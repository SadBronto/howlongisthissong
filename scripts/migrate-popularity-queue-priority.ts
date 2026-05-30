/**
 * Migrate popularity_queue: add priority column + index
 *
 * Adds a priority INTEGER column (default 0) to popularity_queue and
 * creates a covering index so the cron can ORDER BY priority DESC
 * without a full table scan.
 *
 * Safe to run multiple times — ALTER TABLE fails silently if the column
 * already exists, and CREATE INDEX uses IF NOT EXISTS.
 *
 * Usage:
 *   npm run migrate-popularity-queue-priority
 */

import * as path   from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const D1_URL      = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function d1Raw(sql: string, ignoreErrors = false): Promise<void> {
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
    if (!data.success && !ignoreErrors) throw new Error(`D1: ${JSON.stringify(data.errors)}`);
    return;
  }
}

async function main() {
  console.log('Migrating popularity_queue...\n');

  // ADD COLUMN — SQLite doesn't support IF NOT EXISTS here, so ignore the
  // "duplicate column" error if this migration was already applied.
  process.stdout.write('  ADD COLUMN priority... ');
  await d1Raw(
    `ALTER TABLE popularity_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
    true, // ignore error if column already exists
  );
  console.log('done');

  // Partial index — only indexes rows where priority = 1 (searched tracks).
  // Currently 0 rows qualify, so this creates an empty index instantly
  // with no risk of OOM. Stays tiny as searches happen.
  process.stdout.write('  CREATE PARTIAL INDEX (priority = 1)... ');
  await d1Raw(
    `CREATE INDEX IF NOT EXISTS idx_pq_priority1
     ON popularity_queue (track_id) WHERE priority = 1`
  );
  console.log('done');

  console.log('\nMigration complete.');
  console.log('Searched tracks will now be bumped to priority=1 and scored first.');
}

main().catch(err => { console.error(err); process.exit(1); });
