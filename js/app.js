'use strict';

/* ============================================================
   app.js — router, library, folders, set page and set editor.
   Study modes live in their own files and register themselves
   with registerMode() (see core.js).
   ============================================================ */

const app = document.getElementById('app');

/* ============================================================
   Router
   #/                 your sets          #/folders        your folders
   #/new              create a set       #/folder/:id     one folder
   #/set/:id          set page           #/set/:id/edit   edit a set
   #/set/:id/<mode>   a study mode (flashcards, learn, test, match, blast)
   ============================================================ */

let currentHash = null;

const parseHash = () => location.hash.replace(/^#\/?/, '').split('/');

function go(hash) {
  location.hash = hash;
}

function route() {
  if (location.hash === currentHash) return;
  if (leaveGuard && !leaveGuard()) {
    location.hash = currentHash; // undo the navigation; the resulting hashchange is a no-op
    return;
  }
  currentHash = location.hash;
  render();
}

function render() {
  runCleanups();
  app.replaceChildren();
  window.scrollTo(0, 0);

  const [view = '', id, action] = parseHash();
  updateNav(view);

  if (!view) return renderSetsLibrary();
  if (view === 'folders') return renderFoldersLibrary();
  if (view === 'new') return renderEditor(null);
  if (view === 'folder') {
    const folder = findFolder(id);
    return folder ? renderFolder(folder) : renderNotFound('folder');
  }
  if (view === 'set') {
    const set = findSet(id);
    if (!set) return renderNotFound('set');
    if (!action) return renderSetPage(set);
    if (action === 'edit') return renderEditor(set);
    if (MODES[action]) return MODES[action].render(set, app);
  }
  renderNotFound();
}

function updateNav(view) {
  const active = view === 'folders' || view === 'folder' ? 'folders' : view === '' || view === 'set' ? 'sets' : null;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', route);

// Keep several open tabs in sync — but only re-render pages that hold no in-progress work.
// Also used by sync (js/sync.js) after it brings in changes from another device.
function refreshFromStorage() {
  loadAll();
  const [view = '', , action] = parseHash();
  const passive = ['', 'folders', 'folder'].includes(view) || (view === 'set' && !action);
  // Never yank away an open window (e.g. a folder being named); the page catches up on the next render.
  if (passive && !leaveGuard && !document.querySelector('.modal')) render();
}

window.addEventListener('storage', (e) => {
  if (Object.values(KEYS).includes(e.key)) refreshFromStorage();
});

/* ============================================================
   Shared bits
   ============================================================ */

const sortedSets = () => [...db.sets].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

function emptyState({ title, text, action, art = 'cards' }) {
  return h('section', { class: 'empty' },
    art === 'cards'
      ? h('div', { class: 'empty__art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'))
      : h('div', { class: 'empty__icon', 'aria-hidden': 'true' }, icon(art)),
    h('h1', {}, title),
    text && h('p', { class: 'muted' }, text),
    action,
  );
}

// Stacked mastered / still-learning bar.
function progressBar(counts, total, className = '') {
  const pct = (n) => `${(n / total) * 100}%`;
  return h('div', { class: `stack-bar ${className}`, 'aria-hidden': 'true' },
    h('span', { class: 'stack-bar__mastered', style: `width: ${pct(counts.mastered)}` }),
    h('span', { class: 'stack-bar__learning', style: `width: ${pct(counts.learning)}` }),
  );
}

function setTile(set, { onRemove } = {}) {
  const counts = progressCounts(set);
  const studied = counts.learning + counts.mastered > 0;
  const mastered = Math.round((counts.mastered / set.cards.length) * 100);
  return h('li', { class: 'tile-wrap' },
    h('a', { class: 'set-tile', href: `#/set/${set.id}` },
      h('h2', { class: 'set-tile__title' }, set.title),
      h('span', { class: 'pill' }, plural(set.cards.length, 'term')),
      set.description && h('p', { class: 'set-tile__desc' }, set.description),
      studied && h('div', { class: 'set-tile__progress' },
        progressBar(counts, set.cards.length),
        h('span', {}, `${mastered}% mastered`),
      ),
      h('span', { class: 'set-tile__meta' }, `Updated ${formatDate(set.updatedAt)}`),
    ),
    onRemove && h('button', {
      type: 'button',
      class: 'icon-btn tile-remove',
      title: 'Remove from folder',
      'aria-label': `Remove “${set.title}” from this folder`,
      onclick: onRemove,
    }, icon('close')),
  );
}

// A checkbox row for pick lists inside modals.
function checkRow(label, sub, checked, onChange) {
  return h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
    h('span', { class: 'check-row__text' }, h('span', { class: 'check-row__label' }, label), sub && h('span', { class: 'check-row__sub' }, sub)),
  );
}

function labelled(label, control) {
  return h('label', { class: 'labelled' }, h('span', { class: 'labelled__label' }, label), control);
}

/* ============================================================
   Library — sets
   ============================================================ */

function renderSetsLibrary() {
  document.title = 'Your sets · Flashcards';

  if (db.sets.length === 0) {
    app.append(emptyState({
      title: 'Make your first flashcard set',
      text: 'Add terms and definitions, then study them with flashcards, Learn, practice tests and games.',
      action: h('a', { class: 'btn btn-primary btn-lg', href: '#/new' }, icon('plus'), 'Create a set'),
    }));
    return;
  }

  const sets = sortedSets();
  const grid = h('ul', { class: 'set-grid' });
  const search = h('input', {
    type: 'search',
    class: 'search__input',
    placeholder: 'Search your sets',
    'aria-label': 'Search your sets',
    oninput: renderGrid,
  });

  function renderGrid() {
    const q = normalize(search.value);
    const matches = !q ? sets : sets.filter((s) =>
      normalize(`${s.title} ${s.description || ''}`).includes(q)
      || s.cards.some((c) => normalize(`${c.term} ${c.definition}`).includes(q)));
    grid.replaceChildren(...matches.map((s) => setTile(s)));
    if (!matches.length) grid.append(h('li', { class: 'grid-empty muted' }, `No sets match “${search.value.trim()}”.`));
  }

  app.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'page-head__title' }, h('h1', {}, 'Your sets'), h('span', { class: 'muted' }, plural(sets.length, 'set'))),
      h('div', { class: 'search' }, icon('search'), search),
    ),
    grid,
  );
  renderGrid();
}

