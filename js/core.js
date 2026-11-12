'use strict';

/* ============================================================
   core.js — shared storage, helpers and UI building blocks.
   Loaded first; everything here is a global used by the mode
   files (js/flashcards.js, js/learn.js, …) and js/app.js.
   ============================================================ */

/* ------------------------------------------------------------
   Storage
   Sets:    [{ id, title, description, termLang, definitionLang,
               cards: [{ id, term, definition }], createdAt, updatedAt }]
   Folders: [{ id, name, description, setIds: [], createdAt, updatedAt }]
   Study:   { [setId]: { starred: [cardId], progress: { [cardId]: { level, seen } },
                         best: { [game]: number }, settings: { [mode]: {...} } } }
   ------------------------------------------------------------ */

const KEYS = {
  sets: 'flashcards.sets.v1',
  folders: 'flashcards.folders.v1',
  study: 'flashcards.study.v1',
};

const db = { sets: [], folders: [], study: {} };

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    const stamped = stampChanges(key, value);
    localStorage.setItem(key, JSON.stringify(value));
    if (stamped) window.dispatchEvent(new Event('flashcards:changed'));
    return true;
  } catch {
    toast("Couldn't save — your browser's storage is full or turned off.", 'error');
    return false;
  }
}

/* ------------------------------------------------------------
   Change tracking for sync (js/sync.js).
   Every set, folder and per-set study entry gets a "last changed"
   time; deleted ones leave a tombstone. Sync uses these to merge two
   devices item by item: the newest change wins, a deletion wins over
   older edits.
   ------------------------------------------------------------ */

const SYNC_META_KEY = 'flashcards.sync-meta.v1';
const SYNCED = { [KEYS.sets]: 'sets', [KEYS.folders]: 'folders', [KEYS.study]: 'study' };
let applyingRemote = false; // true while sync writes merged data, so it isn't re-stamped

const syncEntries = (name, value) =>
  name === 'study' ? Object.entries(value || {}) : (value || []).map((x) => [x.id, x]);

function readSyncMeta() {
  const m = readJSON(SYNC_META_KEY, {});
  return {
    stamps: m && typeof m.stamps === 'object' ? m.stamps : {},
    tombstones: m && typeof m.tombstones === 'object' ? m.tombstones : {},
  };
}

// Compares the new value of a collection with the current one and stamps what changed.
function stampChanges(key, next) {
  const name = SYNCED[key];
  if (!name || applyingRemote) return false;
  const before = new Map(syncEntries(name, db[name]));
  const after = new Map(syncEntries(name, next));
  const meta = readSyncMeta();
  const now = Date.now();
  let changed = false;
  for (const [id, value] of after) {
    const old = before.get(id);
    if (old && JSON.stringify(old) === JSON.stringify(value)) continue;
    meta.stamps[`${name}:${id}`] = now;
    delete meta.tombstones[`${name}:${id}`];
    changed = true;
  }
  for (const id of before.keys()) {
    if (after.has(id)) continue;
    meta.tombstones[`${name}:${id}`] = now;
    delete meta.stamps[`${name}:${id}`];
    changed = true;
  }
  if (changed) {
    try {
      localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
    } catch { /* sync metadata is best-effort */ }
  }
  return changed;
}

function loadAll() {
  const sets = readJSON(KEYS.sets, []);
  db.sets = Array.isArray(sets) ? sets.filter((s) => s && s.id && Array.isArray(s.cards)) : [];
  const folders = readJSON(KEYS.folders, []);
  db.folders = Array.isArray(folders) ? folders.filter((f) => f && f.id && Array.isArray(f.setIds)) : [];
  const study = readJSON(KEYS.study, {});
  db.study = study && typeof study === 'object' && !Array.isArray(study) ? study : {};
}

loadAll();

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* Sets */

const findSet = (id) => db.sets.find((s) => s.id === id);

