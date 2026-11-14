"""Write fixtures for the browser parity test (web/test/lipread.test.mjs).

results/parity/decode/<id>.bin   uint8 mouth crops (T*88*88), from the evaluation cache
results/parity/decode.json       [{id, T, ref, python}]  python = q4 + beam 10 transcript (ONNX Runtime CPU)
results/parity/align/<id>.*      full grayscale frames, tracked keypoints and Python crops for 3 clips

Run from ml/ after evaluate.py has filled results/cache:
  uv run python scripts/dump_parity.py [--n 30]
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.decode import beam_search, tokens_to_text  # noqa: E402
from lipscribe_ml.model import load_token_list  # noqa: E402
from lipscribe_ml.paths import CACHE_DIR, ML_DIR, RESULTS_DIR  # noqa: E402
from lipscribe_ml import preprocess as pp  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate import OnnxRunner, load_dataset  # noqa: E402

OUT = RESULTS_DIR / "parity"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=30, help="clips for the decode test")
    args = ap.parse_args()

    rows = load_dataset("recordings") + load_dataset("grid")
    rows = rows[:: max(1, len(rows) // args.n)][: args.n]
    tokens = load_token_list()
    runner = OnnxRunner("q4")

    (OUT / "decode").mkdir(parents=True, exist_ok=True)
    meta = []
    for r in rows:
        cache = CACHE_DIR / f"{r['id']}.npz"
        if not cache.exists():
            print(f"  skip {r['id']} (not in cache; run evaluate.py first)")
            continue
        mouths = np.load(cache, allow_pickle=True)["mouths"].astype(np.uint8)
        enc, ctc = runner.encode(mouths)
        text = tokens_to_text(beam_search(runner.step, enc, ctc, beam=10), tokens)
        (OUT / "decode" / f"{r['id']}.bin").write_bytes(mouths.tobytes())
        meta.append({"id": r["id"], "T": int(len(mouths)), "ref": r["text"], "python": text})
        print(f"  {r['id']:<24} {text}")
    (OUT / "decode.json").write_text(json.dumps(meta, indent=1))

    # Alignment fixtures: run Python preprocessing step by step on 3 clips.
    (OUT / "align").mkdir(parents=True, exist_ok=True)
    align_meta = []
    for r in [rows[0], rows[len(rows) // 2], rows[-1]]:
        frames, fps = pp.read_video(r["path"])
        frames = pp.resample_fps(frames, fps)
        kps = pp.track_target(pp.detect_all(frames), "largest")
        crops = pp.crop_mouths(frames, kps)
        gray = np.stack([cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames])
        base = OUT / "align" / r["id"]
        base.with_suffix(".frames.bin").write_bytes(gray.tobytes())
        base.with_suffix(".crops.bin").write_bytes(crops.tobytes())
        align_meta.append({
            "id": r["id"], "T": int(len(frames)), "height": int(gray.shape[1]), "width": int(gray.shape[2]),
            "keypoints": [k.tolist() if k is not None else None for k in kps],
        })
    (OUT / "align.json").write_text(json.dumps(align_meta))
    print(f"wrote {len(meta)} decode + {len(align_meta)} align fixtures to {OUT.relative_to(ML_DIR)}")


if __name__ == "__main__":
    main()
