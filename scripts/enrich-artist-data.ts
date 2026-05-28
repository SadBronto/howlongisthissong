/**
 * Artist & Language Enrichment
 *
 * Fills in four new columns for all tracks using local MusicBrainz dump files:
 *   artist_type     — Person / Group / Orchestra / Choir / Other
 *   artist_gender   — Male / Female / Non-binary  (only for Person type)
 *   artist_country  — country/area name from artist.area
 *   language        — language of the release the track appears on
 *
 * Source chain:
 *   artist_type / gender / country:
 *     recording.artist_credit → artist_credit_name.artist → artist.{type,gender,area} → area.name
 *   language:
 *     recording.id → track.medium → medium.release → release.language → language.name
 *
 * Filter: which recordings are "ours" comes from D1 (mb_id column) — no isrc dump needed.
 *
 * Two-phase approach (same pattern as enrich-d1.ts):
 *   Phase 1 — load all MB dump data into memory, stream recording file once,
 *             write enriched rows to enrich_artist_temp.tsv, free Maps.
 *   Phase 2 — stream temp TSV, batch-UPDATE D1 with CONCURRENCY concurrent
 *             requests and a live progress bar.
 *
 * Resumable: if enrich_artist_temp.tsv already exists, Phase 1 is skipped.
 * Delete it to rebuild from the dumps.
 *
 * Usage:
 *   npm run enrich-artist-data
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 *
 * Optional:
 *   MBDUMP_PATH=./mbdump   (default)
 */

import * as fs       from 'fs';
import * as path     from 'path';
import * as readline from 'readline';
import * as dotenv   from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const MBDUMP_PATH = process.env.MBDUMP_PATH ?? './mbdump';

const ROWS_PER_BATCH  = 200;   // rows per CASE UPDATE statement (matches enrich-d1.ts — D1 rejects larger)
const WRITE_CONC      = 8;     // concurrent D1 write requests
const LOAD_CONC       = 20;    // concurrent D1 read requests (loading mb_ids)
const ID_RANGE        = 10_000; // IDs per D1 read batch
const BAR_WIDTH       = 36;
const TMP_FILE        = path.join(process.cwd(), 'enrich_artist_temp.tsv');
const D1_URL          = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── Artist decode tables ──────────────────────────────────────────────────────

const ARTIST_TYPES: Record<number, string> = {
  1: 'Person', 2: 'Group', 3: 'Other', 4: 'Orchestra', 5: 'Choir',
};
const ARTIST_GENDERS: Record<number, string> = {
  1: 'Male', 2: 'Female', 3: 'Non-binary',
};

// ── D1 helpers ────────────────────────────────────────────────────────────────

async function d1Raw(sql: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/raw`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as { success: boolean; errors?: unknown[] };
    if (!data.success) throw new Error(`D1 raw error: ${JSON.stringify(data.errors)}`);
    return;
  }
}

async function d1Query<T>(sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/query`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as {
      success: boolean;
      result:  Array<{ results: T[] }>;
      errors?: unknown[];
    };
    if (!data.success) throw new Error(`D1 query error: ${JSON.stringify(data.errors)}`);
    return data.result[0]?.results ?? [];
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── File helpers ──────────────────────────────────────────────────────────────

async function streamLines(filePath: string) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  return readline.createInterface({ input, crlfDelay: Infinity });
}
function nullStr(v: string): string | null {
  return v === '\\N' || v === '' ? null : v;
}
function nullInt(v: string): number | null {
  if (v === '\\N' || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function countLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    fs.createReadStream(filePath)
      .on('data', (chunk: Buffer) => { for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) n++; })
      .on('end',   () => resolve(n))
      .on('error', reject);
  });
}

// ── Concurrency helper ────────────────────────────────────────────────────────
// Keeps exactly `concurrency` tasks in flight at all times via Promise.race.

async function runConcurrent(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  const active = new Map<symbol, Promise<void>>();
  for (const task of tasks) {
    const key = Symbol();
    const p   = task().finally(() => active.delete(key));
    active.set(key, p);
    if (active.size >= concurrency) await Promise.race(active.values());
  }
  await Promise.all(active.values());
}

// ── Phase 1 loaders ───────────────────────────────────────────────────────────

