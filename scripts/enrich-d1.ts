/**
 * MusicBrainz → D1 Second-Pass Enrichment
 *
 * Fills in album, release_year, release_type, label, track_number, genre
 * for all 5.7M tracks using local MusicBrainz dump files.
 *
 * Memory strategy: all lookup data is built in Maps (fits in ~1GB), then the
 * recording file is streamed once and enriched rows are written to a temp TSV
 * file on disk. The Maps are then freed, and the TSV is read in small batches
 * for D1 updates. Peak heap: ~1.3 GB (well under the 2.5 GB V8 limit).
 *
 * Resumable: if enrich_temp.tsv already exists from a previous crashed run,
 * the data-load phase is skipped and the script jumps straight to D1 updates.
 *
 * Usage: npm run enrich-d1
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

// Rows per UPDATE batch. Each batch is ONE SQL statement with CASE expressions.
// ~200 rows keeps the request body well under D1's 1MB limit.
const ROWS_PER_BATCH = 200;

const TMP_FILE = path.join(process.cwd(), 'enrich_temp.tsv');

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── D1 ────────────────────────────────────────────────────────────────────────

async function d1Raw(sql: string): Promise<void> {
  const res = await fetch(`${D1_URL}/raw`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sql, params: [] }),
  });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2000));
    return d1Raw(sql);
  }
  const data = await res.json() as { success: boolean; errors?: unknown[] };
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function s(v: string | null): string {
  if (v === null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}
function n(v: number | null): string {
  return v === null ? 'NULL' : String(Math.round(v));
}

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

// ── Step 0: Which recording integer IDs are in our DB (has an ISRC) ──────────

async function loadIsrcRecordingIds(): Promise<Set<number>> {
  const filePath = path.join(MBDUMP_PATH, 'isrc');
  const ids = new Set<number>();
  if (!fs.existsSync(filePath)) return ids;
  console.log('Loading ISRC recording IDs…');
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    const recId = nullInt(cols[1]);
    if (recId != null) ids.add(recId);
  }
  console.log(`  ${ids.size.toLocaleString()} recordings with ISRCs`);
  return ids;
}

// ── Step 1: Tiny lookup tables ────────────────────────────────────────────────

async function loadMap(
  fileName: string, idCol: number, nameCol: number,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, fileName);
  const map = new Map<number, string>();
  if (!fs.existsSync(filePath)) return map;
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    const id   = nullInt(cols[idCol]);
    const name = nullStr(cols[nameCol]);
    if (id != null && name) map.set(id, name);
  }
  return map;
}

// ── Step 2: Best genre per recording (from recording_tag dump) ────────────────

async function loadRecordingGenres(
  isrcIds:  Set<number>,
  tagNames: Map<number, string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'recording_tag');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading recording genres…');
  const best = new Map<number, { name: string; count: number }>();
  const rl = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0) process.stdout.write(`\r  ${(lines/1e6).toFixed(0)}M lines…`);
    const cols  = line.split('\t');
    const recId = nullInt(cols[0]);
    const tagId = nullInt(cols[1]);
    const count = nullInt(cols[2]);
    if (recId == null || tagId == null || count == null) continue;
    if (!isrcIds.has(recId)) continue;
    const name = tagNames.get(tagId);
    if (!name) continue;
    const existing = best.get(recId);
    if (!existing || count > existing.count) best.set(recId, { name, count });
  }
  console.log(`\n  ${best.size.toLocaleString()} recordings have genre tags`);
  const result = new Map<number, string>();
  best.forEach(({ name }, id) => result.set(id, name));
  return result;
}

// ── Step 3: Medium → release mapping ─────────────────────────────────────────

async function loadMediumRelease(): Promise<Map<number, number>> {
  const filePath = path.join(MBDUMP_PATH, 'medium');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading medium → release…');
  const map = new Map<number, number>();
  const rl  = await streamLines(filePath);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const mediumId = nullInt(cols[0]);
    const relId    = nullInt(cols[1]);
    if (mediumId != null && relId != null) map.set(mediumId, relId);
  }
  console.log(`  ${map.size.toLocaleString()} mediums loaded`);
  return map;
}

// ── Step 4: Stream track file → pick best release per recording ───────────────
// "Best" = smallest release_id (earliest added to MusicBrainz ≈ original release).

async function loadTrackData(
  isrcIds:       Set<number>,
  mediumRelease: Map<number, number>,
): Promise<Map<number, { releaseId: number; trackPos: number }>> {
  const filePath = path.join(MBDUMP_PATH, 'track');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Streaming track file (largest file — a few minutes)…');
  const result = new Map<number, { releaseId: number; trackPos: number }>();
  const rl     = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines/1e6).toFixed(0)}M lines, ${result.size.toLocaleString()} matched…`);
    const cols     = line.split('\t');
    const recId    = nullInt(cols[2]);
    const mediumId = nullInt(cols[3]);
    const trackPos = nullInt(cols[4]);
    if (recId == null || mediumId == null || trackPos == null) continue;
    if (!isrcIds.has(recId)) continue;
    const relId = mediumRelease.get(mediumId);
    if (relId == null) continue;
    const existing = result.get(recId);
    if (!existing || relId < existing.releaseId) {
      result.set(recId, { releaseId: relId, trackPos });
    }
  }
  console.log(`\n  ${result.size.toLocaleString()} recordings matched to releases`);
  return result;
}

// ── Step 5: Release name + release_group + status ────────────────────────────

async function loadReleaseData(releaseIds: Set<number>): Promise<Map<number, {
  name:           string;
  releaseGroupId: number | null;
  statusId:       number | null;
}>> {
  const filePath = path.join(MBDUMP_PATH, 'release');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release data…');
  const map = new Map<number, { name: string; releaseGroupId: number | null; statusId: number | null }>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols    = line.split('\t');
    const relId   = nullInt(cols[0]);
    if (relId == null || !releaseIds.has(relId)) continue;
    const name    = nullStr(cols[2]);
    const rgId    = nullInt(cols[4]);
    const statId  = nullInt(cols[5]);
    if (name) map.set(relId, { name, releaseGroupId: rgId, statusId: statId });
  }
  console.log(`\n  ${map.size.toLocaleString()} releases loaded`);
  return map;
}

// ── Step 6: Release → earliest year ──────────────────────────────────────────

async function loadReleaseYears(releaseIds: Set<number>): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const [file, yearCol] of [['release_country', 2], ['release_unknown_country', 1]] as const) {
    const filePath = path.join(MBDUMP_PATH, file);
    if (!fs.existsSync(filePath)) continue;
    const rl = await streamLines(filePath);
    for await (const line of rl) {
      const cols  = line.split('\t');
      const relId = nullInt(cols[0]);
      const year  = nullInt(cols[yearCol]);
      if (relId == null || year == null || !releaseIds.has(relId)) continue;
      const existing = map.get(relId);
      if (!existing || year < existing) map.set(relId, year);
    }
  }
  console.log(`  ${map.size.toLocaleString()} releases have year data`);
  return map;
}

// ── Step 7: Release → label name ─────────────────────────────────────────────

async function loadReleaseLabels(
  releaseIds: Set<number>,
  labelNames: Map<number, string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'release_label');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release labels…');
  const map = new Map<number, string>();
  const rl  = await streamLines(filePath);
  for await (const line of rl) {
    const cols  = line.split('\t');
    const relId = nullInt(cols[1]);
    const labId = nullInt(cols[2]);
    if (relId == null || labId == null) continue;
    if (!releaseIds.has(relId) || map.has(relId)) continue;
    const name = labelNames.get(labId);
    if (name) map.set(relId, name);
  }
  console.log(`  ${map.size.toLocaleString()} releases have label data`);
  return map;
}

// ── Step 8: Release group → type name ────────────────────────────────────────

async function loadReleaseGroupTypes(
  rgIds:       Set<number>,
  rgTypeNames: Map<number, string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'release_group');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release group types…');
  const map = new Map<number, string>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols   = line.split('\t');
    const rgId   = nullInt(cols[0]);
    const typeId = nullInt(cols[4]);
    if (rgId == null || !rgIds.has(rgId)) continue;
    const typeName = typeId != null ? (rgTypeNames.get(typeId) ?? 'Other') : 'Other';
    map.set(rgId, typeName);
  }
  console.log(`\n  ${map.size.toLocaleString()} release groups typed`);
  return map;
}

// ── Step 9: Stream recording file → write enriched rows to temp TSV ──────────
// This replaces the old approach of building two huge in-memory Maps
// (gidToRecId + enriched). By writing to disk we avoid OOM.
//
// TSV columns: gid, album, release_year, release_type, label, track_number, genre
// NULL values are stored as the literal string \N (standard PostgreSQL convention).

async function streamRecordingToTsv(
  recTrack:      Map<number, { releaseId: number; trackPos: number }>,
  recGenres:     Map<number, string>,
  releaseData:   Map<number, { name: string; releaseGroupId: number | null; statusId: number | null }>,
  releaseYears:  Map<number, number>,
  releaseLabels: Map<number, string>,
  rgTypes:       Map<number, string>,
  outPath:       string,
): Promise<number> {
  const filePath = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(filePath)) {
    console.error('recording file not found!');
    return 0;
  }
  console.log('Streaming recording GUIDs → temp file…');
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  const rl  = await streamLines(filePath);
  let count = 0;
  let lines = 0;

  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines/1e6).toFixed(0)}M lines, ${count.toLocaleString()} written…`);

    const cols  = line.split('\t');
    const recId = nullInt(cols[0]);
    const gid   = nullStr(cols[1]);
    if (recId == null || !gid) continue;

    const trackInfo = recTrack.get(recId);
    if (!trackInfo) continue;

    const { releaseId, trackPos } = trackInfo;
    const release     = releaseData.get(releaseId);
    const year        = releaseYears.get(releaseId) ?? null;
    const labelName   = releaseLabels.get(releaseId) ?? null;
    const rgId        = release?.releaseGroupId ?? null;
    const releaseType = rgId != null ? (rgTypes.get(rgId) ?? null) : null;
    const album       = release?.name ?? null;
    const genre       = recGenres.get(recId) ?? null;

    // Encode as tab-separated; use \N for nulls
    const row = [
      gid,
      album        ?? '\\N',
      year   != null ? String(year)      : '\\N',
      releaseType  ?? '\\N',
      labelName    ?? '\\N',
      trackPos != null ? String(trackPos) : '\\N',
      genre        ?? '\\N',
    ].join('\t');
    out.write(row + '\n');
    count++;
  }

  // Wait for write stream to flush
  await new Promise<void>((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  console.log(`\n  ${count.toLocaleString()} records written to ${path.basename(outPath)}`);
  return count;
}

// ── Build batch UPDATE SQL using CASE expressions ─────────────────────────────
// One statement, many rows — D1's /raw endpoint handles it fine.

interface EnrichedRow {
  album:       string | null;
  releaseYear: number | null;
  releaseType: string | null;
  label:       string | null;
  trackNumber: number | null;
  genre:       string | null;
}

function buildBatchUpdate(chunk: [string, EnrichedRow][]): string {
  const ids = chunk.map(([gid]) => s(gid)).join(',');

  function caseExpr(
    col:       string,
    getValue:  (d: EnrichedRow) => string,
    onlyNonNull = false,
  ): string {
    const rows = onlyNonNull ? chunk.filter(([, d]) => getValue(d) !== 'NULL') : chunk;
    const branches = rows.map(([gid, d]) => `WHEN ${s(gid)} THEN ${getValue(d)}`).join(' ');
    return branches
      ? `${col} = CASE mb_id ${branches} ELSE ${col} END`
      : `${col} = ${col}`; // no-op
  }

  const sets = [
    caseExpr('album',        d => s(d.album)),
    caseExpr('release_year', d => n(d.releaseYear)),
    caseExpr('release_type', d => s(d.releaseType)),
    caseExpr('label',        d => s(d.label)),
    caseExpr('track_number', d => n(d.trackNumber)),
    // Genre: only overwrite if dump has a value (don't nuke API-enriched data)
    caseExpr('genre',        d => s(d.genre), true),
  ].join(',\n  ');

  return `UPDATE tracks SET\n  ${sets}\nWHERE mb_id IN (${ids})`;
}

// ── Parse a line from the temp TSV back into an EnrichedRow ──────────────────

function parseTsvRow(line: string): [string, EnrichedRow] | null {
  const cols = line.split('\t');
  if (cols.length < 7) return null;
  const [gid, albumRaw, yearRaw, typeRaw, labelRaw, trackRaw, genreRaw] = cols;
  if (!gid) return null;
  return [gid, {
    album:       albumRaw === '\\N' ? null : albumRaw,
    releaseYear: yearRaw  === '\\N' ? null : parseInt(yearRaw, 10),
    releaseType: typeRaw  === '\\N' ? null : typeRaw,
    label:       labelRaw === '\\N' ? null : labelRaw,
    trackNumber: trackRaw === '\\N' ? null : parseInt(trackRaw, 10),
    genre:       genreRaw === '\\N' ? null : genreRaw.trimEnd(),
  }];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local');
    process.exit(1);
  }

  console.log('MusicBrainz → D1 Enrichment (Pass 2)');
  console.log(`  Dump path: ${MBDUMP_PATH}`);
  console.log('');

  // ── Schema: add new columns (idempotent) ─────────────────────────────────────
  console.log('Adding new columns (if not already present)…');
  for (const sql of [
    'ALTER TABLE tracks ADD COLUMN release_type TEXT',
    'ALTER TABLE tracks ADD COLUMN label        TEXT',
    'ALTER TABLE tracks ADD COLUMN track_number INTEGER',
  ]) {
    try { await d1Raw(sql); console.log(`  ✓ ${sql.split(' ').slice(0, 6).join(' ')}`); }
    catch { console.log(`  (already exists) ${sql.split(' ').slice(0, 6).join(' ')}`); }
  }
  console.log('');

  // ── Drop FTS trigger so album updates don't trigger FTS rewrites ─────────────
  console.log('Dropping FTS update trigger…');
  await d1Raw('DROP TRIGGER IF EXISTS tracks_au');
  console.log('  ✓ trigger dropped');
  console.log('');

  // ── Phase 1: build temp TSV (skipped if temp file already exists) ─────────────

  const tmpExists = fs.existsSync(TMP_FILE);

  if (tmpExists) {
    console.log(`Temp file already exists (${TMP_FILE})`);
    console.log('  Skipping data-load phase — jumping straight to D1 updates.');
    console.log('  (Delete enrich_temp.tsv to start a fresh run.)');
    console.log('');
  } else {
    // ── Load all lookup data ────────────────────────────────────────────────────
    const isrcIds    = await loadIsrcRecordingIds();
    const rgTypeMap  = await loadMap('release_group_primary_type', 0, 1);
    const tagNames   = await loadMap('tag', 0, 1);
    const labelNames = await loadMap('label', 0, 2);
    console.log(`  ${rgTypeMap.size} release types, ${tagNames.size} tags, ${labelNames.size} labels`);

    const recGenres  = await loadRecordingGenres(isrcIds, tagNames);
    tagNames.clear(); // no longer needed after this — free memory

    const medRelease = await loadMediumRelease();
    const recTrack   = await loadTrackData(isrcIds, medRelease);
    medRelease.clear(); // free ~200MB
    isrcIds.clear();    // free ~200MB

    const ourReleaseIds = new Set<number>();
    recTrack.forEach(({ releaseId }) => ourReleaseIds.add(releaseId));
    console.log(`  ${ourReleaseIds.size.toLocaleString()} unique releases to look up`);

    const releaseData   = await loadReleaseData(ourReleaseIds);
    const releaseYears  = await loadReleaseYears(ourReleaseIds);
    const releaseLabels = await loadReleaseLabels(ourReleaseIds, labelNames);
    labelNames.clear(); // no longer needed after this — free memory
    ourReleaseIds.clear();

    const rgIds = new Set<number>();
    releaseData.forEach(({ releaseGroupId }) => {
      if (releaseGroupId != null) rgIds.add(releaseGroupId);
    });
    const rgTypes = await loadReleaseGroupTypes(rgIds, rgTypeMap);
    rgTypeMap.clear(); // no longer needed after this — free memory
    console.log('');

    // ── Stream recording file → temp TSV ──────────────────────────────────────
    await streamRecordingToTsv(
      recTrack, recGenres, releaseData, releaseYears, releaseLabels, rgTypes,
      TMP_FILE,
    );

    // Free all lookup Maps — the TSV on disk is our only data source from here
    recTrack.clear();
    recGenres.clear();
    releaseData.clear();
    releaseYears.clear();
    releaseLabels.clear();
    rgTypes.clear();
    console.log('  Lookup maps freed');
    console.log('');
  }

  // ── Phase 2: batch UPDATE D1 from temp TSV ───────────────────────────────────
  console.log(`Updating D1 in batches of ${ROWS_PER_BATCH}…`);

  const tsvRl = await streamLines(TMP_FILE);
  let chunk: [string, EnrichedRow][] = [];
  let updated = 0;
  let errors  = 0;

  async function flushChunk(): Promise<void> {
    if (chunk.length === 0) return;
    const sql = buildBatchUpdate(chunk);
    try {
      await d1Raw(sql);
      updated += chunk.length;
    } catch (err) {
      errors++;
      if (errors <= 5) console.error('\nBatch error:', (err as Error).message.slice(0, 200));
    }
    chunk = [];
    if (updated % 10_000 < ROWS_PER_BATCH) {
      process.stdout.write(`\r  ${updated.toLocaleString()} updated, ${errors} errors`);
    }
  }

  for await (const line of tsvRl) {
    const parsed = parseTsvRow(line);
    if (!parsed) continue;
    chunk.push(parsed);
    if (chunk.length >= ROWS_PER_BATCH) await flushChunk();
  }
  await flushChunk(); // last partial batch

  console.log(`\n  ${updated.toLocaleString()} records updated, ${errors} errors`);
  console.log('');

  // ── Clean up temp file ────────────────────────────────────────────────────────
  try {
    fs.unlinkSync(TMP_FILE);
    console.log('  Temp file deleted');
  } catch {
    console.log(`  Note: could not delete temp file — remove ${TMP_FILE} manually`);
  }

  // ── Rebuild FTS index ─────────────────────────────────────────────────────────
  console.log('Rebuilding FTS index (may take a couple of minutes)…');
  await d1Raw("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')");
  console.log('  ✓ FTS rebuilt');

  // ── Recreate FTS trigger ──────────────────────────────────────────────────────
  console.log('Recreating FTS update trigger…');
  await d1Raw(`CREATE TRIGGER IF NOT EXISTS tracks_au
    AFTER UPDATE OF title, artist, album ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
      VALUES ('delete', old.id, old.title, old.artist, old.album);
      INSERT INTO tracks_fts(rowid, title, artist, album)
      VALUES (new.id, new.title, new.artist, new.album);
    END`);
  console.log('  ✓ trigger restored');
  console.log('');
  console.log('All done!');
}

main().catch(err => { console.error(err); process.exit(1); });
