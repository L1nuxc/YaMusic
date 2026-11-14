CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    deezer_id INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    artist_id INTEGER NOT NULL,
    album TEXT NOT NULL,
    album_id INTEGER NOT NULL,
    cover_url TEXT NOT NULL DEFAULT '',
    duration_sec INTEGER NOT NULL CHECK (duration_sec >= 0),
    is_explicit INTEGER NOT NULL DEFAULT 0 CHECK (is_explicit IN (0,1)),
    preview_url TEXT NOT NULL DEFAULT '',
    embedding BLOB CHECK (embedding IS NULL OR length(embedding) = 2048),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE catalog_artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, picture_url TEXT NOT NULL DEFAULT '', data_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE catalog_albums (id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist_id INTEGER, cover_url TEXT NOT NULL DEFAULT '', data_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE audio_cache (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_url TEXT NOT NULL,
    local_file_path TEXT,
    file_size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (file_size_bytes >= 0),
    is_uncensored_score INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE interactions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL CHECK (action_type IN ('complete','like','early_skip','dislike')),
    listen_ratio REAL NOT NULL DEFAULT 0 CHECK (listen_ratio BETWEEN 0 AND 1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX interactions_user_time ON interactions(user_id, created_at);
CREATE TABLE user_taste_clusters (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cluster_index INTEGER NOT NULL CHECK (cluster_index BETWEEN 0 AND 4),
    centroid_vector BLOB NOT NULL CHECK (length(centroid_vector) = 2048),
    track_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, cluster_index)
);
CREATE TABLE lyrics_cache (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    synced_lrc TEXT,
    translated_lrc TEXT
);
CREATE TABLE llm_cache (prompt_hash TEXT PRIMARY KEY, response_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE playlists (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE playlist_tracks (playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, track_id TEXT NOT NULL REFERENCES tracks(id), position INTEGER NOT NULL, PRIMARY KEY(playlist_id, track_id));
CREATE TABLE user_track_flags (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, is_liked INTEGER NOT NULL DEFAULT 0, is_disliked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, track_id));