// Load the mb_ids already in D1 — concurrent range-based queries, no isrc file needed.
async function loadOurMbIds(): Promise<Set<string>> {
  process.stdout.write('Loading mb_ids from D1…');

  const maxRow  = await d1Query<{ m: number }>('SELECT MAX(id) AS m FROM tracks');
  const maxId   = maxRow[0]?.m ?? 8_000_000;

  const ids: Set<string> = new Set();
  let   done = 0;

  const ranges: Array<[number, number]> = [];
  for (let lo = 1; lo <= maxId; lo += ID_RANGE) {
    ranges.push([lo, Math.min(lo + ID_RANGE - 1, maxId)]);
  }

  await runConcurrent(
    ranges.map(([lo, hi]) => async () => {
      const rows = await d1Query<{ mb_id: string }>(
        `SELECT mb_id FROM tracks WHERE id BETWEEN ${lo} AND ${hi} AND mb_id IS NOT NULL`
      );
      for (const r of rows) if (r.mb_id) ids.add(r.mb_id);
      done++;
      if (done % 50 === 0)
        process.stdout.write(`\r  Loading mb_ids from D1… ${ids.size.toLocaleString()} loaded`);
    }),
    LOAD_CONC,
  );

  process.stdout.write(`\r  ${ids.size.toLocaleString()} mb_ids loaded from D1                    \n`);
  return ids;
}

// language cols: id(0) | iso_code_3(1) | iso_code_2t(2) | iso_code_2b(3) | iso_code_1(4) | frequency(5) | name(6)
async function loadLanguageNames(): Promise<Map<number, string>> {
  const fp = path.join(MBDUMP_PATH, 'language');
  if (!fs.existsSync(fp)) { console.warn('  language file not found'); return new Map(); }
  console.log('Loading language names…');
  const map = new Map<number, string>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols = line.split('\t');
    const id   = nullInt(cols[0]);
    const name = nullStr(cols[6]);
    if (id != null && name) map.set(id, name);
  }
  console.log(`  ${map.size} languages`);
  return map;
}

// area cols: id(0) | gid(1) | name(2) | ...
async function loadAreaNames(): Promise<Map<number, string>> {
  const fp = path.join(MBDUMP_PATH, 'area');
  if (!fs.existsSync(fp)) { console.warn('  area file not found'); return new Map(); }
  console.log('Loading area names…');
  const map = new Map<number, string>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols = line.split('\t');
    const id   = nullInt(cols[0]);
    const name = nullStr(cols[2]);
    if (id != null && name) map.set(id, name);
  }
  console.log(`  ${map.size.toLocaleString()} areas`);
  return map;
}

// artist cols: id(0) | gid(1) | name(2) | sort_name(3) | ... | type(10) | area(11) | gender(12) | ...
interface ArtistData { typeId: number | null; genderId: number | null; areaId: number | null }

async function loadArtistData(): Promise<Map<number, ArtistData>> {
  const fp = path.join(MBDUMP_PATH, 'artist');
  if (!fs.existsSync(fp)) { console.warn('  artist file not found'); return new Map(); }
  console.log('Loading artist data…');
  const map = new Map<number, ArtistData>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const id       = nullInt(cols[0]);
    const typeId   = nullInt(cols[10]);
    const areaId   = nullInt(cols[11]);
    const genderId = nullInt(cols[12]);
    if (id != null) map.set(id, { typeId, genderId, areaId });
  }
  console.log(`  ${map.size.toLocaleString()} artists`);
  return map;
}

// artist_credit_name cols: artist_credit(0) | position(1) | artist(2) | ...
// Keep only the first artist per credit (primary artist)
async function loadArtistCredits(): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'artist_credit_name');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading artist credits…');
  const map = new Map<number, number>(); // creditId → artistId
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const creditId = nullInt(cols[0]);
    const artistId = nullInt(cols[2]);
    if (creditId != null && artistId != null && !map.has(creditId)) map.set(creditId, artistId);
  }
  console.log(`  ${map.size.toLocaleString()} credits`);
  return map;
}

// release cols: id(0) | gid(1) | name(2) | artist_credit(3) | release_group(4) | status(5) | packaging(6) | language(7) | ...
async function loadReleaseLanguages(): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'release');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading release languages…');
  const map  = new Map<number, number>(); // releaseId → languageId
  const rl   = await streamLines(fp);
  let lines  = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols   = line.split('\t');
    const relId  = nullInt(cols[0]);
    const langId = nullInt(cols[7]);
    if (relId != null && langId != null) map.set(relId, langId);
  }
  process.stdout.write('\n');
  console.log(`  ${map.size.toLocaleString()} releases with language`);
  return map;
}

