/**
 * Popularity enrichment — three-tier system:
 *   1. Last.fm (primary)       — listener count, log-normalized to 5M ceiling → score 0–100
 *   2. ListenBrainz (fallback) — for tracks not found on Last.fm with a MBID, 500K ceiling
 *   3. search_count (floor)    — organic site-search signal; handled in the worker, not here
 *
 * Scoring formula:
 *   lastfmScore(n)  = min(100, round(log10(n) / log10(5_000_000) * 100))
 *   lbScore(n)      = min(100, round(log10(n) / log10(500_000)   * 100))
 *
 * Stored columns:
 *   popularity        INTEGER   0–100 (0 = found but 0 listeners, or unfound)
 *   popularity_source TEXT      'lastfm' | 'listenbrainz' | 'unfound'
 *
 * Tracks with no hit on either platform get (popularity=0, source='unfound').
 * Re-run with --include-unfound to re-try those tracks.
 *
 * Resumable: progress is saved to .popularity_cursor after each batch.
 * Interrupt at any time with Ctrl+C; next run picks up from the cursor.
 * Delete .popularity_cursor to start from scratch.
 *
 * Usage:
 *   npm run enrich-popularity                  # score all unscored tracks
 *   npm run enrich-popularity --include-unfound # also re-try 'unfound' tracks
 *
 * Requires in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 *   LASTFM_API_KEY  (free at https://www.last.fm/api/account/create)
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID     = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN      = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID    = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;

// Empirically established ceilings:
//   Last.fm — "Creep" & "Smells Like Teen Spirit" both hit ~4.1M listeners; ceiling at 5M
//   ListenBrainz — "Karma Police" at 279,805; ceiling at 500K (headroom for growth)
const LASTFM_CEILING = 5_000_000;
const LB_CEILING     = 500_000;

const BATCH_READ    = 500;    // tracks to read from D1 per loop iteration
const BATCH_WRITE   = 200;    // tracks per CASE UPDATE statement
const LASTFM_DELAY  = 210;    // ms between Last.fm calls (~4.7 req/sec, safely under 5)
const LB_BATCH_SIZE = 200;    // max recording MBIDs per ListenBrainz POST

const CURSOR_FILE = path.join(process.cwd(), '.popularity_cursor');
const D1_URL      = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── Score normalization ───────────────────────────────────────────────────────

function lastfmScore(listeners: number): number {
  if (listeners <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(listeners) / Math.log10(LASTFM_CEILING) * 100));
}

function lbScore(users: number): number {
  if (users <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(users) / Math.log10(LB_CEILING) * 100));
}

// ── D1 helpers ────────────────────────────────────────────────────────────────

async function d1Query<T>(sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/query`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const data = await res.json() as {
      success: boolean;
      result:  Array<{ results: T[]; success: boolean }>;
      errors?: unknown[];
    };
    if (!data.success) throw new Error(`D1 query error: ${JSON.stringify(data.errors)}`);
    return data.result[0]?.results ?? [];
  }
}

async function d1Raw(sql: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/raw`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const data = await res.json() as { success: boolean; errors?: unknown[] };
    if (!data.success) throw new Error(`D1 raw error: ${JSON.stringify(data.errors)}`);
    return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrackRow {
  id:     number;
  mb_id:  string | null;
  title:  string;
  artist: string | null;
}

interface ScoreResult {
  id:         number;
  popularity: number;   // 0–100
  source:     string;   // 'lastfm' | 'listenbrainz' | 'unfound'
}

// ── Last.fm ───────────────────────────────────────────────────────────────────

type LfmResult = { listeners: number } | null;

async function lastfmByMbid(mbid: string): Promise<LfmResult> {
  const url =
    `https://ws.audioscrobbler.com/2.0/?method=track.getInfo` +
    `&mbid=${encodeURIComponent(mbid)}` +
    `&api_key=${LASTFM_API_KEY}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 429) throw Object.assign(new Error('lfm429'), { is429: true });
  if (!res.ok) return null;
  const data = await res.json() as { error?: number; track?: { listeners?: string } };
  if (data.error) return null;
  const listeners = parseInt(data.track?.listeners ?? '', 10);
  return isNaN(listeners) ? null : { listeners };
}

async function lastfmByArtistTrack(artist: string, title: string): Promise<LfmResult> {
  const url =
    `https://ws.audioscrobbler.com/2.0/?method=track.getInfo` +
    `&artist=${encodeURIComponent(artist)}` +
    `&track=${encodeURIComponent(title)}` +
    `&api_key=${LASTFM_API_KEY}&format=json&autocorrect=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 429) throw Object.assign(new Error('lfm429'), { is429: true });
  if (!res.ok) return null;
  const data = await res.json() as { error?: number; track?: { listeners?: string } };
  if (data.error) return null;
  const listeners = parseInt(data.track?.listeners ?? '', 10);
  return isNaN(listeners) ? null : { listeners };
}

/** Returns listeners count, null = not found, throws if 429 */
async function lastfmLookup(track: TrackRow): Promise<LfmResult> {
  if (track.mb_id) {
    const r = await lastfmByMbid(track.mb_id);
    if (r !== null) return r;
  }
  if (track.title && track.artist) {
    return await lastfmByArtistTrack(track.artist, track.title);
  }
  return null;
}

