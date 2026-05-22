# Quick start

The fastest path to a phone number you can call and talk to an AI agent.

By the end you will have a DIDWW number that, when dialled, connects the caller
to the built-in demo agent running on your own server.

## What you need

- **A server** — a fresh Ubuntu 24.04 VPS with a public IPv4 address. Root (or
  sudo) access. ~1 vCPU / 1 GB RAM is enough to start.
- **A domain name** — one A record you can point at the server. TLS certificates
  are issued automatically by Caddy.
- **DIDWW** — an account with one DID (phone number) and a two-way SIP trunk.
  Full walkthrough: **[DIDWW-SETUP.md](DIDWW-SETUP.md)**.
- **A Google Gemini API key** — from [Google AI Studio](https://aistudio.google.com/apikey).

## 1. Set up the DIDWW side

Follow **[DIDWW-SETUP.md](DIDWW-SETUP.md)**. In short, you need:

- A **two-way SIP trunk** with **IP authentication** set to your server's
  public IP.
- A **DID** routed to that trunk.
- The trunk's **outbound proxy host** (for placing outbound calls).

Keep three values handy: the **DID** (your number), the **outbound proxy host**,
and confirmation that the trunk is **IP-authenticated** to your server.

## 2. Provision the server

Clone the repository onto the server and run the numbered scripts as root, in
order:

```bash
git clone https://github.com/<you>/didww-voice-agent.git
cd didww-voice-agent

sudo ./provision/10-base.sh                       # Docker, Node.js, Caddy, tools
sudo ./provision/20-harden.sh                     # SSH hardening, fail2ban, sysctl
sudo ./provision/30-containers.sh <public-ip>     # drachtio + rtpengine containers
sudo ./provision/40-ufw.sh                        # firewall
```

`30-containers.sh` builds a custom rtpengine image with EVS support — this
takes a few minutes the first time. EVS is optional; see [NOTICE](../NOTICE).

Before installing the config files, edit two of them:

- `provision/Caddyfile` — replace `voice.example.com` with your domain.
- `provision/drachtio.conf.xml` — replace the placeholder admin secret. Generate
  one with `openssl rand -hex 24` and keep it; you will reuse it in step 4.

Then install the host config and systemd units:

```bash
sudo install -m 644 provision/Caddyfile            /etc/caddy/Caddyfile
sudo install -m 644 provision/99-voice-tuning.conf /etc/sysctl.d/
sudo install -d  -m 755 /etc/drachtio
sudo install -m 644 provision/drachtio.conf.xml    /etc/drachtio/
sudo install -m 644 provision/*.service            /etc/systemd/system/
sudo install -m 644 provision/*.timer              /etc/systemd/system/
sudo install -m 755 provision/drachtio-cert-sync.sh /usr/local/sbin/
sudo systemctl daemon-reload
sudo systemctl enable --now caddy drachtio-cert-sync.timer
```

Point your domain's **A record** at the server now — Caddy obtains the TLS
certificate on the first request to port 80.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full reference if anything here is
unclear.

## 3. Deploy the agent

```bash
sudo mkdir -p /opt/voice-ai /var/log/voice-ai
sudo rsync -a server/ /opt/voice-ai/
cd /opt/voice-ai && sudo npm ci
sudo install -m 600 /dev/stdin /opt/voice-ai/.env < ../didww-voice-agent/.env.example
```

(Or simply copy `.env.example` to `/opt/voice-ai/.env` — just make sure it ends
up mode `600`.)

## 4. Configure `.env`

Edit `/opt/voice-ai/.env`. For the demo you only need five values:

```ini
PUBLIC_IP=203.0.113.10              # this server's public IPv4
GEMINI_API_KEY=...                  # from Google AI Studio
DRACHTIO_SECRET=...                 # the SAME value you put in drachtio.conf.xml
SIP_DOMAIN=...                      # your DIDWW outbound proxy host
CLI=...                             # your DID, E.164 digits — e.g. 12025550123
```

Leave `SIP_USER` and `SIP_PASSWORD` blank — DIDWW two-way trunks authenticate by
IP. Everything else has working defaults; see [CONFIGURATION.md](CONFIGURATION.md).

## 5. Smoke-test the trunk (optional but recommended)

Before involving the AI, confirm the trunk and two-way audio work. The echo test
answers any call and reflects your audio back so you hear yourself:

```bash
sudo systemctl start echo-test       # this stops voice-ai-agent (they conflict)
# …call your DID, speak, you should hear yourself…
sudo systemctl stop  echo-test
```

If you hear your own voice, signalling and media are good.

## 6. Start the agent

```bash
sudo systemctl enable --now voice-ai-agent
sudo journalctl -u voice-ai-agent -f
```

Look for `drachtio connected` and `didww-voice-agent ready` in the log.

## 7. Call your number

Dial your DID from any phone. The demo agent ("Aria") answers, greets you, and
can explain how the project works while you're on the call. Say goodbye and it
hangs up on its own.

## Make it your own

The demo agent lives in **`server/demo-config.js`** — edit `DEMO_SYSTEM_PROMPT`
to change its personality and job, and add entries to `DEMO_TOOLS` (with a local
handler in `execDemoTool`) to give it new abilities. Redeploy the file and
restart `voice-ai-agent`.

For per-caller prompts and tools driven by your own backend, see
[ADVANCED.md](ADVANCED.md).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Call rings but is not answered | `voice-ai-agent` not running, or UDP media is blocked. Check `journalctl -u voice-ai-agent` and the UFW rules for `10000–20000` and, when rtpengine is in the media path, `30000–40000`. |
| Answered, but silence | RTP not reaching the server — check `PUBLIC_IP` is correct and UFW allows your carrier's RTP range. |
| `no voice config` in the log, call declined | `INTERNAL_VOICE_URL` is set but unreachable. For the demo, leave it **blank**. |
| INVITE rejected `403`/`404` | Trunk auth or number format — see [DIDWW-SETUP.md](DIDWW-SETUP.md). |
| `drachtio` not connecting | `DRACHTIO_SECRET` in `.env` does not match `provision/drachtio.conf.xml`. |

More detail and the production reference: [DEPLOYMENT.md](DEPLOYMENT.md).
