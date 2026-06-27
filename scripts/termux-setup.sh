#!/data/data/com.termux/files/usr/bin/bash
# webmux on Android (Termux) — run tmux / Claude Code on the phone and reach it
# from any other webmux on your tailnet, where it appears as a machine card just
# like a PC.
#
# Prerequisites (install the F-Droid / GitHub builds, NOT the old Play Store one):
#   • Termux        + Termux:API  + Termux:Boot
#   • The Tailscale Android app, signed in (gives this phone its 100.x tailnet IP)
#
# Then, in Termux:   bash termux-setup.sh
#
# It binds webmux to the phone's Tailscale IP ONLY (never 0.0.0.0) — webmux has no
# auth, so it must be reachable only over the tailnet, exactly like on a PC.
set -e
say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }

DIR="${WEBMUX_DIR:-$HOME/webmux}"
PORT="${PORT:-8083}"
REPO="https://github.com/samoylenkodmitry/webmux"

say "Installing packages (node, tmux, build tools)…"
pkg update -y
# binutils: node-pty's native build needs `strip`/`ld`. termux-api: the wake-lock
# below. ripgrep: Claude Code shells out to it.
pkg install -y nodejs-lts tmux git python clang make binutils termux-api ripgrep

say "Fetching webmux into $DIR…"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only || true
else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

say "Installing deps (this builds node-pty from source)…"
# node-pty's native build is the most fragile part on Termux. Two Termux-specific
# fixes, both verified on a Galaxy Tab S7+ (Android 13, aarch64):
#   1) node-gyp aborts with "Undefined variable android_ndk_path in binding.gyp"
#      unless the NDK path is pointed at Termux's prefix.
npm config set android_ndk_path "${PREFIX:-/data/data/com.termux/files/usr}"
#   2) If npm still fails, it's the native build; the end note has the retry.
npm install --no-fund --no-audit || warn "npm install failed — almost always node-pty's native build (see note below)."

# Find this phone's Tailscale IP (CGNAT range 100.64.0.0/10) and bind ONLY to it.
TSIP="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
  | grep -E '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' | head -1)"
if [ -z "$TSIP" ]; then
  warn "No Tailscale IP found (looked for a 100.x address). Open the Tailscale app,"
  warn "connect, then re-run this script."
  exit 1
fi
say "Tailnet IP: $TSIP  →  webmux will listen on http://$TSIP:$PORT (tailnet-only)"

# Claude Code on the phone, so you can run it here and steer it remotely. Claude 2.x
# ships a glibc native binary with NO Android build, so it can't run in bare Termux
# ("claude native binary not installed"). We give it a real glibc userland via proot
# instead: webmux + node-pty stay native in Termux (fast), only Claude runs inside
# Debian. Verified running current Claude (2.1.x) on a Galaxy Tab S7+ this way.
CLAUDE_DISTRO="${WEBMUX_CLAUDE_DISTRO:-debian}"
CLAUDE_CMD=""
if command -v proot-distro >/dev/null 2>&1 || pkg install -y proot-distro; then
  if ! proot-distro list 2>/dev/null | grep -qiE "$CLAUDE_DISTRO.*installed"; then
    say "Installing a $CLAUDE_DISTRO userland (proot) for current Claude Code…"
    proot-distro install "$CLAUDE_DISTRO" || warn "proot-distro install $CLAUDE_DISTRO failed."
  fi
  if proot-distro list 2>/dev/null | grep -qiE "$CLAUDE_DISTRO.*installed"; then
    say "Installing current Claude Code inside $CLAUDE_DISTRO…"
    proot-distro login "$CLAUDE_DISTRO" -- bash -lc '
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y >/dev/null 2>&1
      apt-get install -y nodejs npm ca-certificates >/dev/null 2>&1
      command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code
    ' && CLAUDE_CMD="proot-distro login $CLAUDE_DISTRO -- bash -lc 'cd ~ && exec claude'" \
      || warn "Claude install inside $CLAUDE_DISTRO failed; retry later."
  fi
else
  warn "proot-distro unavailable; skipping Claude (webmux itself still works)."
fi

# Keep the CPU awake so Android doesn't suspend webmux in the background.
if command -v termux-wake-lock >/dev/null 2>&1; then termux-wake-lock
else warn "termux-wake-lock missing (install Termux:API) — Android may kill webmux when backgrounded."; fi

# Start webmux detached (survives this script). It runs on its own tmux server so
# every tmux session you create — including one running 'claude' — shows up.
pkill -f "node $DIR/server.js" 2>/dev/null || true
nohup env HOST="$TSIP" PORT="$PORT" node "$DIR/server.js" >"$HOME/webmux.log" 2>&1 &
sleep 1
# Starter sessions so the picker isn't empty. A plain phone shell, plus — if Claude
# installed — a 'claude' session running current Claude inside the proot userland.
# Open either from any webmux; the claude one drops you at Claude's prompt.
tmux has-session -t phone 2>/dev/null || tmux new-session -d -s phone
if [ -n "$CLAUDE_CMD" ]; then
  tmux has-session -t claude 2>/dev/null || tmux new-session -d -s claude -x 110 -y 40 "$CLAUDE_CMD"
fi

cat <<EOF

$(say "webmux is up on http://$TSIP:$PORT")
  • It will appear in your other machines' webmux pickers as this phone, as long
    as the coordinator runs a build with HTTP-peer discovery.
  • Logs: ~/webmux.log   ·   tmux: 'tmux attach'

Auto-start on boot (recommended): with Termux:Boot installed,
    mkdir -p ~/.termux/boot && cp "$0" ~/.termux/boot/00-webmux.sh

If 'npm install' failed on node-pty, that's the known Termux snag. Options:
  • retry after:  pkg install binutils && npm rebuild node-pty
  • or run a real userland with proot ('pkg install proot-distro; proot-distro
    install debian') and run webmux inside it.
EOF
