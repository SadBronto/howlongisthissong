/**
 * Fix Bad Durations
 *
 * Finds all tracks with duration_ms > 3,600,000 (over 1 hour) and attempts
 * to correct them using external sources:
 *   1. iTunes Search API  (free, no auth required)
 *   2. Last.fm track.getInfo (uses LASTFM_API_KEY from .env.local)
 *
 * Logic per track:
 *   - External source returns a different value → update D1
 *   - External source returns the same value   → confirmed correct, leave it
 *   - No source finds it                       → log to fix_durations_manual.tsv
 *
 * Each correction is written to D1 immediately. Naturally resumable:
 * fixed tracks fall out of the WHERE duration_ms > 3600000 query on re-run.
 *
 * Usage:
 *   npm run fix-durations
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 *   LASTFM_API_KEY
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const LASTFM_KEY  = process.env.LASTFM_API_KEY ?? '';

const MANUAL_FILE  = path.join(process.cwd(), 'fix_durations_manual.tsv');
const BAR_WIDTH    = 32;
const ITUNES_CONC  = 15;  // concurrent iTunes lookups — no meaningful rate limit

// ── D1 helpers ─────────────────────────────────────────────────────────────────

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

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

// ── External lookups ───────────────────────────────────────────────────────────

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function tryItunes(title: string, artist: string): Promise<number | null> {
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const res  = await fetch(
      `https://itunes.apple.com/search?term=${term}&entity=song&limit=10`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as {
      results: Array<{ trackName: string; trackTimeMillis?: number }>;
    };
    const want = normTitle(title);
    for (const r of data.results) {
      if (normTitle(r.trackName) === want && r.trackTimeMillis && r.trackTimeMillis > 0) {
        return r.trackTimeMillis;
      }
    }
    return null;
  } catch { return null; }
}

async function tryLastfm(title: string, artist: string): Promise<number | null> {
  if (!LASTFM_KEY) return null;
  try {
    const res = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=track.getInfo` +
      `&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}` +
      `&api_key=${LASTFM_KEY}&format=json&autocorrect=1`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as { error?: number; track?: { duration?: string } };
    if (data.error || !data.track?.duration) return null;
    const ms = parseInt(data.track.duration, 10);
    return isNaN(ms) || ms <= 0 ? null : ms;
  } catch { return null; }
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2,'0')}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

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

interface TrackRow {
  mb_id:       string;
  title:       string;
  artist:      string | null;
  duration_ms: number;
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }

  console.log('Fix Bad Durations');
  console.log('  Source order: iTunes → Last.fm → manual review');
  console.log('');

  process.stdout.write('Loading flagged tracks from D1…');
  const tracks = await d1Query<TrackRow>(
    `SELECT mb_id, title, artist, duration_ms FROM tracks
     WHERE duration_ms > 3600000 ORDER BY duration_ms DESC`,
  );
  process.stdout.write(`\r  ${tracks.length.toLocaleString()} tracks with duration_ms > 3,600,000\n\n`);

  if (tracks.length === 0) {
    console.log('Nothing to fix — all done!');
    return;
  }

  const manual = fs.createWriteStream(MANUAL_FILE, { encoding: 'utf8' });
  manual.write('mb_id\ttitle\tartist\tduration_ms\tduration_display\n');

  const stats   = { itunes: 0, lastfm: 0, confirmed: 0, manual: 0 };
  const startMs = Date.now();
  const lfmQueue: TrackRow[] = [];
  let done = 0;

  // ── Pass 1: iTunes — 15 concurrent, no rate limit ─────────────────────────
  const active = new Map<symbol, Promise<void>>();
  async function runItunes(track: TrackRow): Promise<void> {
    const art      = track.artist ?? '';
    const itunesMs = await tryItunes(track.title, art);
    if (itunesMs !== null) {
      if (itunesMs !== track.duration_ms) {
        await d1Raw(`UPDATE tracks SET duration_ms = ${itunesMs} WHERE mb_id = '${track.mb_id}'`);
        stats.itunes++;
      } else {
        stats.confirmed++;
      }
    } else {
      lfmQueue.push(track);
    }
    renderBar(++done, tracks.length, startMs);
  }

  for (const track of tracks) {
    const key = Symbol();
    const p   = runItunes(track).finally(() => active.delete(key));
    active.set(key, p);
    if (active.size >= ITUNES_CONC) await Promise.race(active.values());
  }
  await Promise.all(active.values());
  process.stdout.write('\n');

  // ── Pass 2: Last.fm — sequential, 1.1 s between calls ─────────────────────
  if (lfmQueue.length > 0) {
    console.log(`\n  iTunes missed ${lfmQueue.length} tracks — trying Last.fm…`);
    for (let i = 0; i < lfmQueue.length; i++) {
      const { mb_id, title, artist, duration_ms } = lfmQueue[i];
      const art      = artist ?? '';
      const lastfmMs = await tryLastfm(title, art);
      if (lastfmMs !== null) {
        if (lastfmMs !== duration_ms) {
          await d1Raw(`UPDATE tracks SET duration_ms = ${lastfmMs} WHERE mb_id = '${mb_id}'`);
          stats.lastfm++;
        } else {
          stats.confirmed++;
        }
      } else {
        manual.write(`${mb_id}\t${title}\t${art}\t${duration_ms}\t${fmtMs(duration_ms)}\n`);
        stats.manual++;
      }
      process.stdout.write(`\r  Last.fm: ${i + 1}/${lfmQueue.length}   `);
      await sleep(1100);
    }
    process.stdout.write('\n');
  }
  await new Promise<void>((res, rej) => manual.end(err => err ? rej(err) : res()));

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  console.log('');
  console.log(`  Done in ${elapsed}s`);
  console.log(`  iTunes corrections:  ${stats.itunes}`);
  console.log(`  Last.fm corrections: ${stats.lastfm}`);
  console.log(`  Confirmed correct:   ${stats.confirmed}`);
  console.log(`  Manual review:       ${stats.manual}`);
  if (stats.manual > 0) console.log(`\n  Review file → ${MANUAL_FILE}`);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
