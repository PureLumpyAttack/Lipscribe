// Hands-free detector on synthetic mouth-opening tracks (30 fps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechDetector } from '../public/js/lipread/speech-detector.js';

function run(track) {
  const events = [];
  const d = createSpeechDetector({ onStart: (t) => events.push(['start', t]), onStop: (t) => events.push(['stop', t]) });
  track.forEach((open, i) => d.push(open, i * (1000 / 30)));
  return events;
}
const still = (n, base = 0.05) => Array.from({ length: n }, (_, i) => base + 0.0008 * Math.sin(i * 1.7)); // landmark jitter
// Talking: the opening swings ~0.05-0.25 a few times a second (syllables).
const talk = (n, amp = 0.1) => Array.from({ length: n }, (_, i) => 0.15 + amp * Math.sin(i * 0.9));

test('a still face never starts a recording', () => {
  assert.deepEqual(run(still(300)), []);
});

test('talking starts a recording, stillness ends it', () => {
  const ev = run([...still(30), ...talk(60), ...still(60)]);
  assert.deepEqual(ev.map((e) => e[0]), ['start', 'stop']);
  assert.ok(ev[0][1] < 1000 + 50, 'start includes the beginning of the movement');
  assert.ok(ev[1][1] > 3000 && ev[1][1] < 4400, `stops ~1.2 s after the lips stop (${Math.round(ev[1][1])} ms)`);
});

test('a short pause between words keeps the same recording', () => {
  const ev = run([...talk(45), ...still(12, 0.15), ...talk(45), ...still(60)]);
  assert.deepEqual(ev.map((e) => e[0]), ['start', 'stop']);
});

test('quiet talkers are picked up', () => {
  assert.equal(run([...still(30), ...talk(60, 0.04)])[0]?.[0], 'start');
});

test('losing the face ends a recording', () => {
  const ev = run([...talk(45), ...Array(20).fill(null)]);
  assert.deepEqual(ev.map((e) => e[0]), ['start', 'stop']);
});

test('one- or two-frame landmark glitches never start a recording', () => {
  const track = still(900, 0.03).map((x, i) => x + (i % 60 === 0 ? 0.3 : 0) + (i % 97 < 2 ? 0.25 : 0));
  assert.deepEqual(run(track), []);
});

test('opening the mouth once and holding it (a yawn, a smile) does not start a recording', () => {
  const open = Array.from({ length: 20 }, (_, i) => 0.03 + (0.3 * i) / 20);
  assert.deepEqual(run([...still(30, 0.03), ...open, ...still(60, 0.33)]), []);
});
