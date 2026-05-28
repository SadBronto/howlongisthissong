/**
 * Fix Bad Durations — MusicBrainz API Pass
 *
 * Reads fix_durations_manual.tsv (tracks unresolved by iTunes/Last.fm)
 * and queries the live MusicBrainz API for each recording.
 *
 * Logic per track:
 *   - MB returns a different duration  → update D1 with corrected value
 *   - MB returns the same bad duration → null out duration_ms in D1
 *   - MB has no duration / no record   → null out duration_ms in D1
 *
 * A null is invisible to sorted lists; a wrong value skews them.
 * Rate: 1 req/sec per MusicBrainz requirements (~32 min for 1,940 tracks).
 * Naturally resumable: nulled/fixed tracks are no longer in the TSV source.
 *
 * Usage:
 *   npm run fix-durations-mb
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;

const MANUAL_FILE = path.join(process.cwd(), 'fix_durations_manual.tsv');
const BAR_WIDTH   = 32;
const MB_DELAY    = 1050; // ms between requests — MB allows 1 req/sec
const MB_UA       = 'HowLongIsThisSong/1.0 (howlongisthissong.com)';

// ── D1 helpers ─────────────────────────────────────────────────────────────────

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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

// ── MusicBrainz lookup ─────────────────────────────────────────────────────────

async function mbDuration(mbid: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording/${mbid}?fmt=json`,
      { headers: { 'User-Agent': MB_UA }, signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as { length?: number | null };
    return (data.length && data.length > 0) ? data.length : null;
  } catch { return null; }
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '--';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function renderBar(done: number, total: number, startMs: number): void {
  const pct     = total > 0 ? done / total : 0;
  const filled  = Math.round(pct * BAR_WIDTH);
  const bar     = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const elapsed = (Date.now() - startMs) / 1000;
  const rate    = elapsed > 0 ? done / elapsed : 0;
  const etaSec  = rate > 0 ? (total - done) / rate : 0;
  process.stdout.write(
    `\r  [${bar}] ${Math.round(pct * 100)}%  ${done.toLocaleString()}/${total.toLocaleString()} tracks  ETA: ${fmtEta(etaSec)}   `,
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

interface TsvRow {
  mb_id:       string;
  duration_ms: number;
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }
  if (!fs.existsSync(MANUAL_FILE)) {
    console.error(`Not found: ${MANUAL_FILE}\nRun npm run fix-durations first.`); process.exit(1);
  }

  // Parse TSV (columns: mb_id, title, artist, duration_ms, duration_display)
  const lines  = fs.readFileSync(MANUAL_FILE, 'utf8').split('\n').filter(Boolean);
  const tracks: TsvRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const mb_id = cols[0]?.trim();
    const duration_ms = parseInt(cols[3] ?? '', 10);
    if (mb_id && !isNaN(duration_ms)) tracks.push({ mb_id, duration_ms });
  }

  console.log('Fix Bad Durations — MusicBrainz API pass');
  console.log(`  ${tracks.length.toLocaleString()} tracks to check`);
  console.log(`  Rate: 1 req/sec  (~${Math.round(tracks.length * MB_DELAY / 60000)} min estimated)\n`);

  const stats   = { updated: 0, nulled: 0, errors: 0 };
  const startMs = Date.now();

  for (let i = 0; i < tracks.length; i++) {
    const { mb_id, duration_ms } = tracks[i];
    const callStart = Date.now();

    try {
      const mbMs = await mbDuration(mb_id);

      if (mbMs !== null && mbMs !== duration_ms) {
        // MB has a corrected value — update
        await d1Raw(`UPDATE tracks SET duration_ms = ${mbMs} WHERE mb_id = '${mb_id}'`);
        stats.updated++;
      } else {
        // MB confirms the same bad value, or has no duration — null it out
        await d1Raw(`UPDATE tracks SET duration_ms = NULL WHERE mb_id = '${mb_id}'`);
        stats.nulled++;
      }
    } catch {
      stats.errors++;
    }

    renderBar(i + 1, tracks.length, startMs);

    // Respect MB 1 req/sec rate limit
    const wait = MB_DELAY - (Date.now() - callStart);
    if (wait > 0) await sleep(wait);
  }

  process.stdout.write('\n');
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log('');
  console.log(`  Done in ${elapsed}s`);
  console.log(`  Updated with MB value: ${stats.updated}`);
  console.log(`  Nulled (unverifiable): ${stats.nulled}`);
  console.log(`  Errors:                ${stats.errors}`);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
