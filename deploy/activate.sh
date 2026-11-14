#!/bin/bash
set -euo pipefail
cd /opt/yamusic/app
install -m 755 backend/target/release/yamusic-server /opt/yamusic/bin/yamusic-server.next
mv -f /opt/yamusic/bin/yamusic-server.next /opt/yamusic/bin/yamusic-server
install -m 755 deploy/ytdlp-audio.py /opt/yamusic/bin/ytdlp-audio
if [ ! -e /opt/yamusic/app/data ]; then ln -s /opt/yamusic/data /opt/yamusic/app/data; fi
chmod -R go-w /opt/yamusic/app
chown -R yamusic:yamusic /opt/yamusic/data /opt/yamusic/.cache
chmod -R o-rwx /opt/yamusic/data
chmod -R g-w /opt/yamusic/data
chmod 750 /opt/yamusic
systemctl daemon-reload
systemctl enable --now yamusic
systemctl restart yamusic
for attempt in $(seq 1 30); do
 if curl -fsS http://127.0.0.1:8000/api/health; then break; fi
 sleep 1
done
curl -fsS https://yamusic.pigboss.xyz/api/health
