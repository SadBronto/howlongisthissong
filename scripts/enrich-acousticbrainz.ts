/**
 * AcousticBrainz Enrichment
 *
 * Adds 7 audio-analysis columns to the tracks table using the flat CSV dumps
 * from AcousticBrainz (shut down 2022, final dump at acousticbrainz.org/download):
 *
 *   bpm              REAL   — tempo in beats per minute
 *   danceability     REAL   — Essentia 0–3 danceability score
 *   key_key          TEXT   — musical key  (C, C#, D … B)
 *   key_scale        TEXT   — major | minor
 *   tuning_freq      REAL   — concert pitch of recording (usually ~440 Hz)
 *   loudness         REAL   — Essentia average_loudness
 *   dynamic_complexity REAL — high = wide loud/soft contrast, low = compressed
 *
 * Memory-efficient pipeline:
 *   Phase A-1  Load mb_ids from cache or D1 → filter Set   (~800 MB)
 *   Phase A-2  Stream each source CSV → write matched rows to small intermediate files
 *              (no Maps held in memory — filter Set + seen Set per CSV only, ~950 MB peak)
 *   Phase A-3  Clear filter Set. Load 3 small matched files → merge → write merged.csv (~250 MB)
 *   Phase B-1  ALTER TABLE (idempotent)
 *   Phase B-2  Stream merged.csv → batch CASE UPDATE D1 with progress bar (tiny memory)
 *
 * Resumable:
 *   Re-running skips Phase A if merged.csv already exists.
 *   Use --rebuild to force full rebuild from source CSVs.
 *   Use --refresh-ids to force re-fetch of mb_ids from D1.
 *
 * Usage:
 *   npm run enrich-acousticbrainz
 *   npm run enrich-acousticbrainz -- --rebuild
 *   npm run enrich-acousticbrainz -- --refresh-ids
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID  /  CLOUDFLARE_API_TOKEN  /  CLOUDFLARE_D1_DATABASE_ID
 *
 * Optional env:
 *   AB_PATH=./acousticbrainz
 */

import * as fs       from 'fs';
import * as path     from 'path';
import * as readline from 'readline';
import * as dotenv   from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const AB_PATH     = process.env.AB_PATH ?? './acousticbrainz';
const REBUILD     = process.argv.includes('--rebuild');
const REFRESH_IDS = process.argv.includes('--refresh-ids');

// File paths
const RHYTHM_SRC      = path.join(AB_PATH, 'rhythm.csv');
const TONAL_SRC       = path.join(AB_PATH, 'tonal.csv');
const LOWLEVEL_SRC    = path.join(AB_PATH, 'lowlevel.csv');
const RHYTHM_MATCHED  = path.join(AB_PATH, 'rhythm_matched.csv');
const TONAL_MATCHED   = path.join(AB_PATH, 'tonal_matched.csv');
const LOWLEVEL_MATCHED = path.join(AB_PATH, 'lowlevel_matched.csv');
const MERGED_FILE     = path.join(AB_PATH, 'merged.csv');
const MBIDS_FILE      = path.join(AB_PATH, 'mb_ids.txt');

const ROWS_PER_BATCH = 100;
const WRITE_CONC     = 16;
const LOAD_CONC      = 20;
const ID_RANGE       = 10_000;
const BAR_WIDTH      = 32;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── D1 helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function d1Query<T>(sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/query`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as {
      success: boolean; result: Array<{ results: T[] }>; errors?: unknown[];
    };
    if (!data.success) throw new Error(`D1 query: ${JSON.stringify(data.errors)}`);
    return data.result[0]?.results ?? [];
  }
}

async function d1Raw(sql: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/raw`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await res.text();
    let data: { success: boolean; errors?: unknown[] };
    try { data = JSON.parse(text); } catch { throw new Error(`D1 raw HTTP ${res.status}: ${text.slice(0, 300)}`); }
    if (!data.success) throw new Error(`D1 raw: ${JSON.stringify(data.errors)}`);
    return;
  }
}

