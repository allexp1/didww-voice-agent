#!/usr/bin/env bash
# Base package install for the didww-voice-agent stack (Ubuntu 24.04).
# Idempotent. Run as root (via sudo).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "[base] apt update + core packages"
apt-get update -y
apt-get install -y \
  curl gnupg lsb-release ca-certificates build-essential \
  ufw sngrep tcpdump git ffmpeg sox jq openssl \
  unattended-upgrades fail2ban \
  apt-transport-https debian-keyring debian-archive-keyring \
  docker.io

echo "[base] Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "[base] Caddy (cloudsmith stable repo)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

systemctl enable --now docker

echo "[base] versions:"
echo "  node:   $(node -v)"
echo "  npm:    $(npm -v)"
echo "  docker: $(docker --version)"
echo "  caddy:  $(caddy version | head -1)"
echo "[base] DONE"
