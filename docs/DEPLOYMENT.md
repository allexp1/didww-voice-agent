# Deployment

Production deployment reference for `didww-voice-agent`: what runs on the
server, where each piece lives, and how to provision or redeploy it.

This is the operational counterpart to the other docs:

- [`../README.md`](../README.md) — project overview.
- [`QUICKSTART.md`](QUICKSTART.md) — get a single call answered fast.
- [`DIDWW-SETUP.md`](DIDWW-SETUP.md) — DIDWW trunk and DID configuration.
- [`CONFIGURATION.md`](CONFIGURATION.md) — every `.env` key, in detail.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the call path fits together.
- [`ADVANCED.md`](ADVANCED.md) — external control app, WhatsApp bridge, conferences.

> **Secrets policy.** Real credentials never belong in the repository. `.env`
> lives only on the server (mode `0600`, owned by `root`). `.env.example` is the
> committed template — every secret value is blank. Keep `.env` out of version
> control and out of backups that leave the host.

Examples below use these placeholders — substitute your own values:

| Placeholder | Meaning |
|---|---|
| `voice.example.com` | the server's public hostname (DNS A record) |
| `203.0.113.10` | the server's public IPv4 address |
| `/opt/voice-ai` | on-server deploy path for the Node application |
| `/var/log/voice-ai/` | on-server log directory |

---

## 1. Overview

The voice agent runs on a single Linux host (reference platform: **Ubuntu
24.04 LTS**). The call path is:

```
DIDWW SIP trunk  →  drachtio (SIP)  →  Node.js process  →  Google Gemini Live API
                          ↕
                     rtpengine (RTP media + transcoding)
```

- **DIDWW** is the carrier. A DIDWW **two-way SIP trunk** is **IP-authenticated**:
  you register the server's public IP in the DIDWW control panel and inbound
  calls arrive with no SIP registration. SIP registration (`server/trunk-register.js`)
  is only needed for *other* carriers that use registration-based trunks — with
  a DIDWW trunk, `SIP_USER`/`SIP_PASSWORD` stay blank. See
  [`DIDWW-SETUP.md`](DIDWW-SETUP.md).
- **drachtio** and **rtpengine** run as host-networked Docker containers.
- **Caddy** terminates TLS and reverse-proxies the HTTP services, obtaining
  Let's Encrypt certificates automatically.
- The Node application is deployed to `/opt/voice-ai` and supervised by systemd.

The optional external **control app** (per-caller config service + WhatsApp
bridge front end) is a separate component and is documented in
[`ADVANCED.md`](ADVANCED.md); a standalone PSTN voice-agent deployment does not
need it.

---

## 2. Listening ports

| Port | Proto | Bound to | Purpose | Exposure |
|---|---|---|---|---|
| 22 | tcp | host | SSH | rate-limited; optionally allow-list your admin IP |
| 80 | tcp | Caddy | ACME HTTP-01 challenge | public |
| 443 | tcp | Caddy | HTTPS (`voice.example.com`) | public |
| 5060 | udp/tcp | drachtio | SIP signalling | DIDWW SIP ranges |
| 5061 | tcp | drachtio | SIP-TLS | DIDWW SIP ranges |
| 8443 | wss | drachtio | SIP-over-WSS (browser softphone) | via Caddy `/sip` |
| 9022 | tcp | drachtio | drachtio admin API | `127.0.0.1` only |
| 22222 | udp | rtpengine | NG control protocol | `127.0.0.1` only |
| 10000–20000 | udp | Node agent | Direct PSTN-leg RTP media | DIDWW SIP ranges |
| 30000–40000 | udp | rtpengine | Transcoded PSTN media; WebRTC media when WhatsApp bridge is enabled | DIDWW SIP ranges by default; public only with `ENABLE_WABA=1` |
| 3000 | tcp | `webhook.js` | WhatsApp bridge HTTP | `127.0.0.1`; via Caddy `/api/waba/*` |
| 3002 | tcp | `agent.js` control API | `/v1/calls/*` (outbound, announce) | `127.0.0.1`; via Caddy `/v1/calls/*` |

