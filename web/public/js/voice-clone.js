// Records the user's own voice sample for the cloned voice.
//
// The sample is recorded live from the microphone (no file upload), with the
// user reading a script that starts with a consent statement. It is stored
// only in this browser and sent along with each speech request (OpenRouter
// voice cloning is stateless; the server keeps nothing).

const SAMPLE_KEY = 'lipscribe.voiceSample.v1';
const SAMPLE_RATE = 24000;
export const MIN_SECONDS = 8;
export const MAX_SECONDS = 40;

export const SCRIPT =
  'I am recording my own voice so Lipscribe can speak for me, and I agree to it being used to create speech in my voice. ' +
  'Bright morning light poured through the window as we packed six jars of plum jam, a quiet box of old books, ' +
  'and a warm blue jacket for the long drive home.';

export function loadSample() {
  try {
    const s = JSON.parse(localStorage.getItem(SAMPLE_KEY));
    return s?.audio?.startsWith('data:audio/') ? s : null;
  } catch {
    return null;
  }
}

export function saveSample(sample) {
  try {
    localStorage.setItem(SAMPLE_KEY, JSON.stringify(sample));
    return true;
  } catch {
    return false; // storage full or blocked
  }
}

export function deleteSample() {
  try {
    localStorage.removeItem(SAMPLE_KEY);
  } catch {
    /* ignore */
  }
}

/** 16-bit mono WAV from Float32 samples. */
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function toDataUri(bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** Recorded blob (webm/opus, mp4/aac, ...) -> 24 kHz mono WAV data URI, peak-normalised. */
async function blobToWav(blob) {
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  await ctx.close();
  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE); // mixes down to mono
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  let peak = 0;
  for (const s of mono) peak = Math.max(peak, Math.abs(s));
  if (peak < 0.02) throw new Error("The recording is almost silent. Check that the right microphone is selected.");
  const gain = Math.min(0.9 / peak, 8);
  for (let i = 0; i < mono.length; i++) mono[i] *= gain;
  return { audio: toDataUri(encodeWav(mono, SAMPLE_RATE), 'audio/wav'), seconds: decoded.duration };
}

/**
 * Start recording from the microphone.
 * onLevel(0..1) is called ~30 times a second for a level meter.
 * Returns { stop(): Promise<{audio, transcript, seconds}>, cancel() }.
 */
export async function startSampleRecording({ onLevel = () => {}, onLimit = () => {} } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let raf = 0;
  const meter = () => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const s of data) sum += s * s;
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 6));
    raf = requestAnimationFrame(meter);
  };
  meter();

  const started = performance.now();
  const limit = setTimeout(onLimit, MAX_SECONDS * 1000);
  recorder.start(250);

  const cleanup = () => {
    clearTimeout(limit);
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    onLevel(0);
  };

  return {
    get seconds() {
      return (performance.now() - started) / 1000;
    },
    stop() {
      return new Promise((resolve, reject) => {
        recorder.onstop = async () => {
          cleanup();
          try {
            const wav = await blobToWav(new Blob(chunks, { type: recorder.mimeType }));
            if (wav.seconds < MIN_SECONDS) throw new Error(`That was ${wav.seconds.toFixed(0)} seconds. Read the whole text (at least ${MIN_SECONDS} seconds).`);
            resolve({ ...wav, transcript: SCRIPT, createdAt: Date.now() });
          } catch (error) {
            reject(error);
          }
        };
        recorder.stop();
      });
    },
    cancel() {
      recorder.onstop = cleanup;
      recorder.stop();
    },
  };
}
