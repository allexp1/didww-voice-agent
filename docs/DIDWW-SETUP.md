# DIDWW setup

How to configure the DIDWW side: a phone number (DID) and a two-way SIP trunk
that lets this agent both **receive** and **place** calls.

This guide describes the concepts and the values you need. DIDWW's control
panel changes over time — for the exact screens, follow DIDWW's own
documentation; the mapping below is what matters.

## Concepts

- **DID** — a phone number you rent from DIDWW. Inbound calls to it are
  delivered to wherever you route it.
- **SIP trunk** — the connection between DIDWW and your server. A **two-way**
  trunk carries both **inbound** (calls to your DID) and **outbound** (calls
  your agent places) traffic.
- **IP authentication** — DIDWW identifies your trunk by the source IP address
  of the SIP traffic. You register your server's public IP with the trunk; no
  username or password is exchanged. This is the recommended setup for a
  server with a stable IP, and it is what this project assumes by default.

## Before you start

- A DIDWW account with credit/balance for the DID and for outbound minutes.
- Your server's **public IPv4 address** (this is `PUBLIC_IP` in `.env`).
- Outbound calling on DIDWW may require enabling specific destination
  countries and/or passing identity verification — do this early, it can take
  time to be approved.

## 1. Create a two-way SIP trunk

In the DIDWW control panel, create a **SIP trunk** capable of two-way (voice
in + voice out) traffic, and configure:

- **Authentication: IP address.** Enter your server's public IPv4. DIDWW will
  then deliver inbound INVITEs to that IP on port `5060`, and accept outbound
  INVITEs from it.
- **Capacity / channels.** Set the number of concurrent calls you expect. Keep
  it consistent with `MAX_CONCURRENT_CALLS` in `.env`.
- **Codecs.** Enable at least **PCMU** and **PCMA** (G.711) — these always
  work and need no transcoding. You may also enable **G.722**, **AMR-WB** or
  **EVS** for HD audio; the agent negotiates the best shared codec and lets
  rtpengine transcode when needed.
- **Transport.** Plain UDP on `5060` works everywhere. If you enable SIP-TLS
  (`5061`), the `drachtio-cert-sync` timer keeps drachtio's certificate current.

When the trunk is created, note its **outbound proxy host** — the SIP host your
server sends outbound INVITEs to. This is `SIP_DOMAIN` in `.env`.

## 2. Get a DID and route it to the trunk

- Buy a **DID** in the country/area you want.
- Set the DID's **destination** (routing) to the **two-way trunk** you just
  created. Inbound calls to the DID will now arrive at your server.
- This DID is also your outbound caller ID — most trunks reject an outbound
  call whose `From` is not a trunk-owned number. Put the DID in E.164 digits
  (no `+`) in `CLI`.

## 3. Outbound calling

Two-way trunks allow your agent to originate calls (used by the outbound and
conference features — see [ADVANCED.md](ADVANCED.md)). Make sure:

- Outbound is enabled on the trunk and the destination countries you intend to
  call are permitted on your account.
- `CLI` in `.env` is a DIDWW-owned DID in E.164 digits.
- `SIP_DOMAIN` is the trunk's outbound proxy host.

DIDWW expects dialled numbers in **E.164** (digits only). The agent's
`toCarrierNumber()` already produces that. If you later use a carrier that
routes on national format, that function is where you adapt it.

## 4. Firewall: DIDWW IP ranges

`provision/40-ufw.sh` restricts SIP signalling and PSTN RTP to DIDWW's
published IP ranges. The script ships with:

```
46.19.208.0/21
185.238.172.0/22
```

These are DIDWW's documented RTP subnets and encompass every DIDWW signalling
IP — verified against DIDWW's documentation
([inbound](https://doc.didww.com/voice/inbound-trunks/technical-data/sip.html),
[outbound](https://doc.didww.com/voice/outbound-trunks/technical-data/sip-details.html))
in May 2026. Carrier ranges can still change, so re-check them periodically. If
your server is dual-stack, DIDWW also announces IPv6 from `2a01:ad00::/32` — an
optional commented block in `provision/40-ufw.sh` covers it. The same ranges
back the `TRUSTED_NETS` array in `server/call-forward.js` (IPv4 only).

## 5. Map it to `.env`

| DIDWW value | `.env` variable | Example |
|---|---|---|
| Your server's public IP | `PUBLIC_IP` | `203.0.113.10` |
| Trunk outbound proxy host | `SIP_DOMAIN` | `sip.example-didww-host` |
| Trunk authentication | `SIP_USER` / `SIP_PASSWORD` | *blank* (IP auth) |
| Your DID (E.164 digits) | `CLI` | `12025550123` |
| Default country code | `DIDWW_DEFAULT_COUNTRY_CODE` | `1` |

With IP authentication, `SIP_USER` and `SIP_PASSWORD` stay empty and
`server/trunk-register.js` does nothing — DIDWW already knows your IP, so no
SIP registration is needed.

## Registration-based trunks (alternative)

If you use a trunk that authenticates with a username and password instead of
by IP, set `SIP_DOMAIN`, `SIP_USER` and `SIP_PASSWORD`. `trunk-register.js`
will then keep a SIP `REGISTER` alive so inbound calls are delivered. This is
not the typical DIDWW two-way setup, but the code supports it.

## 6. Test it

Use the echo test to confirm the trunk before involving the AI — see
[QUICKSTART.md](QUICKSTART.md) step 5. If you hear your own voice echoed back,
inbound signalling, IP authentication and two-way media all work.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Inbound call never reaches the server | DID not routed to the trunk, or UFW is blocking DIDWW's IP range. Confirm the range and the DID routing. |
| Inbound INVITE seen but dropped | drachtio not running, or `voice-ai-agent` is down. Check `journalctl -u voice-ai-agent`. |
| Outbound INVITE rejected `403` | `CLI` is not a trunk-owned DID, or the trunk's IP authentication does not match `PUBLIC_IP`. |
| Outbound INVITE rejected `404` | Number format — DIDWW expects E.164 digits. Check `toCarrierNumber()` and `DIDWW_DEFAULT_COUNTRY_CODE`. |
| Outbound call fails on certain countries | Destination not enabled on your DIDWW account. |
| One-way or no audio | `PUBLIC_IP` wrong, or the RTP port range (`10000–20000`) blocked for DIDWW's media IPs. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for how a call flows through the stack,
and [DEPLOYMENT.md](DEPLOYMENT.md) for the full production reference.
