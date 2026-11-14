// Recorded frames + face keypoints -> aligned 88x88 grayscale mouth crops.
// Port of crop_mouths() in ml/lipscribe_ml/preprocess.py. No DOM access, so
// the parity test can run it under Node.
//
// Keypoints are 4 points per frame in video pixels: right eye, left eye,
// nose tip, mouth centre (MediaPipe FaceDetector order), or null when the
// target face wasn't seen in that frame.
//
// Each frame is a grayscale "region": a window of the video stored at reduced
// size to save memory. Region pixel (u, v) shows video pixel
//   x = ox + (u + 0.5) / scale - 0.5,   y = oy + (v + 0.5) / scale - 0.5
// (scale 1, offset 0 = the full frame).

/** Least-squares similarity (rotation + uniform scale + translation), src -> dst. */
export function similarityTransform(src, dst) {
  const n = src.length;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1];
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let norm = 0, num_a = 0, num_b = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - msx, sy = src[i][1] - msy;
    const dx = dst[i][0] - mdx, dy = dst[i][1] - mdy;
    norm += sx * sx + sy * sy;
    num_a += sx * dx + sy * dy;
    num_b += sx * dy - sy * dx;
  }
  const a = num_a / norm;
  const b = num_b / norm;
  return [a, -b, mdx - (a * msx - b * msy), b, a, mdy - (b * msx + a * msy)];
}

/** Fill gaps by linear interpolation; hold the first/last seen value at the ends. */
export function interpolate(keypoints) {
  const valid = [];
  keypoints.forEach((k, i) => k && valid.push(i));
  if (!valid.length) return null;
  const out = keypoints.map((k) => (k ? k.map((p) => [...p]) : null));
  for (let j = 0; j + 1 < valid.length; j++) {
    const a = valid[j], b = valid[j + 1];
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      out[i] = out[a].map((p, q) => [p[0] + t * (out[b][q][0] - p[0]), p[1] + t * (out[b][q][1] - p[1])]);
    }
  }
  for (let i = 0; i < valid[0]; i++) out[i] = out[valid[0]].map((p) => [...p]);
  const last = valid[valid.length - 1];
  for (let i = last + 1; i < out.length; i++) out[i] = out[last].map((p) => [...p]);
  return out;
}

function sampleBilinear(region, x, y) {
  // region: { data: Uint8Array, width, height, scale, ox, oy }; (x, y) in video pixels
  const u = (x - region.ox + 0.5) * region.scale - 0.5;
  const v = (y - region.oy + 0.5) * region.scale - 0.5;
  const { data, width: w, height: h } = region;
  const u0 = Math.floor(u), v0 = Math.floor(v);
  const fu = u - u0, fv = v - v0;
  const px = (uu, vv) => (uu < 0 || vv < 0 || uu >= w || vv >= h ? 0 : data[vv * w + uu]);
  const top = px(u0, v0) * (1 - fu) + px(u0 + 1, v0) * fu;
  const bottom = px(u0, v0 + 1) * (1 - fu) + px(u0 + 1, v0 + 1) * fu;
  return top * (1 - fv) + bottom * fv;
}

function invertAffine([a, b, c, d, e, f]) {
  const det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

/**
 * @param {Array<{data: Uint8Array, width: number, height: number, scale: number, ox: number, oy: number}>} regions
 * @param {Array<number[][] | null>} keypoints  per frame, 4 x [x, y] in video pixels
 * @param {{stableReference: number[][], windowMargin: number, patch: number, crop: number, alignSize: number}} params
 * @returns {Uint8Array} T * crop * crop
 */
export function cropMouths(regions, keypoints, params) {
  const lms = interpolate(keypoints);
  if (!lms) throw new Error('No face was found in the recording.');
  const { stableReference: ref, windowMargin, patch, crop, alignSize } = params;
  const T = regions.length;
  const half = patch / 2;
  const off = (patch - crop) / 2;
  const out = new Uint8Array(T * crop * crop);

  for (let i = 0; i < T; i++) {
    // Temporal smoothing over +-6 frames, re-centred on this frame's centroid.
    const m = Math.min(Math.floor(windowMargin / 2), i, T - 1 - i);
    const smooth = [[0, 0], [0, 0], [0, 0], [0, 0]];
    for (let j = i - m; j <= i + m; j++) {
      for (let q = 0; q < 4; q++) {
        smooth[q][0] += lms[j][q][0] / (2 * m + 1);
        smooth[q][1] += lms[j][q][1] / (2 * m + 1);
      }
    }
    const centroid = (pts) => pts.reduce((acc, p) => [acc[0] + p[0] / 4, acc[1] + p[1] / 4], [0, 0]);
    const [cx0, cy0] = centroid(lms[i]);
    const [cx1, cy1] = centroid(smooth);
    for (const p of smooth) {
      p[0] += cx0 - cx1;
      p[1] += cy0 - cy1;
    }

    const M = similarityTransform(smooth, ref); // video -> 256x256 aligned face
    const inv = invertAffine(M);
    // Mouth centre in aligned space, then the 96x96 patch around it (clipped like cut_patch).
    const mx = M[0] * smooth[3][0] + M[1] * smooth[3][1] + M[2];
    const my = M[3] * smooth[3][0] + M[4] * smooth[3][1] + M[5];
    const clip = (v) => Math.min(Math.max(v, 0), alignSize);
    const x0 = Math.round(clip(mx - half)), x1 = Math.round(clip(mx + half));
    const y0 = Math.round(clip(my - half)), y1 = Math.round(clip(my + half));
    const sx = (x1 - x0) / patch, sy = (y1 - y0) / patch; // 1 unless clipped (then resized, as in Python)

    const region = regions[i];
    const base = i * crop * crop;
    for (let r = 0; r < crop; r++) {
      const ay = y0 + (r + off + 0.5) * sy - 0.5;
      for (let c = 0; c < crop; c++) {
        const ax = x0 + (c + off + 0.5) * sx - 0.5;
        const vx = inv[0] * ax + inv[1] * ay + inv[2];
        const vy = inv[3] * ax + inv[4] * ay + inv[5];
        out[base + r * crop + c] = Math.round(sampleBilinear(region, vx, vy));
      }
    }
  }
  return out;
}

/** Pick frames at a steady `fps` from frames captured at uneven times (ms). */
export function resampleByTime(timestamps, fps) {
  if (timestamps.length < 2) return timestamps.map((_, i) => i);
  const t0 = timestamps[0];
  const duration = timestamps[timestamps.length - 1] - t0;
  const n = Math.max(1, Math.floor((duration / 1000) * fps) + 1);
  const picks = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = t0 + (k * 1000) / fps;
    while (j + 1 < timestamps.length && Math.abs(timestamps[j + 1] - target) <= Math.abs(timestamps[j] - target)) j++;
    picks.push(j);
  }
  return picks;
}
