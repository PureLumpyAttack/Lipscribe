"""Render presentation charts (PNG, 1920x1080) from results/*.md.

Writes results/charts/{light,dark}/*.png.

    uv run python scripts/make_charts.py
"""

from __future__ import annotations

import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.patches  # noqa: E402
import matplotlib.ticker  # noqa: E402
from matplotlib import font_manager  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"
OUT = RESULTS / "charts"

THEMES = {
    "light": dict(
        bg="#fcfcfb", text="#0b0b0b", text2="#52514e", muted="#8a8984",
        grid="#e4e3df", accent="#2a78d6", accent2="#eb6834", neutral="#c9c8c2",
        tile="#f2f1ee", quad="#e3f4dc",
    ),
    "dark": dict(
        bg="#1a1a19", text="#f0efec", text2="#c3c2b7", muted="#8f8e88",
        grid="#2f2f2d", accent="#3987e5", accent2="#d95926", neutral="#4a4a46",
        tile="#242423", quad="#22301f",
    ),
}

for name in ("Avenir Next", "Helvetica Neue", "Helvetica"):
    if any(name in f.name for f in font_manager.fontManager.ttflist):
        plt.rcParams["font.family"] = name
        break


def read_table(path: Path) -> dict[str, dict[str, str]]:
    lines = [l for l in path.read_text().splitlines() if l.startswith("|")]
    header = [c.strip() for c in lines[0].strip("|").split("|")]
    rows = {}
    for line in lines[2:]:
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows[cells[0]] = dict(zip(header, cells))
    return rows


def pct(cell: str) -> float:
    return float(re.match(r"([\d.]+)%", cell).group(1))


def new_fig(t):
    return plt.figure(figsize=(9.6, 5.4), dpi=200, facecolor=t["bg"])


def title(fig, t, head, sub):
    fig.text(0.06, 0.90, head, fontsize=22, fontweight="bold", color=t["text"], va="bottom")
    fig.text(0.06, 0.875, sub, fontsize=12, color=t["text2"], va="top")


def footer(fig, t, note):
    fig.text(0.06, 0.04, note, fontsize=8.5, color=t["muted"])


def style_axis(ax, t, grid_axis="x"):
    ax.set_facecolor(t["bg"])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors=t["text2"], length=0, labelsize=11)
    ax.grid(axis=grid_axis, color=t["grid"], linewidth=0.8)
    ax.set_axisbelow(True)


def bars(ax, positions, values, colors, horizontal, width=0.62):
    (ax.barh if horizontal else ax.bar)(positions, values, width, color=colors, linewidth=0)


# ---------------------------------------------------------------- charts

