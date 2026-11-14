// Demo page: camera → record → transcribe → show, speak, remember.

import { config } from './config.js';
import { transcribe, getEngine, onModelProgress } from './transcriber.js';
import { startCamera, createRecorder } from './camera.js';
import { createMouthTracker } from './mouth-tracker.js';
import { createFaceTarget } from './lipread/face-target.js';
import { createFrameRecorder } from './lipread/frame-recorder.js';
import * as speech from './speech.js';
import * as voiceClone from './voice-clone.js';
import { loadHistory, saveHistory, loadPrefs, savePrefs, MAX_HISTORY } from './storage.js';

const $ = (id) => document.getElementById(id);
const ui = {
  viewport: $('viewport'),
  video: $('video'),
  videoFocus: $('video-focus'),
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
  modelTag: $('model-tag'),
  facesOverlay: $('faces-overlay'),
  peopleHint: $('people-hint'),
  loadingNote: document.querySelector('#latest .loading-note'),
  outputField: $('output-field'),
  outputSelect: $('output-select'),
  alsoLocalField: $('also-local-field'),
  alsoLocal: $('also-local'),
  voiceNote: $('voice-note'),
  cloneOpen: $('clone-open'),
  cloneDialog: $('clone-dialog'),
  cloneScript: $('clone-script'),
  cloneConsent: $('clone-consent'),
  cloneLevel: $('clone-level'),
  cloneStatus: $('clone-status'),
  cloneRecord: $('clone-record'),
  cloneTest: $('clone-test'),
  cloneDelete: $('clone-delete'),
};

const inBrowser = config.engine === 'browser';

const state = {
  recorder: null,
  tracker: null,
  faceTarget: null, // lipread/face-target.js, browser engine only
  faceTargetReady: false,
  model: { phase: 'idle' },
  timer: 0,
  startedAt: 0,
  busy: false,
  failedClip: null,
  current: null, // entry shown in the Transcript panel
  speakingId: null,
  history: loadHistory(),
  prefs: loadPrefs(),
  serverVoices: { enabled: false, presets: [], clone: false },
  systemVoices: [],
  cloneRec: null, // active voice-sample recording
};

// Older prefs stored a bare speechSynthesis voice name.
if (state.prefs.voice && !/^(system:|preset:|clone$)/.test(state.prefs.voice)) state.prefs.voice = `system:${state.prefs.voice}`;

/* ---------- Camera ---------- */

const TRACK_COPY = {
  off: 'Camera off',
  loading: 'Loading face tracking…',
  tracking: 'Mouth found',
  search: 'Finding your mouth…',
  guide: 'Line up your mouth with the outline',
};

function setTrackStatus(status) {
  ui.viewport.dataset.track = status;
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
    ui.videoFocus.srcObject = stream;
    await ui.videoFocus.play();
    if (inBrowser) {
      state.faceTarget ??= createFaceTarget({ video: ui.video, onChange: renderFaces });
      state.faceTarget
        .start()
        .then(() => (state.faceTargetReady = true))
        .catch((error) => console.warn('[lipscribe] Face detector unavailable', error));
      state.recorder = createFrameRecorder({ video: ui.video, faceTarget: state.faceTarget });
      loadModel();
    } else {
      state.recorder = createRecorder(stream);
    }
    ui.viewport.dataset.camera = 'on';
    ui.recordBtn.disabled = state.busy;
    renderOutputOptions(); // device names are only visible after a media permission
    state.tracker ??= createMouthTracker({
      video: ui.video,
      viewport: ui.viewport,
      onStatus: setTrackStatus,
      // Keep the highlight on the person being read.
      getTargetBox: () => (state.faceTargetReady ? (state.faceTarget.target?.box ?? null) : undefined),
    });
    state.tracker.start();
  } catch (error) {
    const [title, body] = cameraErrorCopy(error);
    showGate('error', title, body);
  }
}

/* ---------- Choosing who to read (browser engine) ---------- */

// The video layers are mirrored and zoomed (transform: scale(-1.06, 1.06), object-fit: cover).
const ZOOM = 1.06;

function coverMapping() {
  const W = ui.video.videoWidth;
  const H = ui.video.videoHeight;
  const elW = ui.viewport.clientWidth;
  const elH = ui.viewport.clientHeight;
  const scale = Math.max(elW / W, elH / H);
  return { scale, offsetX: (elW - W * scale) / 2, offsetY: (elH - H * scale) / 2, elW, elH };
}

