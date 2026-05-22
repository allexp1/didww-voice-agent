# Architecture

A technical overview of how `didww-voice-agent` fits together — the processes,
the media path, and the lifecycle of a call. For setup and operations see the
sibling docs:

- [`../README.md`](../README.md) — project overview
- [`QUICKSTART.md`](QUICKSTART.md) — get a call answered fast
- [`DIDWW-SETUP.md`](DIDWW-SETUP.md) — SIP trunk + DID configuration
- [`CONFIGURATION.md`](CONFIGURATION.md) — environment variables
- [`ADVANCED.md`](ADVANCED.md) — outbound, conferences, WhatsApp, external config service
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — production inventory, ports, firewall, recovery

Placeholders used below: domain `voice.example.com`, public IP `203.0.113.10`.

---

## 1. Components

The stack is four moving parts: two Docker containers, a TLS reverse proxy, and
the Node.js application.

### drachtio — SIP signalling

A standalone SIP server (`drachtio/drachtio-server`, Docker, host networking).
It owns the SIP transports — UDP/TCP `5060`, SIP-TLS `5061`, and SIP-over-WSS
`8443` for browser softphones — and speaks to the Node app over a private admin
connection on `127.0.0.1:9022` using the drachtio control protocol. The Node app
connects as a client (`drachtio-srf`); drachtio handles digest authentication,
dialog state, and the SIP wire format, while the app decides what to do with
each INVITE. Config: [`provision/drachtio.conf.xml`](../provision/drachtio.conf.xml).

### rtpengine — RTP/SRTP media + transcoding

A kernel-assisted media proxy (Docker, host networking), reached over the
bencoded **NG protocol** on `127.0.0.1:22222`. It is **not** in the path of
every call (see §4) — the agent terminates plain narrowband/wideband RTP
itself. rtpengine is engaged when a call needs codec transcoding, SRTP/DTLS
termination (WebRTC), or media bridging.

The image is **custom-built** ([`provision/rtpengine-evs/Dockerfile`](../provision/rtpengine-evs/Dockerfile)):
the stock image carries no 3GPP **EVS** codec, so the Dockerfile builds
`lib3gpp-evs.so` from the TS 26.443 floating-point reference source and a
recent rtpengine daemon from source, then runs rtpengine with
`--evs-lib-path`. This adds EVS transcoding on top of the AMR-NB/WB and other
codecs ffmpeg provides.

### Caddy — TLS reverse proxy

Terminates HTTPS on `:443` with automatic Let's Encrypt certificates and
reverse-proxies to the loopback-bound Node services. It is the only component
exposed to the public web for HTTP. Routes ([`provision/Caddyfile`](../provision/Caddyfile)):

| Path | Proxied to | Purpose |
|---|---|---|
| `/v1/calls/*` | `127.0.0.1:3002` | agent control API (outbound, conference, announce) |
| `/api/waba/*` | `127.0.0.1:3000` | WhatsApp bridge — IP-restricted to the control app |
| `/healthz` | `127.0.0.1:3000` | health probe |
| `/sip` | `127.0.0.1:8443` | drachtio SIP-over-WSS for the browser softphone |

A companion timer (`drachtio-cert-sync`) copies Caddy's issued certificate into
the drachtio container so SIP-TLS and WSS share the same trust chain as HTTPS.

### Node.js services (`server/`)

| Process | Role | drachtio INVITE stream |
|---|---|---|
| `agent.js` | Inbound 1:1 Gemini agent, outbound PSTN, 3-leg conferences, WABA bridge endpoint | owns it (production) |
| `webhook.js` | WhatsApp Business Calling (WABA) media bridge control API | no |
| `echo-test.js` | Codec-agnostic RTP reflector — trunk smoke test | owns it (exclusive) |
| `call-forward.js` | SIP B2BUA that forwards every inbound call to `FORWARD_TO` | owns it (exclusive) |

`agent.js`, `echo-test.js`, and `call-forward.js` each register as *the*
drachtio application and consume the inbound INVITE stream, so exactly one runs
at a time — the systemd units declare `Conflicts=` on each other. `webhook.js`
is signalling-free (HTTP only) and runs alongside `agent.js`.