Two RTP ranges exist for two transport models. Direct PSTN media (10000–20000)
only ever comes from the carrier, so it is firewalled to DIDWW's SIP ranges.
rtpengine media (30000–40000) is also restricted to DIDWW by default, which
covers PSTN transcoding and outbound/conference media. If you enable the
WhatsApp bridge, that same rtpengine range must reach arbitrary provider edge
IPs; run the firewall script with `ENABLE_WABA=1` to make it public.

---

## 3. On-server file layout

```
/opt/voice-ai/                   Node application — owned by root
  agent.js                         the voice agent (this repo: server/agent.js)
  webhook.js                       WhatsApp bridge HTTP service
  echo-test.js                     RTP reflector for trunk smoke testing (manual)
  call-forward.js                  SIP B2BUA call forwarder (manual; see §10)
  rtpengine.js                     rtpengine NG-protocol client
  trunk-register.js                SIP registration keep-alive (non-DIDWW carriers)
  g722.js, demo-config.js          codec helper / built-in demo persona
  package.json, package-lock.json, node_modules/
  .env                             environment file — mode 0600, root-owned

/etc/caddy/Caddyfile             reverse proxy + TLS  (repo: provision/Caddyfile)
/etc/drachtio/drachtio.conf.xml  drachtio config      (repo: provision/drachtio.conf.xml)
/etc/drachtio/tls/               SIP-TLS cert/key, synced from Caddy (see §6)
/etc/sysctl.d/99-voice-tuning.conf  RTP socket-buffer tuning
/etc/systemd/system/             unit files           (repo: provision/*.service, *.timer)
/usr/local/sbin/drachtio-cert-sync.sh  cert-sync helper script

/var/log/voice-ai/               agent.log, webhook.log, echo-test.log, call-forward.log
/var/log/caddy/access.log        HTTPS/WSS access log
```

Containers:

```
drachtio    drachtio/drachtio-server:latest   SIP server
rtpengine   rtpengine-evs:local               RTP media + transcoder
                                              (built locally — see §5)
```

---

## 4. systemd units

Each unit ships under `provision/` in this repository.

| Unit | Default state | Purpose |
|---|---|---|
| `voice-ai-agent.service` | enabled | the SIP → Gemini Live voice agent |
| `waba-webhook.service` | enabled | WhatsApp bridge HTTP service |
| `drachtio-cert-sync.timer` | enabled | daily SIP-TLS cert re-sync (picks up ACME renewals) |
| `echo-test.service` | disabled — manual | RTP reflector / trunk smoke test (see §10) |
| `call-forward.service` | disabled — manual | SIP B2BUA call forwarder (see §10) |

`caddy.service` (from the Caddy package) and the Docker containers
(`drachtio`, `rtpengine`) round out the running stack.

`voice-ai-agent`, `echo-test` and `call-forward` each take exclusive ownership
of the drachtio INVITE stream, so they **cannot run at the same time**. Their
units declare a symmetric `Conflicts=`: starting one stops the others.

```
sudo systemctl status voice-ai-agent waba-webhook
sudo systemctl restart voice-ai-agent
journalctl -u voice-ai-agent -f
```

---

## 5. Docker (drachtio + rtpengine)

```
sudo docker ps
  drachtio    drachtio/drachtio-server:latest
  rtpengine   rtpengine-evs:local
```

Both run with `--network host` and `--restart unless-stopped`; they are created
by `provision/30-containers.sh`.

- **drachtio** runs the upstream image. Its admin API is bound to
  `127.0.0.1:9022`; the admin secret must match `DRACHTIO_SECRET` in `.env`.
  The config (`provision/drachtio.conf.xml`) defines the SIP transports —
  UDP/TCP `5060`, SIP-TLS `5061`, WSS `8443`.
- **rtpengine** runs a locally built image, `rtpengine-evs:local`, with the
  NG control socket on `127.0.0.1:22222` and the media port range
  `30000–40000`.

### EVS codec support is optional

`rtpengine-evs:local` is built from `provision/rtpengine-evs/Dockerfile`. It
exists for one reason: **EVS (Enhanced Voice Services) codec support**.

EVS is **patent-encumbered** — rtpengine ships no EVS implementation, and no
freely distributable one exists. The Dockerfile builds the 3GPP TS 26.443
floating-point reference codec from 3GPP source **at image build time** and
loads it into rtpengine via `--evs-lib-path`. The build also compiles the
rtpengine daemon itself from a pinned upstream tag (the stock image is too old
to support EVS).

