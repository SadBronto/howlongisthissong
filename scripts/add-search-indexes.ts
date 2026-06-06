/**
 * Add filter indexes to the tracks table
 *
 * Filter-only searches (genre/year/BPM with no text keyword) were doing full
 * 5.7M-row table scans (~13–60s, often timing out). These partial indexes let
 * SQLite jump straight to the relevant slice for the two sargable range filters
 * that aren't already indexed:
 *
 *   idx_bpm           — BPM is sparse (~1.6M tracks), so this index is small and
 *                       very selective for BPM-filtered searches.
 *   idx_release_year  — covers the ~5.6M tracks that have a release year.
 *
 * (duration_ms already has idx_duration.) Both are PARTIAL (WHERE ... IS NOT NULL)
 * to keep them small and avoid the OOM that full 5.7M-row index builds hit on D1.
 * SQLite uses a partial "IS NOT NULL" index for range predicates like
 * `bpm BETWEEN 100 AND 200` because a range implies the column is non-null.
 *
 * Note: substring filters (title/artist LIKE '%x%') and LENGTH() filters can't use
 * a BTree index — those are fast only when paired with a text keyword (FTS) or one
 * of the indexed range filters above.
 *
 * Safe to run multiple times (CREATE INDEX IF NOT EXISTS).
 *
 * Usage:
 *   npm run add-search-indexes
 */

import * as path   from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const D1_URL      = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

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

async function main() {
  console.log('Adding search filter indexes...\n');

  process.stdout.write('  CREATE INDEX idx_bpm (partial, bpm IS NOT NULL)... ');
  await d1Raw(`CREATE INDEX IF NOT EXISTS idx_bpm ON tracks(bpm) WHERE bpm IS NOT NULL`);
  console.log('done');

  process.stdout.write('  CREATE INDEX idx_release_year (partial, release_year IS NOT NULL)... ');
  await d1Raw(`CREATE INDEX IF NOT EXISTS idx_release_year ON tracks(release_year) WHERE release_year IS NOT NULL`);
  console.log('done');

  console.log('\nDone. Filter-only searches on BPM / year now use an index instead of scanning all rows.');
}

main().catch(err => { console.error(err); process.exit(1); });
