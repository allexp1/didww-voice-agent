// didww-voice-agent — SIP → Gemini Live voice agent.
//
// DIDWW DID → drachtio (SIP) → this process bridges RTP both ways → Gemini Live
// WebSocket. rtpengine handles transcoding, WhatsApp/WABA media and conference
// bridging. See docs/ARCHITECTURE.md.

import 'dotenv/config';
import Srf from 'drachtio-srf';
import sdpTransform from 'sdp-transform';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { GoogleGenAI, Modality } from '@google/genai';
import libsamplerate from '@alexanderolsen/libsamplerate-js';
import WebSocket from 'ws';
import express from 'express';
import { rtpNg, parseAudioMedia } from './rtpengine.js';
import { makeG722Codec } from './g722.js';
import { startTrunkRegistration } from './trunk-register.js';
import { getDemoVoiceConfig, execDemoTool } from './demo-config.js';
const { create: createResampler, ConverterType } = libsamplerate;

const {
  PUBLIC_IP,
  DRACHTIO_HOST = '127.0.0.1',
  DRACHTIO_PORT = '9022',
  DRACHTIO_SECRET = 'cymru',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-3.1-flash-live-preview',
  RTP_PORT_MIN = '10000',
  RTP_PORT_MAX = '20000',
  INTERNAL_VOICE_URL = '',     // optional external config service; unset → built-in demo agent
  INTERNAL_VOICE_TOKEN = '',
  VOICE_VPS_ANNOUNCE_SECRET = '', // HMAC secret for app→VPS /v1/calls/* requests
  MAX_CONCURRENT_CALLS = '20',
  MAX_CALL_SECONDS = '600',    // hard cap per call to prevent runaway Gemini cost
  VAD_RMS_THRESHOLD = '500',   // caller-mic energy gate (RMS, Int16 PCM)
  ANNOUNCE_QUEUE_MAX = '3',    // max queued announcements per call
  // --- outbound calling (carrier-agnostic SIP trunk; set in .env) ---
  SIP_DOMAIN = '',  // outbound SIP trunk host/IP — required for outbound calls
  SIP_USER = '',  // trunk digest username — blank → IP auth only
  SIP_PASSWORD = '',
  CLI = '',       // caller ID: a trunk-owned DID, E.164 digits
  // Native-audio model for the 3-leg conference (Proactive Audio). Kept separate
  // from GEMINI_MODEL: inbound 1:1 calls stay on gemini-3.1-flash-live-preview,
  // which does not support proactivity.
  GEMINI_CONFERENCE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025',
  // Deepgram streaming STT — live transcription for outbound conference calls.
  DEEPGRAM_TOKEN = '',
} = process.env;
const MAX_CONCURRENT = parseInt(MAX_CONCURRENT_CALLS);
const MAX_CALL_MS = parseInt(MAX_CALL_SECONDS) * 1000;
const VAD_RMS = parseInt(VAD_RMS_THRESHOLD);
const ANN_QMAX = parseInt(ANNOUNCE_QUEUE_MAX);
// Conference media-path instrumentation — per-leg RTP/jitter-buffer counters
// logged every ~2s. Off by default; set DEBUG_MEDIA=1 in .env to enable.
const DBG_MEDIA = process.env.DEBUG_MEDIA === '1';

// Fetch the system prompt + tool declarations for a specific caller.
//
// When INTERNAL_VOICE_URL is set, this calls an external config service, so each
// caller can get a different prompt and tools (see docs/ADVANCED.md). When it is
// not set, it returns the built-in demo agent from demo-config.js — so a fresh
// clone answers calls with no extra infrastructure.
//
// Returns { systemPrompt, tools, contact, conversationId, locale } or null.
async function fetchVoiceConfig(waId, name) {
  if (!INTERNAL_VOICE_URL || !INTERNAL_VOICE_TOKEN) return getDemoVoiceConfig();
  try {
    const r = await fetch(`${INTERNAL_VOICE_URL.replace(/\/$/, '')}/api/v1/voice/config`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${INTERNAL_VOICE_TOKEN}`,
      },
      body: JSON.stringify({ waId, name }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { console.warn(`[voice-config] HTTP ${r.status}`); return null; }
    return await r.json();
  } catch (e) { console.warn('[voice-config] fetch failed:', e?.message || e); return null; }
}

async function execToolRemote(callId, waId, conversationId, name, args) {
  // No external config service → run the built-in demo tools locally.
  if (!INTERNAL_VOICE_URL || !INTERNAL_VOICE_TOKEN) return execDemoTool(name, args);
  try {
    const r = await fetch(`${INTERNAL_VOICE_URL.replace(/\/$/, '')}/api/v1/voice/tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${INTERNAL_VOICE_TOKEN}`,
      },
      // callId is required so the app can attach voice_tasks rows to the live
      // call and fire mid-call announcements via /v1/calls/:callId/announce.
      body: JSON.stringify({ callId, waId, conversationId, name, args }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    return String(j.result ?? j.error ?? 'Error: no result');
  } catch (e) { return `Error: tool proxy failed — ${e?.message || e}`; }
}

// Ask the control app to hang up a WABA call on Meta's side. This agent owns
// the Gemini + RTP legs, but only the control app holds the Meta access token
// to terminate the WhatsApp call. Returns true on success, false otherwise —
// the caller still does local teardown either way.
async function wabaHangupRemote(callId, waId, reason) {
  if (!INTERNAL_VOICE_URL || !INTERNAL_VOICE_TOKEN) return false;
  try {
    const r = await fetch(`${INTERNAL_VOICE_URL.replace(/\/$/, '')}/api/v1/voice/hangup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${INTERNAL_VOICE_TOKEN}`,
      },
      body: JSON.stringify({ callId, waId, reason, channel: 'waba' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.warn(`[${callId}] control-app hangup HTTP ${r.status}`); return false; }
    return true;
  } catch (e) { console.warn(`[${callId}] control-app hangup failed: ${e?.message || e}`); return false; }
}

// Normalize an inbound PSTN CLI to E.164 digits-only for use as the caller key.
// DIDWW's "Raw" CLI format preserves whatever the originating carrier sent, which
// is sometimes the national format (e.g. "07700900123") without a country code.
// Rule:
//   - leading "+"        → strip it (already E.164)
//   - leading "00"       → international prefix, strip (e.g. "0044770…" → "44770…")
//   - leading "0"        → national format → strip the "0", prepend the default CC
//   - everything else    → assume already in E.164 digits, leave as-is
const DIDWW_DEFAULT_CC = process.env.DIDWW_DEFAULT_COUNTRY_CODE || '1';
function normalizeToE164Digits(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+'))  d = d.slice(1);
  if (d.startsWith('00')) return d.slice(2) || null;
  if (d.startsWith('0'))  return DIDWW_DEFAULT_CC + d.slice(1);
  return d || null;
}
// Convert a caller-supplied number to the digit string the SIP trunk dials with.
// DIDWW two-way trunks route on E.164, so the default is an E.164 digit string
// (no "+", no "00"). Carriers that route on national format instead — some ITSPs
// reject E.164 with a 404 — need a carrier-specific rewrite here, for example an
// Israeli national trunk: `if (d.startsWith('972')) d = '0' + d.slice(3);`.
function toCarrierNumber(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);          // drop 00 international prefix
  return d || null;
}
function extractCallerWaId(fromHeader) {
  // fromHeader like '<sip:441234567890@203.0.113.5>;tag=...'
  const m = String(fromHeader || '').match(/sip:(\+?\d{4,15})@/i);
  if (!m) return null;
  return normalizeToE164Digits(m[1]);
}

// Generic retry-posting helper. Fire-and-forget with exponential backoff 0→1→3→9s,
// then give up. Never throws; errors logged.
async function postWithBackoff(path, body, tag) {
  if (!INTERNAL_VOICE_URL || !INTERNAL_VOICE_TOKEN) return;
  const url = `${INTERNAL_VOICE_URL.replace(/\/$/, '')}${path}`;
  const delays = [0, 1000, 3000, 9000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${INTERNAL_VOICE_TOKEN}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) { return r.json().catch(() => ({})); }
      console.warn(`[${tag}] POST ${path} ${r.status} — retry ${i+1}/${delays.length-1}`);
    } catch (e) {
      console.warn(`[${tag}] POST ${path} err: ${e?.message || e} — retry ${i+1}/${delays.length-1}`);
    }
  }
  console.error(`[${tag}] POST ${path} gave up after ${delays.length} tries`);
}

// Summary hook — idempotent on callId (server dedupes).
const summaryPosted = new Set();
async function postVoiceSummary(meta) {
  if (!meta?.callId || summaryPosted.has(meta.callId)) return;
  summaryPosted.add(meta.callId);
  if (meta.status === 'COMPLETED' && meta.durationSec < 2 && meta.transcript.length === 0) {
    meta.status = 'FAILED';
    if (!meta.endReason) meta.endReason = 'no media';
  }
  const j = await postWithBackoff('/api/v1/voice/summary', meta, meta.callId);
  if (j?.messageId !== undefined) console.log(`[${meta.callId}] summary posted (messageId=${j.messageId})`);
}

// Live per-turn hook — fires on each turnComplete / interrupted so the support UI
// gets transcript updates in realtime. Shares callId with the /summary POST.
function postVoiceTurn({ callId, waId, callerName, channel, turnIndex, role, text, ts, staffName }) {
  if (!text) return;
  postWithBackoff(
    '/api/v1/voice/turn',
    { waId, callerName: callerName || null, channel, callId, turnIndex, role, text, ts: ts || new Date().toISOString(), staffName: staffName || null },
    `${callId}#t${turnIndex}`,
  );
}

// Outbound call-state hook — ringing / answered / failed / ended for conference
// legs, so the control app's UI can show live call progress. Best-effort; the
// /api/v1/voice/call-state endpoint may not exist yet (added in a later stage).
function postCallState(callId, state, extra = {}) {
  postWithBackoff(
    '/api/v1/voice/call-state',
    { callId, state, ...extra, ts: new Date().toISOString() },
    `${callId}#${state}`,
  );
}

// Round-robin even-port allocator inside UFW-allowed range.
const PORT_LO = parseInt(RTP_PORT_MIN) & ~1;
const PORT_HI = parseInt(RTP_PORT_MAX) & ~1;
let nextRtpPort = PORT_LO + ((Math.floor(Math.random() * (PORT_HI - PORT_LO)) >> 1) << 1);
async function allocRtpSocket() {
  for (let tries = 0; tries < 200; tries++) {
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

if (!PUBLIC_IP) throw new Error('PUBLIC_IP env required');
if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY env required');

// --- G.711 µ-law codec (ITU-T G.711) ---
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  MULAW_DECODE[i] = (u & 0x80) ? (0x84 - t) : (t - 0x84);
}
function mulawEncodeSample(s) {
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > 32635) s = 32635;
  s += 0x84;
  let exp = 7, m = 0x4000;
  while ((s & m) === 0 && exp > 0) { exp--; m >>= 1; }
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

// --- codec adapters (PCMU narrowband, L16 wideband) ---
// Selects best codec from SDP offer; exposes uniform encode/decode + metadata
// so runCallSession is codec-agnostic.
const CODEC_PCMU = {
  name: 'PCMU', rate: 8000, pt: 0, frameSamples: 160, frameBytes: 160,
  silence: Buffer.alloc(160, 0xff),
  encodeFrame(pcm16) {
    const b = Buffer.allocUnsafe(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) b[i] = mulawEncodeSample(pcm16[i]);
    return b;
  },
  decodePayload(payload) {
    const pcm = new Int16Array(payload.length);
    for (let i = 0; i < payload.length; i++) pcm[i] = MULAW_DECODE[payload[i]];
    return pcm;
  },
  sdp(pt) {
    return `a=rtpmap:${pt} PCMU/8000\r\n`;
  },
};
function makeL16Codec(pt) {
  return {
    name: 'L16', rate: 16000, pt, frameSamples: 320, frameBytes: 640,
    silence: Buffer.alloc(640, 0x00), // Int16 big-endian zero
    encodeFrame(pcm16) {
      const b = Buffer.allocUnsafe(pcm16.length * 2);
      for (let i = 0; i < pcm16.length; i++) b.writeInt16BE(pcm16[i], i * 2);
      return b;
    },
    decodePayload(payload) {
      const n = payload.length >> 1;
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = payload.readInt16BE(i * 2);
      return pcm;
    },
    sdp(p) {
      return `a=rtpmap:${p} L16/16000\r\n`;
    },
  };
}
// Pick best supported codec from a sdp-transform `media` entry. Returns null if none usable.
function chooseCodec(sdpMedia) {
  const rtps = sdpMedia?.rtp || [];
  // Prefer L16/16000 (wideband)
  const l16 = rtps.find(r => String(r.codec).toUpperCase() === 'L16' && (r.rate === 16000 || !r.rate));
  if (l16) return makeL16Codec(l16.payload);
  const pcmu = rtps.find(r => String(r.codec).toUpperCase() === 'PCMU' && (r.rate === 8000 || !r.rate));
  if (pcmu) return { ...CODEC_PCMU, pt: pcmu.payload };
  return null;
}

// --- libsamplerate-based resampler (sinc interpolation, VoIP-grade) ---
// Single instance per (inRate,outRate) per call — stateful streaming.
//
// Quality choice: SRC_SINC_MEDIUM_QUALITY. ~5x cheaper than BEST_QUALITY
// (≈100-tap kernel vs 512), 132 dB SNR — still ≫ 90 dB above G.711's
// inherent ~37 dB SNR floor, so the difference is inaudible on the wire.
// The CPU savings buy back event-loop headroom, which is what actually
// causes audible jitter under concurrent calls — not converter precision.
async function makeResampler(inRate, outRate) {
  const src = await createResampler(1, inRate, outRate, {
    converterType: ConverterType.SRC_SINC_MEDIUM_QUALITY,
  });
  return {
    process(pcm16) {
      const f32in = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) f32in[i] = pcm16[i] / 32768;
      const f32out = src.full(f32in);
      const out = new Int16Array(f32out.length);
      for (let i = 0; i < f32out.length; i++) {
        const v = Math.max(-1, Math.min(1, f32out[i])) * 32767;
        out[i] = v | 0;
      }
      return out;
    },
    destroy() { try { src.destroy(); } catch {} }
  };
}

// --- RTP packet builder ---
function buildRtpPacket({ seq, ts, ssrc, payload, payloadType = 0, marker = false }) {
  const pkt = Buffer.alloc(12 + payload.length);
  pkt[0] = 0x80;                                  // V=2, P=0, X=0, CC=0
  pkt[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  pkt.writeUInt16BE(seq & 0xffff, 2);
  pkt.writeUInt32BE(ts >>> 0, 4);
  pkt.writeUInt32BE(ssrc >>> 0, 8);
  payload.copy ? payload.copy(pkt, 12) : pkt.set(payload, 12);
  return pkt;
}

// --- RTP payload extractor ---
// Honours the CSRC count and the optional header extension (X bit) instead of
// assuming a fixed 12-byte header. rtpengine sets the X bit on transcoded
// WhatsApp/WABA legs; a fixed offset would feed 4 extension bytes to the
// decoder as audio (an audible ~50 Hz buzz over the caller's voice).
function rtpPayload(pkt) {
  if (pkt.length < 12) return pkt.subarray(pkt.length);
  let off = 12 + (pkt[0] & 0x0f) * 4;                 // skip CSRC list
  if ((pkt[0] & 0x10) && pkt.length >= off + 4) {     // X bit → header extension
    off += 4 + pkt.readUInt16BE(off + 2) * 4;         // 4-byte ext header + words
  }
  return off <= pkt.length ? pkt.subarray(off) : pkt.subarray(pkt.length);
}

// --- main ---
const srf = new Srf();
let trunkReg = null;
srf.connect({ host: DRACHTIO_HOST, port: parseInt(DRACHTIO_PORT), secret: DRACHTIO_SECRET });
srf.on('connect', (err, hp) => {
  if (err) { drachtioConnected = false; return console.error('drachtio', err); }
  drachtioConnected = true;
  console.log('drachtio connected', hp);
  // Register to the carrier so it delivers inbound calls to this server.
  if (!trunkReg) trunkReg = startTrunkRegistration(srf, {
    domain: SIP_DOMAIN, user: SIP_USER, pass: SIP_PASSWORD,
    publicIp: PUBLIC_IP, sipPort: 5060,
  });
});
srf.on('error', (err) => { drachtioConnected = false; console.error('drachtio error', err); });

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
// Separate client pinned to the v1alpha API — required for the conference's
// Proactive Audio (proactivity.proactiveAudio). Inbound 1:1 calls use `ai`.
const aiAlpha = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });

// Active sessions by callId — allows external (HTTP) control for WABA teardown.
const sessions = new Map();
// Recently-ended sessions — kept ~90s so /v1/calls/:callId/status can return
// `active=false` for late polls instead of 404. (Spec open question 6 / 7.)
const endedSessions = new Map(); // callId → { ended_at: unix-seconds }
const ENDED_SESSION_TTL_MS = 90_000;
let shuttingDown = false;
let drachtioConnected = false;

