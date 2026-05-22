// rtpengine bridge/subscribe choreography probe.
// Drives the live rtpengine NG socket with synthetic SDPs to validate the
// double-originated 2-leg bridge + transcription subscription, BEFORE wiring
// it into agent.js. No real media — just checks rtpengine's SDP rewriting.
import crypto from 'node:crypto';
import dgram from 'node:dgram';

const NG_HOST = '127.0.0.1', NG_PORT = 22222;

function bencode(v) {
  if (typeof v === 'number') return `i${v}e`;
  if (typeof v === 'string') return `${Buffer.byteLength(v)}:${v}`;
  if (Array.isArray(v)) return 'l' + v.map(bencode).join('') + 'e';
  if (v && typeof v === 'object') {
    const k = Object.keys(v).sort();
    return 'd' + k.map(x => bencode(x) + bencode(v[x])).join('') + 'e';
  }
  throw new Error('unencodable');
}
function bdecode(s, i = { p: 0 }) {
  const c = s[i.p];
  if (c === 'i') { const e = s.indexOf('e', i.p); const n = parseInt(s.slice(i.p + 1, e)); i.p = e + 1; return n; }
  if (c === 'l') { i.p++; const a = []; while (s[i.p] !== 'e') a.push(bdecode(s, i)); i.p++; return a; }
  if (c === 'd') { i.p++; const o = {}; while (s[i.p] !== 'e') { const k = bdecode(s, i); o[k] = bdecode(s, i); } i.p++; return o; }
  if (c >= '0' && c <= '9') { const col = s.indexOf(':', i.p); const n = parseInt(s.slice(i.p, col)); const str = s.slice(col + 1, col + 1 + n); i.p = col + 1 + n; return str; }
  throw new Error('bdecode ' + c);
}
function ng(cmd) {
  return new Promise((resolve, reject) => {
    const cookie = crypto.randomBytes(6).toString('hex');
    const s = dgram.createSocket('udp4');
    const buf = Buffer.from(`${cookie} ${bencode(cmd)}`);
    const t = setTimeout(() => { s.close(); reject(new Error('timeout')); }, 4000);
    s.on('message', (m) => {
      clearTimeout(t); s.close();
      const str = m.toString('utf8'); const sp = str.indexOf(' ');
      try { resolve(bdecode(str.slice(sp + 1))); } catch (e) { reject(e); }
    });
    s.on('error', (e) => { clearTimeout(t); s.close(); reject(e); });
    s.send(buf, NG_PORT, NG_HOST);
  });
}

const sdp = (ip, port, lines) =>
  `v=0\r\no=- 1 1 IN IP4 ${ip}\r\ns=-\r\nc=IN IP4 ${ip}\r\nt=0 0\r\n` +
  `m=audio ${port} RTP/AVP ${lines.pts}\r\n${lines.rtpmaps}a=sendrecv\r\na=ptime:20\r\n`;

const callId = 'probe-' + crypto.randomBytes(6).toString('hex');
const TAG_CUST = 'cust-' + crypto.randomBytes(4).toString('hex');
const TAG_EMP  = 'emp-'  + crypto.randomBytes(4).toString('hex');

const mline = (s) => (String(s).match(/^m=audio.*$/m) || ['(no m=)'])[0];
const codecs = (s) => (String(s).match(/^a=rtpmap:.*$/gm) || []).map(x => x.replace('a=rtpmap:', '')).join(', ');

