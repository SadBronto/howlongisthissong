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
  { label: 'bohemian rhapsody',     hint: 'by title — all versions' },
  { label: 'pink floyd',            hint: 'by artist' },
  { label: 'free bird',             hint: 'classic' },
];

export default function SearchPage() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [query,     setQuery]     = useState(searchParams.get('q') ?? '');
  const [tolerance, setTolerance] = useState(0); // ms
  const [results,   setResults]   = useState<SearchResult | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const abortRef    = useRef<AbortController | null>(null);

  const doSearch = useCallback(async (q: string, tol: number) => {
    if (!q.trim()) { setResults(null); setError(null); return; }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const base = process.env.NEXT_PUBLIC_WORKER_URL
        ? `${process.env.NEXT_PUBLIC_WORKER_URL}/search`
        : '/api/search';

      const params = new URLSearchParams({ q });
      if (tol > 0) params.set('tolerance', String(tol));

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

  // Debounced search + URL sync on query change
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(query, tolerance);
      const url = query.trim() ? `/?q=${encodeURIComponent(query)}` : '/';
      router.replace(url, { scroll: false });
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, doSearch, router]); // tolerance handled separately below

  // Re-search immediately when tolerance slider moves
  const handleToleranceChange = (ms: number) => {
    setTolerance(ms);
    doSearch(query, ms);
  };

  // Reset tolerance when query changes
  useEffect(() => { setTolerance(0); }, [query]);

  // Initial search from URL on mount
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) doSearch(q, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasQuery    = !!query.trim();
  const parsed      = parseQuery(query);
  const isExactTime = parsed.exactDuration != null && !parsed.keywords;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className={`flex flex-col items-center transition-all duration-200 ${
        hasQuery ? 'pt-5 pb-3' : 'pt-20 sm:pt-28 pb-8'
      }`}>
        <a href="/" onClick={(e) => { e.preventDefault(); setQuery(''); setTolerance(0); }}
          className="no-underline">
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
          <SearchBar value={query} onChange={setQuery} loading={loading} />
        </div>

        {!hasQuery && (
          <div className="flex flex-wrap gap-2 mt-4 px-4 justify-center max-w-xl">
            {EXAMPLES.map((ex) => (
              <button key={ex.label} onClick={() => setQuery(ex.label)} title={ex.hint}
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
        {hasQuery && !error && (
          <SearchResults
            results={results}
            loading={loading}
            query={query}
            tolerance={tolerance}
            isExactTime={isExactTime}
            onToleranceChange={handleToleranceChange}
          />
        )}
        {!hasQuery && (
          <div className="mt-16 text-center text-sm text-gray-300 space-y-1">
            <p>Search by exact time, range, title, artist, or any combination.</p>
            <p>Multiple versions of each song are preserved — that&rsquo;s a feature.</p>
          </div>
        )}
      </main>

      <footer className="text-center text-xs text-gray-300 py-4 border-t border-gray-100">
        Data from{' '}
        <a href="https://musicbrainz.org" target="_blank" rel="noopener noreferrer"
          className="underline hover:text-gray-500 transition-colors">MusicBrainz
        </a>{' '}and other public sources.
      </footer>
    </div>
  );
}