/* ============================================================
   Library — folders
   ============================================================ */

function renderFoldersLibrary() {
  document.title = 'Your folders · Flashcards';
  const newFolderBtn = (big) => h('button', {
    type: 'button',
    class: `btn btn-primary${big ? ' btn-lg' : ''}`,
    onclick: () => folderForm(null, (f) => go(`#/folder/${f.id}`)),
  }, icon('folderPlus'), 'New folder');

  if (db.folders.length === 0) {
    app.append(emptyState({
      art: 'folder',
      title: 'Organize your sets with folders',
      text: 'Group sets by class, subject or exam so they’re easy to find.',
      action: newFolderBtn(true),
    }));
    return;
  }

  const folders = [...db.folders].sort((a, b) => a.name.localeCompare(b.name));
  app.append(
    h('div', { class: 'page-head' },
      h('div', { class: 'page-head__title' }, h('h1', {}, 'Your folders'), h('span', { class: 'muted' }, plural(folders.length, 'folder'))),
      newFolderBtn(false),
    ),
    h('ul', { class: 'set-grid' },
      folders.map((f) => {
        const count = setsInFolder(f).length;
        return h('li', {},
          h('a', { class: 'set-tile folder-tile', href: `#/folder/${f.id}` },
            h('span', { class: 'folder-tile__icon' }, icon('folder')),
            h('h2', { class: 'set-tile__title' }, f.name),
            h('span', { class: 'pill' }, plural(count, 'set')),
            f.description && h('p', { class: 'set-tile__desc' }, f.description),
          ),
        );
      }),
    ),
  );
}

function folderForm(folder, onSaved) {
  const name = h('input', {
    type: 'text', class: 'input', value: folder?.name ?? '', maxLength: 80, placeholder: 'e.g. Biology 101',
    oninput: (e) => e.target.classList.remove('invalid'),
  });
  const description = h('textarea', {
    class: 'input', rows: 2, value: folder?.description ?? '', placeholder: 'What’s in this folder? (optional)',
  });

  function save() {
    const trimmed = name.value.trim();
    if (!trimmed) {
      name.classList.add('invalid');
      name.focus();
      toast('Give your folder a name.', 'error');
      return false;
    }
    const now = Date.now();
    const saved = {
      id: folder?.id ?? uid(),
      name: trimmed,
      description: description.value.trim(),
      setIds: folder?.setIds ?? [],
      createdAt: folder?.createdAt ?? now,
      updatedAt: now,
    };
    if (!saveFolder(saved)) return false;
    toast(folder ? 'Folder updated' : 'Folder created');
    onSaved(saved);
    return true;
  }

  const modal = openModal({
    title: folder ? 'Edit folder' : 'New folder',
    body: [labelled('Name', name), labelled('Description', description)],
    actions: [{ label: 'Cancel' }, { label: folder ? 'Save' : 'Create folder', primary: true, onClick: save }],
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (save()) modal.close();
    }
  });
}

