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

// ── Spotify circuit breaker + logging ─────────────────────────────────────────

// Circuit states:
//   'open'      – running normally
//   'half_open' – backoff elapsed, attempting cautious resume
//   'closed'    – backed off, skipping until backoff_until elapses

async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM spotify_config WHERE key = ?')
    .bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    'INSERT INTO spotify_config (key, value, updated) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated'
  ).bind(key, value, Date.now()).run();
}

async function logRun(db: D1Database, source: string, stats: {
  attempted: number; scored: number; notFound: number; err429: number; errOther: number;
}): Promise<void> {
  await db.prepare(
    'INSERT INTO spotify_log (ts, source, attempted, scored, not_found, err_429, err_other) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(Date.now(), source, stats.attempted, stats.scored, stats.notFound, stats.err429, stats.errOther).run();
  // Keep only the last 200 rows
  await db.prepare(
    'DELETE FROM spotify_log WHERE id NOT IN (SELECT id FROM spotify_log ORDER BY ts DESC LIMIT 200)'
  ).run();
}

// Backoff schedule per consecutive 429 offense: 1→10m, 2→30m, 3→1h, 4+→6h
function backoffMs(consecutive: number): number {
  if (consecutive <= 1) return 10 * 60 * 1000;
  if (consecutive === 2) return 30 * 60 * 1000;
  if (consecutive === 3) return 60 * 60 * 1000;
  return 6 * 60 * 60 * 1000;
}

async function checkCircuit(env: Env): Promise<'run' | 'skip'> {
  const state = await getConfig(env.DB, 'circuit_state') ?? 'open';
  if (state === 'open') return 'run';

  const backoffUntilStr = await getConfig(env.DB, 'backoff_until');
  if (backoffUntilStr && Date.now() < parseInt(backoffUntilStr)) {
    const remaining = Math.round((parseInt(backoffUntilStr) - Date.now()) / 60000);
    console.log(`Spotify circuit ${state} — ${remaining}m remaining on backoff, skipping`);
    return 'skip';
  }

  // Backoff elapsed — cautious resume
  await setConfig(env.DB, 'circuit_state', 'half_open');
  console.log('Spotify circuit half_open — backoff elapsed, attempting resume');
  return 'run';
}

async function updateCircuit(env: Env, stats: {
  err429: number; errOther: number; scored: number; attempted: number;
}): Promise<void> {
  if (stats.err429 > 0) {
    const consecutive = parseInt(await getConfig(env.DB, 'consecutive_429s') ?? '0') + 1;
    const wait        = backoffMs(consecutive);
    await setConfig(env.DB, 'consecutive_429s', String(consecutive));
    await setConfig(env.DB, 'backoff_until',    String(Date.now() + wait));
    await setConfig(env.DB, 'circuit_state',    'closed');
    console.error(`Spotify 429 detected — circuit closed. Offense #${consecutive}, backing off ${wait / 60000}min`);
  } else if (stats.attempted > 0 && stats.scored === 0 && stats.errOther >= stats.attempted) {
    // Every single lookup failed — likely auth issue or Spotify outage
    await setConfig(env.DB, 'circuit_state',    'closed');
    await setConfig(env.DB, 'backoff_until',    String(Date.now() + 60 * 60 * 1000)); // 1h
    await setConfig(env.DB, 'consecutive_429s', '0');
    console.error('Spotify all-errors run — circuit closed 1h (possible auth failure or outage)');
  } else {
    // Clean run — open circuit and reset counter
    await setConfig(env.DB, 'circuit_state',    'open');
    await setConfig(env.DB, 'consecutive_429s', '0');
  }
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

interface LookupResult {
  pop:     number | null;  // null = error; -1 = not on Spotify; 0–100 = score
  is429:   boolean;
  isError: boolean;
}

async function spotifyLookup(isrc: string, token: string): Promise<LookupResult> {
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (res.status === 429) { res.body?.cancel(); return { pop: null, is429: true,  isError: false }; }
    if (!res.ok)            { res.body?.cancel(); return { pop: null, is429: false, isError: true  }; }
    const data  = await res.json() as { tracks: { items: Array<{ popularity: number }> } };
    const items = data.tracks?.items;
    if (!items || items.length === 0) return { pop: -1,         is429: false, isError: false };
    return                                   { pop: items[0].popularity ?? 0, is429: false, isError: false };
  } catch {
    return { pop: null, is429: false, isError: true };
  }
}

interface TrackRow {
  mb_id:      string | null;
  isrc:       string | null;
  popularity: number | null;
  genre:      string | null;
  [key: string]: unknown;
}

interface EnrichStats {
  attempted: number;
  scored:    number;
  notFound:  number;
  err429:    number;
  errOther:  number;
}

async function enrichWithSpotify(
  tracks:    TrackRow[],
  token:     string,
  env:       Env,
  batchSize: number,
  delayMs:   number,
): Promise<EnrichStats> {
  const needs  = tracks.filter(t => t.isrc && t.popularity == null);
  const stats: EnrichStats = { attempted: needs.length, scored: 0, notFound: 0, err429: 0, errOther: 0 };

  for (let i = 0; i < needs.length; i += batchSize) {
    const batch = needs.slice(i, i + batchSize);
    await Promise.all(batch.map(async t => {
      const r = await spotifyLookup(t.isrc!, token);
      if (r.is429)   { stats.err429++;  return; }
      if (r.isError) { stats.errOther++; return; }
      if (r.pop === null) return;
      if (r.pop === -1)   { stats.notFound++; t.popularity = -1; }
      else                { stats.scored++;   t.popularity = r.pop; }
      env.DB.prepare('UPDATE tracks SET popularity = ? WHERE mb_id = ?')
        .bind(r.pop, t.mb_id).run().catch(() => {});
    }));

    if (stats.err429 > 0) break; // stop immediately on rate limit

    if (delayMs > 0 && i + batchSize < needs.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return stats;
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

function buildOrderBy(sort: string, fts: boolean): string {
  const p = fts ? 't.' : '';
  if (sort === 'asc')  return `ORDER BY ${p}duration_ms ASC`;
  if (sort === 'desc') return `ORDER BY ${p}duration_ms DESC`;
  return fts
    ? 'ORDER BY COALESCE(t.popularity, -2) DESC, tracks_fts.rank'
    : 'ORDER BY COALESCE(popularity, -2) DESC, duration_ms';
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

    // ── /status — Spotify health check ───────────────────────────────────────
    if (url.pathname === '/status') {
      const [configRows, logRows] = await Promise.all([
        env.DB.prepare('SELECT key, value, updated FROM spotify_config ORDER BY key').all(),
        env.DB.prepare('SELECT * FROM spotify_log ORDER BY ts DESC LIMIT 50').all(),
      ]);
      const config: Record<string, string> = {};
      for (const row of (configRows.results ?? []) as { key: string; value: string }[]) {
        config[row.key] = row.value;
      }
      const backoffUntil = config['backoff_until'] ? parseInt(config['backoff_until']) : null;
      const backingOff   = backoffUntil != null && Date.now() < backoffUntil;
      return json({
        circuit:              config['circuit_state'] ?? 'open',
        consecutive429s:      parseInt(config['consecutive_429s'] ?? '0'),
        backingOff,
        backoffUntil:         backoffUntil ? new Date(backoffUntil).toISOString() : null,
        backoffRemainingMin:  backingOff ? Math.round((backoffUntil! - Date.now()) / 60000) : 0,
        recentRuns:           logRows.results ?? [],
      });
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

      // ── Inline Spotify enrichment — circuit breaker aware ─────────────────
      if ((hasKeywords || hasFilters) && tracks.length > 0 && env.SPOTIFY_CLIENT_ID) {
        const state       = await getConfig(env.DB, 'circuit_state') ?? 'open';
        const backoffStr  = await getConfig(env.DB, 'backoff_until');
        const circuitOpen = state === 'open' ||
          (state !== 'open' && backoffStr != null && Date.now() >= parseInt(backoffStr));

        if (circuitOpen) {
          const token = await withTimeout(getSpotifyToken(env), 800);
          if (token) {
            const inline = tracks.filter(t => t.isrc && t.popularity == null).slice(0, 8);
            if (inline.length > 0) {
              const stats = await withTimeout(enrichWithSpotify(inline, token, env, 4, 0), 700) as EnrichStats | null;
              if (stats) {
                ctx.waitUntil(logRun(env.DB, 'inline', stats));
                if (stats.err429 > 0) ctx.waitUntil(updateCircuit(env, stats));
              }
            }
            if (sort === 'relevance') {
              tracks.sort((a, b) => (b.popularity ?? -2) - (a.popularity ?? -2));
            }
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
        },
      });

    } catch (err) {
      console.error('Search error:', err);
      return json({ error: 'Search failed' }, 500);
    }
  },

  // ── Cron: background Spotify enrichment ──────────────────────────────────────

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.SPOTIFY_CLIENT_ID) return;

    const decision = await checkCircuit(env);
    if (decision === 'skip') return;

    const token = await getSpotifyToken(env);
    if (!token) {
      console.error('Cron: failed to get Spotify token');
      const stats = { attempted: 0, scored: 0, notFound: 0, err429: 0, errOther: 1 };
      await logRun(env.DB, 'cron', stats);
      await updateCircuit(env, { ...stats, attempted: 1 });
      return;
    }

    const result = await env.DB.prepare(`
      SELECT mb_id, isrc, popularity, genre
      FROM tracks
      WHERE isrc IS NOT NULL AND popularity IS NULL
      LIMIT 1000
    `).all();

    const tracks = (result.results ?? []) as TrackRow[];
    if (tracks.length === 0) {
      console.log('Cron: all ISRC tracks scored — nothing to do');
      return;
    }

    console.log(`Cron: enriching ${tracks.length} tracks`);
    const stats = await enrichWithSpotify(tracks, token, env, 4, 1000);
    await logRun(env.DB, 'cron', stats);
    await updateCircuit(env, stats);
    console.log(`Cron: scored ${stats.scored} · not found ${stats.notFound} · 429s ${stats.err429} · errors ${stats.errOther}`);
  },
};
