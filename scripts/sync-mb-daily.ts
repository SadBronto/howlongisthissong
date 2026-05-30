/**
 * MusicBrainz Daily Sync
 *
 * Downloads incremental replication packets from MusicBrainz and inserts
 * new recordings (with ISRCs) into D1. Designed to run via GitHub Actions
 * on a daily cron schedule.
 *
 * How it works:
 *   MusicBrainz publishes a numbered replication packet every day containing
 *   all DB changes (inserts, updates, deletes). This script tracks the last
 *   processed sequence number in D1 (sync_state table), downloads any new
 *   packets, pulls full recording details from the MB API, and inserts new
 *   tracks into D1 + FTS.
 *
 * First run:
 *   Records the current MB sequence as baseline — no data is processed.
 *   The next daily run will pick up that day's packet.
 *
 * Usage:
 *   npm run sync-mb-daily
 *
 * Required env (set as GitHub Actions secrets):
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_D1_DATABASE_ID
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { execSync } from 'child_process';
import * as dotenv  from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const ACCOUNT_ID  = process.env.CLOUDFLARE_ACCOUNT_ID!;
const API_TOKEN   = process.env.CLOUDFLARE_API_TOKEN!;
const DATABASE_ID = process.env.CLOUDFLARE_D1_DATABASE_ID!;

const MB_REPL_BASE = 'https://data.metabrainz.org/pub/musicbrainz/data/replication';
const MB_API_BASE  = 'https://musicbrainz.org/ws/2';
const MB_UA        = 'HowLongIsThisSong/1.0 (howlongisthissong.com)';
const MB_DELAY     = 1050; // ms — MB enforces 1 req/sec

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}`;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── D1 helpers ────────────────────────────────────────────────────────────────

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
    if (!data.success) throw new Error(`D1 raw: ${JSON.stringify(data.errors)}`);
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

function esc(v: string | null | undefined): string {
  if (v == null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

// ── Sync state ────────────────────────────────────────────────────────────────

async function ensureSyncStateTable(): Promise<void> {
  await d1Raw(
    `CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  );
}

async function getStoredSequence(): Promise<number | null> {
  const rows = await d1Query<{ value: string }>(
    `SELECT value FROM sync_state WHERE key = 'mb_replication_sequence'`
  );
  return rows.length ? parseInt(rows[0].value, 10) : null;
}

async function setStoredSequence(seq: number): Promise<void> {
  await d1Raw(
    `INSERT OR REPLACE INTO sync_state (key, value) VALUES ('mb_replication_sequence', '${seq}')`
  );
}

// ── Replication packet download + parse ───────────────────────────────────────

async function getMbCurrentSequence(): Promise<number> {
  // Parse the directory listing to find the highest replication packet number.
  // MB doesn't publish a LATEST_REPLICATION_SEQUENCE file at a stable URL.
  const res = await fetch(`${MB_REPL_BASE}/`, { headers: { 'User-Agent': MB_UA } });
  if (!res.ok) throw new Error(`MB replication directory fetch failed: ${res.status}`);
  const html = await res.text();
  const matches = [...html.matchAll(/replication-(\d+)\.tar\.bz2/g)];
  if (!matches.length) throw new Error('No replication packets found in MB directory listing');
  return Math.max(...matches.map(m => parseInt(m[1], 10)));
}

async function downloadPacket(seq: number, dir: string): Promise<string> {
  const url  = `${MB_REPL_BASE}/replication-${seq}.tar.bz2`;
  const dest = path.join(dir, `replication-${seq}.tar.bz2`);
  console.log(`  Downloading ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': MB_UA } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`  Downloaded ${kb} KB`);
  return dest;
}

function extractPacket(tarPath: string, dir: string): string {
  const extractDir = path.join(dir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xjf "${tarPath}" -C "${extractDir}"`, { stdio: 'pipe' });
  return extractDir;
}

/**
 * Parse dbmirror_pending — return the set of XIDs for INSERT operations
 * on the musicbrainz.recording table.
 *
 * File format (tab-separated, no header):
 *   <seq>  <schema.table>  <op: i/u/d>  <XID>
 */
function getNewRecordingXids(pendingPath: string): Set<string> {
  const xids = new Set<string>();
  if (!fs.existsSync(pendingPath)) return xids;
  for (const line of fs.readFileSync(pendingPath, 'utf8').split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const [, table, op, xid] = parts;
    if (table.trim() === 'musicbrainz.recording' && op.trim() === 'i') {
      xids.add(xid.trim());
    }
  }
  return xids;
}