function renderFolder(folder) {
  document.title = `${folder.name} · Flashcards`;
  const sets = setsInFolder(folder);

  const addSetsButton = () => h('button', { type: 'button', class: 'btn btn-primary', onclick: () => addSetsModal(folder) }, icon('plus'), 'Add sets');

  function deleteFolder() {
    if (!confirm(`Delete the folder “${folder.name}”? The sets inside it won’t be deleted.`)) return;
    if (!removeFolder(folder.id)) return;
    toast('Folder deleted');
    go('#/folders');
  }

  app.append(
    h('a', { class: 'back-link', href: '#/folders' }, icon('left'), 'Your folders'),
    h('div', { class: 'study-head' },
      h('div', { class: 'study-head__text' },
        h('div', { class: 'folder-head' },
          h('span', { class: 'folder-tile__icon' }, icon('folder')),
          h('h1', {}, folder.name),
        ),
        folder.description && h('p', { class: 'muted' }, folder.description),
        h('p', { class: 'set-meta' }, plural(sets.length, 'set'), ' · ', plural(sets.reduce((n, s) => n + s.cards.length, 0), 'term')),
      ),
      h('div', { class: 'study-head__actions' },
        addSetsButton(),
        h('button', {
          type: 'button', class: 'btn btn-secondary', 'aria-label': 'Edit folder',
          onclick: () => folderForm(folder, () => render()),
        }, icon('edit'), h('span', { class: 'hide-sm' }, 'Edit')),
        h('button', {
          type: 'button', class: 'btn btn-secondary btn-danger', title: 'Delete folder', 'aria-label': 'Delete folder', onclick: deleteFolder,
        }, icon('trash')),
      ),
    ),
    sets.length
      ? h('ul', { class: 'set-grid' },
        sets.map((s) => setTile(s, {
          onRemove: () => {
            if (setInFolder(folder.id, s.id, false)) {
              toast(`Removed “${s.title}” from the folder`);
              render();
            }
          },
        })),
      )
      : h('div', { class: 'panel folder-empty' },
        h('p', {}, 'This folder is empty.'),
        h('p', { class: 'muted' }, db.sets.length ? 'Add some of your sets to it.' : 'Create a set first, then add it here.'),
        db.sets.length ? addSetsButton() : h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), 'Create a set'),
      ),
  );
}

function addSetsModal(folder) {
  const chosen = new Set(folder.setIds);
  const sets = sortedSets();
  openModal({
    title: `Add sets to “${folder.name}”`,
    body: sets.length
      ? h('div', { class: 'check-list' },
        sets.map((s) => checkRow(s.title, plural(s.cards.length, 'term'), chosen.has(s.id), (on) => {
          if (on) chosen.add(s.id);
          else chosen.delete(s.id);
        })),
      )
      : h('p', { class: 'muted' }, 'You don’t have any sets yet.'),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          // Keep the existing order and append newly picked sets.
          const setIds = [...folder.setIds.filter((id) => chosen.has(id)), ...[...chosen].filter((id) => !folder.setIds.includes(id))];
          if (!saveFolder({ ...folder, setIds, updatedAt: Date.now() })) return false;
          render();
          return true;
        },
      },
    ],
  });
}

