"""Word error rate of each model variant on GRID clips and our own recordings.

Variants (pick with --variants):
  torch_lm      PyTorch + espnet beam search, beam 40, LM 0.3   (chaplin's exact setup)
  torch         PyTorch + espnet beam search, beam 40, no LM    (reference for our decoder)
  <prec>_b<N>   ONNX graphs in exports/<prec>/ + our NumPy beam search with beam N
  <prec>_greedy ONNX encoder + CTC greedy decoding
where <prec> is fp32, fp16, int8, q8, q4 or q4f16.

Datasets: grid, recordings (every speaker), recordings/<speaker> (one speaker).
Recordings live in data/recordings/clips/<speaker>/<id>.mp4.

Run from ml/:
  uv run python scripts/evaluate.py --datasets grid,recordings --variants torch,fp32_b40,fp32_b10,int8_b10
"""

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path

import jiwer
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.decode import beam_search, ctc_greedy, tokens_to_text  # noqa: E402
from lipscribe_ml.model import load_token_list  # noqa: E402
from lipscribe_ml.paths import CACHE_DIR, EXPORTS_DIR, GRID_DIR, ML_DIR, RECORDINGS_DIR, RESULTS_DIR  # noqa: E402


def normalize(text):
    text = text.lower().replace("'", "")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", text)).strip()


def load_dataset(name, limit=None):
    rows = []
    if name == "grid":
        with open(GRID_DIR / "manifest.csv") as f:
            rows = [{"id": r["id"], "path": ML_DIR / r["path"], "text": r["text"]} for r in csv.DictReader(f)]
    elif name == "recordings" or name.startswith("recordings/"):
        # data/recordings/clips/<speaker>/<id>.mp4; "recordings" = every speaker
        with open(RECORDINGS_DIR / "prompts.csv") as f:
            prompts = list(csv.DictReader(f))
        root = RECORDINGS_DIR / "clips"
        speakers = [name.split("/", 1)[1]] if "/" in name else sorted(p.name for p in root.iterdir() if p.is_dir())
        for spk in speakers:
            spk_rows = []
            for r in prompts:
                p = root / spk / f"{r['id']}.mp4"
                if p.exists():
                    spk_rows.append({"id": f"rec_{spk}_{r['id']}", "path": p, "text": r["text"], "dataset": f"recordings/{spk}"})
            rows += spk_rows[:limit] if limit else spk_rows
        return rows
    return rows[:limit] if limit else rows


def mouths_for(row):
    """Preprocess once and cache the 88x88 crops."""
    cache = CACHE_DIR / f"{row['id']}.npz"
    if cache.exists():
        z = np.load(cache, allow_pickle=True)
        return z["mouths"], z["info"].item()
    from lipscribe_ml.preprocess import video_to_mouths

    mouths, info = video_to_mouths(row["path"], return_debug=True)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, mouths=mouths, info=np.array(info, dtype=object))
    return mouths, info


