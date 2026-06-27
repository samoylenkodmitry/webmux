#!/bin/bash
# Runs INSIDE the proot Debian rootfs (as fake-root) on first launch. Installs the
# toolchain, webmux, and current Claude Code. Everything here is ordinary glibc
# Debian, so node-pty compiles and Claude's arm64 binary runs unmodified.
set -e
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WEBMUX_DIR=/opt/webmux
REPO="${WEBMUX_REPO:-https://github.com/samoylenkodmitry/webmux}"
NODE_VER="${NODE_VER:-v20.18.1}"   # official glibc arm64 build — newer/robust npm 10

# Under proot, apt's http method can't setresuid() down to the _apt sandbox user
# ("Operation not permitted"). Tell apt to stay root, like proot-distro does.
mkdir -p /etc/apt/apt.conf.d
echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/00sandbox-off

echo "BOOT: apt update"
apt-get update -y

# Just the build toolchain — NOT Debian's nodejs/npm (old npm 9 crashes under proot
# and drags in ~400 MB of node-* packages). We use the official Node tarball instead.
echo "BOOT: apt install build tools"
apt-get install -y --no-install-recommends \
  ca-certificates git curl xz-utils procps python3 make g++ tmux

if [ ! -x /usr/local/bin/node ]; then
  echo "BOOT: install Node $NODE_VER"
  curl -fsSL -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-arm64.tar.xz"
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
echo "BOOT: node $(node --version 2>&1) / npm $(npm --version 2>&1)"

if [ ! -d "$WEBMUX_DIR/.git" ]; then
  echo "BOOT: clone webmux"
  git clone --depth 1 "$REPO" "$WEBMUX_DIR"
else
  echo "BOOT: update webmux"
  git -C "$WEBMUX_DIR" pull --ff-only || true
fi

# npm under proot: serialize fetches and clear any cache poisoned by an earlier run.
npm config set audit false
npm config set fund false
npm config set maxsockets 1
rm -rf /root/.npm/_cacache 2>/dev/null || true

cd "$WEBMUX_DIR"
echo "BOOT: npm install"
npm install --no-audit --no-fund

# node-pty 1.x ships no linux prebuild, and its `prebuild.js || node-gyp rebuild`
# install step can exit 0 without producing pty.node. Force a source compile.
echo "BOOT: compile node-pty"
npm install -g node-gyp >/dev/null 2>&1 || true
( cd node_modules/node-pty && node-gyp rebuild ) 2>&1 | tail -15
if [ -f node_modules/node-pty/build/Release/pty.node ]; then
  echo "BOOT: node-pty compiled"
else
  echo "BOOT: node-pty FAILED to build"; exit 3
fi

echo "BOOT: install current Claude Code"
npm install -g @anthropic-ai/claude-code || echo "BOOT: claude install failed (continuing without it)"

echo "BOOT: done"
touch /opt/.webmux-bootstrapped