/**
 * Parse dbmirror_pendingdata — extract recording GIDs for the given XIDs.
 *
 * File format (tab-separated, no header):
 *   <XID>  <iskey: t/f>  "col" = 'val'  "col" = 'val'  ...
 *
 * iskey=t rows contain only the key columns (for updates/deletes).
 * iskey=f rows contain the full new row (what we want for inserts).
 */
function extractRecordingGids(pendingDataPath: string, xids: Set<string>): string[] {
  const gids: string[] = [];
  if (!fs.existsSync(pendingDataPath) || xids.size === 0) return gids;

  for (const line of fs.readFileSync(pendingDataPath, 'utf8').split('\n')) {
    const tab1 = line.indexOf('\t');
    if (tab1 === -1) continue;
    const xid = line.slice(0, tab1).trim();
    if (!xids.has(xid)) continue;

    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab2 === -1) continue;
    const iskey = line.slice(tab1 + 1, tab2).trim();
    if (iskey !== 'f') continue; // skip key-only rows; we want the full data row

    const data = line.slice(tab2 + 1);
    // Extract "gid" = '<uuid>' from the data payload
    const m = data.match(/"gid"\s*=\s*'([0-9a-f-]{36})'/);
    if (m) gids.push(m[1]);
  }
  return gids;
}

// ── MusicBrainz API ───────────────────────────────────────────────────────────

interface MbArtistCredit {
  name?:        string;
  joinphrase?:  string;
  artist: { name: string };
}
interface MbRelease {
  title:  string;
  date?:  string;
  'release-group'?: { 'primary-type'?: string };
  'label-info'?:    Array<{ label?: { name: string } }>;
  media?:           Array<{ tracks?: Array<{ position?: number }> }>;
}
interface MbRecording {
  id:               string;
  title:            string;
  length?:          number | null;
  disambiguation?:  string;
  isrcs?:           string[];
  'artist-credit'?: MbArtistCredit[];
  releases?:        MbRelease[];
}

async function fetchRecording(gid: string): Promise<MbRecording | null> {
  try {
    const res = await fetch(
      `${MB_API_BASE}/recording/${gid}?inc=isrcs+artist-credits+releases&fmt=json`,
      { headers: { 'User-Agent': MB_UA }, signal: AbortSignal.timeout(12_000) },
    );
    if (!res.ok) return null;
    return await res.json() as MbRecording;
  } catch { return null; }
}

// ── Track insertion ───────────────────────────────────────────────────────────

/** Returns true if a track with this mb_id already exists in D1. */
async function trackExists(mbId: string): Promise<boolean> {
  const rows = await d1Query<{ id: number }>(
    `SELECT id FROM tracks WHERE mb_id = ${esc(mbId)} LIMIT 1`
  );
  return rows.length > 0;
}

