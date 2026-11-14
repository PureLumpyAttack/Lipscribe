// The one place the page talks to the lip-reading model.
//
// demo.js only calls `transcribe(blob)` and expects `{ text, confidence }` back.
// Today that is an HTTP POST. When the ONNX model runs in the browser
// (see ../../ml/README.md), replace the body of `transcribe` with local
// inference and keep the same return shape; nothing else has to change.

import { config } from './config.js';

const EXTENSIONS = { 'video/webm': 'webm', 'video/mp4': 'mp4' };

export async function transcribe(blob) {
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

// Adjust this if the real model answers in a different JSON shape.
function parseResult(data) {
  const text = String(data.text ?? data.transcript ?? data.prediction ?? '').trim();
  if (!text) {
    throw new Error('No words came back. Keep your mouth inside the box and try again.');
  }
  const confidence = typeof data.confidence === 'number' ? data.confidence : null;
  return { text, confidence };
}
