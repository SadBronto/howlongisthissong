// Canonical parser shared with the Next app (single source of truth).
import { parseQuery, exactDurationRange, sanitizeForFts } from '../../lib/queryParser';

export interface Env {
  DB:                 D1Database;
  LASTFM_API_KEY:     string;
  LISTENBRAINZ_TOKEN: string;   // required now — LB blocks unauthenticated popularity calls (401)
  RATE_LIMITER:       { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const MB_USER_AGENT = 'HowLongIsThisSong/1.0 (nrctrivia@gmail.com)';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

const JOINED_COLS = `
  t.id, t.title, t.artist, t.album, t.duration_ms,
  t.disambiguation AS version, t.isrc, t.release_year, t.mb_id,
  t.genre, t.popularity, t.popularity_source, t.search_count,
  t.release_type, t.label, t.track_number,
  t.artist_type, t.artist_gender, t.artist_country, t.language,
  t.bpm, t.danceability, t.key_key, t.key_scale,
  t.tuning_freq, t.loudness, t.dynamic_complexity
`;

const DIRECT_COLS = `
  id, title, artist, album, duration_ms,
  disambiguation AS version, isrc, release_year, mb_id,
  genre, popularity, popularity_source, search_count,
  release_type, label, track_number,
  artist_type, artist_gender, artist_country, language,
  bpm, danceability, key_key, key_scale,
  tuning_freq, loudness, dynamic_complexity
`;

// ── MusicBrainz genre enrichment ──────────────────────────────────────────────

interface TrackRow {
  id:                 number;
  mb_id:              string | null;
  isrc:               string | null;
  popularity:         number | null;
  popularity_source:  string | null;
  search_count:       number;
  genre:              string | null;
  bpm:                number | null;
  danceability:       number | null;
  key_key:            string | null;
  key_scale:          string | null;
  tuning_freq:        number | null;
  loudness:           number | null;
  dynamic_complexity: number | null;
  [key: string]:      unknown;
}

// Genre enrichment runs in the cron (not on live search), so MusicBrainz's
// 1-request-per-second limit can never be violated by concurrent searches —
// the cron is a single serial invocation.
const GENRE_CRON_BATCH = 3;

async function enrichGenreCron(env: Env): Promise<void> {
  const res = await env.DB.prepare(
    `SELECT id, mb_id FROM tracks WHERE genre IS NULL AND mb_id IS NOT NULL LIMIT ${GENRE_CRON_BATCH}`
  ).all();
  const rows = (res.results ?? []) as { id: number; mb_id: string }[];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1100)); // MB: 1 req/sec
    try {
      const r = await fetch(
        `https://musicbrainz.org/ws/2/recording/${rows[i].mb_id}?inc=tags&fmt=json`,
        { headers: { 'User-Agent': MB_USER_AGENT }, signal: AbortSignal.timeout(8000) },
      );
      if (r.ok) {
        const data = await r.json() as { tags?: Array<{ count: number; name: string }> };
        const topTag = (data.tags ?? [])
          .sort((a, b) => b.count - a.count)
          .find(t => t.count > 0)?.name ?? null;
        if (topTag) {
          await env.DB.prepare('UPDATE tracks SET genre = ? WHERE id = ?')
            .bind(topTag, rows[i].id).run();
        }
      }
    } catch { /* best-effort */ }
  }
}

// ── Search filters ────────────────────────────────────────────────────────────

interface Filters {
  titleContains?:  string;
  artistContains?: string;
  genre?:          string;
  yearFrom?:       number;
  yearTo?:         number;
  releaseType?:    string;
  label?:          string;
  artistType?:     string;
  artistGender?:   string;
  artistCountry?:  string;
  language?:       string;
  bpmMin?:         number;
  bpmMax?:         number;
  titleLenMin?:    number;
  titleLenMax?:    number;
  artistLenMin?:   number;
  artistLenMax?:   number;
}

/** Convert a user-typed value with optional * wildcards into a SQL LIKE pattern.
 *  Each '*' means "at least one character on that side" (not zero):
 *    con*  → 'con%_'    starts with con, ≥1 char after  (matches "cons", not "con")
 *    *con  → '_%con'    ends with con,   ≥1 char before (matches "bacon", not "con")
 *    *con* → '_%con%_'  contains con,    ≥1 char before AND after
 *                       (matches "Terror" for *erro*, not "Herro")
 *    con   → '%con%'    no wildcards typed → plain "contains" (advanced-field default)
 */
function likePattern(value: string): string {
  const leading  = value.startsWith('*');
  const trailing = value.endsWith('*');
  // Escape LIKE metacharacters in the literal text (\ % _) so they match literally.
  // Clauses that use this pattern include ESCAPE '\'. The * → %/_ wildcards are added
  // AFTER escaping, so they keep their wildcard meaning.
  const core = value.replace(/^\*+/, '').replace(/\*+$/, '').replace(/[\\%_]/g, m => '\\' + m);
  if (!core) return '%';
  if (!leading && !trailing) return `%${core}%`;
  const left  = leading  ? '_%' : '';
  const right = trailing ? '%_' : '';
  return `${left}${core}${right}`;
}

/** Turn an advanced Title/Artist value into a column-scoped FTS prefix query so it
 *  uses the fast text index instead of a full-table LIKE scan.
 *  "Corner" → 'title:corner*' ; "Street Corner" → 'title:street* title:corner*'
 *  Tokens are lowercased alphanumerics (avoids FTS operator/syntax issues).
 *  Returns '' if there are no usable tokens. */
function columnFtsTerm(col: 'title' | 'artist', value: string): string {
  const tokens = value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return '';
  return tokens.map(t => `${col}:${t}*`).join(' ');
}

