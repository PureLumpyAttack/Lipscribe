// Natural and cloned voices through OpenRouter's speech API.
// https://openrouter.ai/docs/guides/overview/multimodal/tts
//
//   GET  /api/tts/voices   { enabled, presets: [...], clone: bool }
//   POST /api/tts          { text, voice?: preset name, clone?: { audio: data URI, transcript } }
//                          -> audio/wav (presets) or audio/mpeg (cloned voice)
//
// The OpenRouter key stays on the server (OPENROUTER_API_KEY). A cloned voice
// is stateless: the browser keeps the user's own recording and sends it with
// each request; nothing is stored here.
//
// Two ways to run:
//   OPENROUTER_API_KEY=...       call OpenRouter directly
//   TTS_PROXY_URL=https://site   forward /api/tts* to another Lipscribe server
//                                (the desktop app uses this so no key ships with it)

import { checkTtsLimits } from './ratelimit.mjs';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/speech';

const PRESET_MODEL = process.env.TTS_MODEL_PRESET || 'heygen/heygen-voice-1-turbo';
const CLONE_MODEL = process.env.TTS_MODEL_CLONE || 'fish-audio/s2.1-pro';
// HeyGen Voice Turbo voices (from GET /api/v1/models?output_modalities=speech).
const PRESET_VOICES = (process.env.TTS_PRESET_VOICES || 'nadine,tabitha,noelle,meredith,sabrina,bram,gareth,lucian,weston,vincent').split(',');
const PRESET_PCM_RATE = 44100; // HeyGen returns raw 16-bit mono PCM at 44.1 kHz

const MAX_TEXT_CHARS = 600;
const MAX_SAMPLE_BYTES = 4 * 1024 * 1024; // base64 data URI of the voice sample
const MAX_BODY_BYTES = MAX_SAMPLE_BYTES + 64 * 1024;

// Abuse limits for a public site, shared across instances via Upstash Redis
// (lib/ratelimit.mjs; in memory when Redis isn't configured).
const LIMITS = {
  perIpRequests: Number(process.env.TTS_PER_IP_PER_10MIN || 40),
  perIpDailyChars: Number(process.env.TTS_PER_IP_DAILY_CHARS || 20_000),
  dailyChars: Number(process.env.TTS_DAILY_CHAR_LIMIT || 200_000), // ~$3/day at Fish Audio prices
};

function config() {
  const key = process.env.OPENROUTER_API_KEY || '';
  const proxy = (process.env.TTS_PROXY_URL || '').replace(/\/+$/, '');
  return { key, proxy, enabled: Boolean(key || proxy) };
}

export function ttsStatus() {
  return config().enabled;
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

/** Wrap raw 16-bit mono PCM in a WAV header so browsers can play it. */
function pcmToWav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function proxyTo(base, pathname, request, response) {
  const init = { method: request.method, headers: { 'Content-Type': 'application/json' } };
  if (request.method === 'POST') init.body = JSON.stringify(await readJson(request));
  let upstream;
  try {
    upstream = await fetch(base + pathname, { ...init, signal: AbortSignal.timeout(45_000) });
  } catch {
    return send(response, 502, { error: "Couldn't reach the voice server." });
  }
  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

/** Handles /api/tts and /api/tts/voices. Returns false if the path isn't ours. */
export async function handleTts(pathname, request, response) {
  if (pathname !== '/api/tts' && pathname !== '/api/tts/voices') return false;
  const { key, proxy, enabled } = config();

  if (proxy && !key) {
    await proxyTo(proxy, pathname, request, response);
    return true;
  }

  if (pathname === '/api/tts/voices' && request.method === 'GET') {
    send(response, 200, { enabled, presets: enabled ? PRESET_VOICES : [], clone: enabled });
    return true;
  }
  if (pathname !== '/api/tts' || request.method !== 'POST') {
    send(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!enabled) {
    send(response, 503, { error: 'Natural voices are not set up on this server (OPENROUTER_API_KEY is missing).' });
    return true;
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    send(response, error.status || 400, { error: error.message });
    return true;
  }
  const text = String(body.text ?? '').trim();
  if (!text) return send(response, 400, { error: 'No text to speak.' }), true;
  if (text.length > MAX_TEXT_CHARS) return send(response, 400, { error: `Text is longer than ${MAX_TEXT_CHARS} characters.` }), true;

  const clone = body.clone && typeof body.clone.audio === 'string' ? body.clone : null;
  const voice = PRESET_VOICES.includes(body.voice) ? body.voice : PRESET_VOICES[0];
  if (clone && (!clone.audio.startsWith('data:audio/') || clone.audio.length > MAX_SAMPLE_BYTES)) {
    send(response, 400, { error: 'The voice sample is missing or too large. Record it again.' });
    return true;
  }

  // Vercel sets x-forwarded-for itself (clients can't spoof it there).
  const ip = (request.headers['x-forwarded-for']?.split(',')[0] || request.socket.remoteAddress || '?').trim();
  const refused = await checkTtsLimits(ip, text.length, LIMITS);
  if (refused) return send(response, 429, { error: refused }), true;

  const payload = clone
    ? {
        model: CLONE_MODEL,
        input: text,
        response_format: 'mp3',
        input_references: [
          { type: 'input_audio', input_audio: { data: clone.audio } },
          ...(clone.transcript ? [{ type: 'text', text: String(clone.transcript).slice(0, 2000) }] : []),
        ],
      }
    : { model: PRESET_MODEL, input: text, voice, response_format: 'pcm' };

  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/PureLumpyAttack/Lipscribe',
        'X-Title': 'Lipscribe',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    console.error(`[tts] OpenRouter unreachable: ${error.message}`);
    send(response, 502, { error: "Couldn't reach the voice service." });
    return true;
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error(`[tts] ${payload.model} ${upstream.status}: ${detail.slice(0, 300)}`);
    send(response, 502, { error: upstream.status === 402 ? 'The voice service is out of credits.' : 'The voice service returned an error.' });
    return true;
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  console.log(`[tts] ${clone ? 'clone' : voice} ${text.length} chars → ${Math.round(audio.length / 1024)} KB`);
  if (clone) send(response, 200, audio, 'audio/mpeg');
  else send(response, 200, pcmToWav(audio, PRESET_PCM_RATE), 'audio/wav');
  return true;
}
