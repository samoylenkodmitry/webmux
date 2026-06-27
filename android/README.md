# WebMux Host (Android)

A self-contained Android app that puts a phone on your webmux fleet — no Termux, no
manual setup. Install the APK, tap **Start**, and the phone runs `tmux` + **webmux** +
**current Claude Code** and appears in every other webmux's picker like any PC.

## How it works

Android won't let an app run current Claude Code or compile `node-pty` directly
(Claude 2.x is a glibc binary with no Android build; the OS blocks executing
downloaded binaries from app storage). So the app ships a **glibc userland**:

- A static **proot** + a minimal **Debian** rootfs (downloaded on first run) extracted
  into the app's private storage. Inside proot it's ordinary glibc Linux.
- A **foreground service** (the persistence story) brings the userland up: installs
  Node 20, builds `node-pty`, runs webmux bound to the phone's **Tailscale IP**, and
  installs Claude Code. It restarts webmux if it dies and on boot.
- `proot`, its loader, and `libtalloc`/`libandroid-shmem` ride in the APK as native
  libs (`jniLibs/arm64-v8a/lib*.so`) so they land in `nativeLibraryDir`, the one
  app-writable place Android still permits executing from.

webmux has no auth, so the app binds it to the phone's `100.x` Tailscale address only
(never `0.0.0.0`) — same security model as on a PC.

## Build

Needs a JDK 17 + Android SDK (build-tools 34, platform 34). Then:

```sh
cd android
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
```

Release builds are signed from `keystore.properties` (gitignored — create your own):

```
storeFile=webmux-release.keystore
storePassword=…
keyAlias=…
keyPassword=…
```

```sh
keytool -genkeypair -keystore webmux-release.keystore -alias webmux \
  -keyalg RSA -keysize 2048 -validity 10000
./gradlew assembleRelease
```

## Install (sideload)

1. Download `app-release.apk` from the GitHub release onto the phone.
2. Open it; allow "install unknown apps" if prompted.
3. Open **WebMux Host** → **Start / Join fleet**, then **Allow background (battery)**.
4. First run downloads ~90 MB + builds the toolchain (a few minutes). After that the
   phone shows up in your other webmux pickers. Reboots auto-restart it.

The phone must already be signed into the **Tailscale** app (that's what gives it the
`100.x` address webmux binds to).

## Licensing / attribution

- `jniLibs/.../libproot.so`, `libproot_loader*.so` — **proot** (GPL-2.0), prebuilt by
  the Termux project. Source: https://github.com/termux/proot
- `libtalloc.so`, `libandroid-shmem.so` — Termux packages (LGPL/ISC). https://github.com/termux/termux-packages
- The Debian rootfs is fetched at runtime from images.linuxcontainers.org (mirrored on
  this repo's `userland-v1` release).
