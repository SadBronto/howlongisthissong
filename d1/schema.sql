-- ============================================================
-- HowLongIsThisSong — Cloudflare D1 Schema
-- Run via: wrangler d1 execute howlongisthissong --file=d1/schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS tracks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  artist         TEXT,
  album          TEXT,
  duration_ms    INTEGER NOT NULL,
  disambiguation TEXT,        -- "live", "radio edit", "demo", etc.
  isrc           TEXT,        -- International Standard Recording Code
  release_year   INTEGER,
  mb_id          TEXT UNIQUE  -- MusicBrainz recording GUID
);

-- Full-text search index (title + artist + album)
-- content table = FTS reads data from tracks, not stored twice
-- tokenize='porter ascii' = stemming so "loving" finds "love", etc.
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
  title,
  artist,
  album,
  content='tracks',
  content_rowid='id',
  tokenize='porter ascii'
);

-- Keep FTS in sync on insert
CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album)
  VALUES (new.id, new.title, new.artist, new.album);
END;

-- Keep FTS in sync on delete
CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
  VALUES ('delete', old.id, old.title, old.artist, old.album);
END;

-- Keep FTS in sync on update
CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
  VALUES ('delete', old.id, old.title, old.artist, old.album);
  INSERT INTO tracks_fts(rowid, title, artist, album)
  VALUES (new.id, new.title, new.artist, new.album);
END;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_duration ON tracks(duration_ms);
CREATE INDEX IF NOT EXISTS idx_isrc     ON tracks(isrc)  WHERE isrc  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mb_id    ON tracks(mb_id) WHERE mb_id IS NOT NULL;
