import type { Track } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';

interface TrackCardProps {
  track:          Track;
  exactDuration?: number;
  tolerance?:     number; // ms
}

export default function TrackCard({ track, exactDuration, tolerance = 0 }: TrackCardProps) {
  const duration = track.duration_ms != null ? formatDuration(track.duration_ms, true) : '?:??.???';

  // Blue = exactly the typed time (within the 1-second display window)
  // Gray = within tolerance but not exact
  const isExact =
    exactDuration != null && track.duration_ms != null
      ? track.duration_ms >= exactDuration && track.duration_ms <= exactDuration + 999
      : false;

  const isInTolerance =
    !isExact && exactDuration != null && track.duration_ms != null && tolerance > 0
      ? track.duration_ms >= exactDuration - tolerance &&
        track.duration_ms <= exactDuration + 999 + tolerance
      : false;

  return (
    <div className="flex items-center gap-3 sm:gap-4 py-3 px-3 rounded-lg hover:bg-gray-50 transition-colors">
      {/* Duration */}
      <div className={`flex-shrink-0 font-mono text-sm sm:text-base font-semibold w-20 sm:w-24 text-right tabular-nums ${
        isExact        ? 'text-blue-600' :
        isInTolerance  ? 'text-blue-400' :
                         'text-gray-600'
      }`}>
        {duration}
      </div>

      <div className="w-px h-10 bg-gray-200 flex-shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap leading-snug">
          <span className="font-medium text-gray-900">{track.title}</span>
          {track.version && (
            <span className="text-xs text-blue-500 font-medium flex-shrink-0">
              {track.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-sm mt-0.5 flex-wrap">
          {track.artist && <span className="text-gray-600 truncate">{track.artist}</span>}
          {track.album && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 truncate italic">{track.album}</span>
            </>
          )}
          {track.release_year && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 flex-shrink-0">{track.release_year}</span>
            </>
          )}
          {track.release_type && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 flex-shrink-0"><em>{track.release_type}</em> Release</span>
            </>
          )}
          {track.label && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 truncate">Label: {track.label}</span>
            </>
          )}
          {track.genre && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
                {track.genre}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Popularity dot — only shown once enriched, not shown for -1 (not on Spotify) */}
      {track.popularity != null && track.popularity >= 0 && (
        <div
          className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-blue-200"
          style={{ opacity: 0.3 + (track.popularity / 100) * 0.7 }}
          title={`Popularity: ${track.popularity}/100 (Spotify)`}
        />
      )}
    </div>
  );
}