**A PCMU / G.711 deployment needs none of this.** If you do not need EVS, you
can run the stock `drachtio/rtpengine:latest` image instead — the agent and
rtpengine negotiate PCMU/G.711 (and, via ffmpeg in rtpengine, AMR-NB/WB)
without the custom build. EVS support is the only thing the custom image adds.
Review the patent and licensing implications of building and shipping the EVS
reference codec before enabling it.

---

## 6. Caddy reverse proxy

Caddy terminates TLS for `voice.example.com`, obtains and renews the Let's
Encrypt certificate automatically, and reverse-proxies the internal HTTP
services. Config: `provision/Caddyfile` → `/etc/caddy/Caddyfile`.

```
voice.example.com {
  @waba_allowed { path /api/waba/*  remote_ip 198.51.100.20 }
  @waba_any     { path /api/waba/* }
  handle @waba_allowed { reverse_proxy 127.0.0.1:3000 }   # WhatsApp bridge
  handle @waba_any     { respond "forbidden" 403 }
  handle /healthz      { reverse_proxy 127.0.0.1:3000 }
  handle /v1/calls/*   { reverse_proxy 127.0.0.1:3002 }   # agent control API
  handle /sip          { reverse_proxy 127.0.0.1:8443 }   # drachtio WSS
  handle               { respond "not found" 404 }
}
```

- `/api/waba/*` is **IP-restricted** to the control app's address — replace
  `198.51.100.20` with your control app's IP. If you are not running the
  WhatsApp bridge, delete the `@waba_*` matchers and their `handle` blocks.
- `/v1/calls/*` is reached over the public Internet by the control app; the
  agent enforces a second layer of defence by verifying an HMAC signature
  (`VOICE_VPS_ANNOUNCE_SECRET`).
- The certificate Caddy obtains is also used for SIP-TLS — see §7.

### SIP-TLS certificate sync

drachtio needs the same certificate as Caddy to serve SIP-TLS (`5061`) and WSS
(`8443`). `drachtio-cert-sync.sh` copies Caddy's managed Let's Encrypt
certificate into `/etc/drachtio/tls/`, splitting the fullchain into the
separate leaf/intermediate files drachtio's `<tls>` block expects, and restarts
the drachtio container only when the certificate has actually changed.
`drachtio-cert-sync.timer` runs it daily so ACME renewals propagate.

The cert-sync script reads `DOMAIN` (defaults to `voice.example.com`) — set it
to your hostname so it matches the `Caddyfile`.

---

## 7. UFW firewall

`provision/40-ufw.sh` resets UFW to default-deny inbound and adds:

```
22/tcp            LIMIT IN  Anywhere                  SSH (rate-limited)
5060/udp          ALLOW IN  46.19.208.0/21            DIDWW SIP
5060/tcp          ALLOW IN  46.19.208.0/21            DIDWW SIP
5061/tcp          ALLOW IN  46.19.208.0/21            DIDWW SIP-TLS
10000:20000/udp   ALLOW IN  46.19.208.0/21            DIDWW RTP
5060/udp          ALLOW IN  185.238.172.0/22          DIDWW SIP
5060/tcp          ALLOW IN  185.238.172.0/22          DIDWW SIP
5061/tcp          ALLOW IN  185.238.172.0/22          DIDWW SIP-TLS
10000:20000/udp   ALLOW IN  185.238.172.0/22          DIDWW RTP
80/tcp            ALLOW IN  Anywhere                  Caddy ACME
443/tcp           ALLOW IN  Anywhere                  Caddy HTTPS
30000:40000/udp   ALLOW IN  46.19.208.0/21            DIDWW RTP via rtpengine
30000:40000/udp   ALLOW IN  185.238.172.0/22          DIDWW RTP via rtpengine
```

SIP signalling and PSTN RTP are locked to **DIDWW's published SIP IP ranges**
(`46.19.208.0/21` and `185.238.172.0/22`). **Verify these ranges against
DIDWW's current two-way-trunk documentation** before relying on them — carrier
IP space changes.

The rtpengine media range (`30000:40000/udp`) is restricted to DIDWW ranges by
default. To enable the WhatsApp bridge, rerun:

```
sudo ENABLE_WABA=1 ./provision/40-ufw.sh
```

That opens `30000:40000/udp` publicly because the WhatsApp bridge's media peers
(provider SFU edge IPs) are not stable enough to allow-list.

