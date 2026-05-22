// ITU-T G.722 codec — 64 kbit/s, 16 kHz wideband sub-band ADPCM.
//
// Faithful JavaScript port of the public-domain SpanDSP/CMU implementation
// (Steve Underwood 2005; CMU 1993). Only the 64 kbit/s, 16 kHz, unpacked mode
// is ported — that is all the conference bridge needs. The encoder and decoder
// are stateful (ADPCM predictors + QMF history), so each call leg gets its own
// codec instance via makeG722Codec().
//
// Used for the WhatsApp (WABA) conference legs: rtpengine transcodes Meta's
// Opus ↔ G.722, giving an HD 16 kHz path instead of narrowband G.711.
// Reference: https://github.com/sippy/libg722

// ── static tables (verbatim from the ITU/SpanDSP reference) ─────────────────
const QMF = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11];

const Q6 = [
  0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714,
  786, 858, 940, 1023, 1121, 1219, 1339, 1458, 1612, 1765, 1980, 2195, 2557, 2919, 0, 0,
];
const ILN = [
  0, 63, 62, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19,
  18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 0,
];
const ILP = [
  0, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47,
  46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 0,
];
const WL = [-60, -30, 58, 172, 334, 538, 1198, 3042];
const RL42 = [0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0];
const ILB = [
  2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599,
  2656, 2714, 2774, 2834, 2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371,
  3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008,
];
const QM4 = [
  0, -20456, -12896, -8968, -6288, -4240, -2584, -1200,
  20456, 12896, 8968, 6288, 4240, 2584, 1200, 0,
];
const QM2 = [-7408, -1616, 7408, 1616];
const QM6 = [
  -136, -136, -136, -136, -24808, -21904, -19008, -16704,
  -14984, -13512, -12280, -11192, -10232, -9360, -8576, -7856,
  -7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576,
  -3168, -2776, -2400, -2032, -1688, -1360, -1040, -728,
  24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192,
  10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456,
  4944, 4464, 4008, 3576, 3168, 2776, 2400, 2032,
  1688, 1360, 1040, 728, 432, 136, -432, -136,
];
const IHN = [0, 1, 0];
const IHP = [0, 3, 2];
const WH = [0, -214, 798];
const RH2 = [2, 1, 2, 1];

function saturate(amp) {
  if (amp > 32767) return 32767;
  if (amp < -32768) return -32768;
  return amp | 0;
}

function newBand(det) {
  return {
    s: 0, sp: 0, sz: 0,
    r: [0, 0, 0], a: [0, 0, 0], ap: [0, 0, 0], p: [0, 0, 0],
    d: [0, 0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0, 0],
    bp: [0, 0, 0, 0, 0, 0, 0], sg: [0, 0, 0, 0, 0, 0, 0],
    nb: 0, det,
  };
}
// One codec endpoint state: two sub-bands + 24-tap QMF signal history.
function newState() {
  return { band: [newBand(32), newBand(8)], x: new Int32Array(24) };
}

