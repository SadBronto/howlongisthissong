/**
 * Genre-only enrichment — efficient re-run after initial enrich-d1
 *
 * Updates ONLY the genre column using a three-level cascade:
 *   1. recording_tag  (most specific — tags directly on the recording)
 *   2. release_group_tag  (album-level fallback)
 *   3. artist_tag  (artist-level fallback — widest net)
 *
 * All tags are filtered to MusicBrainz's curated genre list, so junk like
 * "Favourite" and "Seen Live" is excluded automatically.
 * Up to 5 genres are stored comma-separated, ordered by community vote count.
 *
 * Only rows that end up with genre data are written to D1 — rows with no
 * genre at any level are silently skipped. The FTS index is NOT rebuilt
 * (genre is not indexed; title/artist/album are not changed).
 *
 * Resumable: if enrich_genre_temp.tsv exists from a crashed run, the
 * data-load phase is skipped and D1 updates resume from that file.
 * Delete enrich_genre_temp.tsv to start fresh.
 *
 * Usage: npm run enrich-genres
 */

import * as fs       from 'fs';
import * as path     from 'path';
import * as readline from 'readline';
import * as dotenv   from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;
const MBDUMP_PATH = process.env.MBDUMP_PATH ?? './mbdump';

const ROWS_PER_BATCH = 200;
const MAX_GENRES     = 5;
const TMP_FILE       = path.join(process.cwd(), 'enrich_genre_temp.tsv');
const D1_URL         = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

// ── D1 ────────────────────────────────────────────────────────────────────────

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

// ── File helpers ──────────────────────────────────────────────────────────────

async function streamLines(filePath: string) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  return readline.createInterface({ input, crlfDelay: Infinity });
}
function nullStr(v: string): string | null {
  return v === '\\N' || v === '' ? null : v;
}
function nullInt(v: string): number | null {
  if (v === '\\N' || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// ── Genre accumulator ─────────────────────────────────────────────────────────

type TagScore = { name: string; count: number };

function accumGenre(map: Map<number, TagScore[]>, id: number, name: string, count: number) {
  const arr = map.get(id) ?? [];
  arr.push({ name, count });
  map.set(id, arr);
}

function finalizeGenres(acc: Map<number, TagScore[]>): Map<number, string> {
  const result = new Map<number, string>();
  acc.forEach((genres, id) => {
    result.set(
      id,
      genres
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_GENRES)
        .map(g => g.name)
        .join(', '),
    );
  });
  return result;
}

// ── Loaders ───────────────────────────────────────────────────────────────────

async function loadGenreNames(): Promise<Set<string>> {
  const fp = path.join(MBDUMP_PATH, 'genre');
  if (!fs.existsSync(fp)) { console.warn('  genre file not found — no filtering'); return new Set(); }
  console.log('Loading genre whitelist…');
  const names = new Set<string>();
  const rl = await streamLines(fp);
  for await (const line of rl) {
    const name = nullStr(line.split('\t')[2]);
    if (name) names.add(name.toLowerCase());
  }
  console.log(`  ${names.size} valid genres`);
  return names;
}

async function loadIsrcIds(): Promise<Set<number>> {
  const fp = path.join(MBDUMP_PATH, 'isrc');
  if (!fs.existsSync(fp)) return new Set();
  console.log('Loading ISRC recording IDs…');
  const ids = new Set<number>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const id = nullInt(line.split('\t')[1]);
    if (id != null) ids.add(id);
  }
  console.log(`  ${ids.size.toLocaleString()} recordings with ISRCs`);
  return ids;
}

async function loadTagNames(): Promise<Map<number, string>> {
  const fp = path.join(MBDUMP_PATH, 'tag');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading tag names…');
  const map = new Map<number, string>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols = line.split('\t');
    const id   = nullInt(cols[0]);
    const name = nullStr(cols[1]);
    if (id != null && name) map.set(id, name);
  }
  console.log(`  ${map.size.toLocaleString()} tags`);
  return map;
}