function saveSet(set) {
  const exists = db.sets.some((s) => s.id === set.id);
  const next = exists ? db.sets.map((s) => (s.id === set.id ? set : s)) : [...db.sets, set];
  if (!writeJSON(KEYS.sets, next)) return false;
  db.sets = next;
  return true;
}

function removeSet(id) {
  const next = db.sets.filter((s) => s.id !== id);
  if (!writeJSON(KEYS.sets, next)) return false;
  db.sets = next;
  // Drop references to the set. If either write fails we only leave harmless leftovers behind.
  const folders = db.folders.map((f) => (f.setIds.includes(id) ? { ...f, setIds: f.setIds.filter((x) => x !== id) } : f));
  if (writeJSON(KEYS.folders, folders)) db.folders = folders;
  const { [id]: _removed, ...study } = db.study;
  if (writeJSON(KEYS.study, study)) db.study = study;
  return true;
}

/* Folders */

const findFolder = (id) => db.folders.find((f) => f.id === id);
const foldersWithSet = (setId) => db.folders.filter((f) => f.setIds.includes(setId));
const setsInFolder = (folder) => folder.setIds.map(findSet).filter(Boolean);

function saveFolder(folder) {
  const exists = db.folders.some((f) => f.id === folder.id);
  const next = exists ? db.folders.map((f) => (f.id === folder.id ? folder : f)) : [...db.folders, folder];
  if (!writeJSON(KEYS.folders, next)) return false;
  db.folders = next;
  return true;
}

function removeFolder(id) {
  const next = db.folders.filter((f) => f.id !== id);
  if (!writeJSON(KEYS.folders, next)) return false;
  db.folders = next;
  return true;
}

function setInFolder(folderId, setId, include) {
  const folder = findFolder(folderId);
  if (!folder) return false;
  if (folder.setIds.includes(setId) === include) return true;
  const setIds = include ? [...folder.setIds, setId] : folder.setIds.filter((x) => x !== setId);
  return saveFolder({ ...folder, setIds, updatedAt: Date.now() });
}

/* Per-set study data (stars, Learn progress, best scores, mode settings) */

function studyOf(setId) {
  const s = db.study[setId] || {};
  return {
    starred: Array.isArray(s.starred) ? s.starred : [],
    progress: s.progress && typeof s.progress === 'object' ? s.progress : {},
    best: s.best && typeof s.best === 'object' ? s.best : {},
    settings: s.settings && typeof s.settings === 'object' ? s.settings : {},
  };
}

// Applies `mutate` to a copy of the set's study data and saves it.
function updateStudy(setId, mutate) {
  const data = structuredClone(studyOf(setId));
  mutate(data);
  const next = { ...db.study, [setId]: data };
  if (!writeJSON(KEYS.study, next)) return false;
  db.study = next;
  return true;
}

const isStarred = (setId, cardId) => studyOf(setId).starred.includes(cardId);

// Flips a card's star and returns the new state.
function toggleStar(setId, cardId) {
  const on = !isStarred(setId, cardId);
  updateStudy(setId, (d) => {
    d.starred = on ? [...d.starred, cardId] : d.starred.filter((x) => x !== cardId);
  });
  return on;
}

function starredCards(set) {
  const ids = studyOf(set.id).starred;
  return set.cards.filter((c) => ids.includes(c.id));
}

// The cards a mode should use: just the starred ones when asked (and there are any), otherwise all.
function studyPool(set, starredOnly) {
  if (starredOnly) {
    const starred = starredCards(set);
    if (starred.length) return starred;
  }
  return set.cards;
}

/* Learn progress. level 0 = not answered correctly yet, 1 = familiar, 2 = mastered. */

const MASTERED = 2;

function cardProgress(setId, cardId) {
  return studyOf(setId).progress[cardId] || { level: 0, seen: false };
}

