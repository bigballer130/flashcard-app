/* ============================================================
   match.js — Match: race the clock to pair every term with its
   definition. Wrong pairs add a one-second penalty.
   ============================================================ */

(() => {
  'use strict';

  const MAX_PAIRS = 6;
  const PENALTY_MS = 1000;
  const DEAL_MS = 800; // staggered entrance of the tiles
  const MATCH_OUT_MS = 520; // success flash + scale-out, then the tile is hidden
  const WRONG_MS = 650; // how long a wrong pair stays red
  const FINISH_DELAY_MS = 650; // let the last pair animate out before the results

  // Tiles with the same key look the same to the player, so they are interchangeable.
  // Deliberately lighter than normalize(), which drops punctuation and would treat
  // "C++" and "C#" (or "+" and "−") as the same tile.
  const keyOf = (text) => String(text).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const pairKey = (termKey, defKey) => `${termKey}\u0000${defKey}`;

  // Can every term tile still be paired with a definition tile? (Kuhn's augmenting paths;
  // there are at most six of each, so this is instant.)
  function canPairAll(terms, defs, pairs) {
    if (terms.length !== defs.length) return false;
    const owner = defs.map(() => -1);
    const assign = (i, seen) => {
      for (let j = 0; j < defs.length; j++) {
        if (seen[j] || !pairs.has(pairKey(terms[i].key, defs[j].key))) continue;
        seen[j] = true;
        if (owner[j] < 0 || assign(owner[j], seen)) {
          owner[j] = i;
          return true;
        }
      }
      return false;
    };
    return terms.every((_, i) => assign(i, []));
  }

  function render(set, root) {
    document.title = `Match · ${set.title} · Flashcards`;

    let settings = getSettings(set.id, 'match', { starredOnly: false });
    let screen = 'start'; // 'start' | 'play' | 'finishing' | 'done'
    let game = null;
    let left = false;
    let frame = 0;

    // Timeouts scheduled by the current round, so a restart can cancel them.
    // later() also cancels them if the page is left.
    const pending = new Set();
    function wait(fn, ms) {
      const cancel = later(() => {
        pending.delete(cancel);
        fn();
      }, ms);
      pending.add(cancel);
      return () => {
        cancel();
        pending.delete(cancel);
      };
    }

    function stopClock() {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    onLeave(() => {
      left = true;
      stopClock();
    });

    /* ---------- Persistent chrome: timer, stage, live region ---------- */

    const clockText = h('span', { class: 'match-timer__time' }, formatTime(0));
    const clock = h('div', { class: 'match-timer', role: 'timer', hidden: true },
      icon('timer'),
      h('span', { class: 'match-sr' }, 'Time: '),
      clockText,
    );
    const stage = h('div', { class: 'match__stage' });
    const live = h('div', { class: 'match-sr', role: 'status', 'aria-live': 'polite' });

    root.append(h('div', { class: 'mode match' },
      modeHeader(set, 'match', { onOptions: openOptions, extra: clock }),
      stage,
      live,
    ));

    let announceToggle = false;
    function announce(message) {
      // Alternate a trailing no-break space so repeating the same message is still announced.
      announceToggle = !announceToggle;
      live.textContent = announceToggle ? message : `${message} `;
    }

    function showClock(ms) {
      const text = formatTime(ms);
      if (clockText.textContent !== text) clockText.textContent = text;
    }

    const elapsed = () => performance.now() - game.startedAt + game.penalty;

    function tick() {
      showClock(elapsed());
      frame = requestAnimationFrame(tick);
    }

    // Stops everything the current round started.
    function endRound() {
      stopClock();
      for (const cancel of pending) cancel();
      pending.clear();
      game = null;
      clock.classList.remove('is-penalty');
      clock.querySelectorAll('.match-penalty').forEach((el) => el.remove());
    }

    /* ---------- Start screen ---------- */

    function showStart() {
      endRound();
      screen = 'start';
      clock.hidden = true;
      const best = getBest(set.id, 'match');
      const starredOnly = settings.starredOnly && starredCards(set).length > 0;
      stage.replaceChildren(
        h('section', { class: 'panel result match-intro' },
          h('div', { class: 'result__icon' }, icon('match')),
          h('h2', {}, 'Ready to play?'),
          h('p', { class: 'match-intro__text' },
            'Match all the terms with their definitions as fast as you can. Avoid wrong matches — they add 1 second to your time.'),
          (best != null || starredOnly) && h('div', { class: 'match-intro__meta' },
            best != null && h('span', { class: 'match-chip match-chip--best' },
              icon('trophy'), 'Your best: ', h('strong', {}, formatTime(best))),
            starredOnly && h('span', { class: 'match-chip match-chip--star' }, icon('star'), 'Starred terms only'),
          ),
          h('div', { class: 'result__actions' },
            h('button', {
              type: 'button',
              class: 'btn btn-primary btn-lg',
              onclick: (e) => startGame(e.detail === 0),
            }, icon('play'), 'Start game'),
          ),
          h('p', { class: 'kbd-hint' }, 'or press ', h('kbd', {}, 'Enter')),
        ),
      );
    }

    /* ---------- Playing ---------- */

    function startGame(fromKeyboard = false) {
      endRound();
      screen = 'play';

      const cards = sample(studyPool(set, settings.starredOnly), MAX_PAIRS);
      const tiles = shuffle(cards.flatMap((card) => [
        { card, side: 'term', text: card.term },
        { card, side: 'definition', text: card.definition },
      ]));

      tiles.forEach((tile, i) => {
        tile.key = keyOf(tile.text);
        tile.done = false;
        tile.wrong = null; // cancels the pending "un-red" timeout while flashing wrong
        tile.el = h('button', {
          type: 'button',
          class: 'match-tile',
          'aria-pressed': 'false',
          onclick: () => pick(tile),
        },
          h('span', { class: 'match-tile__scroll' },
            h('span', { class: 'match-tile__text', 'data-size': textSize(String(tile.text)) },
              h('span', { class: 'match-sr' }, tile.side === 'term' ? 'Term: ' : 'Definition: '),
              tile.text,
            ),
          ),
        );
        tile.el.style.setProperty('--i', i);
      });

      const board = h('div', {
        class: 'match-board is-dealing',
        role: 'group',
        'aria-label': 'Tiles',
        'data-count': tiles.length,
      }, tiles.map((t) => t.el));

      clock.hidden = false;
      showClock(0);
      stage.replaceChildren(board);

      game = {
        tiles,
        board,
        pairs: new Set(cards.map((c) => pairKey(keyOf(c.term), keyOf(c.definition)))),
        total: cards.length,
        left: cards.length,
        selected: null,
        penalty: 0,
        misses: 0,
        penaltyFlash: null,
        startedAt: performance.now(),
      };
      frame = requestAnimationFrame(tick);

      if (prefersReducedMotion()) board.classList.remove('is-dealing');
      else wait(() => board.classList.remove('is-dealing'), DEAL_MS);

      announce(`Go! Match ${plural(cards.length, 'pair')}.`);
      if (fromKeyboard) tiles[0].el.focus({ preventScroll: true });
    }

    function select(tile, on) {
      game.selected = on ? tile : null;
      tile.el.classList.toggle('is-selected', on);
      tile.el.setAttribute('aria-pressed', String(on));
    }

    function pick(tile) {
      if (!game || screen !== 'play' || tile.done) return;
      clearWrong(tile);
      const first = game.selected;
      if (!first) {
        select(tile, true);
        return;
      }
      select(first, false);
      if (first === tile) return;
      if (isPair(first, tile)) matched(first, tile);
      else missed(first, tile);
    }

    // A term tile and a definition tile pair up when some card in this round has exactly
    // that term and definition (so look-alike tiles are interchangeable), as long as every
    // remaining tile can still be paired afterwards — duplicates can never strand the player.
    function isPair(a, b) {
      if (a.side === b.side) return false;
      const [term, def] = a.side === 'term' ? [a, b] : [b, a];
      if (!game.pairs.has(pairKey(term.key, def.key))) return false;
      const rest = game.tiles.filter((t) => !t.done && t !== a && t !== b);
      return canPairAll(
        rest.filter((t) => t.side === 'term'),
        rest.filter((t) => t.side === 'definition'),
        game.pairs,
      );
    }

    // The next tile still on the board after `from` (wrapping around), for keeping focus on the board.
    function nextTile(from) {
      const { tiles } = game;
      const i = tiles.indexOf(from);
      for (let k = 1; k < tiles.length; k++) {
        const t = tiles[(i + k) % tiles.length];
        if (!t.done) return t;
      }
      return null;
    }

    function matched(a, b) {
      const g = game;
      const focused = [a, b].find((t) => t.el === document.activeElement);
      a.done = true;
      b.done = true;
      g.left -= 1;
      const finished = g.left === 0;
      const ms = finished ? elapsed() : 0;
      if (finished) stopClock();

      for (const t of [a, b]) {
        t.el.tabIndex = -1;
        t.el.classList.add('is-matched');
      }
      if (focused && !finished) nextTile(focused)?.el.focus({ preventScroll: true });

      const hide = () => {
        for (const t of [a, b]) t.el.classList.add('is-gone');
      };
      if (prefersReducedMotion()) hide();
      else wait(hide, MATCH_OUT_MS);

      if (finished) finish(ms, Boolean(focused));
      else announce(`Matched! ${plural(g.left, 'pair')} left.`);
    }

    function missed(a, b) {
      game.penalty += PENALTY_MS;
      game.misses += 1;
      showClock(elapsed());
      flashWrong(a);
      flashWrong(b);
      flashPenalty();
      announce('Not a match, +1 second');
    }

    function flashWrong(tile) {
      clearWrong(tile);
      void tile.el.offsetWidth; // restart the shake if it is already playing
      tile.el.classList.add('is-wrong');
      tile.wrong = wait(() => {
        tile.wrong = null;
        tile.el.classList.remove('is-wrong');
      }, WRONG_MS);
    }

    function clearWrong(tile) {
      if (!tile.wrong) return;
      tile.wrong();
      tile.wrong = null;
      tile.el.classList.remove('is-wrong');
    }

    function flashPenalty() {
      const tag = h('span', { class: 'match-penalty', 'aria-hidden': 'true' }, '+1s');
      clock.append(tag);
      wait(() => tag.remove(), 900);

      game.penaltyFlash?.();
      clock.classList.remove('is-penalty');
      void clock.offsetWidth;
      clock.classList.add('is-penalty');
      game.penaltyFlash = wait(() => clock.classList.remove('is-penalty'), 450);
    }

    /* ---------- Finish ---------- */

    function finish(ms, focusResult) {
      const g = game;
      // Keep whole tenths so a "new best" always means a visibly lower time.
      const time = Math.floor(ms / 100) * 100;
      showClock(time);
      screen = 'finishing';
      const isBest = recordBest(set.id, 'match', time, true);
      wait(
        () => showResult({ time, isBest, misses: g.misses, focusResult }),
        prefersReducedMotion() ? 150 : FINISH_DELAY_MS,
      );
    }

    function showResult({ time, isBest, misses, focusResult }) {
      endRound();
      screen = 'done';
      clock.hidden = true;
      const best = getBest(set.id, 'match');
      const again = h('button', {
        type: 'button',
        class: 'btn btn-primary btn-lg',
        onclick: (e) => startGame(e.detail === 0),
      }, icon('restart'), 'Play again');

      stage.replaceChildren(
        h('section', { class: 'panel result match-result' },
          h('div', { class: `result__icon${isBest ? ' is-best' : ''}` }, icon('trophy')),
          h('p', { class: 'match-result__label' }, 'Your time'),
          h('h2', { class: 'match-result__time' }, formatTime(time)),
          isBest
            ? h('p', { class: 'match-result__best' }, icon('star'), 'New personal best!')
            : h('p', { class: 'match-result__prev' }, 'Your best: ', h('strong', {}, formatTime(best))),
          misses > 0 && h('p', { class: 'match-result__note' },
            `Includes +${misses}s for ${plural(misses, 'wrong match', 'wrong matches')}.`),
          h('div', { class: 'result__actions' },
            again,
            h('a', { class: 'btn btn-secondary btn-lg', href: `#/set/${set.id}` }, 'Back to set'),
          ),
        ),
      );

      announce(isBest
        ? `All matched in ${formatTime(time)}. New personal best!`
        : `All matched in ${formatTime(time)}. Your best is ${formatTime(best)}.`);
      if (focusResult) again.focus({ preventScroll: true });
    }

    /* ---------- Options & keys ---------- */

    function openOptions() {
      const before = settings.starredOnly;
      openModal({
        title: 'Options',
        body: optionGroup('Terms',
          starredOnlySwitch(set, settings.starredOnly, (on) => {
            settings = { ...settings, starredOnly: on };
            saveSettings(set.id, 'match', settings);
          }),
          `Each round uses up to ${MAX_PAIRS} terms, picked at random.`,
        ),
        actions: [{ label: 'Done', primary: true }],
        onClose: () => {
          if (!left && settings.starredOnly !== before) showStart();
        },
      });
    }

    listenKeys((e) => {
      if (e.repeat) return;
      if (e.key === 'Escape' && screen === 'play' && game?.selected) {
        select(game.selected, false);
        return;
      }
      // A focused button or link handles Enter itself.
      if (e.key !== 'Enter' || e.target.closest?.('button, a')) return;
      if (screen === 'start' || screen === 'done') {
        e.preventDefault();
        startGame(true);
      }
    });

    showStart();
  }

  registerMode('match', {
    title: 'Match',
    icon: 'match',
    order: 4,
    description: 'Race the clock to pair terms with definitions',
    render,
  });
})();
