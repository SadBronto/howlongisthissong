'use client';

import type { SearchResult } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';
import TrackCard from './TrackCard';

// Slider steps: 0 = exact, then 500ms increments up to 5000ms
const TOLERANCE_STEPS = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000];
const PER_PAGE_OPTIONS = [25, 50, 100, 200];

function toleranceLabel(ms: number) {
  if (ms === 0) return 'Exact';
  if (ms < 1000) return `±${ms}ms`;
  return `±${ms / 1000}s`;
}

interface SearchResultsProps {
  results:           SearchResult | null;
  loading:           boolean;
  query:             string;
  tolerance:         number;  // ms
  isExactTime:       boolean;
  onToleranceChange: (ms: number) => void;
  page:              number;
  perPage:           number;
  sort:              string;
  onPageChange:      (page: number) => void;
  onPerPageChange:   (perPage: number) => void;
  onSortChange:      (sort: string) => void;
}

export default function SearchResults({
  results, loading, tolerance, isExactTime, onToleranceChange,
  page, perPage, sort, onPageChange, onPerPageChange, onSortChange,
}: SearchResultsProps) {
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

  const { tracks = [], total, totalCapped, hasMore, parsed } = results;
  const sliderIndex = TOLERANCE_STEPS.indexOf(tolerance);

  const totalPages = Math.min(500, Math.ceil(total / perPage));
  const rangeStart = (page - 1) * perPage + 1;
  const rangeEnd   = (page - 1) * perPage + tracks.length;

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
          {total === 1 ? (
            <><span className="font-medium text-gray-700">1</span> result</>
          ) : (
            <>
              <span className="font-medium text-gray-700">
                {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}
              </span>
              {' '}of{' '}
              <span className="font-medium text-gray-700">
                {total.toLocaleString()}{totalCapped ? '+' : ''}
              </span>
              {' '}results
            </>
          )}
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
        </p>

        <div className="flex items-center gap-3 flex-wrap">
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

          {/* Per-page selector */}
          <select
            value={perPage}
            onChange={e => onPerPageChange(parseInt(e.target.value, 10))}
            className="text-xs text-gray-500 border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-blue-400"
          >
            {PER_PAGE_OPTIONS.map(n => (
              <option key={n} value={n}>{n} per page</option>
            ))}
          </select>

          {/* Sort */}
          {loading ? (
            <span className="text-xs text-gray-400 animate-pulse">Updating…</span>
          ) : (
            <select
              value={sort}
              onChange={e => onSortChange(e.target.value)}
              className="text-xs text-gray-500 border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-blue-400"
            >
              <option value="relevance">Sort: relevance</option>
              <option value="asc">Shortest first</option>
              <option value="desc">Longest first</option>
            </select>
          )}
        </div>
      </div>

      <div className="border-t border-gray-100 mb-1" />

      {/* Enrichment disclaimer */}
      <p className="text-xs text-gray-400 px-1 py-2 leading-relaxed">
        Popularity and genre data are actively filling in — the most-searched songs get enriched first,
        so the index improves every day.
      </p>

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

      {/* ── Pagination controls ── */}
      {(page > 1 || hasMore) && (
        <div className="flex items-center justify-center gap-3 mt-6 pt-4 border-t border-gray-100">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1 || loading}
            className="text-sm text-gray-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors px-3 py-1.5 rounded-lg hover:bg-gray-50"
          >
            ← Previous
          </button>

          <span className="text-sm text-gray-400 tabular-nums">
            Page <span className="font-medium text-gray-700">{page}</span>
            {totalPages > 1 && (
              <>
                {' '}of{' '}
                <span className="font-medium text-gray-700">
                  {totalPages}{totalCapped ? '+' : ''}
                </span>
              </>
            )}
          </span>

          <button
            onClick={() => onPageChange(page + 1)}
            disabled={!hasMore || loading}
            className="text-sm text-gray-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors px-3 py-1.5 rounded-lg hover:bg-gray-50"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
