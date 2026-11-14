"""Video -> aligned 88x88 grayscale mouth crops, following one chosen person.

Port of chaplin's mediapipe pipeline (pipelines/detectors/mediapipe/*) with
three changes:

1. Face choice. Chaplin re-picks a face in every frame independently. Its
   "largest face" test is broken (`max_id, max_size = 0, 0` is reset inside
   the loop and the size is computed as `(w - x) + (h - y)`), so in practice it
   takes whichever face MediaPipe lists first, which follows detection
   confidence and can change from frame to frame. With two people in view the
   crop can jump between them. Here all faces are detected, one target is chosen once
   (largest face, or the face under a clicked point), and it is tracked by box
   overlap from frame to frame.
2. Frame rate. Video is resampled to the model's 25 fps. Chaplin records at
   16 fps but tells the model the clip is 25 fps, so speech looks ~1.5x faster.
3. Detector. Uses the MediaPipe Tasks FaceDetector (BlazeFace short-range), the
   same model and API the browser build uses, so Python and web crops match.

The alignment and crop maths (similarity transform of eyes/nose/mouth onto a
mean face, 96x96 patch around the mouth, centre crop to 88x88) is unchanged.
"""

from dataclasses import dataclass
import os
import urllib.request

os.environ.setdefault("GLOG_minloglevel", "2")  # silence MediaPipe/LiteRT INFO logs

import cv2
import numpy as np

from .paths import FACE_DETECTOR_MODEL, FACE_DETECTOR_URL, MEAN_FACE
from .model import CROP_SIZE, FPS


@dataclass
class Face:
    box: np.ndarray  # x0, y0, x1, y1 in pixels
    keypoints: np.ndarray  # (4, 2): right eye, left eye, nose tip, mouth centre
    score: float

    @property
    def area(self):
        return float(max(0, self.box[2] - self.box[0]) * max(0, self.box[3] - self.box[1]))

    def contains(self, x, y):
        return self.box[0] <= x <= self.box[2] and self.box[1] <= y <= self.box[3]


# ---------------------------------------------------------------- video I/O


def read_video(path):
    """Return (frames RGB uint8 (T, H, W, 3), fps)."""
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or FPS
    frames = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    cap.release()
    if not frames:
        raise ValueError(f"no frames in {path}")
    return np.stack(frames), float(fps)


def resample_fps(frames, fps, target=FPS):
    """Drop or repeat frames so the clip plays at `target` fps (same rule as chaplin's speed_rate)."""
    if abs(fps - target) < 0.5:
        return frames
    n_out = int(len(frames) * target / fps)
    idx = np.linspace(0, len(frames) - 1, n_out).astype(np.int64)
    return frames[idx]


# ---------------------------------------------------------------- detection


def ensure_face_detector_model():
    if not FACE_DETECTOR_MODEL.exists():
        FACE_DETECTOR_MODEL.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(FACE_DETECTOR_URL, FACE_DETECTOR_MODEL)
    return FACE_DETECTOR_MODEL


class FaceDetector:
    """All faces per frame via MediaPipe Tasks FaceDetector (VIDEO mode)."""

    def __init__(self, min_confidence=0.5):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision

        self._mp = mp
        opts = vision.FaceDetectorOptions(
            base_options=BaseOptions(model_asset_path=str(ensure_face_detector_model())),
            running_mode=vision.RunningMode.VIDEO,
            min_detection_confidence=min_confidence,
        )
        self._detector = vision.FaceDetector.create_from_options(opts)
        self._t_ms = 0

    def close(self):
        self._detector.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def detect(self, frame_rgb):
        h, w = frame_rgb.shape[:2]
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame_rgb))
        self._t_ms += 40  # timestamps must increase in VIDEO mode
        result = self._detector.detect_for_video(image, self._t_ms)
        faces = []
        for det in result.detections:
            bb = det.bounding_box
            kps = np.array([[k.x * w, k.y * h] for k in det.keypoints[:4]], dtype=np.float32)
            box = np.array([bb.origin_x, bb.origin_y, bb.origin_x + bb.width, bb.origin_y + bb.height], dtype=np.float32)
            faces.append(Face(box=box, keypoints=kps, score=det.categories[0].score))
        return faces


def detect_all(frames, min_confidence=0.5):
    with FaceDetector(min_confidence) as det:
        return [det.detect(f) for f in frames]


# ---------------------------------------------------------------- target selection + tracking


def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def pick_initial(faces, target):
    """target: "largest" or (x, y) pixel point (e.g. where the user clicked)."""
    if not faces:
        return None
    if target == "largest":
        return max(faces, key=lambda f: f.area)
    x, y = target
    inside = [f for f in faces if f.contains(x, y)]
    if inside:
        return min(inside, key=lambda f: f.area)  # innermost box under the click
    centre = lambda f: ((f.box[0] + f.box[2]) / 2, (f.box[1] + f.box[3]) / 2)
    return min(faces, key=lambda f: (centre(f)[0] - x) ** 2 + (centre(f)[1] - y) ** 2)