async function loadRecordingGenres(
  isrcIds: Set<number>, tagNames: Map<number, string>, genreNames: Set<string>,
): Promise<Map<number, string>> {
  const fp = path.join(MBDUMP_PATH, 'recording_tag');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading recording genres…');
  const acc = new Map<number, TagScore[]>();
  const rl  = await streamLines(fp);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0) process.stdout.write(`\r  ${(lines/1e6).toFixed(0)}M lines…`);
    const cols  = line.split('\t');
    const recId = nullInt(cols[0]);
    const tagId = nullInt(cols[1]);
    const count = nullInt(cols[2]);
    if (recId == null || tagId == null || count == null || count < 1) continue;
    if (!isrcIds.has(recId)) continue;
    const name = tagNames.get(tagId);
    if (!name || (genreNames.size > 0 && !genreNames.has(name.toLowerCase()))) continue;
    accumGenre(acc, recId, name, count);
  }
  process.stdout.write('\n');
  console.log(`  ${acc.size.toLocaleString()} recordings with genre tags`);
  return finalizeGenres(acc);
}

async function loadReleaseGroupGenres(
  tagNames: Map<number, string>, genreNames: Set<string>,
): Promise<Map<number, string>> {
  const fp = path.join(MBDUMP_PATH, 'release_group_tag');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading release group genres…');
  const acc = new Map<number, TagScore[]>();
  const rl  = await streamLines(fp);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols  = line.split('\t');
    const rgId  = nullInt(cols[0]);
    const tagId = nullInt(cols[1]);
    const count = nullInt(cols[2]);
    if (rgId == null || tagId == null || count == null || count < 1) continue;
    const name = tagNames.get(tagId);
    if (!name || (genreNames.size > 0 && !genreNames.has(name.toLowerCase()))) continue;
    accumGenre(acc, rgId, name, count);
  }
  process.stdout.write('\n');
  console.log(`  ${acc.size.toLocaleString()} release groups with genre tags`);
  return finalizeGenres(acc);
}

async function loadArtistGenres(
  tagNames: Map<number, string>, genreNames: Set<string>,
): Promise<Map<number, string>> {
  const fp = path.join(MBDUMP_PATH, 'artist_tag');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading artist genres…');
  const acc = new Map<number, TagScore[]>();
  const rl  = await streamLines(fp);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols     = line.split('\t');
    const artistId = nullInt(cols[0]);
    const tagId    = nullInt(cols[1]);
    const count    = nullInt(cols[2]);
    if (artistId == null || tagId == null || count == null || count < 1) continue;
    const name = tagNames.get(tagId);
    if (!name || (genreNames.size > 0 && !genreNames.has(name.toLowerCase()))) continue;
    accumGenre(acc, artistId, name, count);
  }
  process.stdout.write('\n');
  console.log(`  ${acc.size.toLocaleString()} artists with genre tags`);
  return finalizeGenres(acc);
}

// artist_credit_name cols: artist_credit(0) | position(1) | artist(2) | ...
async function loadArtistCredits(): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'artist_credit_name');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading artist credits…');
  const map = new Map<number, number>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const creditId = nullInt(cols[0]);
    const artistId = nullInt(cols[2]);
    if (creditId != null && artistId != null && !map.has(creditId)) map.set(creditId, artistId);
  }
  console.log(`  ${map.size.toLocaleString()} credits loaded`);
  return map;
}

// medium cols: id(0) | release(1) | ...
async function loadMediumRelease(): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'medium');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading medium → release…');
  const map = new Map<number, number>();
  const rl  = await streamLines(fp);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const mediumId = nullInt(cols[0]);
    const relId    = nullInt(cols[1]);
    if (mediumId != null && relId != null) map.set(mediumId, relId);
  }
  console.log(`  ${map.size.toLocaleString()} mediums`);
  return map;
}

