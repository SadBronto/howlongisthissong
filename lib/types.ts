export interface Track {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  version: string | null;       // disambiguation field
  duration_ms: number | null;
  release_year: number | null;
  source: string | null;
  mb_id: string | null;
  external_ids: Record<string, string>;
  genre: string | null;         // top genre tag; null until enriched
  listen_count: number | null;  // from ListenBrainz; null until enriched
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
  };
}
