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
  genre: string | null;       // top genre tag; null until enriched
  popularity: number | null;  // Spotify score 0–100; -1 = not on Spotify; null = unchecked
  relevance?: number;
}

export interface SearchResult {
  tracks: Track[];
  total: number;
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
