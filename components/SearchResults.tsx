'use client';

import { useState, useMemo } from 'react';
import type { SearchResult } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';
import TrackCard from './TrackCard';

type SortMode = 'default' | 'duration-asc' | 'duration-desc';

// Slider steps: 0 = exact, then 500ms increments up to 5000ms
const TOLERANCE_STEPS = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];

function toleranceLabel(ms: number) {
  if (ms === 0) return 'Exact';
  if (ms < 1000) return `±${ms}ms`;
  return `±${ms / 1000}s`;
}

interface SearchResultsProps {
  results:          SearchResult | null;
  loading:          boolean;
  query:            string;
  tolerance:        number;  // ms
  isExactTime:      boolean;
  onToleranceChange: (ms: number) => void;
}

export default function SearchResults({
  results, loading, tolerance, isExactTime, onToleranceChange,
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
          <div key={i} className="h-16 bg-gray-100 rounded-lg animate-pulse"
            style={{ opacity: 1 - i * 0.1 }} />
        ))}
      </div>
    );
  }

  if (!results) return null;

  const { total, parsed } = results;
  const sliderIndex = TOLERANCE_STEPS.indexOf(tolerance);

  if (tracks.length === 0) {
    return (
      <div className="mt-8 text-center">
        <p className="text-gray-600 font-medium">No results found.</p>
        {isExactTime && tolerance === 0 && (
          <button
            onClick={() => onToleranceChange(500)}
            className="mt-3 text-sm text-blue-600 hover:underline"
          >
            Widen to ±500ms?
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2">
      {/* ── Controls bar ── */}
      <div className="flex items-start justify-between mb-2 px-1 flex-wrap gap-2">
        {/* Result count + context */}
        <p className="text-sm text-gray-500 pt-1">
          <span className="font-medium text-gray-700">{total.toLocaleString()}</span>{' '}
          {total === 1 ? 'result' : 'results'}
          {parsed?.exactDuration != null && (
            <>
              {' '}— <span className="font-mono text-gray-700">{formatDuration(parsed.exactDuration)}</span>
              {tolerance > 0 && (
                <span className="text-gray-400"> {toleranceLabel(tolerance)}</span>
              )}
            </>
          )}
          {parsed?.minDuration != null && parsed?.maxDuration != null && !parsed?.exactDuration && (
            <>
              {' '}— <span className="font-mono text-gray-700">{formatDuration(parsed.minDuration)}</span>
              {' to '}
              <span className="font-mono text-gray-700">{formatDuration(parsed.maxDuration)}</span>
            </>
          )}
          {total === 100 && <span className="text-gray-400"> (top 100)</span>}
        </p>

        <div className="flex items-center gap-4">
          {/* Tolerance slider — only for exact time searches */}
          {isExactTime && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-10 text-right tabular-nums">
                {toleranceLabel(tolerance)}
              </span>
              <input
                type="range"
                min={0}
                max={TOLERANCE_STEPS.length - 1}
                step={1}
                value={sliderIndex === -1 ? 0 : sliderIndex}
                onChange={e => onToleranceChange(TOLERANCE_STEPS[parseInt(e.target.value)])}
                className="w-28 accent-blue-600"
                title="Duration tolerance"
              />
              <span className="text-xs text-gray-400">±5s</span>
            </div>
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
                <option value="duration-asc">Shortest first</option>
                <option value="duration-desc">Longest first</option>
              </select>
            )
          }
        </div>
      </div>

      <div className="border-t border-gray-100 mb-1" />

      <div>
        {tracks.map(track => (
          <TrackCard
            key={track.id}
            track={track}
            exactDuration={parsed?.exactDuration}
            tolerance={tolerance}
          />
        ))}
      </div>
    </div>
  );
}