def track_target(detections, target="largest", start_frame=0, min_iou=0.3, max_lost=12):
    """Follow one face through the clip.

    detections: per-frame lists of Face (from detect_all).
    target: "largest" or (x, y) in frame `start_frame` coordinates.
    Returns per-frame keypoints (4, 2) for the target, or None where it was not
    seen. Matching uses box IoU with the last known box; if nothing overlaps
    enough, the nearest face centre within one face-width is accepted. After
    `max_lost` frames without a match the target is considered gone and no
    other face is ever substituted.
    """
    n = len(detections)
    out = [None] * n
    first = next((i for i in range(start_frame, n) if detections[i]), None)
    if first is None:
        return out
    current = pick_initial(detections[first], target)
    out[first] = current.keypoints
    last_box, lost = current.box, 0

    def follow(order):
        nonlocal last_box, lost
        for i in order:
            best, best_iou = None, 0.0
            for f in detections[i]:
                v = iou(last_box, f.box)
                if v > best_iou:
                    best, best_iou = f, v
            if best is None or best_iou < min_iou:
                cx, cy = (last_box[0] + last_box[2]) / 2, (last_box[1] + last_box[3]) / 2
                width = last_box[2] - last_box[0]
                near = [
                    f for f in detections[i]
                    if np.hypot((f.box[0] + f.box[2]) / 2 - cx, (f.box[1] + f.box[3]) / 2 - cy) < width
                ]
                best = min(near, key=lambda f: np.hypot((f.box[0] + f.box[2]) / 2 - cx, (f.box[1] + f.box[3]) / 2 - cy)) if near else None
            if best is None:
                lost += 1
                if lost > max_lost:
                    return
                continue
            out[i] = best.keypoints
            last_box, lost = best.box, 0

    follow(range(first + 1, n))
    last_box, lost = current.box, 0
    follow(range(first - 1, -1, -1))
    return out


# ---------------------------------------------------------------- alignment + crop (chaplin VideoProcess)


def _interpolate(landmarks):
    valid = [i for i, lm in enumerate(landmarks) if lm is not None]
    if not valid:
        return None
    lms = list(landmarks)
    for a, b in zip(valid[:-1], valid[1:]):
        for k in range(1, b - a):
            lms[a + k] = lms[a] + k / (b - a) * (lms[b] - lms[a])
    lms[: valid[0]] = [lms[valid[0]]] * valid[0]
    lms[valid[-1]:] = [lms[valid[-1]]] * (len(lms) - valid[-1])
    return lms


def _stable_reference():
    ref = np.load(MEAN_FACE)
    return np.vstack([
        ref[36:42].mean(0),  # right eye
        ref[42:48].mean(0),  # left eye
        ref[31:36].mean(0),  # nose
        ref[48:68].mean(0),  # mouth
    ]).astype(np.float32)


def similarity_transform(src, dst):
    """Least-squares rotation + uniform scale + translation mapping src -> dst (both (N, 2)).

    Returns a 2x3 matrix [[a, -b, tx], [b, a, ty]]. Same model as
    cv2.estimateAffinePartial2D, but closed form (no LMEDS sampling), so the
    browser port in web/public/js/lipread/align.js gives identical results.
    """
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    ms, md = src.mean(0), dst.mean(0)
    s, d = src - ms, dst - md
    norm = (s ** 2).sum()
    a = (s[:, 0] * d[:, 0] + s[:, 1] * d[:, 1]).sum() / norm
    b = (s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum() / norm
    tx = md[0] - (a * ms[0] - b * ms[1])
    ty = md[1] - (b * ms[0] + a * ms[1])
    return np.array([[a, -b, tx], [b, a, ty]], dtype=np.float64)


def crop_mouths(frames, keypoints, window_margin=12, patch=96, target_size=256):
    """frames RGB (T,H,W,3), keypoints list of (4,2)|None -> uint8 (T, 88, 88)."""
    lms = _interpolate(keypoints)
    if lms is None:
        raise ValueError("target face not found in any frame")
    ref = _stable_reference()
    half = patch // 2
    out = []
    for i, frame in enumerate(frames):
        m = min(window_margin // 2, i, len(lms) - 1 - i)
        smooth = np.mean([lms[j] for j in range(i - m, i + m + 1)], axis=0)
        smooth += lms[i].mean(0) - smooth.mean(0)
        gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        tf = similarity_transform(smooth, ref)
        warped = cv2.warpAffine(gray, tf, (target_size, target_size), flags=cv2.INTER_LINEAR,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        mouth = smooth @ tf[:, :2].T + tf[:, 2]
        cx, cy = mouth[3]
        if abs(cy - target_size / 2) > half + 5 or abs(cx - target_size / 2) > half + 5:
            raise ValueError("mouth too far from centre after alignment")
        y0, y1 = int(round(np.clip(cy - half, 0, target_size))), int(round(np.clip(cy + half, 0, target_size)))
        x0, x1 = int(round(np.clip(cx - half, 0, target_size))), int(round(np.clip(cx + half, 0, target_size)))
        crop = warped[y0:y1, x0:x1]
        if crop.shape != (patch, patch):
            crop = cv2.resize(crop, (patch, patch))
        off = (patch - CROP_SIZE) // 2
        out.append(crop[off:off + CROP_SIZE, off:off + CROP_SIZE])
    return np.stack(out)


def video_to_mouths(path, target="largest", return_debug=False):
    frames, fps = read_video(path)
    frames = resample_fps(frames, fps)
    dets = detect_all(frames)
    kps = track_target(dets, target)
    mouths = crop_mouths(frames, kps)
    if return_debug:
        n_faces = [len(d) for d in dets]
        tracked = sum(k is not None for k in kps)
        return mouths, {"fps_in": fps, "frames": len(frames), "max_faces": max(n_faces), "tracked_frames": tracked}
    return mouths