// Shared session runner — used by both SIP (drachtio) and WABA (HTTP control) paths.
// Takes an already-bound RTP socket + the peer's RTP address, plus caller identity.
// Returns { terminate }.
async function runCallSession({ callId, waId, rtp, localPort, remoteHost, remotePort, codec = CODEC_PCMU, channel = 'pstn', direction = 'inbound', callerName = null, endCall = null, voiceConfig }) {
  console.log(`[${callId}] session start waId=${waId || '?'} channel=${channel} codec=${codec.name}/${codec.rate} RTP :${localPort} ↔ ${remoteHost}:${remotePort}`);

  // Call metadata → posted as a voice-call summary to the control app on terminate.
  const meta = {
    waId, callerName, channel, callId,
    direction,
    status: 'COMPLETED',
    endReason: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationSec: 0,
    transcript: [],
    toolCalls: [],
  };
  const _startMs = Date.now();
  // Caller turns are sourced from Deepgram STT (see DG_ENABLED below) — Gemini's
  // own ASR misroutes speakers and skips short bursts. The assistant's turns
  // still come from Gemini's `outputTranscription` (the model's literal text —
  // exact, and it streams cleanly, unlike re-transcribing its TTS audio).
  // Gemini Live owns the conversation and tools throughout.
  let assistantBuf = '';
  let turnIndex = 0;
  // Caller VAD: simple RMS gate on inbound PCM frames; updated in rtp.on('message').
  // Used by /v1/calls/:callId/announce to decide when to inject a mid-call announcement.
  let lastCallerActivityAt = Date.now();
  function emitUserTurn(text) {
    const u = String(text || '').trim();
    if (!u) return;
    const now = new Date().toISOString();
    meta.transcript.push({ role: 'user', text: u, ts: now });
    postVoiceTurn({ callId, waId, callerName, channel, turnIndex: turnIndex++, role: 'user', text: u, ts: now });
  }
  // Posts an 'assistant' chat turn from the accumulated Gemini transcript.
  function emitAssistantTurn(text) {
    const a = String(text || '').trim();
    if (!a) return;
    const now = new Date().toISOString();
    const transcriptText = speakingAnnouncement ? `[announcement] ${a}` : a;
    meta.transcript.push({ role: 'assistant', text: transcriptText, ts: now });
    postVoiceTurn({ callId, waId, callerName, channel, turnIndex: turnIndex++, role: 'assistant', text: transcriptText, ts: now });
  }
  function flushAssistantTurn() {
    const a = assistantBuf.trim();
    assistantBuf = '';
    if (!a) {
      // Empty turn but an announcement was injected → treat as internal_error so
      // the app doesn't wait forever for the ack.
      if (speakingAnnouncement) finalizeAnnouncement('dropped', { dropped_reason: 'internal_error' });
      return;
    }
    emitAssistantTurn(a);
    // If an announcement drove this turn, ack it as spoken.
    if (speakingAnnouncement) finalizeAnnouncement('spoken', { actual_speak_text: a });
  }
  function pushTurnIfAny() { flushAssistantTurn(); } // kept for terminate path

  // Assistant config (system prompt + tools). The inbound-SIP path pre-fetches
  // it and passes it in; other paths fetch here. fetchVoiceConfig returns the
  // built-in demo agent when no external config service is set, so voiceCfg is
  // normally present — a null here means an external service was configured
  // but unreachable, so decline the call rather than answer prompt-less.
  const voiceCfg = voiceConfig !== undefined
    ? voiceConfig
    : (waId ? await fetchVoiceConfig(waId) : null);
  if (!voiceCfg?.systemPrompt) {
    console.warn(`[${callId}] no voice config (waId=${waId || 'unknown'}) — declining call, no static fallback`);
    try { rtp.close(); } catch {}
    try { await endCall?.('no voice config'); } catch {}
    meta.status = 'FAILED';
    meta.endReason = 'no_voice_config';
    meta.endedAt = new Date().toISOString();
    meta.durationSec = 0;
    postVoiceSummary(meta).catch(() => {});
    throw new Error('no_voice_config');
  }
  console.log(`[${callId}] config loaded waId=${waId} contact=#${voiceCfg.contact?.id ?? '?'} tools=${voiceCfg.tools?.length ?? 0}`);

  // Resamplers depend on codec rate. Skip creation when ratio is 1:1.
  const rsUp = codec.rate === 16000 ? null : await makeResampler(codec.rate, 16000);
  const rsDown = await makeResampler(24000, codec.rate);

  // Deepgram STT transcribes the caller leg (16k caller audio) → 'user' turns.
  // Aria's turns come from Gemini's outputTranscription. Falls back to Gemini
  // ASR for the caller too only if DEEPGRAM_TOKEN is unset.
  const DG_ENABLED = !!DEEPGRAM_TOKEN;
  let callerDg = null;
  if (DG_ENABLED) {
    callerDg = startDeepgramStreamAuto({ callId, role: 'caller',
      onTurn: (t) => { console.log(`[${callId}] caller(dg): ${t}`); emitUserTurn(t); } });
  } else {
    console.warn(`[${callId}] DEEPGRAM_TOKEN not set — caller transcript falls back to Gemini ASR`);
  }

  // RTP send state
  const ssrc = (Math.random() * 0xffffffff) >>> 0;
  let seq = (Math.random() * 0xffff) & 0xffff;
  let ts = (Math.random() * 0xffffffff) >>> 0;

  // outbound audio queue (Int16Array at codec rate; 20ms frames = codec.frameSamples)
  let outQueue = new Int16Array(0);
  let wasSilent = true;

  function sendOneRtp() {
    let payload, marker = false;
    if (outQueue.length >= codec.frameSamples) {
      const frame = outQueue.subarray(0, codec.frameSamples);
      outQueue = outQueue.subarray(codec.frameSamples);
      payload = codec.encodeFrame(frame);
      if (wasSilent) { marker = true; wasSilent = false; }
    } else {
      payload = codec.silence;
      wasSilent = true;
    }
    const pkt = buildRtpPacket({ seq, ts, ssrc, payload, marker, payloadType: codec.pt });
    rtp.send(pkt, remotePort, remoteHost);
    seq = (seq + 1) & 0xffff;
    ts = (ts + codec.frameSamples) >>> 0;
  }

  // Drift-corrected 20ms pacer — setInterval has 1–10ms Node.js event-loop jitter which
  // translates to audible underruns/overruns at the receiver's jitter buffer. This loop
  // tracks absolute wall-clock and emits catch-up packets if the loop stalled.
  // Gemini output accumulator — flushed on 80ms timer / turnComplete / barge-in.
  let pendingOut24 = [];
  let pendingOut24Len = 0;
  let pendingFlushTimer = null;
  function flushOut24() {
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
    if (pendingOut24Len === 0) return;
    const concat24 = new Int16Array(pendingOut24Len);
    let off = 0;
    for (const s of pendingOut24) { concat24.set(s, off); off += s.length; }
    pendingOut24 = []; pendingOut24Len = 0;
    const pcm8 = rsDown.process(concat24);
    const merged = new Int16Array(outQueue.length + pcm8.length);
    merged.set(outQueue); merged.set(pcm8, outQueue.length);
    outQueue = merged;
  }

  let pacerStopped = false;
  let nextSendAt = Date.now();
  const PACE_MS = 20;
  let pacerTimer = null;
  function pace() {
    if (pacerStopped) return;
    const now = Date.now();
    let emitted = 0;
    while (nextSendAt <= now && emitted < 10) { // safety cap per tick
      sendOneRtp();
      nextSendAt += PACE_MS;
      emitted++;
    }
    pacerTimer = setTimeout(pace, Math.max(1, nextSendAt - Date.now()));
  }
  pace();
  const pacer = { clear() { pacerStopped = true; if (pacerTimer) clearTimeout(pacerTimer); } };

  // Gemini Live session
  let session;
  try {
    // Prefer the caller-specific locale from the voice config, then the env
    // default, then en-US. Pinning the language stops STT from flipping
    // mid-call on short or noisy frames.
    const GEMINI_LANG = voiceCfg?.locale?.languageCode || process.env.GEMINI_LANGUAGE_CODE || 'en-US';
    console.log(`[${callId}] lang=${GEMINI_LANG}`);
    // Inject the current wall-clock time so the model can reason about "now" —
    // opening hours, today/tomorrow, ETAs. Without it the model falls back to
    // training-data time. Timezone is set by AGENT_TIMEZONE (default UTC).
    const now = new Date();
    const tz = process.env.AGENT_TIMEZONE || 'UTC';
    const fmtEn = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const iso = now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T') + ` (${tz})`;
    const timeBlock =
      `\n\n---\n\nCURRENT TIME (use this as "now" when answering about hours, dates, today/tomorrow):\n` +
      `- ${fmtEn.format(now)}\n` +
      `- ISO: ${iso}\n`;

    const endCallGuide =
      `\n\n---\n\nENDING THE CALL:\n` +
      `You have a tool called \`end_call\` that hangs up the phone. ` +
      `Use it when the customer has clearly finished — they say goodbye, thank you and sign off, or explicitly ask to hang up. ` +
      `Before calling \`end_call\`, say a short, warm goodbye in voice in the same turn — the line stays open just long enough for it to play. ` +
      `Do NOT use \`end_call\` to interrupt the customer, and do NOT mention the tool to them.\n`;

    const gemConfig = {
      responseModalities: [Modality.AUDIO],
      // TTS language + voice for Aria's output. Aoede = warm, natural female voice.
      speechConfig: {
        languageCode: GEMINI_LANG,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || 'Aoede' } },
      },
      // Transcribe caller speech + model speech — drives the live transcript.
      // The transcription config takes no language field (the Gemini API
      // rejects `languageCodes`); `{}` simply enables it.
      inputAudioTranscription:  {},
      outputAudioTranscription: {},
      // VAD tuning. Production-grade VoIP runs into background noise constantly
      // (kitchens, traffic, kids). The previous config (START_HIGH + END_LOW)
      // was exactly backwards: any background noise registered as "caller is
      // speaking" and the LOW end-sensitivity then waited forever to commit
      // turn-end → Aria would sit silent until the noise cleared.
      //
      // Inversion + tighter windows per:
      //   - Vertex Live API enum docs (HIGH = trigger more often)
      //   - sipfront 2026-01 baresip/Gemini Live deep-dive (400–600ms silence)
      //   - Google ai.google.dev best-practices (20–40ms input chunks, pin language)
      //
      // Note: silenceDurationMs is silently ignored on gemini-3.1-flash-live-preview
      // (js-genai #1467, Apr 2026). Kept for forward-compat — value is what we
      // want when the bug is fixed or we move models.
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',    // ignore background noise
          endOfSpeechSensitivity:   'END_SENSITIVITY_HIGH',     // commit turn-end faster
          prefixPaddingMs:  300,                                // 200 sometimes clips first phoneme
          silenceDurationMs: 600,                               // 0.6s silence → end-of-turn (when honored)
        },
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',       // keep barge-in working
      },
      // Enable session resumption → Gemini keeps context across WS drops and
      // lifts the default hard session cap. We track handles via sessionResumptionUpdate.
      sessionResumption: { handle: null },
      // Sliding-window compression prevents token-limit truncation on long calls.
      contextWindowCompression: { slidingWindow: {} },
      systemInstruction: { parts: [{ text: voiceCfg.systemPrompt + timeBlock + endCallGuide }] },
    };
    // Local tools — always available, regardless of the voice config source.
    // `end_call` lets Aria hang up after a goodbye. Local names take precedence over remote
    // ones (defensive — prod should never re-declare `end_call`).
    const localTools = [
      {
        name: 'end_call',
        description:
          'End the current phone call (sends SIP BYE on PSTN, asks Meta to terminate on WABA). ' +
          'Use ONLY after you have said a short goodbye in voice. Never use it to interrupt the caller.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description:
                'Short reason for ending the call (e.g. "caller said goodbye", "caller asked for human", "caller abusive").',
            },
          },
          required: ['reason'],
        },
      },
    ];
    const localToolNames = new Set(localTools.map((t) => t.name));
    const remoteTools = (voiceCfg?.tools || []).filter((t) => !localToolNames.has(t.name));
    gemConfig.tools = [{ functionDeclarations: [...localTools, ...remoteTools] }];

    session = await ai.live.connect({
      model: GEMINI_MODEL,
      config: gemConfig,
      callbacks: {
        onopen: () => console.log(`[${callId}] gemini open`),
        onmessage: (msg) => {
          if (process.env.DEBUG_GEMINI === '1') {
            try {
              const trace = JSON.stringify(msg, (k, v) => k === 'data' && typeof v === 'string' && v.length > 40 ? `<${v.length}B audio>` : v).slice(0, 400);
              console.log(`[${callId}] gemini msg:`, trace);
            } catch {}
          }
          if (msg?.sessionResumptionUpdate?.newHandle) {
            // Save latest handle so we could auto-reconnect on drop (future work).
            console.log(`[${callId}] gemini resumption handle updated (resumable=${!!msg.sessionResumptionUpdate.resumable})`);
          }
          if (msg?.goAway) {
            console.warn(`[${callId}] gemini goAway: time left ${msg.goAway?.timeLeft || '?'}`);
          }
          if (msg?.setupComplete) {
            console.log(`[${callId}] gemini setupComplete → sending kickoff`);
            try {
              // Nudge the model to speak first so the caller hears a greeting.
              session.sendRealtimeInput({ text: `The caller is now connected. Greet them out loud in ${GEMINI_LANG}.` });
            } catch (e) { console.error(`[${callId}] kickoff failed`, e); }
            return;
          }
          // Gemini requested one or more tools — execute each and respond.
          if (msg?.toolCall?.functionCalls?.length) {
            const calls = msg.toolCall.functionCalls;
            console.log(`[${callId}] tools requested: ${calls.map(c => c.name).join(', ')}`);
            Promise.all(calls.map(async (fc) => {
              const tsIso = new Date().toISOString();
              let result;
              if (fc.name === 'end_call') {
                // Handled locally — schedule hangup after the current speaking turn drains.
                const reason = String(fc.args?.reason || 'unspecified').slice(0, 200);
                scheduleEndCallAfterTurn(reason);
                result = 'ok — call ending. Say a brief goodbye now if you have not already.';
              } else {
                result = waId
                  ? await execToolRemote(callId, waId, voiceCfg?.conversationId, fc.name, fc.args || {})
                  : `Error: no caller identity — cannot execute ${fc.name}`;
              }
              console.log(`[${callId}]   ${fc.name} → ${String(result).slice(0, 120)}`);
              // Record for call-summary hook.
              meta.toolCalls.push({ name: fc.name, args: fc.args || {}, result: String(result), ts: tsIso });
              return { id: fc.id, name: fc.name, response: { result } };
            })).then((functionResponses) => {
              try { session.sendToolResponse({ functionResponses }); }
              catch (e) { console.error(`[${callId}] sendToolResponse failed`, e); }
            });
            return;
          }
          if (msg?.serverContent?.inputTranscription?.text) {
            // Gemini ASR — only used as the chat source when Deepgram is off.
            console.log(`[${callId}] caller said: ${msg.serverContent.inputTranscription.text}`);
            if (!DG_ENABLED) emitUserTurn(msg.serverContent.inputTranscription.text);
          }
          if (msg?.serverContent?.outputTranscription?.text) {
            assistantBuf += msg.serverContent.outputTranscription.text;
            console.log(`[${callId}] gemini said: ${msg.serverContent.outputTranscription.text}`);
          }
          // Accumulate Gemini audio across multiple WS messages into a single buffer,
          // then resample in one batch every ~80ms. Cuts sinc-edge transients by ~10×
          // vs per-message resampling. Adds ≤80ms to first-syllable latency.
          const parts = msg?.serverContent?.modelTurn?.parts || [];
          for (const p of parts) {
            const data = p.inlineData?.data;
            if (!data) continue;
            const buf = Buffer.from(data, 'base64');
            const pcm24 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
            pendingOut24.push(pcm24);
            pendingOut24Len += pcm24.length;
          }
          if (pendingOut24Len > 0 && !pendingFlushTimer) {
            // 40ms accumulator (was 80ms). Halves first-syllable latency to
            // the caller. Edge transients between batches are bounded by
            // libsamplerate's internal sinc kernel state — fine at MEDIUM.
            pendingFlushTimer = setTimeout(flushOut24, 40);
          }
          if (msg?.serverContent?.interrupted) {
            console.log(`[${callId}] caller barged in — flushing outbound audio`);
            outQueue = new Int16Array(0);
            pendingOut24 = []; pendingOut24Len = 0;
            if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
            flushAssistantTurn(); // snapshot Aria's partial utterance at barge-in
          }
          if (msg?.serverContent?.turnComplete) {
            console.log(`[${callId}] turn done`);
            flushOut24(); // push any last samples immediately so we don't trail off
            flushAssistantTurn();
            if (endCallPending) executePendingEndCall();
          }
        },
        onerror: (e) => {
          console.error(`[${callId}] gemini err`, e?.message || e);
          meta.status = 'FAILED'; terminatedReason = `gemini error: ${e?.message || e}`;
        },
        onclose: (e) => {
          console.log(`[${callId}] gemini closed`, e?.reason || '');
          if (e?.reason && !terminatedReason) terminatedReason = `gemini closed: ${e.reason}`;
        },
      }
    });
  } catch (e) {
    console.error(`[${callId}] gemini connect failed`, e);
    try { pacer.clear(); } catch {}
    try { rtp.close(); } catch {}
    meta.status = 'FAILED';
    meta.endedAt = new Date().toISOString();
    meta.durationSec = Math.max(0, Math.round((Date.now() - _startMs) / 1000));
    meta.endReason = `gemini connect failed: ${e?.message || e}`;
    postVoiceSummary(meta).catch(() => {});
    throw e;
  }

  // Inbound RTP from caller (or rtpengine for WABA) — buffer 2 packets (40ms) before
  // resampling + sending to Gemini. Google's Live API best-practices recommend
  // 20–40ms chunks for VAD responsiveness; 60ms (the previous value) lagged the
  // VAD enough to feel sluggish under noise.
  let inBuf = [];
  let inLen = 0;
  const IN_BATCH_PACKETS = 2;
  rtp.on('message', (pkt) => {
    if (pkt.length < 12) return;
    const pt = pkt[1] & 0x7f;
    if (pt === 101) return; // DTMF – ignore for now
    if (pt !== codec.pt) return; // only the negotiated codec
    const payload = rtpPayload(pkt);
    const pcm = codec.decodePayload(payload);
    // Cheap RMS VAD on the just-decoded frame (still at codec rate). Updates
    // lastCallerActivityAt whenever energy crosses VAD_RMS, which the announce
    // worker uses to gauge "caller silent for N ms".
    let sumSq = 0;
    for (let i = 0; i < pcm.length; i++) { const s = pcm[i]; sumSq += s * s; }
    if (Math.sqrt(sumSq / pcm.length) > VAD_RMS) lastCallerActivityAt = Date.now();
    inBuf.push(pcm); inLen += pcm.length;
    if (inBuf.length < IN_BATCH_PACKETS) return;
    const merged = new Int16Array(inLen);
    let off = 0;
    for (const s of inBuf) { merged.set(s, off); off += s.length; }
    inBuf = []; inLen = 0;
    const pcm16 = rsUp ? rsUp.process(merged) : merged; // no-op when codec is already 16k
    callerDg?.send(pcm16);                              // → Deepgram live STT (chat source)
    const buf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    try {
      session.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
    } catch (e) { /* session may have closed */ }
  });

  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    pacer.clear();
    // Drain announcement queue + in-flight, ack each as call_ended so the app
    // doesn't wait the full 60s grace for missing acks.
    if (announcePumpTimer) { clearInterval(announcePumpTimer); announcePumpTimer = null; }
    for (const entry of announceQueue) {
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
      ackAnnounce(entry, { status: 'dropped', dropped_reason: 'call_ended' });
    }
    announceQueue.length = 0;
    if (speakingAnnouncement) {
      ackAnnounce(speakingAnnouncement, { status: 'dropped', dropped_reason: 'call_ended' });
      speakingAnnouncement = null;
    }
    try { rtp.close(); } catch {}
    try { session?.close?.(); } catch {}
    // Close Deepgram first: close() flushes any buffered final turn into
    // meta.transcript synchronously, before the summary POST below.
    try { callerDg?.close(); } catch {}
    try { rsUp?.destroy(); } catch {}
    try { rsDown.destroy(); } catch {}
    sessions.delete(callId);
    // Finalize metadata + post summary (non-blocking, idempotent).
    pushTurnIfAny();
    meta.endedAt = new Date().toISOString();
    meta.durationSec = Math.max(0, Math.round((Date.now() - _startMs) / 1000));
    if (!meta.endReason) meta.endReason = terminatedReason || 'COMPLETED';
    // Stash for /v1/calls/:callId/status late polls (~90s window).
    endedSessions.set(callId, { ended_at: Math.floor(new Date(meta.endedAt).getTime() / 1000) });
    setTimeout(() => endedSessions.delete(callId), ENDED_SESSION_TTL_MS).unref();
    postVoiceSummary(meta).catch((e) => console.error(`[${callId}] summary post failed`, e?.message || e));
    console.log(`[${callId}] ended — ${meta.durationSec}s, ${meta.transcript.length} turns, ${meta.toolCalls.length} tool calls`);
  };
  let terminatedReason = null;
  // Hard cap per-call duration to prevent runaway Gemini spend.
  const hardCapTimer = setTimeout(() => {
    if (sessions.has(callId)) {
      console.warn(`[${callId}] hard cap ${MAX_CALL_SECONDS}s reached — terminating`);
      terminate();
    }
  }, MAX_CALL_MS);
  const origTerminate = terminate;
  const wrapTerminate = () => {
    clearTimeout(hardCapTimer);
    if (endCallSafetyTimer) { clearTimeout(endCallSafetyTimer); endCallSafetyTimer = null; }
    origTerminate();
  };

  // Agent-initiated hangup ('end_call' tool). On call: stash reason; on next
  // turnComplete, wait for outQueue to drain (so the goodbye plays out), then
  // run the channel-specific endCall callback (SIP BYE / Meta terminate) and
  // finally local teardown.
  let endCallPending = null;
  let endCallSafetyTimer = null;
  function scheduleEndCallAfterTurn(reason) {
    if (endCallPending || terminated) return;
    endCallPending = { reason };
    // Safety: if turnComplete never arrives, hang up after 10s anyway.
    endCallSafetyTimer = setTimeout(() => {
      if (endCallPending) {
        console.warn(`[${callId}] end_call: turnComplete timeout — forcing hangup`);
        executePendingEndCall();
      }
    }, 10_000);
  }
  function executePendingEndCall() {
    if (!endCallPending || terminated) return;
    const { reason } = endCallPending;
    endCallPending = null;
    if (endCallSafetyTimer) { clearTimeout(endCallSafetyTimer); endCallSafetyTimer = null; }
    // outQueue is at codec.rate (8k or 16k); estimate playout time + 500ms safety.
    const drainMs = Math.ceil((outQueue.length / codec.rate) * 1000) + 500;
    console.log(`[${callId}] end_call: draining ${drainMs}ms then hanging up (reason=${reason})`);
    setTimeout(async () => {
      if (terminated) return;
      terminatedReason = `agent ended call: ${reason}`;
      meta.endReason = terminatedReason;
      try { if (endCall) await endCall(reason); }
      catch (e) { console.error(`[${callId}] endCall callback failed:`, e?.message || e); }
      wrapTerminate();
    }, drainMs);
  }

  // ── Mid-call announcements (POST /v1/calls/:callId/announce) ─────────────
  // Worker pattern: enqueueAnnounce stashes a payload + TTL timer; pumpAnnounceQueue
  // polls every 100ms while non-empty and injects when caller is silent and the
  // model isn't speaking. flushAssistantTurn detects the spoken result and acks.
  // Per-session cap = ANN_QMAX (default 3). One announcement spoken at a time;
  // 500ms gap between consecutive ones.
  const announceQueue = [];
  let speakingAnnouncement = null;
  let announcePumpTimer = null;

  function modelSpeaking() {
    return outQueue.length > 0 || pendingOut24Len > 0 || assistantBuf.length > 0;
  }
  function announceLang() {
    return voiceCfg?.locale?.languageCode || process.env.GEMINI_LANGUAGE_CODE || 'en-US';
  }

  // Fire ack callback to the app. Best-effort, fire-and-forget.
  function ackAnnounce(entry, result) {
    if (!entry.ack_callback_url) return;
    const body = {
      task_id: entry.task_id,
      call_id: callId,
      status: result.status,
      actual_speak_text: result.actual_speak_text || entry.speak_text,
    };
    if (result.status === 'spoken') body.spoken_at = result.spoken_at || Math.floor(Date.now() / 1000);
    if (result.status === 'dropped') body.dropped_reason = result.dropped_reason;
    fetch(entry.ack_callback_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${INTERNAL_VOICE_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).then((r) => {
      if (!r.ok) console.warn(`[${callId}] announce ack ${result.status} HTTP ${r.status}`);
    }).catch((e) => {
      console.warn(`[${callId}] announce ack ${result.status} failed: ${e?.message || e}`);
    });
  }

  // Called from flushAssistantTurn when the announcement-driven turn ends, or
  // from the queue worker on dropped paths. Clears speakingAnnouncement and
  // schedules the next pump after the inter-announcement gap.
  function finalizeAnnouncement(status, extra) {
    if (!speakingAnnouncement) return;
    const entry = speakingAnnouncement;
    speakingAnnouncement = null;
    ackAnnounce(entry, { status, ...(extra || {}) });
    // 500ms gap before next announcement may be considered.
    setTimeout(() => { if (!terminated) pumpAnnounceQueue(); }, 500);
  }

  function pumpAnnounceQueue() {
    if (announcePumpTimer || terminated) return;
    if (!announceQueue.length && !speakingAnnouncement) return;
    announcePumpTimer = setInterval(() => {
      if (terminated) {
        clearInterval(announcePumpTimer); announcePumpTimer = null;
        return;
      }
      if (speakingAnnouncement) return;
      const entry = announceQueue[0];
      if (!entry) {
        clearInterval(announcePumpTimer); announcePumpTimer = null;
        return;
      }
      // Block injection while the model is speaking, the caller is talking,
      // or an end_call hangup is already pending — never speak over a goodbye.
      if (modelSpeaking()) return;
      if (endCallPending) return;
      const silentMs = Date.now() - lastCallerActivityAt;
      if (silentMs < entry.wait_for_silence_ms) return;
      // Inject.
      announceQueue.shift();
      if (entry.ttlTimer) { clearTimeout(entry.ttlTimer); entry.ttlTimer = null; }
      speakingAnnouncement = entry;
      injectAnnouncement(entry);
      // Pump pauses until finalizeAnnouncement re-arms it 500ms after speech end.
      clearInterval(announcePumpTimer); announcePumpTimer = null;
    }, 100);
  }

  function injectAnnouncement(entry) {
    // Option B from the spec: prefixed user turn. The Live SDK's stable surface
    // is sendRealtimeInput({text}) which is treated as a user-side turn; works
    // on every Live version we've seen. If/when Option A (synthetic system turn)
    // is verified for this SDK, swap here.
    const wrapped =
      `[SYSTEM ANNOUNCEMENT — speak the following verbatim in ${entry.language || announceLang()}, ` +
      `then return naturally to the conversation]: ${entry.speak_text}`;
    console.log(`[${callId}] announce inject task_id=${entry.task_id} kind=${entry.kind} text="${entry.speak_text.slice(0, 80)}"`);
    try {
      session.sendRealtimeInput({ text: wrapped });
    } catch (e) {
      console.error(`[${callId}] announce inject failed`, e?.message || e);
      finalizeAnnouncement('dropped', { dropped_reason: 'internal_error' });
    }
  }

  // Public entry from /v1/calls/:callId/announce.
  function enqueueAnnounce(payload) {
    const speakText = String(payload?.speak_text || '').trim().slice(0, 500);
    if (!speakText) return { error: 'invalid_payload', details: 'speak_text required' };
    if (announceQueue.length >= ANN_QMAX) {
      return { error: 'max_queue_depth', current_depth: announceQueue.length };
    }
    const waitMs = Math.max(0, parseInt(payload?.wait_for_silence_ms ?? 1500, 10) || 1500);
    const ttlMs  = Math.max(1000, parseInt(payload?.ttl_ms ?? 30000, 10) || 30000);
    const entry = {
      task_id: payload?.task_id ?? null,
      kind: payload?.kind || 'task_complete',
      speak_text: speakText,
      language: payload?.language || announceLang(),
      wait_for_silence_ms: waitMs,
      ttl_ms: ttlMs,
      ack_callback_url: payload?.ack_callback_url || null,
      queuedAt: Date.now(),
      ttlTimer: null,
    };
    entry.ttlTimer = setTimeout(() => {
      const idx = announceQueue.indexOf(entry);
      if (idx >= 0) {
        announceQueue.splice(idx, 1);
        ackAnnounce(entry, { status: 'dropped', dropped_reason: 'ttl_expired' });
      }
      // If already speaking, let it finish — we don't drop mid-utterance.
    }, ttlMs);
    announceQueue.push(entry);
    pumpAnnounceQueue();
    // Caller-facing estimate: when injection FIRES, not when speech completes.
    // Model pickup latency ≈ 300ms after sendRealtimeInput for a short text turn.
    const estimated = waitMs + 300;
    return { estimated_speak_at_ms: estimated };
  }

  function getStatus() {
    const now = Date.now();
    return {
      call_id: callId,
      active: !terminated,
      started_at: Math.floor(_startMs / 1000),
      duration_ms: now - _startMs,
      caller_speaking: (now - lastCallerActivityAt) < 500,
      model_speaking: modelSpeaking(),
      announce_queue_depth: announceQueue.length + (speakingAnnouncement ? 1 : 0),
    };
  }

  sessions.set(callId, { terminate: wrapTerminate, enqueueAnnounce, getStatus });
  return { terminate: wrapTerminate };
}

