# didww-voice-agent

**Self-hosted AI voice agent for DIDWW SIP trunks.** Point a DIDWW phone number
at your own server and callers talk to a Google Gemini Live agent — speech in,
speech out, in real time.

This is a complete, working example of using **DIDWW two-way SIP trunks and DIDs
to build voice AI agents**: SIP signalling, RTP media, codec negotiation,
transcoding, and a realtime bridge to a multimodal LLM — all self-hosted, with
no SaaS voice platform in the path.

> **Works out of the box.** With a DIDWW trunk and a Gemini API key, a fresh
> clone answers real phone calls using a built-in demo agent — no database, no
> second service. The demo agent can even explain how it works while you're on
> the call. See **[docs/QUICKSTART.md](docs/QUICKSTART.md)**.

## How it works

```
   PSTN caller
        │   dials your DIDWW number
        ▼
   DIDWW two-way SIP trunk
        │   SIP INVITE + RTP media
        ▼
   ┌──────────────────────────────────────────────────┐
   │  your server                                     │
   │                                                  │
   │   drachtio ─────▶ agent.js ──── WebSocket ───▶ Gemini Live
   │   (SIP server)    (Node.js)                    (Google)
   │                      │                           │
   │                      └──▶ rtpengine ◀────────────┘
   │                           (RTP media / transcoding)
   └──────────────────────────────────────────────────┘
```

- **drachtio** — SIP server, runs in Docker.
- **rtpengine** — RTP/SRTP media and transcoding, runs in Docker.
- **Caddy** — TLS reverse proxy with automatic Let's Encrypt certificates.
- **Node.js agent** — bridges RTP audio to the Gemini Live API over a WebSocket,
  and handles tools, transcripts and call control.

A plain G.711 inbound call is bridged by the Node agent directly; rtpengine is
only needed for codec transcoding, outbound calls, conferences and WhatsApp.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Features

- **Inbound voice agent** — Gemini Live, natural barge-in, tool calling, and a
  live transcript of the call.
- **Built-in demo agent** — answers calls with zero external services; edit one
  file (`server/demo-config.js`) to make it your own.
- **Outbound calling** — place PSTN calls out through the trunk.
- **3-leg conferences** — bridge two phones, with an optional AI co-listener.
- **WhatsApp Business Calling bridge** — optional, advanced.
- **Pluggable per-caller config** — connect your own prompt/tool service for
  dynamic, per-caller agents.
- **Full host provisioning** — reproduce the whole server from scratch on a
  fresh Ubuntu 24.04 host.
- **Codec support** — G.711, G.722, L16 out of the box; EVS / AMR-WB / AMR-NB
  via an optional custom rtpengine image.
- **Diagnostics** — a SIP echo test and a call-forward utility.

## Quick start

1. Get a server (Ubuntu 24.04, public IPv4), a **DIDWW DID + two-way SIP trunk**,
   and a **Google Gemini API key**.
2. Provision the host and deploy the agent — `provision/` has the scripts.
3. Fill in `.env` (only five values are needed for the demo).
4. Point your DIDWW number at the server and call it.

The step-by-step walkthrough is in **[docs/QUICKSTART.md](docs/QUICKSTART.md)**;
the DIDWW side is in **[docs/DIDWW-SETUP.md](docs/DIDWW-SETUP.md)**.

## Repository layout

```
server/             Node.js application
  agent.js            inbound agent + outbound + conferences + control API
  webhook.js          WhatsApp / WABA media bridge
  demo-config.js      built-in demo agent (used when no config service is set)
  echo-test.js        RTP echo reflector — trunk smoke test
  call-forward.js     SIP B2BUA call forwarder
  g722.js             G.722 codec
  rtpengine.js        rtpengine NG-protocol client
  trunk-register.js   SIP REGISTER keep-alive (registration trunks only)
provision/          host provisioning for a fresh Ubuntu 24.04 server
  10-base.sh · 20-harden.sh · 30-containers.sh · 40-ufw.sh
  Caddyfile · drachtio.conf.xml · *.service · rtpengine-evs/Dockerfile
tools/              diagnostics (rtpengine bridge probe)
docs/               documentation
.env.example        configuration template — copy to .env
```

## Requirements

- **A server** — Ubuntu 24.04 with a public IPv4. Around 1 vCPU / 1 GB RAM
  handles a handful of concurrent calls.
- **A DIDWW account** — at least one DID and a two-way SIP trunk. See
  [docs/DIDWW-SETUP.md](docs/DIDWW-SETUP.md).
- **A Google Gemini API key** — from [Google AI Studio](https://aistudio.google.com/apikey).
- *(Optional)* a **Deepgram API key** for higher-quality live transcription.

## Documentation

| Doc | What it covers |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md)     | Fastest path to a talking agent |
| [DIDWW-SETUP.md](docs/DIDWW-SETUP.md)   | Buy a DID, create a two-way trunk, wire it up |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How SIP, RTP and Gemini fit together |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Every environment variable |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)     | Full production deployment reference |
| [ADVANCED.md](docs/ADVANCED.md)         | Outbound, conferences, WhatsApp, custom config service |

## Security

This stack terminates SIP and RTP from the public internet — telephony is a
target for toll fraud and abuse. The provisioning scripts firewall SIP/RTP to
your carrier's IP ranges, and the agent enforces per-call and concurrency caps.
Read **[SECURITY.md](SECURITY.md)** before exposing it, and generate fresh
secrets — the values in `.env.example` and `provision/drachtio.conf.xml` are
placeholders.

## License

MIT — see [LICENSE](LICENSE). See [NOTICE](NOTICE) for third-party components
(drachtio, rtpengine, Caddy) and an important note on patent-encumbered codecs
(EVS / AMR). Not affiliated with or endorsed by DIDWW, Google or Meta.