function buildFilterClauses(f: Filters, alias: string): { sql: string; params: unknown[] } {
  const p     = alias ? `${alias}.` : '';
  const conds: string[]  = [];
  const vals:  unknown[] = [];
  // Adds a LIKE clause, but SKIPS pure-wildcard/empty values (e.g. just "*") so a
  // meaningless filter never turns into "match the entire table".
  const likeOrSkip = (col: string, value: string) => {
    const pat = likePattern(value);
    if (pat === '%') return;
    conds.push(`${p}${col} LIKE ? ESCAPE '\\'`);
    vals.push(pat);
  };
  if (f.titleContains)    likeOrSkip('title',          f.titleContains);
  if (f.artistContains)   likeOrSkip('artist',         f.artistContains);
  if (f.genre)            likeOrSkip('genre',          f.genre);
  if (f.yearFrom != null) { conds.push(`${p}release_year >= ?`);     vals.push(f.yearFrom); }
  if (f.yearTo   != null) { conds.push(`${p}release_year <= ?`);     vals.push(f.yearTo); }
  if (f.releaseType)      { conds.push(`${p}release_type = ?`);      vals.push(f.releaseType); }
  if (f.label)            likeOrSkip('label',          f.label);
  if (f.artistType)       { conds.push(`${p}artist_type = ?`);       vals.push(f.artistType); }
  if (f.artistGender)     { conds.push(`${p}artist_gender = ?`);     vals.push(f.artistGender); }
  if (f.artistCountry)    likeOrSkip('artist_country', f.artistCountry);
  if (f.language)         { conds.push(`${p}language LIKE ?`);       vals.push(`%${f.language}%`); }
  if (f.bpmMin != null)   { conds.push(`${p}bpm >= ?`);              vals.push(f.bpmMin); }
  if (f.bpmMax != null)   { conds.push(`${p}bpm <= ?`);              vals.push(f.bpmMax); }
  if (f.titleLenMin  != null) { conds.push(`LENGTH(${p}title) >= ?`);  vals.push(f.titleLenMin); }
  if (f.titleLenMax  != null) { conds.push(`LENGTH(${p}title) <= ?`);  vals.push(f.titleLenMax); }
  if (f.artistLenMin != null) { conds.push(`LENGTH(${p}artist) >= ?`); vals.push(f.artistLenMin); }
  if (f.artistLenMax != null) { conds.push(`LENGTH(${p}artist) <= ?`); vals.push(f.artistLenMax); }
  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params: vals };
}

// Relevance order:
//   Scored tracks (popularity > 0) sort by their Last.fm / ListenBrainz score (1–100).
//   Unscored tracks fall back to a search_count-derived floor capped at 30,
//   so they can never outrank a properly scored track but still have some ordering.
//   Within score ties, FTS rank or duration_ms breaks the tie.
function buildOrderBy(sort: string, fts: boolean): string {
  const p = fts ? 't.' : '';
  if (sort === 'asc')  return `ORDER BY ${p}duration_ms ASC`;
  if (sort === 'desc') return `ORDER BY ${p}duration_ms DESC`;
  const scoreExpr = `CASE WHEN ${p}popularity > 0 THEN ${p}popularity ELSE MIN(CAST(${p}search_count * 10 AS INTEGER), 30) END`;
  // FTS tiebreak uses weighted bm25 so a title match beats an artist match beats an
  // album-only match (columns are title, artist, album). Lower bm25 = better match.
  return fts
    ? `ORDER BY ${scoreExpr} DESC, bm25(tracks_fts, 10.0, 4.0, 1.0)`
    : `ORDER BY ${scoreExpr} DESC, duration_ms`;
}

// ── Version grouping (keyword searches) ────────────────────────────────────────
// Within a (title, artist) group, pick the headline: most popular, with a boost for
// the untagged studio version (`version` is the disambiguation alias) so it wins when
// scores are close. Columns are unprefixed (they come from the capped subquery).
const HEADLINE_RANK_GROUPED =
  `(COALESCE(popularity, 0) + CASE WHEN version IS NULL OR version = '' THEN 8 ELSE 0 END) DESC, duration_ms`;

const GROUP_SCORE = `CASE WHEN popularity > 0 THEN popularity ELSE MIN(CAST(search_count * 10 AS INTEGER), 30) END`;

// Order the de-duplicated headline rows. bm25 (title-weighted relevance) is carried up
// as the _bm column from the innermost MATCH query, where it's allowed.
function buildGroupedOrderBy(sort: string): string {
  if (sort === 'asc')  return `ORDER BY duration_ms ASC`;
  if (sort === 'desc') return `ORDER BY duration_ms DESC`;
  return `ORDER BY ${GROUP_SCORE} DESC, _bm`;
}

/** Wrap an FTS keyword query so each song (title+artist) returns ONE headline row plus
 *  a version_count. Three levels: (1) FTS match capped to the top-N rows by relevance
 *  — keeps broad searches fast, since windowing the whole match set is too slow;
 *  (2) window functions pick the headline + count per group; (3) keep headlines only. */
function groupedFtsQuery(whereClause: string): string {
  const innerScore = `CASE WHEN t.popularity > 0 THEN t.popularity ELSE MIN(CAST(t.search_count * 10 AS INTEGER), 30) END`;
  return `
    SELECT * FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY lower(title), lower(artist) ORDER BY ${HEADLINE_RANK_GROUPED}) AS _rn,
        COUNT(*) OVER (PARTITION BY lower(title), lower(artist)) AS version_count
      FROM (
        SELECT ${JOINED_COLS}, bm25(tracks_fts, 10.0, 4.0, 1.0) AS _bm
        FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
        WHERE ${whereClause}
        ORDER BY ${innerScore} DESC
        LIMIT 4000
      )
    ) WHERE _rn = 1
  `;
}

/** Build an FTS term that narrows to the candidate rows for ONE song before the exact
 *  lower(title)=? AND lower(artist)=? equality filter runs. AND-ing the title and artist
 *  word tokens keeps the candidate set tiny (a few rows) so the equality filter never
 *  full-scans the 5.7M-row table. Returns '' only when neither field has an alphanumeric
 *  token (extremely rare — e.g. a title that's pure punctuation), in which case the caller
 *  falls back to a direct equality scan. */
