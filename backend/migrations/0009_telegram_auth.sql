CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX auth_session_expiry ON auth_sessions(expires_at);
CREATE TABLE auth_login_receipts (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