// Block 4 — the ADPCM adaptive predictor, shared by encode and decode.
function block4(band, d) {
  let wd1, wd2, wd3, i;

  band.d[0] = d;
  band.r[0] = saturate(band.s + d);
  band.p[0] = saturate(band.sz + d);

  // UPPOL2
  for (i = 0; i < 3; i++) band.sg[i] = band.p[i] >> 15;
  wd1 = saturate(band.a[1] << 2);
  wd2 = (band.sg[0] === band.sg[1]) ? -wd1 : wd1;
  if (wd2 > 32767) wd2 = 32767;
  wd3 = (wd2 >> 7) + ((band.sg[0] === band.sg[2]) ? 128 : -128);
  wd3 += (band.a[2] * 32512) >> 15;
  if (wd3 > 12288) wd3 = 12288;
  else if (wd3 < -12288) wd3 = -12288;
  band.ap[2] = wd3;

  // UPPOL1
  band.sg[0] = band.p[0] >> 15;
  band.sg[1] = band.p[1] >> 15;
  wd1 = (band.sg[0] === band.sg[1]) ? 192 : -192;
  wd2 = (band.a[1] * 32640) >> 15;
  band.ap[1] = saturate(wd1 + wd2);
  wd3 = saturate(15360 - band.ap[2]);
  if (band.ap[1] > wd3) band.ap[1] = wd3;
  else if (band.ap[1] < -wd3) band.ap[1] = -wd3;

  // UPZERO
  wd1 = (d === 0) ? 0 : 128;
  band.sg[0] = d >> 15;
  for (i = 1; i < 7; i++) {
    band.sg[i] = band.d[i] >> 15;
    wd2 = (band.sg[i] === band.sg[0]) ? wd1 : -wd1;
    wd3 = (band.b[i] * 32640) >> 15;
    band.bp[i] = saturate(wd2 + wd3);
  }

  // DELAYA
  for (i = 6; i > 0; i--) {
    band.d[i] = band.d[i - 1];
    band.b[i] = band.bp[i];
  }
  for (i = 2; i > 0; i--) {
    band.r[i] = band.r[i - 1];
    band.p[i] = band.p[i - 1];
    band.a[i] = band.ap[i];
  }

  // FILTEP
  wd1 = saturate(band.r[1] + band.r[1]);
  wd1 = (band.a[1] * wd1) >> 15;
  wd2 = saturate(band.r[2] + band.r[2]);
  wd2 = (band.a[2] * wd2) >> 15;
  band.sp = saturate(wd1 + wd2);

  // FILTEZ
  band.sz = 0;
  for (i = 6; i > 0; i--) {
    wd1 = saturate(band.d[i] + band.d[i]);
    band.sz += (band.b[i] * wd1) >> 15;
  }
  band.sz = saturate(band.sz);

  // PREDIC
  band.s = saturate(band.sp + band.sz);
}

// Encode 16 kHz Int16 PCM → G.722 bytes (2 input samples → 1 byte).
function g722Encode(s, amp) {
  const out = Buffer.allocUnsafe(amp.length >> 1);
  let n = 0;
  for (let j = 0; j < amp.length; ) {
    // Transmit QMF — split into low/high sub-bands.
    for (let i = 0; i < 22; i++) s.x[i] = s.x[i + 2];
    s.x[22] = amp[j++];
    s.x[23] = amp[j++];
    let sumeven = 0, sumodd = 0;
    for (let i = 0; i < 12; i++) {
      sumodd += s.x[2 * i] * QMF[i];
      sumeven += s.x[2 * i + 1] * QMF[11 - i];
    }
    const xlow = (sumeven + sumodd) >> 14;
    const xhigh = (sumeven - sumodd) >> 14;

    // ── Low band ──
    const el = saturate(xlow - s.band[0].s);
    let wd = (el >= 0) ? el : -(el + 1);
    let i;
    for (i = 1; i < 30; i++) {
      const wd1 = (Q6[i] * s.band[0].det) >> 12;
      if (wd < wd1) break;
    }
    const ilow = (el < 0) ? ILN[i] : ILP[i];
    const ril = ilow >> 2;
    let wd2 = QM4[ril];
    const dlow = (s.band[0].det * wd2) >> 15;
    const il4 = RL42[ril];
    wd = (s.band[0].nb * 127) >> 7;
    s.band[0].nb = wd + WL[il4];
    if (s.band[0].nb < 0) s.band[0].nb = 0;
    else if (s.band[0].nb > 18432) s.band[0].nb = 18432;
    let wd1 = (s.band[0].nb >> 6) & 31;
    wd2 = 8 - (s.band[0].nb >> 11);
    let wd3 = (wd2 < 0) ? (ILB[wd1] << -wd2) : (ILB[wd1] >> wd2);
    s.band[0].det = wd3 << 2;
    block4(s.band[0], dlow);

    // ── High band ──
    const eh = saturate(xhigh - s.band[1].s);
    wd = (eh >= 0) ? eh : -(eh + 1);
    wd1 = (564 * s.band[1].det) >> 12;
    const mih = (wd >= wd1) ? 2 : 1;
    const ihigh = (eh < 0) ? IHN[mih] : IHP[mih];
    wd2 = QM2[ihigh];
    const dhigh = (s.band[1].det * wd2) >> 15;
    const ih2 = RH2[ihigh];
    wd = (s.band[1].nb * 127) >> 7;
    s.band[1].nb = wd + WH[ih2];
    if (s.band[1].nb < 0) s.band[1].nb = 0;
    else if (s.band[1].nb > 22528) s.band[1].nb = 22528;
    wd1 = (s.band[1].nb >> 6) & 31;
    wd2 = 10 - (s.band[1].nb >> 11);
    wd3 = (wd2 < 0) ? (ILB[wd1] << -wd2) : (ILB[wd1] >> wd2);
    s.band[1].det = wd3 << 2;
    block4(s.band[1], dhigh);

    out[n++] = ((ihigh << 6) | ilow) & 0xff;
  }
  return out;
}