To test SIP-TLS from your own softphone, temporarily allow your IP:

```
sudo ufw allow proto tcp from <YOUR_IP> to any port 5061 comment 'my softphone'
```

---

## 8. fail2ban

`provision/20-harden.sh` enables the standard `sshd` jail
(`/etc/fail2ban/jail.d/sshd.local`):

```
[sshd]
enabled  = true
maxretry = 4
findtime = 10m
bantime  = 1h
```

Repeated failed SSH attempts from one IP earn a one-hour ban. If you administer
the host from a fixed IP, add it to an ignore list so you cannot lock yourself
out, e.g. a drop-in at `/etc/fail2ban/jail.d/00-whitelist.local`:

```
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 <YOUR_ADMIN_IP>
```

---

## 9. Environment file

`/opt/voice-ai/.env`, mode `0600`, owned by `root`. Template:
[`../.env.example`](../.env.example); every key is documented in
[`CONFIGURATION.md`](CONFIGURATION.md).

The minimum for a working voice agent is small: `PUBLIC_IP`, `GEMINI_API_KEY`,
`DRACHTIO_SECRET`, and the DIDWW trunk settings (`SIP_DOMAIN`; `CLI` for
outbound caller ID). For a DIDWW IP-authenticated trunk, leave `SIP_USER` and
`SIP_PASSWORD` blank.

`DRACHTIO_SECRET` **must match** the `<admin secret="...">` value in
`/etc/drachtio/drachtio.conf.xml`. Generate one with `openssl rand -hex 24`.

The `INTERNAL_VOICE_*`, `VOICE_VPS_ANNOUNCE_SECRET`, `WA_PROD_IPS` and
WhatsApp-bridge keys are only used with the external control app — see
[`ADVANCED.md`](ADVANCED.md).

---

## 10. Maintenance utilities

Two on-demand tools ship as systemd units that are **disabled at boot** and
conflict with the running agent. Start, use, then restore the agent.

### `echo-test` — RTP reflector

Answers any inbound INVITE and reflects every RTP packet straight back to the
caller, so the caller hears themselves. It never decodes the media, so it is
codec-agnostic — use it to confirm the inbound trunk and two-way media path
before pointing real traffic at the agent.

```
sudo systemctl start echo-test        # stops voice-ai-agent, starts the reflector
# … call in, speak, hang up …
sudo systemctl start voice-ai-agent   # stops echo-test, restores the agent
```

It also exposes a loopback-only outbound test driver on `127.0.0.1:3030`
(`POST /dial/<number>`) that places an outbound call and logs the negotiated
codec.

### `call-forward` — SIP B2BUA call forwarder

Answers every inbound call and re-originates it to the number in `FORWARD_TO`,
bridging the two legs through rtpengine. `server/call-forward.js` is hardened:

- a source-IP allow-list (DIDWW's SIP ranges) rejects scanner probes with `403`,
  so a stray firewall rule cannot turn the forwarder into a toll-fraud relay;
- an `uncaughtException` guard absorbs benign stale-dialog teardown races;
- the original caller's CLI is never relayed — the outbound leg uses the
  trunk's own identity (many trunks reject an INVITE whose `From` is not a
  trunk-owned number).

Set `FORWARD_TO` (E.164 digits) in `.env`, then:

```
sudo systemctl start call-forward     # stops voice-ai-agent, starts forwarding
# … route calls …
sudo systemctl start voice-ai-agent   # stops call-forward, restores the agent
```

---

## 11. Replicate from scratch (Ubuntu 24.04)

On a fresh Ubuntu 24.04 host, as `root`, from a checkout of this repository.

**1. Provision** — run the numbered scripts in order:

```
./provision/10-base.sh                # apt: Docker, Caddy, Node.js 20, build tools
./provision/20-harden.sh              # SSH key-only, fail2ban, sysctl tuning, auto-updates
./provision/30-containers.sh 203.0.113.10   # build & run drachtio + rtpengine
./provision/40-ufw.sh                 # firewall (locks SIP/RTP to DIDWW ranges)
```

Pass the server's public IP to `30-containers.sh`. The rtpengine image build
takes a few minutes the first time (it compiles the EVS codec and the
rtpengine daemon); it is skipped on later runs if the image already exists.

