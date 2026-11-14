// Finds the mouth with MediaPipe Face Landmarker and draws the highlight on a
// canvas laid over the video. If the model can't load (offline, blocked CDN),
// it falls back to a fixed guide box so the page still works.

const TASKS_VERSION = '0.10.14';
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Outer lip contour, in drawing order (MediaPipe face mesh indices).
const OUTER_LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
// Where the guide box sits when no face is found (fractions of the frame).
const GUIDE = { x: 0.36, y: 0.56, w: 0.28, h: 0.2 };
const SMOOTHING = 0.35;
const LOST_AFTER_FRAMES = 12;

/**
 * @param {{ video: HTMLVideoElement, canvas: HTMLCanvasElement, onStatus: (s: 'loading'|'tracking'|'search'|'guide') => void }} options
 */
export function createMouthTracker({ video, canvas, onStatus }) {
  const ctx = canvas.getContext('2d');
  let landmarker = null;
  let status = '';
  let rafId = 0;
  let lastVideoTime = -1;
  let box = null; // smoothed mouth box in canvas pixels
  let lips = null;
  let missedFrames = 0;
  let accent = readAccent();

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => (accent = readAccent()));

  function setStatus(next) {
    if (next !== status) onStatus((status = next));
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
      console.warn('[lipscribe] Face tracking unavailable, using the guide box.', error);
      setStatus('guide');
    }
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;

    const W = video.videoWidth;
    const H = video.videoHeight;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }

    if (landmarker) detect(W, H);
    draw(W, H);
  }

  function detect(W, H) {
    const result = landmarker.detectForVideo(video, performance.now());
    const face = result.faceLandmarks?.[0];
    if (!face) {
      if (++missedFrames > LOST_AFTER_FRAMES) {
        box = null;
        lips = null;
        setStatus('search');
      }
      return;
    }
    missedFrames = 0;
    lips = OUTER_LIPS.map((i) => [face[i].x * W, face[i].y * H]);

    const xs = lips.map((p) => p[0]);
    const ys = lips.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = (maxX - minX) * 1.6;
    const h = Math.max((maxY - minY) * 2.1, w * 0.58);
    const target = { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };

    box = box ? lerpBox(box, target, SMOOTHING) : target;
    setStatus('tracking');
  }

  function draw(W, H) {
    const scale = W / 640;
    ctx.clearRect(0, 0, W, H);

    if (!box) {
      // Dashed guide: where to put your mouth.
      const g = { x: GUIDE.x * W, y: GUIDE.y * H, w: GUIDE.w * W, h: GUIDE.h * H };
      ctx.setLineDash([10 * scale, 8 * scale]);
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.roundRect(g.x, g.y, g.w, g.h, 18 * scale);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const radius = Math.min(box.w, box.h) * 0.28;

    // Dim everything except the mouth.
    ctx.fillStyle = 'rgba(8, 9, 11, 0.42)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.roundRect(box.x, box.y, box.w, box.h, radius);
    ctx.fill('evenodd');

    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, radius);
    ctx.stroke();

    if (lips) {
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      lips.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
  }

  return {
    start() {
      if (!landmarker && !status) loadModel();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(rafId);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}

function lerpBox(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

function readAccent() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d0215a';
}
