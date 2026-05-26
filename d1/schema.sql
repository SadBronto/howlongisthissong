-- ============================================================
-- HowLongIsThisSong — Cloudflare D1 Schema
-- Run via: wrangler d1 execute howlongisthissong --file=d1/schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS tracks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  artist         TEXT,
  duration_ms    INTEGER NOT NULL,
  disambiguation TEXT,        -- "live", "radio edit", "demo", etc.
  isrc           TEXT,        -- International Standard Recording Code
  release_year   INTEGER,
  mb_id          TEXT UNIQUE  -- MusicBrainz recording GUID
);

-- Full-text search index (title + artist)
-- content table = FTS reads data from tracks, not stored twice
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title,
  artist,
  content='tracks',
  content_rowid='id'
);

-- Keep FTS in sync on insert
CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artist)
  VALUES (new.id, new.title, new.artist);
END;

-- Keep FTS in sync on delete
CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist)
  VALUES ('delete', old.id, old.title, old.artist);
END;

-- Keep FTS in sync on update
CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist)
  VALUES ('delete', old.id, old.title, old.artist);
  INSERT INTO tracks_fts(rowid, title, artist)
  VALUES (new.id, new.title, new.artist);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_duration ON tracks(duration_ms);
CREATE INDEX IF NOT EXISTS idx_isrc     ON tracks(isrc)  WHERE isrc  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mb_id    ON tracks(mb_id) WHERE mb_id IS NOT NULL;
