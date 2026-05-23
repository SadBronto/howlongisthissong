import type { SearchResult } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';
import TrackCard from './TrackCard';

interface SearchResultsProps {
  results: SearchResult | null;
  loading: boolean;
  query: string;
}

export default function SearchResults({ results, loading, query }: SearchResultsProps) {
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

  const { tracks, total, parsed } = results;

  if (tracks.length === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-gray-600 font-medium">No results for &ldquo;{query}&rdquo;</p>
        <p className="text-sm text-gray-400 mt-1">
          Try a different duration or keyword. If you just set up the database, run{' '}
          <code className="font-mono bg-gray-100 px-1 rounded">npm run seed</code> to add sample data.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2">
      {/* Result count + context */}
      <div className="flex items-center justify-between mb-2 px-1 min-h-[1.5rem]">
        <p className="text-sm text-gray-500">
          <span className="font-medium text-gray-700">{total.toLocaleString()}</span>{' '}
          {total === 1 ? 'result' : 'results'}
          {parsed?.exactDuration != null && (
            <> near <span className="font-mono text-gray-700">{formatDuration(parsed.exactDuration)}</span></>
          )}
          {parsed?.minDuration != null && parsed?.maxDuration != null && (
            <>
              {' '}between{' '}
              <span className="font-mono text-gray-700">{formatDuration(parsed.minDuration)}</span>
              {' – '}
              <span className="font-mono text-gray-700">{formatDuration(parsed.maxDuration)}</span>
            </>
          )}
          {total === 100 && (
            <span className="text-gray-400"> (top 100 shown — refine your search)</span>
          )}
        </p>
        {loading && <span className="text-xs text-gray-400 animate-pulse">Updating…</span>}
      </div>

      {/* Divider */}
      <div className="border-t border-gray-100 mb-1" />

      {/* Track list */}
      <div>
        {tracks.map((track) => (
          <TrackCard
            key={track.id}
            track={track}
            highlightDuration={parsed?.exactDuration}
          />
        ))}
      </div>
    </div>
  );
}