// 'new' (not studied) | 'learning' (still learning) | 'mastered'
function cardStatus(setId, cardId) {
  const p = cardProgress(setId, cardId);
  if (p.level >= MASTERED) return 'mastered';
  return p.seen ? 'learning' : 'new';
}

function progressCounts(set, cards = set.cards) {
  const counts = { new: 0, learning: 0, mastered: 0 };
  for (const c of cards) counts[cardStatus(set.id, c.id)]++;
  return counts;
}

function recordProgress(setId, cardId, level) {
  updateStudy(setId, (d) => {
    d.progress[cardId] = { level: Math.max(0, Math.min(MASTERED, level)), seen: true };
  });
}

function resetProgress(setId, cardIds) {
  updateStudy(setId, (d) => {
    if (!cardIds) d.progress = {};
    else for (const id of cardIds) delete d.progress[id];
  });
}

/* Best scores for games */

const getBest = (setId, game) => studyOf(setId).best[game] ?? null;

// Saves `value` if it beats the stored record and returns true when it did.
function recordBest(setId, game, value, lowerIsBetter = false) {
  const prev = getBest(setId, game);
  const better = prev == null || (lowerIsBetter ? value < prev : value > prev);
  if (better) updateStudy(setId, (d) => { d.best[game] = value; });
  return better;
}

/* Remembered options per set and mode */

function getSettings(setId, mode, defaults) {
  return { ...defaults, ...(studyOf(setId).settings[mode] || {}) };
}

function saveSettings(setId, mode, settings) {
  updateStudy(setId, (d) => { d.settings[mode] = settings; });
}

/* ------------------------------------------------------------
   Questions & grading
   ------------------------------------------------------------ */

const SIDE_LABEL = { term: 'Term', definition: 'Definition' };
const otherSide = (side) => (side === 'term' ? 'definition' : 'term');

// answerWith: 'term' | 'definition' | 'both' ('both' picks a side at random per question).
// Pass the set's cards so duplicates are handled: when several cards show the same prompt
// (e.g. two terms that share the definition "Paris"), every one of their answers is correct.
function makeQuestion(card, answerWith, cards = [card]) {
  const answerSide = answerWith === 'both' ? (Math.random() < 0.5 ? 'term' : 'definition') : answerWith;
  const promptSide = otherSide(answerSide);
  const question = { card, promptSide, answerSide, prompt: card[promptSide], answer: card[answerSide] };
  question.answers = acceptedAnswers(question, cards);
  return question;
}

// Every answer that's right for this question: its own, plus those of cards with the same prompt.
function acceptedAnswers(question, cards) {
  const prompt = normalize(question.prompt);
  const answers = [question.answer];
  for (const c of cards) {
    if (c.id !== question.card.id && normalize(c[question.promptSide]) === prompt) answers.push(c[question.answerSide]);
  }
  return answers;
}

// True when `text` (a picked option or shown answer) is one of the question's right answers.
function isAcceptedAnswer(question, text) {
  const key = normalize(text);
  return (question.answers || [question.answer]).some((a) => normalize(a) === key);
}

// Answer options for a multiple-choice question: the correct answer plus up to count-1
// distinct wrong answers taken from `cards` (pass the whole set for the most variety).
// Answers that would also be right (duplicates) are never offered as decoys.
function choicesFor(question, cards, count = 4) {
  const seen = new Set(acceptedAnswers(question, cards).map(normalize));
  const wrong = [];
  for (const c of shuffle(cards)) {
    if (wrong.length >= count - 1) break;
    const text = c[question.answerSide];
    const key = normalize(text);
    if (c.id === question.card.id || seen.has(key)) continue;
    seen.add(key);
    wrong.push(text);
  }
  return shuffle([question.answer, ...wrong]);
}

