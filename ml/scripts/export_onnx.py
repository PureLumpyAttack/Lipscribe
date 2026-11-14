"""Export the Auto-AVSR VSR model to two ONNX graphs and check them against PyTorch.

  exports/fp32/encoder.onnx   frames (1, T, 88, 88) float [0,255] -> enc (1, T, 768), ctc_logp (1, T, V)
  exports/fp32/decoder.onnx   ys (N, L) int64, memory (1, T, 768) -> logp (N, V)

--precision fp16 exports a .half() copy to exports/fp16/ (weights and compute in
float16, inputs/outputs stay float32), checked against the fp32 PyTorch model.

Run from ml/:  uv run python scripts/export_onnx.py [--precision fp16]
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.model import (  # noqa: E402
    DecoderStepForExport, EncoderForExport, limit_rel_pos_len, load_e2e, pointwise_convs_to_linear,
)
from lipscribe_ml.paths import EXPORTS_DIR  # noqa: E402

OPSET = 17


def export(module, args, path, input_names, output_names, dynamic_axes):
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        module, args, str(path),
        dynamo=False,
        opset_version=OPSET,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        do_constant_folding=True,
    )
    # Fold the external-data side files (if any) back into one file when small enough.
    import onnx
    model = onnx.load(str(path))
    size = sum(t.ByteSize() for t in model.graph.initializer)
    if size < 1.9e9:
        onnx.save_model(model, str(path), save_as_external_data=False)
        for f in path.parent.glob(path.name + "*.data"):
            f.unlink()
    print(f"  wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


def max_rel_diff(a, b):
    return float(np.abs(a - b).max() / (np.abs(a).max() + 1e-9))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-frames", type=int, default=1500, help="longest clip the graph accepts (25 fps)")
    ap.add_argument("--precision", choices=["fp32", "fp16"], default="fp32")
    args = ap.parse_args()
    args.out = EXPORTS_DIR / args.precision
    fp16 = args.precision == "fp16"

    torch.manual_seed(0)
    e2e, tokens = load_e2e()
    n_params = sum(p.numel() for p in e2e.parameters())
    n_enc = sum(p.numel() for p in e2e.encoder.parameters()) + sum(p.numel() for p in e2e.ctc.parameters())
    n_dec = sum(p.numel() for p in e2e.decoder.parameters())
    print(f"params: total {n_params / 1e6:.1f}M, encoder+ctc {n_enc / 1e6:.1f}M, decoder {n_dec / 1e6:.1f}M")
    limit_rel_pos_len(e2e, args.max_frames)

    # Conv1d(k=1) -> Linear so weight-only quantization reaches them; verify it changes nothing.
    probe = torch.rand(1, 40, 88, 88) * 255
    with torch.no_grad():
        before, _ = EncoderForExport(e2e).eval()(probe)
    n_mod = pointwise_convs_to_linear(e2e)
    with torch.no_grad():
        after, _ = EncoderForExport(e2e).eval()(probe)
    rewrite_diff = float((before - after).abs().max())
    print(f"rewrote {n_mod} conformer conv modules; max abs change {rewrite_diff:.2e}")
    assert rewrite_diff < 1e-4, "pointwise conv rewrite changed the output"

    enc_mod = EncoderForExport(e2e).eval()
    dec_mod = DecoderStepForExport(e2e).eval()
    if fp16:
        e2e_half, _ = load_e2e()  # fresh copy (deepcopy does not carry the patched forwards)
        limit_rel_pos_len(e2e_half, args.max_frames)
        pointwise_convs_to_linear(e2e_half)
        e2e_half.half()
        enc_exp, dec_exp = EncoderForExport(e2e_half).eval(), DecoderStepForExport(e2e_half).eval()
    else:
        enc_exp, dec_exp = enc_mod, dec_mod

    t_ex, l_ex = 50, 5
    frames = torch.rand(1, t_ex, 88, 88) * 255
    with torch.no_grad():
        enc_ex, _ = enc_mod(frames)
    ys = torch.randint(1, len(tokens) - 1, (3, l_ex))
    ys[:, 0] = len(tokens) - 1

    print("exporting encoder ...")
    export(enc_exp, (frames,), args.out / "encoder.onnx", ["frames"], ["enc", "ctc_logp"],
           {"frames": {1: "T"}, "enc": {1: "T"}, "ctc_logp": {1: "T"}})
    print("exporting decoder ...")
    export(dec_exp, (ys, enc_ex), args.out / "decoder.onnx", ["ys", "memory"], ["logp"],
           {"ys": {0: "N", 1: "L"}, "memory": {1: "T"}, "logp": {0: "N"}})

    # ---- parity: different shapes from the ones used for tracing
    so = ort.SessionOptions()
    enc_sess = ort.InferenceSession(str(args.out / "encoder.onnx"), so, providers=["CPUExecutionProvider"])
    dec_sess = ort.InferenceSession(str(args.out / "decoder.onnx"), so, providers=["CPUExecutionProvider"])
    report = {"params_total": n_params, "params_encoder_ctc": n_enc, "params_decoder": n_dec, "checks": []}
    for t, n, l in [(23, 1, 1), (75, 4, 9), (160, 10, 17)]:
        fr = torch.rand(1, t, 88, 88) * 255
        y = torch.randint(1, len(tokens) - 1, (n, l))
        y[:, 0] = len(tokens) - 1
        with torch.no_grad():
            pe, pc = enc_mod(fr)
            pd = dec_mod(y, pe)
        t0 = time.perf_counter()
        oe, oc = enc_sess.run(None, {"frames": fr.numpy()})
        t_enc = time.perf_counter() - t0
        t0 = time.perf_counter()
        (od,) = dec_sess.run(None, {"ys": y.numpy(), "memory": oe})
        t_dec = time.perf_counter() - t0
        row = {
            "T": t, "N": n, "L": l,
            "enc_max_abs": float(np.abs(pe.numpy() - oe).max()),
            "ctc_max_abs": float(np.abs(pc.numpy() - oc).max()),
            "dec_max_abs": float(np.abs(pd.numpy() - od).max()),
            "dec_argmax_match": float((pd.numpy().argmax(-1) == od.argmax(-1)).mean()),
            "ort_cpu_enc_s": round(t_enc, 3), "ort_cpu_dec_s": round(t_dec, 3),
        }
        report["checks"].append(row)
        print("  parity", row)
    (args.out / "export_report.json").write_text(json.dumps(report, indent=2))
    if fp16:  # compared with fp32 PyTorch, so only rough agreement is expected
        ok = all(r["dec_argmax_match"] >= 0.9 for r in report["checks"])
    else:
        ok = all(r["enc_max_abs"] < 1e-3 and r["dec_max_abs"] < 1e-3 for r in report["checks"])
    print("PARITY OK" if ok else "PARITY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
