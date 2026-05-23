-- ============================================================
-- HowLongIsThisSong — Initial Schema
-- Run this in your Supabase SQL editor or via `supabase db push`
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Tracks table
-- ============================================================
CREATE TABLE IF NOT EXISTS tracks (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title         TEXT        NOT NULL,
  artist        TEXT,
  album         TEXT,
  version       TEXT,          -- "Live", "Radio Edit", "2011 Remaster", etc.
  duration_ms   INTEGER,       -- milliseconds
  release_year  INTEGER,
  source        TEXT        DEFAULT 'musicbrainz',
  mb_id         UUID,          -- MusicBrainz recording GUID
  external_ids  JSONB       DEFAULT '{}',
  search_vector TSVECTOR,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_tracks_duration_ms
  ON tracks(duration_ms) WHERE duration_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracks_search_vector
  ON tracks USING GIN(search_vector);

CREATE INDEX IF NOT EXISTS idx_tracks_mb_id
  ON tracks(mb_id) WHERE mb_id IS NOT NULL;

-- Trigram indexes for fuzzy matching (used in future Meilisearch/Typesense migration)
CREATE INDEX IF NOT EXISTS idx_tracks_title_trgm
  ON tracks USING GIN(title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_tracks_artist_trgm
  ON tracks USING GIN(artist gin_trgm_ops) WHERE artist IS NOT NULL;

-- ============================================================
-- Auto-update search_vector on insert/update
-- ============================================================
CREATE OR REPLACE FUNCTION update_tracks_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(unaccent(NEW.title),   '')), 'A') ||
    setweight(to_tsvector('english', coalesce(unaccent(NEW.artist),  '')), 'B') ||
    setweight(to_tsvector('english', coalesce(unaccent(NEW.album),   '')), 'C') ||
    setweight(to_tsvector('english', coalesce(unaccent(NEW.version), '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tracks_search_vector
  BEFORE INSERT OR UPDATE ON tracks
  FOR EACH ROW EXECUTE FUNCTION update_tracks_search_vector();

-- ============================================================
-- Auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tracks_updated_at
  BEFORE UPDATE ON tracks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Search RPC function
-- Called by the API route for all search queries.
-- ============================================================
CREATE OR REPLACE FUNCTION search_tracks(
  p_query        TEXT    DEFAULT NULL,
  p_min_duration INTEGER DEFAULT NULL,
  p_max_duration INTEGER DEFAULT NULL,
  p_limit        INTEGER DEFAULT 100,
  p_offset       INTEGER DEFAULT 0
)
RETURNS TABLE (
  id           UUID,
  title        TEXT,
  artist       TEXT,
  album        TEXT,
  version      TEXT,
  duration_ms  INTEGER,
  release_year INTEGER,
  source       TEXT,
  mb_id        UUID,
  external_ids JSONB,
  relevance    REAL
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tsquery TSQUERY;
BEGIN
  IF p_query IS NOT NULL AND length(trim(p_query)) > 0 THEN
    BEGIN
      v_tsquery := plainto_tsquery('english', unaccent(p_query));
    EXCEPTION WHEN OTHERS THEN
      v_tsquery := NULL;
    END;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.title,
    t.artist,
    t.album,
    t.version,
    t.duration_ms,
    t.release_year,
    t.source,
    t.mb_id,
    t.external_ids,
    CASE
      WHEN v_tsquery IS NOT NULL THEN ts_rank(t.search_vector, v_tsquery)
      ELSE 1.0
    END::REAL AS relevance
  FROM tracks t
  WHERE
    (v_tsquery IS NULL OR t.search_vector @@ v_tsquery)
    AND (p_min_duration IS NULL OR t.duration_ms >= p_min_duration)
    AND (p_max_duration IS NULL OR t.duration_ms <= p_max_duration)
    AND t.duration_ms IS NOT NULL
  ORDER BY
    CASE WHEN v_tsquery IS NOT NULL
      THEN ts_rank(t.search_vector, v_tsquery) END DESC NULLS LAST,
    t.duration_ms ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ============================================================
-- Row Level Security
-- ============================================================
ALTER TABLE tracks ENABLE ROW LEVEL SECURITY;

-- Public can read all tracks
CREATE POLICY "tracks_public_read"
  ON tracks FOR SELECT
  TO anon, authenticated
  USING (true);

-- Only service role can write
CREATE POLICY "tracks_service_write"
  ON tracks FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