async function runConcurrent(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  const active = new Map<symbol, Promise<void>>();
  for (const task of tasks) {
    const key = Symbol();
    const p   = task().finally(() => active.delete(key));
    active.set(key, p);
    if (active.size >= concurrency) await Promise.race(active.values());
  }
  await Promise.all(active.values());
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseNum(s: string): number | undefined { const n = parseFloat(s); return isNaN(n) ? undefined : n; }
function sq(s: string): string { return `'${s.replace(/'/g, "''")}'`; }
function n(v: number | undefined): string { return v !== undefined ? String(v) : ''; }
function s(v: string  | undefined): string { return v ? v.replace(/[,\r\n]/g, '') : ''; }

function lines(filePath: string) {
  return readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

function endStream(ws: fs.WriteStream): Promise<void> {
  return new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
}

// ── Phase A-1: load mb_ids ─────────────────────────────────────────────────────

async function loadOurMbIds(): Promise<Set<string>> {
  if (fs.existsSync(MBIDS_FILE) && !REFRESH_IDS) {
    process.stdout.write('  Loading mb_ids from cache…');
    const ids = new Set(fs.readFileSync(MBIDS_FILE, 'utf8').split('\n').filter(Boolean));
    process.stdout.write(`\r  ${ids.size.toLocaleString()} mb_ids loaded from cache                       \n`);
    return ids;
  }

  process.stdout.write('  Loading mb_ids from D1…');
  const maxRow = await d1Query<{ m: number }>('SELECT MAX(id) AS m FROM tracks');
  const maxId  = maxRow[0]?.m ?? 8_000_000;
  const ids    = new Set<string>();

  const ranges: Array<[number, number]> = [];
  for (let lo = 1; lo <= maxId; lo += ID_RANGE)
    ranges.push([lo, Math.min(lo + ID_RANGE - 1, maxId)]);

  let done = 0;
  await runConcurrent(
    ranges.map(([lo, hi]) => async () => {
      const rows = await d1Query<{ mb_id: string }>(
        `SELECT mb_id FROM tracks WHERE id BETWEEN ${lo} AND ${hi} AND mb_id IS NOT NULL`,
      );
      for (const r of rows) if (r.mb_id) ids.add(r.mb_id);
      if (++done % 50 === 0)
        process.stdout.write(`\r  Loading mb_ids from D1… ${ids.size.toLocaleString()} loaded`);
    }),
    LOAD_CONC,
  );
  process.stdout.write(`\r  ${ids.size.toLocaleString()} mb_ids loaded from D1                        \n`);

  process.stdout.write('  Saving mb_ids cache…');
  fs.writeFileSync(MBIDS_FILE, [...ids].join('\n'), 'utf8');
  process.stdout.write(`\r  mb_ids cached to ${MBIDS_FILE}                                \n`);

  return ids;
}

// ── Phase A-2: stream each source CSV → write matched rows to file ─────────────
// No Maps built here. filter Set + a small seen Set per CSV is all that's in RAM.

async function streamRhythm(filter: Set<string>): Promise<number> {
  const seen   = new Set<string>();
  const writer = fs.createWriteStream(RHYTHM_MATCHED, { encoding: 'utf8' });
  writer.write('mb_id,bpm,danceability\n');
  let totalLines = 0, matched = 0, first = true;
  let iMbid = 0, iBpm = 0, iDance = 0;

  for await (const line of lines(RHYTHM_SRC)) {
    if (first) {
      first = false;
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      iMbid = cols.indexOf('mbid'); iBpm = cols.indexOf('bpm'); iDance = cols.indexOf('danceability');
      continue;
    }
    if (++totalLines % 2_000_000 === 0)
      process.stdout.write(`\r  rhythm.csv: ${(totalLines / 1e6).toFixed(0)}M rows · ${matched.toLocaleString()} matched…`);

    const cols = line.split(',');
    const mbid = cols[iMbid]?.replace(/"/g, '').trim();
    if (!mbid || !filter.has(mbid) || seen.has(mbid)) continue;

    const bpm          = parseNum(cols[iBpm]);
    const danceability = parseNum(cols[iDance]);
    if (bpm === undefined && danceability === undefined) continue;

    writer.write(`${mbid},${n(bpm)},${n(danceability)}\n`);
    seen.add(mbid);
    matched++;
  }
  await endStream(writer);
  process.stdout.write(`\r  rhythm.csv: ${totalLines.toLocaleString()} rows · ${matched.toLocaleString()} matched         \n`);
  return matched;
}

async function streamTonal(filter: Set<string>): Promise<number> {
  const seen   = new Set<string>();
  const writer = fs.createWriteStream(TONAL_MATCHED, { encoding: 'utf8' });
  writer.write('mb_id,key_key,key_scale,tuning_freq\n');
  let totalLines = 0, matched = 0, first = true;
  let iMbid = 0, iKey = 0, iScale = 0, iTune = 0;

  for await (const line of lines(TONAL_SRC)) {
    if (first) {
      first = false;
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      iMbid = cols.indexOf('mbid'); iKey = cols.indexOf('key_key');
      iScale = cols.indexOf('key_scale'); iTune = cols.indexOf('tuning_frequency');
      continue;
    }
    if (++totalLines % 2_000_000 === 0)
      process.stdout.write(`\r  tonal.csv: ${(totalLines / 1e6).toFixed(0)}M rows · ${matched.toLocaleString()} matched…`);

    const cols     = line.split(',');
    const mbid     = cols[iMbid]?.replace(/"/g, '').trim();
    if (!mbid || !filter.has(mbid) || seen.has(mbid)) continue;

    const key_key   = cols[iKey]?.replace(/"/g, '').trim()   || undefined;
    const key_scale = cols[iScale]?.replace(/"/g, '').trim() || undefined;
    const tuning    = parseNum(cols[iTune]);
    if (!key_key && !key_scale && tuning === undefined) continue;

    writer.write(`${mbid},${s(key_key)},${s(key_scale)},${n(tuning)}\n`);
    seen.add(mbid);
    matched++;
  }
  await endStream(writer);
  process.stdout.write(`\r  tonal.csv: ${totalLines.toLocaleString()} rows · ${matched.toLocaleString()} matched          \n`);
  return matched;
}

async function streamLowlevel(filter: Set<string>): Promise<number> {
  const seen   = new Set<string>();
  const writer = fs.createWriteStream(LOWLEVEL_MATCHED, { encoding: 'utf8' });
  writer.write('mb_id,loudness,dynamic_complexity\n');
  let totalLines = 0, matched = 0, first = true;
  let iMbid = 0, iLoud = 0, iDyn = 0;

  for await (const line of lines(LOWLEVEL_SRC)) {
    if (first) {
      first = false;
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      iMbid = cols.indexOf('mbid'); iLoud = cols.indexOf('average_loudness'); iDyn = cols.indexOf('dynamic_complexity');
      continue;
    }
    if (++totalLines % 2_000_000 === 0)
      process.stdout.write(`\r  lowlevel.csv: ${(totalLines / 1e6).toFixed(0)}M rows · ${matched.toLocaleString()} matched…`);

    const cols = line.split(',');
    const mbid = cols[iMbid]?.replace(/"/g, '').trim();
    if (!mbid || !filter.has(mbid) || seen.has(mbid)) continue;

    const loudness           = parseNum(cols[iLoud]);
    const dynamic_complexity = parseNum(cols[iDyn]);
    if (loudness === undefined && dynamic_complexity === undefined) continue;

    writer.write(`${mbid},${n(loudness)},${n(dynamic_complexity)}\n`);
    seen.add(mbid);
    matched++;
  }
  await endStream(writer);
  process.stdout.write(`\r  lowlevel.csv: ${totalLines.toLocaleString()} rows · ${matched.toLocaleString()} matched        \n`);
  return matched;
}

// ── Phase A-3: merge 3 small matched files → merged.csv ───────────────────────
// Filter Set is cleared before this runs. Peak RAM here: ~250 MB.

interface AcousticData {
  bpm?:                number;
  danceability?:       number;
  key_key?:            string;
  key_scale?:          string;
  tuning_freq?:        number;
  loudness?:           number;
  dynamic_complexity?: number;
}

async function buildMergedCsv(): Promise<number> {
  const merged = new Map<string, AcousticData>();

  // rhythm_matched: mb_id, bpm, danceability
  let first = true;
  for await (const line of lines(RHYTHM_MATCHED)) {
    if (first) { first = false; continue; }
    const [mbid, bpm, danceability] = line.split(',');
    if (!mbid) continue;
    merged.set(mbid, { bpm: parseNum(bpm), danceability: parseNum(danceability) });
  }

  // tonal_matched: mb_id, key_key, key_scale, tuning_freq
  first = true;
  for await (const line of lines(TONAL_MATCHED)) {
    if (first) { first = false; continue; }
    const [mbid, key_key, key_scale, tuning_freq] = line.split(',');
    if (!mbid) continue;
    const d: AcousticData = { key_key: key_key || undefined, key_scale: key_scale || undefined, tuning_freq: parseNum(tuning_freq) };
    const e = merged.get(mbid);
    e ? Object.assign(e, d) : merged.set(mbid, d);
  }

  // lowlevel_matched: mb_id, loudness, dynamic_complexity
  first = true;
  for await (const line of lines(LOWLEVEL_MATCHED)) {
    if (first) { first = false; continue; }
    const [mbid, loudness, dynamic_complexity] = line.split(',');
    if (!mbid) continue;
    const d: AcousticData = { loudness: parseNum(loudness), dynamic_complexity: parseNum(dynamic_complexity) };
    const e = merged.get(mbid);
    e ? Object.assign(e, d) : merged.set(mbid, d);
  }

  // Write merged.csv
  const writer = fs.createWriteStream(MERGED_FILE, { encoding: 'utf8' });
  writer.write('mb_id,bpm,danceability,key_key,key_scale,tuning_freq,loudness,dynamic_complexity\n');
  for (const [mbid, d] of merged)
    writer.write(`${mbid},${n(d.bpm)},${n(d.danceability)},${s(d.key_key)},${s(d.key_scale)},${n(d.tuning_freq)},${n(d.loudness)},${n(d.dynamic_complexity)}\n`);
  await endStream(writer);
  return merged.size;
}

// ── Phase B-2: stream merged.csv → D1 ─────────────────────────────────────────

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = Math.round(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function renderBar(current: number, total: number, startMs: number): void {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * BAR_WIDTH);
  const bar    = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const elapsed = (Date.now() - startMs) / 1000;
  const rate    = elapsed > 0 ? current / elapsed : 0;
  const etaSec  = rate > 0 ? (total - current) / rate : 0;
  process.stdout.write(
    `\r  [${bar}] ${Math.round(pct * 100)}%  ${current.toLocaleString()}/${total.toLocaleString()} rows  ETA: ${fmtEta(etaSec)}   `,
  );
}

function buildBatchSql(mbids: string[], rows: AcousticData[]): string {
  function numCase(col: keyof AcousticData): string {
    const items = mbids.map((id, i) => [id, rows[i][col] as number | undefined] as const).filter(([, v]) => v !== undefined);
    if (!items.length) return `${col} = ${col}`;
    return `${col} = CASE mb_id ${items.map(([id, v]) => `WHEN ${sq(id)} THEN ${v}`).join(' ')} ELSE ${col} END`;
  }
  function strCase(col: keyof AcousticData): string {
    const items = mbids.map((id, i) => [id, rows[i][col] as string | undefined] as const).filter(([, v]) => v);
    if (!items.length) return `${col} = ${col}`;
    return `${col} = CASE mb_id ${items.map(([id, v]) => `WHEN ${sq(id)} THEN ${sq(v!)}`).join(' ')} ELSE ${col} END`;
  }
  const inList = mbids.map(sq).join(',');
  return `UPDATE tracks SET\n  ${[
    numCase('bpm'), numCase('danceability'),
    strCase('key_key'), strCase('key_scale'),
    numCase('tuning_freq'), numCase('loudness'), numCase('dynamic_complexity'),
  ].join(',\n  ')}\nWHERE mb_id IN (${inList})`;
}

async function writeToD1(totalRows: number): Promise<{ updated: number; errors: number }> {
  let updated = 0, errors = 0;
  const startMs = Date.now();
  const active  = new Map<symbol, Promise<void>>();
  let batchIds: string[] = [], batchRows: AcousticData[] = [];

  async function flush() {
    if (!batchIds.length) return;
    const ids = batchIds, rows = batchRows;
    batchIds = []; batchRows = [];
    const sql = buildBatchSql(ids, rows);
    const key = Symbol();
    const p = d1Raw(sql)
      .then(() => { updated += ids.length; renderBar(updated, totalRows, startMs); })
      .catch((err: unknown) => {
        errors++;
        if (errors <= 3) console.error('\n  Batch error:', err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400));
      })
      .finally(() => active.delete(key));
    active.set(key, p);
    if (active.size >= WRITE_CONC) await Promise.race(active.values());
  }

  let first = true;
  for await (const line of lines(MERGED_FILE)) {
    if (first) { first = false; continue; }
    const [mbid, bpm, danceability, key_key, key_scale, tuning_freq, loudness, dynamic_complexity] = line.split(',');
    if (!mbid) continue;
    batchIds.push(mbid);
    batchRows.push({
      bpm:                parseNum(bpm),
      danceability:       parseNum(danceability),
      key_key:            key_key   || undefined,
      key_scale:          key_scale || undefined,
      tuning_freq:        parseNum(tuning_freq),
      loudness:           parseNum(loudness),
      dynamic_complexity: parseNum(dynamic_complexity),
    });
    if (batchIds.length >= ROWS_PER_BATCH) await flush();
  }
  await flush();
  await Promise.all(active.values());
  return { updated, errors };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }

  console.log('AcousticBrainz Enrichment');
  console.log(`  CSV path:    ${AB_PATH}`);
  console.log(`  Batch size:  ${ROWS_PER_BATCH} rows/statement`);
  console.log(`  Concurrency: ${WRITE_CONC} parallel D1 writes`);
  console.log('');

  // ── Phase A: build merged.csv ──────────────────────────────────────────────
  if (fs.existsSync(MERGED_FILE) && !REBUILD) {
    const rows = fs.statSync(MERGED_FILE).size;
    console.log(`Phase A — skipped (merged.csv exists, ${(rows / 1e6).toFixed(0)} MB)`);
    console.log('  Pass --rebuild to regenerate from source CSVs.\n');
  } else {
    for (const fp of [RHYTHM_SRC, TONAL_SRC, LOWLEVEL_SRC]) {
      if (!fs.existsSync(fp)) {
        console.error(`Missing: ${fp}`); process.exit(1);
      }
    }

    console.log('Phase A-1 — loading mb_ids');
    const filter = await loadOurMbIds();
    console.log('');

    console.log('Phase A-2 — streaming source CSV files → intermediate matched files');
    await streamRhythm(filter);
    await streamTonal(filter);
    await streamLowlevel(filter);
    filter.clear();   // ← free 800 MB before merge
    console.log('');

    console.log('Phase A-3 — merging matched files → merged.csv');
    const total = await buildMergedCsv();
    console.log(`  ${total.toLocaleString()} unique tracks written to merged.csv\n`);
  }

  // ── Phase B: schema + D1 writes ────────────────────────────────────────────
  console.log('Phase B-1 — ensuring schema columns exist');
  for (const sql of [
    'ALTER TABLE tracks ADD COLUMN bpm                REAL',
    'ALTER TABLE tracks ADD COLUMN danceability       REAL',
    'ALTER TABLE tracks ADD COLUMN key_key            TEXT',
    'ALTER TABLE tracks ADD COLUMN key_scale          TEXT',
    'ALTER TABLE tracks ADD COLUMN tuning_freq        REAL',
    'ALTER TABLE tracks ADD COLUMN loudness           REAL',
    'ALTER TABLE tracks ADD COLUMN dynamic_complexity REAL',
  ]) {
    const col = sql.match(/ADD COLUMN (\S+)/)![1];
    try   { await d1Raw(sql); console.log(`  added ${col}`); }
    catch { console.log(`  (exists) ${col}`); }
  }
  console.log('');

  // Count rows for progress bar
  let totalRows = 0;
  for await (const _ of lines(MERGED_FILE)) totalRows++;
  totalRows--; // subtract header

  console.log(`Phase B-2 — writing ${totalRows.toLocaleString()} rows to D1`);
  const writeStart = Date.now();
  const { updated, errors } = await writeToD1(totalRows);
  process.stdout.write('\n');

  const elapsed = ((Date.now() - writeStart) / 1000).toFixed(0);
  console.log(`\n  Done in ${elapsed}s`);
  console.log(`  ${updated.toLocaleString()} rows updated · ${errors} errors\n`);
  console.log('New columns: bpm, danceability, key_key, key_scale, tuning_freq, loudness, dynamic_complexity');
  console.log('Wire up worker and UI when ready.');
}

main().catch(err => { console.error(err); process.exit(1); });
