CREATE TABLE audio_resolutions (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    candidate_json TEXT NOT NULL,
    source_url TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE audio_heads (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    stream_url TEXT NOT NULL,
    byte_len INTEGER NOT NULL,
    head_size INTEGER NOT NULL,
    last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
