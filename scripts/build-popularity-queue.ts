/**
 * Build Popularity Queue
 *
 * Creates the popularity_queue table and fills it with every track that
 * doesn't yet have a popularity score. Run once to bootstrap the queue;
 * after that the worker cron drains it and the daily MB sync refills it
 * with any new tracks.
 *
 * Why: the old cron did ORDER BY search_count DESC on 2M rows every minute
 * (≈2.9B D1 row-reads/day). With a pre-built queue the cron reads exactly
 * 50 rows per tick instead.
 *
 * Cost: one full scan of the tracks table (2M reads) + ~2M queue writes.
 * One-time. After that the cron costs ~100 reads/tick instead of 2M.
 *
 * Usage:
 *   npm run build-popularity-queue
 *
 * Required in .env.local:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 */

import * as path   from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;

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
    const text = await res.text();
    let data: { success: boolean; errors?: unknown[] };
    try { data = JSON.parse(text); } catch { throw new Error(`D1 HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (!data.success) throw new Error(`D1: ${JSON.stringify(data.errors)}`);
    return;
  }
}

async function d1Query<T>(sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${D1_URL}/query`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sql, params: [] }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await res.text();
    const data = JSON.parse(text) as {
      success: boolean;
      result?: Array<{ results: T[] }>;
      errors?: unknown[];
    };
    if (!data.success) throw new Error(`D1 query: ${JSON.stringify(data.errors)}`);
    return data.result?.[0]?.results ?? [];
  }
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local'); process.exit(1);
  }

  console.log('Build Popularity Queue');
  console.log('─────────────────────────────────────────\n');

  // 1. Create the queue table
  console.log('Creating popularity_queue table...');
  await d1Raw(`
    CREATE TABLE IF NOT EXISTS popularity_queue (
      track_id INTEGER PRIMARY KEY
    )
  `);
  console.log('  Done.\n');

  // 2. Check current queue size
  const before = await d1Query<{ n: number }>(`SELECT COUNT(*) as n FROM popularity_queue`);
  console.log(`Queue currently has ${before[0]?.n?.toLocaleString() ?? 0} rows.\n`);

  // 3. Populate from unscored tracks — single server-side INSERT...SELECT,
  //    no client-side batching needed. D1 executes it entirely in SQLite.
  console.log('Inserting unscored tracks into queue...');
  console.log('(This scans the tracks table once and may take a moment)\n');

  await d1Raw(`
    INSERT OR IGNORE INTO popularity_queue (track_id)
    SELECT id FROM tracks WHERE popularity IS NULL
  `);

  // 4. Report final size
  const after = await d1Query<{ n: number }>(`SELECT COUNT(*) as n FROM popularity_queue`);
  const added = (after[0]?.n ?? 0) - (before[0]?.n ?? 0);

  console.log(`Done.`);
  console.log(`  Tracks added to queue : ${added.toLocaleString()}`);
  console.log(`  Queue total           : ${after[0]?.n?.toLocaleString() ?? 0}`);
  console.log('');
  console.log('The worker cron will now drain this queue at 50 tracks/tick');
  console.log('instead of scanning 2M rows every minute.');
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