function addToFolderModal(set) {
  const chosen = new Set(foldersWithSet(set.id).map((f) => f.id));
  const list = h('div', { class: 'check-list' });

  function renderList() {
    const folders = [...db.folders].sort((a, b) => a.name.localeCompare(b.name));
    list.replaceChildren(...folders.map((f) =>
      checkRow(f.name, plural(setsInFolder(f).length, 'set'), chosen.has(f.id), (on) => {
        if (on) chosen.add(f.id);
        else chosen.delete(f.id);
      })));
    if (!folders.length) list.append(h('p', { class: 'muted' }, 'No folders yet — create one below.'));
  }

  const newName = h('input', {
    type: 'text', class: 'input', placeholder: 'New folder name', maxLength: 80, 'aria-label': 'New folder name',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        createFolder();
      }
    },
  });

  function createFolder() {
    const name = newName.value.trim();
    if (!name) {
      newName.focus();
      return;
    }
    const now = Date.now();
    const folder = { id: uid(), name, description: '', setIds: [], createdAt: now, updatedAt: now };
    if (!saveFolder(folder)) return;
    chosen.add(folder.id);
    newName.value = '';
    renderList();
  }

  renderList();
  openModal({
    title: 'Add to folder',
    body: [
      list,
      h('div', { class: 'inline-form' },
        newName,
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: createFolder }, icon('plus'), 'Create'),
      ),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          for (const f of db.folders) setInFolder(f.id, set.id, chosen.has(f.id));
          toast('Folders updated');
          render();
        },
      },
    ],
  });
}

/* ============================================================
   Set page — study modes, preview, progress and the term list
   ============================================================ */