// medium cols: id(0) | release(1) | ...
async function loadMediumRelease(): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'medium');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading medium → release…');
  const map = new Map<number, number>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const mediumId = nullInt(cols[0]);
    const relId    = nullInt(cols[1]);
    if (mediumId != null && relId != null) map.set(mediumId, relId);
  }
  console.log(`  ${map.size.toLocaleString()} mediums`);
  return map;
}

// Quick pass over the recording file to get the integer IDs of our recordings.
// Needed to filter the track file — the track file uses integer IDs, not GUIDs.
async function loadOurRecordingIntIds(ourMbIds: Set<string>): Promise<Set<number>> {
  const fp = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(fp)) return new Set();
  console.log('Building recording ID filter…');
  const ids = new Set<number>();
  const rl  = await streamLines(fp);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines / 1e6).toFixed(0)}M lines · ${ids.size.toLocaleString()} matched…`);
    const cols = line.split('\t');
    const id   = nullInt(cols[0]);
    const gid  = nullStr(cols[1]);
    if (id != null && gid && ourMbIds.has(gid)) ids.add(id);
  }
  process.stdout.write('\n');
  console.log(`  ${ids.size.toLocaleString()} recording IDs matched`);
  return ids;
}

// track cols: id(0) | gid(1) | recording(2) | medium(3) | ...
// Filtered to only our recordings — keeps the Map well under V8's 16.7M entry limit.
// Per recording, keep the earliest release (lowest ID = original release).
async function loadRecordingRelease(
  medRelease:    Map<number, number>,
  ourRecordingIds: Set<number>,
): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'track');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Streaming track file (largest file — a few minutes)…');
  const map  = new Map<number, number>(); // recIntId → releaseId
  const rl   = await streamLines(fp);
  let lines  = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines / 1e6).toFixed(0)}M lines · ${map.size.toLocaleString()} recordings mapped…`);
    const cols     = line.split('\t');
    const recId    = nullInt(cols[2]);
    const mediumId = nullInt(cols[3]);
    if (recId == null || mediumId == null || !ourRecordingIds.has(recId)) continue;
    const relId = medRelease.get(mediumId);
    if (relId == null) continue;
    const existing = map.get(recId);
    if (!existing || relId < existing) map.set(recId, relId);
  }
  process.stdout.write('\n');
  console.log(`  ${map.size.toLocaleString()} recordings mapped to releases`);
  return map;
}

// ── Phase 1: stream recording file → write temp TSV ──────────────────────────
// recording cols: id(0) | gid(1) | name(2) | artist_credit(3) | ...
// TSV: gid \t artist_type \t artist_gender \t artist_country \t language
// Rows where all four fields are null are skipped entirely.

async function buildArtistTsv(
  ourMbIds:    Set<string>,
  artistData:  Map<number, ArtistData>,
  artistCreds: Map<number, number>,
  areaNames:   Map<number, string>,
  recRelease:  Map<number, number>,
  relLang:     Map<number, number>,
  langNames:   Map<number, string>,
  outPath:     string,
): Promise<number> {
  const fp = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(fp)) { console.error('recording file not found'); return 0; }
  console.log('Streaming recordings → temp TSV…');
  const out   = fs.createWriteStream(outPath, { encoding: 'utf8' });
  const rl    = await streamLines(fp);
  let written = 0;
  let skipped = 0;
  let lines   = 0;

  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(
        `\r  ${(lines / 1e6).toFixed(0)}M lines · ${written.toLocaleString()} written · ${skipped.toLocaleString()} skipped…`
      );

    const cols     = line.split('\t');
    const recId    = nullInt(cols[0]);
    const gid      = nullStr(cols[1]);
    const creditId = nullInt(cols[3]);

    if (!gid || !ourMbIds.has(gid)) continue; // not one of our tracks

    // Artist fields
    const artistId     = creditId != null ? artistCreds.get(creditId)   : undefined;
    const artist       = artistId != null ? artistData.get(artistId)    : undefined;
    const artistType   = artist?.typeId   != null ? (ARTIST_TYPES[artist.typeId]     ?? null) : null;
    const artistGender = artist?.genderId != null ? (ARTIST_GENDERS[artist.genderId] ?? null) : null;
    const artistCountry = artist?.areaId  != null ? (areaNames.get(artist.areaId)    ?? null) : null;

    // Language via release chain
    const relId    = recId    != null ? recRelease.get(recId)  : undefined;
    const langId   = relId    != null ? relLang.get(relId)     : undefined;
    const language = langId   != null ? langNames.get(langId)  ?? null : null;

    if (!artistType && !artistGender && !artistCountry && !language) { skipped++; continue; }

    out.write(
      [gid,
       artistType    ?? '\\N',
       artistGender  ?? '\\N',
       artistCountry ?? '\\N',
       language      ?? '\\N',
      ].join('\t') + '\n'
    );
    written++;
  }

  await new Promise<void>((res, rej) => out.end(err => err ? rej(err) : res()));
  process.stdout.write('\n');
  console.log(`  ${written.toLocaleString()} rows written · ${skipped.toLocaleString()} skipped (no data at any level)`);
  return written;
}

