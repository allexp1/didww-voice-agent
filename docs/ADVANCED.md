# Advanced features

`didww-voice-agent` ships with a working AI phone agent out of the box — a
DIDWW SIP trunk, a Gemini API key, and the built-in
[`server/demo-config.js`](../server/demo-config.js) prompt are all that is
needed to answer calls. See [QUICKSTART.md](QUICKSTART.md) for that path.

This document covers the **optional** features that go beyond the demo. Every
one of them is off by default and none is required to run the agent:

1. [The external config service ("control app")](#1-the-external-config-service)
2. [The agent control API](#2-the-agent-control-api)
3. [Outbound PSTN calling](#3-outbound-pstn-calling)
4. [Conferences](#4-conferences)
5. [WhatsApp Business Calling (WABA)](#5-whatsapp-business-calling-waba)
6. [Mid-call announcements](#6-mid-call-announcements)

Throughout, the public hostname is written `voice.example.com` and the
server's public IP `203.0.113.10`. Replace them with your own. See
[CONFIGURATION.md](CONFIGURATION.md) for the full environment variable
reference, [ARCHITECTURE.md](ARCHITECTURE.md) for the media-path design, and
[DEPLOYMENT.md](DEPLOYMENT.md) for the production host inventory.

---

## 1. The external config service

By default, [`server/agent.js`](../server/agent.js) gets the system prompt and
tool declarations for every call from the built-in
[`server/demo-config.js`](../server/demo-config.js): one prompt, one locale,
the same for every caller.

When you set **both** `INTERNAL_VOICE_URL` and `INTERNAL_VOICE_TOKEN`, the
agent instead calls an external HTTP service — referred to here as **the
control app** — for a *per-caller* prompt and tool set, and posts call
transcripts, summaries and state back to it. This lets you give known callers a
personalised assistant, run real tools (CRM lookups, bookings, …), and drive
calls from your own backend.

The control app is **your** code. This project does not ship one; this section
documents the HTTP contract precisely enough that you can build your own.

```
agent.js  ──fetch──▶  control app   (per-caller config, tools, hangup,
   ▲                                 summary, turn, call-state, waba-leg)
   │
   └──── control app ──HMAC fetch──▶ agent control API   (§2)
```

### Common conventions

* **Base URL** — every path below is appended to `INTERNAL_VOICE_URL` (a
  trailing slash on the env value is stripped). With
  `INTERNAL_VOICE_URL=https://app.example.com`, the config endpoint is
  `https://app.example.com/api/v1/voice/config`.
* **Auth** — every request from the agent to the control app carries
  `Authorization: Bearer ${INTERNAL_VOICE_TOKEN}` and
  `Content-Type: application/json`.
* **Failure handling** — if a call is unreachable, the agent logs a warning
  and degrades gracefully (see each endpoint). It never crashes a call because
  the control app is down.
* **`waId`** — the caller identity key: the caller's phone number normalised
  to E.164 **digits only** (no `+`, no `00`). The agent derives it from the
  SIP `From` header (inbound), the dialled number (outbound), or Meta's caller
  ID (WABA).

### `POST /api/v1/voice/config`

Fetched once per call, before the agent answers, by `fetchVoiceConfig()`.

Request body:

```json
{ "waId": "441234567890", "name": null }
```

Expected `200` response — the per-caller assistant configuration:

```json
{
  "systemPrompt": "You are Aria, the assistant for ...",
  "tools": [
    {
      "name": "lookup_order",
      "description": "Look up an order by its number.",
      "parameters": {
        "type": "object",
        "properties": { "order_no": { "type": "string" } },
        "required": ["order_no"]
      }
    }
  ],
  "contact": { "id": 4271 },
  "conversationId": "conv_abc123",
  "locale": { "languageCode": "en-GB" }
}
```

| Field | Required | Notes |
|---|---|---|
| `systemPrompt` | **yes** | The Gemini system instruction. If absent/empty the agent **declines the call** — it never answers prompt-less. |
| `tools` | no | Array of Gemini function declarations. The agent always adds its own `end_call`; a `tools` entry named `end_call` is ignored. |
| `contact` | no | Opaque; only `contact.id` is logged. |
| `conversationId` | no | Echoed back on every `/tool` call so the control app can correlate. |
| `locale.languageCode` | no | BCP-47. Pins Gemini's TTS/ASR language. Falls back to `GEMINI_LANGUAGE_CODE`, then `en-US`. |

Behaviour on failure: a non-`200` or a network error makes
`fetchVoiceConfig()` return `null`, and the call is **declined** (SIP `503` on
inbound). The agent does **not** fall back to the demo config when
`INTERNAL_VOICE_URL` is set — a configured-but-unreachable control app is
treated as a hard error so callers never get a degraded bot. Request timeout:
5 s.

### `POST /api/v1/voice/tool`

Called by `execToolRemote()` every time Gemini invokes one of the `tools` from
the config response. (`end_call` is handled locally by the agent and is
**not** proxied here.)

Request body:

```json
{
  "callId": "a1b2c3d4...",
  "waId": "441234567890",
  "conversationId": "conv_abc123",
  "name": "lookup_order",
  "args": { "order_no": "SO-5567" }
}
```

`callId` is included so the control app can attach work to the live call and,
if it wishes, fire a mid-call announcement back via
`POST /v1/calls/{callId}/announce` (see §6) while the tool runs.

Expected `200` response:

```json
{ "result": "Order SO-5567 ships tomorrow by courier." }
```

The agent reads `result` (preferred) or `error`, coerces it to a string, and
hands it back to Gemini, which speaks it. Return a short, speakable string.
Request timeout: 20 s; on timeout/error the model receives
`Error: tool proxy failed — …`.

### `POST /api/v1/voice/hangup`

Called by `wabaHangupRemote()` when Gemini's `end_call` tool fires on a
**WABA** call. The agent owns the Gemini and RTP legs but only the control app
holds the Meta access token needed to terminate the WhatsApp call, so it asks
the control app to do it.

Request body:

```json
{ "callId": "a1b2c3d4...", "waId": "441234567890",
  "reason": "caller said goodbye", "channel": "waba" }
```

Expected response: any `200`. A non-`200` or error is logged; the agent does
its own local teardown regardless. Request timeout: 8 s. Only invoked when
`INTERNAL_VOICE_URL`/`INTERNAL_VOICE_TOKEN` are set.

### `POST /api/v1/voice/summary`

Posted once per call when the call ends, by `postVoiceSummary()` via the
`postWithBackoff()` helper (retries at 0 / 1 / 3 / 9 s, then gives up).
Idempotent: the agent posts each `callId` only once, and the control app
should also de-dupe on `callId`.

Request body (the call's `meta` object):

```json
{
  "waId": "441234567890",
  "callerName": null,
  "channel": "pstn",
  "callId": "a1b2c3d4...",
  "direction": "inbound",
  "status": "COMPLETED",
  "endReason": "caller said goodbye",
  "startedAt": "2026-05-22T10:00:00.000Z",
  "endedAt":   "2026-05-22T10:02:13.000Z",
  "durationSec": 133,
  "transcript": [
    { "role": "user", "text": "Hi ...", "ts": "2026-05-22T10:00:03.000Z" },
    { "role": "assistant", "text": "Hello ...", "ts": "2026-05-22T10:00:05.000Z" }
  ],
  "toolCalls": [
    { "name": "lookup_order", "args": { "order_no": "SO-5567" },
      "result": "Order SO-5567 ...", "ts": "2026-05-22T10:01:10.000Z" }
  ]
}
```

* `channel` is `pstn` or `waba`; `direction` is `inbound` or `outbound`.
* `status` is `COMPLETED` or `FAILED`. A call that completed with no media and
  no transcript is downgraded to `FAILED` with `endReason: "no media"`.
* `transcript[].role` is `user`, `assistant`, or — in a conference — `staff`.
  Announcement-driven assistant turns are prefixed `[announcement] `.

Expected response: any `200`. If the JSON body contains a `messageId`, the
agent logs it. Request timeout per attempt: 8 s.

### `POST /api/v1/voice/turn`

Posted by `postVoiceTurn()` on every completed conversational turn (each
Gemini `turnComplete` / `interrupted`, and each finalised STT utterance in a
conference), so the control app's UI can show a live transcript instead of
waiting for the end-of-call summary. Same `callId` as `/summary`. Fire-and-
forget through `postWithBackoff()`.

Request body:

```json
{
  "waId": "441234567890",
  "callerName": null,
  "channel": "pstn",
  "callId": "a1b2c3d4...",
  "turnIndex": 4,
  "role": "assistant",
  "text": "Your order ships tomorrow.",
  "ts": "2026-05-22T10:01:12.000Z",
  "staffName": null
}
```

`turnIndex` increments per call; `role` is `user` / `assistant` / `staff`;
`staffName` is set only for `staff` turns in a conference. Expected response:
any `200`.

### `POST /api/v1/voice/call-state`

Posted by `postCallState()` for outbound and conference legs as they progress,
so the control app's UI can show live call progress. Fire-and-forget through
`postWithBackoff()`. This endpoint is optional on the control app — the agent
tolerates it not existing.

Request body:

```json
{ "callId": "a1b2c3d4...", "state": "ringing",
  "leg": "customer", "ts": "2026-05-22T10:00:01.000Z" }
```

`state` is one of `ringing`, `answered`, `failed`, `ended`. Extra fields
depend on the state — e.g. `leg` (`staff` / `customer`), `reason`,
`durationSec`, `customerWaId`. Expected response: any `200`.

### `POST /api/v1/voice/waba-leg`

Called by `requestWabaLeg()` when a conference leg needs to ring over
WhatsApp. Only the control app holds the Meta credentials to place a WhatsApp
call, so the agent asks it to start one; the leg connects asynchronously and
flows back through the WABA bridge (see §5).

Request body:

```json
{ "callId": "a1b2c3d4...", "role": "customer", "waId": "441234567890" }
```

`role` is `staff` or `customer`. Expected `200` response:

```json
{ "ok": true }
```

Return `{ "ok": false, "reason": "..." }` (or a non-`200`) to signal failure;
the agent fails that conference leg with the given reason. Request timeout:
15 s.

### Announcement acks

Not under `INTERNAL_VOICE_URL`. When a mid-call announcement (§6) carries an
`ack_callback_url`, the agent `POST`s the outcome to that **absolute** URL with
`Authorization: Bearer ${INTERNAL_VOICE_TOKEN}`. See §6 for the body.

---

## 2. The agent control API

The control app drives the agent — places calls, starts conferences, injects
announcements — through a second Express app inside `agent.js`, the **control
API**. It listens on `127.0.0.1:3002` and is exposed publicly by Caddy:

```
https://voice.example.com/v1/calls/*   →   127.0.0.1:3002
```

There are two route families with two different auth schemes.

### `/v1/calls/*` — HMAC-authenticated

These are reachable over the public Internet (via Caddy). They are protected
by an HMAC-SHA256 signature so a leaked token alone is not enough to call them.

| Method & path | Purpose |
|---|---|
| `POST /v1/calls/outbound` | Place an outbound PSTN call (§3) |
| `POST /v1/calls/conference` | Start a 3-leg conference (§4) |
| `POST /v1/calls/{callId}/announce` | Queue a mid-call announcement (§6) |
| `GET  /v1/calls/{callId}/status` | Live status of a call |
| `POST /v1/calls/{callId}/aria` | Mute / unmute / ask the conference assistant (§4) |

#### HMAC scheme

Implemented by `requireHmac` in `agent.js`. The control app must sign every
`/v1/calls/*` request like this:

1. Take the current Unix time in **seconds**: `ts`.
2. Take the **verbatim request body** as sent on the wire (the empty string
   for a `GET`). Compute `bodyHash = sha256_hex(body)`.
3. Build the signed string by joining four fields with `\n` (newline):

   ```
   <ts>\n<METHOD>\n<PATH>\n<bodyHash>
   ```

   * `METHOD` is upper-case (`POST`, `GET`).
   * `PATH` is the request path only — e.g. `/v1/calls/outbound` — no query
     string, no host.
4. `sig = HMAC_SHA256(key = VOICE_VPS_ANNOUNCE_SECRET, msg = signedString)`,
   hex-encoded.
5. Send it in the `Authorization` header:

   ```
   Authorization: VOICE-HMAC-SHA256 ts=<ts> sig=<hex>
   ```

Verification rules enforced by the agent:

* The header must match `VOICE-HMAC-SHA256 ts=<digits> sig=<hex>` exactly —
  otherwise `401 {"reason":"bad_sig"}`.
* `ts` must be within **60 seconds** of the server clock, or
  `401 {"reason":"timestamp_skew"}`. Keep clocks in NTP sync.
* The signature is compared in constant time; a mismatch is
  `401 {"reason":"bad_sig"}`.
* If `VOICE_VPS_ANNOUNCE_SECRET` is unset, every `/v1/calls/*` route returns
  `503 {"reason":"announce_secret_not_configured"}`.

Reference signer (Node.js):

```js
import crypto from 'node:crypto';

function signRequest(method, path, body, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signed = `${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
  const sig = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `VOICE-HMAC-SHA256 ts=${ts} sig=${sig}`;
}

// POST example
const body = JSON.stringify({ toNumber: '+441234567890' });
const auth = signRequest('POST', '/v1/calls/outbound', body, process.env.VOICE_VPS_ANNOUNCE_SECRET);
await fetch('https://voice.example.com/v1/calls/outbound', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: auth },
  body,
});

// GET example — body is the empty string
const gAuth = signRequest('GET', `/v1/calls/${callId}/status`, '', secret);
```

> The hash must be of the **exact bytes** you transmit. Serialize the JSON
> once, hash that string, and send that same string — do not re-serialize.

#### `GET /v1/calls/{callId}/status`

Returns the live status of a call. While the call is active:

```json
{
  "call_id": "a1b2c3d4...",
  "active": true,
  "started_at": 1747900800,
  "duration_ms": 41200,
  "caller_speaking": false,
  "model_speaking": true,
  "announce_queue_depth": 0
}
```

A conference returns `kind: "conference"` and, for the Node-mixer path,
`aria_muted` / `aria_connected`. For ~90 s after a call ends the route returns
`{ "call_id": ..., "active": false, "ended_at": <unix> }` instead of `404`, so
late polls still resolve. An unknown `callId` is `404
{"reason":"unknown_call_id"}`.

### `/session/*` — Bearer-authenticated

These routes are used by the WABA bridge ([`server/webhook.js`](../server/webhook.js))
on the same host. They are **not** exposed by Caddy — loopback only — so they
use a simpler `Authorization: Bearer ${INTERNAL_VOICE_TOKEN}` check
(`requireControlToken`). They are an internal interface between the two Node
processes, not part of the public control-app contract:

| Method & path | Purpose |
|---|---|
| `POST /session/waba-start` | Start a Gemini session for an inbound WABA call |
| `POST /session/waba-conf-alloc` | Reserve an RTP socket for a WABA conference leg |
| `POST /session/waba-conf-ready` | A WABA conference leg's media is up — bridge it |
| `POST /session/terminate` | Tear down a session by `callId` |

There is also an unauthenticated `GET /healthz` on `127.0.0.1:3002` returning
`{ ok, active_sessions, max_concurrent, shutting_down, drachtio_connected }`.

---

## 3. Outbound PSTN calling

`POST /v1/calls/outbound` (HMAC-authenticated, §2) places a call out through
the SIP trunk and bridges the answered leg into a Gemini Live session — the
same agent as an inbound call, but the agent dials out.

Requires the outbound trunk settings in `.env`: `SIP_DOMAIN` (and `SIP_USER` /
`SIP_PASSWORD` if the trunk is registration-based rather than IP-authenticated)
and `CLI` (a trunk-owned DID used as the caller ID). It also requires
rtpengine.

Request body:

```json
{ "toNumber": "+441234567890", "transport": "pstn", "callId": "optional" }
```

* `toNumber` — **required**. The number to dial; accepts `+E.164`, `00…`
  international, or national format.
* `transport` — optional, defaults to `pstn`. Only `pstn` is supported in this
  build; anything else returns `400 {"reason":"unsupported_transport"}`.
* `callId` — optional; the agent generates a UUID if omitted.

Immediate response — the call then sets up asynchronously (ringing takes
seconds):

```json
{ "callId": "a1b2c3d4...", "status": "dialing" }
```

If the agent is shutting down it returns `503 {"reason":"shutting_down"}`; at
the concurrency cap, `503 {"reason":"at_capacity"}`.

How it works (`placeOutboundPstn`):

1. The agent allocates an RTP socket and asks rtpengine to build a
   carrier-facing offer. The agent itself speaks only L16/PCMU/G.722, so it
   hands rtpengine a lossless **L16/16 kHz** leg over loopback and rtpengine
   offers the carrier a quality-ordered codec ladder
   (`EVS, AMR-WB, AMR, PCMU, PCMA`), transcoding L16 ↔ whatever the carrier
   picks. Outbound calls therefore default to the best quality the carrier
   accepts.
2. drachtio sends the `INVITE` to `sip:<number>@${SIP_DOMAIN}` with `From`
   carrying `CLI`. A SIP failure (`486` busy, `408`/`480` no-answer, `603`
   declined, …) is logged and the call is dropped.
3. On answer, rtpengine is given the carrier's answer SDP and returns the
   loopback endpoint; the agent then runs a normal `runCallSession` with
   `direction: "outbound"`.

Per-leg progress is reported to the control app via
`POST /api/v1/voice/call-state` (§1), and a `/summary` is posted when the call
ends.

---

## 4. Conferences

`POST /v1/calls/conference` (HMAC-authenticated, §2) sets up a **3-leg
conference**: a staff member, a customer, and optionally a quiet AI
co-listener. It returns immediately; legs ring asynchronously.

Two staff-leg styles are supported.

### "Via my phone" — both legs are phones

The staff and customer legs are each a PSTN number or a WhatsApp contact.
Request body:

```json
{
  "mode": "phone",
  "staffChannel": "pstn",     "staffNumber": "+441111111111",
  "customerChannel": "pstn",  "customerNumber": "+442222222222",
  "staffName": "Sam"
}
```

Use `staffWaId` / `customerWaId` instead of `…Number` when that leg's
`…Channel` is `whatsapp` (alias `waba`). The agent dials the **staff** leg
first; once they answer it dials the customer, then bridges. Response:
`{ "callId": ..., "status": "dialing" }`.

#### Two bridging paths

* **rtpengine passthrough** — used when **both** legs are PSTN. The two phone
  legs are bridged *inside rtpengine* with zero transcoding: the first leg
  dialled negotiates the full `EVS/AMR-WB/AMR/PCMU` ladder, the second is
  offered only the codec the first picked, both converge, and rtpengine
  relays. The agent never touches the call audio — it only forks a decoded
  copy of each leg to Deepgram for live transcription. Lowest latency, highest
  quality.
* **Node mixer** (`runConferenceSession`) — used when any leg is a browser or
  WhatsApp leg (a browser leg cannot speak EVS/AMR). A 20 ms software mixer in
  the agent bridges the two human legs, with a per-leg jitter buffer and
  Deepgram transcription per leg.

### Browser-softphone staff leg

If the body has **no** `mode`/`staffNumber`/`staffWaId`, the staff leg is a
**browser softphone**. The request only specifies the customer:

```json
{ "customerChannel": "pstn", "customerNumber": "+442222222222", "staffName": "Sam" }
```

Response: `{ "callId": ..., "status": "awaiting_staff" }`. The `callId` is a
128-bit random token that doubles as a one-time join secret — only a client
that authenticated to `POST /v1/calls/conference` learns it.

The staff member's browser then joins as a SIP UAC **over WebSocket Secure**
(e.g. SIP.js → Caddy `/sip` → drachtio), sending an `INVITE` to
`sip:conf-<callId>`. rtpengine terminates the browser's WebRTC/DTLS-SRTP/Opus
leg and hands the agent a plain-RTP leg that the conference mixer consumes like
any other. Once the browser is in, the agent dials the customer and bridges.

### The Gemini co-listener ("Aria")

The conference design includes an optional third participant: a Gemini Live
co-listener named **Aria**, running on the native-audio model
(`GEMINI_CONFERENCE_MODEL`) with Proactive Audio. She listens silently to the
mixed staff↔customer audio and speaks only on her own judgement — when
addressed by name, to correct a clear factual error, or to raise a missed
question.

**Aria is currently disabled for outbound conferences.** In the code her
co-listener block is commented out; outbound conferences run as a plain
staff↔customer bridge with Deepgram live transcription instead. The
`POST /v1/calls/{callId}/aria` control route still exists and is accepted:

```json
{ "action": "mute", "text": "optional — only for action: ask" }
```

`action` is `mute`, `unmute`, or `ask` (anything else → `400`). On the
rtpengine-passthrough path and while Aria is disabled, the route is a no-op
that simply returns `{ "ok": true, "aria_muted": true }`. The plumbing is kept
so Aria can be re-enabled without an API change.

---

## 5. WhatsApp Business Calling (WABA)

The agent can answer and place **WhatsApp voice calls** in addition to PSTN.
[`server/webhook.js`](../server/webhook.js) is a dedicated **media bridge** for
this: it drives rtpengine to terminate Meta's WebRTC/SRTP/Opus leg and transcode
it to a plain-RTP leg the agent handles natively.

> **WABA cannot be demoed standalone.** It requires:
> 1. a **Meta WhatsApp Business account** with the Calling API enabled, and
> 2. the **control app** (§1) — only it holds the Meta access token and
>    handles Meta's Cloud API webhooks and SDP exchange.
>
> `webhook.js` is purely the *media* half. The control app is the *signalling*
> half: it receives Meta's call webhooks, calls the bridge endpoints below to
> get/apply SDP, and forwards SDP to Meta. There is no built-in demo control
> app, so WABA is an integration feature, not an out-of-the-box one.

### Components

* `webhook.js` listens on `127.0.0.1:3000` (`WEBHOOK_PORT` / `WEBHOOK_BIND`),
  exposed by Caddy at `/api/waba/*`.
* It calls the agent's `/session/*` routes (§2) on `AGENT_CONTROL_URL`
  (`http://127.0.0.1:3002`) to start/stop Gemini sessions.
* It speaks the **rtpengine NG protocol** (bencoded UDP) on
  `RTPENGINE_NG_HOST:RTPENGINE_NG_PORT`.

### Security

The `/api/waba/*` endpoints are defended three ways:

* **Bearer token** — `Authorization: Bearer ${INTERNAL_VOICE_TOKEN}`
  (`requireToken`).
* **IP allow-list** — `WA_PROD_IPS` is a comma-separated list of the control
  app's origin IP(s); anything else gets `403` (`requireWaProdIp`). Defence in
  depth: a leaked token still needs a spoofed source IP. Caddy should also
  restrict `/api/waba/*` to the control app's IP.
* **Rate limit** — 60 requests/minute per IP.

### Endpoints (called by the control app)

All take/return JSON; all require the bearer token + allow-listed IP.

| Method & path | Body | Returns |
|---|---|---|
| `POST /api/waba/connect` | `{ callId, waId, callerName?, sdpOffer }` | `{ sdp, callId, fromTag, toTag }` |
| `POST /api/waba/dial-offer` | `{ callId, role? }` | `{ sdp, callId }` |
| `POST /api/waba/dial-answer` | `{ callId, role?, sdpAnswer }` | `{ ok: true }` |
| `POST /api/waba/terminate` | `{ callId }` | `{ ok: true }` |

* **`/api/waba/connect`** — inbound WhatsApp call. The control app passes
  Meta's SDP offer; the bridge sets up rtpengine (transcoding Meta's
  Opus/SRTP ↔ the agent's leg), starts an agent session via
  `/session/waba-start`, and returns the SDP **answer** for the control app to
  forward to Meta. Offer and answer happen in this one call.
* **`/api/waba/dial-offer`** — outbound WhatsApp call, phase 1. The agent is
  the offerer here: the bridge reserves an agent RTP socket
  (`/session/waba-conf-alloc`) and returns a WebRTC **offer** SDP for the
  control app to `POST` to Meta's `/calls` endpoint. `role` is `customer`
  (default) or `staff`.
* **`/api/waba/dial-answer`** — outbound WhatsApp call, phase 2. When the
  customer accepts and Meta sends back an SDP answer, the control app posts it
  here; the bridge applies it to rtpengine and brings the leg up
  (`/session/waba-conf-ready`). The split into two phases mirrors Meta's
  business-initiated call flow.
* **`/api/waba/terminate`** — tears down the rtpengine session and the agent
  session for `callId`.

`webhook.js` also exposes `GET /healthz` (rtpengine NG ping + agent control
reachability).

A WABA call can be a 1:1 agent call (`/api/waba/connect`) or one leg of a
conference (`/api/waba/dial-offer` + `/api/waba/dial-answer`, reached from the
agent's `requestWabaLeg()` → `/api/v1/voice/waba-leg`). Because a WhatsApp leg
has no SIP dialog, a WhatsApp-side hangup is invisible to signalling — the
agent detects it via an RTP media watchdog (no media for ~12 s ends the call).

---

## 6. Mid-call announcements

`POST /v1/calls/{callId}/announce` (HMAC-authenticated, §2) lets the control
app make the assistant **say something mid-call** — e.g. "your callback has
been booked" once a tool the control app ran asynchronously finishes.

Request body:

```json
{
  "task_id": "task_7781",
  "kind": "task_complete",
  "speak_text": "Good news — your callback is booked for 3pm tomorrow.",
  "language": "en-GB",
  "wait_for_silence_ms": 1500,
  "ttl_ms": 30000,
  "ack_callback_url": "https://app.example.com/voice/announce-ack"
}
```

| Field | Default | Notes |
|---|---|---|
| `speak_text` | — | **Required.** Trimmed to 500 chars. Empty → `400`. |
| `task_id` | `null` | Opaque correlation id, echoed in the ack. |
| `kind` | `task_complete` | Free-form label. |
| `language` | call locale | BCP-47; the language to speak the text in. |
| `wait_for_silence_ms` | `1500` | Inject only after the caller has been silent this long. |
| `ttl_ms` | `30000` (min `1000`) | Drop the announcement if not spoken within this window. |
| `ack_callback_url` | `null` | Absolute URL the agent POSTs the outcome to. |

Responses:

* `200 { "queued": true, "estimated_speak_at_ms": <ms> }` — accepted.
* `409 { "reason": "max_queue_depth", "current_depth": N }` — the per-call
  queue is full (cap `ANNOUNCE_QUEUE_MAX`, default 3).
* `400 { "reason": "invalid_payload", "details": "..." }`.
* `410 { "reason": "call_ended", "ended_at": <unix> }` — the call is over.

### How the queue works

The agent does not interrupt anyone. A worker polls the queue and injects an
announcement only when **all** of these hold:

* the model ("Aria") is not currently speaking,
* the caller has been silent for at least `wait_for_silence_ms` (tracked by an
  RMS voice-activity gate on the inbound audio),
* no agent-initiated hangup (`end_call`) is pending — an announcement never
  steps on a goodbye.

One announcement is spoken at a time, with a 500 ms gap between consecutive
ones. The text is injected as a system-tagged turn instructing Gemini to speak
it verbatim in the requested language, then return to the conversation. The
spoken result is captured into the transcript prefixed `[announcement] ` and
posted as a normal `/turn`.

### Acks

If `ack_callback_url` was given, the agent `POST`s the outcome to that URL with
`Authorization: Bearer ${INTERNAL_VOICE_TOKEN}`:

```json
{
  "task_id": "task_7781",
  "call_id": "a1b2c3d4...",
  "status": "spoken",
  "actual_speak_text": "Good news — your callback is booked for 3pm tomorrow.",
  "spoken_at": 1747900923
}
```

`status` is one of:

| `status` | Meaning | Extra field |
|---|---|---|
| `spoken` | The assistant said it. | `spoken_at` (unix seconds) |
| `dropped` | Not spoken. | `dropped_reason` |

`dropped_reason` is `ttl_expired` (window elapsed), `call_ended` (call ended
first), or `internal_error`. The ack is best-effort and fire-and-forget.

---

## See also

* [README.md](../README.md) — project overview
* [QUICKSTART.md](QUICKSTART.md) — the out-of-the-box demo
* [CONFIGURATION.md](CONFIGURATION.md) — environment variable reference
* [ARCHITECTURE.md](ARCHITECTURE.md) — media-path and component design
* [DEPLOYMENT.md](DEPLOYMENT.md) — production host inventory
