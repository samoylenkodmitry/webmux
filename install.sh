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

# Strip a "# >>> NAME >>>" … "# <<< NAME <<<" block from a file so the
# installer can refresh its content on re-run (older installs may have stale
# settings inside the block).
remove_block() {
  local file="$1" name="$2"
  [ -f "$file" ] || return 0
  local tmp; tmp="$(mktemp)" || return 1
  sed -E "/^# >>> ${name} >>>\$/,/^# <<< ${name} <<<\$/d" "$file" \
    | awk '/./{ if(b)print""; b=0; print; next } /^$/{ b=1 }' > "$tmp"
  mv "$tmp" "$file"
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
  return 0  # never fail (a failed probe must not trip `set -e` and skip prompts)
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
# Optionally make every interactive shell join tmux, so terminals opened normally
# (Ghostty from the dock, etc.) show up in webmux. Idempotent; opt-in.
setup_autostart() {
  local rc had=0
  case "${SHELL##*/}" in zsh) rc="$HOME/.zshrc" ;; bash) rc="$HOME/.bashrc" ;; *) rc="$HOME/.zshrc" ;; esac
  if grep -q 'webmux tmux autostart' "$rc" 2>/dev/null; then
    had=1
  elif grep -qE 'phone-terminal-tmux-autostart|exec tmux new-session' "$rc" 2>/dev/null; then
    warn "An existing tmux autostart is already in $rc — leaving it untouched."; return 0
  fi
  # Self-heal: drop any older webmux block (e.g. one with the old kill-on-detach
  # variant) before writing the current persistent one.
  remove_block "$rc" "webmux tmux autostart"
  # Sessions are persistent: closing the terminal leaves the session detached so
  # you can re-attach from webmux. (A previous version offered a "kill on detach"
  # mode via `destroy-unattached on`; that reaped sessions out from under their
  # own terminal and is intentionally gone.)
  cat >> "$rc" <<'RC'

# >>> webmux tmux autostart >>>
# Join a uniquely-named tmux session in interactive shells so terminals opened
# normally appear in webmux. Remove this block to disable.
if command -v tmux >/dev/null 2>&1 && [ -z "${TMUX:-}" ] && [ -z "${SSH_CONNECTION:-}" ]; then
  case "$-" in
    *i*)
      __wm=$(basename "$PWD"); [ "$PWD" = "$HOME" ] && __wm=home
      __wm=$(printf '%s' "$__wm" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | tr -s '-' | sed -e 's/^[-_]*//' -e 's/[-_]*$//')
      [ -n "$__wm" ] || __wm=shell
      __wm_b=$__wm; __wm_i=2
      while tmux has-session -t "=$__wm" 2>/dev/null; do __wm="$__wm_b-$__wm_i"; __wm_i=$((__wm_i + 1)); done
      exec tmux new-session -s "$__wm"
      ;;
  esac
fi
# <<< webmux tmux autostart <<<
RC
  if [ "$had" = 1 ]; then
    say "Refreshed webmux tmux autostart in $rc"
  else
    say "Added tmux autostart to $rc — open a new terminal window for it to take effect."
  fi
}
# Hide tmux's status bar + enable system-clipboard copy. Re-run rewrites the
# block so older settings (e.g. the previous `mouse on`) are dropped.
setup_tmux_tweaks() {
  local conf="$HOME/.tmux.conf" had=0
  grep -q 'webmux tmux tweaks' "$conf" 2>/dev/null && had=1
  remove_block "$conf" "webmux tmux tweaks"
  cat >> "$conf" <<'RC'

# >>> webmux tmux tweaks >>>
set -g status off        # hide tmux's status bar (clean terminal)
set -g set-clipboard on  # let copy reach the system clipboard
# <<< webmux tmux tweaks <<<
RC
  if [ "$had" = 1 ]; then
    say "Refreshed webmux tmux tweaks in $conf"
  else
    say "Added webmux tmux tweaks to $conf"
  fi
  # Apply to the running server — and revert prior installer's `mouse on`.
  tmux set -g status off       2>/dev/null || true
  tmux set -g set-clipboard on 2>/dev/null || true
  tmux set -g mouse  off       2>/dev/null || true
}
install_tailscale() {
  case "$(uname -s)" in
    Darwin)
      command -v brew >/dev/null 2>&1 || { warn "Install Homebrew or get Tailscale at https://tailscale.com/download"; return 1; }
      brew install --cask tailscale ;;
    Linux) curl -fsSL https://tailscale.com/install.sh | sh ;;
    *) warn "See https://tailscale.com/download"; return 1 ;;
  esac
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

