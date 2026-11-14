CREATE TABLE playback_resume (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    context TEXT,
    queue_json TEXT NOT NULL,
    captured_at INTEGER NOT NULL
);
CREATE TABLE lyrics_translations (
    track_id TEXT NOT NULL REFERENCES lyrics_cache(track_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    translated_lrc TEXT NOT NULL,
    PRIMARY KEY (track_id, provider)
);
