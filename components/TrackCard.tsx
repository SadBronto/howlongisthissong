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
          {track.label && track.label !== '[no label]' && (
            <>
              <span className="text-gray-300 flex-shrink-0">·</span>
              <span className="text-gray-400 truncate">Label: {track.label}</span>
            </>
          )}
          {track.genre && track.genre.split(', ').map(g => (
            <span key={g} className="flex items-center gap-1 flex-shrink-0">
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                {g}
              </span>
            </span>
          ))}
        </div>

        {/* AcousticBrainz audio properties */}
        {(track.bpm != null || track.key_key != null || track.loudness != null ||
          track.danceability != null || track.tuning_freq != null || track.dynamic_complexity != null) && (
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {track.bpm != null && (
              <span title="Tempo in beats per minute (algorithmically detected)"
                className="text-xs text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-help">
                {Math.round(track.bpm)} BPM
              </span>
            )}
            {track.key_key != null && track.key_scale != null && (
              <span title={`Musical key: ${track.key_key} ${track.key_scale}`}
                className="text-xs text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-help">
                {track.key_key} {track.key_scale}
              </span>
            )}
            {track.loudness != null && (
              <span title={`Integrated loudness: ${track.loudness.toFixed(1)} dB (0 dB = maximum; more negative = quieter)`}
                className="text-xs text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-help">
                {track.loudness.toFixed(1)} dB
              </span>
            )}
            {track.danceability != null && (
              <span title={`Danceability: ${Math.round((track.danceability / 3) * 100)}% — how suitable the track is for dancing, based on rhythm stability and beat strength`}
                className="text-xs text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-help">
                Dance {Math.round((track.danceability / 3) * 100)}%
              </span>
            )}
            {track.tuning_freq != null && (
              <span title={`Tuning frequency: ${Math.round(track.tuning_freq)} Hz (standard pitch = 440 Hz)`}
                className="text-xs text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-help">
                {Math.round(track.tuning_freq)} Hz
              </span>
            )}
            {track.dynamic_complexity != null && (
              <span title={`Dynamic complexity: ${track.dynamic_complexity.toFixed(1)} — average variation in loudness; higher = more dramatic shifts between quiet and loud`}
                className="text-xs text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-full flex-shrink-0 cursor-help">
                Dyn {track.dynamic_complexity.toFixed(1)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Popularity dot — only shown once enriched */}
      {track.popularity != null && track.popularity > 0 && (
        <div
          className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-blue-200"
          style={{ opacity: 0.3 + (track.popularity / 100) * 0.7 }}
          title={`Popularity: ${track.popularity}/100 (${
            track.popularity_source === 'lastfm' ? 'Last.fm' :
            track.popularity_source === 'listenbrainz' ? 'ListenBrainz' :
            'scored'
          })`}
        />
      )}
    </div>
  );
}
