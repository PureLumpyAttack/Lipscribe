// Transcript history and preferences, kept in this browser only.
// Every access is guarded: storage can be blocked (private mode, policies).

const HISTORY_KEY = 'lipscribe.history.v1';
const PREFS_KEY = 'lipscribe.prefs.v1';
export const MAX_HISTORY = 50;

function read(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

export const loadHistory = () => {
  const items = read(HISTORY_KEY, []);
  return Array.isArray(items) ? items.slice(0, MAX_HISTORY) : [];
};
export const saveHistory = (items) => write(HISTORY_KEY, items.slice(0, MAX_HISTORY));

export const loadPrefs = () => ({ voice: '', autoSpeak: true, handsFree: true, boost: 1, ...read(PREFS_KEY, {}) });
export const savePrefs = (prefs) => write(PREFS_KEY, prefs);
