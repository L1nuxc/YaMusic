# YaMusic production deployment

Site: https://yamusic.pigboss.xyz

- Ubuntu 24.04 x64; source `/opt/yamusic/app`, executable `/opt/yamusic/bin/yamusic-server`.
- Service `yamusic.service`, unprivileged user `yamusic`, API bound to 127.0.0.1:8000.
- Caddy proxies the domain, obtains and renews Let's Encrypt TLS, redirects HTTP to HTTPS.
- Secrets in `/etc/yamusic/env` (root 0600). Never upload the local Happ `.env`.
- SQLite and audio in `/opt/yamusic/data`. Database migrated from a consistent SQLite snapshot; old signed media links expired. Audio cache is regenerated on the VPS.
- `YT_DLP_PATH=/opt/yamusic/bin/ytdlp-audio`, PyPI yt-dlp[default] 2026.10.26 and yt-dlp-ejs 0.8.0. Node 24 installed for JS runtime.
- Cache budget 2 GB, AUDIO_FOREGROUND_WORKERS=1, AUDIO_BACKGROUND_WORKERS=1. 3 GB swap for the 1 GB RAM VPS.
- Native model setup: `cd /opt/yamusic/app && node scripts/setup-analysis.mjs`.

Update source and client/dist, then build with `CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 cargo build --release --locked --manifest-path backend/Cargo.toml`. Install the binary with `deploy/activate.sh`.

Spotify import uses `SPOTIFY_CLIENT_ID` from the Spotify Developer Dashboard. Register `https://yamusic.pigboss.xyz/api/import/spotify/callback` as the exact redirect URI. The authorization flow uses PKCE and needs no client secret. Google Translation and DeepL use `GOOGLE_TRANSLATE_API_KEY` and `DEEPL_API_KEY` respectively. Store these values in `/etc/yamusic/env` and restart the service.

Operational checks: `systemctl status yamusic caddy`, `journalctl -u yamusic`, `curl https://yamusic.pigboss.xyz/api/health`.

Telegram config uses TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and PUBLIC_ORIGIN. Widget authentication verifies Telegram HMAC and five-minute freshness, stores only session token hashes, prevents payload replay, uses HttpOnly/Secure/SameSite=Lax cookies and checks request Origin. `/auth/me` is not cacheable. Signed-in recommendations use the verified session, not the browser-supplied profile ID. Likes/playlists/settings remain local to the browser; cloud library sync is not implemented.

The pinned audio-only Python launcher skips SoundCloud original-artwork HEAD probing (other artwork variants and every audio field/validation remain intact). This avoids a measured 20-27s lookup stall; the profile cover comes from Deezer. No third-party package files are modified.
