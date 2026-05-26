<h1 align="center">webmux</h1>

<p align="center">
  <img src="public/icon.svg" width="84" alt="webmux">
</p>

<p align="center">A tiny self-hosted <b>web terminal for your tmux sessions</b> — attach to, create, and switch between terminals on your machine from any browser. Built for phones.</p>

---

Rendered with [xterm.js](https://xtermjs.org/); the backend bridges a WebSocket to `tmux attach` over a real PTY. Detaching the browser never kills your local terminal.

## What it does
- Lists your tmux sessions; attach, create, switch, or close them.
- Full terminal over WebSocket: input/output, resize, paste, scrollback, copy.
- **Mobile-first:** soft keys (Esc/Tab/Ctrl/arrows/`^C`…), keyboard-aware layout, touch scrolling, installable as a home-screen app (PWA), robust reconnect on wake/network change.
- **New sessions also open a real terminal window on your PC** and persist after the browser leaves — so they stay visible locally and you can always return to them.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/samoylenkodmitry/webmux/main/install.sh | bash
```

Installs a background service on `127.0.0.1:8083` (systemd user service on Linux, launchd agent on macOS). **Requires** Node ≥ 18, npm, tmux, and a C toolchain for the native PTY module (Linux: `base-devel`/`build-essential` + `python3`; macOS: Xcode Command Line Tools).

Then expose it privately to your other devices (recommended: [Tailscale](https://tailscale.com)):

```sh
tailscale serve --bg 8083
```

Open the printed `https://…ts.net` URL on your phone and **Add to Home Screen**.

## Configure

Set as environment variables (in the generated service file or your shell):

| var | default | meaning |
|-----|---------|---------|
| `HOST` | `127.0.0.1` | bind address |
| `PORT` | `8083` | port |
| `DESKTOP_TERMINAL` | `ghostty` | emulator for "open on PC" (must accept `-e <cmd>`) |
| `TERM_NAME` | `xterm-256color` | `TERM` for the PTY |

## Run from source

```sh
git clone https://github.com/samoylenkodmitry/webmux && cd webmux
npm install   # builds node-pty, vendors xterm.js into public/vendor
npm start     # http://127.0.0.1:8083
```

## Notes
- **Linux & macOS** supported. **Windows:** run under WSL (Linux from there).
- "Open on PC" is best-effort and Linux-focused; with no display it falls back to a browser-only session.
- Bind stays on localhost by design — put a private tunnel (Tailscale) in front rather than exposing the port.
- HTTP API: `GET /api/sessions`, `GET /api/capture`, `/api/windows`, `/api/kill`; WebSocket at `/ws/session/<name>` and `/ws/new`. See [`server.js`](server.js).

## License
MIT