def chart_tradeoff(t, rec):
    """Accuracy vs download size, log x, in the style of a cost/quality scatter."""
    lm_mb = 215  # chaplin's language model, on top of the fp32 weights
    points = [  # (label, size MB, accuracy %, kind)
        ("fp32", float(rec["fp32_b10"]["size MB"]), rec["fp32_b10"], "other"),
        ("fp16", float(rec["fp16_b10"]["size MB"]), rec["fp16_b10"], "other"),
        ("q8", float(rec["q8_b10"]["size MB"]), rec["q8_b10"], "other"),
        ("int8", float(rec["int8_b10"]["size MB"]), rec["int8_b10"], "other"),
        ("q4", float(rec["q4_b10"]["size MB"]), rec["q4_b10"], "other"),
        ("q4f16 (website)", float(rec["q4f16_b10"]["size MB"]), rec["q4f16_b10"], "ours"),
        ("chaplin (PyTorch + LM, beam 40)", float(rec["fp32_b10"]["size MB"]) + lm_mb, rec["torch_lm"], "ref"),
    ]
    points = [(n, mb, 100 - pct(r["WER recordings (all)"]), k) for n, mb, r, k in points]

    fig = new_fig(t)
    title(fig, t, "Smallest model, most accurate",
          "Word accuracy on our recordings vs model download size (log scale)")
    ax = fig.add_axes([0.08, 0.15, 0.86, 0.60])
    style_axis(ax, t, "both")
    ax.set_xscale("log")
    xlim, ylim = (140, 1600), (78.5, 82.5)
    ax.set_xlim(*xlim); ax.set_ylim(*ylim)
    ticks = [150, 200, 300, 500, 700, 1000, 1500]
    ax.set_xticks(ticks, [f"{v:,} MB" for v in ticks])
    ax.xaxis.set_minor_locator(matplotlib.ticker.NullLocator())
    ax.set_yticks([79, 80, 81, 82], ["79%", "80%", "81%", "82%"])

    # Most attractive quadrant: smaller than fp16 and more accurate than full precision.
    full = next(a for n, _, a, _ in points if n == "fp32")
    half = next(mb for n, mb, _, _ in points if n == "fp16")
    ax.add_patch(matplotlib.patches.Rectangle(
        (xlim[0], full), half - xlim[0], ylim[1] - full, facecolor=t["quad"], edgecolor="none", zorder=0))

    # Pareto line: variants no other variant beats on both size and accuracy.
    front, best = [], -1.0
    for n, mb, a, _ in sorted(points, key=lambda p: (p[1], -p[2])):
        if a > best:
            front.append((mb, a)); best = a
    if len(front) > 1:
        ax.plot(*zip(*front), linestyle=(0, (1, 2.5)), color=t["text"], linewidth=1.6, zorder=2)

    colors = {"ours": t["accent"], "ref": t["accent2"], "other": t["neutral"]}
    offsets = {"fp32": (0, -14, "center", "top"), "fp16": (0, 12, "center", "bottom"),
               "q8": (0, -14, "center", "top"), "int8": (0, 12, "center", "bottom"),
               "q4": (10, 0, "left", "center"), "q4f16 (website)": (0, 14, "center", "bottom"),
               "chaplin (PyTorch + LM, beam 40)": (0, 14, "right", "bottom")}
    for n, mb, a, k in points:
        ax.scatter(mb, a, s=150 if k == "ours" else 110, color=colors[k], zorder=3, linewidth=0)
        dx, dy, ha, va = offsets[n]
        ax.annotate(f"{n}  {a:.1f}%", (mb, a), xytext=(dx, dy), textcoords="offset points",
                    ha=ha, va=va, fontsize=11.5, color=t["text"],
                    fontweight="bold" if k == "ours" else "normal")

    fig.patches.append(matplotlib.patches.Rectangle(
        (0.06, 0.787), 0.014, 0.025, transform=fig.transFigure, facecolor=t["quad"], edgecolor="none"))
    fig.text(0.08, 0.80, "Smaller than fp16 and more accurate than fp32",
             fontsize=10.5, color=t["text2"], va="center")
    footer(fig, t, "96 clips, 3 speakers, beam 10 unless noted. Chaplin's size is the fp32 weights plus its 215 MB language model.")
    return fig


def chart_speakers(t, rec):
    fig = new_fig(t)
    title(fig, t, "Reads 81% of words correctly from lips alone",
          "Word accuracy (100% − WER) per speaker, browser model (4-bit + fp16)")
    ax = fig.add_axes([0.08, 0.15, 0.86, 0.62])
    style_axis(ax, t, "y")
    row = rec["q4f16_b10"]
    items = [("Nathan", row["WER recordings/nathan"]), ("Kevin", row["WER recordings/kevin"]),
             ("Jiacai", row["WER recordings/jiacai"]), ("All speakers", row["WER recordings (all)"])]
    labels = [n for n, _ in items]
    acc = [100 - pct(c) for _, c in items]
    colors = [t["neutral"]] * 3 + [t["accent"]]
    x = range(len(items))
    bars(ax, x, acc, colors, horizontal=False, width=0.56)
    ax.set_xticks(list(x), labels)
    ax.get_xticklabels()[-1].set_fontweight("bold"); ax.get_xticklabels()[-1].set_color(t["text"])
    ax.set_ylim(0, 108)
    ax.set_yticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
    for xi, a in zip(x, acc):
        ax.text(xi, a + 2, f"{a:.1f}%", ha="center", va="bottom", fontsize=15,
                fontweight="bold", color=t["text"])
    footer(fig, t, "32 everyday sentences per speaker, recorded on a laptop webcam. No audio used.")
    return fig


