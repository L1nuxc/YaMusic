#!/bin/bash
set -euo pipefail
curl -fSs --max-time 60 -o /tmp/raspyat.audio -w 'raspyat_http=%{http_code} bytes=%{size_download} seconds=%{time_total}\n' https://yamusic.pigboss.xyz/api/stream/deezer_3252782331
python3 - <<'PY'
import sqlite3
c=sqlite3.connect('/opt/yamusic/data/yamusic.db')
print(c.execute('select source_type,source_url,source_title,duration_sec from audio_cache where track_id=?',('deezer_3252782331',)).fetchone())
PY
ffprobe -v error -show_entries format=duration:stream=codec_name -of json /tmp/raspyat.audio
ffmpeg -v error -i /tmp/raspyat.audio -f null -
curl -fSs -H 'Range: bytes=1000-2023' -o /tmp/raspyat-range.bin -w 'range_http=%{http_code} bytes=%{size_download} seconds=%{time_total}\n' https://yamusic.pigboss.xyz/api/stream/deezer_3252782331
