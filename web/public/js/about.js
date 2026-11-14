// About page hero: sample transcripts type out while the illustrated mouth
// shapes each letter.

import * as speech from './speech.js';
import { createMouth, shapeFor, REST } from './mouth.js';

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
const mouth = createMouth({ animate: !reduceMotion });

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
      mouth.setTarget(shapeFor(phrase[n - 1]));
      await wait(70);
    }
    mouth.setTarget(REST);
  }
}

if (speech.supported) {
  play.addEventListener('click', () => speech.speak(phrase));
} else {
  play.hidden = true;
}

loop();
