import { parseQuery, exactDurationRange, sanitizeForFts } from './queryParser';

export interface Env {
  DB: D1Database;
  SPOTIFY_CLIENT_ID:     string;  // set via: wrangler secret put SPOTIFY_CLIENT_ID
  SPOTIFY_CLIENT_SECRET: string;  // set via: wrangler secret put SPOTIFY_CLIENT_SECRET
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

// Columns returned in every response.
// disambiguation aliased as version to match the Track TypeScript interface.
const JOINED_COLS = `
  t.id, t.title, t.artist, t.album, t.duration_ms,
  t.disambiguation AS version, t.isrc, t.release_year, t.mb_id,
  t.genre, t.popularity
`;

const DIRECT_COLS = `
  id, title, artist, album, duration_ms,
  disambiguation AS version, isrc, release_year, mb_id,
  genre, popularity
`;

// ── Utility ───────────────────────────────────────────────────────────────────

/** Race a promise against a hard timeout; returns null on timeout. */
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

/**
 * Look up a single ISRC on Spotify.
 * Returns: 0–100 (popularity score), -1 (not on Spotify), null (API error / rate limited).
 */
async function spotifyLookup(isrc: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (res.status === 429) return null;   // rate limited — skip silently
    if (!res.ok)            return null;
    const data  = await res.json() as { tracks: { items: Array<{ popularity: number }> } };
    const items = data.tracks?.items;
    if (!items || items.length === 0) return -1; // not on Spotify
    return items[0].popularity;                  // 0–100
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

/**
 * Enrich tracks with Spotify popularity scores in parallel batches.
 * Mutates track objects in-place AND writes to D1 (best-effort).
 *
 * @param batchSize  parallel requests per batch (10 is polite)
 * @param delayMs    pause between batches in ms (0 for sync, 2000 for cron)
 */
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
        // Fire-and-forget D1 write — don't block on it
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

/**
 * Fetches genre/tags from MusicBrainz for tracks missing a genre.
 * Rate-limited to 1 req/sec as required by MusicBrainz.
 * Runs in waitUntil — never blocks the search response.
 */
async function enrichGenre(tracks: TrackRow[], env: Env): Promise<void> {
  const needs = tracks.filter(t => t.mb_id && t.genre == null).slice(0, 5);

  for (const track of needs) {
    await new Promise(r => setTimeout(r, 1100)); // respect 1 req/sec
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

// ── Handlers ──────────────────────────────────────────────────────────────────

export default {

  // ── Search endpoint ─────────────────────────────────────────────────────────

  async fetch(
    request: Request,
    env:     Env,
    ctx:     ExecutionContext,
  ): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    const url       = new URL(request.url);
    const q         = url.searchParams.get('q') ?? '';
    const tolerance = parseInt(url.searchParams.get('tolerance') ?? '0', 10) || 0;

    if (url.pathname !== '/search') return json({ error: 'Not found' }, 404);
    if (!q.trim()) return json({ tracks: [], total: 0 });

    const parsed = parseQuery(q);
    if (!parsed.keywords && parsed.exactDuration == null && parsed.minDuration == null) {
      return json({ tracks: [], total: 0 });
    }

    let minDuration: number | null = null;
    let maxDuration: number | null = null;

    if (parsed.exactDuration != null) {
      [minDuration, maxDuration] = exactDurationRange(parsed.exactDuration, tolerance / 1000);
    } else if (parsed.minDuration != null) {
      minDuration = parsed.minDuration;
      maxDuration = parsed.maxDuration ?? null;
    }

    const hasDuration = minDuration != null && maxDuration != null;
    const hasKeywords = !!parsed.keywords;

    try {
      let stmt: D1PreparedStatement;

      if (hasKeywords && hasDuration) {
        const ftsQuery = sanitizeForFts(parsed.keywords!);
        stmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?
            AND t.duration_ms BETWEEN ? AND ?
          ORDER BY COALESCE(t.popularity, -2) DESC, tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery, minDuration, maxDuration);

      } else if (hasKeywords) {
        const ftsQuery = sanitizeForFts(parsed.keywords!);
        stmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?
          ORDER BY COALESCE(t.popularity, -2) DESC, tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery);

      } else {
        // Duration-only: popularity DESC, unscored tracks at the bottom
        stmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS}
          FROM tracks
          WHERE duration_ms BETWEEN ? AND ?
          ORDER BY COALESCE(popularity, -2) DESC, duration_ms
          LIMIT 100
        `).bind(minDuration, maxDuration);
      }

      const result = await stmt.all();
      const tracks = (result.results ?? []) as TrackRow[];

      // ── Sync Spotify enrichment for keyword searches ────────────────────────
      // We look up the returned tracks before sending the response so that
      // popular songs sort to the top on the very first search.
      // Budget: 900ms (user-acceptable latency per their preference).
      if (hasKeywords && tracks.length > 0 && env.SPOTIFY_CLIENT_ID) {
        const token = await withTimeout(getSpotifyToken(env), 400);
        if (token) {
          await withTimeout(
            enrichWithSpotify(tracks, token, env, 10, 0),
            900,
          );
          // Re-sort after enrichment: popularity DESC, -1 (not on Spotify) last
          tracks.sort((a, b) =>
            (b.popularity ?? -2) - (a.popularity ?? -2)
          );
        }
      }

      // ── Background genre enrichment (MusicBrainz, 1 req/sec) ───────────────
      ctx.waitUntil(enrichGenre(tracks, env));

      return json({
        tracks,
        total: tracks.length,
        parsed: {
          keywords:      parsed.keywords,
          exactDuration: parsed.exactDuration,
          minDuration:   parsed.minDuration,
          maxDuration:   parsed.maxDuration,
        },
      });

    } catch (err) {
      console.error('Search error:', err);
      return json({ error: 'Search failed' }, 500);
    }
  },

  // ── Cron: background Spotify enrichment ────────────────────────────────────
  // Runs every 5 minutes, works through the backlog of unscored tracks.
  // Batches of 10 with 2s cooldowns — polite to Spotify's rate limits.
  // At this rate: ~1,200 tracks/hour, ~28,800/day.
  // Full enrichment of 5.7M ISRC tracks: ~200 days.

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

    // Grab the next 200 unscored tracks that have ISRCs
    const result = await env.DB.prepare(`
      SELECT mb_id, isrc, popularity, genre
      FROM tracks
      WHERE isrc IS NOT NULL AND popularity IS NULL
      LIMIT 200
    `).all();

    const tracks = (result.results ?? []) as TrackRow[];
    if (tracks.length === 0) {
      console.log('Cron: all ISRC tracks scored — nothing to do');
      return;
    }

    console.log(`Cron: enriching ${tracks.length} tracks`);
    // 2s between batches keeps us well under Spotify's rate limit
    await enrichWithSpotify(tracks, token, env, 10, 2000);
    console.log('Cron: done');
  },
};
