import { parseQuery, exactDurationRange, sanitizeForFts } from './queryParser';

export interface Env {
  DB:              D1Database;
  LASTFM_API_KEY:  string;
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

async function enrichGenre(tracks: TrackRow[], env: Env): Promise<void> {
  const needs = tracks.filter(t => t.mb_id && t.genre == null).slice(0, 5);
  for (const track of needs) {
    await new Promise(r => setTimeout(r, 1100));
    try {
      const res = await fetch(
        `https://musicbrainz.org/ws/2/recording/${track.mb_id}?inc=tags&fmt=json`,
        { headers: { 'User-Agent': MB_USER_AGENT } }
      );
      if (res.ok) {
        const data = await res.json() as { tags?: Array<{ count: number; name: string }> };
        const topTag = (data.tags ?? [])
          .sort((a, b) => b.count - a.count)
          .find(t => t.count > 0)?.name ?? null;
        if (topTag) {
          track.genre = topTag;
          await env.DB.prepare('UPDATE tracks SET genre = ? WHERE mb_id = ?')
            .bind(topTag, track.mb_id).run();
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
}

function buildFilterClauses(f: Filters, alias: string): { sql: string; params: unknown[] } {
  const p     = alias ? `${alias}.` : '';
  const conds: string[]  = [];
  const vals:  unknown[] = [];
  if (f.titleContains)    { conds.push(`${p}title LIKE ?`);          vals.push(`%${f.titleContains}%`); }
  if (f.artistContains)   { conds.push(`${p}artist LIKE ?`);         vals.push(`%${f.artistContains}%`); }
  if (f.genre)            { conds.push(`${p}genre LIKE ?`);          vals.push(`%${f.genre}%`); }
  if (f.yearFrom != null) { conds.push(`${p}release_year >= ?`);     vals.push(f.yearFrom); }
  if (f.yearTo   != null) { conds.push(`${p}release_year <= ?`);     vals.push(f.yearTo); }
  if (f.releaseType)      { conds.push(`${p}release_type = ?`);      vals.push(f.releaseType); }
  if (f.label)            { conds.push(`${p}label LIKE ?`);          vals.push(`%${f.label}%`); }
  if (f.artistType)       { conds.push(`${p}artist_type = ?`);       vals.push(f.artistType); }
  if (f.artistGender)     { conds.push(`${p}artist_gender = ?`);     vals.push(f.artistGender); }
  if (f.artistCountry)    { conds.push(`${p}artist_country LIKE ?`); vals.push(`%${f.artistCountry}%`); }
  if (f.language)         { conds.push(`${p}language LIKE ?`);       vals.push(`%${f.language}%`); }
  if (f.bpmMin != null)   { conds.push(`${p}bpm >= ?`);              vals.push(f.bpmMin); }
  if (f.bpmMax != null)   { conds.push(`${p}bpm <= ?`);              vals.push(f.bpmMax); }
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
  return fts
    ? `ORDER BY ${scoreExpr} DESC, tracks_fts.rank`
    : `ORDER BY ${scoreExpr} DESC, duration_ms`;
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

// ListenBrainz: batch POST up to 200 MBIDs, returns map of mbid → user count
async function lbBatch(mbids: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const r = await fetch('https://api.listenbrainz.org/1/popularity/recording', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
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

// Cron batch size: 50 tracks × 210ms = ~10.5s for Last.fm pass, safely fits in 30s window
const CRON_BATCH  = 50;
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
    const lbMap = await lbBatch(lbNeeded);
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

    const url = new URL(request.url);

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

    if (url.pathname !== '/search') return json({ error: 'Not found' }, 404);

    const q         = url.searchParams.get('q') ?? '';
    const tolerance = parseInt(url.searchParams.get('tolerance') ?? '0', 10) || 0;

    const titleContains  = url.searchParams.get('title')          || undefined;
    const artistContains = url.searchParams.get('artist')         || undefined;
    const genre          = url.searchParams.get('genre')          || undefined;
    const yearFromRaw    = url.searchParams.get('year_from');
    const yearToRaw      = url.searchParams.get('year_to');
    const yearFrom       = yearFromRaw ? parseInt(yearFromRaw, 10) : undefined;
    const yearTo         = yearToRaw   ? parseInt(yearToRaw,   10) : undefined;
    const releaseType    = url.searchParams.get('release_type')   || undefined;
    const label          = url.searchParams.get('label')          || undefined;
    const artistType     = url.searchParams.get('artist_type')    || undefined;
    const artistGender   = url.searchParams.get('artist_gender')  || undefined;
    const artistCountry  = url.searchParams.get('artist_country') || undefined;
    const language       = url.searchParams.get('language')       || undefined;
    const bpmMinRaw      = url.searchParams.get('bpm_min');
    const bpmMaxRaw      = url.searchParams.get('bpm_max');
    const bpmMin         = bpmMinRaw ? parseFloat(bpmMinRaw) : undefined;
    const bpmMax         = bpmMaxRaw ? parseFloat(bpmMaxRaw) : undefined;

    const filters: Filters = {
      titleContains, artistContains, genre, yearFrom, yearTo,
      releaseType, label, artistType, artistGender, artistCountry, language,
      bpmMin, bpmMax,
    };
    const hasFilters = !!(
      titleContains || artistContains || genre ||
      yearFrom != null || yearTo != null ||
      releaseType || label ||
      artistType || artistGender || artistCountry || language ||
      bpmMin != null || bpmMax != null
    );

    const page       = Math.max(1, Math.min(500, parseInt(url.searchParams.get('page')     ?? '1',  10) || 1));
    const perPage    = Math.max(1, Math.min(200, parseInt(url.searchParams.get('per_page') ?? '50', 10) || 50));
    const sortRaw    = url.searchParams.get('sort') ?? 'relevance';
    const sort       = ['relevance', 'asc', 'desc'].includes(sortRaw) ? sortRaw : 'relevance';
    const offset     = (page - 1) * perPage;
    const artistsMode = url.searchParams.get('mode') === 'artists';

    const parsed       = parseQuery(q);
    const effectiveFts = parsed.keywords ? sanitizeForFts(parsed.keywords) : '';
    const hasKeywords  = !!effectiveFts;

    if (!hasKeywords && parsed.exactDuration == null && parsed.minDuration == null && parsed.maxDuration == null && !hasFilters) {
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
        const fts = buildFilterClauses(filters, 't');
        const dir = buildFilterClauses(filters, '');
        const artistKeyword = parsed.keywords?.trim() ?? '';
        const hasArtistKeyword = !!artistKeyword;

        // Exclude collaboration/credit strings — standalone band names only
        const noC    = ` AND artist NOT LIKE '%feat%' AND artist NOT LIKE '% & %' AND artist NOT LIKE '% of %' AND artist NOT LIKE '%, %' AND artist NOT LIKE '% with %' AND artist NOT LIKE '% vs %'`;
        const noCfts = ` AND t.artist NOT LIKE '%feat%' AND t.artist NOT LIKE '% & %' AND t.artist NOT LIKE '% of %' AND t.artist NOT LIKE '%, %' AND t.artist NOT LIKE '% with %' AND t.artist NOT LIKE '% vs %'`;

        let dataStmt:  D1PreparedStatement;
        let countStmt: D1PreparedStatement;

        if (hasArtistKeyword) {
          // FTS column-specific search: only matches against the artist column,
          // avoids full table scan. Ordered by peak track popularity.
          const ftsArtistTerm = `artist:"${artistKeyword.replace(/"/g, '""')}"`;
          const dur    = hasDuration ? buildDurationClause('t', minDuration, maxDuration) : null;
          const durSql = dur ? ` AND ${dur.sql}` : '';

          dataStmt = env.DB.prepare(`
            SELECT t.artist, MAX(COALESCE(t.popularity, 0)) as max_pop
            FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?${durSql}
            AND t.artist IS NOT NULL${noCfts}${fts.sql}
            GROUP BY t.artist
            ORDER BY max_pop DESC, t.artist ASC
            LIMIT ${perPage + 1} OFFSET ${offset}
          `).bind(ftsArtistTerm, ...(dur?.params ?? []), ...fts.params);

          countStmt = env.DB.prepare(`
            SELECT COUNT(*) as n FROM (
              SELECT t.artist FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
              WHERE tracks_fts MATCH ?${durSql}
              AND t.artist IS NOT NULL${noCfts}${fts.sql}
              GROUP BY t.artist LIMIT 10001
            )
          `).bind(ftsArtistTerm, ...(dur?.params ?? []), ...fts.params);

        } else if (hasDuration) {
          const dur = buildDurationClause('', minDuration, maxDuration);
          dataStmt = env.DB.prepare(`
            SELECT artist, MAX(COALESCE(popularity, 0)) as max_pop FROM tracks
            WHERE ${dur.sql} AND artist IS NOT NULL${noC}${dir.sql}
            GROUP BY artist ORDER BY max_pop DESC, artist ASC
            LIMIT ${perPage + 1} OFFSET ${offset}
          `).bind(...dur.params, ...dir.params);
          countStmt = env.DB.prepare(`
            SELECT COUNT(*) as n FROM (
              SELECT artist FROM tracks WHERE ${dur.sql} AND artist IS NOT NULL${noC}${dir.sql}
              GROUP BY artist LIMIT 10001
            )
          `).bind(...dur.params, ...dir.params);

        } else {
          dataStmt = env.DB.prepare(`
            SELECT artist, MAX(COALESCE(popularity, 0)) as max_pop FROM tracks
            WHERE artist IS NOT NULL${noC}${dir.sql}
            GROUP BY artist ORDER BY max_pop DESC, artist ASC
            LIMIT ${perPage + 1} OFFSET ${offset}
          `).bind(...dir.params);
          countStmt = env.DB.prepare(`
            SELECT COUNT(*) as n FROM (
              SELECT artist FROM tracks WHERE artist IS NOT NULL${noC}${dir.sql}
              GROUP BY artist LIMIT 10001
            )
          `).bind(...dir.params);
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

        return json({ artists, total, totalCapped, page, perPage, hasMore, mode: 'artists' });
      } catch (err) {
        console.error('Artists search error:', err);
        return json({ error: 'Search failed' }, 500);
      }
    }

    try {
      const fts = buildFilterClauses(filters, 't');
      const dir = buildFilterClauses(filters, '');
      const ob  = buildOrderBy(sort, false);
      const obF = buildOrderBy(sort, true);

      let dataStmt:  D1PreparedStatement;
      let countStmt: D1PreparedStatement;

      if (hasKeywords && hasDuration) {
        const dur = buildDurationClause('t', minDuration, maxDuration);
        dataStmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ? AND ${dur.sql}${fts.sql}
          ${obF} LIMIT ${perPage + 1} OFFSET ${offset}
        `).bind(effectiveFts, ...dur.params, ...fts.params);
        countStmt = env.DB.prepare(`
          SELECT COUNT(*) as n FROM (
            SELECT 1 FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ? AND ${dur.sql}${fts.sql} LIMIT 10001
          )
        `).bind(effectiveFts, ...dur.params, ...fts.params);

      } else if (hasKeywords) {
        dataStmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?${fts.sql}
          ${obF} LIMIT ${perPage + 1} OFFSET ${offset}
        `).bind(effectiveFts, ...fts.params);
        countStmt = env.DB.prepare(`
          SELECT COUNT(*) as n FROM (
            SELECT 1 FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?${fts.sql} LIMIT 10001
          )
        `).bind(effectiveFts, ...fts.params);

      } else if (hasDuration) {
        const dur = buildDurationClause('', minDuration, maxDuration);
        dataStmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS} FROM tracks
          WHERE ${dur.sql}${dir.sql}
          ${ob} LIMIT ${perPage + 1} OFFSET ${offset}
        `).bind(...dur.params, ...dir.params);
        countStmt = env.DB.prepare(`
          SELECT COUNT(*) as n FROM (
            SELECT 1 FROM tracks WHERE ${dur.sql}${dir.sql} LIMIT 10001
          )
        `).bind(...dur.params, ...dir.params);

      } else {
        dataStmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS} FROM tracks
          WHERE 1=1${dir.sql}
          ${ob} LIMIT ${perPage + 1} OFFSET ${offset}
        `).bind(...dir.params);
        countStmt = env.DB.prepare(`
          SELECT COUNT(*) as n FROM (
            SELECT 1 FROM tracks WHERE 1=1${dir.sql} LIMIT 10001
          )
        `).bind(...dir.params);
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

      ctx.waitUntil(enrichGenre(tracks, env));

      return json({
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
  },
};
