CREATE TABLE device_profiles (
    profile_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE
);
ALTER TABLE interactions ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX interaction_event ON interactions(user_id,event_id) WHERE event_id IS NOT NULL;
CREATE TABLE wave_sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX wave_user ON wave_sessions(user_id,updated_at);
CREATE TABLE daily_mixes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    track_ids_json TEXT NOT NULL,
    personalized INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,day)
);
