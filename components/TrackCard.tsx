import type { Track } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';

interface TrackCardProps {
  track:         Track;
  exactDuration?: number;
}

export default function TrackCard({ track, exactDuration }: TrackCardProps) {
  const duration = track.duration_ms != null ? formatDuration(track.duration_ms) : '?:??';

  // Highlight if this is an exact duration match
  const isExact =
    exactDuration != null && track.duration_ms != null
      ? track.duration_ms >= exactDuration && track.duration_ms <= exactDuration + 999
      : false;

  return (
    <div className="flex items-center gap-3 sm:gap-4 py-3 px-3 rounded-lg hover:bg-gray-50 transition-colors">
      {/* Duration */}
      <div className={`flex-shrink-0 font-mono text-base sm:text-lg font-semibold w-12 sm:w-14 text-right tabular-nums ${
        isExact ? 'text-blue-600' : 'text-gray-600'
      }`}>
        {duration}
      </div>

      {/* Separator */}
      <div className="w-px h-10 bg-gray-200 flex-shrink-0" />

      {/* Track info */}
      <div className="flex-1 min-w-0">
        {/* Title + disambiguation on same line */}
        <div className="flex items-baseline gap-2 flex-wrap leading-snug">
          <span className="font-medium text-gray-900">{track.title}</span>
          {track.version && (
            <span className="text-xs text-blue-500 font-medium flex-shrink-0">
              {track.version}
            </span>
          )}
        </div>

        {/* Artist · Album · Year */}
        <div className="flex items-center gap-1 text-sm mt-0.5 flex-wrap">
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
    </div>
  );
}
