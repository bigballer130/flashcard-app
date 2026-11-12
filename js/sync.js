'use strict';

/* ============================================================
   sync.js — keeps your sets, folders and study progress the same
   on every device and browser, through a secret gist in your own
   GitHub account.

   Each device keeps its full data locally (localStorage). Syncing
   downloads the gist, merges it with local data item by item using
   the change times recorded in core.js (newest change wins, a
   deletion wins over older edits), keeps the result locally and
   uploads it if it differs from what was downloaded.
   ============================================================ */

const SYNC_KEYS = {
  token: 'flashcards.sync-token',
  gist: 'flashcards.sync-gist',
  login: 'flashcards.sync-login',
  last: 'flashcards.sync-last',
};
const GIST_FILE = 'flashcards.json';
const GIST_DESCRIPTION = "Flashcards sync data (managed by the app, don't edit)";
const GITHUB_API = 'https://api.github.com';
const TOMBSTONE_TTL = 180 * 86400000;
const SYNC_NAMES = ['sets', 'folders', 'study'];

const syncRead = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const syncWrite = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch { /* ignore */ }
};

/* ---------------- snapshots and merging ---------------- */

function localSnapshot() {
  return { version: 1, sets: db.sets, folders: db.folders, study: db.study, meta: readSyncMeta() };
}

function validSnapshot(s) {
  return s && s.version === 1 && Array.isArray(s.sets) && Array.isArray(s.folders) &&
    s.study && typeof s.study === 'object' && !Array.isArray(s.study);
}

// Same winner on every device when two edits have the same time.
const tieBreak = (a, b) => (JSON.stringify(a) >= JSON.stringify(b) ? a : b);

function mergeSnapshots(local, remote) {
  const lm = local.meta || { stamps: {}, tombstones: {} };
  const rm = remote.meta || { stamps: {}, tombstones: {} };
  const now = Date.now();
  const tombstones = {};
  for (const k of new Set([...Object.keys(lm.tombstones), ...Object.keys(rm.tombstones)])) {
    const t = Math.max(lm.tombstones[k] || 0, rm.tombstones[k] || 0);
    if (now - t < TOMBSTONE_TTL) tombstones[k] = t;
  }
  const stamps = {};
  const out = { version: 1 };

  for (const name of SYNC_NAMES) {
    const l = new Map(syncEntries(name, local[name]));
    const r = new Map(syncEntries(name, remote[name]));
    const merged = [];
    for (const id of new Set([...l.keys(), ...r.keys()])) {
      const key = `${name}:${id}`;
      const ls = lm.stamps[key] || 0;
      const rs = rm.stamps[key] || 0;
      const a = l.get(id);
      const b = r.get(id);
      let winner;
      let at;
      if (a && b) {
        winner = ls > rs ? a : rs > ls ? b : tieBreak(a, b);
        at = Math.max(ls, rs);
      } else {
        winner = a || b;
        at = a ? ls : rs;
      }
      if ((tombstones[key] || 0) >= at && tombstones[key]) continue;
      delete tombstones[key];
      if (at) stamps[key] = at;
      merged.push([id, winner]);
    }
    out[name] = name === 'study' ? Object.fromEntries(merged) : merged.map(([, v]) => v);
  }

  // A folder may still list a set that another device deleted.
  const setIds = new Set(out.sets.map((s) => s.id));
  out.folders = out.folders.map((f) =>
    f.setIds.every((id) => setIds.has(id)) ? f : { ...f, setIds: f.setIds.filter((id) => setIds.has(id)) });
  out.study = Object.fromEntries(Object.entries(out.study).filter(([id]) => setIds.has(id)));

  out.meta = { stamps, tombstones };
  return out;
}

