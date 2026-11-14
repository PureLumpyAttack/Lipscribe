// The one place the page talks to the lip-reading model.
//
// demo.js calls `transcribe(clip)` and expects `{ text, confidence }` back.
//
// config.engine === 'browser' (default): clip.frames comes from
// lipread/frame-recorder.js and the model runs in this tab (lipread/engine.js).
// config.engine === 'server': clip.blob is a video file POSTed to
// config.transcribeUrl (mock server, or a proxy to a Python model).

import { config } from './config.js';
import { createEngine } from './lipread/engine.js';
import { cropMouths, resampleByTime } from './lipread/align.js';

const EXTENSIONS = { 'video/webm': 'webm', 'video/mp4': 'mp4' };

let engine = null;
const progressListeners = new Set();

/** The in-browser model (created on first use). */
export function getEngine() {
  engine ??= createEngine({
    baseUrl: config.modelBaseUrl,
    beam: config.beamSize,
    onProgress: (p) => progressListeners.forEach((fn) => fn(p)),
  });
  return engine;
}

export function onModelProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export async function transcribe(clip) {
  return config.engine === 'browser' ? transcribeInBrowser(clip) : transcribeOnServer(clip);
}

async function transcribeInBrowser(clip) {
  const { regions, keypoints, timestamps } = clip.frames;
  if (!keypoints.some(Boolean)) {
    throw new Error('No face was found in that clip. Face the camera and try again.');
  }
  const model = getEngine();
  const { prep } = await model.load();
  const picks = resampleByTime(timestamps, prep.fps);
  const mouths = cropMouths(picks.map((i) => regions[i]), picks.map((i) => keypoints[i]), prep);
  const { text, ms } = await model.transcribe(mouths, picks.length);
  console.info(`[lipscribe] ${picks.length} frames → "${text}" in ${Math.round(ms)} ms`);
  return parseResult({ text });
}

async function transcribeOnServer(clip) {
  const blob = clip.blob;
  const type = blob.type.split(';')[0];
  const form = new FormData();
  form.append(config.videoField, blob, `clip.${EXTENSIONS[type] ?? 'webm'}`);

  let response;
  try {
    response = await fetch(config.transcribeUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new Error('The model took too long to answer. Try a shorter clip.');
    }
    throw new Error("Couldn't reach the model. Check that the server is still running.");
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `The model answered with an error (${response.status}).`);
  }
  return parseResult(data);
}

// Adjust this if a server model answers in a different JSON shape.
function parseResult(data) {
  const text = String(data.text ?? data.transcript ?? data.prediction ?? '').trim();
  if (!text) {
    throw new Error('No words came back. Keep your mouth inside the box and try again.');
  }
  const confidence = typeof data.confidence === 'number' ? data.confidence : null;
  // The model writes in capitals; show it as a sentence.
  const pretty = text === text.toUpperCase() ? text.charAt(0) + text.slice(1).toLowerCase() : text;
  return { text: pretty.replace(/\bi\b/g, 'I'), confidence };
}
