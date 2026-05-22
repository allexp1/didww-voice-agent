// echo-test.js — standalone SIP echo / loopback test for the SIP trunk.
//
// Answers ANY inbound INVITE and reflects every RTP packet straight back to the
// sender, so the caller hears their own audio. It is codec-agnostic: it never
// decodes the media, it just bounces the packets — so it works for PCMU, AMR-NB,
// AMR-WB, EVS, anything the carrier sends. Use it to confirm the inbound trunk
// + two-way media path before pointing real traffic at the agent.
//
// Runs INSTEAD of voice-ai-agent (both are "the" drachtio SIP app). The systemd
// unit declares Conflicts=voice-ai-agent.service, so:
//   sudo systemctl start echo-test      # stops the agent, starts the echo test
//   sudo systemctl start voice-ai-agent # stops the echo test, restores the agent

import 'dotenv/config';
import Srf from 'drachtio-srf';
import sdpTransform from 'sdp-transform';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import http from 'node:http';
import { startTrunkRegistration } from './trunk-register.js';

const {
  PUBLIC_IP,
  DRACHTIO_HOST = '127.0.0.1',
  DRACHTIO_PORT = '9022',
  DRACHTIO_SECRET = 'cymru',
  RTP_PORT_MIN = '10000',
  RTP_PORT_MAX = '20000',
  SIP_DOMAIN, SIP_USER, SIP_PASSWORD, CLI,
} = process.env;
if (!PUBLIC_IP) throw new Error('PUBLIC_IP env required');

const PORT_LO = parseInt(RTP_PORT_MIN) & ~1;
const PORT_HI = parseInt(RTP_PORT_MAX) & ~1;
let nextRtpPort = PORT_LO;
async function allocRtpSocket() {
  for (let i = 0; i < 500; i++) {
    const port = nextRtpPort;
    nextRtpPort += 2;
    if (nextRtpPort >= PORT_HI) nextRtpPort = PORT_LO;
    const s = dgram.createSocket('udp4');
    const ok = await new Promise((resolve) => {
      s.once('error', () => resolve(false));
      s.bind(port, '0.0.0.0', () => resolve(true));
    });
    if (ok) return { socket: s, port };
    try { s.close(); } catch {}
  }
  throw new Error('no free RTP port in allowed range');
}

const srf = new Srf();
let trunkReg = null;
srf.connect({ host: DRACHTIO_HOST, port: parseInt(DRACHTIO_PORT), secret: DRACHTIO_SECRET });
srf.on('connect', (err, hp) => {
  if (err) return console.error('drachtio connect error', err);
  console.log('echo-test: drachtio connected', hp);
  // Register to the carrier so it delivers inbound calls to this server.
  if (!trunkReg) trunkReg = startTrunkRegistration(srf, {
    domain: SIP_DOMAIN, user: SIP_USER, pass: SIP_PASSWORD,
    publicIp: PUBLIC_IP, sipPort: 5060,
  });
});
srf.on('error', (err) => console.error('drachtio error', err));

srf.invite(async (req, res) => {
  const callId = req.get('Call-ID');
  const from = req.getParsedHeader('From')?.uri || req.source_address;
  console.log(`\n[${callId}] INVITE from ${from}`);

  let offer;
  try { offer = sdpTransform.parse(req.body); }
  catch (e) { console.error(`[${callId}] bad SDP`, e); return res.send(400); }
  const m = offer.media.find(x => x.type === 'audio');
  if (!m) { console.warn(`[${callId}] no audio media — 488`); return res.send(488); }

  const { socket: rtp, port: localPort } = await allocRtpSocket();

  // Reflect every packet straight back to wherever it actually came from
  // (symmetric RTP — also handles NAT). No decode, no transcode: pure echo.
  //
  // We DO rewrite the 32-bit SSRC (RTP header bytes 8–11) to a fresh value:
  // bouncing the caller's own SSRC back at them is an RFC 3550 collision, and
  // the phone discards the stream — which sounds like dead air. Sequence
  // numbers, timestamps and payload are left untouched, so it stays fully
  // codec-agnostic.
  let pkts = 0;
  const echoSsrc = crypto.randomBytes(4);
  rtp.on('message', (buf, rinfo) => {
    if (buf.length >= 12) echoSsrc.copy(buf, 8);
    rtp.send(buf, rinfo.port, rinfo.address);
    if (++pkts === 1) console.log(`[${callId}] media flowing — echoing RTP from ${rinfo.address}:${rinfo.port}`);
  });
  rtp.on('error', (e) => console.error(`[${callId}] rtp socket error`, e));

  // Answer with the caller's OWN codec list + payload types so the packets we
  // bounce back are valid for them (we never transcode).
  const payloads = (m.payloads != null && m.payloads !== '')
    ? String(m.payloads)
    : (m.rtp || []).map(r => r.payload).join(' ');
  const rtpmaps = (m.rtp || []).map(r =>
    `a=rtpmap:${r.payload} ${r.codec}/${r.rate}${r.encoding ? '/' + r.encoding : ''}\r\n`).join('');
  const fmtps = (m.fmtp || []).map(f => `a=fmtp:${f.payload} ${f.config}\r\n`).join('');
  const answer =
    `v=0\r\no=- ${Date.now()} 1 IN IP4 ${PUBLIC_IP}\r\ns=echo-test\r\n` +
    `c=IN IP4 ${PUBLIC_IP}\r\nt=0 0\r\n` +
    `m=audio ${localPort} RTP/AVP ${payloads}\r\n` +
    rtpmaps + fmtps +
    `a=sendrecv\r\na=ptime:20\r\n`;

  let dialog;
  try { dialog = await srf.createUAS(req, res, { localSdp: answer }); }
  catch (e) { console.error(`[${callId}] createUAS failed`, e); rtp.close(); return; }
  console.log(`[${callId}] answered — echo active on :${localPort} (payloads: ${payloads})`);

  dialog.on('destroy', () => {
    console.log(`[${callId}] hangup — ${pkts} packets echoed`);
    try { rtp.close(); } catch {}
  });
});