// Order-independent text form, so equal data compares equal across devices.
function stableJSON(v) {
  if (Array.isArray(v)) return `[${v.map(stableJSON).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJSON(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const canonicalData = (s) => stableJSON({ sets: byId(s.sets), folders: byId(s.folders), study: s.study });
const canonicalAll = (s) => stableJSON({ data: canonicalData(s), meta: s.meta });

function applySnapshot(s) {
  applyingRemote = true;
  try {
    writeJSON(KEYS.sets, s.sets);
    writeJSON(KEYS.folders, s.folders);
    writeJSON(KEYS.study, s.study);
    syncWrite(SYNC_META_KEY, JSON.stringify(s.meta));
  } finally {
    applyingRemote = false;
  }
  refreshFromStorage();
}

/* ---------------- GitHub ---------------- */

class SyncError extends Error {}

async function githubApi(token, path, init = {}) {
  let res;
  try {
    res = await fetch(GITHUB_API + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
    });
  } catch {
    throw new SyncError('offline');
  }
  if (res.status === 401) throw new SyncError('GitHub rejected the key. It may have expired: create a new one.');
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    throw new SyncError('GitHub is limiting requests for a while. Sync will resume by itself.');
  }
  if (res.status === 403 || res.status === 404) {
    throw new SyncError('The key can’t reach your gists. Make sure it has the “gist” permission.');
  }
  if (!res.ok) throw new SyncError(`GitHub returned an error (${res.status}). Will try again.`);
  return res.json();
}

async function readGist(token, id) {
  const gist = await githubApi(token, `/gists/${id}`);
  const file = gist.files && gist.files[GIST_FILE];
  if (!file) return null;
  let text = file.content || '';
  if (file.truncated && file.raw_url) {
    try {
      text = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
    } catch {
      throw new SyncError('offline');
    }
  }
  if (!text.trim()) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SyncError('The synced data looks damaged.');
  }
  if (!validSnapshot(data)) throw new SyncError('The synced data looks damaged.');
  return data;
}

const writeGist = (token, id, snapshot) => githubApi(token, `/gists/${id}`, {
  method: 'PATCH',
  body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(snapshot) } } }),
});

async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await githubApi(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.description === GIST_DESCRIPTION || (g.files && GIST_FILE in g.files));
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

/* ---------------- status ---------------- */

const syncStatus = {
  phase: syncRead(SYNC_KEYS.token) && syncRead(SYNC_KEYS.gist) ? 'idle' : 'off', // off | idle | syncing | error | offline
  error: null,
  lastSync: Number(syncRead(SYNC_KEYS.last)) || null,
  login: syncRead(SYNC_KEYS.login),
};
const syncListeners = new Set();

function setSyncStatus(patch) {
  Object.assign(syncStatus, patch);
  syncListeners.forEach((fn) => fn());
}

/* ---------------- sync loop ---------------- */

let syncRunning = null;
let syncAgain = false;
let syncDirty = false;

function syncNow() {
  if (syncRunning) {
    syncAgain = true;
    return syncRunning;
  }
  syncRunning = (async () => {
    do {
      syncAgain = false;
      await syncOnce();
    } while (syncAgain);
  })().finally(() => {
    syncRunning = null;
  });
  return syncRunning;
}

async function syncOnce() {
  const token = syncRead(SYNC_KEYS.token);
  const gistId = syncRead(SYNC_KEYS.gist);
  if (!token || !gistId) return;
  if (!navigator.onLine) return setSyncStatus({ phase: 'offline' });
  setSyncStatus({ phase: 'syncing' });
  try {
    const remote = await readGist(token, gistId);
    // Everything from here to the upload is synchronous, so no local edit can slip in between.
    loadAll();
    const local = localSnapshot();
    const merged = remote ? mergeSnapshots(local, remote) : local;
    if (canonicalAll(merged) !== canonicalAll(local)) applySnapshot(merged);
    syncDirty = false;
    if (!remote || canonicalAll(merged) !== canonicalAll(remote)) await writeGist(token, gistId, merged);
    const now = Date.now();
    syncWrite(SYNC_KEYS.last, String(now));
    setSyncStatus({ phase: 'idle', error: null, lastSync: now });
  } catch (e) {
    if (e.message === 'offline') setSyncStatus({ phase: 'offline' });
    else setSyncStatus({ phase: 'error', error: e.message });
  }
}

// Checks the key, finds or creates the gist, and merges this device's data with it.
async function connectSync(rawToken) {
  const token = rawToken.trim();
  try {
    const user = await githubApi(token, '/user');
    let gistId = await findGist(token);
    if (!gistId) {
      const created = await githubApi(token, '/gists', {
        method: 'POST',
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          public: false,
          files: { [GIST_FILE]: { content: JSON.stringify(localSnapshot()) } },
        }),
      });
      gistId = created.id;
    }
    syncWrite(SYNC_KEYS.token, token);
    syncWrite(SYNC_KEYS.gist, gistId);
    syncWrite(SYNC_KEYS.login, user.login);
    setSyncStatus({ phase: 'idle', error: null, login: user.login });
    await syncNow();
    if (syncStatus.phase === 'error') throw new SyncError(syncStatus.error);
  } catch (e) {
    throw new Error(e.message === 'offline' ? 'Couldn’t reach GitHub. Check your internet connection.' : e.message);
  }
}

function disconnectSync() {
  for (const k of Object.values(SYNC_KEYS)) syncWrite(k, null);
  setSyncStatus({ phase: 'off', error: null, login: null, lastSync: null });
}

/* ---------------- UI ---------------- */

const syncButton = document.getElementById('sync-btn');

function syncLabel() {
  switch (syncStatus.phase) {
    case 'off': return 'Sync is off';
    case 'syncing': return 'Syncing…';
    case 'offline': return 'Offline: changes will sync when you’re back online';
    case 'error': return `Sync problem: ${syncStatus.error}`;
    default: return syncStatus.lastSync ? `Synced ${formatSyncTime(syncStatus.lastSync)}` : 'Synced';
  }
}

function formatSyncTime(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function updateSyncButton() {
  if (!syncButton) return;
  syncButton.dataset.state = syncStatus.phase;
  syncButton.title = syncLabel();
  syncButton.setAttribute('aria-label', `Sync between devices. ${syncLabel()}`);
}
syncListeners.add(updateSyncButton);
updateSyncButton();

function openSyncModal() {
  if (syncStatus.phase === 'off') return openConnectModal();

  const status = h('p', { class: 'sync-status' });
  const render = () => {
    status.textContent = syncLabel();
    status.dataset.state = syncStatus.phase;
  };
  render();
  syncListeners.add(render);

  openModal({
    title: 'Sync',
    body: [
      h('p', {}, 'Connected to GitHub as ', h('strong', {}, syncStatus.login || 'you'),
        '. Your sets, folders and study progress are the same on every device you connect.'),
      status,
      h('p', { class: 'muted sync-small' },
        'Changes sync a couple of seconds after you make them, and whenever you come back to the app.'),
    ],
    actions: [
      {
        label: 'Disconnect this device',
        danger: true,
        onClick: () => {
          disconnectSync();
          toast('Sync turned off on this device. Your cards stay here.');
        },
      },
      { label: 'Sync now', primary: true, onClick: () => { syncNow(); return false; } },
    ],
    onClose: () => {
      syncListeners.delete(render);
      refreshFromStorage();
    },
  });
}

function openConnectModal() {
  const tokenLink = 'https://github.com/settings/tokens/new?scopes=gist&description=Flashcards%20sync';
  const input = h('input', {
    type: 'password', class: 'input', autocomplete: 'off', spellcheck: false,
    placeholder: 'ghp_…', oninput: () => { input.classList.remove('invalid'); error.textContent = ''; },
  });
  const error = h('p', { class: 'sync-error', role: 'alert' });
  let busy = false;

  async function connect() {
    if (busy) return false;
    if (!input.value.trim()) {
      input.classList.add('invalid');
      input.focus();
      return false;
    }
    busy = true;
    error.textContent = 'Connecting…';
    try {
      await connectSync(input.value);
      modal.close();
      toast('Sync is on. Connect your other devices with the same key.');
    } catch (e) {
      error.textContent = e.message;
    } finally {
      busy = false;
    }
    return false;
  }

  const modal = openModal({
    title: 'Sync between devices',
    body: [
      h('p', {}, 'Keep the same sets, folders and progress on your laptop, phone and any browser. ' +
        'Your cards are saved in a private file in your own GitHub account.'),
      h('ol', { class: 'sync-steps' },
        h('li', {}, h('a', { href: tokenLink, target: '_blank', rel: 'noopener' }, 'Create a GitHub key'),
          ' with only the “gist” permission ticked. Set the expiration to “No expiration” (or as long as possible), then click “Generate token” and copy it.'),
        h('li', {}, 'Paste it here and press Connect.'),
        h('li', {}, 'On your other devices, open this page, press the cloud button and paste the same key.'),
      ),
      labelled('GitHub key', input),
      error,
      h('p', { class: 'muted sync-small' },
        'Cards already on this device are combined with the synced ones; nothing is deleted. ' +
        'The key is only stored in this browser. Don’t share it: it lets anyone read your synced cards.'),
    ],
    actions: [{ label: 'Cancel' }, { label: 'Connect', primary: true, onClick: () => { connect(); return false; } }],
    onClose: refreshFromStorage,
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      connect();
    }
  });
}

syncButton?.addEventListener('click', openSyncModal);

/* ---------------- triggers ---------------- */

let syncDebounce = 0;
window.addEventListener('flashcards:changed', () => {
  if (syncStatus.phase === 'off') return;
  syncDirty = true;
  clearTimeout(syncDebounce);
  syncDebounce = setTimeout(syncNow, 2000);
});

const syncKick = () => {
  if (syncStatus.phase !== 'off' && document.visibilityState === 'visible') syncNow();
};
window.addEventListener('focus', syncKick);
window.addEventListener('online', syncKick);
document.addEventListener('visibilitychange', syncKick);
// Push pending edits before the page goes away (e.g. a phone switching apps).
window.addEventListener('pagehide', () => {
  if (syncDirty && syncStatus.phase !== 'off') syncNow();
});
setInterval(syncKick, 30000);
syncKick();
