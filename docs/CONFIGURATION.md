# Configuration

All configuration is supplied through a single `.env` file in the repo root.
That file is git-ignored — it is where real secrets live and it is never
committed. To create it, copy the canonical template and fill in the blanks:

```sh
cp .env.example .env
```

`.env.example` is the authoritative list of every supported variable, grouped
the same way as the table below. It is loaded by every Node.js entry point
(`server/agent.js`, `server/webhook.js`, `server/echo-test.js`,
`server/call-forward.js`) via `dotenv/config`.

The **built-in demo agent needs only a handful of variables**. Everything in
the *Advanced* group is for the optional external config service and the
WhatsApp Business Calling (WABA) bridge — leave it untouched for a standard
deployment.

See also: [`../README.md`](../README.md),
[`QUICKSTART.md`](QUICKSTART.md), [`DIDWW-SETUP.md`](DIDWW-SETUP.md),
[`ADVANCED.md`](ADVANCED.md) and [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Demo minimum

To answer an inbound call with the built-in demo agent
(`server/demo-config.js`), only these variables must be set:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_IP` | Public IPv4 of this server. Written into the SIP/SDP your server advertises. |
| `GEMINI_API_KEY` | Google Gemini API key — get one at <https://aistudio.google.com/apikey>. |
| `DRACHTIO_SECRET` | drachtio admin secret. Must match `provision/drachtio.conf.xml` (see below). |
| `SIP_DOMAIN` | DIDWW outbound proxy host. Required for the trunk; also used for outbound calls. |
| `CLI` | Outbound caller ID — a DIDWW-owned DID in E.164 digits. |

`SIP_USER` and `SIP_PASSWORD` **stay blank** for DIDWW two-way trunks: those
trunks authenticate by IP. Register this server's `PUBLIC_IP` in the DIDWW
panel and inbound `INVITE`s arrive with no SIP registration. Setting `SIP_USER`
switches the stack to registration-based trunk mode (see
[`DIDWW-SETUP.md`](DIDWW-SETUP.md)).

Nothing else is strictly required — `rtpengine` is only needed for outbound
calls, conferences, WABA, or inbound calls that require transcoding; a
PCMU/L16 inbound-only demo runs without it. The persona, locale and limit
variables all have working defaults.

## drachtio admin secret

`DRACHTIO_SECRET` is how `agent.js` (and `echo-test.js` / `call-forward.js`)
authenticate to the drachtio SIP server's admin port. It **must be identical**
to the value of the `secret` attribute in `provision/drachtio.conf.xml`:

```xml
<admin port="9022" secret="CHANGEME_drachtio_admin_secret">127.0.0.1</admin>
```

If the two differ, drachtio rejects the connection and no calls are handled.
Generate a fresh value with `openssl rand -hex 24` and set it in both places.

## Full variable reference

Defaults below are exactly what the code falls back to when the variable is
unset. "Consumed by" lists the `server/*.js` files that read the variable;
`rtpengine.js` and `trunk-register.js` are shared modules imported by the
entry points.

### SIP / trunk

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `PUBLIC_IP` | Required | _(none — process exits if unset)_ | agent.js, webhook.js, echo-test.js, call-forward.js | Public IPv4 of this server, advertised in SIP/SDP. |
| `SIP_DOMAIN` | Required for trunk | _(empty)_ | agent.js, echo-test.js, call-forward.js, trunk-register.js | DIDWW outbound proxy host. Used for outbound `INVITE`s and trunk registration. |
| `SIP_USER` | Optional | _(empty)_ | agent.js, echo-test.js, call-forward.js, trunk-register.js | Trunk digest username. **Leave blank for DIDWW IP-authenticated trunks**; setting it enables registration mode. |
| `SIP_PASSWORD` | Optional | _(empty)_ | agent.js, echo-test.js, call-forward.js, trunk-register.js | Trunk digest password. Used only when `SIP_USER` is set. |
| `CLI` | Required for outbound | _(empty)_ | agent.js, echo-test.js | Outbound caller ID — a DIDWW-owned DID in E.164 digits. |

### drachtio (SIP server)

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `DRACHTIO_HOST` | Optional | `127.0.0.1` | agent.js, echo-test.js, call-forward.js | Host of the drachtio admin interface. drachtio runs in Docker on the same host. |
| `DRACHTIO_PORT` | Optional | `9022` | agent.js, echo-test.js, call-forward.js | TCP port of the drachtio admin interface. |
| `DRACHTIO_SECRET` | Required | `cymru` | agent.js, echo-test.js, call-forward.js | drachtio admin secret. Must match `<admin secret="...">` in `provision/drachtio.conf.xml`. The `cymru` default is drachtio's stock value — always override it. |

### rtpengine (media)

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `RTPENGINE_NG_HOST` | Optional | `127.0.0.1` | rtpengine.js (agent.js), webhook.js | Host of the rtpengine NG control protocol. rtpengine runs in Docker on the same host. |
| `RTPENGINE_NG_PORT` | Optional | `22222` | rtpengine.js (agent.js), webhook.js | UDP port of the rtpengine NG control protocol. |

### Gemini

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | Required | _(none)_ | agent.js | Google Gemini API key — <https://aistudio.google.com/apikey>. |
| `GEMINI_MODEL` | Optional | `gemini-3.1-flash-live-preview` | agent.js | Gemini Live model for inbound 1:1 calls. |

### Demo agent persona and locale

These tune the built-in demo agent (`server/demo-config.js`) and the
locale-dependent behaviour in `agent.js`. All have safe defaults.

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `ASSISTANT_NAME` | Optional | `Aria` | agent.js, demo-config.js | The demo assistant's name, woven into the system prompt. |
| `DEMO_LANGUAGE_CODE` | Optional | `en-US` | demo-config.js | Demo agent language (BCP-47). Surfaces as the config `locale.languageCode`. |
| `AGENT_TIMEZONE` | Optional | `UTC` | agent.js, demo-config.js | IANA timezone for the "current time" given to the model and the `get_current_time` demo tool. |
| `DIDWW_DEFAULT_COUNTRY_CODE` | Optional | `1` | agent.js | Country code prepended to national-format inbound caller IDs when normalising to E.164. |
| `GEMINI_VOICE` | Optional | `Aoede` | agent.js | Gemini prebuilt voice name. |
| `GEMINI_LANGUAGE_CODE` | Optional | `en-US` | agent.js | Gemini speech language. Used only when the active voice config has no `locale.languageCode`; effectively overrides `DEMO_LANGUAGE_CODE` for the Gemini session when set. |

### Deepgram live transcription (optional)

Optional streaming speech-to-text. Without `DEEPGRAM_TOKEN` the caller
transcript falls back to Gemini's own ASR and the rest of this group is
ignored.

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `DEEPGRAM_TOKEN` | Optional | _(empty)_ | agent.js | Deepgram API token. Empty disables Deepgram transcription. |
| `DEEPGRAM_MODEL` | Optional | `nova-3` | agent.js | Deepgram recognition model. |
| `DEEPGRAM_LANGUAGE` | Optional | `en` | agent.js | Fallback recognition language when auto-detect is off or inconclusive. |
| `DEEPGRAM_AUTO_DETECT` | Optional | `true` | agent.js | Detect the caller's language from the first audio. Set to `false` to disable; any other value (or unset) keeps it on. |
| `DEEPGRAM_DETECT_MS` | Optional | `2500` | agent.js | Window in milliseconds used for language detection (minimum 500). |

### Agent limits and debug

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `RTP_PORT_MIN` | Optional | `10000` | agent.js, echo-test.js | Lower bound of the local RTP port range the agent allocates from. |
| `RTP_PORT_MAX` | Optional | `20000` | agent.js, echo-test.js | Upper bound of the local RTP port range. |
| `MAX_CONCURRENT_CALLS` | Optional | `20` | agent.js | Maximum simultaneous calls; further `INVITE`s are rejected. |
| `MAX_CALL_SECONDS` | Optional | `600` | agent.js | Hard per-call duration cap, in seconds — guards against runaway model cost. |
| `VAD_RMS_THRESHOLD` | Optional | `500` | agent.js | Caller-mic energy gate (RMS over Int16 PCM) for voice-activity detection. |
| `ANNOUNCE_QUEUE_MAX` | Optional | `3` | agent.js | Maximum queued mid-call announcements per call. |
| `DEBUG_MEDIA` | Optional | _(off)_ | agent.js | Set to `1` to log per-leg RTP / jitter-buffer instrumentation. |
| `DEBUG_GEMINI` | Optional | _(off)_ | agent.js | Set to `1` to log raw Gemini Live protocol messages. |

### Advanced

Not needed for the demo. Covers the external per-caller config service and the
WhatsApp Business Calling bridge — see [`ADVANCED.md`](ADVANCED.md).

| Variable | Required | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `INTERNAL_VOICE_URL` | Optional | _(empty)_ | agent.js | Base URL of an external config service. When set (with `INTERNAL_VOICE_TOKEN`), `agent.js` fetches the system prompt and tools from it instead of `server/demo-config.js`. |
| `INTERNAL_VOICE_TOKEN` | Optional | _(empty)_ | agent.js, webhook.js | Bearer token shared with the control app. Authenticates config-service calls and inbound `/api/waba/*` requests. |
| `VOICE_VPS_ANNOUNCE_SECRET` | Optional | _(empty)_ | agent.js | HMAC secret for control-app → agent `/v1/calls/*` requests (outbound, announce). Unset disables those endpoints. |
| `WA_PROD_IPS` | Optional | _(empty)_ | webhook.js | Comma-separated IP allow-list for `/api/waba/*` (the control-app origin). |
| `WEBHOOK_PORT` | Optional | `3000` | webhook.js | TCP port the WABA bridge HTTP server listens on. |
| `WEBHOOK_BIND` | Optional | `127.0.0.1` | webhook.js | Bind address for the WABA bridge HTTP server. |
| `AGENT_CONTROL_URL` | Optional | `http://127.0.0.1:3002` | webhook.js | Base URL of the agent's control endpoint, which `webhook.js` calls to start/terminate WABA sessions. |
| `GEMINI_CONFERENCE_MODEL` | Optional | `gemini-2.5-flash-native-audio-preview-12-2025` | agent.js | Native-audio Gemini model for the 3-leg conference (Proactive Audio). Kept separate from `GEMINI_MODEL`. |
| `FORWARD_TO` | Required for call-forward | _(empty)_ | call-forward.js | Destination number (E.164) every inbound call is forwarded to. Only used when running the `call-forward` utility. |
