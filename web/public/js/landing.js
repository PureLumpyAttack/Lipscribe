// Landing hero: the illustrated lips "talk" while sample transcripts type out.

import * as speech from './speech.js';

const PHRASES = [
  'Can you hear me now?',
  "I'm on a train, I'll call you back.",
  'Could I get some water, please?',
  'The baby just fell asleep.',
];

const heard = document.getElementById('heard');
const scene = document.getElementById('scene');
const play = document.getElementById('play');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

let current = PHRASES[0];

async function loop() {
  for (let i = 1; ; i++) {
    await wait(3200);
    current = PHRASES[i % PHRASES.length];
    if (reduceMotion) {
      heard.textContent = current;
      continue;
    }
    scene.classList.add('talking');
    for (let n = 1; n <= current.length; n++) {
      heard.textContent = current.slice(0, n);
      await wait(42);
    }
    scene.classList.remove('talking');
  }
}

if (speech.supported) {
  play.addEventListener('click', () => speech.speak(current));
} else {
  play.hidden = true;
}

loop();
