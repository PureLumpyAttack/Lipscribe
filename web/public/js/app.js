// Wires the page together: camera → record → transcribe → show, speak, remember.

import { config } from './config.js';
import { transcribe } from './transcriber.js';
import { startCamera, createRecorder } from './camera.js';
import { createMouthTracker } from './mouth-tracker.js';
import * as speech from './speech.js';
import { loadHistory, saveHistory, loadPrefs, savePrefs, MAX_HISTORY } from './storage.js';

const $ = (id) => document.getElementById(id);
const ui = {
  viewport: $('viewport'),
  video: $('video'),
  overlay: $('overlay'),
  trackChip: $('track-chip'),
  recChip: $('rec-chip'),
  recTime: $('rec-time'),
  progress: $('progress-bar'),
  gateTitle: $('gate-title'),
  gateBody: $('gate-body'),
  cameraBtn: $('camera-btn'),
  recordBtn: $('record-btn'),
  recordLabel: $('record-label'),
  latest: $('latest'),
  latestMeta: $('latest-meta'),
  transcript: $('transcript'),
  errorText: $('error-text'),
  retryBtn: $('retry-btn'),
  speakBtn: $('speak-btn'),
  speakLabel: $('speak-label'),
  copyBtn: $('copy-btn'),
  copyLabel: $('copy-label'),
  voiceSelect: $('voice-select'),
  autospeak: $('autospeak'),
  historyList: $('history-list'),
  historyEmpty: $('history-empty'),
  historyCount: $('history-count'),
  clearBtn: $('clear-btn'),
  itemTemplate: $('history-item'),
  backendPill: $('backend-pill'),
  backendLabel: $('backend-label'),
};

const state = {
  recorder: null,
  tracker: null,
  timer: 0,
  startedAt: 0,
  busy: false,
  failedClip: null,
  current: null, // entry shown in the Transcript panel
  speakingId: null,
  history: loadHistory(),
  prefs: loadPrefs(),
};

/* ---------- Camera ---------- */

const TRACK_COPY = {
  off: 'Camera off',
  loading: 'Loading face tracking…',
  tracking: 'Mouth tracked',
  search: 'Looking for your face',
  guide: 'Line up your mouth with the box',
};

function setTrackStatus(status) {
  ui.trackChip.dataset.state = status;
  ui.trackChip.textContent = TRACK_COPY[status];
}

function showGate(kind, title, body) {
  ui.viewport.dataset.camera = kind;
  ui.gateTitle.textContent = title;
  ui.gateBody.textContent = body;
  ui.cameraBtn.hidden = kind === 'loading';
  ui.cameraBtn.textContent = kind === 'error' ? 'Try again' : 'Enable camera';
}

function cameraErrorCopy(error) {
  switch (error?.name) {
    case 'NotAllowedError':
      return ['Camera access is blocked', 'Allow the camera from the icon in the address bar, then try again.'];
    case 'NotFoundError':
    case 'OverconstrainedError':
      return ['No camera found', 'Plug in a webcam or open Lipscribe on a device that has one.'];
    case 'NotReadableError':
      return ['Camera is busy', 'Another app (Zoom, FaceTime, OBS) is using it. Close that app, then try again.'];
    default:
      return ["Camera didn't start", error?.message || 'Something went wrong. Try again.'];
  }
}

async function enableCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showGate('error', "This browser can't record video", 'Open http://localhost:3000 in Chrome, Edge or Safari.');
    return;
  }
  showGate('loading', 'Starting camera…', 'Allow camera access when your browser asks.');
  try {
    const stream = await startCamera(ui.video);
    state.recorder = createRecorder(stream);
    ui.viewport.dataset.camera = 'on';
    ui.recordBtn.disabled = state.busy;
    state.tracker ??= createMouthTracker({ video: ui.video, canvas: ui.overlay, onStatus: setTrackStatus });
    state.tracker.start();
  } catch (error) {
    const [title, body] = cameraErrorCopy(error);
    showGate('error', title, body);
  }
}

/* ---------- Recording ---------- */

function setRecordingUI(on) {
  ui.viewport.dataset.recording = String(on);
  ui.recordBtn.setAttribute('aria-pressed', String(on));
  ui.recordLabel.textContent = on ? 'Stop and transcribe' : 'Start recording';
  ui.recChip.hidden = !on;
  if (!on) ui.progress.style.transform = 'scaleX(0)';
}

