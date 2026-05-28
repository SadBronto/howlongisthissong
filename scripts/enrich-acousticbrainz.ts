/**
 * AcousticBrainz Enrichment
 *
 * Adds 7 audio-analysis columns to the tracks table using the flat CSV dumps
 * from AcousticBrainz (shut down 2022, final dump available at acousticbrainz.org/download):
 *
 *   bpm              REAL   — tempo in beats per minute
 *   danceability     REAL   — Essentia 0–3 danceability score
 *   key_key          TEXT   — musical key  (C, C#, D … B)
 *   key_scale        TEXT   — major | minor
 *   tuning_freq      REAL   — concert pitch of recording (usually ~440 Hz)
 *   loudness         REAL   — Essentia average_loudness
 *   dynamic_complexity REAL — high = wide loud/soft contrast, low = compressed
 *
 * Required CSV files (download from acousticbrainz.org/download, place in AB_PATH):
 *   rhythm.csv    — contains bpm, danceability
 *   tonal.csv     — contains key_key, key_scale, tuning_frequency
 *   lowlevel.csv  — contains average_loudness, dynamic_complexity
 *
 * Each CSV has header row: mbid, submission_offset, ...fields...
 * Multiple rows per mbid (multiple submissions) — first submission wins per file.
 *
 * Coverage: ~30-50% of our tracks will match. The rest stay NULL for these columns.
 *
 * Phases:
 *   1. Load our 5.7M mb_ids from D1 into a filter Set
 *   2. Stream each CSV, keep only matching mb_ids (first-wins per mbid)
 *   3. Merge the three result Maps
 *   4. ALTER TABLE to add 7 columns (idempotent)
 *   5. Batch CASE UPDATE D1 with progress bar
 *
 * No temp file needed — matched data fits comfortably in RAM.
 * Not resumable (re-run overwrites same rows with same values — safe).
 *
 * Usage:
 *   npm run enrich-acousticbrainz
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 *
 * Optional:
 *   AB_PATH=./acousticbrainz   (directory containing the three CSV files)
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

const ROWS_PER_BATCH = 200;
const WRITE_CONC     = 8;
const LOAD_CONC      = 20;
const ID_RANGE       = 10_000;
const BAR_WIDTH      = 40;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── Data types ─────────────────────────────────────────────────────────────────

interface AcousticData {
  bpm?:               number;
  danceability?:      number;
  key_key?:           string;
  key_scale?:         string;
  tuning_freq?:       number;
  loudness?:          number;
  dynamic_complexity?: number;
}

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
    const data = await res.json() as { success: boolean; errors?: unknown[] };
    if (!data.success) throw new Error(`D1 raw: ${JSON.stringify(data.errors)}`);
    return;
  }
}

// ── Concurrency helper ─────────────────────────────────────────────────────────

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

// ── Phase 1: load our mb_ids from D1 ──────────────────────────────────────────

async function loadOurMbIds(): Promise<Set<string>> {
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
  return ids;
}

// ── Phase 2: stream CSV files ──────────────────────────────────────────────────

async function streamLines(filePath: string) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function parseFloat_(s: string): number | undefined {
  const n = parseFloat(s);
  return isNaN(n) ? undefined : n;
}

async function streamRhythm(
  filePath: string,
  filter: Set<string>,
): Promise<Map<string, AcousticData>> {
  const map = new Map<string, AcousticData>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  let first = true;
  let iMbid = 0, iBpm = 2, iDance = 7; // default column positions

  for await (const line of rl) {
    if (first) {
      first = false;
      // Parse header to find column positions
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      iMbid  = cols.indexOf('mbid');
      iBpm   = cols.indexOf('bpm');
      iDance = cols.indexOf('danceability');
      continue;
    }
    if (++lines % 2_000_000 === 0)
      process.stdout.write(`\r  rhythm.csv: ${(lines / 1e6).toFixed(0)}M rows · ${map.size.toLocaleString()} matched…`);

    const cols = line.split(',');
    const mbid = cols[iMbid]?.replace(/"/g, '').trim();
    if (!mbid || !filter.has(mbid) || map.has(mbid)) continue;

    const bpm         = parseFloat_(cols[iBpm]);
    const danceability = parseFloat_(cols[iDance]);
    if (bpm !== undefined || danceability !== undefined)
      map.set(mbid, { bpm, danceability });
  }
  process.stdout.write(`\r  rhythm.csv: ${lines.toLocaleString()} rows · ${map.size.toLocaleString()} matched         \n`);
  return map;
}

async function streamTonal(
  filePath: string,
  filter: Set<string>,
): Promise<Map<string, AcousticData>> {
  const map = new Map<string, AcousticData>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  let first = true;
  let iMbid = 0, iKey = 2, iScale = 3, iTune = 4;

  for await (const line of rl) {
    if (first) {
      first = false;
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      iMbid  = cols.indexOf('mbid');
      iKey   = cols.indexOf('key_key');
      iScale = cols.indexOf('key_scale');
      iTune  = cols.indexOf('tuning_frequency');
      continue;
    }
    if (++lines % 2_000_000 === 0)
      process.stdout.write(`\r  tonal.csv: ${(lines / 1e6).toFixed(0)}M rows · ${map.size.toLocaleString()} matched…`);

    const cols  = line.split(',');
    const mbid  = cols[iMbid]?.replace(/"/g, '').trim();
    if (!mbid || !filter.has(mbid) || map.has(mbid)) continue;

    const key_key   = cols[iKey]?.replace(/"/g, '').trim()   || undefined;
    const key_scale = cols[iScale]?.replace(/"/g, '').trim() || undefined;
    const tuning    = parseFloat_(cols[iTune]);
    if (key_key || key_scale || tuning !== undefined)
      map.set(mbid, { key_key, key_scale, tuning_freq: tuning });
  }
  process.stdout.write(`\r  tonal.csv: ${lines.toLocaleString()} rows · ${map.size.toLocaleString()} matched          \n`);
  return map;
}

async function streamLowlevel(
  filePath: string,
  filter: Set<string>,
): Promise<Map<string, AcousticData>> {
  const map = new Map<string, AcousticData>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  let first = true;
  let iMbid = 0, iLoud = 2, iDyn = 3;

  for await (const line of rl) {
    if (first) {
      first = false;
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      iMbid = cols.indexOf('mbid');
      iLoud = cols.indexOf('average_loudness');
      iDyn  = cols.indexOf('dynamic_complexity');
      continue;
    }
    if (++lines % 2_000_000 === 0)
      process.stdout.write(`\r  lowlevel.csv: ${(lines / 1e6).toFixed(0)}M rows · ${map.size.toLocaleString()} matched…`);

    const cols = line.split(',');
    const mbid = cols[iMbid]?.replace(/"/g, '').trim();
    if (!mbid || !filter.has(mbid) || map.has(mbid)) continue;

    const loudness          = parseFloat_(cols[iLoud]);
    const dynamic_complexity = parseFloat_(cols[iDyn]);
    if (loudness !== undefined || dynamic_complexity !== undefined)
      map.set(mbid, { loudness, dynamic_complexity });
  }
  process.stdout.write(`\r  lowlevel.csv: ${lines.toLocaleString()} rows · ${map.size.toLocaleString()} matched        \n`);
  return map;
}

// ── Phase 3: merge Maps ────────────────────────────────────────────────────────

function mergeMaps(
  rhythm:   Map<string, AcousticData>,
  tonal:    Map<string, AcousticData>,
  lowlevel: Map<string, AcousticData>,
): Map<string, AcousticData> {
  const merged = new Map<string, AcousticData>();
  for (const [mbid, d] of rhythm)   merged.set(mbid, { ...d });
  for (const [mbid, d] of tonal)    { const e = merged.get(mbid); e ? Object.assign(e, d) : merged.set(mbid, { ...d }); }
  for (const [mbid, d] of lowlevel) { const e = merged.get(mbid); e ? Object.assign(e, d) : merged.set(mbid, { ...d }); }
  return merged;
}

// ── Phase 5: batch CASE UPDATE ─────────────────────────────────────────────────

function sq(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

function buildBatchUpdate(chunk: Array<[string, AcousticData]>): string {
  function numCase(col: string, get: (d: AcousticData) => number | undefined): string {
    const rows = chunk.filter(([, d]) => get(d) !== undefined);
    if (rows.length === 0) return `${col} = ${col}`;
    const branches = rows.map(([mbid, d]) => `WHEN ${sq(mbid)} THEN ${get(d)}`).join(' ');
    return `${col} = CASE mb_id ${branches} ELSE ${col} END`;
  }
  function strCase(col: string, get: (d: AcousticData) => string | undefined): string {
    const rows = chunk.filter(([, d]) => get(d) !== undefined);
    if (rows.length === 0) return `${col} = ${col}`;
    const branches = rows.map(([mbid, d]) => `WHEN ${sq(mbid)} THEN ${sq(get(d)!)}`).join(' ');
    return `${col} = CASE mb_id ${branches} ELSE ${col} END`;
  }

  const mbids = chunk.map(([mbid]) => sq(mbid)).join(',');
  const sets  = [
    numCase('bpm',               d => d.bpm),
    numCase('danceability',      d => d.danceability),
    strCase('key_key',           d => d.key_key),
    strCase('key_scale',         d => d.key_scale),
    numCase('tuning_freq',       d => d.tuning_freq),
    numCase('loudness',          d => d.loudness),
    numCase('dynamic_complexity', d => d.dynamic_complexity),
  ].join(',\n  ');

  return `UPDATE tracks SET\n  ${sets}\nWHERE mb_id IN (${mbids})`;
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function renderBar(current: number, total: number, startMs: number, errors: number): void {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * BAR_WIDTH);
  const bar    = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const elapsed = (Date.now() - startMs) / 1000;
  const rate   = elapsed > 0 ? current / elapsed : 0;
  const eta    = rate > 0 ? (total - current) / rate : 0;
  const errTag = errors > 0 ? `  ⚠ ${errors} err` : '';
  process.stdout.write(
    `\r  [${bar}] ${Math.round(pct * 100)}%  ${current.toLocaleString()}/${total.toLocaleString()}` +
    `  ${Math.round(rate)}/s  ETA:${fmtEta(eta)}${errTag}   `,
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }

  const rhythmFile   = path.join(AB_PATH, 'rhythm.csv');
  const tonalFile    = path.join(AB_PATH, 'tonal.csv');
  const lowlevelFile = path.join(AB_PATH, 'lowlevel.csv');

  for (const [label, fp] of [['rhythm.csv', rhythmFile], ['tonal.csv', tonalFile], ['lowlevel.csv', lowlevelFile]] as const) {
    if (!fs.existsSync(fp)) {
      console.error(`Missing: ${fp}`);
      console.error(`Download the CSV dumps from acousticbrainz.org/download and place them in ${AB_PATH}`);
      process.exit(1);
    }
  }

  console.log('AcousticBrainz Enrichment');
  console.log(`  CSV path:    ${AB_PATH}`);
  console.log(`  Batch size:  ${ROWS_PER_BATCH} rows/statement`);
  console.log(`  Concurrency: ${WRITE_CONC} parallel D1 writes`);
  console.log('');

  // ── Phase 1: load our mb_ids ────────────────────────────────────────────────
  console.log('Phase 1 — loading our mb_ids from D1');
  const ourMbIds = await loadOurMbIds();
  console.log('');

  // ── Phase 2: stream CSVs ────────────────────────────────────────────────────
  console.log('Phase 2 — streaming AcousticBrainz CSV files');
  const rhythmMap   = await streamRhythm(rhythmFile,     ourMbIds);
  const tonalMap    = await streamTonal(tonalFile,       ourMbIds);
  const lowMap      = await streamLowlevel(lowlevelFile, ourMbIds);

  // ── Phase 3: merge ──────────────────────────────────────────────────────────
  console.log('');
  console.log('Phase 3 — merging results');
  const merged = mergeMaps(rhythmMap, tonalMap, lowMap);
  rhythmMap.clear(); tonalMap.clear(); lowMap.clear();
  console.log(`  ${merged.size.toLocaleString()} unique tracks with at least one AcousticBrainz field`);
  console.log(`  Coverage: ${((merged.size / ourMbIds.size) * 100).toFixed(1)}% of our catalog`);
  ourMbIds.clear();
  console.log('');

  if (merged.size === 0) {
    console.log('No matches found — check that the CSV files are in the right directory.');
    return;
  }

  // ── Phase 4: schema ─────────────────────────────────────────────────────────
  console.log('Phase 4 — ensuring schema columns exist');
  const newCols = [
    'ALTER TABLE tracks ADD COLUMN bpm               REAL',
    'ALTER TABLE tracks ADD COLUMN danceability      REAL',
    'ALTER TABLE tracks ADD COLUMN key_key           TEXT',
    'ALTER TABLE tracks ADD COLUMN key_scale         TEXT',
    'ALTER TABLE tracks ADD COLUMN tuning_freq       REAL',
    'ALTER TABLE tracks ADD COLUMN loudness          REAL',
    'ALTER TABLE tracks ADD COLUMN dynamic_complexity REAL',
  ];
  for (const sql of newCols) {
    const col = sql.match(/ADD COLUMN (\S+)/)![1];
    try   { await d1Raw(sql); console.log(`  ✓ added ${col}`); }
    catch { console.log(`  (exists) ${col}`); }
  }
  console.log('');

  // ── Phase 5: batch UPDATE D1 ────────────────────────────────────────────────
  const totalRows = merged.size;
  console.log(`Phase 5 — writing ${totalRows.toLocaleString()} rows to D1`);

  const entries  = [...merged.entries()];
  let updated    = 0;
  let errors     = 0;
  const startMs  = Date.now();

  const tasks: Array<() => Promise<void>> = [];
  for (let i = 0; i < entries.length; i += ROWS_PER_BATCH) {
    const chunk = entries.slice(i, i + ROWS_PER_BATCH);
    tasks.push(async () => {
      try {
        await d1Raw(buildBatchUpdate(chunk));
        updated += chunk.length;
      } catch (err) {
        errors++;
        if (errors <= 5) console.error('\n  Batch error:', (err as Error).message.slice(0, 200));
      }
      renderBar(updated, totalRows, startMs, errors);
    });
  }

  // Drain in groups of WRITE_CONC, rendering bar after each group
  for (let i = 0; i < tasks.length; i += WRITE_CONC) {
    await runConcurrent(tasks.slice(i, i + WRITE_CONC), WRITE_CONC);
  }

  renderBar(updated, totalRows, startMs, errors);
  process.stdout.write('\n');

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log('');
  console.log(`  Done in ${elapsed}s`);
  console.log(`  ${updated.toLocaleString()} rows updated · ${errors} errors`);
  console.log('');
  console.log('All done!');
  console.log('  FTS index unchanged — new columns are not FTS-indexed.');
  console.log('  Run "npx wrangler deploy" in worker/ to expose the new fields.');
}

main().catch(err => { console.error(err); process.exit(1); });
