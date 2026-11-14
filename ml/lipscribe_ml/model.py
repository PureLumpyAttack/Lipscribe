"""Load the Auto-AVSR visual speech recognition model and wrap it for ONNX export."""

import argparse
import json
import sys

import torch

from .paths import CHAPLIN_DIR, TOKENS_FILE, VSR_MODEL_DIR, LM_MODEL_DIR

if str(CHAPLIN_DIR) not in sys.path:
    sys.path.insert(0, str(CHAPLIN_DIR))

# Pixel normalisation used in training (pipelines/data/transforms.py).
PIXEL_MEAN = 0.421
PIXEL_STD = 0.165
CROP_SIZE = 88
FPS = 25


def load_token_list():
    units = TOKENS_FILE.read_text().splitlines()
    return ["<blank>"] + [u.split()[0] for u in units] + ["<eos>"]


def load_e2e(model_dir=VSR_MODEL_DIR):
    """Return (espnet E2E model in eval mode, token list)."""
    from espnet.nets.pytorch_backend.e2e_asr_transformer import E2E

    confs = json.loads((model_dir / "model.json").read_text())
    args = argparse.Namespace(**(confs if isinstance(confs, dict) else confs[2]))
    tokens = load_token_list()
    model = E2E(len(tokens), args)
    state = torch.load(model_dir / "model.pth", map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    model.eval()
    return model, tokens


def load_lm(n_vocab, lm_dir=LM_MODEL_DIR):
    from espnet.asr.asr_utils import get_model_conf, torch_load
    from espnet.nets.lm_interface import dynamic_import_lm

    lm_args = get_model_conf(str(lm_dir / "model.pth"), str(lm_dir / "model.json"))
    lm_class = dynamic_import_lm(getattr(lm_args, "model_module", "default"), lm_args.backend)
    lm = lm_class(n_vocab, lm_args)
    torch_load(str(lm_dir / "model.pth"), lm)
    lm.eval()
    return lm


def limit_rel_pos_len(e2e, max_frames):
    """Shrink the relative positional table so the exported graph stays small.

    The table holds 2*max_frames-1 rows of 768 floats. 5000 frames (default) adds
    ~30 MB to the ONNX file; 1500 frames (60 s at 25 fps) adds ~9 MB.
    """
    embed = e2e.encoder.embed
    pos = embed[-1] if isinstance(embed, torch.nn.Sequential) else embed
    pos.pe = None
    pos.extend_pe(torch.tensor(0.0).expand(1, max_frames))
    return 2 * max_frames - 1


def pointwise_convs_to_linear(e2e):
    """Rewrite each Conformer ConvolutionModule so its 1x1 convs are Linear layers.

    Same maths (a kernel-1 Conv1d is a per-frame matrix multiply; GLU over the
    channel axis becomes GLU over the last axis), but the graph gets MatMul
    nodes instead of Conv. Weight-only quantizers (MatMulNBits) only handle
    MatMul, so this lets 4/8-bit quantization cover these ~21M parameters.
    """
    import types

    from espnet.nets.pytorch_backend.transformer.convolution import ConvolutionModule

    def to_linear(conv):
        lin = torch.nn.Linear(conv.in_channels, conv.out_channels, bias=conv.bias is not None)
        lin.weight.data.copy_(conv.weight.data[:, :, 0])
        if conv.bias is not None:
            lin.bias.data.copy_(conv.bias.data)
        return lin.to(conv.weight.dtype)

    def forward(self, x):  # x: (batch, time, channels)
        x = torch.nn.functional.glu(self.pointwise_lin1(x), dim=-1)
        x = x.transpose(1, 2)
        x = self.activation(self.norm(self.depthwise_conv(x)))
        return self.pointwise_lin2(x.transpose(1, 2))

    n = 0
    for m in e2e.modules():
        if isinstance(m, ConvolutionModule):
            m.pointwise_lin1 = to_linear(m.pointwise_cov1)
            m.pointwise_lin2 = to_linear(m.pointwise_cov2)
            del m.pointwise_cov1, m.pointwise_cov2
            m.forward = types.MethodType(forward, m)
            n += 1
    return n


class EncoderForExport(torch.nn.Module):
    """frames (1, T, 88, 88) float32 in [0, 255] -> encoder features + CTC log-probs.

    Pixel normalisation is folded into the graph so the browser only has to
    supply the grayscale mouth crops.
    """

    def __init__(self, e2e):
        super().__init__()
        self.encoder = e2e.encoder
        self.ctc_lo = e2e.ctc.ctc_lo

    def forward(self, frames):
        dtype = self.ctc_lo.weight.dtype  # float16 when exporting a .half() model
        x = (frames / 255.0 - PIXEL_MEAN) / PIXEL_STD
        x = x.unsqueeze(1).to(dtype)  # (B, C=1, T, H, W)
        enc, _ = self.encoder(x, None)
        ctc_logp = torch.log_softmax(self.ctc_lo(enc).float(), dim=-1)
        return enc.float(), ctc_logp


class DecoderStepForExport(torch.nn.Module):
    """One attention-decoder step for a batch of beam hypotheses.

    ys (N, L) int64 prefix tokens (starting with <sos>), memory (1, T, D)
    -> log-probs (N, V) of the next token. No KV cache: the full prefix is
    recomputed each step, which keeps the graph simple; prefixes are short.
    """

    def __init__(self, e2e):
        super().__init__()
        self.decoder = e2e.decoder

    def forward(self, ys, memory):
        n, length = ys.shape
        dtype = self.decoder.output_layer.weight.dtype
        mem = memory.to(dtype).expand(n, -1, -1)
        mask = torch.tril(torch.ones(length, length, dtype=torch.bool, device=ys.device)).unsqueeze(0)
        logp, _ = self.decoder.forward_one_step(ys, mask, mem, None, cache=None)
        return logp.float()