// ── SIP egress (outbound PSTN via the carrier trunk) ─────────────────
// Step 1 of outbound calling. Places a call through the outbound trunk and
// bridges the answered leg into the existing 1:1 Gemini session.
//
// Outbound legs are routed through rtpengine so every call defaults to the
// best quality the carrier can take. The agent natively speaks only
// PCMU/G.722/L16, so it hands rtpengine a lossless L16/16k leg over loopback
// and rtpengine offers the carrier a quality-ordered codec ladder, transcoding
// L16 ↔ whatever the carrier picks. PCMU/PCMA stay last so a call never fails
// on codec negotiation. (fmtp tuning — AMR octet-align, EVS bandwidth/bitrate —
// uses rtpengine defaults; revisit once a real carrier negotiation is observed.)
const OUTBOUND_TRUNK_CODECS = ['EVS', 'AMR-WB', 'AMR', 'PCMU', 'PCMA', 'telephone-event'];
const OUTBOUND_L16_PT = 118;

// rtpengine `offer` for an outbound leg: feed it the agent's L16/16k SDP and
// get back the carrier-facing offer SDP to put in the INVITE. The agent is the
// offerer here, so its own media endpoint comes later, from the `answer` reply.
async function rtpengineOutboundOffer(rtpCallId, localPort) {
  const fromTag = 'agent-' + crypto.randomBytes(4).toString('hex');
  const toTag   = 'trunk-' + crypto.randomBytes(4).toString('hex');
  const agentOffer =
    `v=0\r\no=- ${Date.now()} 1 IN IP4 127.0.0.1\r\ns=agent\r\n` +
    `c=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
    `m=audio ${localPort} RTP/AVP ${OUTBOUND_L16_PT} 101\r\n` +
    `a=rtpmap:${OUTBOUND_L16_PT} L16/16000\r\n` +
    `a=rtpmap:101 telephone-event/16000\r\n` +
    `a=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n`;
  const offerReply = await rtpNg({
    command: 'offer',
    'call-id': rtpCallId,
    'from-tag': fromTag,
    sdp: agentOffer,
    'ICE': 'remove',
    'DTLS': 'off',
    'SDES': 'off',
    'rtcp-mux': ['demux'],
    'transport-protocol': 'RTP/AVP',
    'replace': ['origin', 'session-connection'],
    'flags': ['trust-address', 'strict-source'],
    // Mask the agent's L16 from the carrier-facing offer and present the
    // quality ladder instead — list order = SDP preference (EVS first).
    'codec': { mask: ['all'], offer: OUTBOUND_TRUNK_CODECS, transcode: OUTBOUND_TRUNK_CODECS },
  });
  if (offerReply?.result !== 'ok') {
    throw new Error(`rtpengine outbound offer: ${offerReply?.['error-reason'] || JSON.stringify(offerReply).slice(0, 200)}`);
  }
  return { fromTag, toTag, trunkOfferSdp: offerReply.sdp };
}

// rtpengine `answer`: feed it the carrier's answer SDP and get back the
// agent-facing endpoint (rtpengine's loopback side) the agent sends L16 to.
async function rtpengineOutboundAnswer(rtpCallId, fromTag, toTag, trunkAnswerSdp) {
  const answerReply = await rtpNg({
    command: 'answer',
    'call-id': rtpCallId,
    'from-tag': fromTag,
    'to-tag': toTag,
    sdp: trunkAnswerSdp,
    'ICE': 'remove',
    'DTLS': 'off',
    'SDES': 'off',
    'rtcp-mux': ['demux'],
    'transport-protocol': 'RTP/AVP',
    'flags': ['trust-address', 'strict-source'],
  });
  if (answerReply?.result !== 'ok') {
    throw new Error(`rtpengine outbound answer: ${answerReply?.['error-reason'] || JSON.stringify(answerReply).slice(0, 200)}`);
  }
  const { host, port } = parseAudioMedia(answerReply.sdp);
  if (!host || !port) throw new Error('rtpengine outbound answer: no media endpoint');
  return { remoteHost: host, remotePort: port };
}

// Place an outbound PSTN call and bridge the answered leg to a Gemini session.
// Resolves once the call is up; throws on any failure (the HTTP handler logs it).
async function placeOutboundPstn({ callId, toNumber }) {
  const toDigits = normalizeToE164Digits(toNumber);  // E.164 — waId / config lookup
  const dialNum  = toCarrierNumber(toNumber);         // national — SIP RURI (carrier format)
  if (!toDigits || !dialNum) throw new Error(`unroutable number: ${toNumber}`);
  if (!CLI) {
    console.warn(`[${callId}] CLI not set — the trunk may reject the call or rewrite the CLI`);
  }

  const { socket: rtp, port: localPort } = await allocRtpSocket();

  // Route the leg through rtpengine so the carrier is offered EVS/AMR-WB/…
  let fromTag, toTag, trunkOfferSdp;
  try {
    ({ fromTag, toTag, trunkOfferSdp } = await rtpengineOutboundOffer(callId, localPort));
  } catch (e) {
    try { rtp.close(); } catch {}
    throw new Error(`rtpengine offer failed: ${e?.message || e}`);
  }

  // From carries our caller ID; drachtio adds the From tag and sets Contact
  // itself. `auth` answers the trunk's digest challenge — omitted on IP auth.
  const uacOpts = {
    localSdp: trunkOfferSdp,
    headers: { From: `<sip:${SIP_USER || CLI || dialNum}@${SIP_DOMAIN || PUBLIC_IP}>` },
  };
  if (SIP_USER) uacOpts.auth = { username: SIP_USER, password: SIP_PASSWORD };

  console.log(`[${callId}] outbound INVITE → sip:${dialNum}@${SIP_DOMAIN} CLI=${CLI || '(none)'} (HD via rtpengine)`);
  let dialog;
  try {
    dialog = await srf.createUAC(`sip:${dialNum}@${SIP_DOMAIN}`, uacOpts);
  } catch (e) {
    try { rtp.close(); } catch {}
    rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    // e.status carries the SIP failure code (486 Busy, 480, 408 timeout, 603…).
    throw new Error(`outbound INVITE failed: ${e?.status || e?.message || e}`);
  }
  console.log(`[${callId}] outbound call answered by ${toDigits}`);

  // Hand the carrier's answer to rtpengine; it transcodes L16 ↔ the negotiated
  // carrier codec and tells us the loopback endpoint to send our L16 to.
  let remoteHost, remotePort;
  try {
    ({ remoteHost, remotePort } = await rtpengineOutboundAnswer(callId, fromTag, toTag, dialog.remote.sdp));
  } catch (e) {
    try { rtp.close(); } catch {}
    try { await dialog.destroy(); } catch {}
    rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    throw new Error(`bad outbound answer SDP: ${e?.message || e}`);
  }

  const codec = makeL16Codec(OUTBOUND_L16_PT);
  let sess;
  try {
    sess = await runCallSession({
      callId, waId: toDigits, rtp, localPort, remoteHost, remotePort, codec,
      channel: 'pstn', direction: 'outbound',
      // Agent-initiated hangup ('end_call'): send BYE downstream; dialog.on('destroy')
      // then fires sess.terminate via the normal teardown path.
      endCall: async () => {
        try { await dialog.destroy(); }
        catch (e) { console.warn(`[${callId}] dialog.destroy failed`, e?.message || e); }
      },
    });
  } catch (e) {
    try { await dialog.destroy(); } catch {}
    rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    throw e;
  }
  dialog.on('destroy', () => {
    sess.terminate();
    rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
  });
  return sess;
}

// Dial one outbound PSTN leg via the carrier trunk. Resolves when the callee
// answers, with the established dialog + a bound RTP socket + the negotiated
// remote media. Throws (with the SIP failure code) on any failure.
//
// Like placeOutboundPstn, the leg is routed through rtpengine for HD codec
// negotiation. Both conference legs share the base callId, so the rtpengine
// session is keyed on `callId-label` to stay distinct; `cleanup` deletes it.
async function dialPstnLeg(callId, toNumber, label) {
  const toDigits = normalizeToE164Digits(toNumber);  // E.164 — waId / label
  const dialNum  = toCarrierNumber(toNumber);         // national — SIP RURI (carrier format)
  if (!toDigits || !dialNum) throw new Error(`${label}: unroutable number ${toNumber}`);
  const { socket: rtp, port: localPort } = await allocRtpSocket();
  const rtpCallId = `${callId}-${label}`;

  let fromTag, toTag, trunkOfferSdp;
  try {
    ({ fromTag, toTag, trunkOfferSdp } = await rtpengineOutboundOffer(rtpCallId, localPort));
  } catch (e) {
    try { rtp.close(); } catch {}
    throw new Error(`${label}: rtpengine offer failed — ${e?.message || e}`);
  }

  const uacOpts = {
    localSdp: trunkOfferSdp,
    headers: { From: `<sip:${SIP_USER || CLI || dialNum}@${SIP_DOMAIN || PUBLIC_IP}>` },
  };
  if (SIP_USER) uacOpts.auth = { username: SIP_USER, password: SIP_PASSWORD };
  console.log(`[${callId}] ${label} INVITE → sip:${dialNum}@${SIP_DOMAIN} CLI=${CLI || '(none)'} (HD via rtpengine)`);
  let dialog;
  try {
    dialog = await srf.createUAC(`sip:${dialNum}@${SIP_DOMAIN}`, uacOpts);
  } catch (e) {
    try { rtp.close(); } catch {}
    rtpNg({ command: 'delete', 'call-id': rtpCallId }).catch(() => {});
    // e.status carries the SIP failure code (486 Busy, 408/480 no-answer, 603…).
    const err = new Error(`${label} INVITE failed: ${e?.status || e?.message || e}`);
    err.sipStatus = e?.status;
    throw err;
  }
  let remoteHost, remotePort;
  try {
    ({ remoteHost, remotePort } = await rtpengineOutboundAnswer(rtpCallId, fromTag, toTag, dialog.remote.sdp));
  } catch (e) {
    try { rtp.close(); } catch {}
    try { await dialog.destroy(); } catch {}
    rtpNg({ command: 'delete', 'call-id': rtpCallId }).catch(() => {});
    throw new Error(`${label}: bad answer SDP — ${e?.message || e}`);
  }
  const codec = makeL16Codec(OUTBOUND_L16_PT);
  console.log(`[${callId}] ${label} answered by ${toDigits} (${codec.name}/${codec.rate} ↔ carrier via rtpengine)`);
  return {
    dialog, rtp, localPort, remoteHost, remotePort, codec, toDigits,
    // Conference teardown calls this alongside closing the socket.
    cleanup: () => {
      try { rtp.close(); } catch {}
      rtpNg({ command: 'delete', 'call-id': rtpCallId }).catch(() => {});
    },
  };
}

// 3-leg conference: a staff PSTN leg + a customer PSTN leg, bridged to each
// other, with Aria as a quiet third participant. Aria runs on the native-
// audio model with Proactive Audio — she co-listens silently and speaks only
// on her own judgement (addressed by name, a factual error, a missed question).
// ── Deepgram streaming STT (outbound-conference transcription) ──────────────
// Each human leg of an outbound call opens its own Deepgram realtime socket,
// so speaker attribution is exact (no mixed-audio guessing). Finalised
// utterances are handed to onTurn(text). Non-fatal: if the socket fails, the
// call simply continues without live transcription.
//
// `language` pins the recogniser to a specific tongue. The wrapper
// startDeepgramStreamAuto() below detects the caller's language from the
// first ~2.5s of audio and feeds the result here; callers can pass an explicit
// code to skip detection.
function startDeepgramStream({ callId, role, onTurn, language }) {
  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || 'nova-3',
    language: language || process.env.DEEPGRAM_LANGUAGE || 'en',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300',          // 300ms silence → utterance boundary (speech_final)
  });
  let buf = '';                  // finalised (is_final) segments not yet emitted as a turn
  let interim = '';              // latest non-final hypothesis (only flushed on close)
  let flushTimer = null;
  let closed = false;
  let opened = false;
  const pending = [];            // audio captured before the socket finished opening

  function pushTurn(text) {
    const t = String(text || '').trim();
    if (t) { try { onTurn(t); } catch {} }
  }

  // Sentence-by-sentence streaming: as soon as buf holds one or more complete
  // sentences (smart_format gives us punctuation), emit each as its own turn
  // and keep only the trailing partial. A sentence terminator must be followed
  // by whitespace or end-of-buffer, so decimals like "12.5" don't split.
  function flushSentences() {
    const re = /(.+?[.!?…]+)(?=\s|$)/s;
    let m;
    while ((m = buf.match(re))) {
      pushTurn(m[1]);
      buf = buf.slice(m.index + m[1].length).replace(/^\s+/, '');
    }
  }

  // Flush everything still buffered (buf + interim) as one turn — used at an
  // endpoint / timeout / close, when no further punctuation will arrive.
  function emit() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const text = `${buf} ${interim}`.trim();
    buf = ''; interim = '';
    pushTurn(text);
  }

  let ws;
  try {
    ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${DEEPGRAM_TOKEN}` },
    });
  } catch (e) {
    console.error(`[${callId}] deepgram ${role} connect threw: ${e?.message || e}`);
    return { send() {}, close() {} };
  }

  ws.on('open', () => {
    opened = true;
    console.log(`[${callId}] deepgram ${role} open (lang=${params.get('language')})`);
    for (const b of pending.splice(0)) { try { ws.send(b); } catch {} }
  });
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type && m.type !== 'Results') return;
    const t = (m.channel?.alternatives?.[0]?.transcript || '').trim();
    if (!t) return;
    if (m.is_final) {
      buf = buf ? `${buf} ${t}` : t;
      interim = '';
      flushSentences();          // emit each now-complete sentence immediately
    } else { interim = t; }
    // speech_final marks an endpointed utterance boundary → flush the trailing
    // partial sentence (one without closing punctuation).
    if (m.speech_final && buf) { emit(); return; }
    // Safety net: flush a partial sentence that has sat unsent for ~2.5s.
    if (buf) { if (flushTimer) clearTimeout(flushTimer); flushTimer = setTimeout(emit, 2500); }
    else if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  });
  ws.on('error', (e) => console.error(`[${callId}] deepgram ${role} error: ${e?.message || e}`));
  ws.on('close', () => { if (!closed) console.warn(`[${callId}] deepgram ${role} socket closed`); });

  // Deepgram drops idle sockets after ~10s; a live call's RTP is continuous so
  // this rarely matters, but a KeepAlive is cheap insurance during long holds.
  const ka = setInterval(() => {
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
  }, 7000);
  ka.unref?.();

  return {
    send(pcm16) {
      const b = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
      if (opened && ws.readyState === 1) { try { ws.send(b); } catch {} }
      else if (!closed && pending.length < 250) pending.push(b);   // ~5s pre-open cap
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(ka);
      emit();   // flush any buffered transcript into meta.transcript before the summary
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
      try { ws.close(); } catch {}
    },
  };
}