// Decode G.722 bytes → 16 kHz Int16 PCM (1 byte → 2 output samples).
function g722Decode(s, data) {
  const out = new Int16Array(data.length * 2);
  let n = 0;
  for (let j = 0; j < data.length; ) {
    const code = data[j++];
    let wd1 = code & 0x3f;
    const ihigh = (code >> 6) & 0x03;
    let wd2 = QM6[wd1];
    wd1 >>= 2;

    // ── Low band ──
    wd2 = (s.band[0].det * wd2) >> 15;
    let rlow = s.band[0].s + wd2;
    if (rlow > 16383) rlow = 16383;
    else if (rlow < -16384) rlow = -16384;
    wd2 = QM4[wd1];
    const dlowt = (s.band[0].det * wd2) >> 15;
    wd2 = RL42[wd1];
    wd1 = (s.band[0].nb * 127) >> 7;
    wd1 += WL[wd2];
    if (wd1 < 0) wd1 = 0;
    else if (wd1 > 18432) wd1 = 18432;
    s.band[0].nb = wd1;
    wd1 = (s.band[0].nb >> 6) & 31;
    wd2 = 8 - (s.band[0].nb >> 11);
    let wd3 = (wd2 < 0) ? (ILB[wd1] << -wd2) : (ILB[wd1] >> wd2);
    s.band[0].det = wd3 << 2;
    block4(s.band[0], dlowt);

    // ── High band ──
    wd2 = QM2[ihigh];
    const dhigh = (s.band[1].det * wd2) >> 15;
    let rhigh = dhigh + s.band[1].s;
    if (rhigh > 16383) rhigh = 16383;
    else if (rhigh < -16384) rhigh = -16384;
    wd2 = RH2[ihigh];
    wd1 = (s.band[1].nb * 127) >> 7;
    wd1 += WH[wd2];
    if (wd1 < 0) wd1 = 0;
    else if (wd1 > 22528) wd1 = 22528;
    s.band[1].nb = wd1;
    wd1 = (s.band[1].nb >> 6) & 31;
    wd2 = 10 - (s.band[1].nb >> 11);
    wd3 = (wd2 < 0) ? (ILB[wd1] << -wd2) : (ILB[wd1] >> wd2);
    s.band[1].det = wd3 << 2;
    block4(s.band[1], dhigh);

    // Receive QMF — recombine the sub-bands.
    for (let i = 0; i < 22; i++) s.x[i] = s.x[i + 2];
    s.x[22] = rlow + rhigh;
    s.x[23] = rlow - rhigh;
    let xout1 = 0, xout2 = 0;
    for (let i = 0; i < 12; i++) {
      xout2 += s.x[2 * i] * QMF[i];
      xout1 += s.x[2 * i + 1] * QMF[11 - i];
    }
    out[n++] = saturate(xout1 >> 11);
    out[n++] = saturate(xout2 >> 11);
  }
  return out;
}

// A per-leg G.722 codec instance matching the conference codec interface
// (see CODEC_PCMU / makeL16Codec in agent.js).
export function makeG722Codec(pt = 9) {
  const enc = newState();
  const dec = newState();
  return {
    name: 'G722',
    rate: 16000,           // decoded audio is 16 kHz → conference mixer needs no resampler
    pt,
    frameSamples: 320,     // 20 ms of 16 kHz PCM consumed per RTP packet
    frameBytes: 160,       // G.722 payload bytes per 20 ms
    rtpTsIncr: 160,        // G.722's RTP timestamp clock is 8 kHz (RFC 3551 quirk)
    silence: Buffer.alloc(160, 0),
    encodeFrame(pcm16) { return g722Encode(enc, pcm16); },
    decodePayload(payload) { return g722Decode(dec, payload); },
    sdp(p) { return `a=rtpmap:${p} G722/8000\r\n`; },
  };
}