// ── ListenBrainz ──────────────────────────────────────────────────────────────

/** Batch POST mbids → returns map of mbid → total_user_count */
async function lbLookup(mbids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let i = 0; i < mbids.length; i += LB_BATCH_SIZE) {
    const chunk = mbids.slice(i, i + LB_BATCH_SIZE);
    try {
      const res = await fetch('https://api.listenbrainz.org/1/popularity/recording', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ recording_mbids: chunk }),
        signal:  AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const data = await res.json() as Array<{ recording_mbid: string; total_user_count: number }>;
        for (const item of data) {
          if (item.recording_mbid && item.total_user_count > 0) {
            result.set(item.recording_mbid, item.total_user_count);
          }
        }
      }
    } catch { /* skip chunk on error */ }
    if (i + LB_BATCH_SIZE < mbids.length) await sleep(500);
  }
  return result;
}

// ── D1 batch write ────────────────────────────────────────────────────────────

function buildUpdate(chunk: ScoreResult[]): string {
  const popBranches = chunk.map(r => `WHEN ${r.id} THEN ${r.popularity}`).join(' ');
  const srcBranches = chunk.map(r => `WHEN ${r.id} THEN '${r.source}'`).join(' ');
  const ids         = chunk.map(r => r.id).join(',');
  return (
    `UPDATE tracks SET ` +
    `popularity = CASE id ${popBranches} ELSE popularity END, ` +
    `popularity_source = CASE id ${srcBranches} ELSE popularity_source END ` +
    `WHERE id IN (${ids})`
  );
}

async function flushResults(pending: ScoreResult[]): Promise<{ written: number; errors: number }> {
  let written = 0;
  let errors  = 0;
  for (let i = 0; i < pending.length; i += BATCH_WRITE) {
    const chunk = pending.slice(i, i + BATCH_WRITE);
    try {
      await d1Raw(buildUpdate(chunk));
      written += chunk.length;
    } catch (err) {
      errors++;
      if (errors <= 5) console.error('\n  Write error:', (err as Error).message.slice(0, 200));
    }
  }
  return { written, errors };
}

// ── Cursor ────────────────────────────────────────────────────────────────────

function readCursor(): number {
  try { return parseInt(fs.readFileSync(CURSOR_FILE, 'utf8').trim(), 10) || 0; }
  catch { return 0; }
}

function writeCursor(id: number): void {
  fs.writeFileSync(CURSOR_FILE, String(id), 'utf8');
}

// ── Cron lock ─────────────────────────────────────────────────────────────────

let lockCleared = false;

async function acquireLock(): Promise<void> {
  await d1Raw('UPDATE enrichment_lock SET local_active = 1 WHERE id = 1');
  console.log('Cron paused — local enrichment has the lock.');
}