async function main() {
  console.log(`call-id=${callId}\n`);

  // Generic ladder offer the agent crafts to seed leg B (the placeholder).
  const genOffer = sdp('127.0.0.1', 40000, {
    pts: '96 97 8 0 101',
    rtpmaps: 'a=rtpmap:96 EVS/16000\r\na=rtpmap:97 AMR-WB/16000\r\n' +
             'a=rtpmap:8 PCMA/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n',
  });

  // STEP 1 — offer(from-tag=EMP, sdp=genOffer) → SDP to INVITE the customer with.
  const r1 = await ng({
    command: 'offer', 'call-id': callId, 'from-tag': TAG_EMP, sdp: genOffer,
    ICE: 'remove', DTLS: 'off', SDES: 'off', 'transport-protocol': 'RTP/AVP',
    'rtcp-mux': ['demux'], replace: ['origin', 'session-connection'],
    flags: ['trust-address'],
  });
  console.log(`STEP 1 offer(placeholder)  result=${r1.result}`);
  console.log(`  → customer INVITE SDP: ${mline(r1.sdp)}  [${codecs(r1.sdp)}]\n`);

  // Customer answers — picks EVS.
  const custAns = sdp('198.51.100.10', 6000, {
    pts: '96 101', rtpmaps: 'a=rtpmap:96 EVS/16000\r\na=rtpmap:101 telephone-event/8000\r\n',
  });
  // STEP 2 — answer(from-tag=EMP, to-tag=CUST) → SDP to INVITE the employee with.
  const r2 = await ng({
    command: 'answer', 'call-id': callId, 'from-tag': TAG_EMP, 'to-tag': TAG_CUST, sdp: custAns,
    ICE: 'remove', DTLS: 'off', SDES: 'off', 'transport-protocol': 'RTP/AVP',
    'rtcp-mux': ['demux'], flags: ['trust-address'],
  });
  console.log(`STEP 2 answer(customer=EVS)  result=${r2.result}`);
  console.log(`  → employee INVITE SDP: ${mline(r2.sdp)}  [${codecs(r2.sdp)}]\n`);

  // Employee answers — also EVS (the 90% phone case → should bridge passthrough).
  const empAns = sdp('203.0.113.20', 7000, {
    pts: '96 101', rtpmaps: 'a=rtpmap:96 EVS/16000\r\na=rtpmap:101 telephone-event/8000\r\n',
  });
  // STEP 3 — re-offer(from-tag=EMP) to replace the placeholder with the real employee media.
  const r3 = await ng({
    command: 'offer', 'call-id': callId, 'from-tag': TAG_EMP, sdp: empAns,
    ICE: 'remove', DTLS: 'off', SDES: 'off', 'transport-protocol': 'RTP/AVP',
    'rtcp-mux': ['demux'], flags: ['trust-address'],
  });
  console.log(`STEP 3 re-offer(employee=EVS)  result=${r3.result}`);
  console.log(`  → (would re-INVITE customer only if this changed) ${mline(r3.sdp)}  [${codecs(r3.sdp)}]\n`);

  // STEP 4 — subscribe to the customer leg for a PCMU transcription fork.
  const r4 = await ng({
    command: 'subscribe request', 'call-id': callId, 'from-tag': TAG_CUST,
    ICE: 'remove', DTLS: 'off', SDES: 'off', 'transport-protocol': 'RTP/AVP',
    'rtcp-mux': ['demux'], codec: { transcode: ['PCMU'] },
  });
  console.log(`STEP 4 subscribe request(customer)  result=${r4.result}`);
  console.log(`  → fork offer SDP: ${mline(r4.sdp)}  [${codecs(r4.sdp)}]`);
  console.log(`  → keys: ${Object.keys(r4).join(', ')}  to-tag=${r4['to-tag']}\n`);

  // STEP 4b — subscribe answer: agent provides a recvonly PCMU socket.
  const subTag = r4['to-tag'];
  const agentRecv = sdp('127.0.0.1', 41000, {
    pts: '0 101', rtpmaps: 'a=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n',
  }).replace('a=sendrecv', 'a=recvonly');
  const r4b = await ng({
    command: 'subscribe answer', 'call-id': callId,
    'to-tag': subTag, sdp: agentRecv,
    ICE: 'remove', DTLS: 'off', SDES: 'off', 'transport-protocol': 'RTP/AVP',
    'rtcp-mux': ['demux'], flags: ['allow transcoding'],
  });
  console.log(`STEP 4b subscribe answer  result=${r4b.result}  ${r4b['error-reason'] || ''}\n`);

  // STEP 5 — inspect the resulting call.
  const q = await ng({ command: 'query', 'call-id': callId });
  console.log(`STEP 5 query  result=${q.result}  tags=${q.tags ? Object.keys(q.tags).length : '?'}`);
  console.log(JSON.stringify(q, null, 1).slice(0, 1400));

  await ng({ command: 'delete', 'call-id': callId });
  console.log('\ncleaned up.');
}
main().catch(e => { console.error('PROBE ERROR:', e?.message || e); process.exit(1); });