`agent.js` also runs a loopback-bound control API on `127.0.0.1:3002` (Express)
for outbound calls, conferences, mid-call announcements, and WABA session
control. Public `/v1/calls/*` requests are HMAC-SHA256 authenticated
(`VOICE_VPS_ANNOUNCE_SECRET`); internal `/session/*` requests use a bearer token
(`INTERNAL_VOICE_TOKEN`).

---

## 2. Inbound 1:1 call path

The common case — a PSTN caller reaching the AI agent — with **no rtpengine in
the media path**:

```
   ┌──────────┐     PSTN      ┌──────────────┐
   │  Caller  │──────────────▶│  DIDWW DID   │   carrier owns the phone number
   │  (phone) │               │   (carrier)  │
   └──────────┘               └──────┬───────┘
                                     │ SIP INVITE (UDP/TCP/TLS 5060/5061)
                                     │ + SDP offer
                                     ▼
                          ┌─────────────────────┐
                          │      drachtio       │   SIP server (Docker)
                          │   SIP transports    │
                          └──────────┬──────────┘
                                     │ drachtio admin protocol
                                     │ (127.0.0.1:9022)
                                     ▼
   ┌───────────────────────────────────────────────────────────┐
   │                        agent.js                            │
   │                                                             │
   │   srf.invite()  ─ negotiate codec ─ fetch voice config      │
   │       │                                                     │
   │       ├── RTP socket (UDP, port 10000–20000) ───────────────┼──▶ caller
   │       │     decode ─ resample 16k ─┐         ┌─ encode ─ RTP │   RTP audio
   │       │                            ▼         │               │   (both ways)
   │       │                   ┌──────────────────┴──┐            │
   │       └──── WebSocket ────▶│   Gemini Live API   │            │
   │             16k PCM in     │   (model: Aria)     │            │
   │             24k PCM out    └─────────────────────┘            │
   │                                                               │
   │   Deepgram WS (per-leg STT)  ◀── 16k caller audio              │
   └───────────────────────────────────────────────────────────────┘
```

The caller's RTP terminates directly on a UDP socket bound by `agent.js` in the
`RTP_PORT_MIN`–`RTP_PORT_MAX` range. The agent decodes it, resamples to 16 kHz,
and streams it to **Gemini Live** over a WebSocket; Gemini's 24 kHz audio is
resampled down, re-encoded, and paced back to the caller as RTP. The carrier's
DID delivers the INVITE to drachtio because either the trunk is
IP-authenticated (DIDWW two-way trunk) or `trunk-register.js` keeps a SIP
REGISTER alive (registration-based trunk).

---

## 3. Inbound 1:1 lifecycle in `agent.js`

The whole 1:1 call runs inside `runCallSession()`. Step by step:

### 3.1 INVITE handling

`srf.invite()` receives the INVITE. A request-URI of `sip:conf-<id>@…` branches
to the browser-conference path; everything else is a normal inbound call. The
agent rejects with `503` while shutting down and `486 Busy Here` at
`MAX_CONCURRENT_CALLS`. It parses the SDP offer (`sdp-transform`), finds the
audio `m=` line, and reads the caller's RTP `host:port`. The caller's E.164
identity is extracted from the `From` header and normalized
(`normalizeToE164Digits` — handles `+`, `00`, and bare-national formats).

### 3.2 SDP / codec negotiation — `chooseCodec`

`chooseCodec()` picks the best codec from the offer:

1. **L16/16000** (uncompressed wideband linear PCM) — preferred. No transcoding
   loss; the agent's working rate is already 16 kHz.
2. **PCMU/8000** (G.711 µ-law) — narrowband fallback. Universally supported.
3. **Neither offered** → `bridgePstnLeg()` routes the call through **rtpengine**,
   which transcodes the caller's codec (AMR-NB/WB, G.729, …) ↔ PCMU. The agent
   then runs its well-tested PCMU narrowband path against rtpengine's loopback
   leg instead of against the caller directly.