// Lowercase, unify quotes, turn punctuation into spaces and collapse whitespace.
function normalize(text) {
  return String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Edit distance where swapping two neighbouring letters ("teh" → "the") counts as a single typo.
function editDistance(a, b) {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// "the library (building)" also accepts "the library"; "car; automobile" or "car / auto" accept either part.
function answerVariants(answer) {
  const variants = new Set([normalize(answer), normalize(answer.replace(/\([^)]*\)/g, ' '))]);
  const parts = answer.split(/[;/]/);
  if (parts.length > 1) parts.forEach((p) => variants.add(normalize(p)));
  variants.delete('');
  return [...variants];
}

// 'correct' — matches, ignoring case, punctuation and extra spaces
// 'close'   — off by a small typo; count it as correct but show the right spelling
// 'wrong'
// `answer` may be a list of acceptable answers (question.answers).
function gradeWritten(input, answer) {
  const given = normalize(input);
  if (!given) return 'wrong';
  const variants = [].concat(answer).flatMap(answerVariants);
  if (variants.includes(given)) return 'correct';
  for (const v of variants) {
    const allowed = v.length < 4 ? 0 : v.length < 9 ? 1 : Math.min(3, Math.floor(v.length / 8));
    if (allowed && editDistance(given, v) <= allowed) return 'close';
  }
  return 'wrong';
}

// Answers this long are unreasonable to type out exactly; modes self-grade them instead.
const isLongAnswer = (text) => text.length > 60;

// A data-size bucket for fitting text of any length in a fixed box ('l' | 'm' | 's' | 'xs').
function textSize(text) {
  const n = text.length;
  return n > 300 ? 'xs' : n > 140 ? 's' : n > 50 ? 'm' : 'l';
}

/* ------------------------------------------------------------
   Speech (text-to-speech)
   ------------------------------------------------------------ */

const canSpeak = 'speechSynthesis' in window;
const langOf = (set, side) => (side === 'term' ? set.termLang : set.definitionLang) || '';

function speak(text, lang) {
  if (!canSpeak || !text) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  if (lang) utterance.lang = lang;
  speechSynthesis.speak(utterance);
}

// A speaker button that reads `getText()` aloud. Clicks don't bubble (so it can sit on a flip card).
function speakButton(getText, getLang, label = 'Read aloud') {
  if (!canSpeak) return null;
  return h('button', {
    type: 'button',
    class: 'icon-btn speak-btn',
    title: label,
    'aria-label': label,
    onclick: (e) => {
      e.stopPropagation();
      speak(getText(), getLang ? getLang() : '');
    },
  }, icon('volume'));
}

/* ------------------------------------------------------------
   DOM helpers
   ------------------------------------------------------------ */

// h('a', { class: 'btn', href: '#/', onclick: fn }, 'text', childNode, [moreChildren])
// Props that exist on the element are set as properties, others as attributes; `on…` adds listeners.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child);
  }
  return el;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  restart: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10.5v5M9.5 13h5"/>',
  cards: '<rect x="3" y="7" width="14" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v10"/>',
  learn: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/><path d="m8.5 12 2.5 2.5 4.5-4.5"/>',
  test: '<path d="M9 3h6v3H9z"/><path d="M15 4.5h2a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2"/><path d="m9 13.5 2 2 4-4"/>',
  match: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="13" width="8" height="8" rx="2"/><path d="M7 15v2a2 2 0 0 0 2 2h2M17 9V7a2 2 0 0 0-2-2h-2"/>',
  blast: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3s-2.2-.8-3 0Z"/><path d="m12 15-3-3a22 22 0 0 1 2-4A13 13 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2Z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  play: '<path d="M7 4v16l13-8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M10 2h4"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