// ── Phase 2: batch UPDATE helpers ────────────────────────────────────────────

interface ArtistRow {
  gid: string;
  type: string | null; gender: string | null;
  country: string | null; lang: string | null;
}

function sq(v: string): string { return `'${v.replace(/'/g, "''")}'`; }

function buildBatchUpdate(chunk: ArtistRow[]): string {
  function caseExpr(col: string, get: (r: ArtistRow) => string | null): string {
    const rows = chunk.filter(r => get(r) !== null);
    if (rows.length === 0) return `${col} = ${col}`;
    const branches = rows.map(r => `WHEN ${sq(r.gid)} THEN ${sq(get(r)!)}`).join(' ');
    return `${col} = CASE mb_id ${branches} ELSE ${col} END`;
  }
  const ids  = chunk.map(r => sq(r.gid)).join(',');
  const sets = [
    caseExpr('artist_type',    r => r.type),
    caseExpr('artist_gender',  r => r.gender),
    caseExpr('artist_country', r => r.country),
    caseExpr('language',       r => r.lang),
  ].join(',\n  ');
  return `UPDATE tracks SET\n  ${sets}\nWHERE mb_id IN (${ids})`;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderBar(current: number, total: number, startMs: number, errors: number): void {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * BAR_WIDTH);
  const bar    = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const elapsed = (Date.now() - startMs) / 1000;
  const rate   = elapsed > 0 ? Math.round(current / elapsed) : 0;
  const etaSec = rate > 0 ? (total - current) / rate : 0;
  const errTag = errors > 0 ? `  ⚠ ${errors} err` : '';
  process.stdout.write(
    `\r  [${bar}] ${Math.round(pct * 100)}%  ${current.toLocaleString()}/${total.toLocaleString()}  ${rate}/s  ETA: ${fmtEta(etaSec)}${errTag}   `
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }

  console.log('Artist & Language Enrichment');
  console.log(`  Dump:        ${MBDUMP_PATH}`);
  console.log(`  Batch size:  ${ROWS_PER_BATCH} rows/statement`);
  console.log(`  Concurrency: ${WRITE_CONC} parallel D1 writes`);
  console.log('');

  // ── Phase 1: build temp TSV ─────────────────────────────────────────────────

  if (fs.existsSync(TMP_FILE)) {
    const mb = (fs.statSync(TMP_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`Temp file found (${mb} MB) — skipping Phase 1.`);
    console.log('  Delete enrich_artist_temp.tsv to rebuild from dumps.');
    console.log('');
  } else {
    // Pull our recording GUIDs from D1 (replaces isrc dump file)
    const ourMbIds = await loadOurMbIds();
    console.log('');

    // Load lookup tables
    const langNames  = await loadLanguageNames();
    const areaNames  = await loadAreaNames();
    const artistData = await loadArtistData();
    const artCreds   = await loadArtistCredits();
    console.log('');

    // Build release → language chain
    const ourRecIds = await loadOurRecordingIntIds(ourMbIds);
    const relLang   = await loadReleaseLanguages();
    const medRel    = await loadMediumRelease();
    const recRel    = await loadRecordingRelease(medRel, ourRecIds);
    medRel.clear();
    ourRecIds.clear();
    console.log('');

    // Write temp TSV
    await buildArtistTsv(
      ourMbIds, artistData, artCreds, areaNames,
      recRel, relLang, langNames, TMP_FILE,
    );

    // Free all Maps before D1 write phase
    ourMbIds.clear(); artistData.clear(); artCreds.clear(); areaNames.clear();
    recRel.clear(); relLang.clear(); langNames.clear();
    console.log('  Lookup maps freed');
    console.log('');
  }

  // ── Schema: add new columns (idempotent) ─────────────────────────────────────
  console.log('Ensuring schema columns exist…');
  for (const sql of [
    'ALTER TABLE tracks ADD COLUMN artist_type    TEXT',
    'ALTER TABLE tracks ADD COLUMN artist_gender  TEXT',
    'ALTER TABLE tracks ADD COLUMN artist_country TEXT',
    'ALTER TABLE tracks ADD COLUMN language       TEXT',
  ]) {
    try   { await d1Raw(sql); console.log(`  ✓ ${sql.match(/ADD COLUMN \w+/)![0]}`); }
    catch { console.log(`  (already exists) ${sql.match(/ADD COLUMN \w+/)![0]}`); }
  }
  console.log('');

  // ── Phase 2: stream temp TSV → batch UPDATE D1 ───────────────────────────────
  process.stdout.write('Counting rows in temp file…');
  const totalRows = await countLines(TMP_FILE);
  process.stdout.write(`\r  ${totalRows.toLocaleString()} rows to update\n\n`);

  console.log(`Updating D1 · ${ROWS_PER_BATCH} rows/batch · ${WRITE_CONC} concurrent…`);

  const rl             = await streamLines(TMP_FILE);
  let chunk: ArtistRow[] = [];
  let updated          = 0;
  let errors           = 0;
  let lastCheckpoint   = 0;
  const startMs        = Date.now();
  const pendingTasks:  Array<() => Promise<void>> = [];

  function makeTask(c: ArtistRow[]): () => Promise<void> {
    const sql  = buildBatchUpdate(c);
    const size = c.length;
    return async () => {
      try   { await d1Raw(sql); updated += size; }
      catch (err) {
        errors++;
        if (errors <= 5) console.error('\n  Batch error:', (err as Error).message.slice(0, 200));
      }
    };
  }

  async function drainQueue(force = false): Promise<void> {
    const threshold = force ? 0 : WRITE_CONC * 4;
    if (pendingTasks.length <= threshold) return;
    const group = pendingTasks.splice(0, WRITE_CONC * 2);
    await runConcurrent(group, WRITE_CONC);
    renderBar(updated, totalRows, startMs, errors);
    if (updated - lastCheckpoint >= 100_000) {
      lastCheckpoint = updated;
      process.stdout.write(`\n  ✓ checkpoint: ${updated.toLocaleString()} rows written\n`);
    }
  }

  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const gid     = cols[0].trim();
    const type    = cols[1].trim() === '\\N' ? null : cols[1].trim();
    const gender  = cols[2].trim() === '\\N' ? null : cols[2].trim();
    const country = cols[3].trim() === '\\N' ? null : cols[3].trim();
    const lang    = cols[4].trim() === '\\N' ? null : cols[4].trim();
    if (!gid) continue;

    chunk.push({ gid, type, gender, country, lang });
    if (chunk.length >= ROWS_PER_BATCH) {
      pendingTasks.push(makeTask(chunk));
      chunk = [];
      await drainQueue();
    }
  }

  if (chunk.length > 0) pendingTasks.push(makeTask(chunk));
  await drainQueue(true);
  await runConcurrent(pendingTasks, WRITE_CONC);
  renderBar(updated, totalRows, startMs, errors);

  process.stdout.write('\n');

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log('');
  console.log(`  Finished in ${elapsed}s`);
  console.log(`  ${updated.toLocaleString()} rows updated · ${errors} errors`);
  console.log('');

  try { fs.unlinkSync(TMP_FILE); console.log('  Temp file deleted'); }
  catch { console.log(`  Note: could not delete ${TMP_FILE} — remove manually`); }

  console.log('');
  console.log('All done!');
  console.log('  FTS index unchanged (new columns are not FTS-indexed).');
}

main().catch(err => { console.error(err); process.exit(1); });
