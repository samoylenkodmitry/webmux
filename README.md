<h1 align="center">webmux</h1>


All terminals from all computers in a single place.

https://github.com/user-attachments/assets/f6fbf494-1de4-47cb-b80e-32f76660511e




<p align="center">
  <img src="public/icon.svg" width="84" alt="webmux">
</p>

<p align="center">A tiny self-hosted <b>web terminal for your tmux sessions</b> — attach to, create, and switch between terminals on your machine from any browser. Built for phones.</p>

<p align="center">
  <img src="docs/picker.png" alt="session picker" width="44%">
  &nbsp;&nbsp;
  <img src="docs/terminal.png" alt="terminal view" width="44%">
</p>

---

Rendered with [xterm.js](https://xtermjs.org/); the backend bridges a WebSocket to `tmux attach` over a real PTY. Detaching the browser never kills your local terminal.

## What it does
- Lists your tmux sessions; attach, create, switch, or close them.
- Full terminal over WebSocket: input/output, resize, paste, scrollback, copy.
- **Mobile-first:** soft keys (`/ Tab Esc ↑↓←→ Ctrl ^C …`), keyboard-aware layout, touch scrolling, installable as a home-screen app (PWA), robust reconnect on wake/network change.
- **New sessions also open a real terminal window on your PC** and persist after the browser leaves — so they stay visible locally and you can always return to them.
- **Recent directories:** when a session closes, its directory is remembered so you can start a fresh terminal there in one tap.
- **Live title:** the bar (and tab) shows the session's current command + directory.
- **Multiple machines:** optionally discovers other webmux instances on your [Tailscale](https://tailscale.com) tailnet and shows them as a row you can switch between — one app for all your boxes. The session switcher also lists **every machine's sessions, grouped by box** (each peer streams in as it answers, so your own appear instantly).
- **Compose bar:** a ✎ toggle opens a plain text field to type into and **Send** to the terminal — mobile keyboards' predictive text / T9 work there without the character-doubling that direct in-terminal typing can cause. Plus **Undo** (erase exactly what you last typed) and **Clr Ln** (^U) soft-keys.
- **One-tap update:** a menu button runs the installer one-liner on this PC **and every webmux box on your tailnet**, inside a tmux session you watch live as it self-updates and restarts.
- **Per-terminal font size:** each session remembers its own zoom.

## Why (the workflow)

Run your long-lived terminals — `claude`, `codex`, dev servers, builds, `htop` — in **tmux on your big machine**. Put webmux in front, reachable only over your private [Tailscale](https://tailscale.com) network. Now from your phone, anywhere:

1. Open the home-screen app → see every session with its live command/dir.
2. Tap one to jump in: read what your coding agent is doing, answer its prompt, approve a step, paste a fix, `^C` a runaway, scroll back through output.
3. Tap **＋ New** (or a recent dir) to start a fresh session — a **real Ghostty/Terminal window opens on the PC too**, so when you're back at the desk it's right there, exactly where the phone left it.

Because every session lives in tmux on the PC, nothing is lost when the phone disconnects, sleeps, or switches networks — webmux just re-attaches. It's "check on and steer the agents running at home, from the train."

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/samoylenkodmitry/webmux/main/install.sh | bash
```

Installs a background service on `127.0.0.1:8083` (systemd user service on Linux, launchd agent on macOS). It's **interactive**: it offers to install `tmux` if missing, lets you choose which installed terminal **New** opens on the desktop, and can optionally auto-start tmux in new shells so terminals you open normally also appear in webmux. **Requires** Node ≥ 18, npm, and a C toolchain for the native PTY module (Linux: `base-devel`/`build-essential` + `python3`; macOS: Xcode Command Line Tools). Set `WEBMUX_NONINTERACTIVE=1` to accept defaults silently.

The installer can also configure the private Tailscale share for you. If you
skip that prompt, expose it manually:

```sh
tailscale serve --bg 8083
```

Open the printed `https://…ts.net` URL on your phone and **Add to Home Screen**.

## Configure

Environment variables (set in the generated service file or your shell):

| var | default | meaning |
|-----|---------|---------|
| `HOST` | `127.0.0.1` | bind address |
| `PORT` | `8083` | port |
| `DESKTOP_TERMINAL` | ghostty (Linux) · Terminal.app (macOS) | emulator for "open on PC"; set to any that accepts `-e <cmd>` |
| `TERM_NAME` | `xterm-256color` | `TERM` for the PTY |
| `TMUX_SOCKET` | — | target a specific `tmux -L <name>` server |
| `WEBMUX_STATE` | `~/.local/state/webmux` | where recent-directory history is stored |
| `WEBMUX_TAILSCALE` | unset | `1` shows this node's share state + other tailnet webmux instances in the picker |

## Run from source

```sh
git clone https://github.com/samoylenkodmitry/webmux && cd webmux
npm install   # builds node-pty, vendors xterm.js into public/vendor
npm start     # http://127.0.0.1:8083
```

## Security

webmux has **no authentication** — anyone who can reach the port gets a shell as you. That's intentional and safe *only* because it binds to `127.0.0.1` and you expose it through your private Tailscale tailnet (which authenticates devices). **Do not** bind it to `0.0.0.0` or put it on the public internet / a `tailscale funnel`. Treat the URL like SSH access to your machine.

## Notes
- webmux only sees **tmux** sessions. To make terminals you open normally show up, let the installer add the **auto-tmux** snippet to your shell rc (it's guarded by `# >>> webmux tmux autostart >>>` markers — delete that block to undo).
- **Linux & macOS** supported (open-on-PC uses Ghostty on Linux, Terminal.app/iTerm/Ghostty on macOS via your installer choice). **Windows:** run under WSL (Linux from there).
- "Open on PC" is best-effort; with no display it falls back to a browser-only session.
- Opening a peer's `…ts.net` URL from a desktop needs Tailscale MagicDNS working there; if it doesn't, the picker shows a one-line `/etc/hosts` workaround for that peer.
- HTTP API: `/api/sessions`, `/api/session`, `/api/recents`, `/api/capture`, `/api/windows`, `/api/open`, `/api/kill`, `/api/update`, `/api/peer/sessions`, `/api/tailnet`, `/api/health`; WebSocket at `/ws/session/<name>` and `/ws/new`. See [`server.js`](server.js).
- The **all-PCs update** only reaches peers that already run this version (it POSTs `/api/update` to each); update a box once the normal way and thereafter it joins the one-tap fleet update.

## License
MIT
