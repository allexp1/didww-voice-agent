// rtpengine NG-protocol client (bencoded control messages over UDP).
//
// Shared by agent.js — used to hand a browser WebRTC/DTLS-SRTP leg to rtpengine
// and get back a plain RTP/AVP leg the conference mixer can consume. webhook.js
// keeps its own copy for the WABA bridge (deliberately not refactored, to leave
// the live WhatsApp path byte-identical).

import crypto from 'node:crypto';
import dgram from 'node:dgram';

const RTPENGINE_NG_HOST = process.env.RTPENGINE_NG_HOST || '127.0.0.1';
const RTPENGINE_NG_PORT = parseInt(process.env.RTPENGINE_NG_PORT || '22222', 10);

// Send one NG command and resolve with the decoded reply.
export function rtpNg(cmd) {
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
    s.send(buf, RTPENGINE_NG_PORT, RTPENGINE_NG_HOST, (err) => {
      if (err) { clearTimeout(timer); s.close(); reject(err); }
    });
  });
}

export function bencode(v) {
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

export function bdecode(s, i = { p: 0 }) {
  const c = s[i.p];
  if (c === 'i') { const e = s.indexOf('e', i.p); const n = parseInt(s.slice(i.p + 1, e)); i.p = e + 1; return n; }
  if (c === 'l') { i.p++; const a = []; while (s[i.p] !== 'e') a.push(bdecode(s, i)); i.p++; return a; }
  if (c === 'd') { i.p++; const o = {}; while (s[i.p] !== 'e') { const k = bdecode(s, i); o[k] = bdecode(s, i); } i.p++; return o; }
  if (c >= '0' && c <= '9') { const col = s.indexOf(':', i.p); const n = parseInt(s.slice(i.p, col)); const str = s.slice(col + 1, col + 1 + n); i.p = col + 1 + n; return str; }
  throw new Error('bdecode ' + c + ' at ' + i.p);
}

// Pull the peer RTP host:port out of an SDP's audio m=/c= lines.
export function parseAudioMedia(sdpText) {
  let connIp = null;
  let mPort = null;
  for (const line of String(sdpText || '').split(/\r?\n/)) {
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