async function insertTrack(rec: MbRecording, isrc: string): Promise<number | null> {
  // Pick the earliest-dated release for metadata
  const releases = (rec.releases ?? []).filter(r => r.date).sort((a, b) =>
    (a.date ?? '').localeCompare(b.date ?? '')
  );
  const rel = releases[0] ?? rec.releases?.[0];

  const title       = rec.title;
  const artist      = rec['artist-credit']
    ?.map(ac => (ac.name ?? ac.artist.name) + (ac.joinphrase ?? '')).join('') || null;
  const album       = rel?.title ?? null;
  const durationMs  = rec.length ?? null;
  const disambig    = rec.disambiguation || null;
  const releaseYear = rel?.date ? (parseInt(rel.date.slice(0, 4), 10) || null) : null;
  const releaseType = rel?.['release-group']?.['primary-type'] ?? null;
  const label       = rel?.['label-info']?.[0]?.label?.name ?? null;
  const trackNum    = rel?.media?.[0]?.tracks?.[0]?.position ?? null;

  await d1Raw(`
    INSERT OR IGNORE INTO tracks
      (title, artist, album, duration_ms, disambiguation, isrc, release_year,
       mb_id, release_type, label, track_number, search_count)
    VALUES
      (${esc(title)}, ${esc(artist)}, ${esc(album)}, ${durationMs ?? 'NULL'}, ${esc(disambig)},
       ${esc(isrc)}, ${releaseYear ?? 'NULL'}, ${esc(rec.id)}, ${esc(releaseType)},
       ${esc(label)}, ${trackNum ?? 'NULL'}, 0)
  `);

  // Fetch the new row's id so we can insert into FTS
  const rows = await d1Query<{ id: number }>(
    `SELECT id FROM tracks WHERE isrc = ${esc(isrc)} LIMIT 1`
  );
  if (!rows.length) return null; // INSERT was ignored (row already existed via isrc)

  const id = rows[0].id;
  await d1Raw(`
    INSERT OR IGNORE INTO tracks_fts(rowid, title, artist, album)
    VALUES (${id}, ${esc(title)}, ${esc(artist)}, ${esc(album)})
  `);

  // Add to popularity queue so the cron picks it up without a full table scan
  await d1Raw(`INSERT OR IGNORE INTO popularity_queue (track_id) VALUES (${id})`);

  return id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!ACCOUNT_ID || !API_TOKEN || !DATABASE_ID) {
    console.error('Missing Cloudflare credentials in environment.'); process.exit(1);
  }

  await ensureSyncStateTable();

  const currentSeq = await getMbCurrentSequence();
  console.log(`MB current sequence : ${currentSeq}`);

  const storedSeq = await getStoredSequence();

  // ── First run: record baseline, process nothing ───────────────────────────
  if (storedSeq === null) {
    await setStoredSequence(currentSeq);
    console.log(`First run — baseline set to ${currentSeq}. Next run will process tomorrow's packet.`);
    return;
  }

  if (storedSeq >= currentSeq) {
    console.log(`Already up to date at sequence ${storedSeq}.`);
    return;
  }

  const toProcess = currentSeq - storedSeq;
  console.log(`Last processed      : ${storedSeq}`);
  console.log(`Packets to process  : ${toProcess}\n`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sync-'));
  const stats  = { inserted: 0, alreadyHad: 0, noIsrc: 0, errors: 0 };

  try {
    for (let seq = storedSeq + 1; seq <= currentSeq; seq++) {
      console.log(`\n── Packet ${seq} (${seq - storedSeq}/${toProcess}) ──────────────────────`);

      let tarPath:    string | undefined;
      let extractDir: string | undefined;

      try {
        tarPath    = await downloadPacket(seq, tmpDir);
        extractDir = extractPacket(tarPath, tmpDir);

        const pendingPath     = path.join(extractDir, 'dbmirror_pending');
        const pendingDataPath = path.join(extractDir, 'dbmirror_pendingdata');

        const xids = getNewRecordingXids(pendingPath);
        console.log(`  New recording inserts : ${xids.size}`);
        if (xids.size === 0) { await setStoredSequence(seq); continue; }

        const gids = extractRecordingGids(pendingDataPath, xids);
        console.log(`  Recording GIDs found  : ${gids.length}`);
        if (gids.length === 0) { await setStoredSequence(seq); continue; }

        // ── Fetch and insert ────────────────────────────────────────────────
        for (let i = 0; i < gids.length; i++) {
          const gid       = gids[i];
          const callStart = Date.now();

          try {
            // Skip if we already have this recording (e.g. from a previous import)
            if (await trackExists(gid)) {
              stats.alreadyHad++;
            } else {
              const rec = await fetchRecording(gid);
              if (!rec?.isrcs?.length) {
                stats.noIsrc++;
              } else {
                // Mirror import-d1 pattern: first ISRC wins, one row per recording
                const id = await insertTrack(rec, rec.isrcs[0]);
                if (id != null) stats.inserted++;
                else            stats.alreadyHad++;
              }
            }
          } catch (err) {
            stats.errors++;
            if (stats.errors <= 3) console.error(`\n  Error on ${gid}:`, (err as Error).message);
          }

          // Respect MB 1 req/sec rate limit
          const wait = MB_DELAY - (Date.now() - callStart);
          if (wait > 0) await sleep(wait);

          if ((i + 1) % 10 === 0 || i + 1 === gids.length) {
            process.stdout.write(
              `\r  ${i + 1}/${gids.length} fetched  |  +${stats.inserted} new  |  ${stats.noIsrc} no-ISRC  |  ${stats.errors} errors   `
            );
          }
        }
        process.stdout.write('\n');

        // Advance stored sequence only after this packet is fully processed
        await setStoredSequence(seq);

      } finally {
        if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
        if (tarPath)    fs.rmSync(tarPath,    { force: true });
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n── Summary ──────────────────────────────────────────────────────');
  console.log(`  New tracks inserted : ${stats.inserted}`);
  console.log(`  Already in DB       : ${stats.alreadyHad}`);
  console.log(`  No ISRC (skipped)   : ${stats.noIsrc}`);
  console.log(`  Errors              : ${stats.errors}`);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