For the direct (L16/PCMU) path the agent builds an SDP answer advertising the
chosen codec plus `telephone-event`, binds an RTP socket, and answers the
INVITE with `srf.createUAS()`.

### 3.3 Voice config — the demo-config fallback

Before answering, the agent loads the assistant configuration
(`fetchVoiceConfig`): the system prompt, tool declarations, locale, and caller
context.

- **No external service** (`INTERNAL_VOICE_URL` unset, the default) →
  `getDemoVoiceConfig()` from [`server/demo-config.js`](../server/demo-config.js)
  returns the built-in **demo agent**. A fresh clone answers real calls with a
  working "Aria" persona using nothing but a SIP trunk and a Gemini API key — no
  database, no second service.
- **External service set** → the agent POSTs to `/api/v1/voice/config` and gets
  a per-caller prompt and tools. If that service is configured but unreachable,
  the call is **declined** (`503`) rather than answered prompt-less. See
  [`ADVANCED.md`](ADVANCED.md).

### 3.4 The Gemini Live session

`runCallSession()` opens a Gemini Live WebSocket (`ai.live.connect`, model
`GEMINI_MODEL`, default `gemini-3.1-flash-live-preview`). The session config
sets:

- `responseModalities: [AUDIO]` and a TTS `speechConfig` (voice `Aoede`,
  caller locale).
- `inputAudioTranscription` / `outputAudioTranscription` — drive the transcript.
- `realtimeInputConfig.automaticActivityDetection` — server-side VAD: low
  start-sensitivity (ignores background noise), high end-sensitivity (commits
  turn-end fast), with `START_OF_ACTIVITY_INTERRUPTS` for barge-in.
- `sessionResumption` and `contextWindowCompression.slidingWindow` — survive WS
  drops and avoid token-limit truncation on long calls.
- `systemInstruction` — the voice-config system prompt, plus an injected
  current-time block and an `end_call` usage guide.

On `setupComplete` the agent sends a kickoff text turn so Aria greets the caller
first.

### 3.5 The audio path

**Caller → Gemini.** Inbound RTP packets are filtered to the negotiated payload
type (DTMF `pt 101` ignored), the payload extracted with a CSRC/extension-aware
parser (`rtpPayload` — honours the X bit, which rtpengine sets on transcoded
legs). Decoded PCM is buffered two packets (~40 ms) at a time, resampled to
16 kHz (`libsamplerate`, sinc medium-quality — skipped when the codec is already
16 kHz), and sent to Gemini base64-encoded as `audio/pcm;rate=16000`. The same
16 kHz audio is forked to Deepgram (§7).

**Gemini → caller.** Gemini streams 24 kHz PCM across many WS messages. The
agent accumulates it and resamples in one batch every ~40 ms (`flushOut24`) to
cut sinc-edge transients, downsampling 24 kHz → codec rate, then appends to the
outbound queue.

**The 20 ms drift-corrected pacer.** A single sender loop (`pace()`) emits one
20 ms RTP frame per tick. Rather than trusting `setInterval` (1–10 ms of
event-loop jitter, which causes audible jitter-buffer underruns/overruns), it
tracks absolute wall-clock time and emits catch-up packets if a tick was late.
When the outbound queue is empty it sends codec silence and sets the RTP marker
bit on the next real frame.

### 3.6 VAD / barge-in

Two layers. Gemini's own server-side VAD (above) detects speech and, with
`START_OF_ACTIVITY_INTERRUPTS`, fires an `interrupted` event when the caller
talks over Aria — the agent then flushes the outbound queue and the pending
24 kHz buffer so Aria stops mid-sentence. Separately, a cheap RMS gate on each
inbound frame (`VAD_RMS_THRESHOLD`) tracks `lastCallerActivityAt`, used by the
mid-call announcement worker to decide when the caller is silent enough to
inject an announcement.

### 3.7 Tools — `end_call`