// One-shot batch language detection on a short PCM16/16k mono sample. Returns
// an ISO code (e.g. 'en', 'ru', 'fr') with reasonable confidence, or null when
// inconclusive. If a language is not detectable, callers fall back to
// DEEPGRAM_LANGUAGE (default `en`) at the call-site. Uses nova-2
// because detect_language is most reliable there; the streaming socket below
// then uses whichever model DEEPGRAM_MODEL points at (nova-3 by default).
async function detectCallerLanguage({ callId, role, pcmBuf }) {
  if (!DEEPGRAM_TOKEN || !pcmBuf?.length) return null;
  const params = new URLSearchParams({
    model: 'nova-2',
    detect_language: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });
  try {
    const r = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${DEEPGRAM_TOKEN}`,
        'Content-Type': 'audio/x-raw',
      },
      body: pcmBuf,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.warn(`[${callId}] ${role} lang-detect HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    const ch = j?.results?.channels?.[0];
    const detected = ch?.detected_language || null;
    const conf = ch?.language_confidence ?? 0;
    if (detected && conf >= 0.5) {
      console.log(`[${callId}] ${role} lang detected: ${detected} (conf=${conf.toFixed(2)})`);
      return detected;
    }
    console.log(`[${callId}] ${role} lang detect inconclusive (got=${detected || 'none'}, conf=${conf})`);
    return null;
  } catch (e) {
    console.warn(`[${callId}] ${role} lang-detect failed: ${e?.message || e}`);
    return null;
  }
}

// Auto-language wrapper around startDeepgramStream. Buffers the first
// DEEPGRAM_DETECT_MS of caller audio in RAM, runs a batch detect_language
// call, then opens the streaming socket pinned to the detected language and
// replays the buffered audio. If detection is inconclusive or auto-detect is
// off, falls back to DEEPGRAM_LANGUAGE (default `en`). Same {send, close}
// surface as startDeepgramStream so call-sites don't change.
function startDeepgramStreamAuto({ callId, role, onTurn }) {
  const DEFAULT_LANG = process.env.DEEPGRAM_LANGUAGE || 'en';
  const AUTO_ON = process.env.DEEPGRAM_AUTO_DETECT !== 'false';
  const DETECT_MS = Math.max(500, parseInt(process.env.DEEPGRAM_DETECT_MS || '2500'));

  if (!AUTO_ON) return startDeepgramStream({ callId, role, onTurn, language: DEFAULT_LANG });

  let inner = null;
  let closed = false;
  let detectFired = false;
  const buffered = [];                // Buffer[] — pcm16 frames captured pre-detect
  let bufferedBytes = 0;
  // 16k mono PCM16 = 32 bytes/ms. Cap the buffer at ~10s so a silent caller
  // can't pin unbounded memory if detect somehow never fires.
  const BYTES_PER_MS = 32;
  const TARGET_BYTES = BYTES_PER_MS * DETECT_MS;
  const BUDGET_BYTES = BYTES_PER_MS * 10000;

  function openWith(lang) {
    inner = startDeepgramStream({ callId, role, onTurn, language: lang });
    for (const buf of buffered.splice(0)) {
      inner.send(new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2));
    }
    bufferedBytes = 0;
  }

  async function fireDetect() {
    if (detectFired || closed) return;
    detectFired = true;
    const sample = Buffer.concat(buffered);
    const detected = await detectCallerLanguage({ callId, role, pcmBuf: sample });
    if (closed) return;
    openWith(detected || DEFAULT_LANG);
  }

  // Safety net: if audio is sparse (e.g. caller silent), still open a stream
  // with the default language after 2× the target window so we don't sit on
  // a dead socket forever.
  const timer = setTimeout(() => { fireDetect(); }, DETECT_MS * 2);
  timer.unref?.();

  return {
    send(pcm16) {
      if (closed) return;
      if (inner) { inner.send(pcm16); return; }
      // Deep-copy: pcm16's underlying ArrayBuffer may be reused by the caller.
      const view = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
      const copy = Buffer.allocUnsafe(view.length);
      view.copy(copy);
      if (bufferedBytes + copy.length <= BUDGET_BYTES) {
        buffered.push(copy);
        bufferedBytes += copy.length;
      }
      if (!detectFired && bufferedBytes >= TARGET_BYTES) fireDetect();
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (inner) { inner.close(); return; }
      // Detection never fired — flush whatever we buffered through a default-lang
      // stream so any speech we did capture still shows up in the transcript.
      if (buffered.length) {
        openWith(DEFAULT_LANG);
        inner.close();
      }
    },
  };
}

// ── outbound conference: rtpengine passthrough bridge ────────────────────
// A phone↔phone conference (employee + customer, Gemini NOT in the path) is
// bridged entirely inside rtpengine — the agent never touches the call media.
// The first leg dialed negotiates freely against the EVS/AMR-WB/AMR/PCMU
// ladder; the second leg is then offered ONLY what the first leg picked, so
// both converge on one codec and rtpengine relays with zero transcoding and
// no added latency. Validated NG choreography (see tools/rtpe-bridge-probe):
//   offer(placeholder) → answer(leg1) → offer(leg2 re-register).
// Transcription is a side-tap: `subscribe request`/`answer` forks a decoded
// PCMU copy of each leg to the agent for Deepgram, off the critical path.
//
// Browser-staff and WhatsApp conferences do NOT use this — they stay on the
// Node mixer (runConferenceSession): a browser leg can't speak EVS/AMR anyway.
function createOutboundBridge(rtpCallId) {
  const tag1 = 'cl1-' + crypto.randomBytes(5).toString('hex'); // 1st leg dialed
  const tag2 = 'cl2-' + crypto.randomBytes(5).toString('hex'); // 2nd leg dialed
  const base = {
    'call-id': rtpCallId,
    ICE: 'remove', DTLS: 'off', SDES: 'off',
    'transport-protocol': 'RTP/AVP', 'rtcp-mux': ['demux'],
    flags: ['trust-address', 'strict-source'],
  };
  // Seed offer for leg 1 — a placeholder standing in for the not-yet-dialed
  // leg 2. rtpengine rewrites it into leg 1's INVITE SDP, offering the ladder.
  const seed =
    `v=0\r\no=- ${Date.now()} 1 IN IP4 ${PUBLIC_IP}\r\ns=conf\r\n` +
    `c=IN IP4 ${PUBLIC_IP}\r\nt=0 0\r\n` +
    `m=audio 40000 RTP/AVP 96 97 98 8 0 101\r\n` +
    `a=rtpmap:96 EVS/16000\r\na=rtpmap:97 AMR-WB/16000\r\na=rtpmap:98 AMR/8000\r\n` +
    `a=rtpmap:8 PCMA/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n` +
    `a=sendrecv\r\na=ptime:20\r\n`;
  return {
    rtpCallId, tag1, tag2,
    // SDP for leg 1's INVITE.
    async offerLeg1() {
      const r = await rtpNg({ ...base, command: 'offer', 'from-tag': tag2,
        sdp: seed, replace: ['origin', 'session-connection'] });
      if (r?.result !== 'ok') throw new Error(`bridge offer leg1: ${r?.['error-reason'] || JSON.stringify(r).slice(0, 160)}`);
      return r.sdp;
    },
    // Leg 1 answered → SDP for leg 2's INVITE (narrowed to leg 1's codec).
    async answerLeg1(ansSdp) {
      const r = await rtpNg({ ...base, command: 'answer', 'from-tag': tag2,
        'to-tag': tag1, sdp: ansSdp });
      if (r?.result !== 'ok') throw new Error(`bridge answer leg1: ${r?.['error-reason'] || JSON.stringify(r).slice(0, 160)}`);
      return r.sdp;
    },
    // Leg 2 answered → re-register leg 2 with its real media. Returns the
    // (possibly updated) leg-1-facing SDP; leg 1 is re-INVITEd only if it changed.
    async offerLeg2(ansSdp) {
      const r = await rtpNg({ ...base, command: 'offer', 'from-tag': tag2,
        sdp: ansSdp, replace: ['origin', 'session-connection'] });
      if (r?.result !== 'ok') throw new Error(`bridge offer leg2: ${r?.['error-reason'] || JSON.stringify(r).slice(0, 160)}`);
      return r.sdp;
    },
    del() { rtpNg({ command: 'delete', 'call-id': rtpCallId }).catch(() => {}); },
  };
}

// Sorted lower-cased codec list of an SDP's audio rtpmaps — used to tell
// whether two bridged legs converged on the same codec (else re-INVITE leg 1).
function audioCodecSet(sdp) {
  return (String(sdp || '').match(/^a=rtpmap:\d+ [^\/\r\n]+/gm) || [])
    .map(l => l.replace(/^a=rtpmap:\d+ /, '').toLowerCase()).sort().join(',');
}