function versionsFtsTerm(title: string, artist: string): string {
  const toks = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const parts = [
    ...toks(title).map(t  => `title:${t}`),
    ...toks(artist).map(t => `artist:${t}`),
  ];
  return parts.join(' ');
}

function buildDurationClause(alias: string, minDuration: number | null, maxDuration: number | null): { sql: string; params: unknown[] } {
  const p = alias ? `${alias}.` : '';
  if (minDuration != null && maxDuration != null) {
    return { sql: `${p}duration_ms BETWEEN ? AND ?`, params: [minDuration, maxDuration] };
  } else if (minDuration != null) {
    return { sql: `${p}duration_ms >= ?`,            params: [minDuration] };
  } else {
    return { sql: `${p}duration_ms <= ?`,            params: [maxDuration!] };
  }
}

// ── Popularity enrichment (cron) ──────────────────────────────────────────────

// Log normalization ceilings — empirically established before first run:
//   Last.fm:      Creep + Smells Like Teen Spirit both at ~4.1M listeners → 5M ceiling
//   ListenBrainz: Karma Police at 279,805 → 500K ceiling
const LASTFM_CEILING = 5_000_000;
const LB_CEILING     = 500_000;

function calcLastfmScore(listeners: number): number {
  if (listeners <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(listeners) / Math.log10(LASTFM_CEILING) * 100));
}

function calcLbScore(users: number): number {
  if (users <= 0) return 0;
  return Math.min(100, Math.round(Math.log10(users) / Math.log10(LB_CEILING) * 100));
}

interface EnrichRow {
  id:     number;
  mb_id:  string | null;
  title:  string;
  artist: string | null;
}

interface EnrichResult {
  id:         number;
  popularity: number;
  source:     string;   // 'lastfm' | 'listenbrainz' | 'unfound'
}

// Last.fm: try MBID lookup first, fall back to artist+title
async function lfmLookup(row: EnrichRow, apiKey: string): Promise<number | null> {
  // MBID lookup
  if (row.mb_id) {
    try {
      const r = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&mbid=${encodeURIComponent(row.mb_id)}&api_key=${apiKey}&format=json`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const d = await r.json() as { error?: number; track?: { listeners?: string } };
        if (!d.error && d.track?.listeners != null) {
          const n = parseInt(d.track.listeners, 10);
          if (!isNaN(n)) return n;
        }
      }
    } catch { /* fall through to artist+title */ }
  }
  // Artist + title fallback
  if (row.artist && row.title) {
    try {
      const r = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=track.getInfo` +
        `&artist=${encodeURIComponent(row.artist)}&track=${encodeURIComponent(row.title)}` +
        `&api_key=${apiKey}&format=json&autocorrect=1`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const d = await r.json() as { error?: number; track?: { listeners?: string } };
        if (!d.error && d.track?.listeners != null) {
          const n = parseInt(d.track.listeners, 10);
          if (!isNaN(n)) return n;
        }
      }
    } catch { /* not found */ }
  }
  return null;
}

