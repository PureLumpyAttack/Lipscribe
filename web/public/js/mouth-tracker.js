// Finds the mouth with MediaPipe Face Landmarker and moves the highlight window.
//
// The highlight itself is CSS (see .cam-focus in demo.css): the base video is
// blurred, and a second, sharp copy of the video is masked
// to an ellipse around the mouth. This file only measures where that ellipse
// goes and writes it to CSS variables on the viewport.
//
// If the model can't load (offline, blocked CDN), status becomes 'guide' and
// the page shows a fixed outline to line your mouth up with instead.

const TASKS_VERSION = '0.10.14';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Outer lip contour (MediaPipe face mesh indices).
const OUTER_LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const SMOOTHING = 0.35;
const LOST_AFTER_FRAMES = 12;

/**
 * @param {{
 *   video: HTMLVideoElement,
 *   viewport: HTMLElement,
 *   onStatus: (status: 'loading' | 'tracking' | 'search' | 'guide') => void,
 * }} options
 */
export function createMouthTracker({ video, viewport, onStatus }) {
  let landmarker = null;
  let status = '';
  let rafId = 0;
  let lastVideoTime = -1;
  let mouth = null; // smoothed ellipse in video pixels: { cx, cy, rx, ry }
  let missedFrames = 0;

  function setStatus(next) {
    if (next !== status) onStatus((status = next));
  }

  function setFocus(on) {
    viewport.dataset.focus = String(on);
  }

  async function loadModel() {
    setStatus('loading');
    try {
      const { FaceLandmarker, FilesetResolver } = await import(`${TASKS_URL}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
      });
      try {
        landmarker = await FaceLandmarker.createFromOptions(files, options('GPU'));
      } catch {
        landmarker = await FaceLandmarker.createFromOptions(files, options('CPU'));
      }
      setStatus('search');
    } catch (error) {
      console.warn('[lipscribe] Face tracking unavailable, showing the guide outline.', error);
      setStatus('guide');
    }
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const face = landmarker.detectForVideo(video, performance.now()).faceLandmarks?.[0];
    if (!face) {
      if (++missedFrames > LOST_AFTER_FRAMES) {
        mouth = null;
        setFocus(false);
        setStatus('search');
      }
      return;
    }
    missedFrames = 0;

    const W = video.videoWidth;
    const H = video.videoHeight;
    const xs = OUTER_LIPS.map((i) => face[i].x * W);
    const ys = OUTER_LIPS.map((i) => face[i].y * H);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const lipWidth = maxX - minX;
    const target = {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      rx: lipWidth * 0.95,
      ry: Math.max((maxY - minY) * 1.5, lipWidth * 0.62),
    };
    mouth = mouth ? lerp(mouth, target, SMOOTHING) : target;

    placeWindow(W, H);
    setFocus(true);
    setStatus('tracking');
  }

  // Video pixels → viewport pixels, matching `object-fit: cover`.
  // The mirror transform applies after the mask, so unmirrored coordinates are right.
  function placeWindow(W, H) {
    const elW = viewport.clientWidth;
    const elH = viewport.clientHeight;
    const scale = Math.max(elW / W, elH / H);
    const offsetX = (elW - W * scale) / 2;
    const offsetY = (elH - H * scale) / 2;
    const style = viewport.style;
    style.setProperty('--mx', `${offsetX + mouth.cx * scale}px`);
    style.setProperty('--my', `${offsetY + mouth.cy * scale}px`);
    style.setProperty('--mw', `${mouth.rx * scale}px`);
    style.setProperty('--mh', `${mouth.ry * scale}px`);
  }

  return {
    start() {
      if (!status) loadModel();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(rafId);
      setFocus(false);
    },
  };
}

function lerp(a, b, t) {
  return {
    cx: a.cx + (b.cx - a.cx) * t,
    cy: a.cy + (b.cy - a.cy) * t,
    rx: a.rx + (b.rx - a.rx) * t,
    ry: a.ry + (b.ry - a.ry) * t,
  };
}
