CREATE TABLE personal_mixes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    period TEXT NOT NULL,
    title TEXT NOT NULL,
    track_ids_json TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, period)
);
