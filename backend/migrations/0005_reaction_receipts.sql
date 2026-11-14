-- Keep delivery receipts even when a like/dislike is undone. An old retry
-- must not resurrect a reaction that the listener already removed.
CREATE TABLE reaction_receipts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id,event_id)
);
INSERT OR IGNORE INTO reaction_receipts(user_id,event_id)
SELECT user_id,event_id FROM interactions WHERE event_id IS NOT NULL;
