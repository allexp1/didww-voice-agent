# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue. Use
GitHub's *"Report a vulnerability"* button (Security → Advisories) on this
repository, or contact the maintainers directly. You can expect an
acknowledgement within a few days.

## Security model

didww-voice-agent terminates SIP and RTP from the public internet. Telephony is
a standing target for toll fraud, scanning and abuse. Before exposing it:

- **Firewall.** `provision/40-ufw.sh` restricts SIP signalling (5060/5061) and
  PSTN RTP (10000–20000) to your carrier's published IP ranges. Keep it that
  way — an open 5060 will be found and probed within hours.
- **Per-call and concurrency caps.** `MAX_CALL_SECONDS` and
  `MAX_CONCURRENT_CALLS` bound the blast radius of a runaway call and of model
  spend. Set them conservatively.
- **The demo agent answers every inbound call.** With no external config
  service set, the built-in demo agent picks up every call that reaches your
  DID — there is no per-caller gate. The firewall (carrier-only SIP) plus the
  caps above are what bound exposure and model cost. A production deployment
  should front the agent with an external config service (see
  [docs/ADVANCED.md](docs/ADVANCED.md)) to gate or identify callers.
- **Loopback-bound control planes.** The drachtio admin port (9022), the
  rtpengine NG socket (22222), the agent control API (3002) and the WABA
  webhook (3000) bind to `127.0.0.1` only. Do not expose them; reach them only
  through Caddy where intended.
- **Authentication.** The control API under `/v1/calls/*` is HMAC-SHA256
  authenticated (`VOICE_VPS_ANNOUNCE_SECRET`, 60-second timestamp window).
  `/api/waba/*` is IP-allow-listed *and* bearer-authenticated. Use long, random,
  unique secrets.
- **call-forward.** `server/call-forward.js` enforces a source-IP allow-list so
  it cannot be turned into a toll-fraud relay. Keep that allow-list correct for
  your carrier.
- **Secrets.** Never commit `.env`. The values in `.env.example` and
  `provision/drachtio.conf.xml` are placeholders — generate fresh secrets
  (`openssl rand -hex 24`) before going to production.
- **Host hardening.** `provision/20-harden.sh` applies SSH key-only login,
  fail2ban and unattended security upgrades.

## Scope

This policy covers the code in this repository. Vulnerabilities in drachtio,
rtpengine, Caddy or the Node.js dependencies should be reported to those
projects directly.
