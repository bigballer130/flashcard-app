/* ============================================================
   learn.js — Learn mode. Adaptive rounds of up to 7 terms:
   multiple choice while a term is new, written once it's
   familiar, until every term in the pool is mastered.
   Progress is the shared per-card level in core.js.
   ============================================================ */

(() => {
  'use strict';

  const ROUND_SIZE = 7;
  const ADVANCE_MS = 900;
  const DEFAULTS = { answerWith: 'definition', multipleChoice: true, written: true, starredOnly: false };
  const PRAISE = ['Nice work!', "You're on a roll!", 'Great job!', 'Nailed it!', "That's right!", 'Keep it up!', 'Awesome!', 'Spot on!'];
  const STATUS = { mastered: 'Mastered', learning: 'Still learning', new: 'Not studied' };
  const KINDS = ['mastered', 'learning', 'new'];

  const pickOne = (items) => items[Math.floor(Math.random() * items.length)];
  const isBlank = (text) => !String(text ?? '').trim();
  const isActivate = (key) => key === 'Enter' || key === ' ';
  const kbd = (key) => h('kbd', {}, key);

  // Only the first call does anything — a key, a click and a timer can all race to advance.
  function once(fn) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  }

  // Focuses once the current key event is over, so its trailing keypress can't activate `el`.
  function focusSoon(el) {
    requestAnimationFrame(() => {
      if (el.isConnected) el.focus({ preventScroll: true });
    });
  }

  function loadSettings(setId) {
    const s = getSettings(setId, 'learn', DEFAULTS);
    const settings = {
      answerWith: ['term', 'definition', 'both'].includes(s.answerWith) ? s.answerWith : DEFAULTS.answerWith,
      multipleChoice: s.multipleChoice !== false,
      written: s.written !== false,
      starredOnly: s.starredOnly === true,
    };
    if (!settings.multipleChoice && !settings.written) settings.multipleChoice = true;
    return settings;
  }

  function feedback(kind, iconName, ...content) {
    return h('div', { class: `feedback feedback--${kind}` },
      icon(iconName),
      h('div', { class: 'learn-feedback' }, ...content),
    );
  }

  function render(set, root) {
    document.title = `Learn · ${set.title} · Flashcards`;

    let settings = loadSettings(set.id);
    let pool = studyPool(set, settings.starredOnly);
    let roundNo = 1;
    let roundCards = [];     // this round's cards, in the order first asked
    let queue = [];          // the round's questions; a wrong answer re-queues its card once
    let requeued = new Set();
    let pos = 0;

    let keyHandler = null;   // current screen's key handler; returns true when it used the key
    let cancelTimer = null;

    const overview = progressOverview();
    const body = h('div', { class: 'learn__body' });

    root.append(h('div', { class: 'mode learn' },
      modeHeader(set, 'learn', { onOptions: openOptions }),
      overview.el,
      body,
    ));

    listenKeys((e) => {
      if (!keyHandler || e.repeat) return;
      // Focused buttons and links handle Enter/Space natively.
      if (isActivate(e.key) && e.target.closest?.('button:not(:disabled), a[href]')) return;
      if (keyHandler(e.key)) e.preventDefault();
    });

    startRound(1);

    /* ---------- Screens & timing ---------- */

    function show(screen, focusEl, keys = null) {
      cancelTimer?.();
      cancelTimer = null;
      keyHandler = keys;
      body.replaceChildren(screen);
      if (window.scrollY > 0 && body.getBoundingClientRect().top < 72) window.scrollTo(0, 0);
      focusEl?.focus({ preventScroll: true });
    }

    function after(fn, ms) {
      cancelTimer?.();
      cancelTimer = later(fn, ms);
    }

    /* ---------- Overall progress bar ---------- */

    function progressOverview() {
      const segs = {};
      const counts = {};
      const el = h('div', { class: 'learn-progress' },
        h('div', { class: 'learn-progress__bar', 'aria-hidden': 'true' },
          KINDS.map((k) => (segs[k] = h('span', { class: `learn-progress__seg learn-progress__seg--${k}` }))),
        ),
        h('ul', { class: 'learn-progress__legend', 'aria-label': 'Progress' },
          KINDS.map((k) => h('li', { class: `learn-progress__item learn-progress__item--${k}` },
            h('span', { class: 'learn-progress__dot', 'aria-hidden': 'true' }),
            h('span', {}, STATUS[k]),
            (counts[k] = h('span', { class: 'learn-progress__count' }, '0')),
          )),
        ),
      );
      return {
        el,
        // Refreshes the bar from stored progress and returns the counts.
        update() {
          const c = progressCounts(set, pool);
          for (const k of KINDS) {
            segs[k].style.width = `${pool.length ? (c[k] / pool.length) * 100 : 0}%`;
            counts[k].textContent = String(c[k]);
          }
          return c;
        },
      };
    }

    /* ---------- Rounds ---------- */

    function startRound(n) {
      pool = studyPool(set, settings.starredOnly);
      overview.update();
      const cards = nextRoundCards();
      if (!cards.length) return showComplete();
      roundNo = n;
      roundCards = shuffle(cards);
      queue = [...roundCards];
      requeued = new Set();
      pos = 0;
      ask();
    }

    // Up to ROUND_SIZE unmastered cards: familiar first, then ones missed before, then new ones (set order).
    function nextRoundCards() {
      const familiar = [];
      const missed = [];
      const fresh = [];
      for (const card of pool) {
        const { level, seen } = cardProgress(set.id, card.id);
        if (level >= MASTERED) continue;
        if (level >= 1) familiar.push(card);
        else if (seen) missed.push(card);
        else fresh.push(card);
      }
      return [...familiar, ...missed, ...fresh].slice(0, ROUND_SIZE);
    }

    function ask() {
      // Skip anything mastered meanwhile (e.g. progress changed in another tab).
      while (pos < queue.length && cardProgress(set.id, queue[pos].id).level >= MASTERED) pos++;
      if (pos >= queue.length) return finishRound();

      const card = queue[pos];
      const level = cardProgress(set.id, card.id).level;
      const question = makeQuestion(card, settings.answerWith);
      const next = once(() => {
        pos++;
        ask();
      });

      // New terms get multiple choice, familiar ones written (unless only one type is on).
      let kind = settings.multipleChoice && (!settings.written || level < 1) ? 'choice' : 'written';
      let choices = null;
      if (kind === 'choice') {
        choices = choicesFor(question, set.cards);
        if (choices.length < 2 && settings.written) kind = 'written';
      }
      // Long (or empty) answers are unreasonable to type: self-grade them instead.
      if (isBlank(question.answer) || (kind === 'written' && isLongAnswer(question.answer))) kind = 'flashcard';

      const ctx = { card, level, question, next };
      if (kind === 'choice') choiceQuestion(ctx, choices);
      else if (kind === 'written') writtenQuestion(ctx);
      else flashcardQuestion(ctx);
    }

    function grade(card, level, correct) {
      if (correct) {
        recordProgress(set.id, card.id, level + 1);
      } else {
        recordProgress(set.id, card.id, 0);
        if (!requeued.has(card.id)) {
          requeued.add(card.id);
          queue.push(card);
        }
      }
      overview.update();
    }

    // "Override: I was right" — count a wrong written answer as correct after all.
    function overrule(card, level) {
      recordProgress(set.id, card.id, level + 1);
      const again = queue.lastIndexOf(card);
      if (again > pos) {
        queue.splice(again, 1);
        requeued.delete(card.id);
      }
      overview.update();
    }

    /* ---------- Question screens ---------- */

    function questionScreen(content, hint) {
      const posEl = h('span', { class: 'learn__pos' });
      const refresh = () => {
        posEl.textContent = `${pos + 1} of ${queue.length}`;
      };
      refresh();
      const panel = h('section', { class: 'panel learn-q', tabIndex: -1 }, content);
      const el = h('div', { class: 'learn__screen' },
        h('div', { class: 'learn__meta' },
          h('span', { class: 'learn__round' }, `Round ${roundNo}`),
          posEl,
        ),
        panel,
        hint,
      );
      return { el, panel, hint, refresh };
    }

    function prompt(question) {
      return promptBlock(set, isBlank(question.prompt) ? { ...question, prompt: '—' } : question);
    }

    // Correct: praise is already shown; move on shortly (Enter/Space skips the wait).
    function autoAdvance(screen, next) {
      keyHandler = (key) => isActivate(key) && (next(), true);
      after(next, ADVANCE_MS);
      screen.panel.focus({ preventScroll: true });
    }

    // Wrong or close: wait for Continue (button, Enter or Space).
    function waitForContinue(screen, actions, next, extra = null) {
      const button = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: next }, 'Continue');
      actions.append(...[extra, button].filter(Boolean));
      screen.hint.replaceChildren('Press ', kbd('Enter'), ' to continue');
      keyHandler = (key) => isActivate(key) && (next(), true);
      focusSoon(button);
    }

    function choiceQuestion({ card, level, question, next }, choices) {
      let answered = false;
      const list = choiceList(choices, (i) => pick(i));
      list.el.setAttribute('role', 'group');
      list.el.setAttribute('aria-label', 'Choose the answer');
      const live = h('div', { class: 'learn__live', 'aria-live': 'polite' });
      const actions = h('div', { class: 'learn__actions' });
      const hint = h('p', { class: 'kbd-hint' },
        'Press ', kbd('1'), choices.length > 1 && ['–', kbd(String(choices.length))], ' to answer',
      );
      const screen = questionScreen([
        prompt(question),
        h('div', { class: 'learn-q__work' },
          h('div', { class: 'learn-q__label', 'aria-hidden': 'true' }, 'Choose the answer'),
          list.el,
        ),
        live,
        actions,
      ], hint);

      function pick(i) {
        if (answered) return;
        answered = true;
        const correct = choices[i] === question.answer;
        list.mark(question.answer, i);
        grade(card, level, correct);
        screen.refresh();
        if (correct) {
          live.append(feedback('good', 'check', pickOne(PRAISE)));
          autoAdvance(screen, next);
        } else {
          live.append(feedback('bad', 'close', 'Not quite — study this one!'));
          waitForContinue(screen, actions, next);
        }
      }

      show(screen.el, screen.panel, (key) => {
        const button = !answered && /^[1-9]$/.test(key) ? list.buttons[Number(key) - 1] : null;
        if (!button) return false;
        button.click();
        return true;
      });
    }

    function writtenQuestion({ card, level, question, next }) {
      let answered = false;
      const side = SIDE_LABEL[question.answerSide].toLowerCase();

      const input = h('input', {
        id: 'learn-answer',
        class: 'answer-input',
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'off',
        enterKeyHint: 'done',
        placeholder: 'Type the answer',
        lang: langOf(set, question.answerSide) || null,
      });
      input.spellcheck = false;
      input.setAttribute('autocorrect', 'off');
      const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Answer');
      const skipBtn = h('button', { type: 'button', class: 'btn btn-ghost learn-write__skip', onclick: giveUp }, "Don't know?");
      const work = h('div', { class: 'learn-q__work' },
        h('label', { class: 'learn-q__label', htmlFor: 'learn-answer' }, `Type the ${side}`),
        h('form', {
          class: 'learn-write',
          noValidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            submit();
          },
        }, input, submitBtn),
        skipBtn,
      );
      const live = h('div', { class: 'learn__live', 'aria-live': 'polite' });
      const actions = h('div', { class: 'learn__actions' });
      const hint = h('p', { class: 'kbd-hint' }, 'Press ', kbd('Enter'), ' to answer');
      const screen = questionScreen([prompt(question), work, live, actions], hint);

      function lock(state) {
        answered = true;
        input.readOnly = true;
        input.classList.add(state);
        submitBtn.hidden = true;
        skipBtn.hidden = true;
      }

      function submit() {
        if (answered) return;
        const given = input.value;
        if (isBlank(given)) {
          input.focus();
          return;
        }
        const result = gradeWritten(given, question.answer);
        grade(card, level, result !== 'wrong');
        screen.refresh();
        if (result === 'correct') {
          lock('is-correct');
          live.append(feedback('good', 'check', pickOne(PRAISE)));
          autoAdvance(screen, next);
        } else if (result === 'close') {
          lock('is-close');
          live.append(feedback('note', 'check',
            h('div', {}, 'Almost! Watch the spelling'),
            h('div', { class: 'learn-feedback__answer' },
              h('span', { class: 'learn-feedback__key' }, 'Correct answer: '),
              question.answer,
            ),
          ));
          waitForContinue(screen, actions, next);
        } else {
          reveal(given);
        }
      }

      function giveUp() {
        if (answered) return;
        grade(card, level, false);
        screen.refresh();
        reveal(null);
      }

      // Wrong or "Don't know?": swap the input for the answer comparison.
      function reveal(given) {
        answered = true;
        screen.panel.focus({ preventScroll: true }); // don't leave focus on the input we're hiding
        work.hidden = true;
        live.append(
          feedback('bad', 'close', given == null ? 'No worries — study this one!' : 'Not quite — study this one!'),
          compareBlock(question, given),
        );
        const override = given != null && h('button', {
          type: 'button',
          class: 'btn btn-ghost learn__override',
          onclick: () => {
            overrule(card, level);
            next();
          },
        }, 'Override: I was right');
        waitForContinue(screen, actions, next, override);
      }

      show(screen.el, input, (key) => key === 'Enter' && (submit(), true));
    }

    function compareBlock(question, given) {
      return h('div', { class: 'learn-compare' },
        given != null && h('div', { class: 'learn-compare__row learn-compare__row--given' },
          h('span', { class: 'learn-compare__label' }, 'Your answer'),
          h('s', { class: 'learn-compare__text' }, given),
        ),
        h('div', { class: 'learn-compare__row learn-compare__row--correct' },
          h('div', { class: 'learn-compare__head' },
            h('span', { class: 'learn-compare__label' }, 'Correct answer'),
            speakButton(() => question.answer, () => langOf(set, question.answerSide)),
          ),
          h('div', { class: 'learn-compare__text' }, question.answer),
        ),
      );
    }

    // Self-graded question for answers too long to type: reveal, then "I knew it" / "I didn't".
    function flashcardQuestion({ card, level, question, next }) {
      let revealed = false;
      const side = SIDE_LABEL[question.answerSide].toLowerCase();
      const work = h('div', { class: 'learn-q__work learn-card' },
        h('div', { class: 'learn-q__label' }, `Think of the ${side}, then check yourself`),
        h('div', { class: 'learn-card__reveal' },
          h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: reveal }, 'Reveal answer'),
        ),
      );
      const hint = h('p', { class: 'kbd-hint' }, 'Press ', kbd('Space'), ' to reveal the answer');
      const screen = questionScreen([prompt(question), work], hint);

      function reveal() {
        if (revealed) return;
        revealed = true;
        const answer = promptBlock(set, {
          promptSide: question.answerSide,
          prompt: isBlank(question.answer) ? '—' : question.answer,
        });
        answer.classList.add('learn-card__answer');
        answer.tabIndex = -1;
        let graded = false;
        const list = choiceList(["I didn't know it", 'I knew it'], (i) => {
          if (graded) return;
          graded = true;
          grade(card, level, i === 1);
          next();
        });
        list.el.setAttribute('role', 'group');
        list.el.setAttribute('aria-label', 'How did you do?');
        work.replaceChildren(
          answer,
          h('div', { class: 'learn-q__label', 'aria-hidden': 'true' }, 'How did you do?'),
          list.el,
        );
        hint.replaceChildren('Press ', kbd('1'), ' or ', kbd('2'), ' to grade yourself');
        keyHandler = (key) => {
          const button = list.buttons[Number(key) - 1];
          if (!/^[12]$/.test(key) || !button) return false;
          button.click();
          return true;
        };
        answer.focus({ preventScroll: true });
      }

      show(screen.el, screen.panel, (key) => isActivate(key) && (reveal(), true));
    }

    /* ---------- Round summary & completion ---------- */

    function finishRound() {
      const counts = overview.update();
      if (counts.mastered >= pool.length) return showComplete();

      const go = once(() => startRound(roundNo + 1));
      const left = pool.length - counts.mastered;
      const stat = (kind, label) => h('div', { class: `stat learn-stat learn-stat--${kind}` },
        h('div', { class: 'stat__value' }, String(counts[kind])),
        h('div', { class: 'stat__label' }, label),
      );
      const panel = h('section', { class: 'panel learn-summary', tabIndex: -1 },
        h('div', { class: 'learn-summary__head' },
          h('div', { class: 'result__icon learn-summary__icon' }, icon('check')),
          h('h2', {}, `Round ${roundNo} complete`),
          h('p', { class: 'muted' },
            `You've mastered ${counts.mastered} of ${plural(pool.length, 'term')}. `,
            left === 1 ? 'Just one to go!' : `${left} to go — keep it up!`,
          ),
        ),
        h('div', { class: 'stat-row' },
          stat('mastered', STATUS.mastered),
          stat('learning', STATUS.learning),
          stat('new', STATUS.new),
        ),
        h('div', {},
          h('h3', { class: 'learn-summary__title' }, 'Terms in this round'),
          h('ul', { class: 'learn-terms' }, roundCards.map(termRow)),
        ),
        h('div', { class: 'learn-summary__actions' },
          h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: go }, 'Continue', icon('right')),
        ),
      );
      show(
        h('div', { class: 'learn__screen' }, panel, h('p', { class: 'kbd-hint' }, 'Press ', kbd('Enter'), ' to continue')),
        panel,
        (key) => key === 'Enter' && (go(), true),
      );
    }

    function termRow(card) {
      const status = cardStatus(set.id, card.id);
      return h('li', { class: 'learn-term' },
        h('div', { class: 'learn-term__term' }, card.term),
        h('div', { class: 'learn-term__def' }, card.definition),
        h('span', { class: `learn-badge learn-badge--${status}` }, STATUS[status]),
      );
    }

    function showComplete() {
      const n = pool.length;
      const again = once(() => {
        resetProgress(set.id, pool.map((c) => c.id));
        startRound(1);
      });
      const panel = h('section', { class: 'panel learn-done', tabIndex: -1 },
        h('div', { class: 'result' },
          h('div', { class: 'result__icon learn-done__icon' }, icon('trophy')),
          h('h2', {}, n === 1 ? "You've mastered this term!" : `You've mastered all ${n} terms!`),
          h('p', { class: 'muted' }, 'Great work. Check yourself with a practice test, or start Learn over from scratch.'),
          h('div', { class: 'result__actions' },
            h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: again }, icon('restart'), 'Study again'),
            h('a', { class: 'btn btn-secondary btn-lg', href: `#/set/${set.id}/test` }, icon('test'), 'Take a practice test'),
            h('a', { class: 'btn btn-ghost btn-lg', href: `#/set/${set.id}` }, 'Back to set'),
          ),
        ),
      );
      show(h('div', { class: 'learn__screen' }, panel), panel);
    }

    /* ---------- Options ---------- */

    function openOptions() {
      const draft = { ...settings };
      let action = null; // set by Apply or Reset; acted on once the modal has closed (and restored focus)

      const typeSwitch = (key, label) => {
        const row = switchRow(label, draft[key], (on) => {
          const other = key === 'multipleChoice' ? 'written' : 'multipleChoice';
          if (!on && !draft[other]) {
            row.querySelector('input').checked = true;
            toast('Keep at least one question type turned on');
            return;
          }
          draft[key] = on;
        });
        return row;
      };

      const resetBtn = h('button', {
        type: 'button',
        class: 'btn btn-secondary btn-danger learn-reset',
        onclick: () => {
          const n = studyPool(set, draft.starredOnly).length;
          if (!confirm(`Reset your Learn progress for ${plural(n, 'term')}? This can't be undone.`)) return;
          action = 'reset';
          modal.close();
        },
      }, icon('restart'), 'Reset progress');

      const modal = openModal({
        title: 'Options',
        body: [
          optionGroup('Answer with', answerWithControl(draft.answerWith, (value) => {
            draft.answerWith = value;
          })),
          optionGroup('Question types',
            h('div', { class: 'learn-opt-switches' },
              typeSwitch('multipleChoice', 'Multiple choice'),
              typeSwitch('written', 'Written'),
            ),
            'New terms start as multiple choice and move to written once you get them right.',
          ),
          optionGroup('Terms', starredOnlySwitch(set, draft.starredOnly, (on) => {
            draft.starredOnly = on;
          })),
          optionGroup('Progress', resetBtn, 'Clears Learn progress for these terms so you can start over.'),
        ],
        actions: [
          { label: 'Cancel' },
          {
            label: 'Apply',
            primary: true,
            onClick: () => {
              action = 'apply';
            },
          },
        ],
        onClose: () => {
          if (action) applyOptions(draft, action === 'reset');
        },
      });
    }

    function applyOptions(next, reset) {
      const changed = JSON.stringify(next) !== JSON.stringify(settings);
      settings = next;
      if (changed) saveSettings(set.id, 'learn', settings);
      if (reset) {
        resetProgress(set.id, studyPool(set, settings.starredOnly).map((c) => c.id));
        toast('Progress reset');
        startRound(1);
      } else if (changed) {
        startRound(roundNo); // restart the current round with the new settings
      }
    }
  }

  registerMode('learn', {
    title: 'Learn',
    icon: 'learn',
    order: 2,
    description: 'Adaptive questions until you master every term',
    render,
  });
})();
