/**
 * MusicBrainz → D1 Second-Pass Enrichment
 *
 * Fills in album, release_year, release_type, label, track_number, genre
 * for all 5.7M tracks using local MusicBrainz dump files.
 *
 * Genre strategy (cascading fallback):
 *   1. Recording-level tags, filtered to MusicBrainz's curated genre list
 *   2. Release-group tags if the recording has none
 *   3. Artist tags if neither recording nor release group has genres
 *   Up to 5 genres stored comma-separated, ordered by community vote count.
 *
 * Memory strategy: all lookup data is built in Maps (~1.5–2 GB peak), then the
 * recording file is streamed once and enriched rows are written to a temp TSV
 * file on disk. The Maps are freed before the D1 update phase begins.
 *
 * Resumable: if enrich_temp.tsv already exists, the data-load phase is skipped.
 * Delete enrich_temp.tsv before re-running to get updated genre data.
 *
 * Usage: npm run enrich-d1
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
const MAX_GENRES     = 5;    // genres stored per track, sorted by vote count

const TMP_FILE = path.join(process.cwd(), 'enrich_temp.tsv');

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

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

// ── SQL helpers ───────────────────────────────────────────────────────────────

function s(v: string | null): string {
  if (v === null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}
function n(v: number | null): string {
  return v === null ? 'NULL' : String(Math.round(v));
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

// ── Genre accumulator helpers ─────────────────────────────────────────────────

type TagScore = { name: string; count: number };

function accumGenre(map: Map<number, TagScore[]>, id: number, name: string, count: number) {
  const arr = map.get(id) ?? [];
  arr.push({ name, count });
  map.set(id, arr);
}

function finalizeGenres(acc: Map<number, TagScore[]>): Map<number, string> {
  const result = new Map<number, string>();
  acc.forEach((genres, id) => {
    const str = genres
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_GENRES)
      .map(g => g.name)
      .join(', ');
    result.set(id, str);
  });
  return result;
}

// ── Step 0: Valid genre names from MusicBrainz genre table ───────────────────
// Columns: id(0) | gid(1) | name(2) | comment(3) | edits_pending(4) | last_updated(5)

async function loadGenreNames(): Promise<Set<string>> {
  const filePath = path.join(MBDUMP_PATH, 'genre');
  if (!fs.existsSync(filePath)) {
    console.warn('  Warning: genre file not found — no genre filtering applied');
    return new Set();
  }
  console.log('Loading valid genre names…');
  const names = new Set<string>();
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    const name = nullStr(cols[2]);
    if (name) names.add(name.toLowerCase());
  }
  console.log(`  ${names.size} genres in MusicBrainz curated genre list`);
  return names;
}

// ── Step 1: ISRC recording IDs ────────────────────────────────────────────────

async function loadIsrcRecordingIds(): Promise<Set<number>> {
  const filePath = path.join(MBDUMP_PATH, 'isrc');
  const ids = new Set<number>();
  if (!fs.existsSync(filePath)) return ids;
  console.log('Loading ISRC recording IDs…');
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols  = line.split('\t');
    const recId = nullInt(cols[1]);
    if (recId != null) ids.add(recId);
  }
  console.log(`  ${ids.size.toLocaleString()} recordings with ISRCs`);
  return ids;
}

// ── Step 2: Tiny lookup tables ────────────────────────────────────────────────

async function loadMap(
  fileName: string, idCol: number, nameCol: number,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, fileName);
  const map = new Map<number, string>();
  if (!fs.existsSync(filePath)) return map;
  const rl = await streamLines(filePath);
  for await (const line of rl) {
    const cols = line.split('\t');
    const id   = nullInt(cols[idCol]);
    const name = nullStr(cols[nameCol]);
    if (id != null && name) map.set(id, name);
  }
  return map;
}

// ── Step 3: Genre tags per recording ─────────────────────────────────────────
// Columns: recording(0) | tag(1) | count(2) | last_updated(3)

async function loadRecordingGenres(
  isrcIds:    Set<number>,
  tagNames:   Map<number, string>,
  genreNames: Set<string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'recording_tag');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading recording genres…');
  const acc = new Map<number, TagScore[]>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0) process.stdout.write(`\r  ${(lines / 1e6).toFixed(0)}M lines…`);
    const cols  = line.split('\t');
    const recId = nullInt(cols[0]);
    const tagId = nullInt(cols[1]);
    const count = nullInt(cols[2]);
    if (recId == null || tagId == null || count == null || count < 1) continue;
    if (!isrcIds.has(recId)) continue;
    const name = tagNames.get(tagId);
    if (!name) continue;
    if (genreNames.size > 0 && !genreNames.has(name.toLowerCase())) continue;
    accumGenre(acc, recId, name, count);
  }
  process.stdout.write('\n');
  console.log(`  ${acc.size.toLocaleString()} recordings have genre tags`);
  return finalizeGenres(acc);
}

// ── Step 4: Genre tags per release group ──────────────────────────────────────
// Columns: release_group(0) | tag(1) | count(2) | last_updated(3)

async function loadReleaseGroupGenres(
  tagNames:   Map<number, string>,
  genreNames: Set<string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'release_group_tag');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release group genres…');
  const acc = new Map<number, TagScore[]>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols  = line.split('\t');
    const rgId  = nullInt(cols[0]);
    const tagId = nullInt(cols[1]);
    const count = nullInt(cols[2]);
    if (rgId == null || tagId == null || count == null || count < 1) continue;
    const name = tagNames.get(tagId);
    if (!name) continue;
    if (genreNames.size > 0 && !genreNames.has(name.toLowerCase())) continue;
    accumGenre(acc, rgId, name, count);
  }
  process.stdout.write('\n');
  console.log(`  ${acc.size.toLocaleString()} release groups have genre tags`);
  return finalizeGenres(acc);
}

// ── Step 5: Genre tags per artist ─────────────────────────────────────────────
// Columns: artist(0) | tag(1) | count(2) | last_updated(3)

async function loadArtistGenres(
  tagNames:   Map<number, string>,
  genreNames: Set<string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'artist_tag');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading artist genres…');
  const acc = new Map<number, TagScore[]>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols     = line.split('\t');
    const artistId = nullInt(cols[0]);
    const tagId    = nullInt(cols[1]);
    const count    = nullInt(cols[2]);
    if (artistId == null || tagId == null || count == null || count < 1) continue;
    const name = tagNames.get(tagId);
    if (!name) continue;
    if (genreNames.size > 0 && !genreNames.has(name.toLowerCase())) continue;
    accumGenre(acc, artistId, name, count);
  }
  process.stdout.write('\n');
  console.log(`  ${acc.size.toLocaleString()} artists have genre tags`);
  return finalizeGenres(acc);
}

// ── Step 6: Artist credit → primary artist ID ────────────────────────────────
// Columns: artist_credit(0) | position(1) | artist(2) | name(3) | join_phrase(4)

async function loadArtistCredits(): Promise<Map<number, number>> {
  const filePath = path.join(MBDUMP_PATH, 'artist_credit_name');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading artist credits…');
  const map = new Map<number, number>(); // creditId → artistId
  const rl  = await streamLines(filePath);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const creditId = nullInt(cols[0]);
    const artistId = nullInt(cols[2]);
    // Take first artist encountered per credit (file is ordered by position)
    if (creditId != null && artistId != null && !map.has(creditId)) {
      map.set(creditId, artistId);
    }
  }
  console.log(`  ${map.size.toLocaleString()} artist credits loaded`);
  return map;
}

// ── Step 7: Medium → release mapping ─────────────────────────────────────────

async function loadMediumRelease(): Promise<Map<number, number>> {
  const filePath = path.join(MBDUMP_PATH, 'medium');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading medium → release…');
  const map = new Map<number, number>();
  const rl  = await streamLines(filePath);
  for await (const line of rl) {
    const cols     = line.split('\t');
    const mediumId = nullInt(cols[0]);
    const relId    = nullInt(cols[1]);
    if (mediumId != null && relId != null) map.set(mediumId, relId);
  }
  console.log(`  ${map.size.toLocaleString()} mediums loaded`);
  return map;
}

// ── Step 8: Stream track file → pick best release per recording ───────────────

async function loadTrackData(
  isrcIds:       Set<number>,
  mediumRelease: Map<number, number>,
): Promise<Map<number, { releaseId: number; trackPos: number }>> {
  const filePath = path.join(MBDUMP_PATH, 'track');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Streaming track file (largest file — a few minutes)…');
  const result = new Map<number, { releaseId: number; trackPos: number }>();
  const rl     = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines / 1e6).toFixed(0)}M lines, ${result.size.toLocaleString()} matched…`);
    const cols     = line.split('\t');
    const recId    = nullInt(cols[2]);
    const mediumId = nullInt(cols[3]);
    const trackPos = nullInt(cols[4]);
    if (recId == null || mediumId == null || trackPos == null) continue;
    if (!isrcIds.has(recId)) continue;
    const relId = mediumRelease.get(mediumId);
    if (relId == null) continue;
    const existing = result.get(recId);
    if (!existing || relId < existing.releaseId) {
      result.set(recId, { releaseId: relId, trackPos });
    }
  }
  process.stdout.write('\n');
  console.log(`  ${result.size.toLocaleString()} recordings matched to releases`);
  return result;
}

// ── Step 9: Release name + release_group ─────────────────────────────────────

async function loadReleaseData(releaseIds: Set<number>): Promise<Map<number, {
  name:           string;
  releaseGroupId: number | null;
  statusId:       number | null;
}>> {
  const filePath = path.join(MBDUMP_PATH, 'release');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release data…');
  const map = new Map<number, { name: string; releaseGroupId: number | null; statusId: number | null }>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols   = line.split('\t');
    const relId  = nullInt(cols[0]);
    if (relId == null || !releaseIds.has(relId)) continue;
    const name   = nullStr(cols[2]);
    const rgId   = nullInt(cols[4]);
    const statId = nullInt(cols[5]);
    if (name) map.set(relId, { name, releaseGroupId: rgId, statusId: statId });
  }
  process.stdout.write('\n');
  console.log(`  ${map.size.toLocaleString()} releases loaded`);
  return map;
}

// ── Step 10: Release → earliest year ─────────────────────────────────────────

async function loadReleaseYears(releaseIds: Set<number>): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const [file, yearCol] of [['release_country', 2], ['release_unknown_country', 1]] as const) {
    const filePath = path.join(MBDUMP_PATH, file);
    if (!fs.existsSync(filePath)) continue;
    const rl = await streamLines(filePath);
    for await (const line of rl) {
      const cols  = line.split('\t');
      const relId = nullInt(cols[0]);
      const year  = nullInt(cols[yearCol]);
      if (relId == null || year == null || !releaseIds.has(relId)) continue;
      const existing = map.get(relId);
      if (!existing || year < existing) map.set(relId, year);
    }
  }
  console.log(`  ${map.size.toLocaleString()} releases have year data`);
  return map;
}

// ── Step 11: Release → label name ────────────────────────────────────────────

async function loadReleaseLabels(
  releaseIds: Set<number>,
  labelNames: Map<number, string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'release_label');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release labels…');
  const map = new Map<number, string>();
  const rl  = await streamLines(filePath);
  for await (const line of rl) {
    const cols  = line.split('\t');
    const relId = nullInt(cols[1]);
    const labId = nullInt(cols[2]);
    if (relId == null || labId == null) continue;
    if (!releaseIds.has(relId) || map.has(relId)) continue;
    const name = labelNames.get(labId);
    if (name) map.set(relId, name);
  }
  console.log(`  ${map.size.toLocaleString()} releases have label data`);
  return map;
}

// ── Step 12: Release group → type name ───────────────────────────────────────

async function loadReleaseGroupTypes(
  rgIds:       Set<number>,
  rgTypeNames: Map<number, string>,
): Promise<Map<number, string>> {
  const filePath = path.join(MBDUMP_PATH, 'release_group');
  if (!fs.existsSync(filePath)) return new Map();
  console.log('Loading release group types…');
  const map = new Map<number, string>();
  const rl  = await streamLines(filePath);
  let lines = 0;
  for await (const line of rl) {
    if (++lines % 1_000_000 === 0) process.stdout.write(`\r  ${lines.toLocaleString()} lines…`);
    const cols   = line.split('\t');
    const rgId   = nullInt(cols[0]);
    const typeId = nullInt(cols[4]);
    if (rgId == null || !rgIds.has(rgId)) continue;
    const typeName = typeId != null ? (rgTypeNames.get(typeId) ?? 'Other') : 'Other';
    map.set(rgId, typeName);
  }
  process.stdout.write('\n');
  console.log(`  ${map.size.toLocaleString()} release groups typed`);
  return map;
}

// ── Step 13: Stream recording file → write enriched rows to temp TSV ──────────
// recording columns: id(0) | gid(1) | name(2) | artist_credit(3) | length(4) | ...
// TSV columns: gid | album | release_year | release_type | label | track_number | genre

async function streamRecordingToTsv(
  recTrack:      Map<number, { releaseId: number; trackPos: number }>,
  recGenres:     Map<number, string>,
  releaseData:   Map<number, { name: string; releaseGroupId: number | null; statusId: number | null }>,
  releaseYears:  Map<number, number>,
  releaseLabels: Map<number, string>,
  rgTypes:       Map<number, string>,
  rgGenres:      Map<number, string>,
  artistGenres:  Map<number, string>,
  artistCredits: Map<number, number>,
  outPath:       string,
): Promise<number> {
  const filePath = path.join(MBDUMP_PATH, 'recording');
  if (!fs.existsSync(filePath)) {
    console.error('recording file not found!');
    return 0;
  }
  console.log('Streaming recording GUIDs → temp file…');
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  const rl  = await streamLines(filePath);
  let count = 0;
  let lines = 0;

  for await (const line of rl) {
    if (++lines % 5_000_000 === 0)
      process.stdout.write(`\r  ${(lines / 1e6).toFixed(0)}M lines, ${count.toLocaleString()} written…`);

    const cols       = line.split('\t');
    const recId      = nullInt(cols[0]);
    const gid        = nullStr(cols[1]);
    const artistCrId = nullInt(cols[3]);
    if (recId == null || !gid) continue;

    const trackInfo = recTrack.get(recId);
    if (!trackInfo) continue;

    const { releaseId, trackPos } = trackInfo;
    const release     = releaseData.get(releaseId);
    const year        = releaseYears.get(releaseId) ?? null;
    const labelName   = releaseLabels.get(releaseId) ?? null;
    const rgId        = release?.releaseGroupId ?? null;
    const releaseType = rgId != null ? (rgTypes.get(rgId) ?? null) : null;
    const album       = release?.name ?? null;
    const artistId    = artistCrId != null ? artistCredits.get(artistCrId) : undefined;

    // Cascading genre: recording-level → release group → artist
    const genre =
      recGenres.get(recId) ??
      (rgId     != null    ? rgGenres.get(rgId)         : undefined) ??
      (artistId != null    ? artistGenres.get(artistId) : undefined) ??
      null;

    const row = [
      gid,
      album       ?? '\\N',
      year   != null ? String(year) : '\\N',
      releaseType ?? '\\N',
      labelName   ?? '\\N',
      String(trackPos),
      genre       ?? '\\N',
    ].join('\t');
    out.write(row + '\n');
    count++;
  }

  await new Promise<void>((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  process.stdout.write('\n');
  console.log(`  ${count.toLocaleString()} records written to ${path.basename(outPath)}`);
  return count;
}

// ── Build batch UPDATE SQL using CASE expressions ─────────────────────────────

interface EnrichedRow {
  album:       string | null;
  releaseYear: number | null;
  releaseType: string | null;
  label:       string | null;
  trackNumber: number | null;
  genre:       string | null;
}

function buildBatchUpdate(chunk: [string, EnrichedRow][]): string {
  const ids = chunk.map(([gid]) => s(gid)).join(',');

  function caseExpr(
    col:        string,
    getValue:   (d: EnrichedRow) => string,
    onlyNonNull = false,
  ): string {
    const rows     = onlyNonNull ? chunk.filter(([, d]) => getValue(d) !== 'NULL') : chunk;
    const branches = rows.map(([gid, d]) => `WHEN ${s(gid)} THEN ${getValue(d)}`).join(' ');
    return branches
      ? `${col} = CASE mb_id ${branches} ELSE ${col} END`
      : `${col} = ${col}`;
  }

  const sets = [
    caseExpr('album',        d => s(d.album)),
    caseExpr('release_year', d => n(d.releaseYear)),
    caseExpr('release_type', d => s(d.releaseType)),
    caseExpr('label',        d => s(d.label)),
    caseExpr('track_number', d => n(d.trackNumber)),
    // Genre: only overwrite rows that have a value — don't blank out API-enriched data
    caseExpr('genre',        d => s(d.genre), true),
  ].join(',\n  ');

  return `UPDATE tracks SET\n  ${sets}\nWHERE mb_id IN (${ids})`;
}

// ── Parse a line from the temp TSV ───────────────────────────────────────────

function parseTsvRow(line: string): [string, EnrichedRow] | null {
  const cols = line.split('\t');
  if (cols.length < 7) return null;
  const [gid, albumRaw, yearRaw, typeRaw, labelRaw, trackRaw, genreRaw] = cols;
  if (!gid) return null;
  return [gid, {
    album:       albumRaw === '\\N' ? null : albumRaw,
    releaseYear: yearRaw  === '\\N' ? null : parseInt(yearRaw, 10),
    releaseType: typeRaw  === '\\N' ? null : typeRaw,
    label:       labelRaw === '\\N' ? null : labelRaw,
    trackNumber: trackRaw === '\\N' ? null : parseInt(trackRaw, 10),
    genre:       genreRaw === '\\N' ? null : genreRaw.trimEnd(),
  }];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in .env.local');
    process.exit(1);
  }

  console.log('MusicBrainz → D1 Enrichment (Pass 2)');
  console.log(`  Dump path: ${MBDUMP_PATH}`);
  console.log('');

  // ── Schema: add new columns (idempotent) ──────────────────────────────────
  console.log('Ensuring schema columns exist…');
  for (const sql of [
    'ALTER TABLE tracks ADD COLUMN release_type TEXT',
    'ALTER TABLE tracks ADD COLUMN label        TEXT',
    'ALTER TABLE tracks ADD COLUMN track_number INTEGER',
  ]) {
    try   { await d1Raw(sql); console.log(`  ✓ added: ${sql.match(/ADD COLUMN \w+/)![0]}`); }
    catch { console.log(`  (already exists) ${sql.match(/ADD COLUMN \w+/)![0]}`); }
  }
  console.log('');

  // ── Drop FTS trigger (prevents per-row FTS writes during bulk update) ──────
  console.log('Dropping FTS update trigger…');
  await d1Raw('DROP TRIGGER IF EXISTS tracks_au');
  console.log('  ✓ done');
  console.log('');

  // ── Phase 1: build temp TSV ───────────────────────────────────────────────

  if (fs.existsSync(TMP_FILE)) {
    console.log(`Temp file found: ${TMP_FILE}`);
    console.log('  Skipping data-load — jumping straight to D1 updates.');
    console.log('  To rebuild with fresh genre data, delete enrich_temp.tsv first.');
    console.log('');
  } else {
    // ── Load all lookup data ────────────────────────────────────────────────
    const genreNames  = await loadGenreNames();
    const isrcIds     = await loadIsrcRecordingIds();
    const rgTypeMap   = await loadMap('release_group_primary_type', 0, 1);
    const tagNames    = await loadMap('tag', 0, 1);
    const labelNames  = await loadMap('label', 0, 2);
    console.log(`  ${rgTypeMap.size} release types · ${tagNames.size.toLocaleString()} tags · ${labelNames.size.toLocaleString()} labels`);
    console.log('');

    const recGenres    = await loadRecordingGenres(isrcIds, tagNames, genreNames);
    const rgGenres     = await loadReleaseGroupGenres(tagNames, genreNames);
    const artistGenres = await loadArtistGenres(tagNames, genreNames);
    tagNames.clear();
    console.log('');

    const artistCredits = await loadArtistCredits();
    const medRelease    = await loadMediumRelease();
    const recTrack      = await loadTrackData(isrcIds, medRelease);
    medRelease.clear();
    isrcIds.clear();

    const ourReleaseIds = new Set<number>();
    recTrack.forEach(({ releaseId }) => ourReleaseIds.add(releaseId));
    console.log(`  ${ourReleaseIds.size.toLocaleString()} unique releases to look up`);
    console.log('');

    const releaseData   = await loadReleaseData(ourReleaseIds);
    const releaseYears  = await loadReleaseYears(ourReleaseIds);
    const releaseLabels = await loadReleaseLabels(ourReleaseIds, labelNames);
    labelNames.clear();
    ourReleaseIds.clear();

    const rgIds = new Set<number>();
    releaseData.forEach(({ releaseGroupId }) => {
      if (releaseGroupId != null) rgIds.add(releaseGroupId);
    });
    const rgTypes = await loadReleaseGroupTypes(rgIds, rgTypeMap);
    rgTypeMap.clear();
    console.log('');

    await streamRecordingToTsv(
      recTrack, recGenres, releaseData, releaseYears, releaseLabels, rgTypes,
      rgGenres, artistGenres, artistCredits,
      TMP_FILE,
    );

    recTrack.clear(); recGenres.clear(); releaseData.clear();
    releaseYears.clear(); releaseLabels.clear(); rgTypes.clear();
    rgGenres.clear(); artistGenres.clear(); artistCredits.clear();
    console.log('  Lookup maps freed');
    console.log('');
  }

  // ── Phase 2: batch UPDATE D1 from temp TSV ────────────────────────────────
  console.log(`Updating D1 in batches of ${ROWS_PER_BATCH}…`);

  const tsvRl = await streamLines(TMP_FILE);
  let chunk: [string, EnrichedRow][] = [];
  let updated = 0;
  let errors  = 0;

  async function flushChunk(): Promise<void> {
    if (chunk.length === 0) return;
    const sql = buildBatchUpdate(chunk);
    try {
      await d1Raw(sql);
      updated += chunk.length;
    } catch (err) {
      errors++;
      if (errors <= 5) console.error('\nBatch error:', (err as Error).message.slice(0, 200));
    }
    chunk = [];
    if (updated % 10_000 < ROWS_PER_BATCH)
      process.stdout.write(`\r  ${updated.toLocaleString()} updated, ${errors} errors`);
  }

  for await (const line of tsvRl) {
    const parsed = parseTsvRow(line);
    if (!parsed) continue;
    chunk.push(parsed);
    if (chunk.length >= ROWS_PER_BATCH) await flushChunk();
  }
  await flushChunk();

  console.log(`\n  ${updated.toLocaleString()} records updated, ${errors} errors`);
  console.log('');

  try {
    fs.unlinkSync(TMP_FILE);
    console.log('  Temp file deleted');
  } catch {
    console.log(`  Note: could not delete temp file — remove ${TMP_FILE} manually`);
  }
  console.log('');

  // ── Rebuild FTS index in batches ──────────────────────────────────────────
  console.log('Rebuilding FTS index in batches of 10,000…');
  await d1Raw('DROP TRIGGER IF EXISTS tracks_au');
  await d1Raw('DROP TABLE IF EXISTS tracks_fts');
  await d1Raw(`CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album,
    tokenize = 'porter ascii'
  )`);

  const FTS_BATCH    = 10_000;
  const MAX_ID       = 7_743_491;
  const totalBatches = Math.ceil(MAX_ID / FTS_BATCH);
  const BAR_WIDTH    = 32;
  const ftsStart     = Date.now();
  let   batchNum     = 0;

  for (let lo = 1; lo <= MAX_ID; lo += FTS_BATCH) {
    const hi = lo + FTS_BATCH - 1;
    await d1Raw(
      `INSERT INTO tracks_fts(rowid, title, artist, album)
       SELECT id, title, artist, album FROM tracks WHERE id BETWEEN ${lo} AND ${hi}`
    );
    batchNum++;
    const pct     = batchNum / totalBatches;
    const elapsed = (Date.now() - ftsStart) / 1000;
    const rate    = batchNum / elapsed;
    const etaSec  = (totalBatches - batchNum) / rate;
    const eta     = etaSec < 60
      ? `${Math.round(etaSec)}s`
      : `${Math.floor(etaSec / 60)}m ${Math.round(etaSec % 60)}s`;
    const filled  = Math.round(pct * BAR_WIDTH);
    const bar     = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const rows    = Math.min(batchNum * FTS_BATCH, MAX_ID).toLocaleString();
    process.stdout.write(`\r  [${bar}] ${Math.round(pct * 100)}%  ${rows} rows  ETA: ${eta}   `);
  }
  process.stdout.write('\n');
  console.log('  ✓ FTS rebuilt');

  console.log('Recreating FTS update trigger…');
  await d1Raw(`CREATE TRIGGER IF NOT EXISTS tracks_au
    AFTER UPDATE OF title, artist, album ON tracks BEGIN
      INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
      VALUES ('delete', old.id, old.title, old.artist, old.album);
      INSERT INTO tracks_fts(rowid, title, artist, album)
      VALUES (new.id, new.title, new.artist, new.album);
    END`);
  console.log('  ✓ trigger restored');
  console.log('');
  console.log('All done!');
}

main().catch(err => { console.error(err); process.exit(1); });
