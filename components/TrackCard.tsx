import type { Track } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';

interface TrackCardProps {
  track: Track;
  highlightDuration?: number;
}

export default function TrackCard({ track, highlightDuration }: TrackCardProps) {
  const duration = track.duration_ms != null ? formatDuration(track.duration_ms) : '?:??';
  const isExactMatch =
    highlightDuration != null && track.duration_ms != null
      ? Math.abs(track.duration_ms - highlightDuration) <= 2000
      : false;

  return (
    <div className="flex items-center gap-3 sm:gap-4 py-3 px-3 rounded-lg hover:bg-gray-50 transition-colors">
      {/* Duration */}
      <div
        className={`flex-shrink-0 font-mono text-base sm:text-lg font-semibold w-12 sm:w-14 text-right tabular-nums ${
          isExactMatch ? 'text-blue-600' : 'text-gray-600'
        }`}
      >
        {duration}
      </div>

      {/* Separator */}
      <div className="w-px h-9 bg-gray-200 flex-shrink-0" />

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-gray-900 truncate leading-snug">{track.title}</span>
          {track.version && (
            <span className="text-xs text-gray-400 flex-shrink-0 bg-gray-100 px-1.5 py-0.5 rounded">
              {track.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-sm mt-0.5 min-w-0 flex-wrap">
          {track.artist && (
            <span className="text-gray-600 truncate">{track.artist}</span>
          )}
          {track.album && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 truncate">{track.album}</span>
            </>
          )}
          {track.release_year && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 flex-shrink-0">{track.release_year}</span>
            </>
          )}
        </div>
      </div>

      {/* Source badge — desktop only */}
      {track.source && (
        <div className="flex-shrink-0 hidden sm:block">
          <span className="text-xs text-gray-300 uppercase tracking-widest font-mono">
            {track.source === 'musicbrainz' ? 'MB' : track.source === 'sample' ? '' : track.source}
          </span>
        </div>
      )}
    </div>
  );
}
