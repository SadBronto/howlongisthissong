import { parseQuery, exactDurationRange, sanitizeForFts } from './queryParser';

export interface Env {
  DB: D1Database;
  SPOTIFY_CLIENT_ID:     string;
  SPOTIFY_CLIENT_SECRET: string;
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
  t.genre, t.popularity, t.release_type, t.label, t.track_number
`;

const DIRECT_COLS = `
  id, title, artist, album, duration_ms,
  disambiguation AS version, isrc, release_year, mb_id,
  genre, popularity, release_type, label, track_number
`;

// ── Utility ───────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>(r => setTimeout(() => r(null), ms)),
  ]);
}

// ── Spotify ───────────────────────────────────────────────────────────────────

async function getSpotifyToken(env: Env): Promise<string | null> {
  try {
    const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization':  `Basic ${creds}`,
        'Content-Type':   'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) return null;
    const data = await res.json() as { access_token: string };
    return data.access_token;
  } catch {
    return null;
  }
}

async function spotifyLookup(isrc: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (res.status === 429) { res.body?.cancel(); return null; }
    if (!res.ok)            { res.body?.cancel(); return null; }
    const data  = await res.json() as { tracks: { items: Array<{ popularity: number }> } };
    const items = data.tracks?.items;
    if (!items || items.length === 0) return -1;
    return items[0].popularity ?? 0;
  } catch {
    return null;
  }
}

interface TrackRow {
  mb_id:      string | null;
  isrc:       string | null;
  popularity: number | null;
  genre:      string | null;
  [key: string]: unknown;
}

async function enrichWithSpotify(
  tracks:    TrackRow[],
  token:     string,
  env:       Env,
  batchSize: number,
  delayMs:   number,
): Promise<void> {
  const needs = tracks.filter(t => t.isrc && t.popularity == null);

  for (let i = 0; i < needs.length; i += batchSize) {
    const batch = needs.slice(i, i + batchSize);
    await Promise.all(batch.map(async t => {
      const score = await spotifyLookup(t.isrc!, token);
      if (score !== null) {
        t.popularity = score;
        env.DB.prepare('UPDATE tracks SET popularity = ? WHERE mb_id = ?')
          .bind(score, t.mb_id)
          .run()
          .catch(() => {});
      }
    }));
    if (delayMs > 0 && i + batchSize < needs.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── MusicBrainz genre enrichment ──────────────────────────────────────────────

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
            .bind(topTag, track.mb_id)
            .run();
        }
      }
    } catch {
      // best-effort
    }
  }
}

// ── Search filters ────────────────────────────────────────────────────────────

interface Filters {
  genre?:       string;
  yearFrom?:    number;
  yearTo?:      number;
  releaseType?: string;
  label?:       string;
}

/**
 * Returns SQL condition fragments and their bound values for the active filters.
 * alias: 't' for FTS-join queries, '' for direct queries.
 */
function buildFilterClauses(
  f: Filters,
  alias: string,
): { sql: string; params: unknown[] } {
  const p    = alias ? `${alias}.` : '';
  const conds: string[] = [];
  const vals:  unknown[] = [];

  if (f.genre) {
    conds.push(`${p}genre LIKE ?`);
    vals.push(`%${f.genre}%`);
  }
  if (f.yearFrom != null) {
    conds.push(`${p}release_year >= ?`);
    vals.push(f.yearFrom);
  }
  if (f.yearTo != null) {
    conds.push(`${p}release_year <= ?`);
    vals.push(f.yearTo);
  }
  if (f.releaseType) {
    conds.push(`${p}release_type = ?`);
    vals.push(f.releaseType);
  }
  if (f.label) {
    conds.push(`${p}label LIKE ?`);
    vals.push(`%${f.label}%`);
  }

  return {
    sql:    conds.length ? ' AND ' + conds.join(' AND ') : '',
    params: vals,
  };
}

/** Build the duration WHERE fragment (handles open-ended ranges). */
function buildDurationClause(
  alias:       string,
  minDuration: number | null,
  maxDuration: number | null,
): { sql: string; params: unknown[] } {
  const p = alias ? `${alias}.` : '';
  if (minDuration != null && maxDuration != null) {
    return { sql: `${p}duration_ms BETWEEN ? AND ?`, params: [minDuration, maxDuration] };
  } else if (minDuration != null) {
    return { sql: `${p}duration_ms >= ?`,            params: [minDuration] };
  } else {
    return { sql: `${p}duration_ms <= ?`,            params: [maxDuration!] };
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export default {

  async fetch(
    request: Request,
    env:     Env,
    ctx:     ExecutionContext,
  ): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url       = new URL(request.url);
    const q         = url.searchParams.get('q') ?? '';
    const tolerance = parseInt(url.searchParams.get('tolerance') ?? '0', 10) || 0;

    // ── Optional filters ──────────────────────────────────────────────────────
    const genre       = url.searchParams.get('genre')        || undefined;
    const yearFromRaw = url.searchParams.get('year_from');
    const yearToRaw   = url.searchParams.get('year_to');
    const yearFrom    = yearFromRaw ? parseInt(yearFromRaw, 10) : undefined;
    const yearTo      = yearToRaw   ? parseInt(yearToRaw,   10) : undefined;
    const releaseType = url.searchParams.get('release_type') || undefined;
    const label       = url.searchParams.get('label')        || undefined;

    const filters: Filters = { genre, yearFrom, yearTo, releaseType, label };
    const hasFilters = !!(genre || yearFrom != null || yearTo != null || releaseType || label);

    if (url.pathname !== '/search') return json({ error: 'Not found' }, 404);

    const parsed = parseQuery(q);

    // Bail early only if there's truly nothing to search on
    if (!parsed.keywords && parsed.exactDuration == null && parsed.minDuration == null && parsed.maxDuration == null && !hasFilters) {
      return json({ tracks: [], total: 0 });
    }

    // ── Resolve duration bounds ───────────────────────────────────────────────
    let minDuration: number | null = null;
    let maxDuration: number | null = null;

    if (parsed.exactDuration != null) {
      const windowMs = parsed.exactDurationWindowMs ?? 1000;
      [minDuration, maxDuration] = exactDurationRange(parsed.exactDuration, windowMs, tolerance / 1000);
    } else if (parsed.minDuration != null || parsed.maxDuration != null) {
      minDuration = parsed.minDuration ?? null;
      maxDuration = parsed.maxDuration ?? null;
      // Widen by tolerance on whichever bound exists
      if (tolerance > 0) {
        if (minDuration != null) minDuration -= tolerance;
        if (maxDuration != null) maxDuration += tolerance;
      }
    }

    const hasDuration = minDuration != null || maxDuration != null;
    const hasKeywords = !!parsed.keywords;

    try {
      let stmt: D1PreparedStatement;

      const fts = buildFilterClauses(filters, 't');
      const dir = buildFilterClauses(filters, '');

      if (hasKeywords && hasDuration) {
        const ftsQuery = sanitizeForFts(parsed.keywords!);
        const dur = buildDurationClause('t', minDuration, maxDuration);
        stmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?
            AND ${dur.sql}${fts.sql}
          ORDER BY COALESCE(t.popularity, -2) DESC, tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery, ...dur.params, ...fts.params);

      } else if (hasKeywords) {
        const ftsQuery = sanitizeForFts(parsed.keywords!);
        stmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?${fts.sql}
          ORDER BY COALESCE(t.popularity, -2) DESC, tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery, ...fts.params);

      } else if (hasDuration) {
        const dur = buildDurationClause('', minDuration, maxDuration);
        stmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS}
          FROM tracks
          WHERE ${dur.sql}${dir.sql}
          ORDER BY COALESCE(popularity, -2) DESC, duration_ms
          LIMIT 100
        `).bind(...dur.params, ...dir.params);

      } else {
        // Filters only — no keywords, no duration
        stmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS}
          FROM tracks
          WHERE 1=1${dir.sql}
          ORDER BY COALESCE(popularity, -2) DESC
          LIMIT 100
        `).bind(...dir.params);
      }

      const result = await stmt.all();
      const tracks = (result.results ?? []) as TrackRow[];

      // ── Spotify enrichment for keyword or filter searches ─────────────────
      if ((hasKeywords || hasFilters) && tracks.length > 0 && env.SPOTIFY_CLIENT_ID) {
        const token = await withTimeout(getSpotifyToken(env), 800);
        if (token) {
          await withTimeout(enrichWithSpotify(tracks, token, env, 4, 0), 700);
          tracks.sort((a, b) => (b.popularity ?? -2) - (a.popularity ?? -2));
        }
      }

      // ── Background genre enrichment ───────────────────────────────────────
      ctx.waitUntil(enrichGenre(tracks, env));

      return json({
        tracks,
        total: tracks.length,
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
        },
      });

    } catch (err) {
      console.error('Search error:', err);
      return json({ error: 'Search failed' }, 500);
    }
  },

  // ── Cron: background Spotify enrichment ────────────────────────────────────

  async scheduled(
    _event: ScheduledEvent,
    env:    Env,
    _ctx:   ExecutionContext,
  ): Promise<void> {
    if (!env.SPOTIFY_CLIENT_ID) return;

    const token = await getSpotifyToken(env);
    if (!token) {
      console.error('Cron: failed to get Spotify token');
      return;
    }

    const result = await env.DB.prepare(`
      SELECT mb_id, isrc, popularity, genre
      FROM tracks
      WHERE isrc IS NOT NULL AND popularity IS NULL
      LIMIT 500
    `).all();

    const tracks = (result.results ?? []) as TrackRow[];
    if (tracks.length === 0) {
      console.log('Cron: all ISRC tracks scored — nothing to do');
      return;
    }

    console.log(`Cron: enriching ${tracks.length} tracks`);
    await enrichWithSpotify(tracks, token, env, 4, 2000);
    console.log('Cron: done');
  },
};
