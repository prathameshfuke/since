// Settings: one small store with defaults, validation and subscribers (the same shape a React
// context + reducer would have, without React). Everything is validated on the way in AND on the way
// out of localStorage, so a hand-edited value cannot put the app in a state it cannot render.
//
//   theme        system | light | dark
//   answerStyle  concise | detailed          sent to the server
//   searchDepth  fast | balanced | thorough  sent to the server
//   useMemory    use saved history when answering
//   timezone     '' = detected; used to understand "Monday" and "yesterday"

const KEY = 'since.settings.v1';
export const DEFAULTS = { theme: 'system', answerStyle: 'concise', searchDepth: 'balanced', useMemory: true, timezone: '' };
const CHOICES = {
  theme: ['system', 'light', 'dark'],
  answerStyle: ['concise', 'detailed'],
  searchDepth: ['fast', 'balanced', 'thorough'],
};

const validZone = (z) => {
  if (z === '') return true;
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; }
};

function sanitize(raw) {
  const out = { ...DEFAULTS };
  for (const [key, allowed] of Object.entries(CHOICES)) if (allowed.includes(raw?.[key])) out[key] = raw[key];
  if (typeof raw?.useMemory === 'boolean') out.useMemory = raw.useMemory;
  if (typeof raw?.timezone === 'string' && validZone(raw.timezone)) out.timezone = raw.timezone;
  return out;
}

function load() {
  try { return sanitize(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return { ...DEFAULTS }; }
}

let state = load();
const listeners = new Set();

export const get = () => state;
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const detectedZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const zone = () => state.timezone || detectedZone();

export function zones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return [detectedZone()]; }
}

export function applyTheme() {
  if (state.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}

export function set(patch) {
  state = sanitize({ ...state, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode: keep it for this session */ }
  applyTheme();
  listeners.forEach((fn) => fn(state));
}

applyTheme();
