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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
          SELECT t.id, t.title, t.artist, t.duration_ms,
                 t.disambiguation, t.isrc, t.release_year, t.mb_id
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
          SELECT t.id, t.title, t.artist, t.duration_ms,
                 t.disambiguation, t.isrc, t.release_year, t.mb_id
          FROM tracks_fts
          JOIN tracks t ON t.id = tracks_fts.rowid
          WHERE tracks_fts MATCH ?
          ORDER BY tracks_fts.rank
          LIMIT 100
        `).bind(ftsQuery);

      } else {
        stmt = env.DB.prepare(`
          SELECT id, title, artist, duration_ms,
                 disambiguation, isrc, release_year, mb_id
          FROM tracks
          WHERE duration_ms BETWEEN ? AND ?
          ORDER BY duration_ms
          LIMIT 100
        `).bind(minDuration, maxDuration);
      }

      const result = await stmt.all();
      return json({
        tracks: result.results ?? [],
        total:  (result.results ?? []).length,
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
