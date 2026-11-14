ALTER TABLE lyrics_cache ADD COLUMN plain_lyrics TEXT;
ALTER TABLE lyrics_cache ADD COLUMN instrumental INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lyrics_cache ADD COLUMN provider_id INTEGER;
ALTER TABLE lyrics_cache ADD COLUMN fetched_at TEXT;
ALTER TABLE audio_cache ADD COLUMN content_type TEXT NOT NULL DEFAULT 'audio/mpeg';
ALTER TABLE audio_cache ADD COLUMN source_title TEXT NOT NULL DEFAULT '';
ALTER TABLE audio_cache ADD COLUMN duration_sec REAL;
