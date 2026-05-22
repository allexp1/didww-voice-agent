#!/usr/bin/env bash
# UFW firewall for the didww-voice-agent host. Run as root.
#
# SIP signalling (5060 + SIP-TLS 5061) and PSTN RTP are restricted to the
# carrier's published IP ranges. The ranges below are DIDWW's — verify them
# against DIDWW's current documentation before relying on them.
#
# To test SIP-TLS from your own softphone, add:
#   sudo ufw allow proto tcp from <YOUR_IP> to any port 5061 comment 'my softphone'
set -euo pipefail

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# SSH — rate-limited (UFW LIMIT blocks >6 conns / 30s).
ufw limit 22/tcp comment 'SSH'

# DIDWW SIP trunk — signalling (5060 + SIP-TLS 5061) and PSTN RTP (10000-20000).
# 46.19.208.0/21 and 185.238.172.0/22 are DIDWW's documented RTP subnets
# (doc.didww.com, verified 2026-05) and cover every DIDWW signalling IP.
for net in 46.19.208.0/21 185.238.172.0/22; do
  ufw allow proto udp from "$net" to any port 5060        comment 'DIDWW SIP'
  ufw allow proto tcp from "$net" to any port 5060        comment 'DIDWW SIP'
  ufw allow proto tcp from "$net" to any port 5061        comment 'DIDWW SIP-TLS'
  ufw allow proto udp from "$net" to any port 10000:20000 comment 'DIDWW RTP direct'
  ufw allow proto udp from "$net" to any port 30000:40000 comment 'DIDWW RTP via rtpengine'
done

# IPv6 — uncomment if your server is dual-stack and the trunk reaches it over
# IPv6. DIDWW announces its IPv6 from 2a01:ad00::/32.
# for net in 2a01:ad00::/32; do
#   ufw allow proto udp from "$net" to any port 5060        comment 'DIDWW SIP v6'
#   ufw allow proto tcp from "$net" to any port 5060        comment 'DIDWW SIP v6'
#   ufw allow proto tcp from "$net" to any port 5061        comment 'DIDWW SIP-TLS v6'
#   ufw allow proto udp from "$net" to any port 10000:20000 comment 'DIDWW RTP v6'
# done

# Caddy: HTTP (ACME challenge) + HTTPS.
ufw allow 80/tcp  comment 'Caddy ACME'
ufw allow 443/tcp comment 'Caddy HTTPS'

# WhatsApp/WABA + WebRTC media via rtpengine. Meta's SFU IPs are not stable
# enough to allow-list, so this range must be public only when you enable WABA.
if [ "${ENABLE_WABA:-0}" = "1" ]; then
  ufw allow 30000:40000/udp comment 'WABA/rtpengine media'
else
  echo "[ufw] WABA disabled: 30000-40000/udp is restricted to DIDWW ranges."
  echo "[ufw] To enable WABA media, rerun: ENABLE_WABA=1 $0"
fi

ufw --force enable
ufw status numbered
