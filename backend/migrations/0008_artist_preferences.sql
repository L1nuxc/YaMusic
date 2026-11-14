CREATE TABLE favorite_artists (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    artist_id INTEGER NOT NULL REFERENCES catalog_artists(id),
    position INTEGER NOT NULL,
    PRIMARY KEY(user_id, artist_id)
);
-- Editorial origin is explicit: Russian-language discovery is not inferred
-- from an artist's spelling, the listener's address, or a global chart.
CREATE TABLE editorial_artists (
    query TEXT PRIMARY KEY,
    artist_id INTEGER NOT NULL REFERENCES catalog_artists(id)
);
CREATE TABLE editorial_tracks (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE
);
-- A changed candidate policy must not reuse yesterday's global cold start.
DELETE FROM daily_mixes;
