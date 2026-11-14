// Turn model outputs into text. Line-for-line port of ml/lipscribe_ml/decode.py
// (which matches espnet's BatchBeamSearch exactly on 196 test clips).
//
//   score(token) = (1 - ctcWeight) * decoderLogp + ctcWeight * ctcPrefixDelta
//
// No DOM access, so it also runs under Node for the parity tests.

const LOGZERO = -1e10;

function logaddexp(a, b) {
  const m = a > b ? a : b;
  if (m <= LOGZERO) return m;
  return m + Math.log1p(Math.exp(-Math.abs(a - b)));
}

export function tokensToText(ids, tokens) {
  return ids
    .map((i) => tokens[i])
    .join('')
    .replaceAll('<eos>', '')
    .replaceAll('▁', ' ')
    .trim();
}

/** Best token per frame, merge repeats, drop blanks. ctcLogp: Float32Array (T*V). */
export function ctcGreedy(ctcLogp, T, V, blank = 0) {
  const eos = V - 1;
  const out = [];
  let prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0;
    let bestV = -Infinity;
    const row = t * V;
    for (let v = 0; v < V; v++) {
      if (ctcLogp[row + v] > bestV) {
        bestV = ctcLogp[row + v];
        best = v;
      }
    }
    if (best !== prev && best !== blank && best !== eos) out.push(best);
    prev = best;
  }
  return out;
}

/** Indices of the k largest values of arr[offset .. offset+len). Unordered. */
function topK(arr, offset, len, k) {
  const idx = new Int32Array(k).fill(-1);
  const val = new Float64Array(k).fill(-Infinity);
  let minPos = 0;
  for (let i = 0; i < len; i++) {
    const x = arr[offset + i];
    if (x > val[minPos]) {
      val[minPos] = x;
      idx[minPos] = i;
      minPos = 0;
      for (let j = 1; j < k; j++) if (val[j] < val[minPos]) minPos = j;
    }
  }
  return idx;
}

/** CTC prefix scorer (espnet CTCPrefixScoreTH, batch 1, no attention window). */
class CTCPrefixScorer {
  constructor(ctcLogp, T, V, blank, eos) {
    this.x = ctcLogp;
    this.T = T;
    this.V = V;
    this.blank = blank;
    this.eos = eos;
  }

  /** State for the empty prefix: r (T x 2, [non-blank, blank]) and prefix score s. */
  initState() {
    const { T, V, x, blank } = this;
    const r = new Float64Array(T * 2);
    let acc = 0;
    for (let t = 0; t < T; t++) {
      acc += x[t * V + blank];
      r[t * 2] = LOGZERO;
      r[t * 2 + 1] = acc;
    }
    return { r, s: 0 };
  }

  /**
   * Score candidate tokens `cand[h]` for every hypothesis h.
   * Returns { delta: (N, V) Float64Array of score changes (LOGZERO for tokens
   * not scored, except eos), newState(h, k), logPsi(h, token) }.
   */
  score(outLen, lastIds, states, cand) {
    const { T, V, x, blank, eos } = this;
    const N = states.length;
    const K = cand[0].length;
    const start = Math.max(outLen, 1);
    const delta = new Float64Array(N * V).fill(LOGZERO);
    const rNew = new Array(N); // rNew[h]: Float64Array (T * 2 * K), layout [t][0|1][k]
    const psi = new Array(N); // psi[h]: Float64Array (K)
    const rSumEnd = new Float64Array(N);

    for (let h = 0; h < N; h++) {
      const rPrev = states[h].r;
      const sPrev = states[h].s;
      const c = cand[h];
      const rSum = new Float64Array(T);
      for (let t = 0; t < T; t++) rSum[t] = logaddexp(rPrev[t * 2], rPrev[t * 2 + 1]);
      rSumEnd[h] = rSum[T - 1];

      // logPhi[t][k]: prefix prob available to start token c[k] at frame t
      const r = new Float64Array(T * 2 * K).fill(LOGZERO);
      const logPhi = (t, k) => (c[k] === lastIds[h] ? rPrev[t * 2 + 1] : rSum[t]);
      if (outLen === 0) for (let k = 0; k < K; k++) r[k] = x[c[k]];
      for (let t = start; t < T; t++) {
        const base = t * 2 * K;
        const prev = (t - 1) * 2 * K;
        const xb = x[t * V + blank];
        for (let k = 0; k < K; k++) {
          r[base + k] = logaddexp(r[prev + k], logPhi(t - 1, k)) + x[t * V + c[k]];
          r[base + K + k] = logaddexp(r[prev + k], r[prev + K + k]) + xb;
        }
      }
      // psi[k] = logsumexp over t in [start, T) of logPhiShifted(t) + x[t, c[k]], plus r[start-1, 0, k]
      const p = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        let acc = r[(start - 1) * 2 * K + k];
        for (let t = start; t < T; t++) {
          const phi = t === 0 ? logPhi(0, k) : logPhi(t - 1, k);
          acc = logaddexp(acc, phi + x[t * V + c[k]]);
        }
        p[k] = acc;
        delta[h * V + c[k]] = acc - sPrev;
      }
      delta[h * V + eos] = rSum[T - 1] - sPrev;
      delta[h * V + blank] = LOGZERO;
      rNew[h] = r;
      psi[h] = p;
    }

