// Reading transcripts aloud.
//
// Voices are strings:
//   'system:<name>'  browser speechSynthesis voice (offline, can't pick an output device)
//   'preset:<name>'  natural voice from the server (/api/tts, OpenRouter)
//   'clone'          the user's own cloned voice (sample from voice-clone.js)
//
// Server voices can be sent to any output device, e.g. a virtual microphone
// (the desktop app's Lipscribe Microphone, BlackHole, VB-CABLE) that a call app
// (Zoom, Meet, Discord) listens to. That copy can be made louder (`gain`): it
// plays through Web Audio with a limiter so the boost doesn't clip.

import { loadSample } from './voice-clone.js';

const synth = window.speechSynthesis;
let active = null; // current utterance or { token, players }
let token = 0;

// Speaking is always possible: browser voices, or server voices through <audio>.
export const supported = true;
export const systemSupported = Boolean(synth && window.SpeechSynthesisUtterance);
export const canPickOutput = 'setSinkId' in HTMLMediaElement.prototype;

export function onVoices(callback) {
  if (!systemSupported) return callback([]);
  const emit = () => callback(synth.getVoices());
  emit();
  synth.addEventListener('voiceschanged', emit);
}

/** Server voice options: { enabled, presets: [...], clone }. */
export async function serverVoices() {
  try {
    const r = await fetch('/api/tts/voices');
    return r.ok ? await r.json() : { enabled: false, presets: [], clone: false };
  } catch {
    return { enabled: false, presets: [], clone: false };
  }
}

/** Audio output devices (labels appear once the page has camera or mic permission). */
export async function outputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
}

export const isVirtualDevice = (label) => /lipscribe|blackhole|vb-?audio|cable|loopback|virtual|soundflower|voicemeeter/i.test(label);
export const isLipscribeMic = (label) => /lipscribe microphone/i.test(label);

const canRouteWebAudio = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

/** Play `bytes` on one output. Returns { stop, done } where done resolves when playback ends. */
async function playOn(bytes, blobUrl, sinkId, gain) {
  if (gain !== 1 && canRouteWebAudio) {
    const ctx = new AudioContext(sinkId ? { sinkId } : {});
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    // Hard-ish limiter: the boosted peaks are squashed instead of clipping.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    source.connect(amp).connect(limiter).connect(ctx.destination);
    const done = new Promise((resolve) => (source.onended = resolve)).finally(() => ctx.close().catch(() => {}));
    await ctx.resume().catch(() => {});
    source.start();
    return { stop: () => source.stop(), done };
  }
  const audio = new Audio(blobUrl);
  if (sinkId) await audio.setSinkId(sinkId).catch(() => {});
  const done = new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
  });
  await audio.play().catch(() => {});
  return { stop: () => audio.pause(), done: Promise.race([done, new Promise((r) => audio.paused && r())]) };
}

function speakSystem(text, voiceName, { onStart, onEnd }) {
  if (!systemSupported) return onEnd?.();
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = synth.getVoices().find((v) => v.name === voiceName);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }
  // Only the newest utterance reports back, so a cancelled one can't
  // clear the "speaking" state of the one that replaced it.
  active = utterance;
  utterance.onstart = () => active === utterance && onStart?.();
  const done = () => {
    if (active !== utterance) return;
    active = null;
    onEnd?.();
  };
  utterance.onend = done;
  utterance.onerror = done;
  synth.speak(utterance);
}

async function speakServer(text, voice, { sinkId, alsoLocal, gain = 1, onStart, onEnd, onError }) {
  const mine = ++token;
  const body = { text };
  if (voice === 'clone') {
    const sample = loadSample();
    if (!sample) throw new Error('Set up your voice first.');
    body.clone = { audio: sample.audio, transcript: sample.transcript };
  } else {
    body.voice = voice.slice('preset:'.length);
  }
  active = { token: mine, players: [] };
  onStart?.(); // show "speaking" right away; the request takes a second or two

  let blob;
  try {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Voice request failed (${r.status}).`);
    blob = await r.blob();
  } catch (error) {
    if (active?.token === mine) {
      active = null;
      onError?.(error.name === 'TimeoutError' ? new Error('The voice took too long. Try again.') : error);
      onEnd?.();
    }
    return;
  }
  if (active?.token !== mine) return; // stopped or replaced while waiting

  const url = URL.createObjectURL(blob);
  const bytes = await blob.arrayBuffer();
  // The chosen device (louder if `gain` > 1), plus this computer's speakers at normal volume.
  const outputs = sinkId && canPickOutput ? [[sinkId, gain], ...(alsoLocal ? [['', 1]] : [])] : [['', 1]];
  const players = await Promise.all(outputs.map(([id, g]) => playOn(bytes, url, id, g).catch(() => null)));
  if (active?.token !== mine) {
    for (const p of players) p?.stop();
    URL.revokeObjectURL(url);
    return;
  }
  active.players = players.filter(Boolean);
  await Promise.all(active.players.map((p) => p.done));
  URL.revokeObjectURL(url);
  if (active?.token !== mine) return;
  active = null;
  onEnd?.();
}

/**
 * @param {string} text
 * @param {{ voice?: string, sinkId?: string, alsoLocal?: boolean, gain?: number, onStart?: Function, onEnd?: Function, onError?: (e: Error) => void }} options
 *   gain: volume of the copy sent to `sinkId` (1 = as is, 2 = twice as loud)
 */
export function speak(text, { voice = '', ...options } = {}) {
  stop();
  if (voice === 'clone' || voice.startsWith('preset:')) {
    speakServer(text, voice, options).catch((error) => {
      options.onError?.(error);
      options.onEnd?.();
    });
  } else {
    speakSystem(text, voice.replace(/^system:/, ''), options);
  }
}

export function stop() {
  token++;
  if (active?.players) for (const p of active.players) p.stop();
  active = null;
  if (systemSupported) synth.cancel();
}
