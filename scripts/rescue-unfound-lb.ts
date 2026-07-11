/**
 * Rescue mis-marked 'unfound' tracks via ListenBrainz.
 *
 * Background: ListenBrainz's popularity endpoint started returning 401 for
 * unauthenticated requests ("provide an Auth token"). The worker cron + the
 * enrich script were calling it with NO token, so the LB fallback silently
 * returned nothing — any track checked after that break got stamped 'unfound'
 * even when it HAS ListenBrainz data. This one-off, LB-only pass re-checks the
 * whole 'unfound' bucket WITH the token and upgrades the hits to a real score.
 *
 * It does NOT touch Last.fm (those tracks already missed Last.fm) and it does
 * NOT touch the unscored queue (that's the cron's job).
 *
 * Usage:
 *   npx tsx scripts/rescue-unfound-lb.ts --dry-run [--limit=N]   # measure hit rate, no writes
 *   npx tsx scripts/rescue-unfound-lb.ts [--limit=N]             # real run (writes hits)
 *
 * Requires in .env.local: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID
 * Requires LISTENBRAINZ_TOKEN in .dev.vars (or the environment).
 *
 * Resumable: progress saved to .rescue_cursor after each batch (real runs only).
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;

// LB token: prefer env, else parse it out of .dev.vars (never printed)
function loadLbToken(): string {
  if (process.env.LISTENBRAINZ_TOKEN) return process.env.LISTENBRAINZ_TOKEN.trim();
  const p = path.resolve(process.cwd(), '.dev.vars');
  if (fs.existsSync(p)) {
    for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('LISTENBRAINZ_TOKEN')) {
        return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return '';
}
const LB_TOKEN = loadLbToken();

const LB_CEILING    = 500_000;   // same ceiling as enrich-popularity.ts
const BATCH_READ    = 200;       // unfound rows read per loop
const BATCH_WRITE   = 200;       // rows per CASE UPDATE
const LB_BATCH_SIZE = 200;       // max MBIDs per LB POST
const LB_DELAY      = 300;       // ms between LB POSTs (polite pacing)

const CURSOR_FILE = path.join(process.cwd(), '.rescue_cursor');
const D1_URL      = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT    = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function lbScore(users: number): number {
  if (users <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(users) / Math.log10(LB_CEILING) * 100));
}

// ── D1 helpers (same REST pattern as enrich-popularity.ts) ─────────────────────
async function d1Query<T>(sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/query`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as { success: boolean; result: Array<{ results: T[] }>; errors?: unknown[] };
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
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const data = await res.json() as { success: boolean; errors?: unknown[] };
    if (!data.success) throw new Error(`D1 raw error: ${JSON.stringify(data.errors)}`);
    return;
  }
}

// ── ListenBrainz (authenticated, rate-limit aware) ─────────────────────────────
async function lbLookup(mbids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let i = 0; i < mbids.length; i += LB_BATCH_SIZE) {
    const chunk = mbids.slice(i, i + LB_BATCH_SIZE);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch('https://api.listenbrainz.org/1/popularity/recording', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Token ${LB_TOKEN}`,
            'User-Agent':    'HowLongIsThisSong/1.0 (nrctrivia@gmail.com)',
          },
          body:    JSON.stringify({ recording_mbids: chunk }),
          signal:  AbortSignal.timeout(20_000),
        });
        if (res.status === 429) {
          const resetIn = parseInt(res.headers.get('x-ratelimit-reset-in') || '5', 10);
          console.error(`\n  LB 429 — sleeping ${resetIn + 1}s`);
          await sleep((resetIn + 1) * 1000);
          continue;
        }
        if (res.ok) {
          const data = await res.json() as Array<{ recording_mbid: string; total_user_count: number }>;
          for (const item of data) {
            if (item.recording_mbid && item.total_user_count > 0) {
              result.set(item.recording_mbid, item.total_user_count);
            }
          }
          // Respect remaining budget
          const remaining = parseInt(res.headers.get('x-ratelimit-remaining') || '999', 10);
          if (remaining <= 2) {
            const resetIn = parseInt(res.headers.get('x-ratelimit-reset-in') || '5', 10);
            await sleep((resetIn + 1) * 1000);
          }
        } else if (res.status === 401) {
          throw new Error('LB 401 — token missing or invalid. Aborting.');
        }
        break;
      } catch (err) {
        if (attempt >= 3 || (err as Error).message?.includes('401')) throw err;
        await sleep(1500 * (attempt + 1));
      }
    }
    if (i + LB_BATCH_SIZE < mbids.length) await sleep(LB_DELAY);
  }
  return result;
}

// ── CASE UPDATE for the hits only ──────────────────────────────────────────────
function buildUpdate(chunk: Array<{ id: number; popularity: number }>): string {
  const popBranches = chunk.map(r => `WHEN ${r.id} THEN ${r.popularity}`).join(' ');
  const ids         = chunk.map(r => r.id).join(',');
  return (
    `UPDATE tracks SET popularity = CASE id ${popBranches} ELSE popularity END, ` +
    `popularity_source = 'listenbrainz' WHERE id IN (${ids})`
  );
}

// ── Cron lock ──────────────────────────────────────────────────────────────────
let lockCleared = false;
async function acquireLock() { await d1Raw('UPDATE enrichment_lock SET local_active = 1 WHERE id = 1'); console.log('Cron paused — rescue has the lock.'); }
async function releaseLock() {
  if (lockCleared) return; lockCleared = true;
  try { await d1Raw('UPDATE enrichment_lock SET local_active = 0 WHERE id = 1'); console.log('Lock released — cron resumes next tick.'); } catch {}
}

function readCursor(): number { try { return parseInt(fs.readFileSync(CURSOR_FILE, 'utf8').trim(), 10) || 0; } catch { return 0; } }
function writeCursor(id: number): void { fs.writeFileSync(CURSOR_FILE, String(id), 'utf8'); }

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) { console.error('Missing Cloudflare creds in .env.local'); process.exit(1); }
  if (!LB_TOKEN) { console.error('Missing LISTENBRAINZ_TOKEN (env or .dev.vars)'); process.exit(1); }

  console.log('');
  console.log(`Rescue 'unfound' via ListenBrainz  ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE — will write hits)'}`);
  console.log(`  LB token: loaded (len=${LB_TOKEN.length}, not shown)`);
  console.log(`  Limit: ${LIMIT === Infinity ? 'all' : LIMIT}`);
  console.log('');

  if (!DRY_RUN) {
    await acquireLock();
    process.on('SIGINT',  async () => { await releaseLock(); process.exit(0); });
    process.on('SIGTERM', async () => { await releaseLock(); process.exit(0); });
  }

  let cursor = DRY_RUN ? 0 : readCursor();
  if (!DRY_RUN && cursor > 0) console.log(`Resuming from cursor id > ${cursor}`);

  let scanned = 0, hits = 0, written = 0, writeErrs = 0;
  const start = Date.now();

  for (;;) {
    if (scanned >= LIMIT) { console.log(`\nReached --limit=${LIMIT}.`); break; }
    const rows = await d1Query<{ id: number; mb_id: string }>(
      `SELECT id, mb_id FROM tracks WHERE popularity_source='unfound' AND mb_id IS NOT NULL ` +
      `AND id > ${cursor} ORDER BY id LIMIT ${BATCH_READ}`
    );
    if (rows.length === 0) { console.log('\nNo more unfound tracks — done!'); break; }

    const mbids = rows.map(r => r.mb_id);
    const lbMap = await lbLookup(mbids);

    const pending: Array<{ id: number; popularity: number }> = [];
    for (const r of rows) {
      const users = lbMap.get(r.mb_id);
      if (users != null && users > 0) { pending.push({ id: r.id, popularity: lbScore(users) }); hits++; }
    }

    if (!DRY_RUN && pending.length > 0) {
      for (let i = 0; i < pending.length; i += BATCH_WRITE) {
        try { await d1Raw(buildUpdate(pending.slice(i, i + BATCH_WRITE))); written += Math.min(BATCH_WRITE, pending.length - i); }
        catch (e) { writeErrs++; if (writeErrs <= 5) console.error('\n  Write error:', (e as Error).message.slice(0, 160)); }
      }
    }

    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
    if (!DRY_RUN) writeCursor(cursor);

    const secs = (Date.now() - start) / 1000;
    const rate = secs > 0 ? Math.round((scanned / secs) * 60) : 0;
    process.stdout.write(
      `\r  scanned ${scanned.toLocaleString()} | LB hits ${hits.toLocaleString()} ` +
      `(${scanned > 0 ? ((hits / scanned) * 100).toFixed(1) : 0}%) | ` +
      `${DRY_RUN ? 'writes skipped' : `written ${written.toLocaleString()}`} | ${rate}/min`
    );
  }

  process.stdout.write('\n\n');
  if (!DRY_RUN) { try { fs.unlinkSync(CURSOR_FILE); } catch {} await releaseLock(); }

  console.log(`  Scanned:  ${scanned.toLocaleString()} unfound tracks`);
  console.log(`  LB hits:  ${hits.toLocaleString()}  (${scanned > 0 ? ((hits / scanned) * 100).toFixed(1) : 0}% coverage)`);
  if (!DRY_RUN) console.log(`  Rescued (written): ${written.toLocaleString()}${writeErrs ? `  (write errors: ${writeErrs})` : ''}`);
  else          console.log(`  DRY RUN — projected writes if run live: ${hits.toLocaleString()} rows (~$${(hits / 1_000_000).toFixed(2)})`);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
