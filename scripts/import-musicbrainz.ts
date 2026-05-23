/**
 * MusicBrainz Full Database Import
 *
 * Imports the MusicBrainz PostgreSQL dump into Supabase.
 * The full dump has ~30M+ recordings — expect a long runtime.
 *
 * ── Prerequisites ─────────────────────────────────────────────────────────────
 * 1. Download the latest dump from:
 *    https://data.metabrainz.org/pub/musicbrainz/data/fullexport/
 *    (Latest/ directory → mbdump.tar.bz2 or mbdump-derived.tar.bz2)
 *
 * 2. Extract the archive. You only need these files:
 *    mbdump/recording          — recording ID, title, artist_credit, duration
 *    mbdump/artist_credit      — artist credit names
 *    mbdump/release            — album/release titles (optional, for album data)
 *    mbdump/track              — links recordings to releases (optional)
 *
 *    Minimal import (title + artist + duration):
 *      bzip2 -dk mbdump.tar.bz2 && tar -xf mbdump.tar recording artist_credit
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *    MBDUMP_PATH=/path/to/mbdump npm run import-mb
 *
 *    Optional env vars:
 *      BATCH_SIZE=500          (default: 500 rows per Supabase insert)
 *      MAX_RECORDS=1000000     (default: unlimited — import all)
 *
 * ── Column layout of MusicBrainz TSV files ────────────────────────────────────
 *    recording:      id | gid | name | artist_credit | length | comment | ...
 *    artist_credit:  id | name | artist_count | ref_count | created | ...
 *    release:        id | gid | name | artist_credit | release_group | ...
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

const MBDUMP_PATH = process.env.MBDUMP_PATH ?? './mbdump';
const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  ?? '500',       10);
const MAX_RECORDS = parseInt(process.env.MAX_RECORDS ?? '999999999', 10);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileExists(p: string) {
  return fs.existsSync(p);
}

async function streamLines(filePath: string): Promise<readline.Interface> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function nullableString(s: string): string | null {
  return s === '\\N' || s === '' ? null : s;
}

function nullableInt(s: string): number | null {
  if (s === '\\N' || s === '') return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// ── Step 1: Load artist credit names ─────────────────────────────────────────

async function loadArtistCredits(): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'artist_credit');
  const credits  = new Map<number, string>();

  if (!fileExists(filePath)) {
    console.warn(`⚠  artist_credit not found at ${filePath} — artist names will be null`);
    return credits;
  }

  console.log('Loading artist credits…');
  const rl = await streamLines(filePath);

  for await (const line of rl) {
    const cols = line.split('\t');
    // cols[0] = id, cols[1] = name
    if (cols.length < 2) continue;
    const id   = parseInt(cols[0], 10);
    const name = nullableString(cols[1]);
    if (!isNaN(id) && name) credits.set(id, name);
  }

  console.log(`Loaded ${credits.size.toLocaleString()} artist credits`);
  return credits;
}

// ── Step 2: Import recordings ─────────────────────────────────────────────────

async function importRecordings(artistCredits: Map<number, string>) {
  const filePath = path.join(MBDUMP_PATH, 'recording');

  if (!fileExists(filePath)) {
    console.error(`✗ recording file not found at ${filePath}`);
    process.exit(1);
  }

  console.log('Importing recordings…');
  const rl = await streamLines(filePath);

  type Row = {
    title:        string;
    artist:       string | null;
    duration_ms:  number;
    version:      string | null;
    mb_id:        string;
    source:       string;
  };

  let batch:   Row[] = [];
  let total    = 0;
  let skipped  = 0;
  let errors   = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const { error } = await supabase.from('tracks').insert(batch);
    if (error) {
      console.error(`  Insert error: ${error.message}`);
      errors++;
    } else {
      total += batch.length;
    }
    batch = [];
  };

  for await (const line of rl) {
    if (total + batch.length >= MAX_RECORDS) break;

    // recording columns:
    // 0:id  1:gid  2:name  3:artist_credit  4:length  5:comment  6:edits_pending  7:last_updated  8:video
    const cols = line.split('\t');
    if (cols.length < 5) { skipped++; continue; }

    const mbId           = nullableString(cols[1]);
    const title          = nullableString(cols[2]);
    const artistCreditId = nullableInt(cols[3]);
    const lengthMs       = nullableInt(cols[4]);
    const comment        = nullableString(cols[5]);

    // Skip rows with no title or no duration
    if (!title || !mbId || !lengthMs || lengthMs <= 0) { skipped++; continue; }

    const artist  = artistCreditId != null ? (artistCredits.get(artistCreditId) ?? null) : null;
    const version = comment; // MB comment is often "live", "radio edit", etc.

    batch.push({ title, artist, duration_ms: lengthMs, version, mb_id: mbId, source: 'musicbrainz' });

    if (batch.length >= BATCH_SIZE) {
      await flush();
      if (total % 50_000 === 0) {
        console.log(`  ${total.toLocaleString()} imported, ${skipped.toLocaleString()} skipped, ${errors} errors`);
      }
    }
  }

  await flush();

  console.log('');
  console.log(`Import complete:`);
  console.log(`  ${total.toLocaleString()} recordings imported`);
  console.log(`  ${skipped.toLocaleString()} skipped (no duration or title)`);
  console.log(`  ${errors} batch errors`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('MusicBrainz Import');
  console.log(`  Dump path:  ${MBDUMP_PATH}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  Max rows:   ${MAX_RECORDS === 999_999_999 ? 'unlimited' : MAX_RECORDS.toLocaleString()}`);
  console.log('');

  const artistCredits = await loadArtistCredits();
  await importRecordings(artistCredits);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
