// Finds every face in the webcam and follows one chosen person.
//
// Same detector as the Python pipeline (MediaPipe BlazeFace short-range) and
// the same tracking rule as track_target() in ml/lipscribe_ml/preprocess.py:
// match the target to the face whose box overlaps its last box most (IoU >=
// 0.3), else the nearest face centre within one face width. The largest face
// is picked automatically until someone clicks a face; after a click that
// person stays selected and is never swapped for someone else, even if they
// leave the frame.

const TASKS_VERSION = '0.10.14';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const DETECTOR_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';

const MIN_IOU = 0.3;
const MAX_LOST = 12; // frames

function iou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

const area = (f) => (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]);
const centre = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];

/**
 * @param {{ video: HTMLVideoElement, onChange?: (state: {faces: object[], target: object|null, locked: boolean, lost: boolean}) => void }} options
 */
export function createFaceTarget({ video, onChange = () => {} }) {
  let detector = null;
  let loading = null;
  let running = false;
  let rafId = 0;
  let lastTime = -1;
  let faces = [];
  let target = null; // face object for this frame, or null
  let lastBox = null; // target box last time it was seen
  let lost = 0;
  let locked = false;
  const listeners = new Set();

  async function load() {
    const { FaceDetector, FilesetResolver } = await import(`${TASKS_URL}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: DETECTOR_URL, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    try {
      detector = await FaceDetector.createFromOptions(files, options('GPU'));
    } catch {
      detector = await FaceDetector.createFromOptions(files, options('CPU'));
    }
  }

  function detect(now) {
    const W = video.videoWidth;
    const H = video.videoHeight;
    const result = detector.detectForVideo(video, now);
    return result.detections.map((d) => {
      const b = d.boundingBox;
      return {
        box: [b.originX, b.originY, b.originX + b.width, b.originY + b.height],
        keypoints: d.keypoints.slice(0, 4).map((k) => [k.x * W, k.y * H]),
        score: d.categories?.[0]?.score ?? 0,
      };
    });
  }

  function follow() {
    if (!lastBox) {
      target = faces.length ? faces.reduce((a, b) => (area(b) > area(a) ? b : a)) : null;
    } else {
      let best = null;
      let bestIou = 0;
      for (const f of faces) {
        const v = iou(lastBox, f.box);
        if (v > bestIou) [best, bestIou] = [f, v];
      }
      if (!best || bestIou < MIN_IOU) {
        const [cx, cy] = centre(lastBox);
        const width = lastBox[2] - lastBox[0];
        best = null;
        let bestD = width;
        for (const f of faces) {
          const [fx, fy] = centre(f.box);
          const d = Math.hypot(fx - cx, fy - cy);
          if (d < bestD) [best, bestD] = [f, d];
        }
      }
      target = best;
    }
    if (target) {
      lastBox = target.box;
      lost = 0;
    } else if (lastBox && ++lost > MAX_LOST && !locked) {
      lastBox = null; // automatic mode: fall back to the largest face again
    }
  }

  function frame() {
    if (!running) return;
    rafId = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame);
    if (!detector || video.readyState < 2 || video.currentTime === lastTime) return;
    lastTime = video.currentTime;
    const now = performance.now();
    faces = detect(now);
    follow();
    const state = { faces, target, locked, lost: locked && !target, timestamp: now };
    for (const fn of listeners) fn(state);
    onChange(state);
  }

  return {
    async start() {
      loading ??= load();
      await loading;
      if (running) return;
      running = true;
      frame();
    },
    stop() {
      running = false;
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rafId);
      cancelAnimationFrame(rafId);
    },
    /** Lock onto the face at (x, y) in video pixels. Returns true if a face was there or near. */
    selectAt(x, y) {
      if (!faces.length) return false;
      const inside = faces.filter((f) => f.box[0] <= x && x <= f.box[2] && f.box[1] <= y && y <= f.box[3]);
      const dist = (f) => Math.hypot(centre(f.box)[0] - x, centre(f.box)[1] - y);
      const pick = inside.length
        ? inside.reduce((a, b) => (area(b) < area(a) ? b : a)) // innermost box under the click
        : faces.reduce((a, b) => (dist(b) < dist(a) ? b : a));
      target = pick;
      lastBox = pick.box;
      lost = 0;
      locked = true;
      return true;
    },
    /** Back to automatic (largest face). */
    unlock() {
      locked = false;
      lastBox = null;
    },
    get target() {
      return target;
    },
    get faces() {
      return faces;
    },
    /** Called on every processed video frame with { faces, target, timestamp }. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