function autosize(textarea) {
  const borders = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + borders}px`;
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 864e5);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

// 8400 -> "8.4s", 72300 -> "1:12.3"
function formatTime(ms) {
  const tenths = Math.floor(ms / 100);
  const seconds = Math.floor(tenths / 10);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const t = tenths % 10;
  return m ? `${m}:${String(s).padStart(2, '0')}.${t}` : `${s}.${t}s`;
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sample = (items, n) => shuffle(items).slice(0, n);

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let toastTimer;
function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2800);
}

/* ------------------------------------------------------------
   Page lifecycle — the router (app.js) calls runCleanups() before
   rendering each page. Views register what to undo with onLeave().
   ------------------------------------------------------------ */

let cleanups = [];
let leaveGuard = null; // returns true if it's OK to leave the current page

function onLeave(fn) {
  cleanups.push(fn);
}

function setLeaveGuard(fn) {
  leaveGuard = fn;
}

function runCleanups() {
  const fns = cleanups;
  cleanups = [];
  leaveGuard = null;
  for (const fn of fns) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

// Page-level keyboard shortcuts. Ignores key combos, keys something else already handled (e.g. the
// Escape that just closed a modal), keys typed while a modal is open, and (unless inFields) keys typed
// into form fields. Removed automatically on navigation.
function listenKeys(handler, { inFields = false } = {}) {
  const listener = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal')) return;
    if (!inFields && e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    handler(e);
  };
  document.addEventListener('keydown', listener);
  onLeave(() => document.removeEventListener('keydown', listener));
}

// Runs `fn` after `ms` unless the page is left first. Returns a cancel function.
function later(fn, ms) {
  const id = setTimeout(fn, ms);
  onLeave(() => clearTimeout(id));
  return () => clearTimeout(id);
}

/* ------------------------------------------------------------
   Study modes
   Each mode file calls registerMode(); the router sends
   #/set/:id/<key> to mode.render(set, root).
   ------------------------------------------------------------ */

const MODES = {};

function registerMode(key, { title, icon: iconName, description, order = 99, render }) {
  MODES[key] = { key, title, icon: iconName, description, order, render };
}

const modeList = () => Object.values(MODES).sort((a, b) => a.order - b.order);

// Standard header for a study mode page: mode + set name on the left; extra controls,
// an options button (if onOptions is given) and a close link on the right.
function modeHeader(set, modeKey, { onOptions, extra } = {}) {
  const mode = MODES[modeKey];
  return h('div', { class: 'mode-bar' },
    h('div', { class: 'mode-bar__title' },
      h('span', { class: 'mode-bar__icon' }, icon(mode.icon)),
      h('div', { class: 'mode-bar__text' },
        h('div', { class: 'mode-bar__name' }, mode.title),
        h('a', { class: 'mode-bar__set', href: `#/set/${set.id}` }, set.title),
      ),
    ),
    h('div', { class: 'mode-bar__actions' },
      extra,
      onOptions && h('button', {
        type: 'button', class: 'btn btn-secondary', onclick: onOptions,
      }, icon('settings'), h('span', { class: 'hide-sm' }, 'Options')),
      h('a', {
        class: 'icon-btn', href: `#/set/${set.id}`, title: 'Close', 'aria-label': `Close ${mode.title}`,
      }, icon('close')),
    ),
  );
}

/* ------------------------------------------------------------
   Shared UI components
   ------------------------------------------------------------ */

