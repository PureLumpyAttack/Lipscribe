// Landing hero: sample transcripts type out while the illustrated mouth
// shapes each letter. The mouth is one connected shape (upper lip, lower lip,
// opening and teeth share the same corners), so it opens like a real mouth.

import * as speech from './speech.js';

const PHRASES = [
  'Can you hear me now?',
  "I'm on a train, I'll call you back.",
  'Could I get some water, please?',
  'The baby just fell asleep.',
];

const heard = document.getElementById('heard');
const play = document.getElementById('play');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---------- Mouth shape ---------- */

const el = {
  inner: document.getElementById('m-inner'),
  clip: document.getElementById('m-clip'),
  teeth: document.getElementById('m-teeth'),
  upper: document.getElementById('m-upper'),
  lower: document.getElementById('m-lower'),
  shine: document.getElementById('m-shine'),
};

// w: half-width at the corners, u: how far the upper lip lifts, d: how far the lower lip drops.
const REST = { w: 184, u: 1.5, d: 3 };
const SHAPES = {
  open: { w: 176, u: 12, d: 36 }, // a, e, i, h
  round: { w: 138, u: 9, d: 26 }, // o, u, w
  closed: { w: 186, u: 0, d: 0 }, // m, b, p
  bite: { w: 180, u: 5, d: 7 }, // f, v
  mid: { w: 180, u: 6, d: 16 }, // other consonants
};

function shapeFor(char) {
  const c = char.toLowerCase();
  if ('aeih'.includes(c)) return SHAPES.open;
  if ('ouwq'.includes(c)) return SHAPES.round;
  if ('mbp'.includes(c)) return SHAPES.closed;
  if ('fv'.includes(c)) return SHAPES.bite;
  if (/[a-z]/.test(c)) return SHAPES.mid;
  return REST;
}

function drawMouth({ w, u, d }) {
  const cx = 480;
  const cy = 281;
  const k = w / 184;
  const lift = u * 0.5;
  const X = (dx) => (cx + dx * k).toFixed(1);
  const Y = (dy) => (cy + dy).toFixed(1);
  const U = (dy) => Y(dy - lift);
  const B = 91 + d * 0.85; // depth of the lower lip

  // Edges where the lips meet the opening; shared so nothing comes apart.
  const upperInner = `C${X(92)} ${Y(-u)} ${X(-92)} ${Y(-u)} ${X(-184)} ${Y(0)}`;
  const lowerInner = `C${X(-101)} ${Y(d)} ${X(101)} ${Y(d)} ${X(184)} ${Y(0)}`;

  el.upper.setAttribute(
    'd',
    `M${X(-184)} ${Y(0)}` +
      `C${X(-136)} ${U(-52)} ${X(-84)} ${U(-81)} ${X(-44)} ${U(-77)}` +
      `C${X(-26)} ${U(-75)} ${X(-12)} ${U(-66)} ${X(0)} ${U(-55)}` +
      `C${X(12)} ${U(-66)} ${X(26)} ${U(-75)} ${X(44)} ${U(-77)}` +
      `C${X(84)} ${U(-81)} ${X(136)} ${U(-52)} ${X(184)} ${Y(0)}` +
      `${upperInner}Z`,
  );
  el.lower.setAttribute(
    'd',
    `M${X(-184)} ${Y(0)}${lowerInner}` +
      `C${X(144)} ${Y(B * 0.69)} ${X(76)} ${Y(B)} ${X(0)} ${Y(B)}` +
      `S${X(-144)} ${Y(B * 0.69)} ${X(-184)} ${Y(0)}Z`,
  );
  const opening =
    `M${X(-184)} ${Y(0)}C${X(-92)} ${Y(-u)} ${X(92)} ${Y(-u)} ${X(184)} ${Y(0)}` +
    `C${X(101)} ${Y(d)} ${X(-101)} ${Y(d)} ${X(-184)} ${Y(0)}Z`;
  el.inner.setAttribute('d', opening);
  el.clip.setAttribute('d', opening);

  // Upper teeth show in the top part of the opening.
  // An ellipse hanging from the upper edge, clipped to the opening, gives a curved row.
  const top = cy - 0.75 * u;
  el.teeth.setAttribute('cy', (top - 2).toFixed(1));
  el.teeth.setAttribute('rx', (118 * k).toFixed(1));
  el.teeth.setAttribute('ry', (4 + 0.75 * (u + d) * 0.4).toFixed(1));

  el.shine.setAttribute('cy', Y(B * 0.55));
  el.shine.setAttribute('rx', (72 * k).toFixed(1));
}

let current = { ...REST };
let target = REST;

function animate() {
  for (const key of ['w', 'u', 'd']) current[key] += (target[key] - current[key]) * 0.32;
  drawMouth(current);
  requestAnimationFrame(animate);
}

/* ---------- Typing loop ---------- */

let phrase = PHRASES[0];

async function loop() {
  for (let i = 1; ; i++) {
    await wait(3000);
    phrase = PHRASES[i % PHRASES.length];
    if (reduceMotion) {
      heard.textContent = phrase;
      continue;
    }
    for (let n = 1; n <= phrase.length; n++) {
      heard.textContent = phrase.slice(0, n);
      target = shapeFor(phrase[n - 1]);
      await wait(70);
    }
    target = REST;
  }
}

if (speech.supported) {
  play.addEventListener('click', () => speech.speak(phrase));
} else {
  play.hidden = true;
}

drawMouth(REST);
if (!reduceMotion) requestAnimationFrame(animate);
loop();