function renderSetPage(set) {
  document.title = `${set.title} · Flashcards`;
  const folders = foldersWithSet(set.id);

  function deleteThisSet() {
    if (!confirm(`Delete “${set.title}”? This can’t be undone.`)) return;
    if (!removeSet(set.id)) return;
    toast('Set deleted');
    go('#/');
  }

  /* Header + study modes */

  const head = [
    h('a', { class: 'back-link', href: '#/' }, icon('left'), 'Your sets'),
    h('div', { class: 'study-head' },
      h('div', { class: 'study-head__text' },
        h('h1', {}, set.title),
        set.description && h('p', { class: 'muted' }, set.description),
        h('div', { class: 'set-meta' },
          h('span', {}, plural(set.cards.length, 'term')),
          folders.map((f) => h('a', { class: 'chip', href: `#/folder/${f.id}` }, icon('folder'), f.name)),
        ),
      ),
      h('div', { class: 'study-head__actions' },
        h('button', {
          type: 'button', class: 'btn btn-secondary', 'aria-label': 'Add to folder', onclick: () => addToFolderModal(set),
        }, icon('folderPlus'), h('span', { class: 'hide-sm' }, 'Add to folder')),
        h('a', { class: 'btn btn-secondary', href: `#/set/${set.id}/edit`, 'aria-label': 'Edit set' }, icon('edit'), h('span', { class: 'hide-sm' }, 'Edit')),
        h('button', {
          type: 'button', class: 'btn btn-secondary btn-danger', title: 'Delete set', 'aria-label': 'Delete set', onclick: deleteThisSet,
        }, icon('trash')),
      ),
    ),
    h('nav', { class: 'mode-grid', 'aria-label': 'Study modes' },
      modeList().map((m) =>
        h('a', { class: 'mode-tile', href: `#/set/${set.id}/${m.key}`, title: m.description },
          h('span', { class: 'mode-tile__icon' }, icon(m.icon)),
          h('span', { class: 'mode-tile__title' }, m.title),
        ),
      ),
    ),
  ];

  /* Flashcard preview */

  let pos = 0;
  const preview = createFlipCard(set, { onSwipe: (dir) => step(-dir), onStarChange: () => renderTerms() });
  const counter = h('span', { class: 'counter', 'aria-live': 'polite' });
  const prevBtn = h('button', { type: 'button', class: 'nav-btn', title: 'Previous (←)', 'aria-label': 'Previous card', onclick: () => step(-1) }, icon('left'));
  const nextBtn = h('button', { type: 'button', class: 'nav-btn', title: 'Next (→)', 'aria-label': 'Next card', onclick: () => step(1) }, icon('right'));

  function showPreview(direction = 0) {
    preview.show(set.cards[pos], 'term', direction);
    counter.textContent = `${pos + 1} / ${set.cards.length}`;
    prevBtn.disabled = pos === 0;
    nextBtn.disabled = pos === set.cards.length - 1;
  }

  function step(delta) {
    const next = pos + delta;
    if (next < 0 || next >= set.cards.length) return;
    pos = next;
    showPreview(delta);
  }

  const previewSection = h('section', { class: 'preview', 'aria-label': 'Flashcard preview' },
    preview.el,
    h('div', { class: 'preview__controls' },
      h('span'),
      h('div', { class: 'preview__nav' }, prevBtn, counter, nextBtn),
      h('a', {
        class: 'icon-btn preview__expand', href: `#/set/${set.id}/flashcards`, title: 'Open Flashcards', 'aria-label': 'Open in Flashcards mode',
      }, icon('expand')),
    ),
  );

  /* Progress */

  function progressSection() {
    const counts = progressCounts(set);
    if (counts.learning + counts.mastered === 0) return null;
    const total = set.cards.length;
    const allMastered = counts.mastered === total;
    const item = (kind, label, n) => h('div', { class: `legend legend--${kind}` }, h('span', { class: 'legend__dot' }), h('span', { class: 'legend__label' }, label), h('strong', {}, n));
    return h('section', { class: 'panel progress-card' },
      h('div', { class: 'progress-card__head' },
        h('div', {},
          h('h2', {}, 'Your progress'),
          h('p', { class: 'muted' }, allMastered ? 'You’ve mastered every term. Nice!' : `${Math.round((counts.mastered / total) * 100)}% mastered in Learn`),
        ),
        h('a', { class: 'btn btn-primary', href: `#/set/${set.id}/learn` }, icon('learn'), allMastered ? 'Review in Learn' : 'Continue learning'),
      ),
      progressBar(counts, total, 'stack-bar--lg'),
      h('div', { class: 'progress-card__legend' },
        item('mastered', 'Mastered', counts.mastered),
        item('learning', 'Still learning', counts.learning),
        item('new', 'Not studied', counts.new),
        h('button', {
          type: 'button',
          class: 'btn btn-ghost progress-card__reset',
          onclick: () => {
            if (!confirm('Reset your Learn progress for this set?')) return;
            resetProgress(set.id);
            render();
          },
        }, icon('restart'), 'Reset'),
      ),
    );
  }

  /* Term list (grouped by progress once you've studied) */

  const termsSection = h('section', { class: 'terms' });
  let filter = 'all';

  function termRow(card) {
    const starred = isStarred(set.id, card.id);
    return h('li', { class: 'term-row' },
      h('div', { class: 'term-row__term' }, card.term),
      h('div', { class: 'term-row__def' }, card.definition),
      h('div', { class: 'term-row__tools' },
        speakButton(() => card.term, () => langOf(set, 'term'), 'Read term aloud'),
        h('button', {
          type: 'button',
          class: `icon-btn star-btn${starred ? ' is-starred' : ''}`,
          title: starred ? 'Unstar' : 'Star',
          'aria-pressed': String(starred),
          'aria-label': `${starred ? 'Unstar' : 'Star'} “${card.term}”`,
          onclick: () => {
            toggleStar(set.id, card.id);
            preview.syncStar();
            renderTerms();
          },
        }, icon('star')),
      ),
    );
  }

  function renderTerms() {
    const starredIds = studyOf(set.id).starred;
    const starredCount = set.cards.filter((c) => starredIds.includes(c.id)).length;
    const cards = filter === 'starred' ? set.cards.filter((c) => starredIds.includes(c.id)) : set.cards;
    const counts = progressCounts(set);
    const grouped = counts.learning + counts.mastered > 0;
    const groups = grouped
      ? [['learning', 'Still learning'], ['new', 'Not studied'], ['mastered', 'Mastered']]
        .map(([status, label]) => ({ status, label, cards: cards.filter((c) => cardStatus(set.id, c.id) === status) }))
        .filter((g) => g.cards.length)
      : [{ cards }];

    termsSection.replaceChildren(
      h('div', { class: 'terms__head' },
        h('h2', {}, `Terms in this set (${set.cards.length})`),
        segmented(
          [{ value: 'all', label: 'All' }, { value: 'starred', label: `Starred (${starredCount})` }],
          filter,
          (v) => {
            filter = v;
            renderTerms();
          },
        ),
      ),
      filter === 'starred' && !starredCount
        ? h('div', { class: 'panel terms__empty' },
          h('p', {}, 'No starred terms yet.'),
          h('p', { class: 'muted' }, 'Star the terms you find hardest, then study just those in any mode.'),
        )
        : h('div', {}, groups.map((g) => [
          g.label && h('h3', { class: `terms__group terms__group--${g.status}` }, `${g.label} (${g.cards.length})`),
          h('ul', { class: 'term-list' }, g.cards.map(termRow)),
        ])),
    );
  }

  app.append(h('div', { class: 'set-page' }, head, previewSection, progressSection(), termsSection));
  showPreview();
  renderTerms();

  listenKeys((e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if ((e.key === ' ' || e.key === 'Enter') && !e.target.closest('button, a')) {
      e.preventDefault();
      if (!e.repeat) preview.flip();
    }
  });
}