class OnnxRunner:
    def __init__(self, precision):
        import onnxruntime as ort

        d = EXPORTS_DIR / precision
        so = ort.SessionOptions()
        so.log_severity_level = 3
        self.enc = ort.InferenceSession(str(d / "encoder.onnx"), so, providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(str(d / "decoder.onnx"), so, providers=["CPUExecutionProvider"])
        self.size_mb = sum((d / f"{g}.onnx").stat().st_size for g in ("encoder", "decoder")) / 1e6

    def encode(self, mouths):
        enc, ctc = self.enc.run(None, {"frames": mouths[None].astype(np.float32)})
        return enc, ctc[0]

    def step(self, ys, enc):
        return self.dec.run(None, {"ys": ys, "memory": enc})[0]


class TorchRunner:
    def __init__(self, use_lm, beam=40):
        import torch
        from espnet.nets.batch_beam_search import BatchBeamSearch
        from espnet.nets.scorers.length_bonus import LengthBonus
        from lipscribe_ml.model import PIXEL_MEAN, PIXEL_STD, load_e2e, load_lm

        self.torch = torch
        self.mean, self.std = PIXEL_MEAN, PIXEL_STD
        self.model, self.tokens = load_e2e()
        v = len(self.tokens)
        # Same construction as chaplin's pipelines/model.py:get_beam_search_decoder.
        scorers = self.model.scorers()
        scorers["lm"] = load_lm(v) if use_lm else None
        scorers["length_bonus"] = LengthBonus(v)
        self.bs = BatchBeamSearch(
            beam_size=beam, vocab_size=v,
            weights=dict(decoder=0.9, ctc=0.1, lm=0.3 if use_lm else 0.0, length_bonus=0.0),
            scorers=scorers, sos=v - 1, eos=v - 1, token_list=self.tokens, pre_beam_score_key="decoder",
        ).eval()

    def transcribe(self, mouths):
        torch = self.torch
        with torch.no_grad():
            x = (torch.from_numpy(mouths).float() / 255.0 - self.mean) / self.std
            enc = self.model.encode(x.unsqueeze(0))  # (T, D)
            hyps = self.bs(enc)
        ids = [int(t) for t in hyps[0].yseq[1:]] if hyps else []
        return tokens_to_text(ids, self.tokens)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", default="grid,recordings")
    ap.add_argument("--variants", default="torch,fp32_b40,fp32_b10,fp32_greedy")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--out", default="eval")
    args = ap.parse_args()

    tokens = load_token_list()
    rows = []
    for ds in args.datasets.split(","):
        for r in load_dataset(ds, args.limit):
            r.setdefault("dataset", ds)
            rows.append(r)
    print(f"{len(rows)} clips")

    # preprocess (cached)
    clips = []
    for r in rows:
        try:
            m, info = mouths_for(r)
            clips.append((r, m, info))
        except Exception as e:
            print(f"  skip {r['id']}: {e}")

    out_path = RESULTS_DIR / f"{args.out}.json"
    results = json.loads(out_path.read_text()) if out_path.exists() else {"clips": {}, "variants": {}}
    for variant in args.variants.split(","):
        print(f"== {variant}")
        if variant in ("torch", "torch_lm"):
            runner = TorchRunner(use_lm=variant == "torch_lm")
            size = None
        else:
            prec, mode = variant.rsplit("_", 1)
            runner = OnnxRunner(prec)
            size = runner.size_mb
        times = []
        for r, m, info in clips:
            t0 = time.perf_counter()
            if variant in ("torch", "torch_lm"):
                hyp = runner.transcribe(m)
            else:
                enc, ctc = runner.encode(m)
                if mode == "greedy":
                    ids = ctc_greedy(ctc, tokens)
                else:
                    ids = beam_search(runner.step, enc, ctc, beam=int(mode[1:]))
                hyp = tokens_to_text(ids, tokens)
            dt = time.perf_counter() - t0
            times.append(dt)
            c = results["clips"].setdefault(r["id"], {"dataset": r["dataset"], "ref": r["text"], "frames": int(len(m)), "info": info, "hyp": {}})
            c["hyp"][variant] = hyp
            print(f"  {r['id']:<22} {dt:5.2f}s  ref: {r['text']}\n  {'':<22}        hyp: {hyp}")
        results["variants"][variant] = {"size_mb": size, "mean_s": float(np.mean(times)) if times else None}
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(results, indent=1, default=str))

    summarize(results, RESULTS_DIR / f"{args.out}.md")


def wer(refs, hyps):
    if not refs:
        return None
    return jiwer.wer([normalize(r) or "_" for r in refs], [normalize(h) for h in hyps])


def summarize(results, md_path):
    datasets = sorted({c["dataset"] for c in results["clips"].values()})
    if sum(d.startswith("recordings/") for d in datasets) > 1:
        datasets.append("recordings (all)")
    variants = list(results["variants"])
    base = "fp32_b40" if "fp32_b40" in variants else None
    lines = ["| variant | size MB | s/clip (CPU) | " + " | ".join(f"WER {d}" for d in datasets) +
             (" | WER vs fp32_b40 |" if base else " |"),
             "|---|---|---|" + "---|" * len(datasets) + ("---|" if base else "")]
    for v in variants:
        meta = results["variants"][v]
        cells = [v, f"{meta['size_mb']:.0f}" if meta.get("size_mb") else "-", f"{meta['mean_s']:.2f}" if meta.get("mean_s") else "-"]
        for d in datasets:
            match = (lambda ds: ds.startswith("recordings/")) if d == "recordings (all)" else (lambda ds: ds == d)
            cs = [c for c in results["clips"].values() if match(c["dataset"]) and v in c["hyp"]]
            w = wer([c["ref"] for c in cs], [c["hyp"][v] for c in cs])
            cells.append(f"{100 * w:.1f}% (n={len(cs)})" if w is not None else "-")
        if base:
            cs = [c for c in results["clips"].values() if v in c["hyp"] and base in c["hyp"]]
            w = wer([c["hyp"][base] for c in cs], [c["hyp"][v] for c in cs]) if cs else None
            cells.append(f"{100 * w:.1f}%" if w is not None else "-")
        lines.append("| " + " | ".join(cells) + " |")
    md_path.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
