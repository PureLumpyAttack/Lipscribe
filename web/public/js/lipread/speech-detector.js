// Hands-free mode: notices when the person being read starts and stops
// talking, from their lips alone (they may be mouthing words silently, so
// there's no audio to listen to).
//
// Input, once per video frame: the mouth opening (inner-lip gap / mouth
// width, from mouth-tracker.js) or null when the face isn't found. The
// opening is lightly smoothed first, because webcam landmarks jitter.
//
// Talking needs all three over the last ~600 ms, held for startMs:
//   motion  average change of the opening per 1/30 s     > startLevel
//   range   biggest minus smallest opening                > startRange
//   peak    the mouth actually opened at some point       > minPeak
// Landmark jitter, blinking, a nod or a still open mouth pass one test at
// most. Measured with MediaPipe on our recordings (ml/data/recordings,
// 1280x720): talking swings the opening by 0.06-0.25 (the quietest talker
// ~0.06) with motion 0.008-0.07; a still mouth moves < 0.01.
//
// Talking ends after motion stays below stopLevel (or the range below half
// of startRange) for stopMs, so pauses between words don't cut the clip.

const MOTION_MS = 270;
const RANGE_MS = 600;
const SMOOTHING = 0.5; // weight of the new sample

/**
 * @param {{
 *   onStart: (fromTimestamp: number) => void,  start of the movement (performance.now() clock)
 *   onStop: (timestamp: number) => void,
 *   startLevel?: number, stopLevel?: number, startRange?: number, minPeak?: number,
 *   startMs?: number, stopMs?: number, lostMs?: number,
 * }} options
 */
export function createSpeechDetector({
  onStart,
  onStop,
  startLevel = 0.01,
  stopLevel = 0.005,
  startRange = 0.05,
  minPeak = 0.08,
  startMs = 200,
  stopMs = 900,
  lostMs = 400,
}) {
  let speaking = false;
  let prev = null; // { open, t }
  let deltas = []; // { d, t } for motion
  let history = []; // { open, t } for range and peak
  let smooth = null;
  let aboveSince = null;
  let belowSince = null;
  let lostSince = null;
  let level = 0;
  let range = 0;

  function stop(t) {
    speaking = false;
    aboveSince = null;
    belowSince = null;
    onStop(t);
  }

  return {
    get speaking() {
      return speaking;
    },
    /** Current measurements, for tuning: { level, range }. */
    get level() {
      return { level, range };
    },

    /** One video frame: mouth opening (or null if no face) at time t (ms). */
    push(open, t) {
      if (open == null) {
        prev = null;
        smooth = null;
        deltas = [];
        history = [];
        level = 0;
        aboveSince = null;
        lostSince ??= t;
        if (speaking && t - lostSince > lostMs) stop(t);
        return;
      }
      lostSince = null;
      smooth = smooth == null ? open : smooth + SMOOTHING * (open - smooth);
      if (prev) {
        const dt = t - prev.t;
        if (dt > 200) {
          deltas = []; // a gap in tracking: start over
          history = [];
        } else if (dt > 0) deltas.push({ d: (Math.abs(smooth - prev.open) * (1000 / 30)) / dt, t });
      }
      prev = { open: smooth, t };
      history.push({ open: smooth, t });
      while (deltas.length && deltas[0].t < t - MOTION_MS) deltas.shift();
      while (history.length && history[0].t < t - RANGE_MS) history.shift();
      level = deltas.length >= 3 ? deltas.reduce((sum, x) => sum + x.d, 0) / deltas.length : 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (const h of history) {
        lo = Math.min(lo, h.open);
        hi = Math.max(hi, h.open);
      }
      range = history.length >= 5 ? hi - lo : 0;
      const talking = level > startLevel && range > startRange && hi > minPeak;
      const still = level < stopLevel || range < startRange / 2;

      if (!speaking) {
        if (talking) {
          aboveSince ??= t;
          if (t - aboveSince >= startMs) {
            speaking = true;
            belowSince = null;
            onStart(aboveSince - RANGE_MS); // the movement began a little before it was certain
          }
        } else {
          aboveSince = null;
        }
      } else if (still) {
        belowSince ??= t;
        if (t - belowSince >= stopMs) stop(t);
      } else {
        belowSince = null;
      }
    },

    /** Forget everything; ends a talk in progress (calls onStop). */
    reset(t = performance.now()) {
      if (speaking) stop(t);
      prev = null;
      smooth = null;
      deltas = [];
      history = [];
      level = 0;
      aboveSince = null;
      lostSince = null;
    },
  };
}
