// Reading transcripts aloud.
//
// Voices are strings:
//   'system:<name>'  browser speechSynthesis voice (offline, can't pick an output device)
//   'preset:<name>'  natural voice from the server (/api/tts, OpenRouter)
//   'clone'          the user's own cloned voice (sample from voice-clone.js)
//
// Server voices play through an <audio> element, so they can be sent to any
// output device, e.g. a virtual microphone (BlackHole, VB-CABLE) that a call
// app (Zoom, Meet, Discord) listens to.

import { loadSample } from './voice-clone.js';

const synth = window.speechSynthesis;
let active = null; // current utterance or { audios, token }
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

export const isVirtualDevice = (label) => /blackhole|vb-?audio|cable|loopback|virtual|soundflower|voicemeeter/i.test(label);

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

async function speakServer(text, voice, { sinkId, alsoLocal, onStart, onEnd, onError }) {
  const mine = ++token;
  const body = { text };
  if (voice === 'clone') {
    const sample = loadSample();
    if (!sample) throw new Error('Set up your voice first.');
    body.clone = { audio: sample.audio, transcript: sample.transcript };
  } else {
    body.voice = voice.slice('preset:'.length);
  }
  active = { token: mine, audios: [] };
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
  const targets = sinkId && canPickOutput ? [sinkId, ...(alsoLocal ? [''] : [])] : [''];
  const audios = await Promise.all(
    targets.map(async (id) => {
      const audio = new Audio(url);
      if (id) await audio.setSinkId(id).catch(() => {});
      return audio;
    }),
  );
  active.audios = audios;
  let pending = audios.length;
  const finish = () => {
    if (--pending > 0 || active?.token !== mine) return;
    active = null;
    URL.revokeObjectURL(url);
    onEnd?.();
  };
  for (const a of audios) {
    a.onended = finish;
    a.onerror = finish;
  }
  await Promise.all(audios.map((a) => a.play().catch(finish)));
}

/**
 * @param {string} text
 * @param {{ voice?: string, sinkId?: string, alsoLocal?: boolean, onStart?: Function, onEnd?: Function, onError?: (e: Error) => void }} options
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
  if (active?.audios) for (const a of active.audios) a.pause();
  active = null;
  if (systemSupported) synth.cancel();
}
