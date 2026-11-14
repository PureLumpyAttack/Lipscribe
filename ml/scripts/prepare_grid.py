"""Extract a fixed GRID subset and write data/grid/manifest.csv (id, path, text).

GRID (CC BY 4.0): https://zenodo.org/records/3625687
Run from ml/ after `bash scripts/download.sh grid`:
  uv run python scripts/prepare_grid.py --per-speaker 50 [--cleanup]
"""

import argparse
import csv
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.paths import GRID_DIR  # noqa: E402

SPEAKERS = ["s1", "s4"]


def real_files(names, exts):
    """Skip macOS junk (__MACOSX/, ._ AppleDouble files) bundled in the zips."""
    return [n for n in names if n.lower().endswith(exts) and "__MACOSX" not in n and not Path(n).name.startswith("._")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-speaker", type=int, default=50)
    ap.add_argument("--cleanup", action="store_true", help="delete the zips afterwards")
    args = ap.parse_args()

    zips = GRID_DIR / "_zips"
    with zipfile.ZipFile(zips / "alignments.zip") as az:
        aligns = {Path(n).parent.name + "/" + Path(n).stem: n for n in real_files(az.namelist(), (".align",))}
        rows = []
        for spk in SPEAKERS:
            with zipfile.ZipFile(zips / f"{spk}.zip") as vz:
                videos = sorted(real_files(vz.namelist(), (".mpg", ".mp4", ".avi")))
                videos = [v for v in videos if f"{spk}/{Path(v).stem}" in aligns]
                step = max(1, len(videos) // args.per_speaker)
                for v in videos[::step][: args.per_speaker]:
                    stem = Path(v).stem
                    words = [
                        line.split()[2]
                        for line in az.read(aligns[f"{spk}/{stem}"]).decode().splitlines()
                        if len(line.split()) == 3 and line.split()[2] not in ("sil", "sp")
                    ]
                    out = GRID_DIR / "clips" / spk / Path(v).name
                    out.parent.mkdir(parents=True, exist_ok=True)
                    if not out.exists():
                        out.write_bytes(vz.read(v))
                    rows.append({"id": f"grid_{spk}_{stem}", "path": str(out.relative_to(GRID_DIR.parent.parent)), "text": " ".join(words)})
    with open(GRID_DIR / "manifest.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "path", "text"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} clips to {GRID_DIR / 'manifest.csv'}")
    if args.cleanup:
        for z in zips.glob("*.zip"):
            z.unlink()


if __name__ == "__main__":
    main()