async function releaseLock(): Promise<void> {
  if (lockCleared) return;
  lockCleared = true;
  try {
    await d1Raw('UPDATE enrichment_lock SET local_active = 0 WHERE id = 1');
    console.log('Lock released — cron will resume on next tick.');
  } catch { /* best-effort */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }
  if (!LASTFM_API_KEY) {
    console.error(
      'Missing LASTFM_API_KEY in .env.local\n' +
      'Get a free key at: https://www.last.fm/api/account/create'
    );
    process.exit(1);
  }

  // Pause the worker cron so both don't hammer Last.fm simultaneously
  await acquireLock();

  // Release lock on Ctrl+C or kill signal
  process.on('SIGINT',  async () => { await releaseLock(); process.exit(0); });
  process.on('SIGTERM', async () => { await releaseLock(); process.exit(0); });

  const includeUnfound = process.argv.includes('--include-unfound');
  const whereClause    = includeUnfound
    ? `(popularity IS NULL OR popularity_source = 'unfound')`
    : `popularity IS NULL`;

  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit    = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

  let cursor = readCursor();
  if (cursor > 0) {
    console.log(`Resuming from cursor: id > ${cursor}`);
  } else {
    console.log('Starting fresh (no cursor file found)');
  }

  let totalProcessed = 0;
  let totalLastfm    = 0;
  let totalLb        = 0;
  let totalUnfound   = 0;
  let totalWriteErrs = 0;
  let exhausted      = false;
  const startTime    = Date.now();

  console.log('');
  console.log('Popularity Enrichment — Last.fm → ListenBrainz');
  console.log(`  Last.fm ceiling:      ${LASTFM_CEILING.toLocaleString()} listeners`);
  console.log(`  ListenBrainz ceiling: ${LB_CEILING.toLocaleString()} users`);
  console.log(`  Read batch:    ${BATCH_READ} tracks/batch`);
  console.log(`  Write batch:   ${BATCH_WRITE} tracks/statement`);
  console.log(`  Last.fm delay: ${LASTFM_DELAY}ms between calls`);
  console.log(`  Mode: ${includeUnfound ? 'all unscored + retry unfound' : 'unscored only'}`);
  console.log('');

  for (;;) {
    // ── Read a batch of unscored tracks ──────────────────────────────────────
    const rows = await d1Query<TrackRow>(
      `SELECT id, mb_id, title, artist FROM tracks ` +
      `WHERE ${whereClause} AND id > ${cursor} ORDER BY id LIMIT ${BATCH_READ}`
    );

    if (rows.length === 0) {
      exhausted = true;
      console.log('\nNo more tracks to process — done!');
      break;
    }

    if (totalProcessed >= limit) {
      console.log(`\nReached --limit=${limit}. Stopping.`);
      break;
    }

    const pending: ScoreResult[]  = [];
    const lbNeededIds: string[]   = [];        // mb_ids for LB fallback
    const mbidToTrackId           = new Map<string, number>(); // mb_id → track.id

    // ── Last.fm pass ─────────────────────────────────────────────────────────
    for (let i = 0; i < rows.length; i++) {
      const track = rows[i];
      if (i > 0) await sleep(LASTFM_DELAY);

      try {
        const lfm = await lastfmLookup(track);

        if (lfm !== null) {
          // Found on Last.fm
          pending.push({ id: track.id, popularity: lastfmScore(lfm.listeners), source: 'lastfm' });
          totalLastfm++;
        } else if (track.mb_id) {
          // Not on Last.fm but has MBID → try ListenBrainz
          lbNeededIds.push(track.mb_id);
          mbidToTrackId.set(track.mb_id, track.id);
        } else {
          // No Last.fm hit, no MBID → unfound
          pending.push({ id: track.id, popularity: 0, source: 'unfound' });
          totalUnfound++;
        }

      } catch (err: unknown) {
        const e = err as { is429?: boolean; message?: string };
        if (e.is429) {
          // Rate limited — flush what we have, wait 30s, enqueue remaining via LB/unfound
          console.error(`\n  Last.fm 429 at track ${i + 1}/${rows.length} — pausing 30s`);
          for (let j = i + 1; j < rows.length; j++) {
            const t = rows[j];
            if (t.mb_id) { lbNeededIds.push(t.mb_id); mbidToTrackId.set(t.mb_id, t.id); }
            else          { pending.push({ id: t.id, popularity: 0, source: 'unfound' }); totalUnfound++; }
          }
          await sleep(30_000);
          break;
        }
        // Other error → treat as LB candidate or unfound
        if (track.mb_id) { lbNeededIds.push(track.mb_id); mbidToTrackId.set(track.mb_id, track.id); }
        else              { pending.push({ id: track.id, popularity: 0, source: 'unfound' }); totalUnfound++; }
      }
    }

    // ── ListenBrainz pass ────────────────────────────────────────────────────
    if (lbNeededIds.length > 0) {
      const lbMap = await lbLookup(lbNeededIds);
      for (const mbid of lbNeededIds) {
        const trackId = mbidToTrackId.get(mbid)!;
        const users   = lbMap.get(mbid);
        if (users != null && users > 0) {
          pending.push({ id: trackId, popularity: lbScore(users), source: 'listenbrainz' });
          totalLb++;
        } else {
          pending.push({ id: trackId, popularity: 0, source: 'unfound' });
          totalUnfound++;
        }
      }
    }

    // ── Write results to D1 ──────────────────────────────────────────────────
    const { written, errors } = await flushResults(pending);
    totalProcessed  += rows.length;
    totalWriteErrs  += errors;

    // Advance cursor to last id in this batch
    cursor = rows[rows.length - 1].id;
    writeCursor(cursor);

    // ── Progress ─────────────────────────────────────────────────────────────
    const elapsedSec = (Date.now() - startTime) / 1000;
    const ratePerMin = elapsedSec > 0 ? Math.round((totalProcessed / elapsedSec) * 60) : 0;

    if (limit < Infinity) {
      const pct      = ((totalProcessed / limit) * 100).toFixed(1);
      const etaSec   = ratePerMin > 0 ? ((limit - totalProcessed) / ratePerMin) * 60 : 0;
      process.stdout.write(
        `\r  ${totalProcessed.toLocaleString()}/${limit.toLocaleString()} (${pct}%) | ` +
        `ETA: ${fmtDuration(etaSec)} | ` +
        `lfm: ${totalLastfm.toLocaleString()}  lb: ${totalLb.toLocaleString()}  unfound: ${totalUnfound.toLocaleString()} | ` +
        `${ratePerMin}/min`
      );
    } else {
      process.stdout.write(
        `\r  ${totalProcessed.toLocaleString()} processed | ` +
        `${fmtDuration(elapsedSec)} elapsed | ` +
        `lfm: ${totalLastfm.toLocaleString()}  lb: ${totalLb.toLocaleString()}  unfound: ${totalUnfound.toLocaleString()} | ` +
        `${ratePerMin}/min`
      );
    }
  }

  process.stdout.write('\n');

  // Only delete the cursor when all tracks are exhausted.
  // If we stopped due to --limit, keep it so the next run continues from here.
  if (exhausted) {
    try { fs.unlinkSync(CURSOR_FILE); } catch { /* already gone */ }
  }

  await releaseLock();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const scored  = totalLastfm + totalLb;

  console.log('');
  console.log(`  Finished in ${elapsed}s`);
  console.log(`  Total processed:   ${totalProcessed.toLocaleString()}`);
  console.log(`  Scored via Last.fm:      ${totalLastfm.toLocaleString()}`);
  console.log(`  Scored via ListenBrainz: ${totalLb.toLocaleString()}`);
  console.log(`  Unfound (both platforms): ${totalUnfound.toLocaleString()}`);
  console.log(`  Hit rate: ${totalProcessed > 0 ? ((scored / totalProcessed) * 100).toFixed(1) : 0}%`);
  if (totalWriteErrs > 0) console.warn(`  D1 write errors: ${totalWriteErrs}`);
  console.log('');
  console.log('Run again with --include-unfound to re-try unfound tracks.');
}

main().catch(err => { console.error(err); process.exit(1); });