/** Click position on the viewport -> video pixels (undoing mirror + zoom + cover). */
function viewportToVideo(clientX, clientY) {
  const rect = ui.viewport.getBoundingClientRect();
  const { scale, offsetX, offsetY, elW, elH } = coverMapping();
  const x = elW / 2 - (clientX - rect.left - elW / 2) / ZOOM; // un-mirror
  const y = elH / 2 + (clientY - rect.top - elH / 2) / ZOOM;
  return [(x - offsetX) / scale, (y - offsetY) / scale];
}

function renderFaces({ faces, target, locked, lost }) {
  const canvas = ui.facesOverlay;
  const { scale, offsetX, offsetY, elW, elH } = coverMapping();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(elW * dpr) || canvas.height !== Math.round(elH * dpr)) {
    canvas.width = Math.round(elW * dpr);
    canvas.height = Math.round(elH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, elW, elH);

  const several = faces.length > 1 || lost;
  if (several) {
    for (const face of faces) {
      const [x0, y0, x1, y1] = face.box.map((v, i) => (i % 2 ? offsetY : offsetX) + v * scale);
      const isTarget = face === target;
      ctx.lineWidth = isTarget ? 3 : 1.5;
      ctx.strokeStyle = isTarget ? '#ff5a36' : 'rgb(255 255 255 / 0.85)';
      ctx.setLineDash(isTarget ? [] : [6, 5]);
      ctx.beginPath();
      ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 12);
      ctx.stroke();
    }
  }
  ui.viewport.dataset.people = several ? 'many' : 'one';
  ui.peopleHint.hidden = !several;
  ui.peopleHint.textContent = lost
    ? 'The person you picked left the frame. Click a face to pick again.'
    : `${faces.length} people in view. ${locked ? 'Reading the outlined person. ' : 'Reading the closest person. '}Click a face to choose.`;
}

function selectPerson(event) {
  if (!inBrowser || !state.faceTargetReady || ui.viewport.dataset.camera !== 'on') return;
  if (event.target.closest('button, a')) return;
  const [x, y] = viewportToVideo(event.clientX, event.clientY);
  state.faceTarget.selectAt(x, y);
}

/* ---------- Model (browser engine) ---------- */

function loadModel() {
  getEngine()
    .load()
    .catch((error) => {
      console.error(error);
      ui.modelTag.textContent = 'Model failed to load';
      ui.modelTag.title = error.message;
    });
}

function modelStatusText(p) {
  switch (p.phase) {
    case 'init':
      return 'Model: starting…';
    case 'download':
      return `Model: downloading ${Math.round((100 * p.loaded) / p.total)}% of ${Math.round(p.total / 1e6)} MB`;
    case 'compile':
      return 'Model: preparing…';
    case 'ready':
      return `Model: in browser · ${p.label}`;
    default:
      return 'Model: not loaded';
  }
}