// track cols: id(0) | gid(1) | recording(2) | medium(3) | position(4) | ...
async function loadRecordingRelease(
  isrcIds: Set<number>, mediumRelease: Map<number, number>,
): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'track');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Streaming track file…');
  const map  = new Map<number, number>(); // recId → releaseId (lowest = earliest)
  const rl   = await streamLines(fp);
  let lines  = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines/1e6).toFixed(0)}M lines, ${map.size.toLocaleString()} matched…`);
    const cols     = line.split('\t');
    const recId    = nullInt(cols[2]);
    const mediumId = nullInt(cols[3]);
    if (recId == null || mediumId == null || !isrcIds.has(recId)) continue;
    const relId    = mediumRelease.get(mediumId);
    if (relId == null) continue;
    const existing = map.get(recId);
    if (!existing || relId < existing) map.set(recId, relId);
  }
  process.stdout.write('\n');
  console.log(`  ${map.size.toLocaleString()} recordings mapped to releases`);
  return map;
}

// release cols: id(0) | gid(1) | name(2) | artist_credit(3) | release_group(4) | ...
async function loadReleaseToGroup(releaseIds: Set<number>): Promise<Map<number, number>> {
  const fp = path.join(MBDUMP_PATH, 'release');
  if (!fs.existsSync(fp)) return new Map();
  console.log('Loading release → release_group…');
  const map = new Map<number, number>();
  const rl  = await streamLines(fp);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols  = line.split('\t');
    const relId = nullInt(cols[0]);
    const rgId  = nullInt(cols[4]);
    if (relId != null && rgId != null && releaseIds.has(relId)) map.set(relId, rgId);
  }
  process.stdout.write('\n');
  console.log(`  ${map.size.toLocaleString()} releases mapped`);
  return map;
}

// ── Stream recording file → write genre TSV ───────────────────────────────────
// recording cols: id(0) | gid(1) | name(2) | artist_credit(3) | ...
// TSV output: gid\tgenre  (only rows where genre is non-null)

async function buildGenreTsv(
  recGenres:    Map<number, string>,
  rgGenres:     Map<number, string>,
  artistGenres: Map<number, string>,
  artistCredits: Map<number, number>,
  recRelease:   Map<number, number>,
  releaseToRG:  Map<number, number>,
  outPath:      string,
): Promise<number> {
  const fp = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(fp)) { console.error('recording file not found'); return 0; }
  console.log('Streaming recordings → genre TSV…');
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  const rl  = await streamLines(fp);
  let count = 0;
  let skip  = 0;
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines/1e6).toFixed(0)}M lines · ${count.toLocaleString()} with genre · ${skip.toLocaleString()} skipped…`);
    const cols       = line.split('\t');
    const recId      = nullInt(cols[0]);
    const gid        = nullStr(cols[1]);
    const artistCrId = nullInt(cols[3]);
    if (recId == null || !gid) continue;
    if (!recRelease.has(recId)) continue; // not in our DB

    const relId    = recRelease.get(recId);
    const rgId     = relId != null ? releaseToRG.get(relId) : undefined;
    const artistId = artistCrId != null ? artistCredits.get(artistCrId) : undefined;

    const genre =
      recGenres.get(recId) ??
      (rgId     != null ? rgGenres.get(rgId)         : undefined) ??
      (artistId != null ? artistGenres.get(artistId) : undefined) ??
      null;

    if (!genre) { skip++; continue; } // no genre at any level — skip (no write)
    out.write(`${gid}\t${genre}\n`);
    count++;
  }
  await new Promise<void>((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  process.stdout.write('\n');
  console.log(`  ${count.toLocaleString()} rows with genre · ${skip.toLocaleString()} skipped (no data)`);
  return count;
}

// ── Batch UPDATE genre ────────────────────────────────────────────────────────

function buildGenreUpdate(chunk: [string, string][]): string {
  const branches = chunk.map(([gid, genre]) =>
    `WHEN '${gid.replace(/'/g, "''")}' THEN '${genre.replace(/'/g, "''")}'`
  ).join(' ');
  const ids = chunk.map(([gid]) => `'${gid.replace(/'/g, "''")}'`).join(',');
  return `UPDATE tracks SET genre = CASE mb_id ${branches} ELSE genre END WHERE mb_id IN (${ids})`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local');
    process.exit(1);
  }

  console.log('Genre Enrichment (recording → release_group → artist cascade)');
  console.log(`  Dump: ${MBDUMP_PATH}`);
  console.log('');

  // ── Phase 1: build genre TSV ─────────────────────────────────────────────

  if (fs.existsSync(TMP_FILE)) {
    console.log(`Resuming from existing temp file: ${TMP_FILE}`);
    console.log('  (delete enrich_genre_temp.tsv to start fresh)');
    console.log('');
  } else {
    const genreNames   = await loadGenreNames();
    const isrcIds      = await loadIsrcIds();
    const tagNames     = await loadTagNames();
    console.log('');

    const recGenres    = await loadRecordingGenres(isrcIds, tagNames, genreNames);
    const rgGenres     = await loadReleaseGroupGenres(tagNames, genreNames);
    const artistGenres = await loadArtistGenres(tagNames, genreNames);
    tagNames.clear();
    console.log('');

    const artistCredits = await loadArtistCredits();
    const medRelease    = await loadMediumRelease();
    const recRelease    = await loadRecordingRelease(isrcIds, medRelease);
    medRelease.clear();
    isrcIds.clear();

    const releaseIds = new Set<number>(recRelease.values());
    console.log(`  ${releaseIds.size.toLocaleString()} unique releases`);
    const releaseToRG = await loadReleaseToGroup(releaseIds);
    console.log('');

    await buildGenreTsv(
      recGenres, rgGenres, artistGenres, artistCredits, recRelease, releaseToRG,
      TMP_FILE,
    );

    recGenres.clear(); rgGenres.clear(); artistGenres.clear();
    artistCredits.clear(); recRelease.clear(); releaseToRG.clear();
    console.log('  Maps freed');
    console.log('');
  }

  // ── Phase 2: batch UPDATE genre in D1 ────────────────────────────────────
  console.log(`Updating D1 genre column in batches of ${ROWS_PER_BATCH}…`);
  console.log('  (Only rows with genre data are written — no wasted calls)\n');

  const rl      = await streamLines(TMP_FILE);
  let chunk: [string, string][] = [];
  let updated   = 0;
  let errors    = 0;

  async function flush() {
    if (chunk.length === 0) return;
    try {
      await d1Raw(buildGenreUpdate(chunk));
      updated += chunk.length;
    } catch (err) {
      errors++;
      if (errors <= 5) console.error('\nBatch error:', (err as Error).message.slice(0, 200));
    }
    chunk = [];
    if (updated % 10_000 < ROWS_PER_BATCH)
      process.stdout.write(`\r  ${updated.toLocaleString()} updated · ${errors} errors`);
  }

  for await (const line of rl) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const gid   = line.slice(0, tab).trim();
    const genre = line.slice(tab + 1).trimEnd();
    if (!gid || !genre) continue;
    chunk.push([gid, genre]);
    if (chunk.length >= ROWS_PER_BATCH) await flush();
  }
  await flush();

  process.stdout.write('\n');
  console.log(`\n  Done — ${updated.toLocaleString()} rows updated · ${errors} errors`);

  try {
    fs.unlinkSync(TMP_FILE);
    console.log('  Temp file deleted');
  } catch {
    console.log(`  Note: could not delete ${TMP_FILE} — remove manually`);
  }

  console.log('\nAll done! FTS index unchanged (genre is not indexed).');
}

main().catch(err => { console.error(err); process.exit(1); });
