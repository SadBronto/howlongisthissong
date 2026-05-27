import { parseQuery, exactDurationRange, sanitizeForFts } from './queryParser';

export interface Env {
  DB: D1Database;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const USER_AGENT = 'HowLongIsThisSong/1.0 (nrctrivia@gmail.com)';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

// Columns returned in every response
// disambiguation aliased as version to match the Track interface
const JOINED_COLS = `
  t.id, t.title, t.artist, t.album, t.duration_ms,
  t.disambiguation AS version, t.isrc, t.release_year, t.mb_id,
  t.genre, t.listen_count
`;

const DIRECT_COLS = `
  id, title, artist, album, duration_ms,
  disambiguation AS version, isrc, release_year, mb_id,
  genre, listen_count
`;

// ── Background enrichment ─────────────────────────────────────────────────────
// Runs after the response is sent via ctx.waitUntil().
// Fetches listen_count from ListenBrainz and genre from MusicBrainz
// for tracks that are missing either value. Max 5 tracks per search call
// to stay comfortably within rate limits.

interface TrackRow {
  mb_id:        string | null;
  listen_count: number | null;
  genre:        string | null;
}

async function enrichTracks(tracks: TrackRow[], env: Env): Promise<void> {
  const toEnrich = tracks
    .filter(t => t.mb_id && (t.listen_count == null || t.genre == null))
    .slice(0, 5);

  for (const track of toEnrich) {
    const mbid = track.mb_id!;

    // 1. ListenBrainz — listen count
    if (track.listen_count == null) {
      try {
        const res = await fetch(
          `https://api.listenbrainz.org/1/metadata/recording/?recording_mbid=${mbid}&inc=stats`,
          { headers: { 'User-Agent': USER_AGENT } }
        );
        if (res.ok) {
          const data = await res.json() as Record<string, any>;
          const entry = data[mbid];
          // ListenBrainz may nest it differently depending on API version
          const count =
            entry?.stats?.total_listen_count ??
            entry?.metadata?.listen_count ??
            entry?.listen_count ??
            null;
          if (typeof count === 'number') {
            await env.DB.prepare(
              'UPDATE tracks SET listen_count = ? WHERE mb_id = ?'
            ).bind(count, mbid).run();
          }
        }
      } catch {
        // Best-effort — silently skip on network error
      }
    }

    // 2. MusicBrainz — genre/tags
    // Rate limit: 1 req/sec without auth; wait before each call
    if (track.genre == null) {
      await new Promise(r => setTimeout(r, 1100));
      try {
        const res = await fetch(
          `https://musicbrainz.org/ws/2/recording/${mbid}?inc=tags&fmt=json`,
          { headers: { 'User-Agent': USER_AGENT } }
        );
        if (res.ok) {
          const data = await res.json() as {
            tags?: Array<{ count: number; name: string }>;
          };
          const topTag = (data.tags ?? [])
            .sort((a, b) => b.count - a.count)
            .find(t => t.count > 0)?.name ?? null;
          if (topTag) {
            await env.DB.prepare(
              'UPDATE tracks SET genre = ? WHERE mb_id = ?'
            ).bind(topTag, mbid).run();
          }
        }
      } catch {
        // Best-effort — silently skip on network error
      }
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env:     Env,
    ctx:     ExecutionContext
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
          ORDER BY tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery, minDuration, maxDuration);

      } else if (hasKeywords) {
        const ftsQuery = sanitizeForFts(parsed.keywords!);
        stmt = env.DB.prepare(`
          SELECT ${JOINED_COLS}
          FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?
          ORDER BY tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery);

      } else {
        // Duration-only: sort by listen_count so popular songs surface first.
        // Unscored tracks (NULL) fall to the bottom via COALESCE trick.
        stmt = env.DB.prepare(`
          SELECT ${DIRECT_COLS}
          FROM tracks
          WHERE duration_ms BETWEEN ? AND ?
          ORDER BY COALESCE(listen_count, -1) DESC, duration_ms
          LIMIT 100
        `).bind(minDuration, maxDuration);
      }

      const result = await stmt.all();
      const tracks = (result.results ?? []) as TrackRow[];

      // Fire enrichment in the background — zero impact on response latency
      ctx.waitUntil(enrichTracks(tracks, env));

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
};
