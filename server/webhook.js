// WABA media bridge — WhatsApp Business Calling (advanced; see docs/ADVANCED.md).
//
// Receives connect/terminate requests from the control app (authed with
// INTERNAL_VOICE_TOKEN), drives rtpengine via the NG protocol to terminate
// Meta's WebRTC/SRTP/Opus leg, and spawns an agent Gemini-Live session for the
// decoded PCMU leg.

import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import dgram from 'node:dgram';

const {
  WEBHOOK_PORT = '3000',
  WEBHOOK_BIND = '127.0.0.1',
  INTERNAL_VOICE_TOKEN = '',
  RTPENGINE_NG_HOST = '127.0.0.1',
  RTPENGINE_NG_PORT = '22222',
  AGENT_CONTROL_URL = 'http://127.0.0.1:3002',
  WA_PROD_IPS = '',  // comma-separated IP allow-list for /api/waba/* (control-app origin)
  PUBLIC_IP,
} = process.env;

const app = express();
// Trust Caddy (loopback) so req.ip gives the real client via X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));

function requireToken(req, res, next) {
  if (!INTERNAL_VOICE_TOKEN) return res.status(503).json({ error: 'INTERNAL_VOICE_TOKEN not configured' });
  const h = req.get('authorization') || '';
  if (!timingSafeStringEqual(h, `Bearer ${INTERNAL_VOICE_TOKEN}`)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function timingSafeStringEqual(actual, expected) {
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Only the control app's production origin may hit /api/waba/*. Defense in depth
// on top of bearer auth; if the token ever leaks, the attacker also needs to
// spoof the source IP.
const WA_PROD_IP_SET = new Set(WA_PROD_IPS.split(',').map(s => s.trim()).filter(Boolean));
function requireWaProdIp(req, res, next) {
  const raw = req.ip || req.socket.remoteAddress || '';
  const clean = raw.replace(/^::ffff:/, '');
  if (!WA_PROD_IP_SET.has(clean)) {
    console.warn(`[waba] IP ${clean} blocked (not in WA_PROD_IPS allow-list)`);
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// Per-IP rate limit (60 req/min) on /api/waba/* — stops a leaked-token abuser
// from driving us into concurrency exhaustion.
const wabaLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit exceeded' },
});

// ── rtpengine NG protocol (bencoded over UDP) ────────────────────────────────
function rtpNg(cmd) {
  return new Promise((resolve, reject) => {
    const cookie = crypto.randomBytes(6).toString('hex');
    const s = dgram.createSocket('udp4');
    const body = bencode(cmd);
    const buf = Buffer.from(`${cookie} ${body}`);
    const timer = setTimeout(() => { s.close(); reject(new Error('rtpengine timeout')); }, 5000);
    s.on('message', (msg) => {
      clearTimeout(timer); s.close();
      const str = msg.toString('utf8');
      const sp = str.indexOf(' ');
      try { resolve(bdecode(str.slice(sp + 1))); }
      catch (e) { reject(e); }
    });
    s.on('error', (e) => { clearTimeout(timer); s.close(); reject(e); });
    s.send(buf, parseInt(RTPENGINE_NG_PORT), RTPENGINE_NG_HOST, (err) => {
      if (err) { clearTimeout(timer); s.close(); reject(err); }
    });
  });
}
function bencode(v) {
  if (typeof v === 'number') return `i${v}e`;
  if (typeof v === 'string') return `${Buffer.byteLength(v)}:${v}`;
  if (Buffer.isBuffer(v)) return `${v.length}:${v.toString('binary')}`;
  if (Array.isArray(v)) return 'l' + v.map(bencode).join('') + 'e';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return 'd' + keys.map(k => bencode(k) + bencode(v[k])).join('') + 'e';
  }
  throw new Error('unencodable: ' + typeof v);
}
function bdecode(s, i = { p: 0 }) {
  const c = s[i.p];
  if (c === 'i') { const e = s.indexOf('e', i.p); const n = parseInt(s.slice(i.p + 1, e)); i.p = e + 1; return n; }
  if (c === 'l') { i.p++; const a = []; while (s[i.p] !== 'e') a.push(bdecode(s, i)); i.p++; return a; }
  if (c === 'd') { i.p++; const o = {}; while (s[i.p] !== 'e') { const k = bdecode(s, i); o[k] = bdecode(s, i); } i.p++; return o; }
  if (c >= '0' && c <= '9') { const col = s.indexOf(':', i.p); const n = parseInt(s.slice(i.p, col)); const str = s.slice(col + 1, col + 1 + n); i.p = col + 1 + n; return str; }
  throw new Error('bdecode ' + c + ' at ' + i.p);
}

// ── agent control ────────────────────────────────────────────────────────────
async function agentStartWaba(callId, waId, callerName, remoteHost, remotePort) {
  const r = await fetch(`${AGENT_CONTROL_URL}/session/waba-start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_VOICE_TOKEN}` },
    body: JSON.stringify({ callId, waId, callerName, remoteHost, remotePort }),
  });
  if (!r.ok) throw new Error(`agent start ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}
async function agentTerminate(callId) {
  try {
    await fetch(`${AGENT_CONTROL_URL}/session/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_VOICE_TOKEN}` },
      body: JSON.stringify({ callId }),
    });
  } catch {}
}

// Parse the audio m= line from an SDP to find the peer's RTP address:port.
function parseAudioMedia(sdpText) {
  let connIp = null;
  let mPort = null;
  for (const line of sdpText.split(/\r?\n/)) {
    if (!connIp && line.startsWith('c=IN ')) {
      const m = line.match(/^c=IN IP[46]\s+(\S+)/);
      if (m) connIp = m[1];
    }
    if (!mPort && line.startsWith('m=audio')) {
      const m = line.match(/^m=audio\s+(\d+)/);
      if (m) mPort = parseInt(m[1]);
    }
  }
  return { host: connIp, port: mPort };
}

// Build an SDP answer from the agent's side: L16/16000 preferred (wideband linear),
// PCMU as fallback. 16k LPCM over loopback keeps fricatives intact — critical for
// Hebrew vs Arabic disambiguation in the downstream Gemini ASR.
function agentSdpAnswer(port, host = '127.0.0.1') {
  return (
    `v=0\r\no=- ${Date.now()} 1 IN IP4 ${host}\r\ns=agent\r\n` +
    `c=IN IP4 ${host}\r\nt=0 0\r\n` +
    `m=audio ${port} RTP/AVP 118 0 101\r\n` +
    `a=rtpmap:118 L16/16000\r\n` +
    `a=rtpmap:0 PCMU/8000\r\n` +
    `a=rtpmap:101 telephone-event/16000\r\n` +
    `a=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n`
  );
}

// An agent-side plain-RTP *offer* SDP — G.722, 16 kHz wideband. rtpengine
// rewrites this into the WebRTC offer handed to Meta and transcodes Meta's
// Opus ↔ G.722, so the WhatsApp customer leg is HD end-to-end. (agent.js
// encodes/decodes G.722 itself — see g722.js. G.722's RTP rtpmap clock is
// 8000 by convention even though the audio is 16 kHz — RFC 3551 quirk.)
function agentOfferSdp(port, host = '127.0.0.1') {
  return (
    `v=0\r\no=- ${Date.now()} 1 IN IP4 ${host}\r\ns=agent\r\n` +
    `c=IN IP4 ${host}\r\nt=0 0\r\n` +
    `m=audio ${port} RTP/AVP 9 101\r\n` +
    `a=rtpmap:9 G722/8000\r\n` +
    `a=rtpmap:101 telephone-event/8000\r\n` +
    `a=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n`
  );
}

// agent control — outbound WABA conference leg (two phases). `role` selects
// which conference slot the leg fills: 'staff' or 'customer'.
async function agentWabaConfAlloc(callId, role) {
  const r = await fetch(`${AGENT_CONTROL_URL}/session/waba-conf-alloc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_VOICE_TOKEN}` },
    body: JSON.stringify({ callId, role }),
  });
  if (!r.ok) throw new Error(`agent waba-conf-alloc ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}
