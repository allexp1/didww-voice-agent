#!/usr/bin/env bash
# Sync Caddy's managed Let's Encrypt cert into /etc/drachtio/tls
# so drachtio can serve SIP-TLS (sips:5061). drachtio's <tls> block wants the
# leaf and the intermediate(s) in separate files, so we split Caddy's fullchain.
# Restarts the drachtio container only when the cert actually changed.
set -euo pipefail

DOMAIN="${DOMAIN:-voice.example.com}"   # your domain — must match the Caddyfile
DST=/etc/drachtio/tls
CADDY_CERTS=/var/lib/caddy/.local/share/caddy/certificates

src_crt=$(ls -1 "$CADDY_CERTS"/*/"$DOMAIN"/"$DOMAIN".crt 2>/dev/null | head -1 || true)
src_key=$(ls -1 "$CADDY_CERTS"/*/"$DOMAIN"/"$DOMAIN".key 2>/dev/null | head -1 || true)

if [ -z "$src_crt" ] || [ -z "$src_key" ]; then
  echo "[cert-sync] Caddy cert for $DOMAIN not found under $CADDY_CERTS — is Caddy up?" >&2
  exit 1
fi

install -d -m 0755 "$DST"

# DH params — generated once, reused across renewals.
if [ ! -f "$DST/dh.pem" ]; then
  echo "[cert-sync] generating DH params (one-time)…"
  openssl dhparam -out "$DST/dh.pem" 2048 2>/dev/null
fi

changed=0
cmp -s "$src_crt" "$DST/.fullchain.src" 2>/dev/null || changed=1
cp "$src_crt" "$DST/.fullchain.src"

# Split Caddy's fullchain into leaf (cert.pem) + intermediates (chain.pem).
awk -v cert="$DST/cert.pem.new" -v chain="$DST/chain.pem.new" '
  /-----BEGIN CERTIFICATE-----/ { n++ }
  { if (n <= 1) print > cert; else print > chain }
' "$src_crt"
mv -f "$DST/cert.pem.new"  "$DST/cert.pem"
mv -f "$DST/chain.pem.new" "$DST/chain.pem"
chmod 0644 "$DST/cert.pem" "$DST/chain.pem"
install -m 0640 "$src_key" "$DST/privkey.pem"

if [ "$changed" = 1 ]; then
  echo "[cert-sync] cert updated → restarting drachtio"
  docker restart drachtio >/dev/null 2>&1 \
    && echo "[cert-sync] drachtio restarted" \
    || echo "[cert-sync] drachtio container not running yet — skipped restart"
else
  echo "[cert-sync] cert unchanged"
fi
