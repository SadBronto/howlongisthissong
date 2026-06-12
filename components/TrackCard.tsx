'use client';

import { useState } from 'react';
import type { Track } from '@/lib/types';
import { formatDuration } from '@/lib/queryParser';

interface TrackCardProps {
  track:          Track;
  exactDuration?: number;
  tolerance?:     number; // ms
}

// Same worker that serves /search also serves /versions (every recording of one song).
const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

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

  // Audio chips: hover shows the explanation on desktop; tapping shows it on mobile
  // (where there's no hover) via the caption below the chip row.
  const [info, setInfo] = useState<string | null>(null);
  const audioChip = (text: string, explain: string) => (
    <button
      type="button"
      title={explain}
      onClick={() => setInfo(prev => (prev === explain ? null : explain))}
      className="text-xs text-indigo-500 bg-indigo-50 hover:bg-indigo-100 px-1.5 py-0.5 rounded-full flex-shrink-0 transition-colors cursor-help"
    >
      {text}
    </button>
  );

  // ── "N more versions" ───────────────────────────────────────────────────────
  // Grouped /search results carry version_count (# of recordings of the same song).
  // >1 means other recordings exist (live, remaster, alt album…). We fetch the full
  // list lazily on first expand and cache it for the life of the card.
  const moreCount = (track.version_count ?? 1) - 1;
  const canExpand = moreCount > 0 && !!track.artist;
  const [expanded, setExpanded] = useState(false);
  const [versions, setVersions] = useState<Track[] | null>(null);
  const [vLoading, setVLoading] = useState(false);
  const [vError,   setVError]   = useState(false);

  const toggleVersions = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && versions == null && !vLoading) {
      setVLoading(true);
      setVError(false);
      try {
        const params = new URLSearchParams({ title: track.title, artist: track.artist ?? '' });
        const res = await fetch(`${WORKER_BASE}/versions?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setVersions((data.versions ?? []) as Track[]);
      } catch {
        setVError(true);
      } finally {
        setVLoading(false);
      }
    }
  };

  // Every recording except the headline (already shown as this card's main row).
  const otherVersions = versions?.filter(v => String(v.id) !== String(track.id)) ?? [];

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

        {/* AcousticBrainz audio properties — tap a chip (or hover) for what it means */}
        {(track.bpm != null || track.key_key != null || track.loudness != null ||
          track.danceability != null || track.tuning_freq != null || track.dynamic_complexity != null) && (
          <div className="mt-1">
            <div className="flex items-center gap-1 flex-wrap">
              {track.bpm != null &&
                audioChip(`${Math.round(track.bpm)} BPM`, 'Tempo in beats per minute (algorithmically detected).')}
              {track.key_key != null && track.key_scale != null &&
                audioChip(`${track.key_key} ${track.key_scale}`, `Musical key: ${track.key_key} ${track.key_scale}.`)}
              {track.loudness != null &&
                audioChip(`${track.loudness.toFixed(1)} dB`, `Integrated loudness: ${track.loudness.toFixed(1)} dB (0 dB = maximum; more negative = quieter).`)}
              {track.danceability != null &&
                audioChip(`Dance ${Math.round((track.danceability / 3) * 100)}%`, `Danceability: ${Math.round((track.danceability / 3) * 100)}% — how suitable the track is for dancing, based on rhythm stability and beat strength.`)}
              {track.tuning_freq != null &&
                audioChip(`${Math.round(track.tuning_freq)} Hz`, `Tuning frequency: ${Math.round(track.tuning_freq)} Hz (standard pitch = 440 Hz).`)}
              {track.dynamic_complexity != null &&
                audioChip(`Dyn ${track.dynamic_complexity.toFixed(1)}`, `Dynamic complexity: ${track.dynamic_complexity.toFixed(1)} — average variation in loudness; higher = more dramatic shifts between quiet and loud.`)}
            </div>
            {info && <p className="text-xs text-gray-400 mt-1 leading-snug">{info}</p>}
          </div>
        )}

        {/* "N more versions" — same song, other recordings (live, remaster, alt album…) */}
        {canExpand && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={toggleVersions}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
            >
              <svg className={`h-3 w-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              {expanded ? 'Hide versions' : `${moreCount} more version${moreCount === 1 ? '' : 's'}`}
            </button>

            {expanded && (
              <div className="mt-1.5 pl-3 border-l-2 border-gray-100 space-y-1.5">
                {vLoading && <p className="text-xs text-gray-400">Loading versions…</p>}
                {vError && (
                  <p className="text-xs text-red-400">
                    Couldn&rsquo;t load versions.{' '}
                    <button type="button" onClick={toggleVersions} className="underline hover:text-red-500">
                      Retry
                    </button>
                  </p>
                )}
                {!vLoading && !vError && otherVersions.length === 0 && (
                  <p className="text-xs text-gray-400">No other versions found.</p>
                )}
                {otherVersions.map(v => (
                  <div key={v.id} className="flex items-baseline gap-3 leading-snug">
                    <span className="flex-shrink-0 font-mono text-xs text-gray-500 tabular-nums w-16 text-right">
                      {v.duration_ms != null ? formatDuration(v.duration_ms, true) : '?:??.???'}
                    </span>
                    <span className="min-w-0 text-xs text-gray-500">
                      {v.version
                        ? <span className="text-blue-500">{v.version}</span>
                        : <span className="italic text-gray-400">studio / untagged</span>}
                      {v.album && <span className="text-gray-400"> · <span className="italic">{v.album}</span></span>}
                      {v.release_year && <span className="text-gray-400"> · {v.release_year}</span>}
                    </span>
                  </div>
                ))}
              </div>
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
