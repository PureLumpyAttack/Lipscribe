// Records what the model needs instead of a video file: for every webcam
// frame, a small grayscale window around the chosen person's face plus their
// face keypoints. Nothing leaves the browser.
//
// Same start/stop shape as createRecorder() in camera.js, so demo.js can use
// either. stop() resolves with { frames: { regions, keypoints, timestamps }, durationMs }.

const REGION_SIZE = 256; // px; the window is at most this big (about 64 KB per frame)
const REGION_SCALE = 2.2; // window side = 2.2 x face box size

export function createFrameRecorder({ video, faceTarget }) {
  const canvas = new OffscreenCanvas(REGION_SIZE, REGION_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let unsubscribe = null;
  let regions = [];
  let keypoints = [];
  let timestamps = [];
  let lastBox = null;
  let startedAt = 0;

  function capture({ target, timestamp }) {
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (target) lastBox = target.box;
    const box = lastBox ?? [0, 0, W, H];
    const side = Math.max(box[2] - box[0], box[3] - box[1]) * (lastBox ? REGION_SCALE : 1);
    const [cx, cy] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const sx = cx - side / 2;
    const sy = cy - side / 2;
    const size = Math.max(1, Math.round(Math.min(REGION_SIZE, side)));

    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const gray = new Uint8Array(size * size);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
    }
    regions.push({ data: gray, width: size, height: size, scale: size / side, ox: sx, oy: sy });
    keypoints.push(target ? target.keypoints.map((p) => [...p]) : null);
    timestamps.push(timestamp);
  }

  return {
    get recording() {
      return Boolean(unsubscribe);
    },
    start() {
      regions = [];
      keypoints = [];
      timestamps = [];
      lastBox = faceTarget.target?.box ?? null;
      startedAt = performance.now();
      unsubscribe = faceTarget.subscribe(capture);
    },
    stop() {
      if (!unsubscribe) return Promise.reject(new Error('Not recording.'));
      unsubscribe();
      unsubscribe = null;
      return Promise.resolve({
        frames: { regions, keypoints, timestamps },
        durationMs: performance.now() - startedAt,
      });
    },
  };
}