/* ============================================================
   Editor — create or edit a set
   ============================================================ */

// Voices for read-aloud. '' lets the browser pick its default.
const LANGUAGES = [
  ['', 'Auto'], ['en-US', 'English'], ['es-ES', 'Spanish'], ['fr-FR', 'French'], ['de-DE', 'German'],
  ['it-IT', 'Italian'], ['pt-BR', 'Portuguese'], ['nl-NL', 'Dutch'], ['sv-SE', 'Swedish'], ['pl-PL', 'Polish'],
  ['ru-RU', 'Russian'], ['uk-UA', 'Ukrainian'], ['tr-TR', 'Turkish'], ['el-GR', 'Greek'], ['ar-SA', 'Arabic'],
  ['he-IL', 'Hebrew'], ['hi-IN', 'Hindi'], ['zh-CN', 'Chinese'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'],
  ['vi-VN', 'Vietnamese'], ['id-ID', 'Indonesian'],
];

const blankCard = () => ({ id: uid(), term: '', definition: '' });
const hasContent = (card) => card.term.trim() !== '' || card.definition.trim() !== '';

function renderEditor(existing) {
  const isNew = !existing;
  document.title = isNew ? 'New set · Flashcards' : `Edit ${existing.title} · Flashcards`;

  const draft = {
    title: existing?.title ?? '',
    description: existing?.description ?? '',
    termLang: existing?.termLang ?? '',
    definitionLang: existing?.definitionLang ?? '',
    cards: existing ? existing.cards.map((c) => ({ ...c })) : [blankCard(), blankCard(), blankCard()],
  };

  // Blank rows and surrounding whitespace don't count as changes.
  const snapshot = () => JSON.stringify([
    draft.title.trim(),
    draft.description.trim(),
    draft.termLang,
    draft.definitionLang,
    draft.cards.filter(hasContent).map((c) => [c.term.trim(), c.definition.trim()]),
  ]);
  const initial = snapshot();
  const isDirty = () => snapshot() !== initial;

  setLeaveGuard(() => !isDirty() || confirm('Leave without saving? Your changes will be lost.'));

  const onBeforeUnload = (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  let resizeFrame = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => app.querySelectorAll('textarea').forEach(autosize));
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('resize', onResize);
  onLeave(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('resize', onResize);
  });

  const titleInput = h('input', {
    type: 'text',
    class: 'text-input text-input--title',
    value: draft.title,
    maxLength: 150,
    placeholder: 'e.g. “Spanish — Chapter 3 vocabulary”',
    oninput: (e) => {
      draft.title = e.target.value;
      e.target.classList.remove('invalid');
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        descInput.focus();
      }
    },
  });

  const descInput = h('textarea', {
    class: 'text-input',
    rows: 1,
    value: draft.description,
    placeholder: 'Add a description (optional)',
    oninput: (e) => {
      draft.description = e.target.value;
      autosize(e.target);
    },
  });

  const langSelect = (key) => {
    const select = h('select', {
      class: 'select',
      onchange: (e) => {
        draft[key] = e.target.value;
      },
    }, LANGUAGES.map(([code, name]) => h('option', { value: code }, name)));
    select.value = draft[key];
    return select;
  };

  const list = h('ol', { class: 'card-list' });

  function renderCards(focusIndex) {
    list.replaceChildren(...draft.cards.map(cardRow));
    list.querySelectorAll('textarea').forEach(autosize);
    if (focusIndex != null) list.children[focusIndex]?.querySelector('textarea')?.focus();
  }

  function cardRow(card, index) {
    const isLast = index === draft.cards.length - 1;
    const field = (key, label) =>
      h('label', { class: 'field' },
        h('textarea', {
          rows: 1,
          value: card[key],
          'data-field': key,
          oninput: (e) => {
            card[key] = e.target.value;
            e.target.classList.remove('invalid');
            autosize(e.target);
          },
          // Tabbing out of the very last definition adds a fresh card, like Quizlet.
          onkeydown: key === 'definition' && isLast
            ? (e) => {
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                addCard();
              }
            }
            : null,
        }),
        h('span', { class: 'field__label' }, label),
      );

    return h('li', { class: 'card-row' },
      h('div', { class: 'card-row__head' },
        h('span', { class: 'card-row__num' }, index + 1),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Delete card',
          'aria-label': `Delete card ${index + 1}`,
          onclick: () => removeCard(index),
        }, icon('trash')),
      ),
      h('div', { class: 'card-row__body' }, field('term', 'Term'), field('definition', 'Definition')),
    );
  }

  function addCard() {
    draft.cards.push(blankCard());
    renderCards(draft.cards.length - 1);
  }

  function removeCard(index) {
    draft.cards.splice(index, 1);
    if (draft.cards.length === 0) draft.cards.push(blankCard());
    renderCards();
  }

  function fail(message, field) {
    toast(message, 'error');
    if (field) {
      field.classList.add('invalid');
      field.focus();
    }
  }

  function save() {
    const title = draft.title.trim();
    if (!title) return fail('Give your set a title.', titleInput);

    const filled = draft.cards.filter(hasContent);
    if (filled.length === 0) return fail('Add at least one card.', list.querySelector('textarea'));

    const gap = draft.cards.findIndex((c) => hasContent(c) && !(c.term.trim() && c.definition.trim()));
    if (gap !== -1) {
      const missing = draft.cards[gap].term.trim() ? 'definition' : 'term';
      return fail(`Card ${gap + 1} needs a ${missing}.`, list.children[gap].querySelector(`[data-field="${missing}"]`));
    }

    const now = Date.now();
    const set = {
      id: existing?.id ?? uid(),
      title,
      description: draft.description.trim(),
      termLang: draft.termLang,
      definitionLang: draft.definitionLang,
      // Card ids are kept, so stars and Learn progress survive edits.
      cards: filled.map((c) => ({ id: c.id, term: c.term.trim(), definition: c.definition.trim() })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!saveSet(set)) return;

    setLeaveGuard(null);
    toast(isNew ? 'Set created' : 'Changes saved');
    go(`#/set/${set.id}`);
  }

  const submitLabel = isNew ? 'Create' : 'Save';

  app.append(
    h('form', {
      class: 'editor',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      },
    },
      h('div', { class: 'editor__bar' },
        h('h1', {}, isNew ? 'Create a new flashcard set' : 'Edit set'),
        h('div', { class: 'editor__actions' },
          h('a', { class: 'btn btn-ghost', href: isNew ? '#/' : `#/set/${existing.id}` }, 'Cancel'),
          h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel),
        ),
      ),
      h('div', { class: 'editor__meta' },
        h('label', { class: 'meta-field' }, h('span', { class: 'meta-field__label' }, 'Title'), titleInput),
        h('label', { class: 'meta-field' }, h('span', { class: 'meta-field__label' }, 'Description'), descInput),
        h('div', { class: 'editor__langs' },
          h('label', { class: 'meta-field' }, h('span', { class: 'meta-field__label' }, 'Term language (read aloud)'), langSelect('termLang')),
          h('label', { class: 'meta-field' }, h('span', { class: 'meta-field__label' }, 'Definition language (read aloud)'), langSelect('definitionLang')),
        ),
      ),
      list,
      h('button', { type: 'button', class: 'add-card', onclick: addCard }, icon('plus'), 'Add card'),
      h('div', { class: 'editor__footer' },
        h('span', { class: 'muted editor__tip' }, 'Tip: press Tab in the last definition to add another card.'),
        h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, submitLabel),
      ),
    ),
  );

  renderCards();
  autosize(descInput);
  if (isNew) titleInput.focus();
}

/* ============================================================
   Not found
   ============================================================ */

function renderNotFound(kind = 'page') {
  document.title = 'Not found · Flashcards';
  const isFolder = kind === 'folder';
  app.append(emptyState({
    art: isFolder ? 'folder' : 'cards',
    title: kind === 'page' ? 'Page not found' : `This ${kind} doesn’t exist`,
    text: kind === 'page' ? null : 'It may have been deleted.',
    action: h('a', { class: 'btn btn-primary', href: isFolder ? '#/folders' : '#/' }, isFolder ? 'Back to your folders' : 'Back to your sets'),
  }));
}

route();
