/* ============================================================
   test.js — Test mode: a graded practice test that mixes
   true/false, multiple choice, matching and written questions.
   Screens: setup -> test -> results.
   ============================================================ */

(() => {
  'use strict';

  const DEFAULTS = {
    count: 20,
    answerWith: 'definition',
    trueFalse: true,
    multipleChoice: true,
    matching: true,
    written: true,
    starredOnly: false,
  };

  // Sections appear (and questions are numbered) in this order.
  const TYPES = [
    { key: 'trueFalse', label: 'True/False', title: 'True or false' },
    { key: 'multipleChoice', label: 'Multiple choice', title: 'Multiple choice' },
    { key: 'matching', label: 'Matching', title: 'Matching' },
    { key: 'written', label: 'Written', title: 'Written' },
  ];
  const TYPE_TITLE = Object.fromEntries(TYPES.map((t) => [t.key, t.title]));

  const LEAVE_MESSAGE = 'Leave this test? Your answers will be lost.';
  const RING_R = 52;
  const RING_C = 2 * Math.PI * RING_R;

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const lower = (side) => SIDE_LABEL[side].toLowerCase();
  const pick = (items) => items[Math.floor(Math.random() * items.length)];
  const randomSide = () => (Math.random() < 0.5 ? 'term' : 'definition');
  const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth');

  // 0 -> "A", 25 -> "Z", 26 -> "AA" …
  function letter(i) {
    return (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
  }

  // Stored settings may be stale or hand-edited; make them usable.
  function cleanSettings(s) {
    const out = { ...s };
    if (!['term', 'definition', 'both'].includes(out.answerWith)) out.answerWith = DEFAULTS.answerWith;
    out.count = Math.max(1, Math.round(Number(out.count)) || DEFAULTS.count);
    for (const t of TYPES) out[t.key] = Boolean(out[t.key]);
    if (!TYPES.some((t) => out[t.key])) for (const t of TYPES) out[t.key] = true;
    out.starredOnly = Boolean(out.starredOnly);
    return out;
  }

  /* ------------------------------------------------------------
     Building a test
     ------------------------------------------------------------ */

  // Splits n questions over the enabled types as evenly as possible (earlier sections take the
  // remainder). Matching needs at least two items, so a lone one goes to the smallest other section.
  function distribute(n, keys) {
    const counts = {};
    keys.forEach((k, i) => {
      counts[k] = Math.floor(n / keys.length) + (i < n % keys.length ? 1 : 0);
    });
    if (counts.matching === 1 && keys.length > 1) {
      const others = keys.filter((k) => k !== 'matching');
      const target = others.reduce((a, b) => (counts[b] < counts[a] ? b : a));
      counts.matching = 0;
      counts[target]++;
    }
    return counts;
  }

  // Answers this long are unreasonable to type, so such cards are kept out of the Written section when possible.
  const tooLongToWrite = (card, answerWith) =>
    answerWith === 'both'
      ? isLongAnswer(card.term) && isLongAnswer(card.definition)
      : isLongAnswer(card[answerWith]);

  // With "Both", a written question asks for whichever side is short enough to type.
  function writtenSide(card, answerWith) {
    if (answerWith !== 'both') return answerWith;
    const termLong = isLongAnswer(card.term);
    if (termLong !== isLongAnswer(card.definition)) return termLong ? 'definition' : 'term';
    return randomSide();
  }

  // Matching options: the items' answers, shuffled, with answers that normalize the same listed once.
  function uniqueAnswers(answers) {
    const seen = new Set();
    return shuffle(answers).filter((text) => {
      const key = normalize(text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function makeItem(set, type, card, answerWith, matchSide) {
    if (type === 'trueFalse') {
      const q = makeQuestion(card, answerWith, set.cards);
      // A decoy must be wrong for this prompt — not just a different card that shares it.
      const decoys = set.cards.filter((c) => !isAcceptedAnswer(q, c[q.answerSide]));
      const truth = !decoys.length || Math.random() < 0.5;
      return { type, q, truth, shown: truth ? q.answer : pick(decoys)[q.answerSide], response: null };
    }
    if (type === 'multipleChoice') {
      const q = makeQuestion(card, answerWith, set.cards);
      return { type, q, choices: choicesFor(q, set.cards), response: null };
    }
    if (type === 'matching') return { type, q: makeQuestion(card, matchSide, set.cards), response: null };
    return { type, q: makeQuestion(card, writtenSide(card, answerWith), set.cards), response: '' };
  }

  function buildTest(set, s) {
    const pool = studyPool(set, s.starredOnly);
    const n = clamp(s.count, 1, pool.length);
    const counts = distribute(n, TYPES.map((t) => t.key).filter((k) => s[k]));

    let cards = sample(pool, n);
    if (counts.written && counts.written < n) {
      const long = cards.filter((c) => tooLongToWrite(c, s.answerWith));
      cards = [...long, ...cards.filter((c) => !long.includes(c))];
    }

    const sections = [];
    const questions = [];
    let next = 0;
    for (const { key, title } of TYPES) {
      const size = counts[key] || 0;
      if (!size) continue;
      const section = { type: key, title, items: [] };
      // Keep one direction for the whole matching block, even with "Both".
      const matchSide = s.answerWith === 'both' ? randomSide() : s.answerWith;
      for (const card of shuffle(cards.slice(next, next + size))) {
        const item = makeItem(set, key, card, s.answerWith, matchSide);
        item.num = questions.length + 1;
        item.section = section;
        section.items.push(item);
        questions.push(item);
      }
      next += size;
      if (key === 'matching') section.options = uniqueAnswers(section.items.map((it) => it.q.answer));
      sections.push(section);
    }
    return { sections, questions, total: questions.length, startedAt: Date.now(), elapsed: 0 };
  }

  /* ------------------------------------------------------------
     Grading
     ------------------------------------------------------------ */

  const isAnswered = (item) => (item.type === 'written' ? item.response.trim() !== '' : item.response !== null);

  // 'correct' | 'close' (written, small typo) | 'wrong' | 'blank'
  function grade(item) {
    if (!isAnswered(item)) return 'blank';
    switch (item.type) {
      case 'trueFalse':
        return item.response === item.truth ? 'correct' : 'wrong';
      case 'multipleChoice':
        return isAcceptedAnswer(item.q, item.choices[item.response]) ? 'correct' : 'wrong';
      case 'matching':
        return isAcceptedAnswer(item.q, item.section.options[item.response]) ? 'correct' : 'wrong';
      default:
        return gradeWritten(item.response, item.q.answers);
    }
  }

  const isCorrect = (item) => item.overridden || item.result === 'correct' || item.result === 'close';

  function verdict(pct) {
    if (pct === 100) return ['Perfect score!', 'You got every question right. Outstanding.'];
    if (pct >= 90) return ['Excellent work!', 'You really know this material.'];
    if (pct >= 75) return ['Great job!', 'Review the few you missed and you’ll have it down.'];
    if (pct >= 50) return ['Nice effort!', 'You’re getting there. Go over the answers below, then try again.'];
    return ['Keep practicing!', 'Every test helps. Study the answers below and give it another go.'];
  }

  /* ------------------------------------------------------------
     Shared pieces
     ------------------------------------------------------------ */

  // The prompt / candidate-answer pair of a true-or-false question.
  function tfPair(set, item) {
    return h('div', { class: 'test-tf__pair' },
      promptBlock(set, item.q),
      h('div', { class: 'test-tf__divider', 'aria-hidden': 'true' }),
      // promptBlock only reads promptSide + prompt, so it can show the candidate answer too.
      promptBlock(set, { promptSide: item.q.answerSide, prompt: item.shown }),
    );
  }

  function setPressed(button, on) {
    button.classList.toggle('is-selected', on);
    button.setAttribute('aria-pressed', String(on));
  }

  function answerRow(label, text, kind) {
    const empty = text == null || text === '';
    return h('div', { class: `test-answer test-answer--${kind}` },
      h('div', { class: 'test-answer__label' }, label),
      h('div', { class: `test-answer__text${empty ? ' is-empty' : ''}` }, empty ? 'No answer' : text),
    );
  }

  // Moves focus to a question control and brings its question into view.
  function focusField(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const box = el.closest('.test-match__row, .test-q');
    const target = box && box.offsetHeight < window.innerHeight - 240 ? box : el;
    target.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  }

  /* ------------------------------------------------------------
     The mode
     ------------------------------------------------------------ */

  function render(set, root) {
    document.title = `Test · ${set.title} · Flashcards`;
    let settings = cleanSettings(getSettings(set.id, 'test', DEFAULTS));
    let activeTest = null; // the test on screen while it's being taken

    const view = h('div', { class: 'mode test' });
    root.append(view);

    // Reloading or closing the tab mid-test would lose the answers too.
    const onBeforeUnload = (e) => {
      if (!activeTest || !activeTest.questions.some(isAnswered)) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    onLeave(() => window.removeEventListener('beforeunload', onBeforeUnload));

    function mount(screen, onOptions) {
      view.replaceChildren(modeHeader(set, 'test', { onOptions }), screen);
      window.scrollTo(0, 0);
    }

    const startTest = () => showTest(buildTest(set, settings));

    /* ---------- Setup ---------- */

    function showSetup() {
      activeTest = null;
      setLeaveGuard(null);
      const draft = cleanSettings(getSettings(set.id, 'test', DEFAULTS));
      let wanted = draft.count; // what the user asked for; shown clamped to the pool size
      const poolSize = () => studyPool(set, draft.starredOnly).length;

      const maxNote = h('span', { class: 'test-count__max', id: 'test-count-max' });
      const countInput = h('input', {
        type: 'number',
        class: 'test-count__input',
        min: 1,
        step: 1,
        inputMode: 'numeric',
        autocomplete: 'off',
        'aria-label': 'Number of questions',
        'aria-describedby': 'test-count-max',
        onchange: commitCount,
      });

      function syncCount() {
        const max = poolSize();
        countInput.max = max;
        countInput.value = Math.min(wanted, max);
        maxNote.textContent = `max ${max}`;
      }

      function commitCount() {
        const n = Math.round(Number(countInput.value));
        if (countInput.value !== '' && Number.isFinite(n)) wanted = clamp(n, 1, poolSize());
        syncCount();
      }

      const answerWith = answerWithControl(draft.answerWith, (value) => {
        draft.answerWith = value;
      });
      answerWith.setAttribute('aria-label', 'Answer with');

      // At least one question type has to stay on: the last one left is locked.
      const typesNote = h('p', { class: 'test-types__note', hidden: true }, 'At least one question type has to stay on.');
      const typeRows = TYPES.map((t) => {
        const row = switchRow(t.label, draft[t.key], (on) => {
          draft[t.key] = on;
          syncTypes();
        });
        return { key: t.key, row, input: row.querySelector('input') };
      });

      function syncTypes() {
        const lastOne = typeRows.filter((r) => draft[r.key]).length === 1;
        for (const r of typeRows) {
          const locked = lastOne && draft[r.key];
          r.input.disabled = locked;
          r.row.classList.toggle('is-disabled', locked);
        }
        typesNote.hidden = !lastOne;
      }

      const starred = starredOnlySwitch(set, draft.starredOnly, (on) => {
        draft.starredOnly = on;
        syncCount();
      });

      function start(e) {
        e.preventDefault();
        commitCount();
        settings = { ...draft, count: wanted };
        saveSettings(set.id, 'test', settings);
        startTest();
      }

      const best = getBest(set.id, 'test');
      const panel = h('div', { class: 'panel test-setup test-screen' },
        h('div', { class: 'test-setup__head' },
          h('h1', {}, 'Set up your test'),
          h('p', { class: 'muted' }, 'Choose how many questions you want and which kinds.'),
          best != null && h('div', { class: 'test-best' }, icon('trophy'), `Best score: ${best}%`),
        ),
        h('form', { class: 'test-setup__form', novalidate: true, onsubmit: start },
          optionGroup('Questions', h('div', { class: 'test-count' }, countInput, maxNote)),
          optionGroup('Answer with', answerWith),
          optionGroup('Question types',
            h('div', { class: 'test-types', role: 'group', 'aria-label': 'Question types' },
              typeRows.map((r) => r.row),
              typesNote,
            ),
          ),
          optionGroup('Terms', starred),
          h('div', { class: 'test-setup__foot' },
            h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'Start test'),
          ),
        ),
      );

      syncCount();
      syncTypes();
      mount(panel, null);
    }

    /* ---------- Taking the test ---------- */

    function showTest(test) {
      const { total, questions } = test;
      const writtens = questions.filter((it) => it.type === 'written');

      // Sticky "X of N answered" strip
      const answeredEl = h('strong', {}, '0');
      const bar = h('div', { class: 'test-strip__bar' });
      const track = h('div', {
        class: 'test-strip__track',
        role: 'progressbar',
        'aria-label': 'Questions answered',
        'aria-valuemin': '0',
        'aria-valuemax': String(total),
        'aria-valuenow': '0',
      }, bar);
      const strip = h('div', { class: 'test-strip' },
        h('div', { class: 'test-strip__row' }, h('span', {}, answeredEl, ` of ${total} answered`)),
        track,
      );

      function updateProgress() {
        const answered = questions.filter(isAnswered).length;
        answeredEl.textContent = answered;
        bar.style.width = `${(answered / total) * 100}%`;
        track.setAttribute('aria-valuenow', String(answered));
        strip.classList.toggle('is-complete', answered === total);
        setLeaveGuard(answered ? () => confirm(LEAVE_MESSAGE) : null);
      }

      function changed(item) {
        const done = isAnswered(item);
        item.el.classList.toggle('is-answered', done);
        if (done) item.el.classList.remove('is-missing');
        updateProgress();
      }

      const submitBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: trySubmit }, 'Submit test');

      function questionCard(item, label, ...body) {
        item.el = h('article', {
          class: 'panel test-q',
          id: `test-q-${item.num}`,
          'aria-label': `Question ${item.num} of ${total}`,
        },
          h('div', { class: 'test-q__head' },
            h('span', { class: 'test-q__type' }, label),
            h('span', { class: 'test-q__num' }, `${item.num} of ${total}`),
          ),
          ...body,
        );
        return item.el;
      }

      function trueFalseCard(item) {
        const buttons = [true, false].map((value) =>
          h('button', {
            type: 'button',
            class: 'choice test-tf__btn',
            'aria-pressed': 'false',
            onclick: () => {
              item.response = value;
              buttons.forEach((b, i) => setPressed(b, (i === 0) === value));
              changed(item);
            },
          }, value ? 'True' : 'False'),
        );
        item.focusEl = buttons[0];
        return questionCard(item, 'True or false',
          tfPair(set, item),
          h('div', { class: 'test-q__answer' },
            h('p', { class: 'test-q__ask' }, 'Choose an answer'),
            h('div', { class: 'test-tf__choices' }, buttons),
          ),
        );
      }

      function multipleChoiceCard(item) {
        const list = choiceList(item.choices, (index) => {
          item.response = index;
          list.buttons.forEach((b, i) => setPressed(b, i === index));
          changed(item);
        });
        list.buttons.forEach((b) => b.setAttribute('aria-pressed', 'false'));
        item.focusEl = list.buttons[0];
        return questionCard(item, 'Multiple choice',
          promptBlock(set, item.q),
          h('div', { class: 'test-q__answer' },
            h('p', { class: 'test-q__ask' }, `Choose the matching ${lower(item.q.answerSide)}`),
            list.el,
          ),
        );
      }

      function writtenCard(item) {
        const id = `test-answer-${item.num}`;
        const isLast = item === writtens[writtens.length - 1];
        const input = h('input', {
          type: 'text',
          id,
          class: 'answer-input',
          placeholder: `Type the ${lower(item.q.answerSide)}`,
          autocomplete: 'off',
          autocapitalize: 'off',
          enterKeyHint: isLast ? 'done' : 'next',
          lang: langOf(set, item.q.answerSide) || null,
          oninput: () => {
            item.response = input.value;
            changed(item);
          },
          onkeydown: (e) => {
            if (e.key !== 'Enter' || e.isComposing) return;
            e.preventDefault();
            const next = writtens[writtens.indexOf(item) + 1];
            focusField(next ? next.focusEl : submitBtn);
          },
        });
        input.spellcheck = false;
        input.setAttribute('autocorrect', 'off');
        item.focusEl = input;
        return questionCard(item, 'Written',
          promptBlock(set, item.q),
          h('div', { class: 'test-q__answer' },
            h('label', { class: 'test-q__ask', for: id }, 'Your answer'),
            input,
          ),
        );
      }

      function matchingCard(section) {
        const { items, options } = section;
        const { promptSide, answerSide } = items[0].q;

        const bank = options.map((text, i) => {
          const used = h('span', { class: 'test-match__used' });
          const el = h('li', { class: 'test-match__option' },
            h('span', { class: 'test-match__letter' }, letter(i)),
            h('span', { class: 'test-match__option-text' }, text),
            used,
          );
          return { el, used };
        });

        // Dim the options already picked and note which questions use them.
        const syncBank = () => bank.forEach((b, i) => {
          const nums = items.filter((it) => it.response === i).map((it) => `#${it.num}`);
          b.el.classList.toggle('is-used', nums.length > 0);
          b.used.textContent = nums.join(' ');
        });

        const rows = items.map((item) => {
          const chosen = h('div', { class: 'test-match__chosen' });
          const select = h('select', {
            class: 'test-match__select',
            'aria-labelledby': `test-mnum-${item.num} test-mtext-${item.num}`,
            onchange: () => {
              item.response = select.value === '' ? null : Number(select.value);
              chosen.textContent = item.response === null ? '' : options[item.response];
              syncBank();
              changed(item);
            },
          },
            h('option', { value: '' }, '–'),
            options.map((_, i) => h('option', { value: String(i) }, letter(i))),
          );
          item.focusEl = select;
          item.el = h('li', { class: 'test-match__row', id: `test-q-${item.num}` },
            h('span', { class: 'test-match__num', id: `test-mnum-${item.num}` }, String(item.num)),
            h('div', { class: 'test-match__prompt' },
              h('span', { class: 'test-match__text', id: `test-mtext-${item.num}` }, item.q.prompt),
              speakButton(() => item.q.prompt, () => langOf(set, promptSide)),
            ),
            h('span', { class: 'test-select' }, select),
            chosen,
          );
          return item.el;
        });

        const first = items[0].num;
        const last = items[items.length - 1].num;
        return h('article', { class: 'panel test-q test-match', 'aria-label': `Questions ${first} to ${last} of ${total}` },
          h('div', { class: 'test-q__head' },
            h('span', { class: 'test-q__type' }, 'Matching'),
            h('span', { class: 'test-q__num' }, `${first}–${last} of ${total}`),
          ),
          h('p', { class: 'test-q__ask' }, `Match each ${lower(promptSide)} with its ${lower(answerSide)} by picking a letter.`),
          h('div', { class: 'test-match__layout' },
            h('div', { class: 'test-match__bank' },
              h('div', { class: 'test-match__bank-label' }, `${SIDE_LABEL[answerSide]}s`),
              h('ul', { class: 'test-match__options' }, bank.map((b) => b.el)),
            ),
            h('ol', { class: 'test-match__rows' }, rows),
          ),
        );
      }

      const builders = { trueFalse: trueFalseCard, multipleChoice: multipleChoiceCard, written: writtenCard };

      const sectionEl = (section) =>
        h('section', { class: 'test-section' },
          h('h2', { class: 'test-section__title' },
            section.title,
            h('span', { class: 'test-section__count' }, plural(section.items.length, 'question')),
          ),
          section.type === 'matching'
            ? matchingCard(section)
            : section.items.map((item) => builders[section.type](item)),
        );

      function trySubmit() {
        const missing = questions.filter((it) => !isAnswered(it));
        if (!missing.length) return finish();
        openModal({
          title: `You have ${plural(missing.length, 'unanswered question')}`,
          body: h('p', { class: 'muted' }, 'Unanswered questions are marked incorrect.'),
          actions: [
            {
              label: 'Keep working',
              onClick: () => {
                missing.forEach((it) => it.el.classList.add('is-missing'));
                // After the modal has closed and handed focus back.
                later(() => focusField(missing[0].focusEl), 0);
              },
            },
            { label: 'Submit anyway', primary: true, onClick: finish },
          ],
        });
      }

      function finish() {
        activeTest = null;
        setLeaveGuard(null);
        test.elapsed = Date.now() - test.startedAt;
        for (const item of questions) {
          item.result = grade(item);
          item.overridden = false;
        }
        showResults(test);
      }

      const submitPanel = h('div', { class: 'panel result test-submit' },
        h('div', { class: 'result__icon' }, icon('test')),
        h('h2', {}, 'Ready to submit?'),
        h('p', { class: 'muted' }, 'Check your answers, then submit to see your score.'),
        h('div', { class: 'result__actions' }, submitBtn),
      );

      const sheet = h('div', { class: 'test-sheet test-screen' }, strip, test.sections.map(sectionEl), submitPanel);
      mount(sheet, () => {
        if (questions.some(isAnswered) && !confirm(LEAVE_MESSAGE)) return;
        showSetup();
      });
      activeTest = test;
      test.startedAt = Date.now();
      updateProgress();
    }

    /* ---------- Results ---------- */

    function showResults(test) {
      const { total, questions } = test;
      const prevBest = getBest(set.id, 'test');

      const pctEl = h('span', { class: 'test-ring__pct' });
      const ring = h('div', { class: 'test-ring' });
      ring.innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
        <circle class="test-ring__track" cx="60" cy="60" r="${RING_R}"/>
        <circle class="test-ring__value" cx="60" cy="60" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}"/>
      </svg>`;
      ring.append(pctEl);
      const arc = ring.querySelector('.test-ring__value');
      arc.style.strokeDashoffset = RING_C;
      arc.style.opacity = '0';

      const setRing = (pct) => {
        arc.style.strokeDashoffset = RING_C * (1 - pct / 100);
        arc.style.opacity = pct ? '1' : '0';
      };

      const title = h('h2', { class: 'test-hero__title', tabIndex: -1 });
      const blurb = h('p', { class: 'muted' });
      const tally = h('span', { class: 'test-hero__tally' });
      const bestBadge = h('div', { class: 'test-newbest' }, icon('trophy'), 'New best score!');

      // Recomputes the score (overrides change it) and saves it if it's a record.
      function update() {
        const correct = questions.filter(isCorrect).length;
        const pct = Math.round((correct / total) * 100);
        const [heading, text] = verdict(pct);
        pctEl.textContent = `${pct}%`;
        ring.dataset.band = pct >= 75 ? 'high' : pct >= 50 ? 'mid' : 'low';
        title.textContent = heading;
        blurb.textContent = text;
        tally.replaceChildren(
          h('span', { class: 'test-tally--good' }, `${correct} correct`),
          ' · ',
          h('span', { class: 'test-tally--bad' }, `${total - correct} incorrect`),
        );
        recordBest(set.id, 'test', pct);
        bestBadge.hidden = !(prevBest == null || pct > prevBest);
        return pct;
      }

      const actions = () => h('div', { class: 'result__actions test-actions' },
        h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: startTest }, icon('restart'), 'Retake test'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-lg', onclick: () => showSetup() }, 'New test'),
        h('a', { class: 'btn btn-ghost btn-lg', href: `#/set/${set.id}` }, 'Back to set'),
      );

      function toggleOverride(item, card) {
        item.overridden = !item.overridden;
        const fresh = reviewCard(item);
        card.replaceWith(fresh);
        fresh.querySelector('.test-override button')?.focus();
        setRing(update());
      }

      // Disabled True/False buttons coloured like a marked choice list.
      function tfReview(item) {
        return h('div', { class: 'test-tf__choices' },
          [true, false].map((value) => {
            const isAnswer = value === item.truth;
            const isPicked = value === item.response;
            const note = [isAnswer && 'correct answer', isPicked && 'your answer'].filter(Boolean).join(', ');
            const label = value ? 'True' : 'False';
            return h('button', {
              type: 'button',
              class: `choice test-tf__btn ${isAnswer ? 'is-correct' : isPicked ? 'is-wrong' : 'is-dim'}`,
              disabled: true,
              'aria-label': note ? `${label} (${note})` : null,
            }, label);
          }),
        );
      }

      function mcReview(item) {
        const list = choiceList(item.choices, () => {});
        const picked = item.response ?? -1;
        list.mark(item.q.answer, picked);
        list.buttons.forEach((b, i) => {
          const isAnswer = item.choices[i] === item.q.answer;
          const note = [isAnswer && 'correct answer', i === picked && 'your answer'].filter(Boolean).join(', ');
          if (note) b.setAttribute('aria-label', `${item.choices[i]} (${note})`);
        });
        return list.el;
      }

      function reviewCard(item) {
        const ok = isCorrect(item);
        const blank = item.result === 'blank';
        const { q } = item;
        const status = ok ? 'Correct' : blank ? 'No answer' : 'Incorrect';
        const body = [];

        if (item.type === 'trueFalse') {
          body.push(tfPair(set, item), tfReview(item));
          if (!item.truth) body.push(answerRow(`Correct ${lower(q.answerSide)}`, q.answer, 'good'));
        } else if (item.type === 'multipleChoice') {
          body.push(promptBlock(set, q), mcReview(item));
        } else if (item.type === 'matching') {
          body.push(promptBlock(set, q), h('div', { class: 'test-answers' },
            answerRow('Your answer', blank ? null : item.section.options[item.response], ok ? 'good' : 'bad'),
            !ok && answerRow('Correct answer', q.answer, 'good'),
          ));
        } else {
          const close = item.result === 'close';
          const kind = !ok ? 'bad' : close ? 'close' : 'good';
          body.push(promptBlock(set, q), h('div', { class: 'test-answers' },
            answerRow('Your answer', blank ? null : item.response, kind),
            item.result !== 'correct' && answerRow('Correct answer', q.answer, 'good'),
          ));
          if (close) {
            body.push(h('div', { class: 'feedback feedback--note' }, icon('edit'), 'Almost! Watch the spelling.'));
          } else if (item.result === 'wrong') {
            body.push(h('div', { class: 'test-override' },
              item.overridden && h('span', { class: 'test-override__note' }, icon('check'), 'You marked this as correct.'),
              h('button', {
                type: 'button',
                class: item.overridden ? 'btn btn-ghost' : 'btn btn-secondary',
                onclick: () => toggleOverride(item, card),
              }, icon(item.overridden ? 'undo' : 'check'), item.overridden ? 'Undo' : 'Override: I was right'),
            ));
          }
        }

        const card = h('article', {
          class: `panel test-q test-rev ${ok ? 'is-correct' : 'is-wrong'}`,
          'aria-label': `Question ${item.num}: ${status}`,
        },
          h('div', { class: 'test-q__head' },
            h('span', { class: 'test-status' }, icon(ok ? 'check' : 'close'), status),
            h('span', { class: 'test-q__num' }, `${TYPE_TITLE[item.type]} · ${item.num} of ${total}`),
          ),
          body,
        );
        return card;
      }

      const hero = h('section', { class: 'panel test-hero', 'aria-label': 'Your score' },
        h('div', { class: 'test-hero__main' },
          ring,
          h('div', { class: 'test-hero__text' },
            bestBadge,
            title,
            blurb,
            h('div', { class: 'test-hero__meta' },
              tally,
              h('span', { class: 'test-hero__time' }, icon('timer'), `Finished in ${formatTime(test.elapsed)}`),
            ),
          ),
        ),
        actions(),
      );

      const review = h('div', { class: 'test-review' },
        h('h2', { class: 'test-review__title' }, 'Your answers'),
        test.sections.map((section) =>
          h('section', { class: 'test-section' },
            h('h3', { class: 'test-section__title' },
              section.title,
              h('span', { class: 'test-section__count' }, plural(section.items.length, 'question')),
            ),
            section.items.map(reviewCard),
          ),
        ),
        actions(),
      );

      const pct = update();
      mount(h('div', { class: 'test-results test-screen' }, hero, review), () => showSetup());
      title.focus({ preventScroll: true });
      later(() => setRing(pct), 80); // let the empty ring paint first so it animates in
    }

    showSetup();
  }

  registerMode('test', {
    title: 'Test',
    icon: 'test',
    order: 3,
    description: 'A graded practice test with mixed question types',
    render,
  });
})();
