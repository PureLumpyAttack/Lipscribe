"""Target-person tracking vs chaplin's per-frame face choice.

Run from ml/:  uv run python -m pytest tests -q   (or: uv run python tests/test_tracking.py)
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lipscribe_ml.preprocess import Face, track_target  # noqa: E402


def face(x, y, size=100, tag=0.0):
    box = np.array([x, y, x + size, y + size], dtype=np.float32)
    kps = np.array([[x + 30, y + 35], [x + 70, y + 35], [x + 50, y + 55], [x + 50 + tag, y + 75]], dtype=np.float32)
    return Face(box=box, keypoints=kps, score=0.9)


def chaplin_pick(faces):
    """Exact selection logic from chaplin pipelines/detectors/mediapipe/detector.py."""
    face_points = []
    for idx, f in enumerate(faces):
        max_id, max_size = 0, 0  # reset every iteration (the bug)
        x, y, w, h = f.box[0], f.box[1], f.box[2] - f.box[0], f.box[3] - f.box[1]
        bbox_size = (w - x) + (h - y)
        if bbox_size > max_size:
            max_id, max_size = idx, bbox_size
        face_points.append(f.keypoints)
    return face_points[max_id]


def two_people_clip(n=40):
    """Person A on the left (big), person B on the right (small), both drifting.
    MediaPipe's output order follows detection confidence, which fluctuates, so
    the list order flips every 5 frames here. For typical positions chaplin's
    size test `(w - x) + (h - y)` is negative, so it just takes faces[0]."""
    frames = []
    for t in range(n):
        a = face(200 + t, 150, size=140, tag=0.0)
        b = face(480 - t, 160, size=90, tag=0.5)
        frames.append([a, b] if (t // 5) % 2 == 0 else [b, a])
    return frames


def who(kps):
    return "A" if kps[0][0] < 380 else "B"


def test_chaplin_switches_between_people():
    picks = [who(chaplin_pick(f)) for f in two_people_clip()]
    assert "A" in picks and "B" in picks  # the crop jumps between two mouths


def test_tracker_follows_largest():
    out = track_target(two_people_clip(), "largest")
    assert all(who(k) == "A" for k in out)


def test_tracker_follows_clicked_person():
    out = track_target(two_people_clip(), (520, 200))  # click on B in frame 0
    assert all(who(k) == "B" for k in out)


def test_tracker_never_substitutes_other_person():
    clip = two_people_clip()
    for t in range(10, 20):  # B leaves the frame for 10 frames
        clip[t] = [f for f in clip[t] if who([f.keypoints[0]]) == "A"]
    out = track_target(clip, (520, 200))
    assert all(k is None or who(k) == "B" for k in out)
    assert all(out[t] is None for t in range(10, 20))
    assert out[25] is not None and who(out[25]) == "B"  # picked up again when B returns


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok ", name)
