/**
 * MusicBrainz → Cloudflare D1 Import
 *
 * Reads recording, artist_credit, and isrc files from the MusicBrainz dump
 * and batch-inserts into Cloudflare D1 via the REST API.
 *
 * Usage:
 *   MBDUMP_PATH=/path/to/mbdump npm run import-d1
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID   = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN    = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID  = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const MBDUMP_PATH  = process.env.MBDUMP_PATH ?? './mbdump';

const ROWS_PER_INSERT  = 50;   // rows per INSERT statement
const STMTS_PER_BATCH  = 20;   // INSERT statements per API call (= 1000 rows/call)

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── Cloudflare D1 API ─────────────────────────────────────────────────────────

async function d1Query(sql: string, params: unknown[] = []) {
  const res = await fetch(`${D1_URL}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json() as { success: boolean; errors?: unknown[] };
  if (!data.success) throw new Error(`D1 query failed: ${JSON.stringify(data.errors)}`);
}

async function d1Batch(statements: { sql: string; params: unknown[] }[]) {
  const res = await fetch(`${D1_URL}/batch`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(statements),
  });
  const data = await res.json() as { success: boolean; errors?: unknown[] };
  if (!data.success) throw new Error(`D1 batch failed: ${JSON.stringify(data.errors)}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nullStr(s: string): string | null {
  return s === '\\N' || s === '' ? null : s;
}

function nullInt(s: string): number | null {
  if (s === '\\N' || s === '') return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

async function streamLines(filePath: string) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  return readline.createInterface({ input, crlfDelay: Infinity });
}

// ── Step 1: Load artist credits ───────────────────────────────────────────────
// artist_credit columns: id | name | artist_count | ref_count | created | ...

async function loadArtistCredits(): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'artist_credit');
  const credits = new Map<number, string>();
  if (!fs.existsSync(filePath)) {
    console.warn('⚠  artist_credit not found — artist names will be null');
    return credits;
  }
  console.log('Loading artist credits…');
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const id = parseInt(cols[0], 10);
    const name = nullStr(cols[1]);
    if (!isNaN(id) && name) credits.set(id, name);
  }
  console.log(`  Loaded ${credits.size.toLocaleString()} artist credits`);
  return credits;
}

// ── Step 2: Load ISRCs ────────────────────────────────────────────────────────
// isrc columns: id | recording | isrc | source | edits_pending

async function loadIsrcs(): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'isrc');
  const isrcs = new Map<number, string>();
  if (!fs.existsSync(filePath)) {
    console.warn('⚠  isrc file not found — ISRC codes will be null');
    return isrcs;
  }
  console.log('Loading ISRCs…');
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const recordingId = nullInt(cols[1]);
    const isrc = nullStr(cols[2]);
    // Keep first ISRC per recording
    if (recordingId != null && isrc && !isrcs.has(recordingId)) {
      isrcs.set(recordingId, isrc);
    }
  }
  console.log(`  Loaded ${isrcs.size.toLocaleString()} ISRCs`);
  return isrcs;
}

// ── Step 3: Import recordings ─────────────────────────────────────────────────
// recording columns: id | gid | name | artist_credit | length | comment | ...

type Row = {
  title:          string;
  artist:         string | null;
  duration_ms:    number;
  disambiguation: string | null;
  isrc:           string | null;
  release_year:   null;   // not in recording table; would need release join
  mb_id:          string;
};

async function importRecordings(
  artistCredits: Map<number, string>,
  isrcs: Map<number, string>
) {
  const filePath = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(filePath)) {
    console.error('✗ recording file not found at', filePath);
    process.exit(1);
  }

  console.log('Importing recordings…');
  const rl = await streamLines(filePath);

  let pending:  Row[]  = [];
  let allStmts: { sql: string; params: unknown[] }[] = [];
  let total    = 0;
  let skipped  = 0;
  let errors   = 0;

  const flush = async (force = false) => {
    if (pending.length === 0) return;

    // Build INSERT statements from pending rows
    while (pending.length >= ROWS_PER_INSERT || (force && pending.length > 0)) {
      const chunk = pending.splice(0, ROWS_PER_INSERT);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?)').join(',');
      const params = chunk.flatMap(r => [
        r.title, r.artist, r.duration_ms,
        r.disambiguation, r.isrc, r.release_year, r.mb_id,
      ]);
      allStmts.push({
        sql: `INSERT OR IGNORE INTO tracks
              (title, artist, duration_ms, disambiguation, isrc, release_year, mb_id)
              VALUES ${placeholders}`,
        params,
      });
    }

    // Send batches to D1
    while (allStmts.length >= STMTS_PER_BATCH || (force && allStmts.length > 0)) {
      const batch = allStmts.splice(0, STMTS_PER_BATCH);
      try {
        await d1Batch(batch);
        total += batch.reduce((sum, s) =>
          sum + (s.sql.match(/\),\s*\(/g)?.length ?? 0) + 1, 0) * ROWS_PER_INSERT;
      } catch (err) {
        console.error('  Batch error:', (err as Error).message);
        errors++;
      }
      if (total % 50_000 < ROWS_PER_INSERT * STMTS_PER_BATCH) {
        console.log(`  ${total.toLocaleString()} imported, ${skipped.toLocaleString()} skipped, ${errors} errors`);
      }
    }
  };

  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length < 5) { skipped++; continue; }

    const recId          = nullInt(cols[0]);
    const mbId           = nullStr(cols[1]);
    const title          = nullStr(cols[2]);
    const artistCreditId = nullInt(cols[3]);
    const lengthMs       = nullInt(cols[4]);
    const comment        = nullStr(cols[5]);

    if (!title || !mbId || !lengthMs || lengthMs <= 0) { skipped++; continue; }

    pending.push({
      title,
      artist:         artistCreditId != null ? (artistCredits.get(artistCreditId) ?? null) : null,
      duration_ms:    lengthMs,
      disambiguation: comment,
      isrc:           recId != null ? (isrcs.get(recId) ?? null) : null,
      release_year:   null,
      mb_id:          mbId,
    });

    await flush();
  }

  await flush(true);

  console.log('');
  console.log('Import complete:');
  console.log(`  ${total.toLocaleString()} recordings imported`);
  console.log(`  ${skipped.toLocaleString()} skipped (no duration or title)`);
  console.log(`  ${errors} batch errors`);
  console.log('');
  console.log('Rebuilding FTS index…');
  await d1Query("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')");
  console.log('Done.');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, or CLOUDFLARE_D1_DATABASE_ID in .env.local');
    process.exit(1);
  }

  console.log('MusicBrainz → Cloudflare D1');
  console.log(`  Dump path: ${MBDUMP_PATH}`);
  console.log('');

  const artistCredits = await loadArtistCredits();
  const isrcs         = await loadIsrcs();
  await importRecordings(artistCredits, isrcs);
}

main().catch(err => { console.error(err); process.exit(1); });