**2. Install config and systemd units:**

```
install -m 644 provision/Caddyfile            /etc/caddy/Caddyfile
install -m 644 provision/99-voice-tuning.conf  /etc/sysctl.d/
install -d -m 755 /etc/drachtio
install -m 644 provision/drachtio.conf.xml     /etc/drachtio/
install -m 755 provision/drachtio-cert-sync.sh /usr/local/sbin/
install -m 644 provision/*.service             /etc/systemd/system/
install -m 644 provision/*.timer               /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now caddy drachtio-cert-sync.timer
```

Edit `/etc/caddy/Caddyfile` and `/etc/drachtio/drachtio.conf.xml` for your
hostname and admin secret before starting Caddy.

**3. Deploy the application:**

```
mkdir -p /opt/voice-ai /var/log/voice-ai
rsync -a server/ /opt/voice-ai/
cd /opt/voice-ai && npm ci
install -m 600 .env.example /opt/voice-ai/.env   # then edit — fill in secrets
```

**4. DNS** — point an A record for `voice.example.com` at `203.0.113.10`.
Caddy obtains the TLS certificate on the first request to port 80; the
`drachtio-cert-sync` timer then propagates it into the drachtio container.

**5. Start the services:**

```
systemctl enable --now voice-ai-agent waba-webhook
```

(Skip `waba-webhook` for a PSTN-only deployment.)

---

## 12. Incremental redeploy

To push application changes after the host is already provisioned:

```
git pull
# copy changed files into /opt/voice-ai (rsync, scp, or install), e.g.:
rsync -a server/ /opt/voice-ai/
cd /opt/voice-ai && npm ci          # only if dependencies changed
sudo systemctl restart voice-ai-agent
```

For provisioning-file changes:

- `Caddyfile` → reinstall into `/etc/caddy/`, then `sudo systemctl reload caddy`.
- `*.service` / `*.timer` → reinstall into `/etc/systemd/system/`, then
  `sudo systemctl daemon-reload` and restart the affected unit.
- `drachtio.conf.xml` → reinstall into `/etc/drachtio/`, then
  `sudo docker restart drachtio`.

Always back up the existing `.env` before editing it (e.g.
`cp .env .env.bak.$(date +%Y%m%d-%H%M%S)`) so a bad edit is easy to revert.

---

## 13. Logs

```
/var/log/voice-ai/agent.log          primary — per-call session lifecycle
/var/log/voice-ai/webhook.log        WhatsApp bridge HTTP service
/var/log/voice-ai/echo-test.log      when echo-test is running
/var/log/voice-ai/call-forward.log   when call-forward is running
/var/log/caddy/access.log            HTTPS / WSS access

journalctl -u voice-ai-agent         systemd lifecycle for the agent
journalctl -u waba-webhook           systemd lifecycle for the WhatsApp bridge
sudo docker logs drachtio            SIP signalling layer
sudo docker logs rtpengine           rtpengine media events
```

Each call session has an ID printed in `[brackets]` at the start of its log
lines — grep on it to follow a single call across `agent.log` (and, for the
WhatsApp bridge, `webhook.log`).

---

## 14. Trust model recap

- **DIDWW → server.** A two-way trunk is IP-authenticated: DIDWW only sends
  calls to the registered server IP, and UFW restricts SIP signalling and PSTN
  RTP to DIDWW's published SIP ranges. SIP-TLS (`5061`) is available and uses
  the same Let's Encrypt certificate as HTTPS. Registration credentials are
  only used for other (registration-based) carriers.
- **Control app → server.** HTTPS via Caddy. `/api/waba/*` is IP-restricted to
  the control app's address *and* validates the provider's webhook payload.
  `/v1/calls/*` is HMAC-authenticated with `VOICE_VPS_ANNOUNCE_SECRET`.
- **Server → control app.** Bearer token (`INTERNAL_VOICE_TOKEN`) on outbound
  callbacks.
- **SSH.** Key-only authentication; fail2ban bans brute-force sources.
- **Internal control sockets.** rtpengine NG (`22222`), the drachtio admin API
  (`9022`) and the Node control API (`3002`) and WhatsApp bridge (`3000`) all
  bind to `127.0.0.1` only and are reached, where needed, exclusively through
  Caddy.

If any of this changes, update this document and `.env.example` in the same
commit.
