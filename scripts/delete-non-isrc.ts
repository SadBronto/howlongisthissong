/**
 * Deletes all tracks with no ISRC from D1 in small batches to avoid CPU timeout.
 * Run from project root: npx ts-node --esm scripts/delete-non-isrc.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const BATCH       = 5_000;

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

async function d1Raw(sql: string): Promise<{ rows_written: number }> {
  const res = await fetch(`${D1_URL}/raw`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ sql, params: [] }),
  });

  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2000));
    return d1Raw(sql);
  }

  const data = await res.json() as {
    success: boolean;
    errors?: unknown[];
    result?: Array<{ meta?: { rows_written?: number } }>;
  };
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  return { rows_written: data.result?.[0]?.meta?.rows_written ?? 0 };
}

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local');
    process.exit(1);
  }

  console.log('Deleting non-ISRC tracks in batches of', BATCH, '…');
  let total = 0;

  while (true) {
    const result = await d1Raw(
      `DELETE FROM tracks WHERE id IN (SELECT id FROM tracks WHERE isrc IS NULL LIMIT ${BATCH})`
    );
    const deleted = result.rows_written ?? 0;
    total += deleted;
    process.stdout.write(`\r  ${total.toLocaleString()} deleted so far…`);
    if (deleted === 0) break;
    // Small pause to be polite to the API
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone. ${total.toLocaleString()} non-ISRC tracks removed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
