'use strict';

/* ============================================================
   Flip card component — used by the set page preview and by
   Flashcards mode. Global so app.js can use it too.
   ============================================================ */

// A two-sided card that flips on click/tap. show(card, frontSide, direction) swaps in a card without
// revealing its answer mid-flip. Each face has read-aloud and star buttons. Horizontal swipes call
// onSwipe(+1 | -1) instead of flipping.
function createFlipCard(set, { onSwipe, onStarChange, className = '' } = {}) {
  let current = null;
  let frontSide = 'term';
  let flipped = false;
  const sideOf = (which) => (which === 'front' ? frontSide : otherSide(frontSide));

  const faces = ['front', 'back'].map((which) => {
    const label = h('span', { class: 'flip__side' });
    const text = h('div', { class: 'flip__text' });
    const star = h('button', {
      type: 'button',
      class: 'icon-btn star-btn',
      onclick: (e) => {
        e.stopPropagation();
        toggleCardStar();
      },
    }, icon('star'));
    const face = h('div', { class: `flip__face flip__face--${which}` },
      h('div', { class: 'flip__bar' },
        label,
        h('div', { class: 'flip__tools' },
          speakButton(() => (current ? current[sideOf(which)] : ''), () => langOf(set, sideOf(which))),
          star,
        ),
      ),
      h('div', { class: 'flip__scroll' }, text),
    );
    return { which, label, text, star, face };
  });

  const el = h('div', { class: `flip ${className}`, role: 'button', tabIndex: 0, 'aria-label': 'Flashcard — press Space to flip' },
    h('div', { class: 'flip__inner' }, faces.map((f) => f.face)),
  );

  // Click flips; a horizontal swipe navigates instead (and swallows the click that follows it).
  let swipeStart = null;
  let swallowClick = false;
  el.addEventListener('pointerdown', (e) => {
    swipeStart = { x: e.clientX, y: e.clientY };
  });
  el.addEventListener('pointerup', (e) => {
    if (!swipeStart || !onSwipe) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swallowClick = true;
      onSwipe(dx > 0 ? 1 : -1);
    }
  });
  el.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    flip();
  });

  function setFlipped(value) {
    flipped = value;
    el.classList.toggle('is-flipped', value);
  }

  function flip() {
    if (current) setFlipped(!flipped);
  }

  function syncStar() {
    const on = !!current && isStarred(set.id, current.id);
    for (const f of faces) {
      f.star.classList.toggle('is-starred', on);
      f.star.setAttribute('aria-pressed', String(on));
      f.star.title = on ? 'Unstar (S)' : 'Star (S)';
      f.star.setAttribute('aria-label', on ? 'Unstar this term' : 'Star this term');
    }
  }

  function toggleCardStar() {
    if (!current) return;
    const on = toggleStar(set.id, current.id);
    syncStar();
    onStarChange?.(current, on);
  }

  function show(card, side = frontSide, direction = 0) {
    current = card;
    frontSide = side;
    // Snap back to the front without animating, so the next card's answer never flashes by.
    el.classList.add('no-anim');
    setFlipped(false);
    for (const f of faces) {
      const s = sideOf(f.which);
      f.label.textContent = SIDE_LABEL[s];
      f.text.textContent = card[s];
      f.text.dataset.size = textSize(card[s]);
    }
    syncStar();
    void el.offsetWidth;
    el.classList.remove('no-anim');

    if (direction && !prefersReducedMotion()) {
      el.animate(
        [{ opacity: 0, transform: `translateX(${direction * 32}px)` }, { opacity: 1, transform: 'none' }],
        { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    }
  }

  return {
    el,
    show,
    flip,
    syncStar,
    toggleStar: toggleCardStar,
    get flipped() {
      return flipped;
    },
  };
}

/* ============================================================
   Flashcards mode
   ============================================================ */

(() => {
  const DEFAULTS = { front: 'term', shuffle: false, starredOnly: false, trackProgress: false };
  const AUTOPLAY_MS = 3000;

  registerMode('flashcards', {
    title: 'Flashcards',
    icon: 'cards',
    order: 1,
    description: 'Flip through terms and sort what you know',
    render,
  });

  function render(set, root) {
    document.title = `Flashcards · ${set.title} · Flashcards`;

    let settings = getSettings(set.id, 'flashcards', DEFAULTS);
    let screen = 'play';
    let deck = [];
    let pos = 0;
    let known = [];
    let learning = [];
    let history = []; // tracking mode: 'known' | 'learning' per sorted card, for undo
    let autoplayId = null;
    let ui = {};

    const pool = () => studyPool(set, settings.starredOnly);
    const body = h('div', { class: 'fc' });
    const card = createFlipCard(set, {
      className: 'flip--lg',
      onSwipe: (dir) => (settings.trackProgress ? sort(dir > 0 ? 'known' : 'learning') : step(-dir)),
    });

    root.append(h('div', { class: 'mode flashcards' }, modeHeader(set, 'flashcards', { onOptions: openOptions }), body));
    onLeave(stopAutoplay);

    function newRound(cards) {
      deck = settings.shuffle ? shuffle(cards) : [...cards];
      pos = 0;
      known = [];
      learning = [];
      history = [];
      renderPlay();
    }

    /* ---------- Play screen ---------- */

    function renderPlay() {
      screen = 'play';
      stopAutoplay();
      const tracking = settings.trackProgress;

      ui.counter = h('span', { class: 'counter', 'aria-live': 'polite' });
      ui.bar = h('div', { class: 'progress__bar' });

      const trackSwitch = h('label', { class: 'fc-track' },
        h('input', {
          type: 'checkbox',
          class: 'switch__input',
          checked: tracking,
          onchange: (e) => updateSettings({ trackProgress: e.target.checked }),
        }),
        h('span', { class: 'switch__track', 'aria-hidden': 'true' }),
        h('span', {}, 'Track progress'),
      );

      let main;
      let tools;
      if (tracking) {
        ui.learningCount = h('span', { class: 'fc-count' });
        ui.knownCount = h('span', { class: 'fc-count' });
        ui.undo = h('button', {
          type: 'button', class: 'icon-btn', title: 'Undo (Z)', 'aria-label': 'Undo last card', onclick: undo,
        }, icon('undo'));
        main = [
          h('button', { type: 'button', class: 'sort-btn sort-btn--learning', title: 'Still learning (←)', onclick: () => sort('learning') },
            ui.learningCount, icon('close'), h('span', { class: 'hide-sm' }, 'Still learning')),
          ui.counter,
          h('button', { type: 'button', class: 'sort-btn sort-btn--known', title: 'Know (→)', onclick: () => sort('known') },
            h('span', { class: 'hide-sm' }, 'Know'), icon('check'), ui.knownCount),
        ];
        tools = [ui.undo];
      } else {
        ui.prev = h('button', {
          type: 'button', class: 'nav-btn', title: 'Previous (←)', 'aria-label': 'Previous card', onclick: () => step(-1),
        }, icon('left'));
        ui.next = h('button', {
          type: 'button', class: 'nav-btn', title: 'Next (→)', 'aria-label': 'Next card', onclick: () => step(1),
        }, icon('right'));
        ui.autoplay = h('button', {
          type: 'button', class: 'icon-btn', title: 'Autoplay', 'aria-label': 'Autoplay', 'aria-pressed': 'false', onclick: toggleAutoplay,
        }, icon('play'));
        main = [ui.prev, ui.counter, ui.next];
        tools = [
          h('button', {
            type: 'button',
            class: `icon-btn${settings.shuffle ? ' is-active' : ''}`,
            title: 'Shuffle',
            'aria-label': 'Shuffle',
            'aria-pressed': String(settings.shuffle),
            onclick: () => updateSettings({ shuffle: !settings.shuffle }),
          }, icon('shuffle')),
          ui.autoplay,
        ];
      }

      body.replaceChildren(
        card.el,
        h('div', { class: 'progress', 'aria-hidden': 'true' }, ui.bar),
        h('div', { class: 'fc-controls' },
          h('div', { class: 'fc-controls__side' }, trackSwitch),
          h('div', { class: 'fc-controls__main' }, main),
          h('div', { class: 'fc-controls__side fc-controls__side--end' }, tools),
        ),
        h('p', { class: 'kbd-hint' },
          h('kbd', {}, 'Space'), ' flip · ',
          tracking
            ? [h('kbd', {}, '←'), ' still learning · ', h('kbd', {}, '→'), ' know · ', h('kbd', {}, 'Z'), ' undo']
            : [h('kbd', {}, '←'), ' ', h('kbd', {}, '→'), ' move'],
          ' · ', h('kbd', {}, 'S'), ' star',
        ),
      );
      showCurrent();
    }

    function showCurrent(direction = 0) {
      card.show(deck[pos], settings.front, direction);
      ui.counter.textContent = `${pos + 1} / ${deck.length}`;
      if (settings.trackProgress) {
        ui.bar.style.width = `${(history.length / deck.length) * 100}%`;
        ui.learningCount.textContent = learning.length;
        ui.knownCount.textContent = known.length;
        ui.undo.disabled = history.length === 0;
      } else {
        ui.bar.style.width = `${((pos + 1) / deck.length) * 100}%`;
        ui.prev.disabled = pos === 0;
      }
    }

    function step(delta) {
      if (screen !== 'play') return;
      const next = pos + delta;
      if (next < 0) return;
      if (next >= deck.length) {
        renderSummary();
        return;
      }
      pos = next;
      showCurrent(delta);
    }

    // Tracking mode: file the current card and move on. pos always equals the number sorted.
    function sort(bucket) {
      if (screen !== 'play') return;
      (bucket === 'known' ? known : learning).push(deck[pos]);
      history.push(bucket);
      pos = history.length;
      if (pos >= deck.length) renderSummary();
      else showCurrent(bucket === 'known' ? 1 : -1);
    }

    function undo() {
      if (!history.length) return;
      const bucket = history.pop();
      (bucket === 'known' ? known : learning).pop();
      pos = history.length;
      if (screen === 'play') showCurrent(-1);
      else renderPlay();
    }

    /* ---------- Autoplay ---------- */

    function toggleAutoplay() {
      if (autoplayId) stopAutoplay();
      else startAutoplay();
    }

    function startAutoplay() {
      autoplayId = setInterval(() => {
        if (!card.flipped) card.flip();
        else if (pos < deck.length - 1) step(1);
        else stopAutoplay();
      }, AUTOPLAY_MS);
      syncAutoplayButton();
    }

    function stopAutoplay() {
      clearInterval(autoplayId);
      autoplayId = null;
      syncAutoplayButton();
    }

    function syncAutoplayButton() {
      if (!ui.autoplay || !ui.autoplay.isConnected) return;
      ui.autoplay.replaceChildren(icon(autoplayId ? 'pause' : 'play'));
      ui.autoplay.classList.toggle('is-active', !!autoplayId);
      ui.autoplay.setAttribute('aria-pressed', String(!!autoplayId));
      ui.autoplay.title = autoplayId ? 'Pause autoplay' : 'Autoplay';
    }

    /* ---------- Summary screen ---------- */

    function renderSummary() {
      screen = 'summary';
      stopAutoplay();
      const learnLink = h('a', { class: 'btn btn-secondary', href: `#/set/${set.id}/learn` }, icon('learn'), 'Practice with Learn');
      let content;

      if (settings.trackProgress) {
        const allKnown = learning.length === 0;
        content = [
          h('div', { class: 'result__icon' }, icon(allKnown ? 'trophy' : 'check')),
          h('h2', {}, allKnown ? `Way to go! You know all ${plural(known.length, 'card')}.` : "You're doing great!"),
          h('p', { class: 'muted' }, allKnown
            ? 'Keep it fresh with Learn or a practice test.'
            : 'Keep focusing on the tough terms and you’ll have them down in no time.'),
          h('div', { class: 'stat-row' },
            h('div', { class: 'stat stat--known' }, h('div', { class: 'stat__value' }, known.length), h('div', { class: 'stat__label' }, 'Know')),
            h('div', { class: 'stat stat--learning' }, h('div', { class: 'stat__value' }, learning.length), h('div', { class: 'stat__label' }, 'Still learning')),
          ),
          h('div', { class: 'result__actions' },
            !allKnown && h('button', {
              type: 'button', class: 'btn btn-primary', onclick: () => newRound(learning),
            }, `Keep reviewing ${plural(learning.length, 'term')}`),
            h('button', { type: 'button', class: `btn ${allKnown ? 'btn-primary' : 'btn-secondary'}`, onclick: () => newRound(pool()) }, icon('restart'), 'Restart Flashcards'),
            learnLink,
          ),
          h('button', { type: 'button', class: 'btn btn-ghost fc-back', onclick: undo }, icon('undo'), 'Back to the last card'),
        ];
      } else {
        content = [
          h('div', { class: 'result__icon' }, icon('cards')),
          h('h2', {}, `Nice! You’ve reviewed all ${plural(deck.length, 'card')}.`),
          h('p', { class: 'muted' }, 'Turn on “Track progress” to sort cards into ones you know and ones you’re still learning.'),
          h('div', { class: 'result__actions' },
            h('button', { type: 'button', class: 'btn btn-primary', onclick: () => newRound(pool()) }, icon('restart'), 'Restart Flashcards'),
            learnLink,
          ),
        ];
      }

      body.replaceChildren(h('div', { class: 'panel result fc-summary' }, content));
      body.querySelector('.btn-primary')?.focus();
    }

    /* ---------- Options ---------- */

    function updateSettings(patch) {
      settings = { ...settings, ...patch };
      saveSettings(set.id, 'flashcards', settings);
      newRound(pool());
    }

    function openOptions() {
      const draft = { ...settings };
      openModal({
        title: 'Flashcard options',
        body: [
          optionGroup('Front of the card', segmented(
            [{ value: 'term', label: 'Term' }, { value: 'definition', label: 'Definition' }],
            draft.front,
            (v) => { draft.front = v; },
          )),
          optionGroup('Study', h('div', {},
            switchRow('Shuffle', draft.shuffle, (v) => { draft.shuffle = v; }),
            switchRow('Track progress', draft.trackProgress, (v) => { draft.trackProgress = v; }, {
              hint: 'Sort cards into “Know” and “Still learning”',
            }),
            starredOnlySwitch(set, draft.starredOnly, (v) => { draft.starredOnly = v; }),
          )),
        ],
        actions: [
          { label: 'Cancel' },
          { label: 'Apply', primary: true, onClick: () => updateSettings(draft) },
        ],
      });
    }

    /* ---------- Keyboard ---------- */

    listenKeys((e) => {
      if (screen !== 'play') return;
      const onControl = e.target.closest('button, a');
      switch (e.key) {
        case ' ':
        case 'Enter':
          if (onControl) return;
          e.preventDefault();
          if (!e.repeat) card.flip();
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          e.preventDefault();
          card.flip();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (settings.trackProgress) sort('learning');
          else step(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (settings.trackProgress) sort('known');
          else step(1);
          break;
        case 's':
        case 'S':
          card.toggleStar();
          break;
        case 'z':
        case 'Z':
          if (settings.trackProgress) undo();
          break;
        default:
      }
    });

    newRound(pool());
  }
})();
