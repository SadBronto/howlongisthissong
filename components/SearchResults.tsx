'use client';

import { useState, useMemo } from 'react';
import type { SearchResult } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';
import TrackCard from './TrackCard';

type SortMode = 'default' | 'duration-asc' | 'duration-desc';

interface SearchResultsProps {
  results:       SearchResult | null;
  loading:       boolean;
  query:         string;
  loose:         boolean;
  isExactTime:   boolean;
  onLooseChange: (val: boolean) => void;
}

export default function SearchResults({
  results, loading, loose, isExactTime, onLooseChange,
}: SearchResultsProps) {
  const [sort, setSort] = useState<SortMode>('default');

  const tracks = useMemo(() => {
    if (!results?.tracks) return [];
    const copy = [...results.tracks];
    if (sort === 'duration-asc')  copy.sort((a, b) => (a.duration_ms ?? 0) - (b.duration_ms ?? 0));
    if (sort === 'duration-desc') copy.sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0));
    return copy;
  }, [results, sort]);

  if (loading && !results) {
    return (
      <div className="mt-4 space-y-1">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-16 bg-gray-100 rounded-lg animate-pulse" style={{ opacity: 1 - i * 0.1 }} />
        ))}
      </div>
    );
  }

  if (!results) return null;

  const { total, parsed } = results;

  if (tracks.length === 0) {
    return (
      <div className="mt-8">
        <p className="text-gray-600 font-medium text-center">No results found.</p>
        {isExactTime && !loose && (
          <div className="mt-4 text-center">
            <button
              onClick={() => onLooseChange(true)}
              className="text-sm text-blue-600 hover:underline"
            >
              Try ±5 seconds
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2">
      {/* ── Controls bar ── */}
      <div className="flex items-center justify-between mb-2 px-1 flex-wrap gap-2 min-h-[2rem]">
        {/* Result count + context */}
        <p className="text-sm text-gray-500">
          <span className="font-medium text-gray-700">{total.toLocaleString()}</span>{' '}
          {total === 1 ? 'result' : 'results'}
          {parsed?.exactDuration != null && (
            <> — exactly <span className="font-mono text-gray-700">{formatDuration(parsed.exactDuration)}</span>
            {loose && <span className="text-gray-400"> ±5s</span>}</>
          )}
          {parsed?.minDuration != null && parsed?.maxDuration != null && !parsed?.exactDuration && (
            <> — <span className="font-mono text-gray-700">{formatDuration(parsed.minDuration)}</span>
            {' to '}
            <span className="font-mono text-gray-700">{formatDuration(parsed.maxDuration)}</span></>
          )}
          {total === 100 && <span className="text-gray-400"> (top 100)</span>}
        </p>

        <div className="flex items-center gap-3">
          {/* ±5s toggle — only for exact time searches */}
          {isExactTime && (
            <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={loose}
                onChange={e => onLooseChange(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span>±5 seconds</span>
            </label>
          )}

          {/* Sort */}
          {loading
            ? <span className="text-xs text-gray-400 animate-pulse">Updating…</span>
            : (
              <select
                value={sort}
                onChange={e => setSort(e.target.value as SortMode)}
                className="text-xs text-gray-500 border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-blue-400"
              >
                <option value="default">Sort: relevance</option>
                <option value="duration-asc">Sort: shortest first</option>
                <option value="duration-desc">Sort: longest first</option>
              </select>
            )
          }
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-gray-100 mb-1" />

      {/* Track list */}
      <div>
        {tracks.map(track => (
          <TrackCard
            key={track.id}
            track={track}
            exactDuration={parsed?.exactDuration}
          />
        ))}
      </div>
    </div>
  );
}