onModelProgress((p) => {
  state.model = p;
  ui.modelTag.textContent = modelStatusText(p);
  ui.modelTag.title = p.phase === 'ready' ? 'The video never leaves this browser.' : '';
  if (state.busy) ui.loadingNote.textContent = p.phase === 'ready' ? 'Reading your lips…' : modelStatusText(p).replace('Model: ', 'Loading model: ');
});

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
  ui.loadingNote.textContent =
    inBrowser && state.model.phase !== 'ready' ? modelStatusText(state.model).replace('Model: ', 'Loading model: ') : 'Reading your lips…';

  try {
    const result = await transcribe(clip);
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
  showVoiceNote('');
  speech.speak(entry.text, {
    voice: state.prefs.voice,
    sinkId: state.prefs.outputDevice || '',
    alsoLocal: state.prefs.alsoLocal !== false,
    onStart: () => setSpeaking(entry.id),
    onEnd: () => setSpeaking(null),
    onError: (error) => showVoiceNote(error.message, 'error'),
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

function showVoiceNote(text, tone = '') {
  ui.voiceNote.hidden = !text;
  ui.voiceNote.textContent = text;
  ui.voiceNote.dataset.tone = tone;
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Rebuild the Voice list: own voice, natural (server) voices, browser voices. */
function renderVoiceOptions() {
  const groups = [];
  const { enabled, presets } = state.serverVoices;
  if (enabled) {
    const own = new Option(voiceClone.loadSample() ? 'My voice' : 'My voice (set up first)', 'clone');
    own.disabled = !voiceClone.loadSample();
    const g = document.createElement('optgroup');
    g.label = 'Your voice';
    g.append(own);
    groups.push(g);
    const n = document.createElement('optgroup');
    n.label = 'Natural voices';
    n.append(...presets.map((v) => new Option(titleCase(v), `preset:${v}`)));
    groups.push(n);
  }
  if (state.systemVoices.length) {
    const english = state.systemVoices.filter((v) => v.lang.startsWith('en'));
    const others = state.systemVoices.filter((v) => !v.lang.startsWith('en'));
    const b = document.createElement('optgroup');
    b.label = 'Browser voices (offline)';
    b.append(new Option('System default', 'system:'), ...[...english, ...others].map((v) => new Option(`${v.name} (${v.lang})`, `system:${v.name}`)));
    groups.push(b);
  }
  ui.voiceSelect.replaceChildren(...groups);
  ui.voiceSelect.disabled = groups.length === 0;

  const values = [...ui.voiceSelect.querySelectorAll('option:not(:disabled)')].map((o) => o.value);
  if (!values.includes(state.prefs.voice)) {
    // Default: a natural voice when the server has them, else the browser default.
    state.prefs.voice = enabled && presets.length ? `preset:${presets[0]}` : 'system:';
  }
  ui.voiceSelect.value = state.prefs.voice;
  ui.cloneOpen.hidden = !enabled;
  updateOutputUI();
}

/** Output device picker: only for server voices, only where setSinkId exists. */
async function renderOutputOptions() {
  if (!speech.canPickOutput) return;
  const devices = await speech.outputDevices().catch(() => []);
  const options = devices.map((d, i) => {
    const label = d.label || (d.deviceId === 'default' ? 'System default' : `Output ${i + 1}`);
    return new Option(speech.isVirtualDevice(label) ? `${label} (virtual mic)` : label, d.deviceId === 'default' ? '' : d.deviceId);
  });
  if (!options.some((o) => o.value === '')) options.unshift(new Option('System default', ''));
  ui.outputSelect.replaceChildren(...options);
  if (![...ui.outputSelect.options].some((o) => o.value === state.prefs.outputDevice)) state.prefs.outputDevice = '';
  ui.outputSelect.value = state.prefs.outputDevice || '';
  updateOutputUI();
}

function updateOutputUI() {
  const serverVoice = state.prefs.voice === 'clone' || state.prefs.voice.startsWith('preset:');
  ui.outputField.hidden = !speech.canPickOutput || !serverVoice || ui.outputSelect.options.length < 2;
  ui.alsoLocalField.hidden = ui.outputField.hidden || !state.prefs.outputDevice;
  ui.alsoLocal.checked = state.prefs.alsoLocal !== false;
}

async function setupVoices() {
  speech.onVoices((voices) => {
    state.systemVoices = voices;
    renderVoiceOptions();
  });
  state.serverVoices = await speech.serverVoices();
  renderVoiceOptions();
  renderOutputOptions();
  navigator.mediaDevices?.addEventListener?.('devicechange', renderOutputOptions);
}

/* ---------- Your own voice ---------- */

function setCloneStatus(text, tone = '') {
  ui.cloneStatus.textContent = text;
  ui.cloneStatus.dataset.tone = tone;
}

function refreshCloneDialog() {
  const sample = voiceClone.loadSample();
  ui.cloneTest.hidden = !sample;
  ui.cloneDelete.hidden = !sample;
  ui.cloneRecord.disabled = !ui.cloneConsent.checked && !state.cloneRec;
  ui.cloneRecord.textContent = state.cloneRec ? 'Stop and save' : sample ? 'Record again' : 'Start recording';
  if (!state.cloneRec && !ui.cloneStatus.textContent) {
    setCloneStatus(sample ? `Your voice is saved (${new Date(sample.createdAt).toLocaleDateString()}).` : '');
  }
}

function openCloneDialog() {
  ui.cloneScript.textContent = voiceClone.SCRIPT;
  ui.cloneConsent.checked = Boolean(voiceClone.loadSample());
  setCloneStatus('');
  refreshCloneDialog();
  ui.cloneDialog.showModal();
}

async function toggleCloneRecording() {
  if (!state.cloneRec) {
    setCloneStatus('');
    try {
      state.cloneRec = await voiceClone.startSampleRecording({
        onLevel: (v) => (ui.cloneLevel.style.transform = `scaleX(${v})`),
        onLimit: () => state.cloneRec && toggleCloneRecording(),
      });
      setCloneStatus('Recording… read the text above, then press Stop and save.');
    } catch (error) {
      setCloneStatus(error.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it from the address bar.' : error.message, 'error');
    }
    refreshCloneDialog();
    return;
  }
  const rec = state.cloneRec;
  state.cloneRec = null;
  setCloneStatus('Processing…');
  refreshCloneDialog();
  try {
    const sample = await rec.stop();
    if (!voiceClone.saveSample(sample)) throw new Error("Couldn't save the recording in this browser (storage is full or blocked).");
    state.prefs.voice = 'clone';
    savePrefs(state.prefs);
    setCloneStatus(`Saved ${Math.round(sample.seconds)} seconds. Lipscribe will now speak in your voice.`);
    renderVoiceOptions();
  } catch (error) {
    setCloneStatus(error.message, 'error');
  }
  refreshCloneDialog();
}

/* ---------- History ---------- *//* ---------- History ---------- */

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

async function showModel() {
  if (inBrowser) {
    ui.modelTag.textContent = modelStatusText(state.model);
    $('privacy-note').textContent = 'Video never leaves this browser.';
    return;
  }
  ui.modelTag.title = `Clips go to ${config.transcribeUrl}`;
  $('endpoint-label').textContent = config.transcribeUrl;
  const target = new URL(config.transcribeUrl, location.href);
  if (target.origin !== location.origin) {
    ui.modelTag.textContent = 'Model: live';
    return;
  }
  try {
    const { mode } = await (await fetch('/api/status')).json();
    ui.modelTag.textContent = mode === 'proxy' ? 'Model: live' : 'Model: mock';
  } catch {
    ui.modelTag.textContent = 'Model: unknown';
  }
}

/* ---------- Events ---------- */

ui.cameraBtn.addEventListener('click', enableCamera);
ui.viewport.addEventListener('click', selectPerson);
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
  updateOutputUI();
});

ui.outputSelect.addEventListener('change', () => {
  state.prefs.outputDevice = ui.outputSelect.value;
  savePrefs(state.prefs);
  updateOutputUI();
  const label = ui.outputSelect.selectedOptions[0]?.textContent ?? '';
  showVoiceNote(speech.isVirtualDevice(label) ? 'Now choose the same cable as the microphone in your call app.' : '');
});

ui.alsoLocal.addEventListener('change', () => {
  state.prefs.alsoLocal = ui.alsoLocal.checked;
  savePrefs(state.prefs);
});

ui.cloneOpen.addEventListener('click', openCloneDialog);
ui.cloneConsent.addEventListener('change', refreshCloneDialog);
ui.cloneRecord.addEventListener('click', toggleCloneRecording);
ui.cloneTest.addEventListener('click', () => {
  speech.speak('Hi, this is how I sound in Lipscribe.', {
    voice: 'clone',
    sinkId: '',
    onStart: () => setCloneStatus('Generating…'),
    onEnd: () => {
      if (ui.cloneStatus.textContent === 'Generating…') setCloneStatus('');
      refreshCloneDialog();
    },
    onError: (error) => setCloneStatus(error.message, 'error'),
  });
});
ui.cloneDelete.addEventListener('click', () => {
  voiceClone.deleteSample();
  if (state.prefs.voice === 'clone') state.prefs.voice = '';
  savePrefs(state.prefs);
  setCloneStatus('Your voice recording was deleted from this browser.');
  renderVoiceOptions();
  refreshCloneDialog();
});
ui.cloneDialog.addEventListener('close', () => {
  state.cloneRec?.cancel();
  state.cloneRec = null;
  ui.cloneStatus.dataset.tone = '';
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

// Desktop app: global shortcut (works while a call app is in front).
window.lipscribeApp?.onToggleRecording(() => toggleRecording());

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (event.target.closest('button, input, select, textarea, a, [contenteditable]')) return;
  event.preventDefault();
  toggleRecording();
});

/* ---------- Start ---------- */

$('max-secs').textContent = config.maxRecordSeconds;
if (inBrowser) ui.gateBody.textContent = 'Lipscribe only needs video, and the video never leaves this browser.';
ui.autospeak.checked = state.prefs.autoSpeak;
setupVoices();
renderHistory();
if (state.history[0]) showEntry(state.history[0]);
showModel();

// Skip the button if the camera was already allowed on a previous visit.
navigator.permissions
  ?.query({ name: 'camera' })
  .then((permission) => permission.state === 'granted' && enableCamera())
  .catch(() => {});
