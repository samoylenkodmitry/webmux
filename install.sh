#!/usr/bin/env bash
# webmux installer — sets up the web terminal as a background service.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/samoylenkodmitry/webmux/main/install.sh | bash
#   ./install.sh            (from a checkout)
# Env overrides: WEBMUX_DIR, HOST (127.0.0.1), PORT (8083).
set -euo pipefail

APP="webmux"
REPO="https://github.com/samoylenkodmitry/webmux"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8083}"

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- locate or fetch the source ------------------------------------------
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$d/server.js" ] && SRC="$d"
fi
[ -z "$SRC" ] && [ -f "$PWD/server.js" ] && SRC="$PWD"

# --- prerequisites --------------------------------------------------------
miss=0
for c in node npm; do command -v "$c" >/dev/null 2>&1 || { warn "missing required: $c"; miss=1; }; done
[ "$miss" = 0 ] || die "install Node.js (>=18) and re-run. See https://nodejs.org"
command -v git  >/dev/null 2>&1 || [ -n "$SRC" ] || die "git is required to fetch the source"
command -v tmux >/dev/null 2>&1 || warn "tmux not found — it is required at runtime (install it with your package manager)"

if [ -n "$SRC" ]; then
  DIR="$SRC"
  say "Using checkout at $DIR"
else
  DIR="${WEBMUX_DIR:-$HOME/.local/share/$APP}"
  if [ -d "$DIR/.git" ]; then say "Updating $DIR"; git -C "$DIR" pull --ff-only --quiet || true
  else say "Cloning into $DIR"; git clone --depth 1 "$REPO" "$DIR"; fi
fi

cd "$DIR"
say "Installing dependencies (builds node-pty, vendors xterm.js)…"
npm install --no-fund --no-audit
NODE_BIN="$(command -v node)"
TMUX_BIN="$(command -v tmux || true)"

# A service (systemd/launchd) starts with a minimal PATH that often misses
# Homebrew (/opt/homebrew/bin) — where tmux/node/ghostty live. Bake a good PATH
# and the resolved tmux path so the service can actually find tmux.
SVC_PATH="$(dirname "$NODE_BIN")"
[ -n "$TMUX_BIN" ] && SVC_PATH="$SVC_PATH:$(dirname "$TMUX_BIN")"
SVC_PATH="$SVC_PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TMUX_BIN="${TMUX_BIN:-tmux}"

# --- service setup --------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      UNIT="$HOME/.config/systemd/user/$APP.service"
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<EOF
[Unit]
Description=webmux — web terminal for tmux sessions
After=graphical-session.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=HOST=$HOST
Environment=PORT=$PORT
Environment=PATH=$SVC_PATH
Environment=TMUX_BIN=$TMUX_BIN
# Desktop window emulator for sessions started from the web (must accept -e <cmd>):
# Environment=DESKTOP_TERMINAL=ghostty
ExecStart=$NODE_BIN $DIR/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now "$APP.service"
      say "systemd user service '$APP' enabled and started."
      echo "   manage: systemctl --user {status,restart,stop} $APP   logs: journalctl --user -u $APP -f"
    else
      MANUAL=1
    fi
    ;;
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.$APP.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.$APP</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOST</key><string>$HOST</string>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>$SVC_PATH</string>
    <key>TMUX_BIN</key><string>$TMUX_BIN</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    say "launchd agent 'com.$APP' loaded and started."
    echo "   manage: launchctl {unload,load} $PLIST"
    ;;
  *) MANUAL=1 ;;
esac

if [ "${MANUAL:-0}" = 1 ]; then
  warn "No supported service manager detected. Run it manually:"
  echo "   cd $DIR && HOST=$HOST PORT=$PORT npm start"
fi

cat <<EOF

$APP is up on http://$HOST:$PORT
Expose it to your other devices (recommended: Tailscale, keeps it private):
   tailscale serve --bg $PORT
Then open the printed https URL on your phone and "Add to Home Screen".
EOF
