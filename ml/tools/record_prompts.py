"""Record labeled lip-reading test clips from the webcam.

Shows each sentence from data/recordings/prompts.csv over the camera feed.
Each clip is saved as data/recordings/clips/<speaker>/<id>.mp4, so the label is
the prompt with the same id. Clips are not committed to git (they contain your face).

Keys (focus the camera window):
  SPACE  start recording / stop and save
  R      redo the current sentence (discard the last save)
  N      skip to the next sentence
  B      go back one sentence
  Q/ESC  quit

Run from the ml/ folder, one --speaker name per person:
  uv run python tools/record_prompts.py --speaker alex            # start at first unrecorded prompt
  uv run python tools/record_prompts.py --speaker alex --start r10
"""

import argparse
import csv
import re
import time
from pathlib import Path

import cv2

ML_DIR = Path(__file__).resolve().parents[1]
PROMPTS = ML_DIR / "data" / "recordings" / "prompts.csv"
CLIPS_ROOT = ML_DIR / "data" / "recordings" / "clips"


def load_prompts():
    with open(PROMPTS, newline="") as f:
        return list(csv.DictReader(f))


def draw_text(img, text, org, scale, color, thickness=2):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thickness + 3, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness, cv2.LINE_AA)


def wrap(text, width=38):
    words, lines, line = text.split(), [], ""
    for w in words:
        if len(line) + len(w) + 1 > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    lines.append(line)
    return lines


def save_clip(path, frames, timestamps):
    if len(frames) < 10:
        return False
    fps = (len(timestamps) - 1) / (timestamps[-1] - timestamps[0])
    h, w = frames[0].shape[:2]
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for fr in frames:
        out.write(fr)
    out.release()
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--speaker", required=True, help="your name, lowercase, e.g. alex (clips go to clips/<speaker>/)")
    ap.add_argument("--start", help="prompt id to start at")
    ap.add_argument("--camera", type=int, default=0)
    args = ap.parse_args()

    speaker = re.sub(r"[^a-z0-9_-]", "", args.speaker.lower())
    if not speaker:
        raise SystemExit("--speaker must contain letters or digits")
    clips = CLIPS_ROOT / speaker
    prompts = load_prompts()
    clips.mkdir(parents=True, exist_ok=True)
    ids = [p["id"] for p in prompts]
    if args.start:
        idx = ids.index(args.start)
    else:
        idx = next((i for i, p in enumerate(prompts) if not (clips / f"{p['id']}.mp4").exists()), 0)

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
    if not cap.isOpened():
        raise SystemExit("Cannot open camera. Allow camera access for your terminal app in System Settings > Privacy & Security > Camera.")

    recording, frames, stamps = False, [], []
    while True:
        ok, frame = cap.read()
        if not ok:
            continue
        now = time.time()
        if recording:
            frames.append(frame.copy())
            stamps.append(now)

        p = prompts[idx]
        view = cv2.flip(frame, 1)
        done = sum((clips / f"{q['id']}.mp4").exists() for q in prompts)
        draw_text(view, f"{speaker}  {p['id']}  ({idx + 1}/{len(prompts)}, {done} recorded)", (20, 40), 0.8, (255, 255, 255))
        for i, line in enumerate(wrap(p["text"])):
            draw_text(view, line, (20, 100 + i * 50), 1.3, (0, 255, 255), 3)
        status = "REC  (SPACE to stop)" if recording else "SPACE record | R redo | N next | B back | Q quit"
        if (clips / f"{p['id']}.mp4").exists() and not recording:
            status = "saved  -  " + status
        draw_text(view, status, (20, view.shape[0] - 30), 0.8, (0, 0, 255) if recording else (255, 255, 255))
        if recording:
            cv2.circle(view, (view.shape[1] - 40, 40), 15, (0, 0, 255), -1)
        cv2.imshow("Lipscribe recorder", view)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if key == ord(" "):
            if not recording:
                recording, frames, stamps = True, [], []
            else:
                recording = False
                if save_clip(clips / f"{p['id']}.mp4", frames, stamps):
                    idx = min(idx + 1, len(prompts) - 1)
        elif not recording and key == ord("r"):
            (clips / f"{p['id']}.mp4").unlink(missing_ok=True)
        elif not recording and key == ord("n"):
            idx = min(idx + 1, len(prompts) - 1)
        elif not recording and key == ord("b"):
            idx = max(idx - 1, 0)

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