// Fork one bridged leg's media to a local socket for Deepgram transcription.
// rtpengine transcodes the leg's codec → PCMU for the fork (off the call path).
async function startConfTap(bridge, legTag, dg) {
  const sreq = await rtpNg({
    command: 'subscribe request', 'call-id': bridge.rtpCallId, 'from-tag': legTag,
    ICE: 'remove', DTLS: 'off', SDES: 'off',
    'transport-protocol': 'RTP/AVP', 'rtcp-mux': ['demux'],
    codec: { transcode: ['PCMU'] },
  });
  if (sreq?.result !== 'ok') throw new Error(`subscribe request: ${sreq?.['error-reason'] || '?'}`);
  const subTag = sreq['to-tag'];
  const { socket, port } = await allocRtpSocket();
  const tapSdp =
    `v=0\r\no=- ${Date.now()} 1 IN IP4 127.0.0.1\r\ns=tap\r\n` +
    `c=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
    `m=audio ${port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=recvonly\r\na=ptime:20\r\n`;
  const sans = await rtpNg({
    command: 'subscribe answer', 'call-id': bridge.rtpCallId, 'to-tag': subTag,
    sdp: tapSdp, ICE: 'remove', DTLS: 'off', SDES: 'off',
    'transport-protocol': 'RTP/AVP', 'rtcp-mux': ['demux'], flags: ['allow transcoding'],
  });
  if (sans?.result !== 'ok') {
    try { socket.close(); } catch {}
    throw new Error(`subscribe answer: ${sans?.['error-reason'] || '?'}`);
  }
  const rsUp = await makeResampler(8000, 16000);   // PCMU 8k → Deepgram 16k
  socket.on('message', (pkt) => {
    if (pkt.length < 12 || (pkt[1] & 0x7f) !== 0) return;   // PCMU payload type 0 only
    dg?.send(rsUp.process(CODEC_PCMU.decodePayload(rtpPayload(pkt))));
  });
  socket.on('error', () => {});
  return { close() { try { socket.close(); } catch {} try { rsUp.destroy(); } catch {} } };
}

// Dial one leg of a bridged phone↔phone conference into the shared rtpengine
// bridge. Staff is dialed first (leg 1, free codec choice); customer second
// (leg 2, offered only the staff leg's codec → both converge → passthrough).
async function dialBridgedConfLeg(callId, role) {
  const pc = pendingConferences.get(callId);
  if (!pc || pc.started) return;
  postCallState(callId, 'ringing', { leg: role });
  const number = role === 'staff' ? pc.staffNumber : pc.customerNumber;
  const toDigits = normalizeToE164Digits(number);  // E.164 — waId / label
  const dialNum  = toCarrierNumber(number);         // national — SIP RURI (carrier format)
  if (!toDigits || !dialNum) return failConfLeg(callId, role, 'failed');

  let inviteSdp;
  try {
    inviteSdp = role === 'staff' ? await pc.bridge.offerLeg1() : pc.leg2Sdp;
  } catch (e) {
    console.error(`[${callId}] bridged-conf ${role} rtpengine offer failed: ${e?.message || e}`);
    return failConfLeg(callId, role, 'failed');
  }
  if (!inviteSdp) return failConfLeg(callId, role, 'failed');

  const uacOpts = {
    localSdp: inviteSdp,
    headers: { From: `<sip:${SIP_USER || CLI || dialNum}@${SIP_DOMAIN || PUBLIC_IP}>` },
  };
  if (SIP_USER) uacOpts.auth = { username: SIP_USER, password: SIP_PASSWORD };
  console.log(`[${callId}] bridged-conf ${role} INVITE → sip:${dialNum}@${SIP_DOMAIN}`);
  let dialog;
  try {
    dialog = await srf.createUAC(`sip:${dialNum}@${SIP_DOMAIN}`, uacOpts);
  } catch (e) {
    console.error(`[${callId}] bridged-conf ${role} dial failed: ${e?.status || e?.message || e}`);
    return failConfLeg(callId, role, dialReason(e));
  }

  try {
    if (role === 'staff') {
      pc.leg2Sdp = await pc.bridge.answerLeg1(dialog.remote.sdp);
      pc.staffCodecs = audioCodecSet(dialog.remote.sdp);
    } else {
      const updated = await pc.bridge.offerLeg2(dialog.remote.sdp);
      // If the customer landed on a different codec than the staff leg, the
      // staff leg is re-INVITEd so both converge — keeps the bridge passthrough.
      if (pc.staffLeg?.dialog && audioCodecSet(updated) !== pc.staffCodecs) {
        console.log(`[${callId}] bridged-conf legs differ — re-INVITE staff to converge`);
        try { await pc.staffLeg.dialog.modify(updated); }
        catch (e) { console.warn(`[${callId}] staff re-INVITE failed: ${e?.message || e}`); }
      }
    }
  } catch (e) {
    console.error(`[${callId}] bridged-conf ${role} rtpengine bridge failed: ${e?.message || e}`);
    try { await dialog.destroy(); } catch {}
    return failConfLeg(callId, role, 'failed');
  }

  confLegArrived(callId, role, {
    dialog, toDigits, role,
    tag: role === 'staff' ? pc.bridge.tag1 : pc.bridge.tag2,
  });
}

// Run a phone↔phone conference whose two legs are bridged inside rtpengine.
// The agent only runs transcription (Deepgram) + bookkeeping — no media mixer.
async function runBridgedConference({ callId, customerWaId, customerLeg, staffLeg, staffName = null, bridge }) {
  console.log(`[${callId}] bridged conference start — staff ${staffName || staffLeg.toDigits} + customer ${customerLeg.toDigits} (rtpengine passthrough)`);
  const _startMs = Date.now();
  const meta = {
    waId: customerWaId || customerLeg.toDigits, callerName: null, staffName: staffName || null,
    channel: 'pstn', callId, direction: 'outbound', status: 'COMPLETED', endReason: null,
    startedAt: new Date().toISOString(), endedAt: null, durationSec: 0,
    transcript: [], toolCalls: [],
  };
  let confTurnIndex = 0;
  function postConfTurn(role, text) {
    const t = String(text || '').trim();
    if (!t) return;
    const ts = new Date().toISOString();
    meta.transcript.push({ role, text: t, ts });
    postVoiceTurn({
      callId, waId: meta.waId, callerName: null, channel: 'pstn',
      turnIndex: confTurnIndex++, role, text: t, ts,
      staffName: role === 'staff' ? meta.staffName : null,
    });
  }

  // Deepgram live transcription — one stream per leg for exact attribution.
  customerLeg.dg = DEEPGRAM_TOKEN
    ? startDeepgramStreamAuto({ callId, role: 'customer',
        onTurn: (t) => { console.log(`[${callId}] customer: ${t}`); postConfTurn('user', t); } })
    : null;
  staffLeg.dg = DEEPGRAM_TOKEN
    ? startDeepgramStreamAuto({ callId, role: 'staff',
        onTurn: (t) => { console.log(`[${callId}] staff: ${t}`); postConfTurn('staff', t); } })
    : null;
  if (!DEEPGRAM_TOKEN) console.warn(`[${callId}] DEEPGRAM_TOKEN not set — conference runs without live transcription`);

  // Transcription side-taps — rtpengine forks each leg's audio to us as PCMU.
  // Non-fatal: a tap failure just means that leg isn't transcribed.
  let custTap = null, staffTap = null;
  try { custTap  = await startConfTap(bridge, bridge.tag2, customerLeg.dg); }
  catch (e) { console.error(`[${callId}] customer transcription tap failed: ${e?.message || e}`); }
  try { staffTap = await startConfTap(bridge, bridge.tag1, staffLeg.dg); }
  catch (e) { console.error(`[${callId}] staff transcription tap failed: ${e?.message || e}`); }

  let terminated = false;
  let terminatedReason = null;
  function terminate() {
    if (terminated) return;
    terminated = true;
    try { customerLeg.dg?.close(); } catch {}
    try { staffLeg.dg?.close(); } catch {}
    try { custTap?.close(); } catch {}
    try { staffTap?.close(); } catch {}
    for (const leg of [customerLeg, staffLeg]) {
      if (!leg._ended) { try { leg.dialog?.destroy(); } catch {} }
    }
    bridge.del();
    sessions.delete(callId);
    endedSessions.set(callId, { ended_at: Math.floor(Date.now() / 1000) });
    setTimeout(() => endedSessions.delete(callId), ENDED_SESSION_TTL_MS).unref();
    meta.endedAt = new Date().toISOString();
    meta.durationSec = Math.max(0, Math.round((Date.now() - _startMs) / 1000));
    meta.endReason = terminatedReason || 'COMPLETED';
    postVoiceSummary(meta).catch((e) => console.error(`[${callId}] conf summary post failed`, e?.message || e));
    postCallState(callId, 'ended', { reason: meta.endReason, durationSec: meta.durationSec });
    console.log(`[${callId}] bridged conference ended — ${meta.durationSec}s, ${meta.transcript.length} turns`);
  }
  // Either party hanging up ends the conference (both legs have a SIP dialog).
  customerLeg.dialog?.on('destroy', () => { customerLeg._ended = true; terminatedReason ||= 'customer hung up'; terminate(); });
  staffLeg.dialog?.on('destroy',    () => { staffLeg._ended = true;    terminatedReason ||= 'staff hung up';    terminate(); });

  function getStatus() {
    return {
      call_id: callId, active: !terminated, kind: 'conference',
      started_at: Math.floor(_startMs / 1000), duration_ms: Date.now() - _startMs,
    };
  }
  // Aria is not present on a bridged conference — accept the control as a no-op.
  function controlAria() { return { aria_muted: true }; }

  sessions.set(callId, { terminate, getStatus, controlAria });
  return { terminate };
}

// A 20ms mixer bridges the two human legs; each leg streams to Deepgram for
// live transcription. (Gemini "Aria" is disabled for outbound — see below.)
async function runConferenceSession({ callId, customerWaId, customerLeg, staffLeg, staffName = null, customerChannel = 'pstn' }) {
  console.log(`[${callId}] conference start — staff ${staffName || staffLeg.toDigits} + customer ${customerLeg.toDigits} (${customerChannel}) + Deepgram STT`);
  const _startMs = Date.now();
  // The staff leg is always the browser softphone; the customer leg is either
  // a PSTN call or a WhatsApp (WABA) call. Summary + turn rows are tagged with
  // the customer channel so the chat timeline labels the call correctly.
  const confChannel = customerChannel === 'waba' ? 'waba' : 'pstn';
  const meta = {
    waId: customerWaId || customerLeg.toDigits, callerName: null, staffName: staffName || null,
    channel: confChannel, callId,
    direction: 'outbound', status: 'COMPLETED', endReason: null,
    startedAt: new Date().toISOString(), endedAt: null, durationSec: 0,
    transcript: [], toolCalls: [],
  };

  // Live per-turn streaming for the conference, mirroring the 1:1 path so the
  // support UI sees customer / staff / Aria turns appear in realtime instead
  // of all landing at once via the end-of-call /summary backfill.
  let confTurnIndex = 0;
  function postConfTurn(role, text) {
    const t = String(text || '').trim();
    if (!t) return;
    const ts = new Date().toISOString();
    meta.transcript.push({ role, text: t, ts });
    postVoiceTurn({
      callId, waId: meta.waId, callerName: null, channel: confChannel,
      turnIndex: confTurnIndex++, role, text: t, ts,
      staffName: role === 'staff' ? meta.staffName : null,
    });
  }

  // The native-audio model streams inputTranscription as incremental deltas
  // (one per syllable/word), not one message per utterance. Accumulate and
  // flush as a single turn on a silence debounce / speaker change / call end —
  // otherwise every fragment lands as its own chat bubble.
  let inBuf = '';
  let inWho = null;
  let inFlushTimer = null;
  function flushInputTurn() {
    if (inFlushTimer) { clearTimeout(inFlushTimer); inFlushTimer = null; }
    const t = inBuf.trim();
    const who = inWho;
    inBuf = ''; inWho = null;
    if (t && who) postConfTurn(who === 'customer' ? 'user' : 'staff', t);
  }

  // Per-leg media state. inbox = inbound audio resampled to 16k awaiting the
  // mixer; outQueue = outbound audio at codec rate awaiting RTP framing.
  for (const leg of [customerLeg, staffLeg]) {
    leg.rsUp   = leg.codec.rate === 16000 ? null : await makeResampler(leg.codec.rate, 16000);
    leg.rsDown = leg.codec.rate === 16000 ? null : await makeResampler(16000, leg.codec.rate);
    leg.inbox = new Int16Array(0);
    leg.outQueue = new Int16Array(0);
    leg.ssrc = (Math.random() * 0xffffffff) >>> 0;
    leg.seq  = (Math.random() * 0xffff) & 0xffff;
    leg.ts   = (Math.random() * 0xffffffff) >>> 0;
    leg.lastVoiceAt = 0;
    leg.lastRtpAt = Date.now();   // media-watchdog grace start
    leg.jbReady = false;     // playout jitter-buffer primed flag
  }

  // Deepgram live transcription — one realtime stream per human leg, so
  // speaker attribution is exact. customer → 'user' turn, staff → 'staff'.
  customerLeg.dg = DEEPGRAM_TOKEN
    ? startDeepgramStreamAuto({ callId, role: 'customer',
        onTurn: (t) => { console.log(`[${callId}] customer: ${t}`); postConfTurn('user', t); } })
    : null;
  staffLeg.dg = DEEPGRAM_TOKEN
    ? startDeepgramStreamAuto({ callId, role: 'staff',
        onTurn: (t) => { console.log(`[${callId}] staff: ${t}`); postConfTurn('staff', t); } })
    : null;
  if (!DEEPGRAM_TOKEN) console.warn(`[${callId}] DEEPGRAM_TOKEN not set — conference runs without live transcription`);

  const ariaRsDown = await makeResampler(24000, 16000); // Aria's 24k output → 16k bus
  let ariaOut16 = new Int16Array(0);
  let ariaMuted = false;                                // staff override; default off
  let ariaSpeechBuf = '';
  let session = null;

  // Inbound RTP for a leg → decode → VAD → resample to 16k → append to inbox.
  function attachInbound(leg) {
    leg.rtp.on('message', (pkt) => {
      if (pkt.length < 12) return;
      leg.lastRtpAt = Date.now();                         // media watchdog
      if (DBG_MEDIA) leg._rtpPkts = (leg._rtpPkts || 0) + 1;
      if ((pkt[1] & 0x7f) !== leg.codec.pt) {             // only the negotiated codec
        if (DBG_MEDIA) { leg._ptDrop = (leg._ptDrop || 0) + 1; leg._lastPt = pkt[1] & 0x7f; }
        return;
      }
      const pcm = leg.codec.decodePayload(rtpPayload(pkt));
      let sumSq = 0;
      for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
      const _rms = Math.sqrt(sumSq / pcm.length);
      if (_rms > VAD_RMS) leg.lastVoiceAt = Date.now();
      if (DBG_MEDIA) { leg._inPkts = (leg._inPkts || 0) + 1; if (_rms > (leg._inPeak || 0)) leg._inPeak = _rms; }
      const pcm16 = leg.rsUp ? leg.rsUp.process(pcm) : pcm;
      leg.dg?.send(pcm16);                                  // → Deepgram live STT
      let merged = new Int16Array(leg.inbox.length + pcm16.length);
      merged.set(leg.inbox); merged.set(pcm16, leg.inbox.length);
      if (merged.length > 16000) merged = merged.slice(merged.length - 16000); // cap ~1s jitter
      leg.inbox = merged;
    });
  }

  // Take one 20ms frame (320 @16k) off a buffer; returns [frame(320), rest].
  function take320(buf) {
    const FR = 320;
    if (buf.length >= FR) return [buf.slice(0, FR), buf.subarray(FR)];
    const f = new Int16Array(FR); f.set(buf);
    return [f, new Int16Array(0)];
  }

  // Per-leg playout jitter buffer with clock-drift compensation.
  //
  // The mixer drains 20ms/tick paced on the VPS wall clock. Inbound RTP
  // arrives bursty — the staff (browser→rtpengine) leg especially swings
  // ±8% in packet rate. So we hold JB_TARGET of audio before playout begins.
  //
  // Two failure modes this must survive:
  //  - jitter (transient under-supply): conceal a SINGLE 20ms frame and keep
  //    playing — never full re-prime, which would turn one blip into a
  //    JB_TARGET-long dropout.
  //  - clock drift (the far-end clock runs slow/fast vs the VPS clock):
  //    fast → buffer grows → trim a few ms across a silent frame, or hard
  //    trim past JB_MAX; slow → buffer shrinks → the single-frame conceal
  //    above absorbs it. Trim only kicks in well ABOVE target (JB_TRIM_HIGH)
  //    so the buffer keeps a working range and isn't pinned at the edge.
  const JB_TARGET = 2560;        // 160ms — playout target / prime depth
  const JB_TRIM_HIGH = 5760;     // 360ms — trim drift only above this (headroom)
  const JB_TRIM = 64;            // 4ms trimmed per silent tick to absorb drift
  const JB_SILENCE = 250;        // RMS below this → frame is silence (safe to trim across)
  const JB_MAX = 9600;           // 600ms hard ceiling — trim even mid-speech beyond this
  const SILENT320 = new Int16Array(320);
  function takeJB(leg) {
    const FR = 320;
    if (!leg.jbReady) {
      if (leg.inbox.length < JB_TARGET) return SILENT320;   // initial priming only
      leg.jbReady = true;
    }
    if (leg.inbox.length < FR) {
      // Transient underrun — conceal one frame, stay primed. No re-prime:
      // the buffer refills on its own as packets arrive.
      if (DBG_MEDIA) leg._jbUnder = (leg._jbUnder || 0) + 1;
      return SILENT320;
    }
    const f = leg.inbox.slice(0, FR);
    leg.inbox = leg.inbox.subarray(FR);
    // Drift compensation — pull the buffer back toward JB_TARGET, but only
    // once it has drifted well above target so jitter has room to breathe.
    const depth = leg.inbox.length;
    if (depth > JB_MAX) {
      leg.inbox = leg.inbox.subarray(depth - JB_TARGET);    // hard trim
      if (DBG_MEDIA) leg._jbTrim = (leg._jbTrim || 0) + 1;
    } else if (depth > JB_TRIM_HIGH) {
      let ss = 0;
      for (let i = 0; i < FR; i++) ss += f[i] * f[i];
      if (Math.sqrt(ss / FR) < JB_SILENCE) {                // silent frame → trim is inaudible
        leg.inbox = leg.inbox.subarray(Math.min(JB_TRIM, depth - JB_TARGET));
        if (DBG_MEDIA) leg._jbTrim = (leg._jbTrim || 0) + 1;
      }
    }
    return f;
  }
  // a + b (both 320), clamped to Int16. b may be null → returns a unchanged.
  function mix(a, b) {
    if (!b) return a;
    const out = new Int16Array(320);
    for (let i = 0; i < 320; i++) {
      const v = a[i] + b[i];
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return out;
  }
  // Resample a 320 @16k frame to the leg's codec rate, append to its outQueue.
  function pushOut(leg, pcm16) {
    const at = leg.rsDown ? leg.rsDown.process(pcm16) : pcm16;
    const merged = new Int16Array(leg.outQueue.length + at.length);
    merged.set(leg.outQueue); merged.set(at, leg.outQueue.length);
    leg.outQueue = merged;
  }
  // Emit whole RTP frames from a leg's outQueue.
  function flushRtp(leg) {
    const FR = leg.codec.frameSamples;
    while (leg.outQueue.length >= FR) {
      const frame = leg.outQueue.slice(0, FR);
      leg.outQueue = leg.outQueue.subarray(FR);
      if (DBG_MEDIA) {
        let _oss = 0;
        for (let i = 0; i < frame.length; i++) _oss += frame[i] * frame[i];
        const _orms = Math.sqrt(_oss / frame.length);
        if (_orms > (leg._outPeak || 0)) leg._outPeak = _orms;
        leg._outPkts = (leg._outPkts || 0) + 1;
      }
      const pkt = buildRtpPacket({
        seq: leg.seq, ts: leg.ts, ssrc: leg.ssrc,
        payload: leg.codec.encodeFrame(frame), payloadType: leg.codec.pt,
      });
      try { leg.rtp.send(pkt, leg.remotePort, leg.remoteHost); } catch {}
      leg.seq = (leg.seq + 1) & 0xffff;
      // G.722 carries a 8 kHz RTP timestamp clock despite 16 kHz audio
      // (RFC 3551 quirk) — codecs expose rtpTsIncr; others step by frame.
      leg.ts = (leg.ts + (leg.codec.rtpTsIncr || FR)) >>> 0;
    }
  }
  // Batch (customer+staff) mix and stream it to Aria in 40ms chunks.
  let ariaInAccum = [];
  function feedAria(frame16) {
    ariaInAccum.push(frame16);
    if (ariaInAccum.length < 2) return;
    const merged = new Int16Array(ariaInAccum.length * 320);
    ariaInAccum.forEach((f, i) => merged.set(f, i * 320));
    ariaInAccum = [];
    const b = Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength);
    try { session?.sendRealtimeInput({ audio: { data: b.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }); }
    catch {}
  }

  // 20ms drift-corrected mixer tick — bridges the humans and feeds Aria.
  let mixerStopped = false;
  let mixerTimer = null;
  let nextTickAt = Date.now();
  let dbgTick = 0;   // media-path instrumentation accumulator (DBG_MEDIA)
  function tick() {
    if (mixerStopped) return;
    const now = Date.now();
    let n = 0;
    while (nextTickAt <= now && n < 8) {
      let ariaIn;
      const custIn  = takeJB(customerLeg);   // jitter-buffered playout
      const staffIn = takeJB(staffLeg);
      [ariaIn, ariaOut16]      = ariaOut16.length ? take320(ariaOut16) : [null, ariaOut16];
      const sOut = ariaMuted ? null : ariaIn;
      pushOut(customerLeg, mix(staffIn, sOut));   // customer hears staff (+Aria)
      pushOut(staffLeg,    mix(custIn,  sOut));    // staff hears customer (+Aria)
      flushRtp(customerLeg);
      flushRtp(staffLeg);
      // feedAria(mix(custIn, staffIn));         // disabled — Aria off for outbound (Deepgram STT instead)
      nextTickAt += 20;
      n++;
    }
    if (DBG_MEDIA && (dbgTick += n) >= 100) {
      dbgTick = 0;
      for (const [nm, lg] of [['cust', customerLeg], ['staff', staffLeg]]) {
        console.log(`[${callId}] DBG ${nm} codec=${lg.codec.name} rtpPkts=${lg._rtpPkts || 0} ptDrop=${lg._ptDrop || 0} inPkts=${lg._inPkts || 0} inPeak=${Math.round(lg._inPeak || 0)} outPkts=${lg._outPkts || 0} outPeak=${Math.round(lg._outPeak || 0)} jbUnder=${lg._jbUnder || 0} jbTrim=${lg._jbTrim || 0} jbMs=${Math.round(lg.inbox.length / 16)}`);
        lg._rtpPkts = 0; lg._ptDrop = 0; lg._inPkts = 0; lg._inPeak = 0; lg._outPkts = 0; lg._outPeak = 0; lg._jbUnder = 0; lg._jbTrim = 0;
      }
    }
    mixerTimer = setTimeout(tick, Math.max(1, nextTickAt - Date.now()));
  }
  attachInbound(customerLeg);
  attachInbound(staffLeg);
  tick(); // humans are bridged from here, even before Aria connects

  // Media watchdog — a WABA customer leg has no SIP dialog, so a WhatsApp-side
  // hangup is invisible to signalling; the only signal is RTP stopping. If
  // either leg receives no RTP for MEDIA_TIMEOUT_MS, end the conference so it
  // doesn't run forever as a zombie (there is no longer a hard duration cap).
  const MEDIA_TIMEOUT_MS = 12_000;
  const mediaWatchdog = setInterval(() => {
    if (terminated) return;
    const now = Date.now();
    for (const [nm, lg] of [['customer', customerLeg], ['staff', staffLeg]]) {
      if (now - (lg.lastRtpAt || _startMs) > MEDIA_TIMEOUT_MS) {
        console.warn(`[${callId}] ${nm} leg media timeout (no RTP for ${MEDIA_TIMEOUT_MS}ms) — ending conference`);
        lg._ended = true;
        terminatedReason ||= `${nm} media timeout`;
        terminate();
        return;
      }
    }
  }, 2000);
  mediaWatchdog.unref?.();

  /* ═══════════════════════════════════════════════════════════════════════
   *  DISABLED for outbound calls — the Gemini "Aria" co-listener.
   *  Outbound calls now run as a plain staff↔customer bridge with Deepgram
   *  live transcription (startDeepgramStream + leg.dg, above). The native-
   *  audio Aria below is preserved, commented, for reference / future
   *  re-enablement — restoring it also means re-adding the mix-minus of
   *  sOut into tick() and the feedAria() call.
   * ═══════════════════════════════════════════════════════════════════════
  // Load the per-caller knowledge base + tools so the assistant can fact-check
  // and answer lookups — the same config the inbound 1:1 agent uses. Fetched
  // after the humans are bridged, so it never delays the call.
  const confCfg = await fetchVoiceConfig(meta.waId);
  if (confCfg) console.log(`[${callId}] conf config loaded waId=${meta.waId} tools=${confCfg.tools?.length ?? 0}`);
  else console.log(`[${callId}] conf no config (waId=${meta.waId}) — assistant runs prompt-only, no tools`);

  // ── Co-listener assistant: Gemini Live, native-audio + Proactive Audio ──
  const GEMINI_LANG = confCfg?.locale?.languageCode || process.env.GEMINI_LANGUAGE_CODE || 'en-US';
  const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Aria';
  const nowStr = new Date().toLocaleString('en-US', {
    timeZone: process.env.AGENT_TIMEZONE || 'UTC', weekday: 'long', day: 'numeric',
    month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const ariaPrompt =
    `You are ${ASSISTANT_NAME}, an AI assistant silently co-listening on a live ` +
    `phone call between a STAFF MEMBER and a CUSTOMER. You hear the mixed audio ` +
    `of the two of them talking to EACH OTHER — almost nothing you hear is ` +
    `addressed to you.\n\n` +
    `Your default behaviour is to LISTEN SILENTLY and say nothing. Do not greet, do not ` +
    `acknowledge, do not back-channel, do not chime in on ordinary conversation.\n\n` +
    `Speak ONLY in these cases:\n` +
    `1. Someone explicitly addresses you by name — "${ASSISTANT_NAME}" — and asks you something.\n` +
    `2. You hear a clear FACTUAL ERROR that will mislead the customer (a wrong price, ` +
    `wrong product, wrong hours, wrong policy) — briefly correct it.\n` +
    `3. An important question was clearly missed and the call is about to move past it ` +
    `— briefly raise it.\n` +
    `In every other case, produce NO output at all. When in doubt, stay silent.\n\n` +
    `When you do speak: keep it to one or two short sentences, calm and polite, ` +
    `addressing the room naturally — then return to silent listening.\n\n` +
    `Current time: ${nowStr}.` +
    (confCfg?.systemPrompt
      ? `\n\n--- REFERENCE: knowledge base ---\n` +
        `Use the facts and tools below ONLY to fact-check or to answer a ` +
        `question put to you directly. The silence rules above OVERRIDE ` +
        `anything here — in particular, ignore any instruction to greet, ` +
        `lead, or drive the conversation; you are the silent third ` +
        `participant, not the one running this call.\n\n${confCfg.systemPrompt}`
      : '');

  try {
    session = await aiAlpha.live.connect({
      model: GEMINI_CONFERENCE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        proactivity: { proactiveAudio: true },        // co-listen; speak only when relevant
        speechConfig: {
          // The native-audio model rejects an explicit languageCode (e.g. en-US)
          // and is multilingual anyway — the system prompt steers Aria to Hebrew.
          voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || 'Aoede' } },
        },
        inputAudioTranscription:  {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
            endOfSpeechSensitivity:   'END_SENSITIVITY_HIGH',
            prefixPaddingMs:  300,
            silenceDurationMs: 600,
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        },
        sessionResumption: { handle: null },
        contextWindowCompression: { slidingWindow: {} },
        systemInstruction: { parts: [{ text: ariaPrompt }] },
        ...(confCfg?.tools?.length
          ? { tools: [{ functionDeclarations: confCfg.tools }] }
          : {}),
      },
      callbacks: {
        onopen: () => console.log(`[${callId}] conf gemini open`),
        onmessage: (msg) => {
          // Gemini requested a tool — execute each and respond.
          // No `end_call` here: the staff member owns this call, not the assistant.
          if (msg?.toolCall?.functionCalls?.length) {
            const calls = msg.toolCall.functionCalls;
            console.log(`[${callId}] conf tools requested: ${calls.map((c) => c.name).join(', ')}`);
            Promise.all(calls.map(async (fc) => {
              const tsIso = new Date().toISOString();
              const result = await execToolRemote(callId, meta.waId, confCfg?.conversationId, fc.name, fc.args || {});
              console.log(`[${callId}]   ${fc.name} → ${String(result).slice(0, 120)}`);
              meta.toolCalls.push({ name: fc.name, args: fc.args || {}, result: String(result), ts: tsIso });
              return { id: fc.id, name: fc.name, response: { result } };
            })).then((functionResponses) => {
              try { session?.sendToolResponse({ functionResponses }); }
              catch (e) { console.error(`[${callId}] conf sendToolResponse failed`, e?.message || e); }
            });
            return;
          }
          // Aria's transcription of the humans — attributed to whichever leg
          // had voice most recently (best-effort on mixed audio). Deltas are
          // accumulated by flushInputTurn so one utterance = one chat turn.
          if (msg?.serverContent?.inputTranscription?.text) {
            const who = customerLeg.lastVoiceAt >= staffLeg.lastVoiceAt ? 'customer' : 'staff';
            if (inWho && who !== inWho) flushInputTurn();   // speaker changed → close the prior turn
            inWho = who;
            inBuf += msg.serverContent.inputTranscription.text;
            if (inFlushTimer) clearTimeout(inFlushTimer);
            inFlushTimer = setTimeout(flushInputTurn, 1200);
          }
          if (msg?.serverContent?.outputTranscription?.text) {
            ariaSpeechBuf += msg.serverContent.outputTranscription.text;
          }
          // Aria's audio — only arrives when Proactive Audio decides she speaks.
          for (const p of (msg?.serverContent?.modelTurn?.parts || [])) {
            const data = p.inlineData?.data;
            if (!data || ariaMuted) continue;
            const buf = Buffer.from(data, 'base64');
            const pcm24 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
            const pcm16 = ariaRsDown.process(pcm24);
            let merged = new Int16Array(ariaOut16.length + pcm16.length);
            merged.set(ariaOut16); merged.set(pcm16, ariaOut16.length);
            // Aria's play-out queue: the Live API streams her audio FASTER
            // than realtime, while the 20ms mixer drains it at realtime — so
            // this buffer is meant to hold a whole utterance (several seconds).
            // Capping at ~1s (as the inbound jitter buffers do) silently
            // discarded the middle of her speech → very choppy. Cap generously
            // (~30s) only as a runaway safety net; `interrupted` clears it.
            if (merged.length > 480000) merged = merged.subarray(merged.length - 480000);
            ariaOut16 = merged;
          }
          if (msg?.serverContent?.interrupted) ariaOut16 = new Int16Array(0);
          if (msg?.serverContent?.turnComplete) {
            const s = ariaSpeechBuf.trim();
            ariaSpeechBuf = '';
            if (s) {
              postConfTurn('assistant', s);
              console.log(`[${callId}] Aria spoke: ${s}`);
            }
          }
        },
        onerror: (e) => console.error(`[${callId}] conf gemini error`, e?.message || e),
        onclose: (e) => console.log(`[${callId}] conf gemini closed`, e?.reason || ''),
      },
    });
    console.log(`[${callId}] Aria joined (${GEMINI_CONFERENCE_MODEL}, proactive)`);
  } catch (e) {
    // Aria failed to connect — the human↔human call still continues without her.
    console.error(`[${callId}] conf Aria connect failed — call continues without her: ${e?.message || e}`);
    session = null;
  }
   * ═══════════════════════════════════════════════════════════════════════ */

  // ── teardown ──
  let terminated = false;
  let terminatedReason = null;
  function terminate() {
    if (terminated) return;
    terminated = true;
    mixerStopped = true;
    flushInputTurn();   // emit any half-accumulated human turn before the summary
    if (mixerTimer) clearTimeout(mixerTimer);
    clearInterval(mediaWatchdog);
    // Close Deepgram first: close() flushes any buffered final turn into
    // meta.transcript before postVoiceSummary() runs below.
    try { customerLeg.dg?.close(); } catch {}
    try { staffLeg.dg?.close(); } catch {}
    for (const leg of [customerLeg, staffLeg]) {
      try { leg.rtp.close(); } catch {}
      // Only BYE a leg that hasn't already hung up — destroying a gone dialog
      // makes drachtio-srf throw an uncaught "unable to find dialog".
      if (!leg._ended) { try { leg.dialog?.destroy(); } catch {} }
      try { leg.cleanup?.(); } catch {}        // rtpengine session delete (WebRTC leg)
      try { leg.rsUp?.destroy(); } catch {}
      try { leg.rsDown?.destroy(); } catch {}
    }
    try { session?.close?.(); } catch {}
    try { ariaRsDown.destroy(); } catch {}
    sessions.delete(callId);
    endedSessions.set(callId, { ended_at: Math.floor(Date.now() / 1000) });
    setTimeout(() => endedSessions.delete(callId), ENDED_SESSION_TTL_MS).unref();
    meta.endedAt = new Date().toISOString();
    meta.durationSec = Math.max(0, Math.round((Date.now() - _startMs) / 1000));
    meta.endReason = terminatedReason || 'COMPLETED';
    postVoiceSummary(meta).catch((e) => console.error(`[${callId}] conf summary post failed`, e?.message || e));
    postCallState(callId, 'ended', { reason: meta.endReason, durationSec: meta.durationSec });
    console.log(`[${callId}] conference ended — ${meta.durationSec}s, ${meta.transcript.length} turns`);
  }
  // No hard duration cap on conferences — staff-led outbound calls run no
  // Gemini (Aria is disabled for outbound), so there is no runaway-cost
  // reason to time-limit them; the call ends when a human hangs up.
  // If either human hangs up, the conference is over. Mark the leg ended so
  // teardown won't BYE an already-gone dialog (→ drachtio "unable to find dialog").
  // The PSTN customer leg has a SIP dialog whose teardown ends the call. The
  // WABA customer leg has no dialog — Meta's terminate webhook reaches this
  // conference's terminate() via wa → /api/waba/terminate → /session/terminate.
  // Either leg may be a WhatsApp leg with no SIP dialog (in "Via my phone"
  // mode the staff leg can be WhatsApp too) — a hangup on such a leg is only
  // visible via the media watchdog, not a dialog 'destroy'.
  customerLeg.dialog?.on('destroy', () => { customerLeg._ended = true; terminatedReason ||= 'customer hung up'; terminate(); });
  staffLeg.dialog?.on('destroy',    () => { staffLeg._ended = true;    terminatedReason ||= 'staff hung up';    terminate(); });

  function getStatus() {
    return {
      call_id: callId, active: !terminated, kind: 'conference',
      started_at: Math.floor(_startMs / 1000), duration_ms: Date.now() - _startMs,
      aria_muted: ariaMuted, aria_connected: !!session,
    };
  }
  // Staff control over Aria: mute / unmute / ask (inject a prompt turn).
  function controlAria(action, text) {
    if (action === 'mute')   { ariaMuted = true; ariaOut16 = new Int16Array(0); }
    if (action === 'unmute') { ariaMuted = false; }
    if (action === 'ask') {
      ariaMuted = false;
      const q = String(text || '').trim();
      try {
        session?.sendRealtimeInput({ text: q
          ? `[The staff member is addressing you: ${q} — answer now, out loud and briefly.]`
          : `[The staff member is asking you to join the call now — give your view briefly.]` });
      } catch {}
    }
    console.log(`[${callId}] Aria control: ${action} (muted=${ariaMuted})`);
    return { aria_muted: ariaMuted };
  }

  sessions.set(callId, { terminate, getStatus, controlAria });
  return { terminate };
}

// dialReason maps a SIP failure status to a short call-state reason code.
function dialReason(e) {
  const st = e?.sipStatus;
  return st === 486 ? 'busy' : (st === 408 || st === 480) ? 'no_answer' : st === 603 ? 'declined' : 'failed';
}

// Ask the control app to place a WhatsApp leg of a conference — only it holds
// the Meta credentials. The leg connects asynchronously: once the callee
// accepts in WhatsApp, Meta's connect webhook flows back through
// webhook.js → /session/waba-conf-ready → confLegArrived().
async function requestWabaLeg(callId, role, waId) {
  if (!INTERNAL_VOICE_URL || !INTERNAL_VOICE_TOKEN) return { ok: false, reason: 'not_configured' };
  if (!waId) return { ok: false, reason: 'no_waid' };
  try {
    const r = await fetch(`${INTERNAL_VOICE_URL.replace(/\/$/, '')}/api/v1/voice/waba-leg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_VOICE_TOKEN}` },
      body: JSON.stringify({ callId, role, waId }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) return { ok: false, reason: j?.reason || `http_${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

// "Via my phone" conference: ring the staff member, then — once they answer —
// the customer, then bridge. Each leg is PSTN or WhatsApp, chosen per call.
// No browser leg. The pending-conference rendezvous (createPendingConference
// + dialConfLeg + confLegArrived + maybeStartConference) carries the async
// WhatsApp legs, which connect webhook-paced rather than inline.
function startPhoneConference({ callId, staffChannel, customerChannel, staffNumber, staffWaId, customerNumber, customerWaId, staffName = null }) {
  if (staffChannel === 'pstn' && !CLI) {
    console.warn(`[${callId}] CLI not set — the trunk may reject the call or rewrite the CLI`);
  }
  // Pure phone↔phone conferences are bridged inside rtpengine (passthrough, no
  // transcoding). Any WhatsApp leg falls back to the Node mixer path.
  const bridged = staffChannel === 'pstn' && customerChannel === 'pstn';
  createPendingConference({
    callId, mode: 'phone',
    channel: customerChannel,            // back-compat: the customer channel
    staffChannel, customerChannel,
    staffNumber: staffNumber || null, staffWaId: staffWaId || null,
    customerNumber: customerNumber || null, customerWaId: customerWaId || null,
    staffName: staffName || null,
    bridged, bridge: bridged ? createOutboundBridge(callId) : null,
  });
  dialConfLeg(callId, 'staff');
}

// Place one leg of a phone conference. PSTN legs resolve inline (the DIDWW
// INVITE answers); WhatsApp legs are placed by wa and arrive asynchronously.
async function dialConfLeg(callId, role) {
  const pc = pendingConferences.get(callId);
  if (!pc || pc.started) return;
  if (pc.bridged) return dialBridgedConfLeg(callId, role);
  const channel = role === 'staff' ? pc.staffChannel : pc.customerChannel;
  postCallState(callId, 'ringing', { leg: role });
  if (channel === 'waba') {
    const waId = role === 'staff' ? pc.staffWaId : pc.customerWaId;
    const r = await requestWabaLeg(callId, role, waId);
    if (!r.ok) {
      console.error(`[${callId}] phone-conf ${role} WhatsApp leg request failed: ${r.reason}`);
      failConfLeg(callId, role, r.reason === 'permission' ? 'permission' : 'failed');
    }
    return;   // the leg arrives async via /session/waba-conf-ready
  }
  const number = role === 'staff' ? pc.staffNumber : pc.customerNumber;
  let leg;
  try {
    leg = await dialPstnLeg(callId, number, role);
  } catch (e) {
    console.error(`[${callId}] phone-conf ${role} dial failed: ${e?.message || e}`);
    return failConfLeg(callId, role, dialReason(e));
  }
  confLegArrived(callId, role, leg);
}

// A conference leg connected. Park it on the pending entry; for a phone
// conference's staff leg this triggers the customer leg, and once both legs
// are in maybeStartConference() bridges.
function confLegArrived(callId, role, leg) {
  const pc = pendingConferences.get(callId);
  if (!pc || pc.started) {
    // Conference already gone (expired / failed) — drop the orphan leg.
    try { leg?.dialog?.destroy(); } catch {}
    try { leg?.rtp?.close(); } catch {}
    try { leg?.cleanup?.(); } catch {}
    return;
  }
  pc[role + 'Leg'] = leg;
  postCallState(callId, 'answered', { leg: role, customerWaId: pc.customerWaId });
  if (pc.mode === 'phone' && role === 'staff' && !pc.customerLeg) {
    dialConfLeg(callId, 'customer');
    return;
  }
  maybeStartConference(callId);
}

// Fail a still-pending conference: report the leg failure and tear down
// whichever leg did connect.
function failConfLeg(callId, role, reason) {
  const pc = pendingConferences.get(callId);
  if (!pc || pc.started) return;
  if (pc.gcTimer) clearTimeout(pc.gcTimer);
  pendingConferences.delete(callId);
  console.error(`[${callId}] phone-conf ${role} leg failed — ${reason}`);
  postCallState(callId, 'failed', { leg: role, reason });
  for (const lr of ['staff', 'customer']) {
    const l = pc[lr + 'Leg'];
    if (!l) continue;
    try { l.dialog?.destroy(); } catch {}
    try { l.rtp?.close(); } catch {}
    try { l.cleanup?.(); } catch {}
  }
  try { pc.bridge?.del(); } catch {}
}

// ── Browser softphone staff leg (SIP-over-WebSocket → rtpengine bridge) ──────
// The staff member's browser is a SIP UAC over WSS (SIP.js → Caddy /sip →
// drachtio). It INVITEs sip:conf-<callId>; rtpengine terminates the browser's
// WebRTC/DTLS-SRTP/Opus leg and hands us a plain RTP/AVP PCMU leg that the
// conference mixer consumes exactly like a PSTN leg.

// Conferences awaiting their browser staff leg. The callId is a 128-bit random
// token minted server-side and doubles as the join secret: only a client that
// authenticated to POST /v1/calls/conference learns it, and it is good for one
// INVITE inside a short window.
const pendingConferences = new Map(); // callId → { channel, customerNumber, customerWaId, staffName, claimed, started, staffLeg, customerLeg, gcTimer }
const PENDING_CONF_TTL_MS = 45_000;
// A WhatsApp customer leg can take far longer to connect than a PSTN dial:
// the customer's phone rings until they tap accept inside the WhatsApp UI.
const PENDING_WABA_CONF_TTL_MS = 150_000;

function createPendingConference(info) {
  const entry = {
    ...info, createdAt: Date.now(),
    claimed: false, started: false, staffLeg: null, customerLeg: null, gcTimer: null,
  };
  // Any WhatsApp leg can take far longer to connect than a PSTN dial — use the
  // long deadline if either the staff or the customer leg rings over WhatsApp.
  const anyWaba = info.channel === 'waba' || info.staffChannel === 'waba' || info.customerChannel === 'waba';
  const ttl = anyWaba ? PENDING_WABA_CONF_TTL_MS : PENDING_CONF_TTL_MS;
  entry.gcTimer = setTimeout(() => {
    if (pendingConferences.get(info.callId) !== entry || entry.started) return;
    pendingConferences.delete(info.callId);
    // Whichever leg never showed up is the one we report as failed. For a
    // plain (PSTN-customer) conference the browser staff leg is the only
    // async leg; for WABA either the staff browser or the WhatsApp customer.
    const missing = !entry.staffLeg ? 'staff' : 'customer';
    console.warn(`[${info.callId}] pending conference expired — ${missing} leg never connected`);
    try { entry.staffLeg?.dialog?.destroy(); } catch {}
    try { entry.staffLeg?.cleanup?.(); } catch {}
    try { entry.customerLeg?.rtp?.close(); } catch {}
    try { entry.customerLeg?.cleanup?.(); } catch {}
    try { entry.bridge?.del(); } catch {}
    postCallState(info.callId, 'failed', { leg: missing, reason: `${missing}_no_join` });
  }, ttl);
  entry.gcTimer.unref?.();
  pendingConferences.set(info.callId, entry);
}

// Both legs of a conference may arrive asynchronously and in either order
// (a browser staff INVITE, a PSTN dial answering, or a WhatsApp leg via
// webhook.js → /session/waba-conf-ready). Bridge as soon as both are in.
function maybeStartConference(callId) {
  const pc = pendingConferences.get(callId);
  if (!pc || pc.started) return;
  if (!pc.staffLeg || !pc.customerLeg) return;   // still waiting on a leg
  pc.started = true;
  if (pc.gcTimer) clearTimeout(pc.gcTimer);
  pendingConferences.delete(callId);
  console.log(`[${callId}] conference: both legs ready — bridging`);
  const run = pc.bridged
    ? runBridgedConference({
        callId, customerWaId: pc.customerWaId,
        staffLeg: pc.staffLeg, customerLeg: pc.customerLeg,
        staffName: pc.staffName, bridge: pc.bridge,
      })
    : runConferenceSession({
        callId, customerWaId: pc.customerWaId,
        staffLeg: pc.staffLeg, customerLeg: pc.customerLeg,
        staffName: pc.staffName,
        customerChannel: (pc.customerChannel || pc.channel) === 'waba' ? 'waba' : 'pstn',
      });
  run.catch((e) => {
    console.error(`[${callId}] conference bridge failed: ${e?.message || e}`);
    try { pc.staffLeg.dialog?.destroy(); } catch {}
    try { pc.staffLeg.rtp?.close(); } catch {}
    try { pc.staffLeg.cleanup?.(); } catch {}
    try { pc.customerLeg.dialog?.destroy(); } catch {}
    try { pc.customerLeg.rtp?.close(); } catch {}
    try { pc.customerLeg.cleanup?.(); } catch {}
    try { pc.bridge?.del(); } catch {}
    postCallState(callId, 'failed', { reason: 'bridge_failed' });
  });
}

// Hand a browser WebRTC offer to rtpengine; get back a plain-RTP leg plus the
// WebRTC answer SDP to return to the browser. Throws on any rtpengine failure.
async function bridgeWebrtcLeg({ callId, offerSdp, fromTag, toTag, wideband = false }) {
  // Browser's WebRTC offer → agent-facing plain RTP/AVP. rtpengine strips
  // ICE/DTLS/SRTP and transcodes the browser's Opus to the agent-facing codec:
  //   wideband=false → PCMU 8k — PSTN conferences (the customer leg is 8k
  //                    narrowband anyway, so matching the staff leg is free).
  //   wideband=true  → G.722 16k — WABA conferences, HD wideband end-to-end.
  const agentCodecs = wideband ? ['G722', 'telephone-event'] : ['PCMU', 'telephone-event'];
  const offerReply = await rtpNg({
    command: 'offer',
    'call-id': callId,
    'from-tag': fromTag,
    sdp: offerSdp,
    'ICE': 'remove',
    'DTLS': 'off',
    'SDES': 'off',
    'rtcp-mux': ['demux'],
    'transport-protocol': 'RTP/AVP',
    'replace': ['origin', 'session-connection'],
    'flags': ['trust-address', 'strict-source'],
    'codec': { mask: ['all'], offer: agentCodecs, transcode: agentCodecs },
  });
  if (offerReply?.result !== 'ok') {
    throw new Error(`rtpengine offer: ${offerReply?.['error-reason'] || JSON.stringify(offerReply).slice(0, 200)}`);
  }
  const { host: rtpengineHost, port: rtpenginePort } = parseAudioMedia(offerReply.sdp);
  if (!rtpengineHost || !rtpenginePort) throw new Error('could not parse rtpengine offer sdp');

  // Agent binds its RTP socket; its plain PCMU answer goes back through
  // rtpengine, which rebuilds the browser-facing answer (UDP/TLS/RTP/SAVPF +
  // ICE + DTLS fingerprint).
  const { socket: rtp, port: localPort } = await allocRtpSocket();
  const agentAnswer = wideband
    ? `v=0\r\no=- ${Date.now()} 1 IN IP4 127.0.0.1\r\ns=agent\r\n` +
      `c=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
      `m=audio ${localPort} RTP/AVP 9 101\r\n` +
      `a=rtpmap:9 G722/8000\r\n` +
      `a=rtpmap:101 telephone-event/8000\r\n` +
      `a=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n`
    : `v=0\r\no=- ${Date.now()} 1 IN IP4 127.0.0.1\r\ns=agent\r\n` +
      `c=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
      `m=audio ${localPort} RTP/AVP 0 101\r\n` +
      `a=rtpmap:0 PCMU/8000\r\n` +
      `a=rtpmap:101 telephone-event/8000\r\n` +
      `a=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n`;
  let answerReply;
  try {
    answerReply = await rtpNg({
      command: 'answer',
      'call-id': callId,
      'from-tag': fromTag,
      'to-tag': toTag,
      sdp: agentAnswer,
      'ICE': 'force',
      'DTLS': 'active',
      'SDES': 'off',
      'rtcp-mux': ['offer'],
      'transport-protocol': 'UDP/TLS/RTP/SAVPF',
      'flags': ['trust-address', 'strict-source', 'generate-mid'],
    });
  } catch (e) {
    try { rtp.close(); } catch {}
    throw e;
  }
  if (answerReply?.result !== 'ok') {
    try { rtp.close(); } catch {}
    throw new Error(`rtpengine answer: ${answerReply?.['error-reason'] || JSON.stringify(answerReply).slice(0, 200)}`);
  }

  return {
    rtp, localPort,
    remoteHost: rtpengineHost, remotePort: rtpenginePort,
    codec: wideband ? makeG722Codec(9) : { ...CODEC_PCMU },
    toDigits: 'browser',
    answerSdp: answerReply.sdp,
    // Conference teardown calls this in addition to closing the socket.
    cleanup: () => {
      try { rtp.close(); } catch {}
      rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    },
  };
}

// Hand a plain-RTP SIP caller's offer to rtpengine and get back a PCMU leg the
// agent can consume natively, plus the caller-facing answer SDP. Used as the
// fallback for inbound INVITEs whose offer carries no codec agent.js handles
// directly (AMR-NB, AMR-WB, G.729, …): rtpengine transcodes the caller's codec
// ↔ PCMU, so runCallSession stays on its well-tested narrowband path.
async function bridgePstnLeg({ callId, offerSdp, fromTag, toTag }) {
  const agentCodecs = ['PCMU', 'telephone-event'];
  const offerReply = await rtpNg({
    command: 'offer',
    'call-id': callId,
    'from-tag': fromTag,
    sdp: offerSdp,
    'ICE': 'remove',
    'DTLS': 'off',
    'SDES': 'off',
    'rtcp-mux': ['demux'],
    'transport-protocol': 'RTP/AVP',
    'replace': ['origin', 'session-connection'],
    'flags': ['trust-address', 'strict-source'],
    // mask all of the caller's codecs from the agent-facing offer and present
    // only PCMU — rtpengine then transcodes whatever the caller actually sends.
    'codec': { mask: ['all'], offer: agentCodecs, transcode: agentCodecs },
  });
  if (offerReply?.result !== 'ok') {
    throw new Error(`rtpengine offer: ${offerReply?.['error-reason'] || JSON.stringify(offerReply).slice(0, 200)}`);
  }
  const { host: rtpengineHost, port: rtpenginePort } = parseAudioMedia(offerReply.sdp);
  if (!rtpengineHost || !rtpenginePort) throw new Error('could not parse rtpengine offer sdp');

  const { socket: rtp, port: localPort } = await allocRtpSocket();
  const agentAnswer =
    `v=0\r\no=- ${Date.now()} 1 IN IP4 127.0.0.1\r\ns=agent\r\n` +
    `c=IN IP4 127.0.0.1\r\nt=0 0\r\n` +
    `m=audio ${localPort} RTP/AVP 0 101\r\n` +
    `a=rtpmap:0 PCMU/8000\r\n` +
    `a=rtpmap:101 telephone-event/8000\r\n` +
    `a=fmtp:101 0-16\r\na=sendrecv\r\na=ptime:20\r\n`;
  let answerReply;
  try {
    answerReply = await rtpNg({
      command: 'answer',
      'call-id': callId,
      'from-tag': fromTag,
      'to-tag': toTag,
      sdp: agentAnswer,
      'ICE': 'remove',
      'DTLS': 'off',
      'SDES': 'off',
      'rtcp-mux': ['demux'],
      'transport-protocol': 'RTP/AVP',
      'flags': ['trust-address', 'strict-source'],
    });
  } catch (e) {
    try { rtp.close(); } catch {}
    throw e;
  }
  if (answerReply?.result !== 'ok') {
    try { rtp.close(); } catch {}
    throw new Error(`rtpengine answer: ${answerReply?.['error-reason'] || JSON.stringify(answerReply).slice(0, 200)}`);
  }
  return {
    rtp, localPort,
    remoteHost: rtpengineHost, remotePort: rtpenginePort,
    codec: { ...CODEC_PCMU },
    answerSdp: answerReply.sdp,
    cleanup: () => {
      try { rtp.close(); } catch {}
      rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    },
  };
}

// Handle an INVITE to sip:conf-<callId> — the browser staff leg joining a
// pending conference. Bridges the WebRTC leg, dials the customer, then runs
// the 3-leg staff + customer + Aria conference.
async function handleConferenceStaffInvite(req, res, callId) {
  const pc = pendingConferences.get(callId);
  if (!pc) {
    console.warn(`[${callId}] conference INVITE — no matching pending conference`);
    return res.send(404);
  }
  if (pc.claimed) {
    console.warn(`[${callId}] conference INVITE — already claimed (duplicate)`);
    return res.send(486);
  }
  pc.claimed = true;
  // For a WABA conference the pending entry must survive the staff INVITE —
  // it holds the staff leg until the async WhatsApp customer leg connects,
  // and its gcTimer is the customer-no-answer deadline. For a PSTN-customer
  // conference everything happens inline below, so retire the entry now.
  if (pc.channel !== 'waba') {
    if (pc.gcTimer) clearTimeout(pc.gcTimer);
    pendingConferences.delete(callId);
  }

  if (shuttingDown) { console.log(`[${callId}] conf staff INVITE rejected: shutting down`); return res.send(503); }
  if (sessions.size >= MAX_CONCURRENT) { console.warn(`[${callId}] conf staff INVITE rejected: at capacity`); return res.send(486); }

  console.log(`[${callId}] conference: staff browser joining via ${req.protocol || 'ws'}`);

  // 1. Bridge the browser's WebRTC offer through rtpengine.
  const fromTag = 'staff-' + crypto.randomBytes(4).toString('hex');
  const toTag   = 'agent-' + crypto.randomBytes(4).toString('hex');
  let staffLeg;
  try {
    // WABA conferences run the staff leg as G.722 (HD wideband); PSTN
    // conferences stay PCMU — the 8k PSTN customer leg caps them anyway.
    staffLeg = await bridgeWebrtcLeg({ callId, offerSdp: req.body, fromTag, toTag, wideband: pc.channel === 'waba' });
  } catch (e) {
    console.error(`[${callId}] conf staff WebRTC bridge failed: ${e?.message || e}`);
    rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {});
    postCallState(callId, 'failed', { leg: 'staff', reason: 'media_bridge_failed' });
    return res.send(488);
  }

  // 2. Answer the browser with rtpengine's WebRTC answer SDP.
  let dialog;
  try {
    dialog = await srf.createUAS(req, res, { localSdp: staffLeg.answerSdp });
  } catch (e) {
    console.error(`[${callId}] conf staff createUAS failed: ${e?.message || e}`);
    staffLeg.cleanup();
    postCallState(callId, 'failed', { leg: 'staff', reason: 'signalling_failed' });
    return;
  }
  staffLeg.dialog = dialog;
  console.log(`[${callId}] conference: staff browser connected`);

  // WABA customer: the customer leg is dialled over WhatsApp by the control app,
  // not here. Park the staff leg on the pending entry; the rendezvous bridges
  // once Meta's customer leg connects (webhook.js → /session/waba-conf-ready).
  if (pc.channel === 'waba') {
    pc.staffLeg = staffLeg;
    console.log(`[${callId}] conference: staff in — awaiting WhatsApp customer leg`);
    maybeStartConference(callId);
    return;
  }

  // 3. Staff is in — ring the customer. (Ringback is played locally by the
  //    browser softphone in the control app, not here.)
  postCallState(callId, 'ringing', { leg: 'customer', customerWaId: pc.customerWaId });
  let customerLeg;
  try {
    customerLeg = await dialPstnLeg(callId, pc.customerNumber, 'customer');
  } catch (e) {
    const st = e?.sipStatus;
    const reason = st === 486 ? 'busy' : (st === 408 || st === 480) ? 'no_answer' : st === 603 ? 'declined' : 'failed';
    console.error(`[${callId}] conf customer dial failed (${reason}): ${e?.message || e}`);
    postCallState(callId, 'failed', { leg: 'customer', reason, detail: String(e?.message || e) });
    try { await dialog.destroy(); } catch {}
    staffLeg.cleanup();
    return;
  }
  postCallState(callId, 'answered', { leg: 'customer', customerWaId: pc.customerWaId });

  // 4. Bridge staff + customer + Aria.
  runConferenceSession({ callId, customerWaId: pc.customerWaId, staffLeg, customerLeg, staffName: pc.staffName })
    .catch((e) => {
      console.error(`[${callId}] conference bridge failed: ${e?.message || e}`);
      try { dialog.destroy(); } catch {}
      staffLeg.cleanup();
      try { customerLeg.dialog.destroy(); } catch {}
      try { customerLeg.rtp.close(); } catch {}
    });
}

// ── SIP ingress (DIDWW via drachtio) ─────────────────────────────────
srf.invite(async (req, res) => {
  const callId = req.get('Call-ID');
  const from = req.getParsedHeader('From')?.uri || req.source_address;
  console.log(`\n[${callId}] INVITE from ${from}`);

  // Browser softphone staff leg → request-URI sip:conf-<callId>@…. Branch to
  // the WebRTC conference path; everything else is a normal inbound 1:1 call.
  const ruriUser = String(req.uri || '').match(/^sips?:([^@]+)@/i)?.[1];
  if (ruriUser && ruriUser.startsWith('conf-')) {
    return handleConferenceStaffInvite(req, res, ruriUser.slice(5));
  }

  if (shuttingDown) {
    console.log(`[${callId}] rejected: shutting down`);
    return res.send(503);
  }
  if (sessions.size >= MAX_CONCURRENT) {
    console.warn(`[${callId}] rejected: at capacity ${sessions.size}/${MAX_CONCURRENT}`);
    return res.send(486); // Busy Here
  }

  let offer;
  try { offer = sdpTransform.parse(req.body); }
  catch (e) { console.error('bad SDP', e); return res.send(400); }
  const media = offer.media.find(m => m.type === 'audio');
  if (!media) return res.send(488);
  const remoteHost = (media.connection?.ip) || offer.connection?.ip;
  const remotePort = media.port;

  // Pick best codec from offer (L16/16000 > PCMU/8000). If neither is offered,
  // fall back to routing the media through rtpengine, which transcodes the
  // caller's codec (AMR-NB/WB, G.729, …) ↔ PCMU.
  const codec = chooseCodec(media);
  const te = (media.rtp || []).find(r => String(r.codec).toLowerCase() === 'telephone-event');
  const tePt = te?.payload ?? 101;

  // Load the assistant config BEFORE answering. If the config service is
  // unreachable, decline the INVITE (503) — never answer with a degraded,
  // prompt-less, tool-less bot.
  const waId = extractCallerWaId(req.get('From'));

  let rtp, localPort, answer, sessRemoteHost, sessRemotePort, sessCodec;
  let bridged = null;

  if (codec) {
    // Direct path — agent terminates the caller's RTP itself.
    console.log(`[${callId}] negotiated codec=${codec.name}/${codec.rate} pt=${codec.pt} (direct)`);
    ({ socket: rtp, port: localPort } = await allocRtpSocket());
    sessRemoteHost = remoteHost; sessRemotePort = remotePort; sessCodec = codec;
    answer =
      `v=0\r\no=- ${Date.now()} 1 IN IP4 ${PUBLIC_IP}\r\ns=voice-ai\r\n` +
      `c=IN IP4 ${PUBLIC_IP}\r\nt=0 0\r\n` +
      `m=audio ${localPort} RTP/AVP ${codec.pt} ${tePt}\r\n` +
      codec.sdp(codec.pt) +
      `a=rtpmap:${tePt} telephone-event/${codec.rate}\r\n` +
      `a=fmtp:${tePt} 0-16\r\na=sendrecv\r\na=ptime:20\r\n`;
  } else {
    // Transcoding fallback — caller offered no codec agent.js handles natively
    // (e.g. AMR-WB from a mobile-originated call). Bridge through rtpengine.
    console.log(`[${callId}] no native codec in offer — bridging via rtpengine (transcode → PCMU)`);
    const fromTag = 'caller-' + crypto.randomBytes(4).toString('hex');
    const toTag   = 'agent-'  + crypto.randomBytes(4).toString('hex');
    try {
      bridged = await bridgePstnLeg({ callId, offerSdp: req.body, fromTag, toTag });
    } catch (e) {
      console.warn(`[${callId}] rtpengine transcode bridge failed — rejecting 488: ${e?.message || e}`);
      return res.send(488);
    }
    rtp = bridged.rtp; localPort = bridged.localPort;
    sessRemoteHost = bridged.remoteHost; sessRemotePort = bridged.remotePort;
    sessCodec = bridged.codec; answer = bridged.answerSdp;
  }

  const voiceCfg = await fetchVoiceConfig(waId);
  if (!voiceCfg?.systemPrompt) {
    console.warn(`[${callId}] no voice config — declining INVITE with 503`);
    if (bridged) bridged.cleanup(); else rtp.close();
    return res.send(503);
  }

  let dialog;
  try { dialog = await srf.createUAS(req, res, { localSdp: answer }); }
  catch (e) {
    console.error(`[${callId}] createUAS failed`, e);
    if (bridged) bridged.cleanup(); else rtp.close();
    return;
  }

  let sess;
  try {
    sess = await runCallSession({
      callId, waId, voiceConfig: voiceCfg, rtp, localPort,
      remoteHost: sessRemoteHost, remotePort: sessRemotePort, codec: sessCodec, channel: 'pstn',
      // Agent-initiated hangup on PSTN: send BYE downstream. dialog.on('destroy')
      // below will then fire sess.terminate via the normal SIP teardown path; the
      // session's executePendingEndCall also calls wrapTerminate as belt-and-braces.
      endCall: async () => {
        try { await dialog.destroy(); }
        catch (e) { console.warn(`[${callId}] dialog.destroy failed`, e?.message || e); }
      },
    });
  } catch (e) {
    try { await dialog.destroy(); } catch {}
    if (bridged) bridged.cleanup();
    return;
  }
  dialog.on('destroy', () => {
    sess.terminate();
    if (bridged) bridged.cleanup();
  });
});

// ── WABA ingress (rtpengine termination + HTTP control from webhook.js) ──────
const control = express();
// `verify` captures the raw body string so the HMAC middleware can hash it
// without re-serializing (which would change byte-for-byte representation).
control.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

function requireControlToken(req, res, next) {
  const expected = process.env.INTERNAL_VOICE_TOKEN;
  if (!expected) return res.status(503).json({ error: 'INTERNAL_VOICE_TOKEN not configured' });
  const h = req.get('authorization') || '';
  if (!timingSafeStringEqual(h, `Bearer ${expected}`)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function timingSafeStringEqual(actual, expected) {
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// HMAC-SHA256 auth for control-app → agent /v1/calls/* requests. See
// docs/ADVANCED.md for the scheme and how the control app signs requests.
//
// Header: Authorization: VOICE-HMAC-SHA256 ts=<unix-seconds> sig=<hex>
// Signed string: "<ts>\n<METHOD>\n<PATH>\n<sha256_hex(body)>"
//   — body is the verbatim request body (empty string for GET).
function requireHmac(req, res, next) {
  if (!VOICE_VPS_ANNOUNCE_SECRET) {
    return res.status(503).json({ reason: 'announce_secret_not_configured' });
  }
  const auth = req.get('authorization') || '';
  const m = auth.match(/^VOICE-HMAC-SHA256\s+ts=(\d+)\s+sig=([0-9a-fA-F]+)\s*$/);
  if (!m) return res.status(401).json({ reason: 'bad_sig' });
  const ts = parseInt(m[1], 10);
  const sigHex = m[2].toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60) {
    return res.status(401).json({ reason: 'timestamp_skew' });
  }
  const bodyStr = req.rawBody ?? '';
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const signedString = `${ts}\n${req.method.toUpperCase()}\n${req.path}\n${bodyHash}`;
  const expected = crypto.createHmac('sha256', VOICE_VPS_ANNOUNCE_SECRET).update(signedString).digest('hex');
  let ok = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sigHex, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {}
  if (!ok) return res.status(401).json({ reason: 'bad_sig' });
  next();
}

control.get('/healthz', (_req, res) => {
  res.json({
    ok: !shuttingDown,
    ts: Date.now(),
    active_sessions: sessions.size,
    max_concurrent: MAX_CONCURRENT,
    shutting_down: shuttingDown,
    drachtio_connected: drachtioConnected,
  });
});

// ── Control-app mid-call announcements ───────────────────────────────────────
// Both routes are reachable from the public internet via Caddy
// (`https://voice.example.com/v1/calls/*` → 127.0.0.1:3002). HMAC-protected.
control.post('/v1/calls/:callId/announce', requireHmac, (req, res) => {
  const { callId } = req.params;
  const sess = sessions.get(callId);
  if (!sess || !sess.enqueueAnnounce) {
    const ended = endedSessions.get(callId);
    return res.status(410).json({ reason: 'call_ended', ended_at: ended?.ended_at });
  }
  const result = sess.enqueueAnnounce(req.body || {});
  if (result.error === 'max_queue_depth') {
    return res.status(409).json({ reason: 'max_queue_depth', current_depth: result.current_depth });
  }
  if (result.error === 'invalid_payload') {
    return res.status(400).json({ reason: 'invalid_payload', details: result.details });
  }
  res.json({ queued: true, estimated_speak_at_ms: result.estimated_speak_at_ms });
});

control.get('/v1/calls/:callId/status', requireHmac, (req, res) => {
  const { callId } = req.params;
  const sess = sessions.get(callId);
  if (sess && sess.getStatus) return res.json(sess.getStatus());
  const ended = endedSessions.get(callId);
  if (ended) return res.json({ call_id: callId, active: false, ended_at: ended.ended_at });
  return res.status(404).json({ reason: 'unknown_call_id' });
});

// Place an outbound call. Step 1 supports PSTN (DIDWW) only. Returns immediately
// with `dialing`; the call sets up asynchronously (ringing can take seconds).
control.post('/v1/calls/outbound', requireHmac, (req, res) => {
  if (shuttingDown) return res.status(503).json({ reason: 'shutting_down' });
  if (sessions.size >= MAX_CONCURRENT) {
    return res.status(503).json({ reason: 'at_capacity', active: sessions.size });
  }
  const transport = req.body?.transport || 'pstn';
  if (transport !== 'pstn') {
    return res.status(400).json({ reason: 'unsupported_transport', detail: 'only pstn supported in this build' });
  }
  const toNumber = req.body?.toNumber;
  if (!toNumber) return res.status(400).json({ reason: 'invalid_payload', detail: 'toNumber required' });
  const callId = req.body?.callId || crypto.randomUUID();
  console.log(`[${callId}] /v1/calls/outbound → ${toNumber} (${transport})`);
  placeOutboundPstn({ callId, toNumber }).catch((e) => {
    console.error(`[${callId}] outbound dial failed: ${e?.message || e}`);
  });
  res.json({ callId, status: 'dialing' });
});

// Start a 3-leg conference: dial staff + customer, bridge them with a quiet,
// proactive Aria. Returns immediately; setup is async (ringing takes time).
control.post('/v1/calls/conference', requireHmac, (req, res) => {
  if (shuttingDown) return res.status(503).json({ reason: 'shutting_down' });
  if (sessions.size + pendingConferences.size >= MAX_CONCURRENT) {
    return res.status(503).json({ reason: 'at_capacity', active: sessions.size });
  }
  const b = req.body || {};
  const norm = (c) => (c === 'whatsapp' || c === 'waba') ? 'waba' : 'pstn';

  // "Via my phone" — a fully phone-based conference (no browser leg). The
  // staff and customer legs are each PSTN or WhatsApp, chosen per call.
  if (b.mode === 'phone' || b.staffNumber || b.staffWaId) {
    const staffChannel = norm(b.staffChannel);
    const customerChannel = norm(b.customerChannel || b.channel);
    if (staffChannel === 'pstn' && !b.staffNumber) {
      return res.status(400).json({ reason: 'invalid_payload', detail: 'staffNumber required' });
    }
    if (staffChannel === 'waba' && !b.staffWaId) {
      return res.status(400).json({ reason: 'invalid_payload', detail: 'staffWaId required' });
    }
    if (customerChannel === 'pstn' && !b.customerNumber) {
      return res.status(400).json({ reason: 'invalid_payload', detail: 'customerNumber required' });
    }
    if (customerChannel === 'waba' && !b.customerWaId) {
      return res.status(400).json({ reason: 'invalid_payload', detail: 'customerWaId required' });
    }
    const callId = b.callId || crypto.randomBytes(16).toString('hex');
    console.log(`[${callId}] /v1/calls/conference (phone) staff=${staffChannel} customer=${customerChannel}`);
    startPhoneConference({
      callId, staffChannel, customerChannel,
      staffNumber: b.staffNumber, staffWaId: b.staffWaId,
      customerNumber: b.customerNumber, customerWaId: b.customerWaId,
      staffName: b.staffName,
    });
    return res.json({ callId, status: 'dialing' });
  }

  // Browser-softphone staff leg: register a pending conference keyed by a
  // random callId and wait for the staff WS INVITE to sip:conf-<callId>.
  const isWaba = norm(b.customerChannel) === 'waba';
  if (isWaba && !b.customerWaId) {
    return res.status(400).json({ reason: 'invalid_payload', detail: 'customerWaId required for whatsapp' });
  }
  if (!isWaba && !b.customerNumber) {
    return res.status(400).json({ reason: 'invalid_payload', detail: 'customerNumber required' });
  }
  const callId = crypto.randomBytes(16).toString('hex');
  createPendingConference({
    callId,
    channel: isWaba ? 'waba' : 'pstn',
    staffChannel: 'browser',
    customerChannel: isWaba ? 'waba' : 'pstn',
    customerNumber: b.customerNumber || null,
    customerWaId: b.customerWaId || null,
    staffName: b.staffName || null,
  });
  console.log(`[${callId}] /v1/calls/conference (browser staff, ${isWaba ? 'waba' : 'pstn'} customer) — awaiting staff INVITE`);
  res.json({ callId, status: 'awaiting_staff' });
});

// Mute / unmute / ask Aria mid-conference.
control.post('/v1/calls/:callId/aria', requireHmac, (req, res) => {
  const { callId } = req.params;
  const sess = sessions.get(callId);
  if (!sess || !sess.controlAria) {
    if (endedSessions.get(callId)) return res.status(410).json({ reason: 'call_ended' });
    return res.status(404).json({ reason: 'unknown_call_id' });
  }
  const action = req.body?.action;
  if (!['mute', 'unmute', 'ask'].includes(action)) {
    return res.status(400).json({ reason: 'invalid_payload', detail: 'action must be mute|unmute|ask' });
  }
  res.json({ ok: true, ...sess.controlAria(action, req.body?.text) });
});

control.post('/session/waba-start', requireControlToken, async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: 'shutting down' });
  if (sessions.size >= MAX_CONCURRENT) return res.status(503).json({ error: 'at capacity', active: sessions.size });
  const { callId, waId, callerName, remoteHost, remotePort } = req.body || {};
  if (!callId || !remoteHost || !remotePort) return res.status(400).json({ error: 'callId/remoteHost/remotePort required' });
  try {
    const { socket: rtp, port: localPort } = await allocRtpSocket();
    runCallSession({
      callId, waId, callerName, rtp, localPort, remoteHost, remotePort, channel: 'waba',
      // Agent-initiated hangup on WABA: only the control app holds Meta credentials.
      // Local teardown still happens regardless via wrapTerminate.
      endCall: async (reason) => {
        const ok = await wabaHangupRemote(callId, waId, reason);
        if (!ok) console.warn(`[${callId}] WABA hangup: control-app call failed — local teardown only; Meta call may linger`);
      },
    }).catch((e) => {
      console.error(`[${callId}] WABA session setup failed`, e);
    });
    res.json({ localPort });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
// ── WABA outbound conference customer leg (driven by webhook.js) ─────────────
// The WhatsApp customer leg of a 3-leg conference is set up in two phases,
// mirroring inbound /api/waba/connect but with offer/answer reversed:
//   1. waba-conf-alloc → reserve an RTP socket; webhook.js builds the WebRTC
//      offer that wa forwards to Meta /calls.
//   2. waba-conf-ready → the customer answered; webhook.js applied Meta's SDP
//      answer to rtpengine and passes us rtpengine's agent-facing RTP address.
const wabaConfSockets = new Map(); // `${callId}:${role}` → { rtp, localPort, gcTimer }
const WABA_CONF_SOCKET_TTL_MS = 150_000;

// Channel of a given conference leg ('pstn' | 'waba' | 'browser' | undefined).
function confLegChannel(pc, role) {
  if (!pc) return undefined;
  return role === 'staff' ? pc.staffChannel : pc.customerChannel;
}

control.post('/session/waba-conf-alloc', requireControlToken, async (req, res) => {
  const { callId, role = 'customer' } = req.body || {};
  if (!callId) return res.status(400).json({ error: 'callId required' });
  const pc = pendingConferences.get(callId);
  if (!pc || confLegChannel(pc, role) !== 'waba') {
    return res.status(404).json({ error: 'no pending WABA conference leg for callId/role' });
  }
  const key = `${callId}:${role}`;
  if (wabaConfSockets.has(key)) {
    return res.status(409).json({ error: 'socket already allocated for callId/role' });
  }
  try {
    const { socket: rtp, port: localPort } = await allocRtpSocket();
    // Reclaim the socket if dial-answer never arrives (call abandoned pre-answer).
    const gcTimer = setTimeout(() => {
      if (wabaConfSockets.get(key)?.rtp === rtp) {
        wabaConfSockets.delete(key);
        try { rtp.close(); } catch {}
        console.warn(`[${callId}] waba-conf socket (${role}) expired (no dial-answer)`);
      }
    }, WABA_CONF_SOCKET_TTL_MS);
    gcTimer.unref?.();
    wabaConfSockets.set(key, { rtp, localPort, gcTimer });
    console.log(`[${callId}] waba-conf-alloc ${role} localPort=${localPort}`);
    res.json({ localPort });
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});

control.post('/session/waba-conf-ready', requireControlToken, (req, res) => {
  const { callId, role = 'customer', remoteHost, remotePort } = req.body || {};
  if (!callId || !remoteHost || !remotePort) {
    return res.status(400).json({ error: 'callId/remoteHost/remotePort required' });
  }
  const key = `${callId}:${role}`;
  const sock = wabaConfSockets.get(key);
  if (!sock) return res.status(404).json({ error: 'no reserved socket for callId/role (expired?)' });
  const pc = pendingConferences.get(callId);
  if (!pc || confLegChannel(pc, role) !== 'waba' || pc.started) {
    try { sock.rtp.close(); } catch {}
    if (sock.gcTimer) clearTimeout(sock.gcTimer);
    wabaConfSockets.delete(key);
    return res.status(404).json({ error: 'no pending WABA conference for callId' });
  }
  if (sock.gcTimer) clearTimeout(sock.gcTimer);
  wabaConfSockets.delete(key);
  const leg = {
    rtp: sock.rtp,
    localPort: sock.localPort,
    remoteHost,
    remotePort: parseInt(remotePort, 10),
    codec: makeG722Codec(9),         // wideband G.722 — rtpengine transcodes Meta's Opus ↔ G.722
    toDigits: 'whatsapp',
    // Every conference leg shares one rtpengine call-id (=callId); a single
    // delete cleans them all. Idempotent — safe to call more than once.
    cleanup: () => { rtpNg({ command: 'delete', 'call-id': callId }).catch(() => {}); },
  };
  console.log(`[${callId}] waba-conf-ready ${role} — leg → rtpengine ${remoteHost}:${remotePort}`);
  res.json({ ok: true });
  confLegArrived(callId, role, leg);
});

control.post('/session/terminate', requireControlToken, (req, res) => {
  const { callId } = req.body || {};
  const s = sessions.get(callId);
  if (s) { s.terminate(); res.json({ terminated: true }); }
  else res.json({ terminated: false, reason: 'unknown callId' });
});
control.listen(3002, '127.0.0.1', () => console.log('[agent] control API on http://127.0.0.1:3002'));

// Graceful drain: on SIGTERM/SIGINT stop accepting new calls, wait for in-flight
// calls to end (or hit deadline), then exit. systemd TimeoutStopSec=65 covers us.
let shutdownStarted = false;
async function gracefulShutdown(sig) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  console.log(`[shutdown] ${sig} — draining ${sessions.size} active session(s)`);
  const deadline = Date.now() + 55_000;
  while (sessions.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (sessions.size > 0) {
    console.warn(`[shutdown] deadline reached, force-terminating ${sessions.size} session(s)`);
    for (const [, s] of sessions) { try { s.terminate(); } catch {} }
  }
  console.log('[shutdown] clean exit');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// drachtio-srf can throw a stray "unable to find dialog" from its wire-message
// handler when a dialog is torn down twice (a conference-teardown race). It is
// harmless — the dialog is already gone — but uncaught it crashes the process.
// Swallow exactly that class; let every other uncaught error crash as before.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err);
  if (/unable to find dialog|dialog id provided/i.test(msg)) {
    console.warn(`[uncaught] ignored stale drachtio dialog error: ${msg}`);
    return;
  }
  console.error('[uncaught] fatal:', err);
  process.exit(1);
});

// Event-loop lag instrumentation. Logs only when we see a real spike (>50ms
// — well above audible jitter threshold). Cheap to leave on; gives us an
// objective signal next time someone says "calls feel choppy" instead of
// chasing it blind.
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();
setInterval(() => {
  const max = eventLoopMonitor.max / 1e6;            // ns → ms
  const p99 = eventLoopMonitor.percentile(99) / 1e6;
  const mean = eventLoopMonitor.mean / 1e6;
  if (max > 50) {
    console.warn(`[perf] event loop lag: max=${max.toFixed(1)}ms p99=${p99.toFixed(1)}ms mean=${mean.toFixed(2)}ms (last 30s, ${sessions.size} active)`);
  }
  eventLoopMonitor.reset();
}, 30_000).unref();

console.log(`didww-voice-agent ready (cap=${MAX_CONCURRENT}, callMax=${MAX_CALL_SECONDS}s)`);
