import { parseQuery, exactDurationRange, sanitizeForFts } from './queryParser';

export interface Env {
  DB: D1Database;
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
  t.release_type, t.label, t.track_number
`;

const DIRECT_COLS = `
  id, title, artist, album, duration_ms,
  disambiguation AS version, isrc, release_year, mb_id,
  genre, popularity, popularity_source, search_count,
  release_type, label, track_number
`;

// ── MusicBrainz genre enrichment ──────────────────────────────────────────────

interface TrackRow {
  id:               number;
  mb_id:            string | null;
  isrc:             string | null;
  popularity:       number | null;
  popularity_source: string | null;
  search_count:     number;
  genre:            string | null;
  [key: string]:    unknown;
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
  genre?:       string;
  yearFrom?:    number;
  yearTo?:      number;
  releaseType?: string;
  label?:       string;
}

function buildFilterClauses(f: Filters, alias: string): { sql: string; params: unknown[] } {
  const p     = alias ? `${alias}.` : '';
  const conds: string[]  = [];
  const vals:  unknown[] = [];
  if (f.genre)            { conds.push(`${p}genre LIKE ?`);        vals.push(`%${f.genre}%`); }
  if (f.yearFrom != null) { conds.push(`${p}release_year >= ?`);   vals.push(f.yearFrom); }
  if (f.yearTo   != null) { conds.push(`${p}release_year <= ?`);   vals.push(f.yearTo); }
  if (f.releaseType)      { conds.push(`${p}release_type = ?`);    vals.push(f.releaseType); }
  if (f.label)            { conds.push(`${p}label LIKE ?`);        vals.push(`%${f.label}%`); }
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

    const genre       = url.searchParams.get('genre')        || undefined;
    const yearFromRaw = url.searchParams.get('year_from');
    const yearToRaw   = url.searchParams.get('year_to');
    const yearFrom    = yearFromRaw ? parseInt(yearFromRaw, 10) : undefined;
    const yearTo      = yearToRaw   ? parseInt(yearToRaw,   10) : undefined;
    const releaseType = url.searchParams.get('release_type') || undefined;
    const label       = url.searchParams.get('label')        || undefined;

    const filters: Filters = { genre, yearFrom, yearTo, releaseType, label };
    const hasFilters = !!(genre || yearFrom != null || yearTo != null || releaseType || label);

    const page    = Math.max(1, Math.min(500, parseInt(url.searchParams.get('page')     ?? '1',  10) || 1));
    const perPage = Math.max(1, Math.min(200, parseInt(url.searchParams.get('per_page') ?? '50', 10) || 50));
    const sortRaw = url.searchParams.get('sort') ?? 'relevance';
    const sort    = ['relevance', 'asc', 'desc'].includes(sortRaw) ? sortRaw : 'relevance';
    const offset  = (page - 1) * perPage;

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
        },
      });

    } catch (err) {
      console.error('Search error:', err);
      return json({ error: 'Search failed' }, 500);
    }
  },
};
