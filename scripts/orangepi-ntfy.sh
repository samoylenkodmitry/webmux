#!/usr/bin/env bash
# Stand up a self-hosted ntfy on this box as the WebMux fleet's wake relay
# (UnifiedPush). Tailnet-only, idempotent. Run ON the orange pi.
#
#   bash orangepi-ntfy.sh          # default port 2586
#   NTFY_PORT=2586 bash orangepi-ntfy.sh
set -euo pipefail

PORT="${NTFY_PORT:-2586}"
IP="$(tailscale ip -4 2>/dev/null | head -1 || hostname -I | awk '{print $1}')"
BASE="http://${IP}:${PORT}"

if ! command -v ntfy >/dev/null 2>&1; then
  echo "== installing ntfy (apt repo) =="
  sudo mkdir -p /etc/apt/keyrings
  curl -fsSL https://archive.ntfy.sh/apt/keyring.gpg | sudo gpg --dearmor -o /etc/apt/keyrings/archive.ntfy.sh.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/archive.ntfy.sh.gpg] https://archive.ntfy.sh/apt stable main" \
    | sudo tee /etc/apt/sources.list.d/archive.ntfy.sh.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y ntfy
fi

echo "== writing /etc/ntfy/server.yml (base-url ${BASE}) =="
sudo mkdir -p /etc/ntfy
sudo tee /etc/ntfy/server.yml >/dev/null <<EOF
# WebMux fleet wake relay (UnifiedPush). Reachable only over the tailnet.
base-url: "${BASE}"
listen-http: ":${PORT}"
behind-proxy: false
# Keep instant-delivery connections from idling out on mobile.
keepalive-interval: "45s"
EOF

sudo systemctl enable ntfy >/dev/null 2>&1 || true
sudo systemctl restart ntfy
sleep 1
echo "== ntfy: $(systemctl is-active ntfy) on ${BASE} =="
curl -fsS "${BASE}/v1/health" && echo
cat <<EOF

Next, per phone:
  1. Install the "ntfy" app (F-Droid or Play).
  2. ntfy app → Settings → Default server → ${BASE}
  3. WebMux Host → "Enable remote wake".
EOF
