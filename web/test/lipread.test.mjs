// Parity tests: the browser lip-reading code (public/js/lipread/) against the
// Python pipeline in ../ml. Runs the q4 model with onnxruntime-web's WASM
// backend, the same runtime the page falls back to without WebGPU.
//
// Needs fixtures from:  cd ../ml && uv run python scripts/dump_parity.py
// Run:                  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as ort from 'onnxruntime-web';
import { beamSearch, tokensToText } from '../public/js/lipread/decode.js';
import { cropMouths, resampleByTime, similarityTransform } from '../public/js/lipread/align.js';

const ML = fileURLToPath(new URL('../../ml/', import.meta.url));
const PARITY = `${ML}results/parity/`;
const MODELS = `${ML}exports/web/`;
const haveFixtures = existsSync(`${PARITY}decode.json`) && existsSync(`${MODELS}q4/encoder.onnx`);
const skip = haveFixtures ? false : 'run ml/scripts/package_web.py and ml/scripts/dump_parity.py first';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readBytes = (p) => new Uint8Array(readFileSync(p));

function wer(ref, hyp) {
  const norm = (s) => s.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}

test('similarityTransform recovers a known rotation + scale + shift', () => {
  const src = [[10, 20], [60, 25], [35, 60], [36, 85]];
  const [a, b, tx, ty] = [1.3 * Math.cos(0.2), 1.3 * Math.sin(0.2), 7, -4];
  const dst = src.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty]);
  const M = similarityTransform(src, dst);
  [a, -b, tx, b, a, ty].forEach((v, i) => assert.ok(Math.abs(M[i] - v) < 1e-9));
});

test('resampleByTime picks 25 fps frames from a 30 fps capture', () => {
  const ts = Array.from({ length: 61 }, (_, i) => i * (1000 / 30)); // 2 s
  const picks = resampleByTime(ts, 25);
  assert.equal(picks.length, 51);
  assert.equal(picks[0], 0);
  assert.equal(picks.at(-1), 60);
});

test('mouth crops match Python', { skip }, () => {
  const prep = readJson(`${MODELS}preprocess.json`);
  for (const clip of readJson(`${PARITY}align.json`)) {
    const frames = readBytes(`${PARITY}align/${clip.id}.frames.bin`);
    const expected = readBytes(`${PARITY}align/${clip.id}.crops.bin`);
    const { T, width, height } = clip;
    const regions = Array.from({ length: T }, (_, i) => ({
      data: frames.subarray(i * width * height, (i + 1) * width * height),
      width, height, scale: 1, ox: 0, oy: 0,
    }));
    const crops = cropMouths(regions, clip.keypoints, prep);
    assert.equal(crops.length, expected.length);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < crops.length; i++) {
      const d = Math.abs(crops[i] - expected[i]);
      sum += d;
      max = Math.max(max, d);
    }
    const mean = sum / crops.length;
    console.log(`  ${clip.id}: mean |diff| ${mean.toFixed(3)}, max ${max} (0-255)`);
    assert.ok(mean < 1, `mean pixel difference ${mean} too large`); // OpenCV uses 5-bit fixed-point bilinear
  }
});

test('transcripts match Python (q4, beam 10, WASM)', { skip, timeout: 30 * 60_000 }, async () => {
  ort.env.logLevel = 'error';
  const tokens = readJson(`${MODELS}tokens.json`);
  const V = tokens.length;
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const encoder = await ort.InferenceSession.create(readBytes(`${MODELS}q4/encoder.onnx`), opts);
  const decoder = await ort.InferenceSession.create(readBytes(`${MODELS}q4/decoder.onnx`), opts);

  let same = 0;
  const totals = { js: { errors: 0, words: 0 }, py: { errors: 0, words: 0 } };
  const clips = readJson(`${PARITY}decode.json`);
  for (const clip of clips) {
    const mouths = readBytes(`${PARITY}decode/${clip.id}.bin`);
    const t0 = performance.now();
    const out = await encoder.run({ frames: new ort.Tensor('float32', Float32Array.from(mouths), [1, clip.T, 88, 88]) });
    const step = async (ys) => {
      const flat = BigInt64Array.from(ys.flat().map(BigInt));
      const res = await decoder.run({ ys: new ort.Tensor('int64', flat, [ys.length, ys[0].length]), memory: out.enc });
      return res.logp.data;
    };
    const text = tokensToText(await beamSearch(step, out.ctc_logp.data, clip.T, V, { beam: 10 }), tokens);
    const ms = performance.now() - t0;
    if (text === clip.python) same++;
    for (const [k, hyp] of [['js', text], ['py', clip.python]]) {
      const w = wer(clip.ref, hyp);
      totals[k].errors += w.errors;
      totals[k].words += w.words;
    }
    console.log(`  ${text === clip.python ? '=' : '≠'} ${clip.id.padEnd(24)} ${String(Math.round(ms)).padStart(5)} ms  js: ${text}${text === clip.python ? '' : `\n${' '.repeat(36)}py: ${clip.python}`}`);
  }
  const werJs = totals.js.errors / totals.js.words;
  const werPy = totals.py.errors / totals.py.words;
  console.log(`  identical ${same}/${clips.length}; WER js ${(100 * werJs).toFixed(1)}% vs python ${(100 * werPy).toFixed(1)}%`);
  // Different CPU kernels (WASM vs native MLAS) can flip a near-tie, so allow a little drift.
  assert.ok(same >= 0.9 * clips.length, `only ${same}/${clips.length} transcripts identical`);
  assert.ok(Math.abs(werJs - werPy) < 0.02, 'WER drifted by 2 points or more');
});
