#!/usr/bin/env bash
# webmux installer — sets up the web terminal as a background service.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/samoylenkodmitry/webmux/main/install.sh | bash
#   ./install.sh            (from a checkout)
# Env: WEBMUX_DIR, HOST (127.0.0.1), PORT (8083), WEBMUX_NONINTERACTIVE=1 (no prompts).
set -euo pipefail

APP="webmux"
REPO="https://github.com/samoylenkodmitry/webmux"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8083}"
TTYDEV=/dev/tty

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Prompts work even under `curl | bash` by reading the controlling terminal.
interactive() {
  [ "${WEBMUX_NONINTERACTIVE:-0}" = 1 ] && return 1
  [ -e "$TTYDEV" ] && [ -r "$TTYDEV" ] && [ -w "$TTYDEV" ]
}
ask_yn() { # prompt, default(Y/N) -> exit 0 = yes
  local p="$1" d="${2:-Y}" a=""
  if ! interactive; then [ "$d" = Y ]; return; fi
  printf '%s ' "$p" > "$TTYDEV"
  IFS= read -r a < "$TTYDEV" || a=""
  [ -z "$a" ] && a="$d"
  case "$a" in [Yy]*) return 0 ;; *) return 1 ;; esac
}
choose() { # prompt, newline-separated options -> echoes the picked option
  local prompt="$1" opts="$2" first n pick
  first="$(printf '%s\n' "$opts" | sed -n '1p')"
  if ! interactive; then printf '%s\n' "$first"; return; fi
  { printf '%s\n' "$prompt"
    printf '%s\n' "$opts" | nl -w2 -s') '
    printf 'choice [1]: '; } > "$TTYDEV"
  IFS= read -r n < "$TTYDEV" || n=1
  [ -z "$n" ] && n=1
  case "$n" in *[!0-9]*) n=1 ;; esac
  pick="$(printf '%s\n' "$opts" | sed -n "${n}p")"
  [ -n "$pick" ] && printf '%s\n' "$pick" || printf '%s\n' "$first"
}

# `curl | bash` runs a bare shell that may lack Homebrew on PATH, so tools like
# tmux/node wouldn't be found. Make sure the usual install dirs are visible.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

resolve_tmux() {
  TMUX_BIN="$(command -v tmux 2>/dev/null || true)"
  if [ -z "$TMUX_BIN" ]; then
    for c in /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux /home/linuxbrew/.linuxbrew/bin/tmux; do
      [ -x "$c" ] && { TMUX_BIN="$c"; break; }
    done
  fi
}
install_tmux() {
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { warn "Homebrew not found — install it from https://brew.sh, then: brew install tmux"; return 1; }
      brew install tmux ;;
    Linux)
      if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y tmux
      elif command -v dnf     >/dev/null 2>&1; then sudo dnf install -y tmux
      elif command -v pacman  >/dev/null 2>&1; then sudo pacman -S --noconfirm tmux
      elif command -v zypper  >/dev/null 2>&1; then sudo zypper install -y tmux
      elif command -v apk     >/dev/null 2>&1; then sudo apk add tmux
      else warn "No known package manager — install tmux manually."; return 1; fi ;;
    *) warn "Auto-install unsupported on this OS."; return 1 ;;
  esac
}
detect_terminals() { # echo installed terminal tokens, one per line
  if [ "$(uname -s)" = Darwin ]; then
    { [ -d /Applications/Ghostty.app ] || [ -d "$HOME/Applications/Ghostty.app" ]; } && echo ghostty
    [ -d /Applications/iTerm.app ] && echo iterm
    echo terminal
  else
    for t in ghostty kitty alacritty wezterm foot gnome-terminal konsole xterm; do
      command -v "$t" >/dev/null 2>&1 && echo "$t"
    done
  fi
  return 0
}

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
command -v git >/dev/null 2>&1 || [ -n "$SRC" ] || die "git is required to fetch the source"

# tmux: offer to install if missing
resolve_tmux
if [ -z "$TMUX_BIN" ]; then
  if ask_yn "tmux is required but not installed. Install it now? [Y/n]" Y; then
    install_tmux && resolve_tmux || warn "tmux install did not complete."
  fi
fi
[ -z "$TMUX_BIN" ] && warn "Continuing without tmux — webmux won't work until it's installed; re-run this installer afterwards."

# desktop terminal: let the user pick which installed one to open sessions in
TERMLIST="$(detect_terminals)"
DESKTOP_TERMINAL_CHOICE=""
if [ -n "$TERMLIST" ]; then
  DESKTOP_TERMINAL_CHOICE="$(choose "Which terminal should 'New' open on this machine's desktop?" "$TERMLIST")"
  say "Desktop terminal for 'New': $DESKTOP_TERMINAL_CHOICE"
fi

if [ -n "$SRC" ]; then
  DIR="$SRC"; say "Using checkout at $DIR"
else
  DIR="${WEBMUX_DIR:-$HOME/.local/share/$APP}"
  if [ -d "$DIR/.git" ]; then say "Updating $DIR"; git -C "$DIR" pull --ff-only --quiet || true
  else say "Cloning into $DIR"; git clone --depth 1 "$REPO" "$DIR"; fi
fi

cd "$DIR"
say "Installing dependencies (builds node-pty, vendors xterm.js)…"
npm install --no-fund --no-audit
NODE_BIN="$(command -v node)"

# A service starts with a minimal PATH that often misses Homebrew, so bake a good
# PATH and the resolved tmux path in.
SVC_PATH="$(dirname "$NODE_BIN")"
[ -n "$TMUX_BIN" ] && SVC_PATH="$SVC_PATH:$(dirname "$TMUX_BIN")"
SVC_PATH="$SVC_PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TMUX_BIN="${TMUX_BIN:-tmux}"

DT_SYSTEMD=""; DT_PLIST=""
if [ -n "$DESKTOP_TERMINAL_CHOICE" ]; then
  DT_SYSTEMD="Environment=DESKTOP_TERMINAL=$DESKTOP_TERMINAL_CHOICE"
  DT_PLIST="    <key>DESKTOP_TERMINAL</key><string>$DESKTOP_TERMINAL_CHOICE</string>"
fi

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
$DT_SYSTEMD
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
$DT_PLIST
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
