'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import { parseQuery } from '@/lib/queryParser';
import type { SearchResult } from '@/lib/types';
import {
  type Filters, EMPTY_FILTERS, filtersFromParams, buildUrl,
  activeCount, summaryFromFilters, FilterChip, normalizeDuration,
} from './searchFilters';
import { TOP_LANGUAGES, TOP_LANG_CODES, ISO_LANGUAGE_NAMES } from './languages';

interface Example {
  label:     string;            // chip text
  hint:      string;            // tooltip
  query?:    string;            // typed into the main box (defaults to label)
  filters?:  Partial<Filters>;  // advanced filters applied on click
  featured?: boolean;           // rendered as the big standout "wild" example
}

const EXAMPLES: Example[] = [
  { label: '3:16',                  hint: 'exact duration' },
  { label: '3:16.423',              hint: 'millisecond precision' },
  { label: '>10:00',                hint: 'longer than 10 minutes' },
  { label: 'love 4:20',             hint: 'keyword + time' },
  { label: 'between 3:00 and 4:00', hint: 'range' },
  { label: 'con*',                  hint: 'starts with' },
  { label: 'pink floyd',            hint: 'by artist' },
  {
    label:    'rock songs from the 2000s between 100 and 200 BPM that are under 3 minutes and have “duck” in the title',
    hint:     'A keyword + filters combo — runs through the fast text index',
    query:    'duck <3:00',
    filters:  { genre: 'rock', yearFrom: '2000', yearTo: '2009', bpmMin: '100', bpmMax: '200' },
    featured: true,
  },
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
  const [query,       setQuery]       = useState(searchParams.get('q') ?? '');
  const [filters,     setFilters]     = useState<Filters>(() => filtersFromParams(searchParams));
  const [tolerance,   setTolerance]   = useState(0);
  const [artistsMode, setArtistsMode] = useState(() => searchParams.get('mode') === 'artists');
  const [results,     setResults]     = useState<SearchResult | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [slowSearch,  setSlowSearch]  = useState(false);  // true once a search has run >5s
  const [searchCount, setSearchCount] = useState<number | null>(null);  // footer fun-fact tally

  // Fetch the running search tally once on mount for the footer curiosity.
  useEffect(() => {
    let alive = true;
    fetch(`${process.env.NEXT_PUBLIC_WORKER_URL ?? ''}/stats`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d && typeof d.total_searches === 'number') setSearchCount(d.total_searches); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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
  const [advTitle,     setAdvTitle]     = useState('');
  const [advArtist,    setAdvArtist]    = useState('');
  const [advTitleMode, setAdvTitleMode] = useState('');   // '' = contains | 'startswith'
  const [advArtistMode,setAdvArtistMode]= useState('');
  const [advDurMode,  setAdvDurMode]  = useState<DurationMode>('exact');
  const [advExact,    setAdvExact]    = useState('');
  const [advFrom,     setAdvFrom]     = useState('');
  const [advTo,       setAdvTo]       = useState('');
  const [advGenre,    setAdvGenre]    = useState('');
  const [advYearFrom, setAdvYearFrom] = useState('');
  const [advYearTo,   setAdvYearTo]   = useState('');
  const [advRelType,  setAdvRelType]  = useState('');
  const [advLabel,    setAdvLabel]    = useState('');
  const [advArtistType,    setAdvArtistType]    = useState('');
  const [advArtistGender,  setAdvArtistGender]  = useState('');
  const [advArtistCountry, setAdvArtistCountry] = useState('');
  const [advLanguage,      setAdvLanguage]      = useState('');
  const [advLangIsOther,   setAdvLangIsOther]   = useState(false);
  const [showLangModal,    setShowLangModal]    = useState(false);
  const [advBpmMin,        setAdvBpmMin]        = useState('');
  const [advBpmMax,        setAdvBpmMax]        = useState('');
  const [advTitleLenMin,   setAdvTitleLenMin]   = useState('');
  const [advTitleLenMax,   setAdvTitleLenMax]   = useState('');
  const [advArtistLenMin,  setAdvArtistLenMin]  = useState('');
  const [advArtistLenMax,  setAdvArtistLenMax]  = useState('');

  const abortRef        = useRef<AbortController | null>(null);
  const scrollToTopRef  = useRef(false);

  // ── Core fetch ─────────────────────────────────────────────────────────────
  const doSearch = useCallback(async (
    q: string, tol: number, f: Filters,
    pg = 1, pp = 50, s = 'relevance', am = false,
  ) => {
    const hasF = activeCount(f) > 0;
    if (!q.trim() && !hasF) { setResults(null); setError(null); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Some searches (leading-wildcard substrings, filter-only) must scan the whole
    // library and genuinely take time — but they DO return real results. So we don't
    // cut them off early; we let them run (with a 5-min safety net for a truly stuck
    // connection) and, after 5s, show an explainer so the user knows it's still working.
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException('Search timed out', 'TimeoutError')),
      300_000,
    );
    setSlowSearch(false);
    const slowId = setTimeout(() => {
      if (abortRef.current === controller) setSlowSearch(true);
    }, 5000);

    setLoading(true);
    setError(null);

    try {
      // Search is served by the Cloudflare Worker (D1). NEXT_PUBLIC_WORKER_URL is
      // required in production; without it the request fails clearly rather than
      // silently falling back to the retired Supabase backend.
      const base = `${process.env.NEXT_PUBLIC_WORKER_URL ?? ''}/search`;

      const params = new URLSearchParams();
      if (q.trim())           params.set('q',            q.trim());
      if (tol > 0)            params.set('tolerance',     String(tol));
      if (f.titleContains)    params.set('title',          f.titleContains);
      if (f.artistContains)   params.set('artist',         f.artistContains);
      if (f.titleContains  && f.titleMode  === 'startswith') params.set('title_mode',  'startswith');
      if (f.artistContains && f.artistMode === 'startswith') params.set('artist_mode', 'startswith');
      if (f.genre)            params.set('genre',          f.genre);
      if (f.yearFrom)         params.set('year_from',      f.yearFrom);
      if (f.yearTo)           params.set('year_to',        f.yearTo);
      if (f.releaseType)      params.set('release_type',   f.releaseType);
      if (f.label)            params.set('label',          f.label);
      if (f.artistType)       params.set('artist_type',    f.artistType);
      if (f.artistGender)     params.set('artist_gender',  f.artistGender);
      if (f.artistCountry)    params.set('artist_country', f.artistCountry);
      if (f.language)         params.set('language',       f.language);
      if (f.bpmMin)           params.set('bpm_min',        f.bpmMin);
      if (f.bpmMax)           params.set('bpm_max',        f.bpmMax);
      if (f.titleLenMin)      params.set('title_len_min',  f.titleLenMin);
      if (f.titleLenMax)      params.set('title_len_max',  f.titleLenMax);
      if (f.artistLenMin)     params.set('artist_len_min', f.artistLenMin);
      if (f.artistLenMax)     params.set('artist_len_max', f.artistLenMax);
      if (am)                 params.set('mode',           'artists');
      // Group same-song versions behind one headline + "N more versions" (keyword
      // searches only — the worker ignores group=1 for duration/filter-only and for
      // artists mode, so it's safe to always send outside artists mode).
      else                    params.set('group',          '1');
      params.set('page',     String(pg));
      params.set('per_page', String(pp));
      if (s !== 'relevance') params.set('sort', s);

      const res = await fetch(`${base}?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SearchResult = await res.json();
      if (abortRef.current === controller) setResults(data);
    } catch (err) {
      if (abortRef.current !== controller) return; // superseded by a newer search
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError') {
        setError('This search ran for 5 minutes without finishing — that’s unusual. Try adding a word from the title or artist, or removing a leading “*” wildcard, to speed it up.');
      } else if (name !== 'AbortError') {
        setError('Search failed. Please try again in a moment.');
      }
    } finally {
      clearTimeout(timeoutId);
      clearTimeout(slowId);
      if (abortRef.current === controller) { setLoading(false); setSlowSearch(false); }
    }
  }, []);

  // ── Explicit submit (main box) ─────────────────────────────────────────────
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q && activeCount(filters) === 0) return;
    setResults(null);
    setTolerance(0);
    setPage(1);
    doSearch(q, 0, filters, 1, perPage, sort, artistsMode);
    router.replace(buildUrl(q, filters, 1, perPage, sort, artistsMode), { scroll: false });
  }, [query, filters, perPage, sort, artistsMode, doSearch, router]);

  // ── Example chip ──────────────────────────────────────────────────────────
  const handleExampleClick = useCallback((ex: Example) => {
    const q = ex.query ?? ex.label;
    const f: Filters = { ...EMPTY_FILTERS, ...(ex.filters ?? {}) };
    setQuery(q);
    setFilters(f);
    setArtistsMode(false);   // examples are normal-mode searches
    setResults(null);
    setTolerance(0);
    setPage(1);
    // reflect any applied filters in the collapsed advanced summary line
    if (ex.filters) {
      const p = parseQuery(q);
      const durMarker = (p.exactDuration != null || p.minDuration != null || p.maxDuration != null) ? 'x' : '';
      setAdvSummary(summaryFromFilters(f, durMarker, '', ''));
    } else {
      setAdvSummary([]);
    }
    doSearch(q, 0, f, 1, perPage, sort);
    router.replace(buildUrl(q, f, 1, perPage, sort), { scroll: false });
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
    doSearch(query, tolerance, filters, pg, perPage, sort, artistsMode);
    scrollToTopRef.current = true;
    router.replace(buildUrl(query, filters, pg, perPage, sort, artistsMode), { scroll: false });
  }, [query, tolerance, filters, perPage, sort, artistsMode, doSearch, router]);

  const handlePerPageChange = useCallback((pp: number) => {
    setPerPage(pp);
    setPage(1);
    doSearch(query, tolerance, filters, 1, pp, sort, artistsMode);
    router.replace(buildUrl(query, filters, 1, pp, sort, artistsMode), { scroll: false });
  }, [query, tolerance, filters, sort, artistsMode, doSearch, router]);

  const handleSortChange = useCallback((s: string) => {
    setSort(s);
    setPage(1);
    doSearch(query, tolerance, filters, 1, perPage, s, artistsMode);
    router.replace(buildUrl(query, filters, 1, perPage, s, artistsMode), { scroll: false });
  }, [query, tolerance, filters, perPage, artistsMode, doSearch, router]);

  // ── Advanced form compile + submit ─────────────────────────────────────────
  const compileAdvancedQuery = (): string => {
    const parts: string[] = [];
    // Title and artist go as dedicated filter params, NOT as FTS keywords,
    // so they match only the title/artist columns (not album or other indexed fields).
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
      titleContains:  advTitle.trim(),
      artistContains: advArtist.trim(),
      titleMode:      advTitleMode,
      artistMode:     advArtistMode,
      genre:          advGenre,
      yearFrom:       advYearFrom,
      yearTo:         advYearTo,
      releaseType:    advRelType,
      label:          advLabel,
      artistType:     advArtistType,
      artistGender:   advArtistGender,
      artistCountry:  advArtistCountry,
      language:       advLanguage,
      bpmMin:         advBpmMin.trim(),
      bpmMax:         advBpmMax.trim(),
      titleLenMin:    advTitleLenMin.trim(),
      titleLenMax:    advTitleLenMax.trim(),
      artistLenMin:   advArtistLenMin.trim(),
      artistLenMax:   advArtistLenMax.trim(),
    };
    if (!compiled && activeCount(newFilters) === 0) return;
    setResults(null);
    setQuery(compiled);
    setFilters(newFilters);
    setTolerance(0);
    setPage(1);
    doSearch(compiled, 0, newFilters, 1, perPage, sort);
    router.replace(buildUrl(compiled, newFilters, 1, perPage, sort), { scroll: false });

    // Collapse panel and build field summary
    setAdvExpanded(false);
    const durActive = advDurMode === 'exact' ? advExact : `${advFrom}${advTo}`;
    setAdvSummary(summaryFromFilters(newFilters, durActive, '', ''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advTitle, advArtist, advTitleMode, advArtistMode, advDurMode, advExact, advFrom, advTo,
      advGenre, advYearFrom, advYearTo, advRelType, advLabel,
      advArtistType, advArtistGender, advArtistCountry, advLanguage,
      advBpmMin, advBpmMax,
      advTitleLenMin, advTitleLenMax, advArtistLenMin, advArtistLenMax,
      perPage, sort, doSearch, router]);

  // ── Remove a single filter (or a paired range) and re-run the search ────────
  const removeFilter = useCallback((keys: (keyof Filters)[]) => {
    const next: Filters = { ...filters };
    for (const k of keys) next[k] = '';
    setFilters(next);
    setResults(null);
    setPage(1);
    const q = query.trim();
    if (q || activeCount(next) > 0) {
      // keep the collapsed summary line in sync (duration lives in the query, untouched here)
      const p = parseQuery(q);
      const durMarker = (p.exactDuration != null || p.minDuration != null || p.maxDuration != null) ? 'x' : '';
      setAdvSummary(summaryFromFilters(next, durMarker, '', ''));
      doSearch(q, 0, next, 1, perPage, sort, artistsMode);
      router.replace(buildUrl(q, next, 1, perPage, sort, artistsMode), { scroll: false });
    } else {
      setAdvSummary([]);
      router.replace('/', { scroll: false });
    }
  }, [filters, query, perPage, sort, artistsMode, doSearch, router]);

  // Sync advanced filter fields from main filter state when advanced opens
  useEffect(() => {
    if (advExpanded) {
      setAdvTitle(filters.titleContains);
      setAdvArtist(filters.artistContains);
      setAdvTitleMode(filters.titleMode);
      setAdvArtistMode(filters.artistMode);
      setAdvGenre(filters.genre);
      setAdvYearFrom(filters.yearFrom);
      setAdvYearTo(filters.yearTo);
      setAdvRelType(filters.releaseType);
      setAdvLabel(filters.label);
      setAdvArtistType(filters.artistType);
      setAdvArtistGender(filters.artistGender);
      setAdvArtistCountry(filters.artistCountry);
      setAdvLanguage(filters.language);
      setAdvLangIsOther(!!filters.language && !TOP_LANG_CODES.has(filters.language));
      setAdvBpmMin(filters.bpmMin);
      setAdvBpmMax(filters.bpmMax);
      setAdvTitleLenMin(filters.titleLenMin);
      setAdvTitleLenMax(filters.titleLenMax);
      setAdvArtistLenMin(filters.artistLenMin);
      setAdvArtistLenMax(filters.artistLenMax);
    }
  }, [advExpanded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to top after new page results render
  useEffect(() => {
    if (scrollToTopRef.current) {
      scrollToTopRef.current = false;
      window.scrollTo({ top: 0 });
    }
  }, [results]);

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
          className={`no-underline flex items-center gap-2 sm:gap-3 transition-all duration-200 ${
            hasQuery || hasFilters ? 'mb-3' : 'mb-4'
          }`}
        >
          {/* Visible brand logo. Not the semantic <h1> — that's server-rendered in
              app/page.tsx so scanners/search see the page's purpose in the initial HTML. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt=""
            aria-hidden="true"
            width={1024}
            height={1238}
            className={`w-auto shrink-0 transition-all duration-200 ${
              hasQuery || hasFilters ? 'h-7 sm:h-8' : 'h-10 sm:h-14'
            }`}
          />
          <div className={`font-bold text-gray-900 tracking-tight transition-all duration-200 select-none ${
            hasQuery || hasFilters ? 'text-xl' : 'text-3xl sm:text-5xl'
          }`}>
            <span className="text-blue-600">HowLong</span>IsThisSong
            <span className="text-gray-300">.com</span>
          </div>
        </a>

        {!hasQuery && !hasFilters && (
          <p className="text-gray-400 text-sm sm:text-base mb-6 text-center px-4">
            The internet&rsquo;s premium song search.
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

          {/* Mode toggles */}
          <div className="mt-2 flex items-center gap-4 pl-1">
            {/* Artists only toggle */}
            <label className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-500 transition-colors cursor-pointer select-none">
              <input
                type="checkbox"
                checked={artistsMode}
                onChange={e => {
                  const am = e.target.checked;
                  setArtistsMode(am);
                  setResults(null);
                  setPage(1);
                  const q = query.trim();
                  if (q || activeCount(filters) > 0) {
                    doSearch(q, 0, filters, 1, perPage, sort, am);
                    router.replace(buildUrl(q, filters, 1, perPage, sort, am), { scroll: false });
                  }
                }}
                className="accent-blue-600"
              />
              Artists only
            </label>

          {/* Advanced search toggle */}
            <button
              onClick={() => setAdvExpanded(e => !e)}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-500 transition-colors select-none"
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
          </div>

            {advExpanded && (
              <div className="mt-2 p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-4">

                {/* Title + Artist (each with a Contains / Starts-with mode) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-gray-500">Title</label>
                      <select value={advTitleMode} onChange={e => setAdvTitleMode(e.target.value)}
                        className="text-xs text-gray-500 bg-white border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-400 cursor-pointer">
                        <option value="">Contains</option>
                        <option value="startswith">Starts with</option>
                      </select>
                    </div>
                    <input value={advTitle} onChange={e => setAdvTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder={advTitleMode === 'startswith' ? 'Title begins with…' : 'Bohemian* or *rhapsody'}
                      className={ADV_INPUT} />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-gray-500">Artist</label>
                      <select value={advArtistMode} onChange={e => setAdvArtistMode(e.target.value)}
                        className="text-xs text-gray-500 bg-white border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-400 cursor-pointer">
                        <option value="">Contains</option>
                        <option value="startswith">Starts with</option>
                      </select>
                    </div>
                    <input value={advArtist} onChange={e => setAdvArtist(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder={advArtistMode === 'startswith' ? 'Artist begins with…' : 'Queen or *smith*'}
                      className={ADV_INPUT} />
                  </div>
                </div>

                {/* Genre + Label */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

                {/* Artist type + Gender */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Artist type</label>
                    <select value={advArtistType} onChange={e => setAdvArtistType(e.target.value)}
                      className={`${ADV_INPUT} pr-8 cursor-pointer`}>
                      <option value="">Any</option>
                      <option value="Person">Person (solo)</option>
                      <option value="Group">Group / Band</option>
                      <option value="Orchestra">Orchestra</option>
                      <option value="Choir">Choir</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Artist gender</label>
                    <select value={advArtistGender} onChange={e => setAdvArtistGender(e.target.value)}
                      className={`${ADV_INPUT} pr-8 cursor-pointer`}>
                      <option value="">Any</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                      <option value="Non-binary">Non-binary</option>
                    </select>
                  </div>
                </div>

                {/* Country + Language */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Artist country</label>
                    <input value={advArtistCountry} onChange={e => setAdvArtistCountry(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="United States, Japan…" className={ADV_INPUT} />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Language</label>
                    {/* Smart language box: top-6 dropdown + "Other" → ISO text input */}
                    <select
                      value={advLangIsOther ? 'other' : advLanguage}
                      onChange={e => {
                        const v = e.target.value;
                        if (v === 'other') {
                          setAdvLangIsOther(true);
                          setAdvLanguage('');
                        } else {
                          setAdvLangIsOther(false);
                          setAdvLanguage(v);
                        }
                      }}
                      className={`${ADV_INPUT} pr-8 cursor-pointer`}
                    >
                      <option value="">Any</option>
                      {TOP_LANGUAGES.map(l => (
                        <option key={l.code} value={l.code}>{l.label}</option>
                      ))}
                      <option value="other">Other…</option>
                    </select>
                    {advLangIsOther && (
                      <div className="mt-1.5 space-y-1">
                        <input
                          value={advLanguage}
                          onChange={e => setAdvLanguage(e.target.value.toLowerCase().slice(0, 3))}
                          onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                          placeholder="e.g. kor"
                          maxLength={3}
                          className={`${ADV_INPUT} font-mono w-24`}
                          autoFocus
                        />
                        <p className="text-xs text-gray-400">
                          ISO 639-3 code (3 letters).{' '}
                          <button
                            type="button"
                            onClick={() => setShowLangModal(true)}
                            className="underline hover:text-blue-500 transition-colors"
                          >
                            Full list
                          </button>
                        </p>
                      </div>
                    )}
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

                {/* BPM */}
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-1 block">BPM</label>
                  <div className="flex items-center gap-2">
                    <input value={advBpmMin} onChange={e => setAdvBpmMin(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Min" className={`${ADV_INPUT} w-24`} maxLength={3} inputMode="numeric" />
                    <span className="text-xs text-gray-400 flex-shrink-0">to</span>
                    <input value={advBpmMax} onChange={e => setAdvBpmMax(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Max" className={`${ADV_INPUT} w-24`} maxLength={3} inputMode="numeric" />
                  </div>
                </div>

                {/* Name length (number of characters) */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Title length</label>
                    <div className="flex items-center gap-2">
                      <input value={advTitleLenMin} onChange={e => setAdvTitleLenMin(e.target.value.replace(/\D/g, ''))}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="Min" className={`${ADV_INPUT} w-20`} maxLength={3} inputMode="numeric" />
                      <span className="text-xs text-gray-400 flex-shrink-0">to</span>
                      <input value={advTitleLenMax} onChange={e => setAdvTitleLenMax(e.target.value.replace(/\D/g, ''))}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="Max" className={`${ADV_INPUT} w-20`} maxLength={3} inputMode="numeric" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Artist name length</label>
                    <div className="flex items-center gap-2">
                      <input value={advArtistLenMin} onChange={e => setAdvArtistLenMin(e.target.value.replace(/\D/g, ''))}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="Min" className={`${ADV_INPUT} w-20`} maxLength={3} inputMode="numeric" />
                      <span className="text-xs text-gray-400 flex-shrink-0">to</span>
                      <input value={advArtistLenMax} onChange={e => setAdvArtistLenMax(e.target.value.replace(/\D/g, ''))}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="Max" className={`${ADV_INPUT} w-20`} maxLength={3} inputMode="numeric" />
                    </div>
                  </div>
                </div>
                <p className="text-xs text-gray-400 -mt-1">
                  Length = number of characters in the name. Tip: pair it with a keyword or another filter — length on its own scans the whole library and is slow.
                </p>

                {/* Actions */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleAdvancedSubmit}
                    className="px-5 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    Search
                  </button>
                  {(advGenre || advYearFrom || advYearTo || advRelType || advLabel ||
                    advTitle || advArtist || advExact || advFrom || advTo ||
                    advArtistType || advArtistGender || advArtistCountry || advLanguage ||
                    advBpmMin || advBpmMax ||
                    advTitleLenMin || advTitleLenMax || advArtistLenMin || advArtistLenMax) && (
                    <button
                      onClick={() => {
                        setAdvGenre(''); setAdvYearFrom(''); setAdvYearTo('');
                        setAdvRelType(''); setAdvLabel('');
                        setAdvTitle(''); setAdvArtist('');
                        setAdvTitleMode(''); setAdvArtistMode('');
                        setAdvExact(''); setAdvFrom(''); setAdvTo('');
                        setAdvArtistType(''); setAdvArtistGender('');
                        setAdvArtistCountry(''); setAdvLanguage('');
                        setAdvLangIsOther(false);
                        setAdvBpmMin(''); setAdvBpmMax('');
                        setAdvTitleLenMin(''); setAdvTitleLenMax('');
                        setAdvArtistLenMin(''); setAdvArtistLenMax('');
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

        {/* Active filter chips (shown collapsed too) */}
        {numActive > 0 && !advExpanded && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 px-4 max-w-2xl w-full">
            {filters.titleContains && (
              <FilterChip
                label={filters.titleMode === 'startswith' ? `title starts with: ${filters.titleContains}` : `title: ${filters.titleContains}`}
                onRemove={() => removeFilter(['titleContains', 'titleMode'])}
              />
            )}
            {filters.artistContains && (
              <FilterChip
                label={filters.artistMode === 'startswith' ? `artist starts with: ${filters.artistContains}` : `artist: ${filters.artistContains}`}
                onRemove={() => removeFilter(['artistContains', 'artistMode'])}
              />
            )}
            {filters.genre && (
              <FilterChip label={`genre: ${filters.genre}`} onRemove={() => removeFilter(['genre'])} />
            )}
            {(filters.yearFrom || filters.yearTo) && (
              <FilterChip
                label={filters.yearFrom && filters.yearTo
                  ? `${filters.yearFrom}–${filters.yearTo}`
                  : filters.yearFrom ? `from ${filters.yearFrom}` : `to ${filters.yearTo}`}
                onRemove={() => removeFilter(['yearFrom', 'yearTo'])}
              />
            )}
            {filters.releaseType && (
              <FilterChip label={filters.releaseType} onRemove={() => removeFilter(['releaseType'])} />
            )}
            {filters.label && (
              <FilterChip label={`label: ${filters.label}`} onRemove={() => removeFilter(['label'])} />
            )}
            {filters.artistType && (
              <FilterChip label={`type: ${filters.artistType}`} onRemove={() => removeFilter(['artistType'])} />
            )}
            {filters.artistGender && (
              <FilterChip label={`gender: ${filters.artistGender}`} onRemove={() => removeFilter(['artistGender'])} />
            )}
            {filters.artistCountry && (
              <FilterChip label={`country: ${filters.artistCountry}`} onRemove={() => removeFilter(['artistCountry'])} />
            )}
            {filters.language && (
              <FilterChip label={`lang: ${filters.language}`} onRemove={() => removeFilter(['language'])} />
            )}
            {(filters.bpmMin || filters.bpmMax) && (
              <FilterChip
                label={filters.bpmMin && filters.bpmMax
                  ? `${filters.bpmMin}–${filters.bpmMax} BPM`
                  : filters.bpmMin ? `≥${filters.bpmMin} BPM` : `≤${filters.bpmMax} BPM`}
                onRemove={() => removeFilter(['bpmMin', 'bpmMax'])}
              />
            )}
            {(filters.titleLenMin || filters.titleLenMax) && (
              <FilterChip
                label={filters.titleLenMin && filters.titleLenMax
                  ? `title ${filters.titleLenMin}–${filters.titleLenMax} chars`
                  : filters.titleLenMin ? `title ≥${filters.titleLenMin} chars` : `title ≤${filters.titleLenMax} chars`}
                onRemove={() => removeFilter(['titleLenMin', 'titleLenMax'])}
              />
            )}
            {(filters.artistLenMin || filters.artistLenMax) && (
              <FilterChip
                label={filters.artistLenMin && filters.artistLenMax
                  ? `artist ${filters.artistLenMin}–${filters.artistLenMax} chars`
                  : filters.artistLenMin ? `artist ≥${filters.artistLenMin} chars` : `artist ≤${filters.artistLenMax} chars`}
                onRemove={() => removeFilter(['artistLenMin', 'artistLenMax'])}
              />
            )}
            <button
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setAdvSummary([]);
                setResults(null);
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
          <div className="mt-4 px-4 w-full flex flex-col items-center">
            <div className="flex flex-wrap gap-2 justify-center max-w-xl">
              {EXAMPLES.filter(ex => !ex.featured).map((ex) => (
                <button key={ex.label} onClick={() => handleExampleClick(ex)} title={ex.hint}
                  className="text-xs bg-gray-100 hover:bg-blue-50 hover:text-blue-700 text-gray-500 px-3 py-1.5 rounded-full transition-colors font-mono">
                  {ex.label}
                </button>
              ))}
            </div>
            {/* The big standout "wild" example */}
            {EXAMPLES.filter(ex => ex.featured).map((ex) => (
              <button key={ex.label} onClick={() => handleExampleClick(ex)} title={ex.hint}
                className="mt-3 w-full max-w-xl text-left text-xs sm:text-sm bg-gradient-to-r from-blue-50 to-indigo-50 hover:from-blue-100 hover:to-indigo-100 border border-blue-200 text-blue-800 px-4 py-2.5 rounded-xl transition-colors">
                <span className="font-semibold text-blue-600 whitespace-nowrap">Try a wild one&nbsp;→</span>{' '}
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

        {loading && slowSearch && !error && (
          <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <div className="flex items-center gap-2 font-medium">
              <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Still working — this one&rsquo;s the slow kind.
            </div>
            <p className="mt-1.5 text-blue-800 leading-relaxed">
              We don&rsquo;t run the heavy-duty search hardware the big sites do, so some searches have to
              scan the whole library the hard way and simply take time (sometimes a lot of it). As long as
              you see this message, we <span className="font-semibold">are</span> still gathering your
              results — we just can&rsquo;t estimate how long it&rsquo;ll take.
            </p>
            <p className="mt-1.5 text-blue-800 leading-relaxed">
              Want them faster? Searches that begin with a wildcard (like <code className="font-mono">*corner</code>)
              or use only filters are the slow ones. Adding a plain word from the title or artist —{' '}
              <code className="font-mono">corner</code> instead of <code className="font-mono">*corner</code> — is
              usually instant.
            </p>
          </div>
        )}

        {(hasQuery || hasFilters) && !hasResults && !error && (
          <p className="text-center text-sm text-gray-400 mt-10">
            Press <kbd className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 border border-gray-200 rounded">Enter</kbd>{' '}
            or click <strong className="font-medium text-gray-500">Search</strong> to find songs.
          </p>
        )}

        {(filters.bpmMin || filters.bpmMax) && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
            BPM values are algorithmically detected and may be imprecise.
          </p>
        )}

        {hasResults && !error && results?.mode === 'artists' && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-3">
              {results.total > 0 && (
                <p className="text-xs text-gray-400">
                  {results.totalCapped ? `${results.total.toLocaleString()}+` : results.total.toLocaleString()} artist{results.total !== 1 ? 's' : ''}
                </p>
              )}
              <div className="flex items-center gap-1 ml-auto">
                {[
                  { value: 'relevance', label: 'Popularity' },
                  { value: 'asc',       label: 'A→Z' },
                  { value: 'desc',      label: 'Z→A' },
                ].map(opt => (
                  <button key={opt.value} onClick={() => handleSortChange(opt.value)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      sort === opt.value
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300 hover:text-blue-600'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="divide-y divide-gray-100">
              {(results.artists ?? []).map(artist => (
                <div key={artist} className="py-2 text-sm text-gray-800">
                  {artist}
                </div>
              ))}
            </div>
            {(results.hasMore || results.page > 1) && (
              <div className="flex items-center justify-center gap-2 mt-6">
                {results.page > 1 && (
                  <button onClick={() => handlePageChange(results.page - 1)}
                    className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    ← Prev
                  </button>
                )}
                <span className="text-xs text-gray-400">
                  Page {results.page} of {Math.min(500, Math.ceil(results.total / results.perPage))}
                </span>
                {results.hasMore && (
                  <button onClick={() => handlePageChange(results.page + 1)}
                    className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    Next →
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {hasResults && !error && results?.mode !== 'artists' && (
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

      {/* ── ISO Language modal ─────────────────────────────────────────────── */}
      {showLangModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setShowLangModal(false)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col"
            style={{ maxHeight: '70vh' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-gray-800">ISO 639-3 language codes</h2>
                <p className="text-xs text-gray-400 mt-0.5">Click a language to select it</p>
              </div>
              <button
                onClick={() => setShowLangModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors text-lg leading-none"
              >✕</button>
            </div>
            <div className="overflow-y-auto flex-1 px-3 py-3">
              <div className="grid grid-cols-2 gap-0.5">
                {ISO_LANGUAGE_NAMES.map(([code, name]) => (
                  <button
                    key={code}
                    onClick={() => {
                      setAdvLanguage(code);
                      setAdvLangIsOther(true);
                      setShowLangModal(false);
                    }}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-left hover:bg-blue-50 transition-colors group ${
                      advLanguage === code ? 'bg-blue-50' : ''
                    }`}
                  >
                    <span className="font-mono text-xs text-gray-400 group-hover:text-blue-500 w-7 flex-shrink-0">{code}</span>
                    <span className="text-xs text-gray-700 truncate">{name}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-300 text-center mt-3 pb-1">
                Showing top 93 languages by track count · additional rare codes can be typed directly
              </p>
            </div>
          </div>
        </div>
      )}

      <footer className="text-center text-xs text-gray-300 py-4 border-t border-gray-100">
        <a href="/help" className="text-gray-400 hover:text-blue-500 underline transition-colors">Search guide</a>
        <span className="mx-2">·</span>
        <a href="/privacy" className="text-gray-400 hover:text-blue-500 underline transition-colors">Privacy</a>
        <span className="mx-2">·</span>
        <a href="/terms" className="text-gray-400 hover:text-blue-500 underline transition-colors">Terms</a>
        <span className="mx-2">·</span>
        <a href="/legal" className="text-gray-400 hover:text-blue-500 underline transition-colors">Legal</a>
        <span className="mx-2">·</span>
        Track data from{' '}
        <a href="https://musicbrainz.org" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">MusicBrainz</a>
        {' '}· Audio analysis from{' '}
        <a href="https://acousticbrainz.org" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">AcousticBrainz</a>
        {' '}· Popularity from{' '}
        <a href="https://www.last.fm" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">Last.fm</a>
        {' '}&amp;{' '}
        <a href="https://listenbrainz.org" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">ListenBrainz</a>
        {searchCount != null && (
          <>{' '}· {searchCount.toLocaleString()} searches run</>
        )}
      </footer>
    </div>
  );
}