// ── outbound echo (test driver) ──────────────────────────────────────────
// Place an outbound call, log the codec the far end negotiates, and reflect
// its RTP back so the callee hears themselves — a two-way-audio + codec test
// for the OUTBOUND direction. Triggered on demand via the control endpoint.
// Dial the digits exactly as given — the carrier's expected format (national
// vs E.164) is carrier-specific, so the control endpoint passes it verbatim.
function normNumber(raw) {
  return String(raw || '').replace(/[^\d]/g, '');
}

async function dialEcho(number) {
  const toDigits = normNumber(number);
  if (!toDigits) return console.error('[dial] bad number');
  const { socket: rtp, port: localPort } = await allocRtpSocket();
  // Offer the full quality ladder. We reflect RTP verbatim (codec-agnostic),
  // so we never encode/decode — any codec the far end picks just works.
  const offer =
    `v=0\r\no=- ${Date.now()} 1 IN IP4 ${PUBLIC_IP}\r\ns=echo-test\r\n` +
    `c=IN IP4 ${PUBLIC_IP}\r\nt=0 0\r\n` +
    `m=audio ${localPort} RTP/AVP 96 97 98 8 0 101\r\n` +
    `a=rtpmap:96 EVS/16000\r\na=rtpmap:97 AMR-WB/16000\r\na=rtpmap:98 AMR/8000\r\n` +
    `a=rtpmap:8 PCMA/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n` +
    `a=sendrecv\r\na=ptime:20\r\n`;
  // From must be the registered account at the carrier's domain — a
  // registration trunk 403s an unrecognised From instead of challenging it.
  const uacOpts = { localSdp: offer, headers: { From: `<sip:${SIP_USER || toDigits}@${SIP_DOMAIN}>` } };
  if (SIP_USER) uacOpts.auth = { username: SIP_USER, password: SIP_PASSWORD };
  console.log(`\n[dial] outbound echo → sip:${toDigits}@${SIP_DOMAIN}  CLI=${CLI || '(none)'}`);
  console.log('[dial] offering: EVS, AMR-WB, AMR-NB, PCMA, PCMU, telephone-event');
  let dialog;
  try {
    dialog = await srf.createUAC(`sip:${toDigits}@${SIP_DOMAIN}`, uacOpts);
  } catch (e) {
    console.error(`[dial] INVITE failed: ${e?.status || e?.message || e}`);
    try { rtp.close(); } catch {}
    return;
  }
  // The answer SDP IS the codec-negotiation result.
  let neg = '(unparsed)', dst = {};
  try {
    const ans = sdpTransform.parse(dialog.remote.sdp);
    const m = ans.media.find(x => x.type === 'audio');
    neg = (m?.rtp || []).map(r => `${r.codec}/${r.rate}${r.encoding ? '/' + r.encoding : ''} [pt ${r.payload}]`).join(', ');
    dst = { host: m?.connection?.ip || ans.connection?.ip, port: m?.port };
  } catch {}
  console.log(`[dial] ✅ ANSWERED — negotiated codec → ${neg}`);
  console.log(`[dial] far-end RTP ${dst.host}:${dst.port}`);
  console.log(`[dial] --- answer SDP ---\n${dialog.remote.sdp}[dial] -----------------`);
  // Reflect every RTP packet back to its source (symmetric RTP), SSRC-rewritten.
  let pkts = 0;
  const echoSsrc = crypto.randomBytes(4);
  rtp.on('message', (buf, rinfo) => {
    if (buf.length >= 12) echoSsrc.copy(buf, 8);
    rtp.send(buf, rinfo.port, rinfo.address);
    if (++pkts === 1) console.log(`[dial] media flowing — echoing RTP from ${rinfo.address}:${rinfo.port} (first pkt pt ${buf[1] & 0x7f})`);
  });
  rtp.on('error', (e) => console.error('[dial] rtp error', e));
  dialog.on('destroy', () => { console.log(`[dial] hangup — ${pkts} packets echoed\n`); try { rtp.close(); } catch {} });
}

// Control endpoint (loopback only) — POST /dial/<number> triggers an echo call.
http.createServer((req, res) => {
  const m = (req.url || '').match(/^\/dial\/(.+)$/);
  if (req.method === 'POST' && m) {
    res.end(`dialing ${decodeURIComponent(m[1])}\n`);
    dialEcho(decodeURIComponent(m[1])).catch((e) => console.error('[dial]', e?.message || e));
  } else {
    res.statusCode = 404; res.end('POST /dial/<number>\n');
  }
}).listen(3030, '127.0.0.1', () => console.log('echo-test: outbound-dial control on http://127.0.0.1:3030'));

console.log('echo-test ready — answers any INVITE and reflects RTP for a two-way audio test');
