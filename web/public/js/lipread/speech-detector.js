// Hands-free mode: notices when the person being read starts and stops
// talking, from their lips alone (they may be mouthing words silently, so
// there's no audio to listen to).
//
// Input, once per video frame: the mouth opening (inner-lip gap / mouth
// width, from mouth-tracker.js) or null when the face isn't found.
// "Motion" is the average change of that opening per 1/30 s over the last
// ~270 ms. Measured with MediaPipe on our recordings (ml/data/recordings,
// 1280x720): a still mouth stays at 0.000-0.003, talking is 0.007-0.07, and
// the quietest talker 0.008-0.016.
//
// Talking starts after motion stays above startLevel for startMs, and ends
// after it stays below stopLevel for stopMs (so pauses between words don't
// cut the clip).

const WINDOW_MS = 270;

/**
 * @param {{
 *   onStart: (fromTimestamp: number) => void,  start of the movement (performance.now() clock)
 *   onStop: (timestamp: number) => void,
 *   startLevel?: number, stopLevel?: number, startMs?: number, stopMs?: number, lostMs?: number,
 * }} options
 */
export function createSpeechDetector({
  onStart,
  onStop,
  startLevel = 0.007,
  stopLevel = 0.004,
  startMs = 130,
  stopMs = 900,
  lostMs = 400,
}) {
  let speaking = false;
  let prev = null; // { open, t }
  let deltas = []; // { d, t }
  let aboveSince = null;
  let belowSince = null;
  let lostSince = null;
  let level = 0;

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
    get level() {
      return level;
    },

    /** One video frame: mouth opening (or null if no face) at time t (ms). */
    push(open, t) {
      if (open == null) {
        prev = null;
        deltas = [];
        level = 0;
        aboveSince = null;
        lostSince ??= t;
        if (speaking && t - lostSince > lostMs) stop(t);
        return;
      }
      lostSince = null;
      if (prev) {
        const dt = t - prev.t;
        if (dt > 200) deltas = []; // a gap in tracking: start over
        else if (dt > 0) deltas.push({ d: (Math.abs(open - prev.open) * (1000 / 30)) / dt, t });
      }
      prev = { open, t };
      while (deltas.length && deltas[0].t < t - WINDOW_MS) deltas.shift();
      level = deltas.length >= 3 ? deltas.reduce((sum, x) => sum + x.d, 0) / deltas.length : 0;

      if (!speaking) {
        if (level > startLevel) {
          aboveSince ??= t;
          if (t - aboveSince >= startMs) {
            speaking = true;
            belowSince = null;
            onStart(aboveSince - WINDOW_MS); // the movement began a little before the average rose
          }
        } else {
          aboveSince = null;
        }
      } else if (level < stopLevel) {
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
      deltas = [];
      level = 0;
      aboveSince = null;
      lostSince = null;
    },
  };
}