// Modal dialog. `body` is a Node (or array of Nodes). Each action is
// { label, primary?, danger?, onClick? }; returning false from onClick keeps the modal open.
function openModal({ title, body, actions = [], onClose }) {
  const returnFocus = document.activeElement;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    returnFocus?.focus?.();
    onClose?.();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  const panel = h('div', { class: 'modal__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
    h('div', { class: 'modal__head' },
      h('h2', {}, title),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close')),
    ),
    h('div', { class: 'modal__body' }, body),
    actions.length > 0 && h('div', { class: 'modal__foot' },
      actions.map((a) =>
        h('button', {
          type: 'button',
          class: `btn ${a.primary ? 'btn-primary' : 'btn-secondary'}${a.danger ? ' btn-danger' : ''}`,
          onclick: () => {
            if (a.onClick?.() !== false) close();
          },
        }, a.label),
      ),
    ),
  );
  const overlay = h('div', {
    class: 'modal',
    onmousedown: (e) => {
      if (e.target === overlay) close();
    },
  }, panel);

  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  onLeave(close);
  (panel.querySelector('input, select, textarea') || panel).focus();
  return { close, panel };
}

// A labelled block inside an options modal.
function optionGroup(label, control, hint) {
  return h('div', { class: 'opt-group' },
    h('div', { class: 'opt-group__label' }, label),
    control,
    hint && h('p', { class: 'opt-group__hint' }, hint),
  );
}

// Segmented control. options: [{ value, label }]
function segmented(options, value, onChange) {
  const buttons = options.map((o) =>
    h('button', {
      type: 'button',
      class: 'seg__btn',
      role: 'radio',
      'aria-checked': String(o.value === value),
      onclick: (e) => {
        buttons.forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
        onChange(o.value);
      },
    }, o.label),
  );
  return h('div', { class: 'seg', role: 'radiogroup' }, buttons);
}

// "Answer with: Term / Definition / Both" — used by Flashcards, Learn and Test options.
function answerWithControl(value, onChange, { allowBoth = true } = {}) {
  const options = [
    { value: 'term', label: 'Term' },
    { value: 'definition', label: 'Definition' },
  ];
  if (allowBoth) options.push({ value: 'both', label: 'Both' });
  return segmented(options, value, onChange);
}

// On/off switch row.
function switchRow(label, checked, onChange, { disabled = false, hint } = {}) {
  const input = h('input', {
    type: 'checkbox',
    class: 'switch__input',
    checked,
    disabled,
    onchange: (e) => onChange(e.target.checked),
  });
  return h('label', { class: `switch${disabled ? ' is-disabled' : ''}` },
    h('span', { class: 'switch__text' }, label, hint && h('span', { class: 'switch__hint' }, hint)),
    input,
    h('span', { class: 'switch__track', 'aria-hidden': 'true' }),
  );
}

// "Study starred terms only" switch — disabled with a hint when nothing is starred yet.
function starredOnlySwitch(set, checked, onChange) {
  const count = starredCards(set).length;
  return switchRow('Study starred terms only', checked && count > 0, onChange, {
    disabled: count === 0,
    hint: count ? plural(count, 'starred term') : 'Star terms on the set page to use this',
  });
}

// The prompt shown above a question: side label, text (sized to fit) and a speaker button.
function promptBlock(set, question) {
  return h('div', { class: 'prompt' },
    h('div', { class: 'prompt__head' },
      h('span', { class: 'prompt__label' }, SIDE_LABEL[question.promptSide]),
      speakButton(() => question.prompt, () => langOf(set, question.promptSide)),
    ),
    h('div', { class: 'prompt__text fit-text', 'data-size': textSize(question.prompt) }, question.prompt),
  );
}

// Multiple-choice answer buttons with 1–4 number hints. onPick(index, text) fires on click.
// Returns { el, buttons, mark(correctText, pickedIndex) } — mark() colours the buttons and disables them.
function choiceList(choices, onPick) {
  const buttons = choices.map((text, i) =>
    h('button', {
      type: 'button',
      class: 'choice',
      onclick: () => onPick(i, text),
    },
      h('span', { class: 'choice__key', 'aria-hidden': 'true' }, i + 1),
      h('span', { class: 'choice__text' }, text),
    ),
  );
  return {
    el: h('div', { class: 'choices' }, buttons),
    buttons,
    mark(correctText, pickedIndex) {
      buttons.forEach((b, i) => {
        const isCorrect = choices[i] === correctText;
        b.disabled = true;
        b.classList.toggle('is-correct', isCorrect);
        b.classList.toggle('is-wrong', i === pickedIndex && !isCorrect);
        b.classList.toggle('is-dim', !isCorrect && i !== pickedIndex);
      });
    },
  };
}
