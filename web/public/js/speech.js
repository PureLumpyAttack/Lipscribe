// Browser text-to-speech. Swap for a cloud voice later if needed.

const synth = window.speechSynthesis;
let active = null;

export const supported = Boolean(synth && window.SpeechSynthesisUtterance);

export function onVoices(callback) {
  if (!supported) return;
  const emit = () => callback(synth.getVoices());
  emit();
  synth.addEventListener('voiceschanged', emit);
}

export function speak(text, { voiceName, onStart, onEnd } = {}) {
  if (!supported) return;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = synth.getVoices().find((v) => v.name === voiceName);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  }

  // Only the newest utterance reports back, so a cancelled one can't
  // clear the "speaking" state of the one that replaced it.
  active = utterance;
  utterance.onstart = () => active === utterance && onStart?.();
  const done = () => {
    if (active !== utterance) return;
    active = null;
    onEnd?.();
  };
  utterance.onend = done;
  utterance.onerror = done;

  synth.speak(utterance);
}

export function stop() {
  active = null;
  if (supported) synth.cancel();
}