def chart_decoding(t, rec):
    fig = new_fig(t)
    title(fig, t, "Beam 10: near-best accuracy, 3× faster than beam 40",
          "Word error rate on our recordings by decoding method (lower is better)")
    ax = fig.add_axes([0.08, 0.15, 0.86, 0.62])
    style_axis(ax, t, "y")
    items = [
        ("Greedy", rec["fp32_greedy"], None),
        ("Beam 10 (website)", rec["fp32_b10"], None),
        ("Beam 40", rec["fp32_b40"], None),
        ("Beam 40 + language model", rec["torch_lm"], "+215 MB"),
    ]
    wers = [pct(r["WER recordings (all)"]) for _, r, _ in items]
    colors = [t["neutral"], t["accent"], t["neutral"], t["neutral"]]
    x = range(len(items))
    bars(ax, x, wers, colors, horizontal=False, width=0.56)
    ax.set_xticks(list(x), [n for n, _, _ in items])
    ax.get_xticklabels()[1].set_fontweight("bold"); ax.get_xticklabels()[1].set_color(t["text"])
    ax.set_ylim(0, 30)
    ax.set_yticks([0, 10, 20, 30], ["0%", "10%", "20%", "30%"])
    for xi, w, (_, r, extra) in zip(x, wers, items):
        ax.text(xi, w + 0.6, f"{w:.1f}%", ha="center", va="bottom", fontsize=15,
                fontweight="bold", color=t["text"])
        note = extra or f"{float(r['s/clip (CPU)']):.1f} s / clip"
        ax.text(xi, w / 2, note, ha="center", va="center", fontsize=10.5,
                color="#ffffff" if colors[xi] == t["accent"] else t["text"])
    footer(fig, t, "fp32 model on CPU (Apple M3), 96 clips. Language model run in PyTorch, so its time is not comparable and is not shown.")
    return fig


def chart_stats(t, rec):
    fig = new_fig(t)
    fig.text(0.06, 0.86, "Lipscribe at a glance", fontsize=22, fontweight="bold", color=t["text"])
    acc = 100 - pct(rec["q4f16_b10"]["WER recordings (all)"])
    size = float(rec["q4f16_b10"]["size MB"])
    full = float(rec["fp32_b10"]["size MB"])
    tiles = [
        (f"{acc:.0f}%", "of words read correctly", "lips only, 3 speakers"),
        (f"{size:.0f} MB", "model in the browser", f"{full / size:.1f}× smaller than full size"),
        ("0 bytes", "of video uploaded", "everything runs on your device"),
        ("30 / 30", "transcripts match Python", "browser port checked clip by clip"),
    ]
    w, h, gap = 0.425, 0.32, 0.03
    for i, (big, line1, line2) in enumerate(tiles):
        cx = 0.06 + (i % 2) * (w + gap)
        cy = 0.44 - (i // 2) * (h + gap)
        ax = fig.add_axes([cx, cy, w, h])
        ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
        ax.add_patch(matplotlib.patches.FancyBboxPatch(
            (0, 0), 1, 1, boxstyle="round,pad=0,rounding_size=0.06", transform=ax.transAxes,
            facecolor=t["tile"], edgecolor="none", mutation_aspect=w / h * 0.56))
        ax.text(0.07, 0.60, big, fontsize=40, fontweight="bold",
                color=t["accent"] if i == 0 else t["text"], va="center")
        ax.text(0.07, 0.30, line1, fontsize=14, color=t["text"], va="center")
        ax.text(0.07, 0.14, line2, fontsize=11, color=t["text2"], va="center")
    return fig


def main():
    rec = read_table(RESULTS / "recordings.md")
    charts = {
        "1_at_a_glance": lambda t: chart_stats(t, rec),
        "2_accuracy_per_speaker": lambda t: chart_speakers(t, rec),
        "3_size_vs_accuracy": lambda t: chart_tradeoff(t, rec),
        "4_decoding": lambda t: chart_decoding(t, rec),
    }
    for theme, t in THEMES.items():
        (OUT / theme).mkdir(parents=True, exist_ok=True)
        for name, make in charts.items():
            fig = make(t)
            path = OUT / theme / f"{name}.png"
            fig.savefig(path, facecolor=t["bg"])
            plt.close(fig)
            print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
