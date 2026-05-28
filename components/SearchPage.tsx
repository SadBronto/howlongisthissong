'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import { parseQuery } from '@/lib/queryParser';
import type { SearchResult } from '@/lib/types';

const EXAMPLES = [
  { label: '3:16',                  hint: 'exact duration' },
  { label: '3:16.423',              hint: 'millisecond precision' },
  { label: '>10:00',                hint: 'longer than 10 minutes' },
  { label: 'love 4:20',             hint: 'keyword + time' },
  { label: 'between 3:00 and 4:00', hint: 'range' },
  { label: 'bohemian rhapsody',     hint: 'by title' },
  { label: 'pink floyd',            hint: 'by artist' },
];

type DurationMode = 'exact' | 'range';

const RELEASE_TYPES = ['', 'Album', 'Single', 'EP', 'Broadcast', 'Other'] as const;
const RELEASE_TYPE_LABELS: Record<string, string> = {
  '': 'Any type', Album: 'Album', Single: 'Single',
  EP: 'EP', Broadcast: 'Broadcast', Other: 'Other',
};

const DECADES = [
  { label: '60s', from: '1960', to: '1969' },
  { label: '70s', from: '1970', to: '1979' },
  { label: '80s', from: '1980', to: '1989' },
  { label: '90s', from: '1990', to: '1999' },
  { label: '00s', from: '2000', to: '2009' },
  { label: '10s', from: '2010', to: '2019' },
  { label: '20s', from: '2020', to: '2029' },
];

// ── Filter state type ─────────────────────────────────────────────────────────
interface Filters {
  genre:       string;
  yearFrom:    string;
  yearTo:      string;
  releaseType: string;
  label:       string;
}
const EMPTY_FILTERS: Filters = { genre: '', yearFrom: '', yearTo: '', releaseType: '', label: '' };

function filtersFromParams(sp: URLSearchParams): Filters {
  return {
    genre:       sp.get('genre')        ?? '',
    yearFrom:    sp.get('year_from')    ?? '',
    yearTo:      sp.get('year_to')      ?? '',
    releaseType: sp.get('release_type') ?? '',
    label:       sp.get('label')        ?? '',
  };
}

function buildUrl(q: string, f: Filters, pg: number, pp: number, s: string): string {
  const p = new URLSearchParams();
  if (q)             p.set('q',            q);
  if (f.genre)       p.set('genre',        f.genre);
  if (f.yearFrom)    p.set('year_from',    f.yearFrom);
  if (f.yearTo)      p.set('year_to',      f.yearTo);
  if (f.releaseType) p.set('release_type', f.releaseType);
  if (f.label)       p.set('label',        f.label);
  if (pg > 1)        p.set('page',         String(pg));
  if (pp !== 50)     p.set('per_page',     String(pp));
  if (s !== 'relevance') p.set('sort',     s);
  const qs = p.toString();
  return qs ? `/?${qs}` : '/';
}

function activeCount(f: Filters): number {
  return [f.genre, f.yearFrom, f.yearTo, f.releaseType, f.label].filter(Boolean).length;
}

// ── Duration normalizer ───────────────────────────────────────────────────────
/** "2" → "2:00", "10" → "10:00"; leaves "3:16", "3:16.423", "" unchanged. */
function normalizeDuration(s: string): string {
  const t = s.trim();
  if (/^\d{1,2}$/.test(t)) return `${t}:00`;
  return t;
}

// ── Shared input style ────────────────────────────────────────────────────────
const ADV_INPUT = [
  'border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900',
  'placeholder-gray-400 bg-white focus:outline-none focus:border-blue-400 w-full',
].join(' ');

