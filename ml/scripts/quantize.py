"""Build quantized variants of the exported fp32 ONNX graphs.

  (exports/fp16 comes from `export_onnx.py --precision fp16`, not from here)
  exports/int8    dynamic int8, MatMul only (Conv stays fp32; ORT CPU format, not WebGPU)
  exports/q8      8-bit block-wise weight-only MatMulNBits (fp32 compute)
  exports/q4      4-bit block-wise weight-only MatMulNBits (fp32 compute)
  exports/q4f16   4-bit MatMulNBits applied to the fp16 export (typical WebGPU format)

Run from ml/:  uv run python scripts/quantize.py [--only q4,q4f16]
"""

import argparse
import shutil
import sys
from pathlib import Path

import onnx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.paths import EXPORTS_DIR  # noqa: E402

GRAPHS = ["encoder", "decoder"]


def nbits(model, bits):
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    q = MatMulNBitsQuantizer(model, block_size=32, is_symmetric=True, bits=bits)
    q.process()
    return q.model.model


def int8_dynamic(src, dst):
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(src), str(dst), op_types_to_quantize=["MatMul"], weight_type=QuantType.QInt8, per_channel=True)


def save(model, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, str(path), save_as_external_data=False)
    print(f"  {path.relative_to(EXPORTS_DIR)}: {path.stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="int8,q8,q4,q4f16")
    args = ap.parse_args()
    wanted = args.only.split(",")
    src_dir = EXPORTS_DIR / "fp32"

    for g in GRAPHS:
        src = src_dir / f"{g}.onnx"
        print(f"{g}: fp32 {src.stat().st_size / 1e6:.1f} MB")
        for variant in wanted:
            dst = EXPORTS_DIR / variant / f"{g}.onnx"
            try:
                if variant == "int8":
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    int8_dynamic(src, dst)
                    print(f"  int8/{g}.onnx: {dst.stat().st_size / 1e6:.1f} MB")
                elif variant == "q8":
                    save(nbits(onnx.load(str(src)), 8), dst)
                elif variant == "q4":
                    save(nbits(onnx.load(str(src)), 4), dst)
                elif variant == "q4f16":
                    save(nbits(onnx.load(str(EXPORTS_DIR / "fp16" / f"{g}.onnx")), 4), dst)
            except Exception as e:  # keep going so one bad variant doesn't block the rest
                print(f"  {variant}/{g}: FAILED: {type(e).__name__}: {e}")
                shutil.rmtree(dst.parent, ignore_errors=True) if not any(dst.parent.glob("*.onnx")) else None


if __name__ == "__main__":
    main()