`end_call` is a local tool always added by `agent.js`, independent of the config
source. When Gemini calls it the agent schedules a hangup *after* the current
speaking turn drains (so Aria's goodbye plays out), then runs the
channel-specific `endCall` callback — a SIP `BYE` for PSTN, a Meta-terminate
request for WABA. A 10 s safety timer forces the hangup if `turnComplete` never
arrives. Other tools are proxied to the external config service
(`execToolRemote`) or, in demo mode, executed locally (`execDemoTool`, e.g.
`get_current_time`).

### 3.8 Summary, transcript, hard caps

The caller's turns come from **Deepgram** STT; Aria's turns from Gemini's
`outputTranscription`. Each turn is appended to `meta.transcript` and, when an
external service is configured, streamed live via `/api/v1/voice/turn`. On
teardown the agent posts a call summary (`/api/v1/voice/summary`, idempotent,
with exponential-backoff retry) carrying duration, transcript, tool calls, and
end reason. A per-call hard cap (`MAX_CALL_SECONDS`, default 600 s) guards
against runaway model spend. `terminate()` closes the RTP socket, the Gemini
session, Deepgram, and the resamplers, and is wired to the SIP dialog's
`destroy` event so a caller hangup tears everything down.

---

## 4. When rtpengine is — and is not — needed

This is the key architectural distinction.

**Not needed.** A plain inbound 1:1 call whose SDP offers **PCMU** or **L16** is
terminated **directly by `agent.js`**: the agent binds its own RTP socket and
encodes/decodes the media itself. drachtio handles signalling; rtpengine is
never contacted. A PCMU/L16 inbound-only deployment can run without the
rtpengine container at all.

**Required.** rtpengine is engaged whenever the media cannot be handled with a
plain narrowband/wideband RTP socket:

| Scenario | Why rtpengine |
|---|---|
| **Inbound codec transcoding** | Caller offers AMR-NB/WB, G.729, EVS, … — no native codec → transcode ↔ PCMU. |
| **Outbound PSTN calls** | The agent offers the carrier an EVS/AMR-WB quality ladder; rtpengine transcodes L16 ↔ whatever the carrier picks. |
| **Conferences** | Bridging two legs — passthrough relay (phone↔phone) or per-leg transcode for browser/WhatsApp legs. |
| **WhatsApp / WABA** | Meta's leg is WebRTC: ICE + DTLS-SRTP + Opus. rtpengine terminates the WebRTC/SRTP and transcodes Opus ↔ PCMU/G.722. |

So: signalling always goes through drachtio; **media** goes through rtpengine
only when transcoding or SRTP/DTLS termination is required.

---

## 5. Advanced call types

Brief overviews — see [`ADVANCED.md`](ADVANCED.md) for the full choreography.

### Outbound PSTN calling

`POST /v1/calls/outbound` triggers `placeOutboundPstn()`. Every outbound leg is
routed through rtpengine: the agent hands rtpengine a lossless **L16/16k** SDP
over loopback, and rtpengine rewrites it into a carrier-facing offer presenting
a quality ladder (`EVS, AMR-WB, AMR, PCMU, PCMA`) — list order is SDP
preference, with G.711 last so a call never fails on codec negotiation.
drachtio places the INVITE (`srf.createUAC`, digest auth when `SIP_USER` is set,
IP auth otherwise); rtpengine transcodes L16 ↔ the negotiated carrier codec. The
answered leg is then bridged into a normal `runCallSession()` Gemini session.

### 3-leg conferences

A conference joins a staff leg and a customer leg with Aria as a quiet third
participant. `agent.js` has **two bridge strategies**:

- **rtpengine passthrough bridge** (`runBridgedConference`) — for pure
  phone↔phone conferences. The staff leg is dialed first against the full codec
  ladder; the customer leg is then offered only the codec the staff leg picked,
  so both converge and rtpengine relays with **zero transcoding** and no added
  latency. The agent never touches the call media — it only side-taps each leg
  (rtpengine `subscribe`) for Deepgram transcription. Aria is not present.
- **Node mixer** (`runConferenceSession`) — for conferences with a browser or
  WhatsApp leg (which cannot speak EVS/AMR). A 20 ms drift-corrected mixer with
  per-leg jitter buffers bridges the humans and can feed mixed audio to a
  native-audio Gemini "Aria" running with Proactive Audio. (Aria is currently
  disabled for outbound — the path is preserved in code; conferences run as a
  staff↔customer bridge with per-leg Deepgram STT.)

A browser staff leg joins as a SIP UAC over WSS (`/sip` → drachtio); rtpengine
terminates its WebRTC/DTLS-SRTP/Opus leg into a plain RTP/AVP leg the mixer
consumes like any other.

### WhatsApp / WABA media bridge

`webhook.js` is a media-bridge control API for **WhatsApp Business Calling**. A
control app POSTs Meta's WebRTC SDP to `/api/waba/connect`; `webhook.js` drives
rtpengine via the NG protocol to terminate Meta's WebRTC leg (ICE, DTLS-SRTP,
Opus) and produce a plain RTP/AVP leg, then asks `agent.js` (`/session/waba-start`)
to bind an RTP socket and spawn a Gemini Live session for it. rtpengine
transcodes Opus ↔ L16/PCMU and drives the DTLS handshake (it must be the DTLS
client, since Meta's endpoint is ICE-lite and always DTLS-passive). Outbound
WABA and WABA conference legs are the mirror image (the agent is the offerer).
WABA media uses the rtpengine port range (`30000–40000`), which is restricted
to DIDWW by default and opened to the internet only when the firewall script is
run with `ENABLE_WABA=1`; Meta's edge IPs are not stable enough to allow-list.

---

## 6. Codecs

The agent encodes/decodes a small set of codecs natively; rtpengine covers the
rest by transcoding.

| Codec | Where | Notes |
|---|---|---|
| **PCMU** (G.711 µ-law) | native — `agent.js` | 8 kHz narrowband, payload type 0. Universal PSTN fallback; the agent's safe default. |
| **L16** | native — `agent.js` | 16 kHz uncompressed linear PCM. Preferred inbound; used as the lossless loopback codec to rtpengine for outbound. |
| **G.722** | native — [`server/g722.js`](../server/g722.js) | 16 kHz wideband sub-band ADPCM (a public-domain SpanDSP port). Used for WhatsApp/WABA legs and WABA conferences — HD wideband instead of narrowband G.711. Its RTP clock is 8 kHz by RFC 3551 convention despite 16 kHz audio. |
| **EVS / AMR-WB / AMR-NB / G.729 / …** | rtpengine transcode | Carrier-side codecs. The custom rtpengine image adds **3GPP EVS** (TS 26.443); AMR and others come from ffmpeg. The agent never decodes these — rtpengine transcodes them to a codec the agent speaks. |

> **EVS is patent-encumbered and optional.** No freely distributable EVS
> implementation exists, so rtpengine `dlopen()`s an external `lib3gpp-evs.so`
> built from the 3GPP reference source. If you do not need EVS, a stock
> rtpengine image works for AMR and the rest — see
> [`provision/rtpengine-evs/Dockerfile`](../provision/rtpengine-evs/Dockerfile)
> and [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## 7. Live transcription

Transcription is **per-leg STT via Deepgram**. Each human leg of a call opens
its own Deepgram streaming WebSocket (`nova-3` by default), so speaker
attribution is exact — no guessing from mixed audio. For the inbound 1:1 call
the caller's 16 kHz audio is forked to Deepgram for the `user` turns, while
Aria's turns come from Gemini's own `outputTranscription` (the model's literal
output text, which streams cleanly). Conference legs each get their own stream.

An optional auto-language step (`startDeepgramStreamAuto`) buffers the first
~2.5 s of a leg's audio, runs a one-shot `detect_language` batch call, then
pins the streaming socket to the detected language; inconclusive detection
falls back to `DEEPGRAM_LANGUAGE`.

If `DEEPGRAM_TOKEN` is unset, the inbound caller transcript **falls back to
Gemini's own ASR** (`inputTranscription`) — lower fidelity on short or noisy
bursts, but the call still works and still produces a transcript. See
[`CONFIGURATION.md`](CONFIGURATION.md) for the Deepgram variables.