// ── Component ─────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // ── Core search state ──────────────────────────────────────────────────────
  const [query,     setQuery]     = useState(searchParams.get('q') ?? '');
  const [filters,   setFilters]   = useState<Filters>(() => filtersFromParams(searchParams));
  const [tolerance, setTolerance] = useState(0);
  const [results,   setResults]   = useState<SearchResult | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // ── Pagination + sort state ────────────────────────────────────────────────
  const [page, setPage] = useState(() =>
    Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  );
  const [perPage, setPerPage] = useState(() => {
    const v = parseInt(searchParams.get('per_page') ?? '50', 10) || 50;
    return [25, 50, 100, 200].includes(v) ? v : 50;
  });
  const [sort, setSort] = useState(() => {
    const s = searchParams.get('sort') ?? 'relevance';
    return ['relevance', 'asc', 'desc'].includes(s) ? s : 'relevance';
  });

  // ── Advanced form state ────────────────────────────────────────────────────
  const [advExpanded, setAdvExpanded] = useState(false);
  const [advSummary,  setAdvSummary]  = useState<string[]>([]);
  const [advTitle,    setAdvTitle]    = useState('');
  const [advArtist,   setAdvArtist]   = useState('');
  const [advDurMode,  setAdvDurMode]  = useState<DurationMode>('exact');
  const [advExact,    setAdvExact]    = useState('');
  const [advFrom,     setAdvFrom]     = useState('');
  const [advTo,       setAdvTo]       = useState('');
  const [advGenre,    setAdvGenre]    = useState('');
  const [advYearFrom, setAdvYearFrom] = useState('');
  const [advYearTo,   setAdvYearTo]   = useState('');
  const [advRelType,  setAdvRelType]  = useState('');
  const [advLabel,    setAdvLabel]    = useState('');

  const abortRef = useRef<AbortController | null>(null);

  // ── Core fetch ─────────────────────────────────────────────────────────────
  const doSearch = useCallback(async (
    q: string, tol: number, f: Filters,
    pg = 1, pp = 50, s = 'relevance',
  ) => {
    const hasF = activeCount(f) > 0;
    if (!q.trim() && !hasF) { setResults(null); setError(null); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const base = process.env.NEXT_PUBLIC_WORKER_URL
        ? `${process.env.NEXT_PUBLIC_WORKER_URL}/search`
        : '/api/search';

      const params = new URLSearchParams();
      if (q.trim())       params.set('q',            q.trim());
      if (tol > 0)        params.set('tolerance',     String(tol));
      if (f.genre)        params.set('genre',         f.genre);
      if (f.yearFrom)     params.set('year_from',     f.yearFrom);
      if (f.yearTo)       params.set('year_to',       f.yearTo);
      if (f.releaseType)  params.set('release_type',  f.releaseType);
      if (f.label)        params.set('label',         f.label);
      params.set('page',     String(pg));
      params.set('per_page', String(pp));
      if (s !== 'relevance') params.set('sort', s);

      const res = await fetch(`${base}?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SearchResult = await res.json();
      if (!controller.signal.aborted) setResults(data);
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError('Search failed. Check your connection and try again.');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  // ── Explicit submit (main box) ─────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q && activeCount(filters) === 0) return;
    setTolerance(0);
    setPage(1);
    doSearch(q, 0, filters, 1, perPage, sort);
    router.replace(buildUrl(q, filters, 1, perPage, sort), { scroll: false });
  }, [query, filters, perPage, sort, doSearch, router]);

  // ── Example chip ──────────────────────────────────────────────────────────
  const handleExampleClick = useCallback((label: string) => {
    setQuery(label);
    setFilters(EMPTY_FILTERS);
    setTolerance(0);
    setPage(1);
    doSearch(label, 0, EMPTY_FILTERS, 1, perPage, sort);
    router.replace(`/?q=${encodeURIComponent(label)}`, { scroll: false });
  }, [perPage, sort, doSearch, router]);

  // ── Clear ─────────────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setQuery('');
    setFilters(EMPTY_FILTERS);
    setResults(null);
    setError(null);
    setTolerance(0);
    setPage(1);
    setAdvSummary([]);
    router.replace('/', { scroll: false });
  }, [router]);

  // ── Tolerance slider ──────────────────────────────────────────────────────
  const handleToleranceChange = (ms: number) => {
    setTolerance(ms);
    setPage(1);
    doSearch(query, ms, filters, 1, perPage, sort);
  };

  // ── Pagination + sort handlers ─────────────────────────────────────────────
  const handlePageChange = useCallback((pg: number) => {
    setPage(pg);
    doSearch(query, tolerance, filters, pg, perPage, sort);
    router.replace(buildUrl(query, filters, pg, perPage, sort), { scroll: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [query, tolerance, filters, perPage, sort, doSearch, router]);

  const handlePerPageChange = useCallback((pp: number) => {
    setPerPage(pp);
    setPage(1);
    doSearch(query, tolerance, filters, 1, pp, sort);
    router.replace(buildUrl(query, filters, 1, pp, sort), { scroll: false });
  }, [query, tolerance, filters, sort, doSearch, router]);

  const handleSortChange = useCallback((s: string) => {
    setSort(s);
    setPage(1);
    doSearch(query, tolerance, filters, 1, perPage, s);
    router.replace(buildUrl(query, filters, 1, perPage, s), { scroll: false });
  }, [query, tolerance, filters, perPage, doSearch, router]);

  // ── Advanced form compile + submit ─────────────────────────────────────────
  const compileAdvancedQuery = (): string => {
    const parts: string[] = [];
    const kw = [advTitle.trim(), advArtist.trim()].filter(Boolean).join(' ');
    if (kw) parts.push(kw);
    if (advDurMode === 'exact' && advExact.trim()) {
      parts.push(normalizeDuration(advExact));
    } else if (advDurMode === 'range') {
      const from = normalizeDuration(advFrom);
      const to   = normalizeDuration(advTo);
      if (from && to) parts.push(`${from} to ${to}`);
      else if (from)  parts.push(`>${from}`);
      else if (to)    parts.push(`<${to}`);
    }
    return parts.join(' ');
  };

  const handleAdvancedSubmit = useCallback(() => {
    const compiled   = compileAdvancedQuery();
    const newFilters: Filters = {
      genre:       advGenre,
      yearFrom:    advYearFrom,
      yearTo:      advYearTo,
      releaseType: advRelType,
      label:       advLabel,
    };
    if (!compiled && activeCount(newFilters) === 0) return;
    setQuery(compiled);
    setFilters(newFilters);
    setTolerance(0);
    setPage(1);
    doSearch(compiled, 0, newFilters, 1, perPage, sort);
    router.replace(buildUrl(compiled, newFilters, 1, perPage, sort), { scroll: false });

    // Collapse panel and build field summary
    setAdvExpanded(false);
    const summary: string[] = [];
    if (advTitle.trim())  summary.push('Title');
    if (advArtist.trim()) summary.push('Artist');
    if (advDurMode === 'exact' ? advExact.trim() : (advFrom.trim() || advTo.trim()))
      summary.push('Duration');
    if (advGenre)    summary.push('Genre');
    if (advYearFrom || advYearTo) summary.push('Year');
    if (advRelType)  summary.push('Type');
    if (advLabel)    summary.push('Label');
    setAdvSummary(summary);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advTitle, advArtist, advDurMode, advExact, advFrom, advTo,
      advGenre, advYearFrom, advYearTo, advRelType, advLabel,
      perPage, sort, doSearch, router]);

  // Sync advanced filter fields from main filter state when advanced opens
  useEffect(() => {
    if (advExpanded) {
      setAdvGenre(filters.genre);
      setAdvYearFrom(filters.yearFrom);
      setAdvYearTo(filters.yearTo);
      setAdvRelType(filters.releaseType);
      setAdvLabel(filters.label);
    }
  }, [advExpanded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Initial search from URL ────────────────────────────────────────────────
  useEffect(() => {
    const q  = searchParams.get('q') ?? '';
    const f  = filtersFromParams(searchParams);
    const pg = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
    const pp = (() => {
      const v = parseInt(searchParams.get('per_page') ?? '50', 10) || 50;
      return [25, 50, 100, 200].includes(v) ? v : 50;
    })();
    const s = (() => {
      const sv = searchParams.get('sort') ?? 'relevance';
      return ['relevance', 'asc', 'desc'].includes(sv) ? sv : 'relevance';
    })();
    if (q || activeCount(f) > 0) doSearch(q, 0, f, pg, pp, s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasQuery    = !!query.trim();
  const hasFilters  = activeCount(filters) > 0;
  const hasResults  = results !== null || loading;
  const parsed      = parseQuery(query);
  const isExactTime = parsed.exactDuration != null && !parsed.keywords;
  const numActive   = activeCount(filters);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className={`flex flex-col items-center transition-all duration-200 ${
        hasQuery || hasFilters ? 'pt-5 pb-3' : 'pt-20 sm:pt-28 pb-8'
      }`}>
        <a
          href="/"
          onClick={(e) => { e.preventDefault(); handleClear(); setAdvExpanded(false); }}
          className="no-underline"
        >
          <h1 className={`font-bold text-gray-900 tracking-tight transition-all duration-200 select-none ${
            hasQuery || hasFilters ? 'text-xl mb-3' : 'text-3xl sm:text-5xl mb-4'
          }`}>
            <span className="text-blue-600">HowLong</span>IsThisSong
            <span className="text-gray-300">.com</span>
          </h1>
        </a>

        {!hasQuery && !hasFilters && (
          <p className="text-gray-400 text-sm sm:text-base mb-6 text-center px-4">
            The internet&rsquo;s searchable song-duration database.
          </p>
        )}

        <div className={`w-full px-4 transition-all duration-200 ${hasQuery || hasFilters ? 'max-w-2xl' : 'max-w-xl'}`}>
          {/* Main search bar */}
          <SearchBar
            value={query}
            onChange={(v) => setQuery(v)}
            onSubmit={handleSubmit}
            onClear={handleClear}
            loading={loading}
          />

          {/* Advanced search toggle */}
          <div className="mt-2">
            <button
              onClick={() => setAdvExpanded(e => !e)}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-500 transition-colors pl-1 select-none"
            >
              <svg
                className={`h-3 w-3 transition-transform duration-150 ${advExpanded ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
              Advanced search
              {numActive > 0 && (
                <span className="ml-0.5 bg-blue-100 text-blue-600 text-xs font-semibold px-1.5 py-0.5 rounded-full">
                  {numActive}
                </span>
              )}
              {!advExpanded && advSummary.length > 0 && (
                <span className="ml-1 font-semibold text-gray-600">
                  {advSummary.join(', ')}
                </span>
              )}
            </button>

            {advExpanded && (
              <div className="mt-2 p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-4">

                {/* Title + Artist */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Title</label>
                    <input value={advTitle} onChange={e => setAdvTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Bohemian Rhapsody" className={ADV_INPUT} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Artist</label>
                    <input value={advArtist} onChange={e => setAdvArtist(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Queen" className={ADV_INPUT} />
                  </div>
                </div>

                {/* Genre + Label */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Genre</label>
                    <input value={advGenre} onChange={e => setAdvGenre(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="rock, jazz, hip-hop…" className={ADV_INPUT} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Label</label>
                    <input value={advLabel} onChange={e => setAdvLabel(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Warner, Columbia…" className={ADV_INPUT} />
                  </div>
                </div>

                {/* Year range */}
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Year</label>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {DECADES.map(d => {
                      const active = advYearFrom === d.from && advYearTo === d.to;
                      return (
                        <button
                          key={d.label}
                          onClick={() => {
                            if (active) { setAdvYearFrom(''); setAdvYearTo(''); }
                            else        { setAdvYearFrom(d.from); setAdvYearTo(d.to); }
                          }}
                          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                            active
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                          }`}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <input value={advYearFrom} onChange={e => setAdvYearFrom(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="From" className={`${ADV_INPUT} w-24`} maxLength={4} />
                    <span className="text-xs text-gray-400 flex-shrink-0">to</span>
                    <input value={advYearTo} onChange={e => setAdvYearTo(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="To" className={`${ADV_INPUT} w-24`} maxLength={4} />
                  </div>
                </div>

                {/* Release type */}
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-1 block">Release type</label>
                  <select
                    value={advRelType}
                    onChange={e => setAdvRelType(e.target.value)}
                    className={`${ADV_INPUT} w-auto pr-8 cursor-pointer`}
                  >
                    {RELEASE_TYPES.map(rt => (
                      <option key={rt} value={rt}>{RELEASE_TYPE_LABELS[rt]}</option>
                    ))}
                  </select>
                </div>

                {/* Duration */}
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Duration</label>
                  <div className="flex rounded-lg border border-gray-200 w-fit mb-3 text-xs overflow-hidden">
                    {(['exact', 'range'] as const).map(mode => (
                      <button key={mode} onClick={() => setAdvDurMode(mode)}
                        className={`px-3 py-1.5 capitalize transition-colors ${
                          advDurMode === mode
                            ? 'bg-blue-600 text-white font-medium'
                            : 'bg-white text-gray-500 hover:bg-gray-100'
                        }`}
                      >{mode}</button>
                    ))}
                  </div>
                  {advDurMode === 'exact' ? (
                    <input value={advExact} onChange={e => setAdvExact(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="3:16 or 3:16.423"
                      className={`${ADV_INPUT} w-36 font-mono`} />
                  ) : (
                    <div className="flex items-center gap-2">
                      <input value={advFrom} onChange={e => setAdvFrom(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="3:00" className={`${ADV_INPUT} w-28 font-mono`} />
                      <span className="text-xs text-gray-400 flex-shrink-0">to</span>
                      <input value={advTo} onChange={e => setAdvTo(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="4:00" className={`${ADV_INPUT} w-28 font-mono`} />
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleAdvancedSubmit}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    Search
                  </button>
                  {(advGenre || advYearFrom || advYearTo || advRelType || advLabel ||
                    advTitle || advArtist || advExact || advFrom || advTo) && (
                    <button
                      onClick={() => {
                        setAdvGenre(''); setAdvYearFrom(''); setAdvYearTo('');
                        setAdvRelType(''); setAdvLabel('');
                        setAdvTitle(''); setAdvArtist('');
                        setAdvExact(''); setAdvFrom(''); setAdvTo('');
                        setAdvSummary([]);
                      }}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Active filter chips (shown collapsed too) */}
        {numActive > 0 && !advExpanded && (
          <div className="flex flex-wrap gap-1.5 mt-2 px-4 max-w-2xl w-full">
            {filters.genre && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                genre: {filters.genre}
              </span>
            )}
            {(filters.yearFrom || filters.yearTo) && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                {filters.yearFrom && filters.yearTo
                  ? `${filters.yearFrom}–${filters.yearTo}`
                  : filters.yearFrom ? `from ${filters.yearFrom}` : `to ${filters.yearTo}`}
              </span>
            )}
            {filters.releaseType && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                {filters.releaseType}
              </span>
            )}
            {filters.label && (
              <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
                label: {filters.label}
              </span>
            )}
            <button
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setAdvSummary([]);
                setPage(1);
                if (query.trim()) doSearch(query, 0, EMPTY_FILTERS, 1, perPage, sort);
                else handleClear();
              }}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors px-1"
            >
              ✕ clear all
            </button>
          </div>
        )}

        {/* Example chips — only on homepage */}
        {!hasQuery && !hasFilters && (
          <div className="flex flex-wrap gap-2 mt-4 px-4 justify-center max-w-xl">
            {EXAMPLES.map((ex) => (
              <button key={ex.label} onClick={() => handleExampleClick(ex.label)} title={ex.hint}
                className="text-xs bg-gray-100 hover:bg-blue-50 hover:text-blue-700 text-gray-500 px-3 py-1.5 rounded-full transition-colors font-mono">
                {ex.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 pb-20">
        {error && (
          <p className="text-red-500 text-sm text-center mt-8 bg-red-50 py-3 px-4 rounded-lg">{error}</p>
        )}

        {(hasQuery || hasFilters) && !hasResults && !error && (
          <p className="text-center text-sm text-gray-400 mt-10">
            Press <kbd className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 border border-gray-200 rounded">Enter</kbd>{' '}
            or click <strong className="font-medium text-gray-500">Search</strong> to find songs.
          </p>
        )}

        {hasResults && !error && (
          <SearchResults
            results={results}
            loading={loading}
            query={query}
            tolerance={tolerance}
            isExactTime={isExactTime}
            onToleranceChange={handleToleranceChange}
            page={page}
            perPage={perPage}
            sort={sort}
            onPageChange={handlePageChange}
            onPerPageChange={handlePerPageChange}
            onSortChange={handleSortChange}
          />
        )}

        {!hasQuery && !hasFilters && !hasResults && (
          <div className="mt-16 text-center text-sm text-gray-300">
            <p>Search by exact time, range, title, artist, or any combination.</p>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-300 py-4 border-t border-gray-100">
        Track data from{' '}
        <a href="https://musicbrainz.org" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">MusicBrainz</a>
        {' '}· Popularity from{' '}
        <a href="https://www.last.fm" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">Last.fm</a>
        {' '}&amp;{' '}
        <a href="https://listenbrainz.org" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">ListenBrainz</a>
      </footer>
    </div>
  );
}
