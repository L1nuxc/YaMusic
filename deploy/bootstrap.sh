#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 3G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
id yamusic >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/yamusic --shell /usr/sbin/nologin yamusic
install -d -o yamusic -g yamusic /opt/yamusic/app /opt/yamusic/bin /opt/yamusic/data /etc/yamusic
if ! command -v node >/dev/null; then
 curl -fsSL https://nodejs.org/dist/index.json -o /tmp/node-index.json
 node_version=$(python3 -c 'import json; print(next(r["version"] for r in json.load(open("/tmp/node-index.json")) if r["version"].startswith("v24.")))')
 curl -fsSL "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz" -o /tmp/node.tar.xz
 curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o /tmp/node-checksums
 cd /tmp
 grep " node-$node_version-linux-x64.tar.xz$" node-checksums | sed 's|node-.*-linux-x64.tar.xz$|node.tar.xz|' | sha256sum --check
 tar -xJf node.tar.xz -C /usr/local --strip-components=1
fi
if ! command -v caddy >/dev/null; then
 curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
 curl -1fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
 chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
 apt-get update -qq
 apt-get install -y --no-install-recommends caddy
fi
if [ ! -x /root/.cargo/bin/cargo ]; then
 curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup.sh
 sh /tmp/rustup.sh -y --profile minimal
fi
python3 -m venv /opt/yamusic/yt-env
/opt/yamusic/yt-env/bin/pip install 'yt-dlp[default]==2026.10.26' 'yt-dlp-ejs==0.8.0'
cat >/etc/caddy/Caddyfile <<'CADDY'
yamusic.pigboss.xyz {
 encode zstd gzip
 header {
  X-Content-Type-Options nosniff
  Referrer-Policy strict-origin-when-cross-origin
 }
 reverse_proxy 127.0.0.1:8000
}
CADDY
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy
node --version
/root/.cargo/bin/cargo --version