function startRecording() {
  speech.stop();
  setSpeaking(null);
  state.recorder.start();
  state.startedAt = performance.now();
  setRecordingUI(true);
  updateTimer();
  state.timer = setInterval(updateTimer, 100);
}

function updateTimer() {
  const elapsed = performance.now() - state.startedAt;
  const limit = config.maxRecordSeconds * 1000;
  ui.recTime.textContent = formatClock(elapsed);
  ui.progress.style.transform = `scaleX(${Math.min(elapsed / limit, 1)})`;
  if (elapsed >= limit) stopRecording();
}

async function stopRecording() {
  if (!state.recorder?.recording) return;
  clearInterval(state.timer);
  setRecordingUI(false);

  let clip;
  try {
    clip = await state.recorder.stop();
  } catch (error) {
    showError(`Recording failed: ${error.message}`, false);
    return;
  }
  if (clip.durationMs < config.minRecordMs) {
    showError('That clip was too short. Record for at least a second.', false);
    return;
  }
  sendClip(clip);
}

function toggleRecording() {
  if (!state.recorder || state.busy) return;
  if (state.recorder.recording) stopRecording();
  else startRecording();
}

/* ---------- Transcription ---------- */

async function sendClip(clip) {
  state.busy = true;
  state.failedClip = null;
  ui.recordBtn.disabled = true;
  ui.latest.dataset.state = 'loading';
  ui.latestMeta.textContent = '';

  try {
    const result = await transcribe(clip.blob);
    const entry = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      text: result.text,
      confidence: result.confidence,
      durationMs: Math.round(clip.durationMs),
      createdAt: Date.now(),
    };
    state.history = [entry, ...state.history].slice(0, MAX_HISTORY);
    saveHistory(state.history);
    renderHistory();
    showEntry(entry);
    if (ui.autospeak.checked) speakEntry(entry);
  } catch (error) {
    state.failedClip = clip;
    showError(error.message, true);
  } finally {
    state.busy = false;
    ui.recordBtn.disabled = !state.recorder;
  }
}

function showEntry(entry) {
  state.current = entry;
  ui.latest.dataset.state = 'ready';
  ui.transcript.textContent = entry.text;
  ui.latestMeta.textContent = describe(entry);
  ui.speakBtn.disabled = !speech.supported;
  ui.copyBtn.disabled = false;
  setSpeaking(state.speakingId);
}

function showError(message, canRetry) {
  state.current = null;
  ui.latest.dataset.state = 'error';
  ui.errorText.textContent = message;
  ui.retryBtn.hidden = !canRetry;
  ui.latestMeta.textContent = '';
  ui.speakBtn.disabled = true;
  ui.copyBtn.disabled = true;
}

/* ---------- Speech ---------- */

function speakEntry(entry) {
  speech.speak(entry.text, {
    voiceName: state.prefs.voice,
    onStart: () => setSpeaking(entry.id),
    onEnd: () => setSpeaking(null),
  });
}

function toggleSpeak(entry) {
  if (state.speakingId === entry.id) {
    speech.stop();
    setSpeaking(null);
  } else {
    speakEntry(entry);
  }
}

function setSpeaking(id) {
  state.speakingId = id;
  const currentIsSpeaking = Boolean(id && state.current?.id === id);
  ui.latest.dataset.speaking = String(currentIsSpeaking);
  ui.speakLabel.textContent = currentIsSpeaking ? 'Stop' : 'Speak';
  for (const item of ui.historyList.children) {
    item.dataset.speaking = String(item.dataset.id === id);
  }
}

function setupVoices() {
  if (!speech.supported) {
    ui.voiceSelect.innerHTML = '<option>Not supported in this browser</option>';
    ui.voiceSelect.disabled = true;
    ui.autospeak.checked = false;
    ui.autospeak.disabled = true;
    return;
  }
  speech.onVoices((voices) => {
    const english = voices.filter((v) => v.lang.startsWith('en'));
    const others = voices.filter((v) => !v.lang.startsWith('en'));
    const option = (v) => new Option(`${v.name} (${v.lang})`, v.name);
    ui.voiceSelect.replaceChildren(new Option('System default', ''), ...english.map(option), ...others.map(option));
    ui.voiceSelect.value = voices.some((v) => v.name === state.prefs.voice) ? state.prefs.voice : '';
  });
}

