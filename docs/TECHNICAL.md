# webmux — technical reference

The user-facing pitch lives in the [README](../README.md). This document covers configuration, the
API, and how the moving parts work.

## How it works

webmux replaces ttyd while keeping the tmux session model intact. The backend is a small Node HTTP
server (`server.js`, no framework) that:

- serves the static PWA from `public/`,
- exposes a JSON API over plain HTTP,
- bridges a WebSocket to a real PTY running `tmux attach` / `tmux new-session` (via `node-pty`).

Each terminal WebSocket is symmetric and frame-type discriminated:

- **text frame** — a JSON control message (`{type:"session"|"resize"|"error"|"exit"|"ping"|"pong", …}`),
- **binary frame** — raw terminal bytes (stdin client→server, stdout server→client).

Detaching the browser kills only the PTY's `tmux attach` client; tmux keeps the session alive, so
nothing is lost when the phone disconnects. New sessions are created with `destroy-unattached off` so
they survive even before the desktop window attaches.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/samoylenkodmitry/webmux/main/install.sh | bash
```

Installs a background service on `127.0.0.1:8083` — a **systemd user service** on Linux, a **launchd
agent** on macOS. The installer is **interactive**: it offers to install `tmux` if missing, lets you
pick which installed terminal **New** opens on the desktop, can auto-start tmux in new shells (so
terminals you open normally also show up in webmux), and can configure the Tailscale share.

- **Requires** Node ≥ 18, npm, and a C toolchain for the native PTY module (Linux:
  `base-devel`/`build-essential` + `python3`; macOS: Xcode Command Line Tools).
- Set `WEBMUX_NONINTERACTIVE=1` to accept defaults silently (used by the in-app fleet update). On a
  machine that already has webmux, a non-interactive run **reuses the existing settings**.
- The installer is also the **deploy** step: re-running it does `git fetch` + `reset --hard origin/main`
  in `~/.local/share/webmux`, rebuilds, and restarts the service.

Expose it to your phone (recommended: Tailscale, which keeps it private):

```sh
tailscale serve --bg 8083
```

### Run from source

```sh
git clone https://github.com/samoylenkodmitry/webmux && cd webmux
npm install   # builds node-pty, vendors xterm.js into public/vendor
npm start     # http://127.0.0.1:8083
```

## Configure

Environment variables (set in the generated service file or your shell):

| var | default | meaning |
|-----|---------|---------|
| `HOST` | `127.0.0.1` | bind address |
| `PORT` | `8083` | port |
| `DESKTOP_TERMINAL` | ghostty (Linux) · Terminal.app (macOS) | emulator for "open on PC"; any that accepts `-e <cmd>` |
| `TERM_NAME` | `xterm-256color` | `TERM` for the PTY |
| `TMUX_SOCKET` | — | target a specific `tmux -L <name>` server |
| `TMUX_BIN` | `tmux` (PATH) | absolute path to the tmux binary (baked in by the installer) |
| `WEBMUX_STATE` | `~/.local/state/webmux` | recents, shared snippets, VAPID keys, push subscriptions |
| `WEBMUX_TAILSCALE` | unset | `1` shows this node's share + other tailnet webmux instances in the picker |
| `WEBMUX_INSTALL_URL` | the GitHub `install.sh` | override the installer one-liner used by the update button |

## Security

webmux has **no authentication** — anyone who can reach the port gets a shell as you. That is safe
*only* because it binds to `127.0.0.1` and is exposed through your private Tailscale tailnet, which
authenticates devices. **Do not** bind it to `0.0.0.0`, the public internet, or a `tailscale funnel`.
Treat the URL like SSH access to your machine. The fleet features (broadcast, update, shared snippets)
inherit this model: they reach peers over the tailnet only, with no extra auth.

## Multiple machines (Tailscale)

With `WEBMUX_TAILSCALE=1`, webmux discovers other webmux instances on your tailnet by probing each
online peer's `/api/health` (dialing the peer's Tailscale IP with the MagicDNS name as SNI + Host, so
TLS validates even when this node's own MagicDNS can't resolve `.ts.net`). Peer data shown in the
picker — sessions, stats, health — is **proxied through your local server** (`/api/peer/*`) so the
browser never has to make cross-origin requests. Tapping a peer navigates to its `…ts.net` URL in the
same tab; if it can't be reached from your device, the picker shows a one-line `/etc/hosts` workaround.

## Phones (and other non-`serve` nodes) as peers

PC peers are discovered over `tailscale serve` (HTTPS on :443). Devices that can't
run `tailscale serve` — notably **Android via Termux** — instead run webmux as
**plain HTTP on their Tailscale IP**, which is fine because WireGuard already
encrypts the tailnet. Discovery probes each online tailnet node over HTTPS first,
then falls back to plain HTTP on `WEBMUX_PEER_PORTS` (default `8083`); whichever
answers is captured as the peer's connection descriptor and every peer call
(sessions, stats, health, broadcast, snippets, update) uses it. Such peers show up
in the picker like any PC; tapping one navigates to its `http://<tailnet-ip>:<port>`
URL to attach.

There are two ways to put an Android phone on your fleet:

- **WebMux Host app** (recommended) — a self-contained APK ([`android/`](../android/)).
  Install it, tap **Start**, and a foreground service brings up a glibc userland
  (static **proot** + a minimal **Debian** rootfs downloaded on first run), inside
  which it installs Node 20, compiles `node-pty`, runs webmux bound to the phone's
  Tailscale IP, and installs **current Claude Code**. No Termux, survives reboots.
  See [`android/README.md`](../android/README.md).
- **Termux script** — [`scripts/termux-setup.sh`](../scripts/termux-setup.sh) does the
  same by hand inside Termux (needs the Tailscale app + Termux:API/Boot). Claude runs
  via `proot-distro` because 2.x has no Android-native binary.

Why the userland: Android forbids executing binaries from app storage, and Claude 2.x
is a glibc binary with no Android build — so both the app and the script run Claude
(and, in the app, all of webmux) inside a glibc Debian via proot.

> Roadmap: embed a `tsnet` node so the app is its own tailnet device (no separate
> Tailscale app), and add a native Accessibility/MediaProjection control bridge exposed
> to the on-device agent over MCP for full phone control.

## Fleet update

Pressing **Update all** updates every *other* box on the tailnet to this PC's version, with a live
per-machine progress window; this PC stays up as the coordinator (update it the normal way). For each
peer:

- newer peers self-update via `POST /api/update?scope=self`;
- peers too old to have that endpoint are bootstrapped by driving their `/ws/new` shell — the same
  shell access the UI already has — to run the installer.

The installer runs non-interactively, **reuses each box's existing settings**, and is detached with
`nohup` so it survives the service restart it triggers (output → `/tmp/webmux-update.log` on each
peer). The progress window polls each peer's `/api/health` version until it matches.

## Activity alerts (Web Push)

Opt-in via 🔔 in the terminal menu (install the PWA first). The server keeps per-session activity
state in its 5-second sampler; when a session that was producing output goes quiet for ~12s **while no
client is attached**, it sends a Web Push notification ("X is idle — your turn"). Tapping it focuses
or opens that session. VAPID keys are generated once and persisted to `WEBMUX_STATE`; subscriptions are
stored there too. If the `web-push` dependency is missing, the endpoints simply report disabled. The
picker also shows a "new output" dot on sessions whose activity advanced since you last viewed them.

## HTTP / WebSocket API

| path | method | purpose |
|------|--------|---------|
| `/api/sessions` | GET | list tmux sessions (name, attached, windows, foreground command, path, activity) |
| `/api/session?name=` | GET | one session's live command/dir/activity |
| `/api/recents` | GET | recently closed directories |
| `/api/capture?name=` | GET | full scrollback as plain text |
| `/api/windows?name=` | GET/POST | list / select / new / kill windows |
| `/api/open?name=` | POST | open the session as a real terminal window on the PC |
| `/api/kill?name=` | POST | kill a session |
| `/api/stats` · `/api/procs` | GET | machine stats (cpu/gpu/ram/disk/temp/uptime/load) · top processes |
| `/api/broadcast?scope=` | POST | run a command on this box (`self`) or the whole fleet (`all`) |
| `/api/update?scope=` | POST | self-update (`self`) or coordinate a fleet update (`all`) |
| `/api/snippets` | GET/POST | shared quick-reply chips (POST `?scope=all` fans out to peers) |
| `/api/push/key` · `/subscribe` · `/unsubscribe` · `/test` | GET/POST | Web Push wiring |
| `/api/tailnet` | GET | this node's share state + discovered webmux peers |
| `/api/peer/{sessions,health,stats,procs}?dns=&ip=` | GET | proxy the corresponding endpoint on a peer |
| `/api/health` | GET | tmux reachability + running version |
| `/ws/session/<name>` | WS | attach an existing session |
| `/ws/new[?name=&dir=&desktop=1]` | WS | create + attach a new session (in `~` by default) |

## Notes

- webmux only sees **tmux** sessions. To make terminals you open normally show up, let the installer
  add the **auto-tmux** snippet to your shell rc (guarded by `# >>> webmux tmux autostart >>>` markers
  — delete that block to undo).
- The session list shows the **full foreground command** (so `sudo btop` reads as `sudo btop`, not just
  `sudo`), resolved from the pane's controlling-terminal foreground process group (Linux).
- **"Open on PC"** is best-effort (Ghostty on Linux; Terminal.app/iTerm/Ghostty on macOS). The service
  reads the graphical session's `DISPLAY`/`WAYLAND_DISPLAY`/D-Bus env from the systemd user manager at
  spawn time, so it works even though the background service starts without them.
- **Scrollback limits:** full-screen TUIs that repaint in place (e.g. Claude Code) keep their own
  scroll view and don't push history into the terminal scrollback, so the copy view can only capture
  the current screen for those. Regular shell/command output captures in full.
- Per-terminal **font size** is remembered per session; quick-reply snippets are shared fleet-wide.
