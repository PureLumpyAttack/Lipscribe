// Runs the lip-reading model in the browser with ONNX Runtime Web.
//
// Picks the best setup the device supports:
//   WebGPU with shader-f16  -> q4f16 model (182 MB)
//   WebGPU without f16      -> q4 model (248 MB)
//   no WebGPU               -> q4 model on WASM (works, but slow)
// Model files are fetched once and kept in the Cache API, keyed by the
// manifest version, so later visits load from disk.

import { beamSearch, ctcGreedy, tokensToText } from './decode.js';

const ORT_VERSION = '1.31.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const CACHE_NAME = 'lipscribe-models';

async function pickBackend() {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        return adapter.features.has('shader-f16')
          ? { ep: 'webgpu', variant: 'q4f16', label: 'WebGPU · 4-bit' }
          : { ep: 'webgpu', variant: 'q4', label: 'WebGPU · 4-bit (fp32)' };
      }
    } catch {
      /* fall through to WASM */
    }
  }
  return { ep: 'wasm', variant: 'q4', label: 'CPU (WASM) · 4-bit' };
}

/** fetch with progress, served from the Cache API when present. */
async function fetchCached(url, version, onBytes) {
  const key = `${url}?v=${version}`;
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onBytes(buf.byteLength);
      return buf;
    }
  } catch {
    cache = null; // Cache API unavailable (private mode, http on a LAN IP, ...)
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url} (${response.status}).`);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received);
  }
  const buf = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) {
    buf.set(c, pos);
    pos += c.length;
  }
  if (cache) {
    try {
      // Drop older versions of this file, then store the new one.
      for (const req of await cache.keys()) if (req.url.startsWith(new URL(url, location.href).href + '?')) await cache.delete(req);
      await cache.put(key, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch (error) {
      console.warn('[lipscribe] Could not cache model file', error);
    }
  }
  return buf.buffer;
}

/**
 * @param {{ baseUrl: string, beam?: number, onProgress?: (p: {phase: string, loaded?: number, total?: number}) => void }} options
 */
export function createEngine({ baseUrl, beam = 10, onProgress = () => {} }) {
  let ready = null;
  let info = null;

  async function load() {
    onProgress({ phase: 'init' });
    const backend = await pickBackend();
    const ort = await import(`${ORT_BASE}${backend.ep === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.logLevel = 'error';

    const [manifest, tokens, prep] = await Promise.all(
      ['manifest.json', 'tokens.json', 'preprocess.json'].map((f) => fetch(baseUrl + f).then((r) => {
        if (!r.ok) throw new Error(`Model files are missing (${f}). Run ml/scripts/package_web.py.`);
        return r.json();
      })),
    );
    const files = manifest.variants[backend.variant];
    const total = files.encoder.bytes + files.decoder.bytes;
    const got = { encoder: 0, decoder: 0 };
    const report = () => onProgress({ phase: 'download', loaded: got.encoder + got.decoder, total });
    const [encBuf, decBuf] = await Promise.all(
      ['encoder', 'decoder'].map((g) =>
        fetchCached(`${baseUrl}${backend.variant}/${g}.onnx`, manifest.version, (n) => {
          got[g] = n;
          report();
        }),
      ),
    );

    onProgress({ phase: 'compile' });
    const opts = { executionProviders: [backend.ep], graphOptimizationLevel: 'all' };
    const encoder = await ort.InferenceSession.create(new Uint8Array(encBuf), opts);
    const decoder = await ort.InferenceSession.create(new Uint8Array(decBuf), opts);
    info = { ...backend, ort, encoder, decoder, tokens, prep, V: tokens.length };

    // Compile GPU shaders now rather than on the first real clip.
    await run(new Uint8Array(12 * prep.crop * prep.crop), 12, { warmup: true });
    onProgress({ phase: 'ready', label: backend.label });
    return info;
  }

  async function run(mouths, T, { warmup = false } = {}) {
    const { ort, encoder, decoder, tokens, prep, V } = info;
    const frames = new ort.Tensor('float32', Float32Array.from(mouths), [1, T, prep.crop, prep.crop]);
    const out = await encoder.run({ frames });
    const enc = out.enc;
    const ctcLogp = out.ctc_logp.data;

    const step = async (ys) => {
      const N = ys.length;
      const L = ys[0].length;
      const flat = new BigInt64Array(N * L);
      ys.forEach((y, n) => y.forEach((t, l) => (flat[n * L + l] = BigInt(t))));
      const res = await decoder.run({ ys: new ort.Tensor('int64', flat, [N, L]), memory: enc });
      return res.logp.data;
    };
    const ids = warmup
      ? (await step([[V - 1]]), [])
      : beam > 0
        ? await beamSearch(step, ctcLogp, T, V, { beam })
        : ctcGreedy(ctcLogp, T, V);
    return tokensToText(ids, tokens);
  }

  return {
    /** Start downloading/compiling; safe to call repeatedly. */
    load() {
      ready ??= load().catch((error) => {
        ready = null;
        throw error;
      });
      return ready;
    },
    get info() {
      return info;
    },
    /** mouths: Uint8Array T*88*88 grayscale crops (from align.cropMouths). */
    async transcribe(mouths, T) {
      await this.load();
      const t0 = performance.now();
      const text = await run(mouths, T);
      return { text, ms: performance.now() - t0 };
    },
  };
}
