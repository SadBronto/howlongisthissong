'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';
import { parseQuery } from '@/lib/queryParser';
import type { SearchResult } from '@/lib/types';

const EXAMPLES = [
  { label: '3:16',                  hint: 'exact duration' },
  { label: 'love 4:20',             hint: 'keyword + time' },
  { label: 'between 3:00 and 4:00', hint: 'range' },
  { label: 'bohemian rhapsody',     hint: 'by title' },
  { label: 'pink floyd',            hint: 'by artist' },
  { label: 'free bird',             hint: 'classic' },
];

type DurationMode = 'exact' | 'range';

// Shared style for advanced-form inputs
const ADV_INPUT = [
  'border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900',
  'placeholder-gray-400 bg-white focus:outline-none focus:border-blue-400 w-full',
].join(' ');

export default function SearchPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // ── Core search state ──────────────────────────────────────────────────────
  const [query,     setQuery]     = useState(searchParams.get('q') ?? '');
  const [tolerance, setTolerance] = useState(0);
  const [results,   setResults]   = useState<SearchResult | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // ── Advanced-form state ────────────────────────────────────────────────────
  const [advExpanded, setAdvExpanded] = useState(false);
  const [advTitle,    setAdvTitle]    = useState('');
  const [advArtist,   setAdvArtist]   = useState('');
  const [advDurMode,  setAdvDurMode]  = useState<DurationMode>('exact');
  const [advExact,    setAdvExact]    = useState('');
  const [advFrom,     setAdvFrom]     = useState('');
  const [advTo,       setAdvTo]       = useState('');

  const abortRef = useRef<AbortController | null>(null);

  // ── Core fetch ─────────────────────────────────────────────────────────────
  const doSearch = useCallback(async (q: string, tol: number) => {
    if (!q.trim()) { setResults(null); setError(null); return; }

    abortRef.current?.abort();
    const controller  = new AbortController();
    abortRef.current  = controller;

    setLoading(true);
    setError(null);

    try {
      const base = process.env.NEXT_PUBLIC_WORKER_URL
        ? `${process.env.NEXT_PUBLIC_WORKER_URL}/search`
        : '/api/search';

      const params = new URLSearchParams({ q });
      if (tol > 0) params.set('tolerance', String(tol));

      const res  = await fetch(`${base}?${params}`, { signal: controller.signal });
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

  // ── Explicit submit (main search box) ──────────────────────────────────────
  const handleSubmit = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    setTolerance(0);
    doSearch(q, 0);
    router.replace(`/?q=${encodeURIComponent(q)}`, { scroll: false });
  }, [query, doSearch, router]);

  // ── Clicking an example chip searches immediately ──────────────────────────
  const handleExampleClick = useCallback((label: string) => {
    setQuery(label);
    setTolerance(0);
    doSearch(label, 0);
    router.replace(`/?q=${encodeURIComponent(label)}`, { scroll: false });
  }, [doSearch, router]);

  // ── Clear: wipe query + results ────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setQuery('');
    setResults(null);
    setError(null);
    setTolerance(0);
    router.replace('/', { scroll: false });
  }, [router]);

  // ── Tolerance slider (immediate — post-results filter) ─────────────────────
  const handleToleranceChange = (ms: number) => {
    setTolerance(ms);
    doSearch(query, ms);
  };

  // ── Advanced search compile + submit ───────────────────────────────────────
  function compileAdvancedQuery(): string {
    const parts: string[] = [];
    const kw = [advTitle.trim(), advArtist.trim()].filter(Boolean).join(' ');
    if (kw) parts.push(kw);

    if (advDurMode === 'exact' && advExact.trim()) {
      parts.push(advExact.trim());
    } else if (advDurMode === 'range') {
      const from = advFrom.trim();
      const to   = advTo.trim();
      if (from && to) parts.push(`${from} to ${to}`);
      else if (from)  parts.push(from); // single bound — treat as exact
    }

    return parts.join(' ');
  }

  const handleAdvancedSubmit = useCallback(() => {
    const compiled = compileAdvancedQuery();
    if (!compiled) return;
    setQuery(compiled);
    setTolerance(0);
    doSearch(compiled, 0);
    router.replace(`/?q=${encodeURIComponent(compiled)}`, { scroll: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advTitle, advArtist, advDurMode, advExact, advFrom, advTo, doSearch, router]);

  // ── Initial search from URL on first load ──────────────────────────────────
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) doSearch(q, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasQuery    = !!query.trim();
  const hasResults  = results !== null || loading;
  const parsed      = parseQuery(query);
  const isExactTime = parsed.exactDuration != null && !parsed.keywords;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className={`flex flex-col items-center transition-all duration-200 ${
        hasQuery ? 'pt-5 pb-3' : 'pt-20 sm:pt-28 pb-8'
      }`}>
        <a
          href="/"
          onClick={(e) => { e.preventDefault(); handleClear(); setAdvExpanded(false); }}
          className="no-underline"
        >
          <h1 className={`font-bold text-gray-900 tracking-tight transition-all duration-200 select-none ${
            hasQuery ? 'text-xl mb-3' : 'text-3xl sm:text-5xl mb-4'
          }`}>
            <span className="text-blue-600">HowLong</span>IsThisSong
            <span className="text-gray-300">.com</span>
          </h1>
        </a>

        {!hasQuery && (
          <p className="text-gray-400 text-sm sm:text-base mb-6 text-center px-4">
            The internet&rsquo;s searchable song-duration database.
          </p>
        )}

        <div className={`w-full px-4 transition-all duration-200 ${hasQuery ? 'max-w-2xl' : 'max-w-xl'}`}>
          {/* Main search bar */}
          <SearchBar
            value={query}
            onChange={(v) => setQuery(v)}
            onSubmit={handleSubmit}
            onClear={handleClear}
            loading={loading}
          />

          {/* Advanced search */}
          <div className="mt-2">
            <button
              onClick={() => setAdvExpanded(e => !e)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-blue-500 transition-colors pl-1 select-none"
            >
              <svg
                className={`h-3 w-3 transition-transform duration-150 ${advExpanded ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
              Advanced search
            </button>

            {advExpanded && (
              <div className="mt-2 p-4 bg-gray-50 rounded-xl border border-gray-200 space-y-4">

                {/* Title + Artist */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Title</label>
                    <input
                      value={advTitle}
                      onChange={e => setAdvTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Bohemian Rhapsody"
                      className={ADV_INPUT}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Artist</label>
                    <input
                      value={advArtist}
                      onChange={e => setAdvArtist(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="Queen"
                      className={ADV_INPUT}
                    />
                  </div>
                </div>

                {/* Duration */}
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-2 block">Duration</label>

                  {/* Exact / Range toggle */}
                  <div className="flex rounded-lg border border-gray-200 w-fit mb-3 text-xs overflow-hidden">
                    {(['exact', 'range'] as const).map(mode => (
                      <button
                        key={mode}
                        onClick={() => setAdvDurMode(mode)}
                        className={`px-3 py-1.5 capitalize transition-colors ${
                          advDurMode === mode
                            ? 'bg-blue-600 text-white font-medium'
                            : 'bg-white text-gray-500 hover:bg-gray-100'
                        }`}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>

                  {advDurMode === 'exact' ? (
                    <input
                      value={advExact}
                      onChange={e => setAdvExact(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                      placeholder="3:16"
                      className={`${ADV_INPUT} w-28 font-mono`}
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        value={advFrom}
                        onChange={e => setAdvFrom(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="3:00"
                        className={`${ADV_INPUT} w-24 font-mono`}
                      />
                      <span className="text-xs text-gray-400 flex-shrink-0">to</span>
                      <input
                        value={advTo}
                        onChange={e => setAdvTo(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAdvancedSubmit(); }}
                        placeholder="4:00"
                        className={`${ADV_INPUT} w-24 font-mono`}
                      />
                    </div>
                  )}
                </div>

                <button
                  onClick={handleAdvancedSubmit}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  Search
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Example chips — only shown on homepage */}
        {!hasQuery && (
          <div className="flex flex-wrap gap-2 mt-4 px-4 justify-center max-w-xl">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                onClick={() => handleExampleClick(ex.label)}
                title={ex.hint}
                className="text-xs bg-gray-100 hover:bg-blue-50 hover:text-blue-700 text-gray-500 px-3 py-1.5 rounded-full transition-colors font-mono"
              >
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

        {/* Hint when user has typed but hasn't searched yet */}
        {hasQuery && !hasResults && !error && (
          <p className="text-center text-sm text-gray-400 mt-10">
            Press <kbd className="px-1.5 py-0.5 text-xs font-mono bg-gray-100 border border-gray-200 rounded">Enter</kbd> or click <strong className="font-medium text-gray-500">Search</strong> to find songs.
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
          />
        )}

        {!hasQuery && !hasResults && (
          <div className="mt-16 text-center text-sm text-gray-300">
            <p>Search by exact time, range, title, artist, or any combination.</p>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-300 py-4 border-t border-gray-100">
        Data from{' '}
        <a
          href="https://musicbrainz.org"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors"
        >
          MusicBrainz
        </a>{' '}
        and other public sources.
      </footer>
    </div>
  );
}
