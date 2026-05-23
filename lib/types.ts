export interface Track {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  version: string | null;
  duration_ms: number | null;
  release_year: number | null;
  source: string | null;
  mb_id: string | null;
  external_ids: Record<string, string>;
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