// ListenBrainz: batch POST up to 200 MBIDs, returns map of mbid → user count.
// A user token is REQUIRED — LB now returns 401 for unauthenticated requests.
async function lbBatch(mbids: string[], token: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const r = await fetch('https://api.listenbrainz.org/1/popularity/recording', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Token ${token}`,
      },
      body:    JSON.stringify({ recording_mbids: mbids }),
      signal:  AbortSignal.timeout(15_000),
    });
    if (r.ok) {
      const data = await r.json() as Array<{ recording_mbid: string; total_user_count: number }>;
      for (const item of data) {
        if (item.recording_mbid && item.total_user_count > 0) {
          result.set(item.recording_mbid, item.total_user_count);
        }
      }
    }
  } catch { /* best-effort */ }
  return result;
}

// Build a single CASE UPDATE for both columns
function buildPopularityUpdate(rows: EnrichResult[]): string {
  const popBranches = rows.map(r => `WHEN ${r.id} THEN ${r.popularity}`).join(' ');
  const srcBranches = rows.map(r => `WHEN ${r.id} THEN '${r.source}'`).join(' ');
  const ids         = rows.map(r => r.id).join(',');
  return (
    `UPDATE tracks SET ` +
    `popularity = CASE id ${popBranches} ELSE popularity END, ` +
    `popularity_source = CASE id ${srcBranches} ELSE popularity_source END ` +
    `WHERE id IN (${ids})`
  );
}

// Cron batch size: 80 tracks × 210ms ≈ 17s of inter-call waits; with API latency a tick runs
// ~45-48s wall-clock, which still fits inside the 60s gap before the next cron fires.
const CRON_BATCH  = 80;
const LASTFM_WAIT = 210; // ms between Last.fm calls

async function enrichPopularityCron(env: Env): Promise<void> {
  if (!env.LASTFM_API_KEY) { console.error('Cron: LASTFM_API_KEY not set'); return; }

  // Yield to local script if it's running — same API key, can't both hit Last.fm at once
  const lock = await env.DB.prepare(
    'SELECT local_active FROM enrichment_lock WHERE id = 1'
  ).first<{ local_active: number }>();
  if (lock?.local_active) {
    console.log('Cron: local enrichment active — skipping this tick');
    return;
  }

  // Read next batch from the pre-built popularity_queue.
  // Two-pass: high-priority first (tracks a user searched for), then normal.
  // A partial index on (priority = 1) makes the first query instant;
  // the second reads the first 50 rows from the primary key — also fast.
  let result = await env.DB.prepare(
    `SELECT t.id, t.mb_id, t.title, t.artist
     FROM popularity_queue q
     JOIN tracks t ON t.id = q.track_id
     WHERE q.priority = 1
     LIMIT ${CRON_BATCH}`
  ).all();

  if ((result.results ?? []).length === 0) {
    result = await env.DB.prepare(
      `SELECT t.id, t.mb_id, t.title, t.artist
       FROM popularity_queue q
       JOIN tracks t ON t.id = q.track_id
       WHERE q.priority = 0
       LIMIT ${CRON_BATCH}`
    ).all();
  }

  const rows = (result.results ?? []) as EnrichRow[];
  if (rows.length === 0) {
    console.log('Cron: popularity queue empty — nothing to do');
    return;
  }

  const scored:     EnrichResult[] = [];
  const lbNeeded:   string[]       = [];  // mb_ids for ListenBrainz fallback
  const mbidToId    = new Map<string, number>();

  // ── Last.fm pass ─────────────────────────────────────────────────────────────
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, LASTFM_WAIT));
    const row = rows[i];
    const listeners = await lfmLookup(row, env.LASTFM_API_KEY);

    if (listeners !== null) {
      scored.push({ id: row.id, popularity: calcLastfmScore(listeners), source: 'lastfm' });
    } else if (row.mb_id) {
      lbNeeded.push(row.mb_id);
      mbidToId.set(row.mb_id, row.id);
    } else {
      scored.push({ id: row.id, popularity: 0, source: 'unfound' });
    }
  }

  // ── ListenBrainz fallback (one batch POST for all Last.fm misses) ─────────────
  if (lbNeeded.length > 0) {
    const lbMap = await lbBatch(lbNeeded, env.LISTENBRAINZ_TOKEN);
    for (const mbid of lbNeeded) {
      const users   = lbMap.get(mbid);
      const trackId = mbidToId.get(mbid)!;
      if (users != null && users > 0) {
        scored.push({ id: trackId, popularity: calcLbScore(users), source: 'listenbrainz' });
      } else {
        scored.push({ id: trackId, popularity: 0, source: 'unfound' });
      }
    }
  }

  // ── Write results ────────────────────────────────────────────────────────────
  if (scored.length > 0) {
    await env.DB.prepare(buildPopularityUpdate(scored)).run();
  }

  // Remove processed tracks from the queue
  const processedIds = rows.map(r => r.id).join(',');
  await env.DB.prepare(`DELETE FROM popularity_queue WHERE track_id IN (${processedIds})`).run();

  const lfmHits = scored.filter(r => r.source === 'lastfm').length;
  const lbHits  = scored.filter(r => r.source === 'listenbrainz').length;
  const unfound = scored.filter(r => r.source === 'unfound').length;
  console.log(`Cron: ${rows.length} tracks — lfm:${lfmHits} lb:${lbHits} unfound:${unfound}`);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export default {

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    // Per-IP rate limit — generous cap (100/min); only scripted abuse trips it.
    const clientIp = request.headers.get('CF-Connecting-IP') ?? 'anon';
    const { success: underLimit } = await env.RATE_LIMITER.limit({ key: clientIp });
    if (!underLimit) {
      return json({ error: 'Too many requests — please slow down a moment.' }, 429);
    }

    const url = new URL(request.url);

    // Generous length caps — only stop abusive/garbage payloads, never a real search.
    // (No real song title/artist/query approaches these limits.) Defined up here so the
    // /versions handler below can use it too.
    const cap = (s: string | null, n: number): string | undefined => {
      if (!s) return undefined;
      return s.length > n ? s.slice(0, n) : s;
    };

    // ── /status — enrichment progress ────────────────────────────────────────
    if (url.pathname === '/status') {
      const [total, bySource] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as n FROM tracks').first<{ n: number }>(),
        env.DB.prepare(
          `SELECT COALESCE(popularity_source, 'unscored') AS src, COUNT(*) as n ` +
          `FROM tracks GROUP BY src`
        ).all(),
      ]);
      const sources: Record<string, number> = {};
      for (const row of (bySource.results ?? []) as { src: string; n: number }[]) {
        sources[row.src] = row.n;
      }
      return json({ total: total?.n ?? 0, bySource: sources });
    }

    // ── /versions — every recording of one song (same title + same artist) ───
    // Powers the "N more versions" expand in the UI. FTS-scoped so it's fast: the MATCH
    // narrows to a few candidate rows, then the exact equality filter selects only this
    // song. Ordered headline-first (studio-preferred), the same rank that picks the
    // grouped headline in /search?group=1.
    if (url.pathname === '/versions') {
      const vTitle  = (cap(url.searchParams.get('title'),  300) ?? '').trim();
      const vArtist = (cap(url.searchParams.get('artist'), 300) ?? '').trim();
      if (!vTitle || !vArtist) {
        return json({ error: 'title and artist are both required' }, 400);
      }

      // Edge-cache identical lookups (same 5-min TTL as /search).
      const vCache    = caches.default;
      const vCacheKey = new Request(url.toString());
      const vHit      = await vCache.match(vCacheKey);
      if (vHit) return vHit;

      try {
        const ftsTerm = versionsFtsTerm(vTitle, vArtist);
        const lt = vTitle.toLowerCase();
        const la = vArtist.toLowerCase();

        // Cap the payload so a pathological song (hundreds of recordings) can't return an
        // unbounded blob. HEADLINE_RANK_GROUPED references the output aliases
        // (popularity / version / duration_ms), which both column lists expose.
        const stmt = ftsTerm
          ? env.DB.prepare(
              `SELECT ${JOINED_COLS} FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
               WHERE tracks_fts MATCH ? AND lower(t.title) = ? AND lower(t.artist) = ?
               ORDER BY ${HEADLINE_RANK_GROUPED} LIMIT 500`
            ).bind(ftsTerm, lt, la)
          // Rare fallback: a title+artist with no alphanumeric tokens can't use FTS.
          : env.DB.prepare(
              `SELECT ${DIRECT_COLS} FROM tracks
               WHERE lower(title) = ? AND lower(artist) = ?
               ORDER BY ${HEADLINE_RANK_GROUPED} LIMIT 500`
            ).bind(lt, la);

        const result   = await stmt.all();
        const versions = (result.results ?? []) as TrackRow[];

        const resp = new Response(
          JSON.stringify({ versions, total: versions.length, title: vTitle, artist: vArtist }),
          { status: 200, headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' } },
        );
        ctx.waitUntil(vCache.put(vCacheKey, resp.clone()));
        return resp;
      } catch (err) {
        console.error('Versions error:', err);
        return json({ error: 'Versions lookup failed' }, 500);
      }
    }

    // ── /stats — public fun-fact counter: total searches run ──────────────────
    if (url.pathname === '/stats') {
      const sCache = caches.default;
      const sKey   = new Request(url.toString());
      const sHit   = await sCache.match(sKey);
      if (sHit) return sHit;
      const row = await env.DB.prepare('SELECT total_searches FROM site_stats WHERE id = 1')
        .first<{ total_searches: number }>();
      const resp = new Response(
        JSON.stringify({ total_searches: row?.total_searches ?? 0 }),
        { status: 200, headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=60' } },
      );
      ctx.waitUntil(sCache.put(sKey, resp.clone()));
      return resp;
    }

    if (url.pathname !== '/search') return json({ error: 'Not found' }, 404);

    // ── Edge cache ────────────────────────────────────────────────────────────
    // Identical searches within the TTL are served instantly from the per-colo cache
    // instead of re-running the query. The first search of each query+page still runs
    // (and does its search-count / queue-priority tracking); only redundant repeats are
    // served from cache, so no result ever loses its tracking.
    const cache    = caches.default;
    const cacheKey = new Request(url.toString());
    const cacheHit = await cache.match(cacheKey);
    if (cacheHit) return cacheHit;

    const cacheJson = (data: unknown): Response => {
      const resp = new Response(JSON.stringify(data), {
        status:  200,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=300' },
      });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      // Fun-fact counter: one increment per uncached search (cache hits return earlier).
      ctx.waitUntil(
        env.DB.prepare('UPDATE site_stats SET total_searches = total_searches + 1 WHERE id = 1')
          .run().catch(() => {})
      );
      return resp;
    };

    const q         = (cap(url.searchParams.get('q'), 200) ?? '');
    const tolerance = parseInt(url.searchParams.get('tolerance') ?? '0', 10) || 0;

    const titleContains  = cap(url.searchParams.get('title'),          120);
    const artistContains = cap(url.searchParams.get('artist'),         120);
    const genre          = cap(url.searchParams.get('genre'),          120);
    const yearFromRaw    = url.searchParams.get('year_from');
    const yearToRaw      = url.searchParams.get('year_to');
    const yearFrom       = yearFromRaw ? parseInt(yearFromRaw, 10) : undefined;
    const yearTo         = yearToRaw   ? parseInt(yearToRaw,   10) : undefined;
    const releaseType    = url.searchParams.get('release_type')   || undefined;
    const label          = cap(url.searchParams.get('label'),          120);
    const artistType     = url.searchParams.get('artist_type')    || undefined;
    const artistGender   = url.searchParams.get('artist_gender')  || undefined;
    const artistCountry  = cap(url.searchParams.get('artist_country'), 120);
    const language       = cap(url.searchParams.get('language'),       12);
    const bpmMinRaw      = url.searchParams.get('bpm_min');
    const bpmMaxRaw      = url.searchParams.get('bpm_max');
    const bpmMin         = bpmMinRaw ? parseFloat(bpmMinRaw) : undefined;
    const bpmMax         = bpmMaxRaw ? parseFloat(bpmMaxRaw) : undefined;
    const titleLenMinRaw  = url.searchParams.get('title_len_min');
    const titleLenMaxRaw  = url.searchParams.get('title_len_max');
    const artistLenMinRaw = url.searchParams.get('artist_len_min');
    const artistLenMaxRaw = url.searchParams.get('artist_len_max');
    const titleLenMin    = titleLenMinRaw  ? parseInt(titleLenMinRaw,  10) : undefined;
    const titleLenMax    = titleLenMaxRaw  ? parseInt(titleLenMaxRaw,  10) : undefined;
    const artistLenMin   = artistLenMinRaw ? parseInt(artistLenMinRaw, 10) : undefined;
    const artistLenMax   = artistLenMaxRaw ? parseInt(artistLenMaxRaw, 10) : undefined;

    const filters: Filters = {
      titleContains, artistContains, genre, yearFrom, yearTo,
      releaseType, label, artistType, artistGender, artistCountry, language,
      bpmMin, bpmMax, titleLenMin, titleLenMax, artistLenMin, artistLenMax,
    };
    const hasFilters = !!(
      titleContains || artistContains || genre ||
      yearFrom != null || yearTo != null ||
      releaseType || label ||
      artistType || artistGender || artistCountry || language ||
      bpmMin != null || bpmMax != null ||
      titleLenMin != null || titleLenMax != null ||
      artistLenMin != null || artistLenMax != null
    );

    const page       = Math.max(1, Math.min(500, parseInt(url.searchParams.get('page')     ?? '1',  10) || 1));
    const perPage    = Math.max(1, Math.min(200, parseInt(url.searchParams.get('per_page') ?? '50', 10) || 50));
    const sortRaw    = url.searchParams.get('sort') ?? 'relevance';
    const sort       = ['relevance', 'asc', 'desc'].includes(sortRaw) ? sortRaw : 'relevance';
    const offset     = (page - 1) * perPage;
    const artistsMode = url.searchParams.get('mode') === 'artists';
    // Group versions of the same song (keyword searches only). Opt-in via group=1 so
    // the worker stays flat for clients that don't render the "N more versions" UI yet.
    const grouped     = url.searchParams.get('group') === '1';

    const parsed = parseQuery(q);

    // Fold advanced Title/Artist text into the FTS query so they hit the fast text
    // index instead of a full-table LIKE scan (the cause of "Title: Corner" timing out).
    // Only when there's no LEADING wildcard — a leading '*' means suffix/contains, which
    // FTS can't do, so those intentionally stay a (slower, opt-in) LIKE scan.
    const titleFold  = titleContains  && !titleContains.startsWith('*')  ? columnFtsTerm('title',  titleContains)  : '';
    const artistFold = artistContains && !artistContains.startsWith('*') ? columnFtsTerm('artist', artistContains) : '';

    const ftsParts: string[] = [];
    if (parsed.keywords) ftsParts.push(sanitizeForFts(parsed.keywords));
    if (titleFold)  ftsParts.push(titleFold);
    if (artistFold) ftsParts.push(artistFold);
    const effectiveFts = ftsParts.join(' ');
    const hasKeywords  = !!effectiveFts;

    // Title/Artist now handled by FTS are dropped from the LIKE filters so the slow
    // scan never runs; every other filter (genre, year, BPM, length…) is unaffected.
    const filtersForLike: Filters = { ...filters };
    if (titleFold)  delete filtersForLike.titleContains;
    if (artistFold) delete filtersForLike.artistContains;

    // ── Advanced "Starts with" (anchored prefix) — free + fast ─────────────────
    // The FTS fold above already narrows to rows whose title/artist contain a word
    // beginning with the typed text. "Starts with" mode adds an anchored
    // lower(col) LIKE 'value%' on top — but it only runs against those few FTS-matched
    // rows, so it stays instant and needs NO new index (no D1 writes). We require the
    // FTS fold to be present so the anchor can never trigger a full-table scan.
    const titleStartsWith  = url.searchParams.get('title_mode')  === 'startswith';
    const artistStartsWith = url.searchParams.get('artist_mode') === 'startswith';
    const buildSwClause = (col: 'title' | 'artist', value: string | undefined, fold: string): { sql: string; params: unknown[] } => {
      if (!value || !fold) return { sql: '', params: [] };
      const cleaned = value.toLowerCase().replace(/\*/g, '').trim();
      if (!cleaned) return { sql: '', params: [] };
      const core = cleaned.replace(/[\\%_]/g, m => '\\' + m);  // LIKE metachars → literal
      return { sql: ` AND lower(t.${col}) LIKE ? ESCAPE '\\'`, params: [`${core}%`] };
    };
    const swTitle  = titleStartsWith  ? buildSwClause('title',  titleContains,  titleFold)  : { sql: '', params: [] as unknown[] };
    const swArtist = artistStartsWith ? buildSwClause('artist', artistContains, artistFold) : { sql: '', params: [] as unknown[] };
    const swFts    = { sql: swTitle.sql + swArtist.sql, params: [...swTitle.params, ...swArtist.params] };

    // Wildcard pattern from main search box (e.g. con* → title/artist LIKE 'con%_')
    const wcPat    = parsed.wildcardToken ? likePattern(parsed.wildcardToken) : null;
    const hasWc    = !!wcPat;
    const wcFts    = hasWc ? { sql: ` AND (t.title LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\')`, params: [wcPat, wcPat] as unknown[] } : { sql: '', params: [] as unknown[] };
    const wcDir    = hasWc ? { sql: ` AND (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\')`,      params: [wcPat, wcPat] as unknown[] } : { sql: '', params: [] as unknown[] };
    // Artists mode: wildcard applies to artist column only
    const wcArtFts = hasWc ? { sql: ` AND t.artist LIKE ? ESCAPE '\\'`, params: [wcPat] as unknown[] } : { sql: '', params: [] as unknown[] };
    const wcArtDir = hasWc ? { sql: ` AND artist LIKE ? ESCAPE '\\'`,   params: [wcPat] as unknown[] } : { sql: '', params: [] as unknown[] };

    if (!hasKeywords && !hasWc && parsed.exactDuration == null && parsed.minDuration == null && parsed.maxDuration == null && !hasFilters) {
      return json({ tracks: [], total: 0, page, perPage, hasMore: false });
    }

    let minDuration: number | null = null;
    let maxDuration: number | null = null;

    if (parsed.exactDuration != null) {
      const windowMs = parsed.exactDurationWindowMs ?? 1000;
      [minDuration, maxDuration] = exactDurationRange(parsed.exactDuration, windowMs, tolerance / 1000);
    } else if (parsed.minDuration != null || parsed.maxDuration != null) {
      minDuration = parsed.minDuration ?? null;
      maxDuration = parsed.maxDuration ?? null;
      if (tolerance > 0) {
        if (minDuration != null) minDuration -= tolerance;
        if (maxDuration != null) maxDuration += tolerance;
      }
    }

    const hasDuration = minDuration != null || maxDuration != null;

    // ── Artists mode ──────────────────────────────────────────────────────────
    if (artistsMode) {
      try {
        const fts = buildFilterClauses(filtersForLike, 't');
        const dir = buildFilterClauses(filtersForLike, '');
        // Route the artist keyword AND any advanced Title/Artist text through the FTS
        // index (instead of a full-table LIKE scan) so "Artists only" + a title/artist
        // filter stays fast. The main search box is treated as an artist search here.
        const artistKeyword = parsed.keywords?.trim() ?? '';
        const artistFtsParts: string[] = [];
        if (artistKeyword) artistFtsParts.push(`artist:"${artistKeyword.replace(/"/g, '""')}"`);
        if (artistFold)    artistFtsParts.push(artistFold);
        if (titleFold)     artistFtsParts.push(titleFold);
        const artistFtsTerm  = artistFtsParts.join(' ');
        const hasArtistFts   = !!artistFtsTerm;

        // Exclude collaboration/credit strings — standalone band names only
        // Only UNAMBIGUOUS collaboration join-phrases are excluded, so real band
        // names containing "&", "," or "/" (Earth, Wind & Fire / Simon & Garfunkel /
        // Crosby, Stills & Nash / AC/DC) are no longer hidden. Genuine ad-hoc "X & Y"
        // collabs will now appear as artists — intentional (we're reintroducing them).
        const collabPatterns = [
          `NOT LIKE '% feat%'`,       // " feat." / featuring (leading space avoids e.g. "Defeater")
          `NOT LIKE '% ft. %'`,       // alternate feat.
          `NOT LIKE '% ft %'`,        // alternate feat. (no period)
          `NOT LIKE '% vs %'`,        // "vs" / versus
          `NOT LIKE '% presents %'`,  // "Artist presents Other"
          `NOT LIKE '% pres. %'`,     // abbreviated presents
          `NOT LIKE '%;%'`,           // semicolon separates multiple distinct artists
          // NOTE: "and" / "und" intentionally excluded — too many real band names
          // contain "and" (Of Monsters and Men, Simon and Garfunkel, etc.)
        ];
        const noC    = collabPatterns.map(p => ` AND artist ${p}`).join('');
        const noCfts = collabPatterns.map(p => ` AND t.artist ${p}`).join('');

        // Sort order for artists mode
        const artistOb     = sort === 'asc' ? 'ORDER BY artist ASC'
          : sort === 'desc' ? 'ORDER BY artist DESC'
          : 'ORDER BY max_pop DESC, artist ASC';
        const artistObFts  = sort === 'asc' ? 'ORDER BY t.artist ASC'
          : sort === 'desc' ? 'ORDER BY t.artist DESC'
          : 'ORDER BY max_pop DESC, t.artist ASC';

        let dataStmt:  D1PreparedStatement;
        let countStmt: D1PreparedStatement;

        if (hasArtistFts) {
          // FTS column-specific search (artist keyword + folded advanced text):
          // avoids a full-table GROUP BY scan. Ordered by peak track popularity.
          const ftsArtistTerm = artistFtsTerm;
          const dur    = hasDuration ? buildDurationClause('t', minDuration, maxDuration) : null;
          const durSql = dur ? ` AND ${dur.sql}` : '';

          dataStmt = env.DB.prepare(`
            SELECT t.artist, MAX(COALESCE(t.popularity, 0)) as max_pop
            FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?${durSql}
            AND t.artist IS NOT NULL${noCfts}${fts.sql}${wcArtFts.sql}${swArtist.sql}
            GROUP BY t.artist
            ${artistObFts}
            LIMIT ${perPage + 1} OFFSET ${offset}
          `).bind(ftsArtistTerm, ...(dur?.params ?? []), ...fts.params, ...wcArtFts.params, ...swArtist.params);

          countStmt = env.DB.prepare(`
            SELECT COUNT(*) as n FROM (
              SELECT t.artist FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
              WHERE tracks_fts MATCH ?${durSql}
              AND t.artist IS NOT NULL${noCfts}${fts.sql}${wcArtFts.sql}${swArtist.sql}
              GROUP BY t.artist LIMIT 10001
            )
          `).bind(ftsArtistTerm, ...(dur?.params ?? []), ...fts.params, ...wcArtFts.params, ...swArtist.params);

        } else if (hasDuration) {
          const dur = buildDurationClause('', minDuration, maxDuration);
          dataStmt = env.DB.prepare(`
            SELECT artist, MAX(COALESCE(popularity, 0)) as max_pop FROM tracks
            WHERE ${dur.sql} AND artist IS NOT NULL${noC}${dir.sql}${wcArtDir.sql}
            GROUP BY artist ${artistOb}
            LIMIT ${perPage + 1} OFFSET ${offset}
          `).bind(...dur.params, ...dir.params, ...wcArtDir.params);
          countStmt = env.DB.prepare(`
            SELECT COUNT(*) as n FROM (
              SELECT artist FROM tracks WHERE ${dur.sql} AND artist IS NOT NULL${noC}${dir.sql}${wcArtDir.sql}
              GROUP BY artist LIMIT 10001
            )
          `).bind(...dur.params, ...dir.params, ...wcArtDir.params);

        } else {
          dataStmt = env.DB.prepare(`
            SELECT artist, MAX(COALESCE(popularity, 0)) as max_pop FROM tracks
            WHERE artist IS NOT NULL${noC}${dir.sql}${wcArtDir.sql}
            GROUP BY artist ${artistOb}
            LIMIT ${perPage + 1} OFFSET ${offset}
          `).bind(...dir.params, ...wcArtDir.params);
          countStmt = env.DB.prepare(`
            SELECT COUNT(*) as n FROM (
              SELECT artist FROM tracks WHERE artist IS NOT NULL${noC}${dir.sql}${wcArtDir.sql}
              GROUP BY artist LIMIT 10001
            )
          `).bind(...dir.params, ...wcArtDir.params);
        }

        const [result, countResult] = await Promise.all([
          dataStmt.all(),
          countStmt.first<{ n: number }>(),
        ]);

        const allRows     = (result.results ?? []) as { artist: string }[];
        const hasMore     = allRows.length > perPage;
        const artists     = allRows.slice(0, perPage).map(r => r.artist).filter(Boolean);
        const rawCount    = countResult?.n ?? (hasMore ? perPage + 1 : artists.length);
        const totalCapped = rawCount > 10000;
        const total       = Math.min(rawCount, 10000);

        return cacheJson({ artists, total, totalCapped, page, perPage, hasMore, mode: 'artists' });
      } catch (err) {
        console.error('Artists search error:', err);
        return json({ error: 'Search failed' }, 500);
      }
    }

    try {
      const fts = buildFilterClauses(filtersForLike, 't');
      const dir = buildFilterClauses(filtersForLike, '');
      const ob  = buildOrderBy(sort, false);
      const obF = buildOrderBy(sort, true);

      let dataStmt:  D1PreparedStatement;
      let countStmt: D1PreparedStatement;

      if (hasKeywords && hasDuration) {
        const dur = buildDurationClause('t', minDuration, maxDuration);
        const wh  = `tracks_fts MATCH ? AND ${dur.sql}${fts.sql}${wcFts.sql}${swFts.sql}`;
        const ps  = [effectiveFts, ...dur.params, ...fts.params, ...wcFts.params, ...swFts.params];
        if (grouped) {
          dataStmt  = env.DB.prepare(`${groupedFtsQuery(wh)} ${buildGroupedOrderBy(sort)} LIMIT ${perPage + 1} OFFSET ${offset}`).bind(...ps);
          countStmt = env.DB.prepare(`SELECT COUNT(*) as n FROM (SELECT 1 FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid WHERE ${wh} GROUP BY lower(t.title), lower(t.artist) LIMIT 10001)`).bind(...ps);
        } else {
          dataStmt  = env.DB.prepare(`SELECT ${JOINED_COLS} FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid WHERE ${wh} ${obF} LIMIT ${perPage + 1} OFFSET ${offset}`).bind(...ps);
          countStmt = env.DB.prepare(`SELECT COUNT(*) as n FROM (SELECT 1 FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid WHERE ${wh} LIMIT 10001)`).bind(...ps);
        }

      } else if (hasKeywords) {
        const wh = `tracks_fts MATCH ?${fts.sql}${wcFts.sql}${swFts.sql}`;
        const ps = [effectiveFts, ...fts.params, ...wcFts.params, ...swFts.params];
        if (grouped) {
          dataStmt  = env.DB.prepare(`${groupedFtsQuery(wh)} ${buildGroupedOrderBy(sort)} LIMIT ${perPage + 1} OFFSET ${offset}`).bind(...ps);
          countStmt = env.DB.prepare(`SELECT COUNT(*) as n FROM (SELECT 1 FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid WHERE ${wh} GROUP BY lower(t.title), lower(t.artist) LIMIT 10001)`).bind(...ps);
        } else {
          dataStmt  = env.DB.prepare(`SELECT ${JOINED_COLS} FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid WHERE ${wh} ${obF} LIMIT ${perPage + 1} OFFSET ${offset}`).bind(...ps);
          countStmt = env.DB.prepare(`SELECT COUNT(*) as n FROM (SELECT 1 FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid WHERE ${wh} LIMIT 10001)`).bind(...ps);
        }

      } else if (hasDuration) {
        const dur = buildDurationClause('', minDuration, maxDuration);
        dataStmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS} FROM tracks
          WHERE ${dur.sql}${dir.sql}${wcDir.sql}
          ${ob} LIMIT ${perPage + 1} OFFSET ${offset}
        `).bind(...dur.params, ...dir.params, ...wcDir.params);
        countStmt = env.DB.prepare(`
          SELECT COUNT(*) as n FROM (
            SELECT 1 FROM tracks WHERE ${dur.sql}${dir.sql}${wcDir.sql} LIMIT 10001
          )
        `).bind(...dur.params, ...dir.params, ...wcDir.params);

      } else {
        dataStmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS} FROM tracks
          WHERE 1=1${dir.sql}${wcDir.sql}
          ${ob} LIMIT ${perPage + 1} OFFSET ${offset}
        `).bind(...dir.params, ...wcDir.params);
        countStmt = env.DB.prepare(`
          SELECT COUNT(*) as n FROM (
            SELECT 1 FROM tracks WHERE 1=1${dir.sql}${wcDir.sql} LIMIT 10001
          )
        `).bind(...dir.params, ...wcDir.params);
      }

      const [result, countResult] = await Promise.all([
        dataStmt.all(),
        countStmt.first<{ n: number }>(),
      ]);

      const allRows     = (result.results ?? []) as TrackRow[];
      const hasMore     = allRows.length > perPage;
      const tracks      = allRows.slice(0, perPage);
      const rawCount    = countResult?.n ?? (hasMore ? perPage + 1 : tracks.length);
      const totalCapped = rawCount > 10000;
      const total       = Math.min(rawCount, 10000);

      // ── search_count: credit unscored tracks for appearing in this result set ─
      // credit = 1/rawCount so broad searches (10,000 results) give tiny credit (0.0001)
      // and narrow searches (4 results) give meaningful credit (0.25).
      // Cap at 30 in ORDER BY so search_count can never outrank an externally scored track.
      if (rawCount > 0) {
        const unscoredIds = tracks
          .filter(t => t.popularity_source == null || t.popularity_source === 'unfound')
          .map(t => t.id);

        if (unscoredIds.length > 0) {
          const credit = 1 / rawCount;
          const idList = unscoredIds.join(',');
          ctx.waitUntil(
            env.DB.prepare(
              `UPDATE tracks SET search_count = search_count + ? ` +
              `WHERE id IN (${idList}) ` +
              `AND (popularity_source IS NULL OR popularity_source = 'unfound')`
            ).bind(credit).run().catch(() => {})
          );

          // Bump queue priority for any still-unscored tracks so the cron
          // scores them before the ~5M unscored tracks nobody has searched for.
          const queueIds = tracks
            .filter(t => t.popularity_source == null)
            .map(t => t.id);
          if (queueIds.length > 0) {
            ctx.waitUntil(
              env.DB.prepare(
                `UPDATE popularity_queue SET priority = 1 WHERE track_id IN (${queueIds.join(',')})`
              ).run().catch(() => {})
            );
          }
        }
      }

      // Genre enrichment intentionally NOT done here — it runs in the cron to avoid
      // tripping MusicBrainz's rate limit when many people search at once.

      return cacheJson({
        tracks,
        total,
        totalCapped,
        page,
        perPage,
        hasMore,
        parsed: {
          keywords:      parsed.keywords,
          exactDuration: parsed.exactDuration,
          minDuration:   parsed.minDuration,
          maxDuration:   parsed.maxDuration,
          genre,
          yearFrom,
          yearTo,
          releaseType,
          label,
          bpmFrom:       bpmMin,
          bpmTo:         bpmMax,
        },
      });

    } catch (err) {
      console.error('Search error:', err);
      return json({ error: 'Search failed' }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enrichPopularityCron(env));
    ctx.waitUntil(enrichGenreCron(env));   // MusicBrainz genre fill-in, serial & rate-safe
  },
};
