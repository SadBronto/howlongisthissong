/**
 * Standalone FTS rebuild for tracks_fts.
 *
 * Drops and recreates the FTS virtual table, then repopulates it from the
 * tracks table in batches of 10,000 rows so D1 never times out.
 *
 * Usage: npm run rebuild-fts
 */

import * as path   from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

async function d1Raw(sql: string): Promise<void> {
  const res = await fetch(`${D1_URL}/raw`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sql, params: [] }),
  });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2000));
    return d1Raw(sql);
  }
  const data = await res.json() as { success: boolean; errors?: unknown[] };
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
}

async function main() {
  console.log('FTS Rebuild\n');

  console.log('Dropping trigger and FTS table…');
  await d1Raw('DROP TRIGGER IF EXISTS tracks_au');
  await d1Raw('DROP TABLE IF EXISTS tracks_fts');
  console.log('  ✓ dropped');

  console.log('Recreating FTS table…');
  await d1Raw(`CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album,
    tokenize = 'porter ascii'
  )`);
  console.log('  ✓ created');

  const FTS_BATCH   = 10_000;
  const MAX_ID      = 7_743_491;
  const totalBatches = Math.ceil(MAX_ID / FTS_BATCH);
  const BAR_WIDTH   = 32;
  const startTime   = Date.now();
  let batchNum      = 0;

  console.log(`Populating in batches of ${FTS_BATCH.toLocaleString()} rows…`);

  for (let lo = 1; lo <= MAX_ID; lo += FTS_BATCH) {
    const hi = lo + FTS_BATCH - 1;
    await d1Raw(
      `INSERT INTO tracks_fts(rowid, title, artist, album)
       SELECT id, title, artist, album FROM tracks WHERE id BETWEEN ${lo} AND ${hi}`
    );
    batchNum++;

    const pct     = batchNum / totalBatches;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate    = batchNum / elapsed;                        // batches/sec
    const etaSec  = (totalBatches - batchNum) / rate;
    const eta     = etaSec < 60
      ? `${Math.round(etaSec)}s`
      : `${Math.floor(etaSec / 60)}m ${Math.round(etaSec % 60)}s`;

    const filled  = Math.round(pct * BAR_WIDTH);
    const bar     = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const rows    = Math.min(batchNum * FTS_BATCH, MAX_ID).toLocaleString();

    process.stdout.write(
      `\r  [${bar}] ${Math.round(pct * 100)}%  ${rows} rows  ETA: ${eta}   `
    );
  }

  process.stdout.write('\n');
  console.log('  ✓ FTS populated');

  console.log('Recreating FTS trigger…');
  await d1Raw(`CREATE TRIGGER IF NOT EXISTS tracks_au
    AFTER UPDATE OF title, artist, album ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
      VALUES ('delete', old.id, old.title, old.artist, old.album);
      INSERT INTO tracks_fts(rowid, title, artist, album)
      VALUES (new.id, new.title, new.artist, new.album);
    END`);
  console.log('  ✓ trigger restored\n');

  console.log('All done!');
}

main().catch(err => { console.error(err); process.exit(1); });
