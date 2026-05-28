export interface Track {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  version: string | null;       // disambiguation field
  duration_ms: number | null;
  release_year: number | null;
  release_type: string | null;    // Album / Single / EP / etc.
  label: string | null;           // record label
  track_number: number | null;    // position on the album
  source: string | null;
  mb_id: string | null;
  external_ids: Record<string, string>;
  genre: string | null;             // top genre tag; null until enriched
  popularity: number | null;        // Last.fm/ListenBrainz score 0–100; null = unscored
  popularity_source: string | null; // 'lastfm' | 'listenbrainz' | 'unfound' | null
  search_count: number;             // fractional credit from site searches (organic floor signal)
  artist_type:        string | null;    // Person / Group / Orchestra / Choir / Other
  artist_gender:      string | null;    // Male / Female / Non-binary
  artist_country:     string | null;    // country/area name
  language:           string | null;    // language of the release
  bpm:                number | null;    // AcousticBrainz: beats per minute
  danceability:       number | null;    // AcousticBrainz: danceability (0–3)
  key_key:            string | null;    // AcousticBrainz: tonal key (C, F#, Bb, …)
  key_scale:          string | null;    // AcousticBrainz: major | minor
  tuning_freq:        number | null;    // AcousticBrainz: tuning frequency in Hz
  loudness:           number | null;    // AcousticBrainz: integrated loudness in dBFS
  dynamic_complexity: number | null;    // AcousticBrainz: dynamic complexity
  relevance?: number;
}

export interface SearchResult {
  tracks:       Track[];
  total:        number;
  totalCapped?: boolean;  // true if there are >10,000 matching results
  page:         number;
  perPage:      number;
  hasMore:      boolean;
  parsed?: {
    keywords?: string;
    exactDuration?: number;
    minDuration?: number;
    maxDuration?: number;
    genre?: string;
    yearFrom?: number;
    yearTo?: number;
    releaseType?: string;
    label?: string;
  };
}
