"""Collect what the website needs into exports/web/ (served at /models/ by web/server.mjs).

  exports/web/q4f16/{encoder,decoder}.onnx   WebGPU with shader-f16 (default)
  exports/web/q4/{encoder,decoder}.onnx      WebGPU without f16, or WASM
  exports/web/tokens.json                    id -> subword ("▁" marks a word start)
  exports/web/preprocess.json                crop/alignment constants shared with Python

Run from ml/ after export_onnx.py + quantize.py:  uv run python scripts/package_web.py
"""

import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.model import CROP_SIZE, FPS, PIXEL_MEAN, PIXEL_STD, load_token_list  # noqa: E402
from lipscribe_ml.paths import EXPORTS_DIR  # noqa: E402
from lipscribe_ml.preprocess import _stable_reference  # noqa: E402

VARIANTS = ["q4f16", "q4"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    out = EXPORTS_DIR / "web"
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"variants": {}}
    for v in VARIANTS:
        (out / v).mkdir(exist_ok=True)
        manifest["variants"][v] = {}
        for g in ("encoder", "decoder"):
            src, dst = EXPORTS_DIR / v / f"{g}.onnx", out / v / f"{g}.onnx"
            if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
                shutil.copy2(src, dst)
            manifest["variants"][v][g] = {"bytes": dst.stat().st_size, "sha256": sha256(dst)[:16]}
    (out / "tokens.json").write_text(json.dumps(load_token_list(), ensure_ascii=False))
    (out / "preprocess.json").write_text(json.dumps({
        "fps": FPS,
        "crop": CROP_SIZE,
        "patch": 96,
        "alignSize": 256,
        "windowMargin": 12,
        "pixelMean": PIXEL_MEAN,
        "pixelStd": PIXEL_STD,
        # right eye, left eye, nose tip, mouth centre in the 256x256 aligned space
        "stableReference": _stable_reference().round(4).tolist(),
    }, indent=1))
    # Cache key for the browser: changes whenever any model file changes.
    manifest["version"] = hashlib.sha256(json.dumps(manifest["variants"], sort_keys=True).encode()).hexdigest()[:12]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    for p in sorted(out.rglob("*")):
        if p.is_file():
            print(f"  {p.relative_to(out)}  {p.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
