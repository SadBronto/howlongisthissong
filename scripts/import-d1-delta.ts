/**
 * MusicBrainz -> Cloudflare D1 DELTA import.
 *
 * Inserts only recordings whose mb_id we don't already have (i.e. songs added
 * to MusicBrainz since our last dump). Existing tracks are left untouched.
 *
 * Why this is cheap:
 *   - mb_id is UNIQUE, and we pre-load the mb_ids we already have, so only
 *     genuinely-new recordings are written.
 *   - The tracks_ai INSERT trigger auto-populates the FTS search index, so we
 *     never rebuild the whole index (that would re-write ~5.7M rows).
 *   - New tracks are added to popularity_queue so the every-minute cron scores
 *     them just like a searched track.
 *   Cost per new song ~= 3 writes (tracks row + FTS row + queue row).
 *
 * Usage (dry run is the DEFAULT — counts only, writes nothing):
 *   MBDUMP_PATH="C:\path\to\mbdump" npx tsx scripts/import-d1-delta.ts
 *   MBDUMP_PATH="C:\path\to\mbdump" npx tsx scripts/import-d1-delta.ts --live
 *
 * Needs a big heap for the mb_id set:
 *   set NODE_OPTIONS=--max-old-space-size=8192
 *
 * Required in .env.local: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const MBDUMP_PATH = process.env.MBDUMP_PATH ?? './mbdump';
const LIVE        = process.argv.includes('--live');

const ROWS_PER_INSERT = 250;
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── D1 REST helpers ────────────────────────────────────────────────────────────
async function d1Raw(sql: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/raw`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as { success: boolean; errors?: unknown[] };
    if (!data.success) throw new Error(`D1 raw failed: ${JSON.stringify(data.errors)}`);
    return;
  }
}
async function d1Query<T>(sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as { success: boolean; result?: Array<{ results: T[] }>; errors?: unknown[] };
    if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
    return data.result?.[0]?.results ?? [];
  }
}

function s(v: string | null): string { return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`; }
function n(v: number | null): string { return v === null ? 'NULL' : String(Math.round(v)); }
function nullStr(x: string): string | null { return x === '\\N' || x === '' ? null : x; }
function nullInt(x: string): number | null { if (x === '\\N' || x === '') return null; const v = parseInt(x, 10); return isNaN(v) ? null : v; }
async function streamLines(filePath: string) {
  return readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
}

// ── Load the mb_ids we already have (keyset paginated; reads are free) ──────────
async function loadExistingMbIds(): Promise<Set<string>> {
  console.log('Loading existing mb_ids from D1 (so we only add new ones)...');
  const set = new Set<string>();
  let lastId = 0;
  for (;;) {
    const rows = await d1Query<{ id: number; mb_id: string | null }>(
      `SELECT id, mb_id FROM tracks WHERE id > ${lastId} ORDER BY id LIMIT 100000`
    );
    if (!rows.length) break;
    for (const r of rows) { if (r.mb_id) set.add(r.mb_id); lastId = r.id; }
    process.stdout.write(`\r  ${set.size.toLocaleString()} loaded`);
  }
  process.stdout.write('\n');
  return set;
}

async function loadMap(file: string, keyCol: number, valCol: number, label: string): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, file);
  const map = new Map<number, string>();
  if (!fs.existsSync(filePath)) { console.warn(`⚠  ${file} not found at ${filePath}`); return map; }
  console.log(`Loading ${label}...`);
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length <= Math.max(keyCol, valCol)) continue;
    const k = parseInt(cols[keyCol], 10);
    const v = nullStr(cols[valCol]);
    if (!isNaN(k) && v && !map.has(k)) map.set(k, v);
  }
  console.log(`  ${map.size.toLocaleString()} ${label} loaded`);
  return map;
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) { console.error('Missing Cloudflare creds in .env.local'); process.exit(1); }
  const recPath = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(recPath)) { console.error(`✗ recording file not found at ${recPath}\n  (set MBDUMP_PATH to the folder holding recording/artist_credit/isrc)`); process.exit(1); }

  console.log(`\nMusicBrainz DELTA import  ${LIVE ? '(LIVE — will write new songs)' : '(DRY RUN — counts only, no writes)'}`);
  console.log(`  Dump: ${MBDUMP_PATH}\n`);

  const existing      = await loadExistingMbIds();
  const artistCredits = await loadMap('artist_credit', 0, 1, 'artist credits');
  const isrcs         = await loadMap('isrc', 1, 2, 'ISRCs');

  console.log('\nScanning recordings for new songs...');
  const rl = await streamLines(recPath);

  let scanned = 0, newCount = 0, inserted = 0, errors = 0;
  let pending: string[] = [];

  const flush = async (force = false) => {
    while (pending.length >= ROWS_PER_INSERT || (force && pending.length > 0)) {
      const chunk = pending.splice(0, ROWS_PER_INSERT);
      try {
        await d1Raw(`INSERT OR IGNORE INTO tracks (title,artist,album,duration_ms,disambiguation,isrc,release_year,mb_id) VALUES ${chunk.join(',')}`);
        inserted += chunk.length;
      } catch (e) { errors++; if (errors <= 5) console.error('\n  insert error:', (e as Error).message.slice(0, 160)); }
    }
  };

  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length < 6) continue;
    scanned++;
    const recId  = nullInt(cols[0]);
    const mbId   = nullStr(cols[1]);
    const title  = nullStr(cols[2]);
    const acId   = nullInt(cols[3]);
    const length = nullInt(cols[4]);
    const comment= nullStr(cols[5]);
    const isrc   = recId != null ? (isrcs.get(recId) ?? null) : null;

    // same filter as the original import: needs title, mb_id, a real length, and an ISRC
    if (!title || !mbId || !length || length <= 0 || !isrc) continue;
    if (existing.has(mbId)) continue;   // already in the DB — skip

    newCount++;
    if (LIVE) {
      const artist = acId != null ? (artistCredits.get(acId) ?? null) : null;
      pending.push(`(${s(title)},${s(artist)},NULL,${n(length)},${s(comment)},${s(isrc)},NULL,${s(mbId)})`);
      await flush();
    }
    if (newCount % 1000 === 0) process.stdout.write(`\r  scanned ${scanned.toLocaleString()} | new songs ${newCount.toLocaleString()}${LIVE ? ` | inserted ${inserted.toLocaleString()}` : ''}`);
  }
  if (LIVE) await flush(true);
  process.stdout.write('\n');

  console.log('\n── Result ────────────────────────────────────────────────');
  console.log(`  Recordings scanned : ${scanned.toLocaleString()}`);
  console.log(`  NEW songs (ISRC)   : ${newCount.toLocaleString()}`);

  if (!LIVE) {
    const writes = newCount * 3; // tracks + FTS(trigger) + queue
    console.log(`  Estimated writes   : ~${writes.toLocaleString()} (tracks + search index + queue)`);
    console.log(`  Estimated cost     : ~$${(writes / 1_000_000).toFixed(2)}`);
    console.log(`\n  DRY RUN — nothing was written. Re-run with --live to import.\n`);
    return;
  }

  // Queue the new (unscored) tracks so the cron enriches them. Queue is currently empty.
  console.log(`\n  Inserted ${inserted.toLocaleString()} new tracks (search index auto-synced by trigger).`);
  console.log('  Adding new tracks to popularity_queue...');
  await d1Raw(`INSERT INTO popularity_queue (track_id) SELECT id FROM tracks WHERE popularity IS NULL AND id NOT IN (SELECT track_id FROM popularity_queue)`);
  console.log(`  Done. Write errors: ${errors}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