/* ---------- History ---------- */

function renderHistory() {
  const items = state.history;
  ui.historyCount.textContent = items.length;
  ui.historyEmpty.hidden = items.length > 0;
  ui.clearBtn.disabled = items.length === 0;
  ui.historyList.replaceChildren(...items.map(renderItem));
}

function renderItem(entry) {
  const node = ui.itemTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = entry.id;
  node.dataset.speaking = String(entry.id === state.speakingId);
  node.querySelector('.history-text').textContent = entry.text;
  node.querySelector('.history-meta').textContent = describe(entry);
  return node;
}

/* ---------- Helpers ---------- */

function describe(entry) {
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const parts = [time, `${(entry.durationMs / 1000).toFixed(1)}s`];
  if (entry.confidence != null) parts.push(`${Math.round(entry.confidence * 100)}%`);
  return parts.join(' · ');
}

function formatClock(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function copyText(text, onDone) {
  try {
    await navigator.clipboard.writeText(text);
    onDone(true);
  } catch {
    onDone(false);
  }
}

async function showBackend() {
  ui.backendPill.title = `Clips go to ${config.transcribeUrl}`;
  $('endpoint-label').textContent = config.transcribeUrl;
  const target = new URL(config.transcribeUrl, location.href);
  if (target.origin !== location.origin) {
    ui.backendPill.dataset.mode = 'live';
    ui.backendLabel.textContent = 'Live model';
    return;
  }
  try {
    const { mode } = await (await fetch('/api/status')).json();
    ui.backendPill.dataset.mode = mode === 'proxy' ? 'live' : 'mock';
    ui.backendLabel.textContent = mode === 'proxy' ? 'Live model' : 'Mock model';
  } catch {
    ui.backendPill.dataset.mode = 'unknown';
    ui.backendLabel.textContent = 'Model status unknown';
  }
}

/* ---------- Events ---------- */

ui.cameraBtn.addEventListener('click', enableCamera);
ui.recordBtn.addEventListener('click', toggleRecording);

ui.retryBtn.addEventListener('click', () => {
  if (state.failedClip) sendClip(state.failedClip);
});

ui.speakBtn.addEventListener('click', () => state.current && toggleSpeak(state.current));

ui.copyBtn.addEventListener('click', () => {
  if (!state.current) return;
  copyText(state.current.text, (ok) => {
    ui.copyLabel.textContent = ok ? 'Copied' : "Couldn't copy";
    setTimeout(() => (ui.copyLabel.textContent = 'Copy'), 1500);
  });
});

ui.voiceSelect.addEventListener('change', () => {
  state.prefs.voice = ui.voiceSelect.value;
  savePrefs(state.prefs);
});

ui.autospeak.addEventListener('change', () => {
  state.prefs.autoSpeak = ui.autospeak.checked;
  savePrefs(state.prefs);
});

ui.historyList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  const entry = button && state.history.find((e) => e.id === button.closest('li').dataset.id);
  if (!entry) return;
  if (button.dataset.action === 'speak') toggleSpeak(entry);
  if (button.dataset.action === 'copy') {
    copyText(entry.text, (ok) => {
      if (!ok) return;
      button.dataset.copied = 'true';
      setTimeout(() => delete button.dataset.copied, 1500);
    });
  }
});

ui.clearBtn.addEventListener('click', () => {
  if (!confirm(`Delete all ${state.history.length} transcripts from this browser?`)) return;
  speech.stop();
  setSpeaking(null);
  state.history = [];
  saveHistory(state.history);
  renderHistory();
});

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (event.target.closest('button, input, select, textarea, a, [contenteditable]')) return;
  event.preventDefault();
  toggleRecording();
});

/* ---------- Start ---------- */

$('max-secs').textContent = config.maxRecordSeconds;
ui.autospeak.checked = state.prefs.autoSpeak;
setupVoices();
renderHistory();
if (state.history[0]) showEntry(state.history[0]);
showBackend();

// Skip the button if the camera was already allowed on a previous visit.
navigator.permissions
  ?.query({ name: 'camera' })
  .then((permission) => permission.state === 'granted' && enableCamera())
  .catch(() => {});
