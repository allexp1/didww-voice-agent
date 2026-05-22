// call-forward.js — unconditional call forwarding for the inbound DID.
//
// A B2BUA: answers every inbound call, re-originates it to FORWARD_TO, and
// bridges the two legs through rtpengine. The original caller's CLI is NOT
// relayed — the outbound leg uses our own trunk identity, because many SIP
// trunks reject (403) an INVITE whose From is not a trunk-owned number.
//
// Runs INSTEAD of voice-ai-agent / echo-test — all three own the drachtio
// INVITE stream, so the systemd units are mutually exclusive (Conflicts=).
//   sudo systemctl start call-forward     # forwarding mode
//   sudo systemctl start echo-test        # back to the RTP echo test
//   sudo systemctl start voice-ai-agent   # back to the Gemini agent

import 'dotenv/config';
import Srf from 'drachtio-srf';
import sdpTransform from 'sdp-transform';
import crypto from 'node:crypto';
import { rtpNg } from './rtpengine.js';
import { startTrunkRegistration } from './trunk-register.js';

const {
  PUBLIC_IP,
  DRACHTIO_HOST = '127.0.0.1',
  DRACHTIO_PORT = '9022',
  DRACHTIO_SECRET = 'cymru',
  SIP_DOMAIN, SIP_USER, SIP_PASSWORD,
  FORWARD_TO = '',          // destination number — REQUIRED
} = process.env;
if (!PUBLIC_IP)  throw new Error('PUBLIC_IP env required');
if (!FORWARD_TO) throw new Error('FORWARD_TO env required');

// DIDWW two-way trunks route on E.164 (digits only). Carriers that route on
// national format need a carrier-specific rewrite here (see toCarrierNumber in
// agent.js for an example).
function toCarrierNumber(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}
const DEST = toCarrierNumber(FORWARD_TO);

// Only the SIP trunk may deliver calls here. UFW already restricts the SIP
// ports to these ranges — this is defense-in-depth so a future loose firewall
// rule can't turn the forwarder into a toll-fraud relay for SIP scanners.
// These are DIDWW's published SIP ranges — verify against current DIDWW docs.
const TRUSTED_NETS = [['46.19.208.0', 21], ['185.238.172.0', 22]];
function ipToInt(ip) {
  const p = String(ip || '').split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    const v = parseInt(o, 10);
    if (!(v >= 0 && v <= 255)) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}
function isTrustedSource(ip) {
  const a = ipToInt(ip);
  if (a === null) return false;
  return TRUSTED_NETS.some(([base, bits]) => {
    const b = ipToInt(base);
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  });
}

// drachtio-srf can throw asynchronously when we tear down a dialog the server
// has already forgotten (both legs ending at once). That error is benign for a
// stateless forwarder — log and continue instead of crashing every live call.
process.on('uncaughtException', (e) => {
  if (/unable to find dialog/i.test(e?.message || String(e))) {
    console.warn('[warn] ignored stale-dialog teardown error');
    return;
  }
  console.error('FATAL uncaughtException', e);
  process.exit(1);
});

const srf = new Srf();
let trunkReg = null;
srf.connect({ host: DRACHTIO_HOST, port: parseInt(DRACHTIO_PORT), secret: DRACHTIO_SECRET });
srf.on('connect', (err, hp) => {
  if (err) return console.error('drachtio connect error', err);
  console.log('call-forward: drachtio connected', hp);
  // Register to the carrier so it delivers inbound calls to this server.
  if (!trunkReg) trunkReg = startTrunkRegistration(srf, {
    domain: SIP_DOMAIN, user: SIP_USER, pass: SIP_PASSWORD,
    publicIp: PUBLIC_IP, sipPort: 5060,
  });
});
srf.on('error', (e) => console.error('drachtio error', e));

// rtpengine NG flags shared by the offer + answer of one bridged call.
const ng = (callId, extra) => ({
  'call-id': callId,
  ICE: 'remove', DTLS: 'off', SDES: 'off',
  'transport-protocol': 'RTP/AVP', 'rtcp-mux': ['demux'],
  flags: ['trust-address', 'strict-source'],
  ...extra,
});

srf.invite(async (req, res) => {
  const callId = req.get('Call-ID');
  const caller = req.getParsedHeader('From')?.uri || req.source_address;

  // Reject anything not coming from the SIP trunk. SIP scanners probe the
  // public IP directly — without this, every probe rings FORWARD_TO for real.
  if (!isTrustedSource(req.source_address)) {
    console.warn(`[${callId}] ✋ rejected — untrusted source ${req.source_address} (${caller})`);
    return res.send(403);
  }
  console.log(`\n[${callId}] inbound from ${caller} → forwarding to ${DEST}`);

  const fromTag = 'in-'  + crypto.randomBytes(4).toString('hex');
  const toTag   = 'out-' + crypto.randomBytes(4).toString('hex');

  // 1. rtpengine offer — caller's SDP in, SDP for the outbound INVITE out.
  let offerReply;
  try {
    offerReply = await rtpNg(ng(callId, {
      command: 'offer', 'from-tag': fromTag, sdp: req.body,
      replace: ['origin', 'session-connection'],
    }));
    if (offerReply?.result !== 'ok') throw new Error(offerReply?.['error-reason'] || 'offer failed');
  } catch (e) {
    console.error(`[${callId}] rtpengine offer: ${e?.message || e}`);
    return res.send(500);
  }

  // 2. B2BUA — dial FORWARD_TO and bridge. From is our trunk account, never
  //    the inbound caller's CLI (the trunk 403s a foreign From). createB2BUA
  //    relays provisional responses, so the caller hears ringback.
  try {
    const { uas, uac } = await srf.createB2BUA(req, res, `sip:${DEST}@${SIP_DOMAIN}`, {
      headers: { From: `<sip:${SIP_USER}@${SIP_DOMAIN}>` },
      auth: { username: SIP_USER, password: SIP_PASSWORD },
      localSdpB: offerReply.sdp,
      // Caller-facing answer — rtpengine reconciles it against the callee leg.
      localSdpA: async (calleeSdp) => {
        const ans = await rtpNg(ng(callId, {
          command: 'answer', 'from-tag': fromTag, 'to-tag': toTag, sdp: calleeSdp,
        }));
        if (ans?.result !== 'ok') throw new Error(ans?.['error-reason'] || 'answer failed');
        try {
          const m = sdpTransform.parse(calleeSdp).media.find(x => x.type === 'audio');
          console.log(`[${callId}] ${DEST} answered — codec ${(m?.rtp || []).map(r => r.codec).join('/')}`);
        } catch {}
        return ans.sdp;
      },
    });
    console.log(`[${callId}] ✅ bridged — caller ↔ ${DEST}`);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    };
    uas.on('destroy', () => { console.log(`[${callId}] caller hung up`); try { uac.destroy(); } catch {} release(); });
    uac.on('destroy', () => { console.log(`[${callId}] ${DEST} hung up`);  try { uas.destroy(); } catch {} release(); });
  } catch (e) {
    // B-leg failed (busy / no-answer / rejected) — createB2BUA already relayed
    // the failure status to the caller. Just release the rtpengine session.
    console.error(`[${callId}] forward failed: ${e?.status || e?.message || e}`);
    rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
  }
});

console.log(`call-forward ready — forwarding all inbound calls → ${DEST}`);