async function agentWabaConfReady(callId, role, remoteHost, remotePort) {
  const r = await fetch(`${AGENT_CONTROL_URL}/session/waba-conf-ready`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_VOICE_TOKEN}` },
    body: JSON.stringify({ callId, role, remoteHost, remotePort }),
  });
  if (!r.ok) throw new Error(`agent waba-conf-ready ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

// State carried between dial-offer and dial-answer: an outbound WABA call is
// split across two requests (get an offer, then later apply Meta's answer),
// unlike inbound /api/waba/connect which does both in one. We only need to
// remember the rtpengine from-tag.
const wabaDials = new Map(); // `${callId}:${role}` → { fromTag, createdAt }
const WABA_DIAL_TTL_MS = 150_000;
function gcWabaDials() {
  const now = Date.now();
  for (const [k, v] of wabaDials) if (now - v.createdAt > WABA_DIAL_TTL_MS) wabaDials.delete(k);
}

// ── WABA endpoints (called by the control app) ───────────────────────────────

// POST /api/waba/connect
// Body: { callId, waId, sdpOffer, to? }
// Returns: { sdp: <SDP answer to forward to Meta> }
app.post('/api/waba/connect', wabaLimiter, requireWaProdIp, requireToken, async (req, res) => {
  const { callId, waId, callerName, sdpOffer } = req.body || {};
  if (!callId || !sdpOffer) return res.status(400).json({ error: 'callId + sdpOffer required' });
  const fromTag = 'meta-' + crypto.randomBytes(4).toString('hex');
  const toTag = 'agent-' + crypto.randomBytes(4).toString('hex');
  try {
    // Step 1 — rtpengine offer with Meta's SDP.
    //   Meta-facing leg : DTLS-passive, ICE-lite reuse, Opus/SAVPF (unchanged — Meta picks the PT)
    //   Agent-facing leg: plain RTP/AVP PCMU 8k — rtpengine strips DTLS/ICE/SRTP and transcodes Opus↔PCMU.
    // Key: codec.mask=all + codec.offer=[PCMU,telephone-event] + codec.transcode=[PCMU] lets rtpengine
    // remember the original codec list so the *answer* we generate later still references Meta's PT numbers.
    const offerReply = await rtpNg({
      command: 'offer',
      'call-id': callId,
      'from-tag': fromTag,
      sdp: sdpOffer,
      'ICE': 'remove',
      'DTLS': 'off',
      'SDES': 'off',
      'rtcp-mux': ['demux'],
      'transport-protocol': 'RTP/AVP',
      'replace': ['origin', 'session-connection'],
      'flags': ['trust-address', 'strict-source'],
      'codec': {
        mask:      ['all'],
        offer:     ['L16/16000', 'PCMU', 'telephone-event'],
        transcode: ['L16/16000', 'PCMU', 'telephone-event'],
      },
    });
    if (offerReply?.result !== 'ok') {
      throw new Error(`rtpengine offer: ${offerReply?.['error-reason'] || JSON.stringify(offerReply).slice(0, 200)}`);
    }
    const { host: rtpengineHost, port: rtpenginePort } = parseAudioMedia(offerReply.sdp);
    if (!rtpengineHost || !rtpenginePort) throw new Error('could not parse rtpengine offer sdp');

    // Step 2 — agent binds RTP port for the PCMU leg.
    const { localPort: agentPort } = await agentStartWaba(callId, waId, callerName || null, rtpengineHost, rtpenginePort);

    // Step 3 — give rtpengine agent's PCMU answer; rtpengine rebuilds the Meta-facing answer
    // with UDP/TLS/RTP/SAVPF + Opus PT (from original offer) + ICE + DTLS fingerprint + rtcp-mux + setup:active.
    const answerSdpForRtp = agentSdpAnswer(agentPort, '127.0.0.1');
    const answerReply = await rtpNg({
      command: 'answer',
      'call-id': callId,
      'from-tag': fromTag,
      'to-tag': toTag,
      sdp: answerSdpForRtp,
      'ICE': 'force',
      'DTLS': 'active',                       // rtpengine initiates ClientHello → Meta
      'SDES': 'off',
      'rtcp-mux': ['offer'],
      'transport-protocol': 'UDP/TLS/RTP/SAVPF',
      'flags': ['trust-address', 'strict-source', 'generate-mid'],
    });
    if (answerReply?.result !== 'ok') {
      throw new Error(`rtpengine answer: ${answerReply?.['error-reason'] || JSON.stringify(answerReply).slice(0, 200)}`);
    }

    console.log(`[waba-connect] ${callId} waId=${waId} agentPort=${agentPort} → rtpengine ${rtpengineHost}:${rtpenginePort}`);
    console.log(`[waba-connect] ${callId} Meta-facing answer SDP:\n${answerReply.sdp}`);
    res.json({ sdp: answerReply.sdp, callId, fromTag, toTag });
  } catch (e) {
    console.error(`[waba-connect] ${callId} failed:`, e?.message || e);
    // Best-effort cleanup
    rtpNg({ command: 'delete', 'call-id': callId, 'from-tag': fromTag }).catch(() => {});
    agentTerminate(callId).catch(() => {});
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/waba/dial-offer
// Body: { callId }   — callId is the VPS conference token (from /v1/calls/conference)
// Returns: { sdp: <WebRTC offer to POST to Meta /calls connect> }
//
// Outbound is the mirror of /api/waba/connect: here WE are the offerer.
// rtpengine takes the agent's plain-RTP offer and rewrites it into a
// WebRTC/SAVPF offer (ICE + DTLS + Opus) for Meta to answer.
app.post('/api/waba/dial-offer', wabaLimiter, requireWaProdIp, requireToken, async (req, res) => {
  const { callId, role = 'customer' } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  gcWabaDials();
  const dialKey = `${callId}:${role}`;
  const fromTag = 'agent-' + crypto.randomBytes(4).toString('hex');
  try {
    // 1 — agent binds the RTP socket for this WhatsApp leg.
    const { localPort: agentPort } = await agentWabaConfAlloc(callId, role);

    // 2 — rtpengine offer with the agent's plain-RTP SDP. The output flags
    // build the Meta-facing WebRTC offer: ICE, DTLS, rtcp-mux, and Opus
    // (codec.transcode adds Opus to the Meta-facing offer; codec.mask=all
    // drops the agent's G.722 from it; the agent side stays G.722).
    // DTLS=active: WhatsApp's media endpoint is ice-lite and always the DTLS
    // server (a=setup:passive), so rtpengine must be the DTLS client and send
    // the ClientHello — same as the inbound /api/waba/connect answer. A
    // passive↔passive pairing deadlocks the handshake → no SRTP → Meta drops
    // the call with error 138021 ("not receiving any media").
    const offerReply = await rtpNg({
      command: 'offer',
      'call-id': callId,
      'from-tag': fromTag,
      sdp: agentOfferSdp(agentPort, '127.0.0.1'),
      'ICE': 'force',
      'DTLS': 'active',
      // SDES must be fully off: a WebRTC offer is DTLS-keyed only. Left on,
      // rtpengine adds a=crypto lines onto the UDP/TLS/RTP/SAVPF m-line — a
      // malformed offer that breaks Meta's media (SRTP keys never agreed).
      // `SDES: ['off']` (a list, not a string) + the SDES-off flag.
      'SDES': ['off'],
      'rtcp-mux': ['offer'],
      'transport-protocol': 'UDP/TLS/RTP/SAVPF',
      'flags': ['trust-address', 'generate-mid', 'SDES-off'],
      'codec': { mask: ['all'], transcode: ['opus'] },
    });
    if (offerReply?.result !== 'ok') {
      throw new Error(`rtpengine offer: ${offerReply?.['error-reason'] || JSON.stringify(offerReply).slice(0, 200)}`);
    }
    wabaDials.set(dialKey, { fromTag, createdAt: Date.now() });
    // Force a=setup:active to match DTLS=active above — Meta then answers
    // a=setup:passive and rtpengine drives the DTLS handshake to Meta.
    const offerSdp = offerReply.sdp.replace(/a=setup:(actpass|passive)/g, 'a=setup:active');
    console.log(`[waba-dial-offer] ${callId}/${role} agentPort=${agentPort}`);
    console.log(`[waba-dial-offer] ${callId} Meta-facing offer SDP:\n${offerSdp}`);
    res.json({ sdp: offerSdp, callId });
  } catch (e) {
    console.error(`[waba-dial-offer] ${callId}/${role} failed:`, e?.message || e);
    wabaDials.delete(dialKey);
    // from-tag-scoped delete — a sibling leg may share this rtpengine call-id.
    rtpNg({ command: 'delete', 'call-id': callId, 'from-tag': fromTag }).catch(() => {});
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/waba/dial-answer
// Body: { callId, sdpAnswer }   — sdpAnswer is Meta's SDP answer carried on the
// business-initiated Call Connect webhook (the customer accepted the call).
app.post('/api/waba/dial-answer', wabaLimiter, requireWaProdIp, requireToken, async (req, res) => {
  const { callId, role = 'customer', sdpAnswer } = req.body || {};
  if (!callId || !sdpAnswer) return res.status(400).json({ error: 'callId + sdpAnswer required' });
  const dialKey = `${callId}:${role}`;
  const dial = wabaDials.get(dialKey);
  if (!dial) return res.status(404).json({ error: 'no pending dial for callId/role (expired?)' });
  const toTag = 'meta-' + crypto.randomBytes(4).toString('hex');
  try {
    // rtpengine answer with Meta's WebRTC answer. Output flags strip the
    // WebRTC layer back to plain RTP/AVP for the agent (the offerer).
    const answerReply = await rtpNg({
      command: 'answer',
      'call-id': callId,
      'from-tag': dial.fromTag,
      'to-tag': toTag,
      sdp: sdpAnswer,
      'ICE': 'remove',
      'DTLS': 'off',
      'SDES': 'off',
      'rtcp-mux': ['demux'],
      'transport-protocol': 'RTP/AVP',
      'flags': ['trust-address', 'strict-source'],
    });
    if (answerReply?.result !== 'ok') {
      throw new Error(`rtpengine answer: ${answerReply?.['error-reason'] || JSON.stringify(answerReply).slice(0, 200)}`);
    }
    // The answer reply SDP is the agent-facing (offerer) side — its c=/m=
    // give rtpengine's RTP address that the agent leg must send to.
    const { host: rtpengineHost, port: rtpenginePort } = parseAudioMedia(answerReply.sdp);
    if (!rtpengineHost || !rtpenginePort) throw new Error('could not parse rtpengine answer sdp');
    wabaDials.delete(dialKey);
    await agentWabaConfReady(callId, role, rtpengineHost, rtpenginePort);
    console.log(`[waba-dial-answer] ${callId}/${role} leg up → rtpengine ${rtpengineHost}:${rtpenginePort}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[waba-dial-answer] ${callId}/${role} failed:`, e?.message || e);
    // from-tag-scoped delete — a sibling leg may share this rtpengine call-id.
    rtpNg({ command: 'delete', 'call-id': callId, 'from-tag': dial.fromTag }).catch(() => {});
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// POST /api/waba/terminate
app.post('/api/waba/terminate', wabaLimiter, requireWaProdIp, requireToken, async (req, res) => {
  const { callId } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  console.log(`[waba-terminate] ${callId}`);
  await Promise.all([
    rtpNg({ command: 'delete', 'call-id': callId }).catch((e) => console.error('[rtpengine delete]', e?.message || e)),
    agentTerminate(callId),
  ]);
  res.json({ ok: true });
});

// Active health probe — checks rtpengine NG ping + agent control reachable.
app.get('/healthz', async (_req, res) => {
  const out = { ok: false, ts: Date.now(), rtpengine: false, agent: false };
  try {
    const r = await Promise.race([
      rtpNg({ command: 'ping' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
    ]);
    out.rtpengine = r?.result === 'pong';
  } catch (e) { out.rtpengine_error = String(e?.message || e); }
  try {
    const r = await fetch(`${AGENT_CONTROL_URL}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const j = await r.json();
      out.agent = j?.ok === true;
      out.active_sessions = j?.active_sessions;
      out.max_concurrent = j?.max_concurrent;
      out.drachtio_connected = j?.drachtio_connected;
    }
  } catch (e) { out.agent_error = String(e?.message || e); }
  out.ok = out.rtpengine && out.agent;
  res.status(out.ok ? 200 : 503).json(out);
});

const server = app.listen(parseInt(WEBHOOK_PORT), WEBHOOK_BIND, () => {
  console.log(`[webhook] WABA bridge listening on http://${WEBHOOK_BIND}:${WEBHOOK_PORT}`);
  console.log(`[webhook] token=${INTERNAL_VOICE_TOKEN ? 'set' : 'MISSING'} rtpengine=${RTPENGINE_NG_HOST}:${RTPENGINE_NG_PORT} agent=${AGENT_CONTROL_URL}`);
  console.log(`[webhook] WA prod allow-list: ${[...WA_PROD_IP_SET].join(', ') || '(empty — all denied)'}`);
});

// Graceful shutdown — stop accepting new HTTP, let in-flight finish.
let shuttingDown = false;
function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[webhook] ${sig} — closing HTTP listener`);
  server.close(() => {
    console.log('[webhook] clean exit');
    process.exit(0);
  });
  setTimeout(() => { console.warn('[webhook] forced exit'); process.exit(0); }, 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