# tmux look: offer to hide the status bar (cleaner terminals)
if [ -n "$TMUX_BIN" ] && ask_yn "Customize tmux to hide its status bar (cleaner terminals)? [y/N]" N; then
  setup_tmux_tweaks
fi

# desktop terminal: let the user pick which installed one to open sessions in
TERMLIST="$(detect_terminals)"
DESKTOP_TERMINAL_CHOICE=""
if [ -n "$TERMLIST" ]; then
  DESKTOP_TERMINAL_CHOICE="$(choose "Which terminal should 'New' open on this machine's desktop?" "$TERMLIST")"
  say "Desktop terminal for 'New': $DESKTOP_TERMINAL_CHOICE"
fi

# Offer to make all normally-opened terminals show up in webmux (auto-tmux).
if ask_yn "Make terminals you open normally show up in webmux too (auto-start tmux in new shells)? [y/N]" N; then
  setup_autostart
fi

# Tailscale: offer to install it for private remote access from your phone.
if ! command -v tailscale >/dev/null 2>&1 && [ ! -d /Applications/Tailscale.app ]; then
  if ask_yn "Install Tailscale for private access from your phone? [y/N]" N; then
    if install_tailscale; then
      say "Tailscale installed. Log in (open the app, or 'tailscale up'), then: tailscale serve --bg $PORT"
    else
      warn "Tailscale install didn't complete — see https://tailscale.com/download"
    fi
  fi
fi

# Tailscale UI integration: when tailscale is around, offer to show this node's
# `tailscale serve` URL in the picker (handy for opening webmux on your phone).
# Opt-in keeps webmux from invoking `tailscale` for users who don't want it.
WEBMUX_TAILSCALE_ENABLED=
TAILSCALE_PRESENT=0
for c in "$HOME/.local/bin/tailscale" /opt/homebrew/bin/tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  [ -x "$c" ] && TAILSCALE_PRESENT=1 && break
done
command -v tailscale >/dev/null 2>&1 && TAILSCALE_PRESENT=1
if [ "$TAILSCALE_PRESENT" = 1 ]; then
  if ask_yn "Show your Tailscale share URL (and other webmux instances on the tailnet) in the picker? [Y/n]" Y; then
    WEBMUX_TAILSCALE_ENABLED=1
  fi
fi

if [ -n "$SRC" ]; then
  DIR="$SRC"; say "Using checkout at $DIR"
else
  DIR="${WEBMUX_DIR:-$HOME/.local/share/$APP}"
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    # Force to the latest published commit. `git pull --ff-only` fails (silently)
    # when the working tree is dirty — and `npm install` rewrites the committed
    # package-lock.json, so a plain pull would never update. fetch + reset is the
    # robust "deploy" that discards such churn (node_modules/vendor are ignored).
    if git -C "$DIR" fetch --depth 1 --quiet origin main 2>/dev/null; then
      git -C "$DIR" reset --hard --quiet origin/main 2>/dev/null || warn "couldn't reset $DIR; using existing copy"
    else
      warn "couldn't fetch updates for $DIR; using existing copy"
    fi
  else
    say "Cloning into $DIR"; git clone --depth 1 "$REPO" "$DIR"
  fi
fi

cd "$DIR"
say "Installing dependencies (builds node-pty, vendors xterm.js)…"
npm install --no-fund --no-audit
NODE_BIN="$(command -v node)"

# node-pty's prebuilt bindings (both 1.0 and 1.1) fail with "posix_spawnp failed"
# on bleeding-edge Node/macOS combos (seen with Node 26 + macOS 26). The list
# API still works because it uses child_process; only pty.spawn breaks, so the
# picker shows sessions but attach silently fails. Verify the binding actually
# spawns; if not, rebuild from source against the current Node ABI.
if ! "$NODE_BIN" -e 'try{require("./node_modules/node-pty").spawn("/bin/sh",["-c",":"],{name:"xterm",cols:80,rows:24,cwd:process.env.HOME||"/",env:process.env});}catch(e){process.exit(1)}' >/dev/null 2>&1; then
  say "Rebuilding node-pty from source (prebuilt binding doesn't work on this Node/OS)…"
  ( cd node_modules/node-pty && npx --yes node-gyp rebuild ) \
    || warn "node-pty rebuild failed. Install a C++ toolchain (macOS: xcode-select --install; Debian/Ubuntu: build-essential) and re-run."
fi

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
TS_SYSTEMD=""; TS_PLIST=""
if [ "$WEBMUX_TAILSCALE_ENABLED" = 1 ]; then
  TS_SYSTEMD="Environment=WEBMUX_TAILSCALE=1"
  TS_PLIST="    <key>WEBMUX_TAILSCALE</key><string>1</string>"
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
$TS_SYSTEMD
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
$TS_PLIST
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