    return {
      delta,
      newState: (h, k) => {
        const r = rNew[h];
        const out = new Float64Array(T * 2);
        for (let t = 0; t < T; t++) {
          out[t * 2] = r[t * 2 * K + k];
          out[t * 2 + 1] = r[t * 2 * K + K + k];
        }
        return { r: out, s: psi[h][k] };
      },
    };
  }
}

function endDetect(ended, i, mWindow = 3, dEnd = -10) {
  if (!ended.length) return false;
  let best = -Infinity;
  for (const h of ended) best = Math.max(best, h.score);
  let count = 0;
  for (let m = 0; m < mWindow; m++) {
    let bestSame = -Infinity;
    for (const h of ended) if (h.yseq.length === i - m) bestSame = Math.max(bestSame, h.score);
    if (bestSame > -Infinity && bestSame - best < dEnd) count++;
  }
  return count === mWindow;
}

/**
 * Joint attention/CTC beam search.
 * @param {(ys: number[][]) => Promise<Float32Array>} decoderStep  (N, L) prefixes -> (N*V) log-probs
 * @param {Float32Array} ctcLogp  (T*V)
 * @returns {Promise<number[]>} token ids without sos/eos
 */
export async function beamSearch(decoderStep, ctcLogp, T, V, { beam = 10, ctcWeight = 0.1, preBeamRatio = 1.5, maxLen = T } = {}) {
  const sos = V - 1;
  const eos = V - 1;
  const blank = 0;
  const ctc = new CTCPrefixScorer(ctcLogp, T, V, blank, eos);
  const preBeam = Math.floor(preBeamRatio * beam);

  let running = [{ yseq: [sos], score: 0, ctcState: ctc.initState() }];
  const ended = [];
  for (let i = 0; i < maxLen; i++) {
    const N = running.length;
    const dec = await decoderStep(running.map((h) => h.yseq));
    const cand = running.map((_, h) => Array.from(topK(dec, h * V, V, Math.min(preBeam, V))));
    const lastIds = running.map((h) => h.yseq[h.yseq.length - 1]);
    const { delta, newState } = ctc.score(running[0].yseq.length - 1, lastIds, running.map((h) => h.ctcState), cand);

    const weighted = new Float64Array(N * V);
    for (let h = 0; h < N; h++) {
      const s = running[h].score;
      for (let v = 0; v < V; v++) {
        const j = h * V + v;
        weighted[j] = (1 - ctcWeight) * dec[j] + ctcWeight * delta[j] + s;
      }
    }
    const top = Array.from(topK(weighted, 0, N * V, Math.min(beam, N * V))).filter((j) => j >= 0);
    top.sort((a, b) => weighted[b] - weighted[a]);

    const best = top.map((j) => {
      const h = Math.floor(j / V);
      const tok = j % V;
      const k = cand[h].indexOf(tok);
      const ctcState = tok !== eos && k >= 0 ? newState(h, k) : null;
      return { yseq: [...running[h].yseq, tok], score: weighted[j], ctcState };
    });

    if (i === maxLen - 1) for (const h of best) if (h.yseq[h.yseq.length - 1] !== eos) h.yseq.push(eos);
    running = [];
    for (const h of best) (h.yseq[h.yseq.length - 1] === eos ? ended : running).push(h);
    if (endDetect(ended, i) || !running.length) break;
  }
  if (!ended.length) return [];
  const winner = ended.reduce((a, b) => (b.score > a.score ? b : a));
  return winner.yseq.slice(1).filter((t) => t !== eos);
}
