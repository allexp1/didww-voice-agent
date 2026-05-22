#!/usr/bin/env bash
# Run drachtio + rtpengine as host-networked Docker containers.
# Idempotent: removes and recreates. Run as root.
#   usage: 30-containers.sh <public-ip>
set -euo pipefail
PUBLIC_IP="${1:?usage: 30-containers.sh <public-ip>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EVS_SO=/usr/lib/x86_64-linux-gnu/lib3gpp-evs.so

echo "[containers] pulling drachtio image"
docker pull drachtio/drachtio-server:latest

# rtpengine: we build our own image. The stock drachtio/rtpengine:latest is
# mr9.4 with no EVS support; rtpengine-evs is built from a recent rtpengine tag
# and bundles lib3gpp-evs.so (3GPP TS 26.443) so EVS can be transcoded.
# Build is ~3 min — skipped if the image already exists (docker rmi to force).
if ! docker image inspect rtpengine-evs:local >/dev/null 2>&1; then
  echo "[containers] building rtpengine-evs:local (rtpengine + 3GPP EVS codec)"
  docker build -t rtpengine-evs:local "$HERE/rtpengine-evs"
else
  echo "[containers] rtpengine-evs:local already built — skipping (docker rmi to rebuild)"
fi

echo "[containers] (re)starting drachtio  — SIP :5060 udp/tcp, sips:5061 tls, ws :8443"
docker rm -f drachtio 2>/dev/null || true
docker run -d --name drachtio --restart unless-stopped --network host \
  -v /etc/drachtio:/etc/drachtio:ro \
  drachtio/drachtio-server:latest \
  drachtio --loglevel info --sofia-loglevel 3 \
    --f /etc/drachtio/drachtio.conf.xml

echo "[containers] (re)starting rtpengine — SRTP/DTLS media 30000-40000/udp, EVS enabled"
# Our image's entrypoint IS /usr/bin/rtpengine, so we pass flags directly.
# --interface must be set explicitly (the stock image auto-detected it);
# --evs-lib-path enables EVS transcoding via the bundled 3GPP library.
docker rm -f rtpengine 2>/dev/null || true
docker run -d --name rtpengine --restart unless-stopped --network host \
  rtpengine-evs:local \
  --interface="$PUBLIC_IP" \
  --listen-ng=127.0.0.1:22222 --listen-http=127.0.0.1:8080 \
  --port-min=30000 --port-max=40000 \
  --evs-lib-path="$EVS_SO" \
  --foreground --log-stderr --log-level=6

sleep 4
echo "[containers] status:"
docker ps --format '  {{.Names}}\t{{.Image}}\t{{.Status}}'
echo "[containers] DONE"
