// demo-config.js — built-in voice-agent configuration for the out-of-the-box demo.
//
// agent.js normally fetches a per-caller config (system prompt + tools) from an
// external service when INTERNAL_VOICE_URL is set — see docs/ADVANCED.md. When
// that variable is NOT set, agent.js falls back to the config below, so a fresh
// clone answers real phone calls with a working AI agent using nothing but a
// SIP trunk and a Gemini API key. No database, no second service.
//
// Make it your own:
//   - Quick : edit DEMO_SYSTEM_PROMPT and DEMO_TOOLS in this file.
//   - Full  : run a config service and set INTERNAL_VOICE_URL — this file is
//             then unused. See docs/ADVANCED.md.

const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Aria';
const DEMO_LANGUAGE  = process.env.DEMO_LANGUAGE_CODE || 'en-US';

const DEMO_SYSTEM_PROMPT = `
You are ${ASSISTANT_NAME}, a warm and concise voice assistant answering the demo
line of "didww-voice-agent" — an open-source stack that bridges a DIDWW SIP
trunk to Google's Gemini Live API so anyone can run their own AI phone agent.

Whoever is calling has just deployed this project and dialed their number to
hear it work — you ARE the live demo. This is a phone call: keep replies to a
sentence or two, sound natural, and never read out lists or URLs.

You can confidently explain:
  - What this is: a self-hosted, carrier-agnostic AI voice agent.
  - How their call reached you: their DIDWW DID delivered a SIP INVITE to a
    drachtio SIP server, a Node.js process bridged the RTP audio both ways, and
    you are Google Gemini Live answering over a realtime WebSocket.
  - How to customise you: edit the prompt in server/demo-config.js, or connect
    a config service via INTERNAL_VOICE_URL for per-caller prompts and tools.

If asked something unrelated to the project, simply be a helpful assistant.
When the caller is clearly finished, say a short goodbye and call the end_call
tool — do not mention the tool itself to the caller.
`.trim();

// Tools exposed to the model. `end_call` is always added by agent.js itself, so
// it is not repeated here. Demo tools must be runnable locally with no network
// dependency — see execDemoTool below.
const DEMO_TOOLS = [
  {
    name: 'get_current_time',
    description:
      'Get the current date and time. Use when the caller asks what time or day it is.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

// Local executor for the demo tools. agent.js calls this — instead of proxying
// to a remote service — whenever INTERNAL_VOICE_URL is unset. Return a short
// string; the model will speak it.
export function execDemoTool(name /* , args */) {
  switch (name) {
    case 'get_current_time':
      return new Date().toLocaleString('en-US', {
        timeZone: process.env.AGENT_TIMEZONE || 'UTC',
        dateStyle: 'full',
        timeStyle: 'short',
      });
    default:
      return `Error: unknown demo tool "${name}"`;
  }
}

// The config shape agent.js expects back from fetchVoiceConfig().
export function getDemoVoiceConfig() {
  return {
    systemPrompt: DEMO_SYSTEM_PROMPT,
    tools: DEMO_TOOLS,
    contact: { id: 'demo' },
    conversationId: null,
    locale: { languageCode: DEMO_LANGUAGE },
  };
}
