"""Decoding for the exported model, written to be ported line-for-line to JS.

`beam_search` reproduces espnet's BatchBeamSearch as configured by chaplin
(attention decoder + CTC prefix score, pre-beam on decoder scores, no LM):

  score(token) = (1 - ctc_weight) * decoder_logp + ctc_weight * ctc_prefix_delta

`ctc_greedy` is the cheap fallback: best token per frame, collapse repeats,
drop blanks.
"""

from dataclasses import dataclass, field

import numpy as np

LOGZERO = -1e10


def tokens_to_text(ids, tokens):
    text = "".join(tokens[i] for i in ids)
    return text.replace("<eos>", "").replace("▁", " ").strip()


def ctc_greedy(ctc_logp, tokens, blank=0):
    best = ctc_logp.argmax(-1)
    out, prev = [], -1
    for t in best:
        if t != prev and t != blank and t != len(tokens) - 1:
            out.append(int(t))
        prev = t
    return out


class CTCPrefixScorer:
    """Vectorised CTC prefix scoring (espnet CTCPrefixScoreTH, batch=1, no window)."""

    def __init__(self, ctc_logp, blank, eos):
        self.x = ctc_logp.astype(np.float32)  # (T, V)
        self.T = self.x.shape[0]
        self.blank, self.eos = blank, eos

    def init_state(self):
        r = np.full((self.T, 2), LOGZERO, dtype=np.float32)
        r[:, 1] = np.cumsum(self.x[:, self.blank])
        return r, np.float32(0.0)  # (r, prefix score s)

    def score(self, out_len, last_ids, states, cand):
        """out_len: prefix length without <sos>; last_ids (N,); states list of (r, s); cand (N, K).

        Returns delta scores (N, V) (LOGZERO outside cand except eos) and
        per-candidate states r_new (T, 2, N, K), log_psi (N, V).
        """
        T, x = self.T, self.x
        n, k = cand.shape
        r_prev = np.stack([s[0] for s in states], axis=1)  # (T, N, 2)
        s_prev = np.array([s[1] for s in states], dtype=np.float32)  # (N,)
        xc = x[:, cand]  # (T, N, K)
        xb = x[:, self.blank][:, None, None]  # (T, 1, 1)

        r_sum = np.logaddexp(r_prev[..., 0], r_prev[..., 1])  # (T, N)
        log_phi = np.repeat(r_sum[:, :, None], k, axis=2)  # (T, N, K)
        same = cand == last_ids[:, None]  # (N, K)
        if same.any():
            nn_, kk = np.nonzero(same)
            log_phi[:, nn_, kk] = r_prev[:, nn_, 1]

        r = np.full((T, 2, n, k), LOGZERO, dtype=np.float32)
        if out_len == 0:
            r[0, 0] = xc[0]
        start = max(out_len, 1)
        for t in range(start, T):
            r[t, 0] = np.logaddexp(r[t - 1, 0], log_phi[t - 1]) + xc[t]
            r[t, 1] = np.logaddexp(r[t - 1, 0], r[t - 1, 1]) + xb[t]

        log_phi_x = np.concatenate([log_phi[:1], log_phi[:-1]], axis=0) + xc
        stack = np.concatenate([log_phi_x[start:T], r[start - 1, 0][None]], axis=0)
        psi_c = np.logaddexp.reduce(stack, axis=0)  # (N, K)

        v = x.shape[1]
        log_psi = np.full((n, v), LOGZERO, dtype=np.float32)
        np.put_along_axis(log_psi, cand, psi_c, axis=1)
        log_psi[:, self.eos] = r_sum[T - 1]
        log_psi[:, self.blank] = LOGZERO
        return log_psi - s_prev[:, None], r, log_psi


@dataclass
class Hyp:
    yseq: list
    score: float
    ctc_state: tuple = field(repr=False, default=None)


def _end_detect(ended, i, m_window=3, d_end=np.log(np.exp(-10))):
    if not ended:
        return False
    best = max(h.score for h in ended)
    count = 0
    for m in range(m_window):
        same = [h.score for h in ended if len(h.yseq) == i - m]
        if same and max(same) - best < d_end:
            count += 1
    return count == m_window


def beam_search(decoder_step, enc, ctc_logp, beam=40, ctc_weight=0.1, pre_beam_ratio=1.5, maxlen=None):
    """decoder_step(ys (N, L) int64, enc) -> (N, V) log-probs. Returns best token ids (no sos/eos)."""
    v = ctc_logp.shape[1]
    sos = eos = v - 1
    blank = 0
    ctc = CTCPrefixScorer(ctc_logp, blank, eos)
    pre_beam = int(pre_beam_ratio * beam)
    maxlen = maxlen or ctc_logp.shape[0]

    running = [Hyp([sos], 0.0, ctc.init_state())]
    ended = []
    for i in range(maxlen):
        ys = np.array([h.yseq for h in running], dtype=np.int64)
        dec = decoder_step(ys, enc).astype(np.float32)  # (N, V)
        weighted = (1.0 - ctc_weight) * dec
        if pre_beam < v:
            cand = np.argpartition(-dec, pre_beam - 1, axis=1)[:, :pre_beam]
        else:
            cand = np.tile(np.arange(v), (len(running), 1))
        last = np.array([h.yseq[-1] for h in running])
        ctc_delta, r_new, log_psi = ctc.score(len(running[0].yseq) - 1, last, [h.ctc_state for h in running], cand)
        weighted += ctc_weight * ctc_delta
        weighted += np.array([h.score for h in running], dtype=np.float32)[:, None]

        flat = weighted.ravel()
        top = np.argpartition(-flat, beam - 1)[:beam] if flat.size > beam else np.arange(flat.size)
        top = top[np.argsort(-flat[top], kind="stable")]
        best = []
        for idx in top:
            h_i, tok = divmod(int(idx), v)
            pos = np.nonzero(cand[h_i] == tok)[0]
            if tok != eos and pos.size:
                state = (r_new[:, :, h_i, pos[0]], log_psi[h_i, tok])
            else:
                state = None  # eos ends the hyp; its CTC state is never used again
            best.append(Hyp(running[h_i].yseq + [tok], float(flat[idx]), state))

        if i == maxlen - 1:
            for h in best:
                if h.yseq[-1] != eos:
                    h.yseq.append(eos)
        running = []
        for h in best:
            (ended if h.yseq[-1] == eos else running).append(h)
        if _end_detect(ended, i) or not running:
            break

    if not ended:
        return []
    best = max(ended, key=lambda h: h.score)
    return [t for t in best.yseq[1:] if t != eos]
