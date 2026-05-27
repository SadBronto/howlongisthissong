/**
 * MusicBrainz → Cloudflare D1 Import
 *
 * Reads recording, artist_credit, and isrc files from the MusicBrainz dump
 * and batch-inserts into Cloudflare D1 via the REST API (/raw endpoint).
 *
 * Usage:
 *   npm run import-d1
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

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const MBDUMP_PATH = process.env.MBDUMP_PATH ?? './mbdump';

// Rows per INSERT statement sent to /raw
// Keep well under D1's 1 MB request body limit
const ROWS_PER_INSERT = 250;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── Cloudflare D1 REST API (/raw) ─────────────────────────────────────────────

async function d1Raw(sql: string): Promise<void> {
  const res = await fetch(`${D1_URL}/raw`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params: [] }),
  });

  if (res.status === 429) {
    // Rate limited — wait 2 s and retry once
    await new Promise(r => setTimeout(r, 2000));
    return d1Raw(sql);
  }

  const data = await res.json() as { success: boolean; errors?: unknown[] };
  if (!data.success) {
    throw new Error(`D1 raw failed: ${JSON.stringify(data.errors)}`);
  }
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

/** Safely inline a string value into SQL (doubles single quotes). */
function s(v: string | null): string {
  if (v === null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

/** Safely inline an integer into SQL. */
function n(v: number | null): string {
  return v === null ? 'NULL' : String(Math.round(v));
}

// ── File streaming ────────────────────────────────────────────────────────────

async function streamLines(filePath: string) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function nullStr(s: string): string | null {
  return s === '\\N' || s === '' ? null : s;
}

function nullInt(s: string): number | null {
  if (s === '\\N' || s === '') return null;
  const v = parseInt(s, 10);
  return isNaN(v) ? null : v;
}

// ── Step 1: Load artist credits ───────────────────────────────────────────────
// Columns: id | name | artist_count | ref_count | ...

async function loadArtistCredits(): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'artist_credit');
  const credits  = new Map<number, string>();
  if (!fs.existsSync(filePath)) {
    console.warn('⚠  artist_credit not found — artist names will be null');
    return credits;
  }
  console.log('Loading artist credits…');
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const id   = parseInt(cols[0], 10);
    const name = nullStr(cols[1]);
    if (!isNaN(id) && name) credits.set(id, name);
  }
  console.log(`  ${credits.size.toLocaleString()} artist credits loaded`);
  return credits;
}

// ── Step 2: Load ISRCs ────────────────────────────────────────────────────────
// Columns: id | recording | isrc | source | edits_pending

async function loadIsrcs(): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'isrc');
  const isrcs    = new Map<number, string>();
  if (!fs.existsSync(filePath)) {
    console.warn('⚠  isrc file not found — ISRC codes will be null');
    return isrcs;
  }
  console.log('Loading ISRCs…');
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols      = line.split('\t');
    if (cols.length < 3) continue;
    const recId     = nullInt(cols[1]);
    const isrc      = nullStr(cols[2]);
    if (recId != null && isrc && !isrcs.has(recId)) isrcs.set(recId, isrc);
  }
  console.log(`  ${isrcs.size.toLocaleString()} ISRCs loaded`);
  return isrcs;
}

// ── Step 3: Import recordings ─────────────────────────────────────────────────
// Columns: id | gid | name | artist_credit | length | comment | ...

type Row = {
  title:          string;
  artist:         string | null;
  duration_ms:    number;
  disambiguation: string | null;
  isrc:           string | null;
  mb_id:          string;
};

async function importRecordings(
  artistCredits: Map<number, string>,
  isrcs:         Map<number, string>,
) {
  const filePath = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(filePath)) {
    console.error('✗ recording file not found at', filePath);
    process.exit(1);
  }

  console.log('Importing recordings…');
  const rl = await streamLines(filePath);

  let pending: Row[] = [];
  let total   = 0;
  let skipped = 0;
  let errors  = 0;

  const flush = async (force = false) => {
    while (pending.length >= ROWS_PER_INSERT || (force && pending.length > 0)) {
      const chunk = pending.splice(0, ROWS_PER_INSERT);

      // Build a single INSERT with all rows inlined — no parameters needed
      const values = chunk.map(r =>
        `(${s(r.title)},${s(r.artist)},NULL,${n(r.duration_ms)},${s(r.disambiguation)},${s(r.isrc)},NULL,${s(r.mb_id)})`
      ).join(',');

      const sql =
        `INSERT OR IGNORE INTO tracks (title,artist,album,duration_ms,disambiguation,isrc,release_year,mb_id) VALUES ${values}`;

      try {
        await d1Raw(sql);
        total += chunk.length;
      } catch (err) {
        console.error('\n  Insert error:', (err as Error).message);
        errors++;
      }

      if (total > 0 && total % 10_000 < ROWS_PER_INSERT) {
        process.stdout.write(`\r  ${total.toLocaleString()} imported, ${skipped.toLocaleString()} skipped, ${errors} errors`);
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
      mb_id:          mbId,
    });

    await flush();
  }

  await flush(true);

  console.log('');
  console.log('Import complete:');
  console.log(`  ${total.toLocaleString()} recordings imported`);
  console.log(`  ${skipped.toLocaleString()} skipped (no duration or title)`);
  console.log(`  ${errors} errors`);
  console.log('');
  console.log('Rebuilding FTS index…');
  await d1Raw("INSERT INTO tracks_fts(tracks_fts) VALUES('rebuild')");
  console.log('Done.');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local');
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
