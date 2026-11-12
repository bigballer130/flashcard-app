/* ============================================================
   blast.js — Blast: a prompt sits at the bottom of a space arena;
   shoot the asteroid carrying the right answer before it flies
   off-screen. Endless waves, three lives, levels speed things up.
   ============================================================ */

(() => {
  'use strict';

  const MODE = 'blast';
  const DEFAULTS = { answerWith: 'definition', starredOnly: false };
  const ANSWER_SIDES = ['term', 'definition', 'both'];
  const ANSWER_NAMES = { term: 'Term', definition: 'Definition', both: 'Term & definition' };

  const LIVES = 3;
  const PER_LEVEL = 5; // correct answers per level
  const SPEEDUP = 1.15; // each level is 15% faster
  const CROSS_MS = 8000; // how long an asteroid takes to cross the arena at level 1
  const CROSS_MS_REDUCED = 11000;
  const MIN_CROSS_MS = 2600;
  const MAX_FRAME_MS = 50; // clamp long frames so nothing teleports
  const NEXT_WAVE_MS = 600;
  const LEVEL_UP_EXTRA_MS = 900;
  const REVEAL_MS = 1200;
  const GAME_OVER_MS = 1300;

  const SPARK_COLORS = ['#fff4c7', '#ffd36b', '#ffa94d', '#ff7a6b', '#9ef0ff'];
  const SHAKE = [
    { transform: 'translateX(0)' },
    { transform: 'translateX(-7px)' },
    { transform: 'translateX(6px)' },
    { transform: 'translateX(-4px)' },
    { transform: 'translateX(2px)' },
    { transform: 'translateX(0)' },
  ];

  const rand = (min, max) => min + Math.random() * (max - min);
  const randInt = (n) => 1 + Math.floor(Math.random() * n);
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (n) => n.toLocaleString();
  const animate = (el, frames, options) => (el.animate ? el.animate(frames, options) : null);

  /* ------------------------------------------------------------
     One game: builds the arena and runs it until lives run out.
     Everything time-based runs on the game clock (advanced by a
     single rAF loop), so pausing freezes motion and timers alike.
     ------------------------------------------------------------ */

  function createGame(set, settings, { announce, onEnd }) {
    const reduced = prefersReducedMotion();
    const pool = studyPool(set, settings.starredOnly);
    const baseCross = reduced ? CROSS_MS_REDUCED : CROSS_MS;

    const g = {
      running: false,
      paused: false,
      over: false,
      raf: 0,
      last: null, // timestamp of the previous frame; null = next frame has dt 0
      now: 0, // game clock (ms)
      timers: [], // [{ at, fn }] on the game clock
      rocks: [],
      wave: null,
      queue: [],
      lastCard: null,
      score: 0,
      level: 1,
      lives: LIVES,
      streak: 0,
      bestStreak: 0,
      correct: 0,
      wrong: 0,
      missed: 0,
    };
    // Field size, the band asteroids fly in (above the prompt), and where the cannon is.
    const dims = { W: 0, H: 0, top: 0, bottom: 0, gunX: 0, gunY: 0 };
    let resizeObserver = null;

    /* --- DOM --- */

    const scoreEl = h('span', { class: 'blast-hud__value blast-hud__score' }, '0');
    const levelEl = h('span', { class: 'blast-hud__value' }, '1');
    const streakNum = h('span', {});
    const streakEl = h('span', { class: 'blast-hud__streak', 'aria-hidden': 'true' },
      streakNum, h('span', { class: 'hide-sm' }, ' streak'));
    const hearts = range(LIVES).map(() => h('span', { class: 'blast-heart is-alive' }, icon('heart')));
    const heartsEl = h('div', { class: 'blast-hearts', role: 'img' }, hearts);
    const pauseBtn = h('button', {
      type: 'button',
      class: 'icon-btn blast-hud__pause',
      title: 'Pause (P)',
      'aria-label': 'Pause',
      onclick: () => pause(),
    }, icon('pause'));

    const hud = h('div', { class: 'blast-hud' },
      h('div', { class: 'blast-hud__stats' },
        h('div', { class: 'blast-hud__stat' }, h('span', { class: 'blast-hud__label' }, 'Score'), scoreEl),
        h('div', { class: 'blast-hud__stat' }, h('span', { class: 'blast-hud__label' }, 'Level'), levelEl),
        streakEl,
      ),
      h('div', { class: 'blast-hud__side' }, heartsEl, pauseBtn),
    );

    const rocksLayer = h('div', { class: 'blast-rocks' });
    const fx = h('div', { class: 'blast-fx', 'aria-hidden': 'true' });

    const shipLabel = h('div', { class: 'blast-ship__label' });
    const shipText = h('div', { class: 'blast-ship__text' });
    const revealText = h('div', { class: 'blast-reveal__text' });
    const reveal = h('div', { class: 'blast-reveal', 'aria-hidden': 'true' },
      h('div', { class: 'blast-reveal__box' },
        h('div', { class: 'blast-reveal__label' }, 'Correct answer'),
        revealText,
      ),
    );
    const cannon = h('div', { class: 'blast-ship__cannon', 'aria-hidden': 'true' });
    const shipCard = h('div', { class: 'blast-ship__card' },
      h('div', { class: 'blast-ship__main' }, shipLabel, shipText),
      speakButton(
        () => g.wave?.q.prompt || '',
        () => (g.wave ? langOf(set, g.wave.q.promptSide) : ''),
        'Read prompt aloud',
      ),
    );
    const ship = h('div', { class: 'blast-ship' }, reveal, cannon, shipCard);

    const field = h('div', { class: 'blast-field' }, rocksLayer, fx, ship);
    const damage = h('div', { class: 'blast-damage', 'aria-hidden': 'true' });

    const resumeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: () => resume() },
      icon('play'), 'Resume');
    const pauseOverlay = h('div', { class: 'blast-pause' },
      h('div', { class: 'blast-pause__box' },
        h('h2', {}, 'Paused'),
        resumeBtn,
        h('p', { class: 'blast-pause__hint' }, 'Press P or Esc to resume'),
      ),
    );

    const arena = h('div', {
      class: `blast-arena${reduced ? ' is-reduced' : ''}`,
      role: 'group',
      'aria-label': 'Blast game',
      tabIndex: -1,
    },
      h('div', { class: 'blast-stars blast-stars--far', 'aria-hidden': 'true' }),
      h('div', { class: 'blast-stars blast-stars--near', 'aria-hidden': 'true' }),
      hud,
      field,
      damage,
      pauseOverlay,
    );

    /* --- Clock --- */

    function after(ms, fn) {
      g.timers.push({ at: g.now + ms, fn });
    }

    function loop(ts) {
      g.raf = 0;
      if (!g.running || g.paused) return;
      const dt = g.last == null ? 0 : clamp(ts - g.last, 0, MAX_FRAME_MS);
      g.last = ts;
      step(dt);
      if (g.running && !g.paused) g.raf = requestAnimationFrame(loop);
    }

    // Starts the loop if it isn't running. The first frame after this has dt 0, so the clock never jumps.
    function kick() {
      if (g.raf || !g.running || g.paused) return;
      g.last = null;
      g.raf = requestAnimationFrame(loop);
    }

    function step(dt) {
      g.now += dt;
      if (g.timers.some((t) => t.at <= g.now)) {
        const due = g.timers.filter((t) => t.at <= g.now).sort((a, b) => a.at - b.at);
        g.timers = g.timers.filter((t) => t.at > g.now);
        for (const t of due) {
          if (!g.running) return;
          t.fn();
        }
      }
      if (g.running) moveRocks(dt);
    }

    /* --- Layout --- */

    function measure() {
      const W = field.clientWidth;
      const H = field.clientHeight;
      if (!W || !H) return;
      if (dims.W && (W !== dims.W || H !== dims.H)) {
        // Keep in-flight asteroids on sensible paths after a resize.
        const rx = W / dims.W;
        const ry = H / dims.H;
        const oldW = dims.W;
        const sx = (v, r) => (v >= oldW ? W + (v - oldW) : v <= -r.w ? v : v * rx);
        const sy = (v, r) => (v <= -r.h ? v : v * ry);
        for (const r of g.rocks) {
          r.sx = sx(r.sx, r);
          r.ex = sx(r.ex, r);
          r.sy = sy(r.sy, r);
          r.ey = sy(r.ey, r);
        }
      }
      dims.W = W;
      dims.H = H;
      dims.top = 6;
      dims.bottom = Math.max(dims.top + 48, ship.offsetTop - 16);
      dims.gunX = ship.offsetLeft + ship.offsetWidth / 2;
      dims.gunY = ship.offsetTop - 10;
    }

    /* --- HUD --- */

    function updateHud(bump = false) {
      scoreEl.textContent = fmt(g.score);
      levelEl.textContent = String(g.level);
      streakNum.textContent = `×${g.streak}`;
      streakEl.classList.toggle('is-on', g.streak >= 2);
      heartsEl.setAttribute('aria-label', `${plural(g.lives, 'life', 'lives')} left`);
      hearts.forEach((el, i) => el.classList.toggle('is-alive', i < g.lives));
      if (bump && !reduced) {
        animate(scoreEl, [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
      }
    }

    function banner(title, sub) {
      const el = h('div', { class: 'blast-banner', 'aria-hidden': 'true' },
        h('div', { class: 'blast-banner__title' }, title),
        sub && h('div', { class: 'blast-banner__sub' }, sub),
      );
      field.append(el);
      after(1600, () => el.remove());
    }

    /* --- Waves --- */

    function takeCard() {
      if (!g.queue.length) {
        g.queue = shuffle(pool);
        // Don't repeat the card we just played when the deck is reshuffled.
        const end = g.queue.length - 1;
        if (end > 0 && g.queue[end] === g.lastCard) [g.queue[0], g.queue[end]] = [g.queue[end], g.queue[0]];
      }
      g.lastCard = g.queue.pop();
      return g.lastCard;
    }

    function nextWave() {
      if (!g.running || g.over) return;
      const q = makeQuestion(takeCard(), settings.answerWith);
      const choices = choicesFor(q, set.cards, 4);
      const n = choices.length;
      // Entry points are spread over a window of the right + top edges (s: 0 = bottom of the
      // right edge, 1 = most of the way along the top edge). Pairing the lowest entry with the
      // lowest exit lane keeps the paths of one wave from crossing.
      const span = n > 1 ? rand(0.4, 0.55) : 0;
      const s0 = rand(0.08, 0.95 - span);
      const wave = { q, choices, n, done: false, lanes: shuffle(range(n)), s0, s1: s0 + span };
      g.wave = wave;

      shipLabel.textContent = SIDE_LABEL[q.promptSide];
      shipText.textContent = q.prompt;
      shipText.dataset.size = textSize(q.prompt);
      if (!reduced) {
        animate(shipText, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], {
          duration: 260,
          easing: 'ease-out',
        });
      }
      announce(`${SIDE_LABEL[q.promptSide]}: ${q.prompt}`);
      measure();

      let delay = 250;
      for (const i of shuffle(range(n))) {
        after(delay, () => {
          if (g.wave === wave && !wave.done && !g.over) spawn(wave, i);
        });
        delay += rand(420, 780);
      }
    }

    function spawn(wave, i) {
      const text = wave.choices[i];
      const body = h('span', { class: 'blast-rock__body' });
      if (!reduced) body.style.cssText = `animation-duration:${rand(3.5, 6).toFixed(2)}s;animation-delay:-${rand(0, 6).toFixed(2)}s`;
      const key = h('span', { class: 'blast-rock__key', 'aria-hidden': 'true' }, String(i + 1));
      const inner = h('span', { class: 'blast-rock__inner' },
        body,
        key,
        h('span', { class: 'blast-rock__text', 'data-size': textSize(text) }, text.trim() ? text : '…'),
      );
      const el = h('button', {
        type: 'button',
        class: 'blast-rock',
        'data-shape': randInt(4),
        'data-tint': randInt(3),
        'aria-label': `Answer ${i + 1}: ${text}`,
      }, inner);
      const r = { el, inner, key, text, index: i, wave, correct: text === wave.q.answer, state: 'live', t: 0 };

      // Fire on press, not on release: the target moves while the button is held.
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        shoot(r);
      });
      el.addEventListener('mousedown', (e) => e.preventDefault()); // don't steal focus
      el.addEventListener('click', () => shoot(r)); // keyboard (Enter / Space on a focused asteroid)

      rocksLayer.append(el);
      r.w = el.offsetWidth;
      r.h = el.offsetHeight;

      const { W, top, bottom } = dims;
      const n = wave.n;
      const lane = wave.lanes[i];
      const room = Math.max(0, bottom - top - r.h);
      r.ex = -r.w - 6;
      r.ey = top + (room * (lane + 0.5)) / n;
      const s = wave.s0 + ((wave.s1 - wave.s0) * (n - 1 - lane + 0.5)) / n;
      const rightLen = Math.max(0, bottom); // right edge, from y = bottom - h up to y = -h
      const topLen = W * 0.6; // top edge, from the corner to 40% across
      const d = s * (rightLen + topLen);
      if (d <= rightLen) {
        r.sx = W + 6;
        r.sy = bottom - r.h - d;
      } else {
        r.sx = W - (d - rightLen);
        r.sy = -r.h - 6;
      }

      const len = Math.hypot(r.ex - r.sx, r.ey - r.sy) || 1;
      r.nx = -(r.ey - r.sy) / len; // unit normal to the path, for the wobble
      r.ny = (r.ex - r.sx) / len;
      r.amp = reduced ? 0 : rand(6, 13) * clamp(W / 700, 0.6, 1);
      r.freq = (Math.PI * 2 * rand(0.3, 0.6)) / 1000;
      r.phase = rand(0, Math.PI * 2);
      r.dur = Math.max(MIN_CROSS_MS, baseCross / SPEEDUP ** (g.level - 1)) * rand(0.92, 1.08);
      r.x = r.sx;
      r.y = r.sy;
      place(r);
      g.rocks.push(r);
    }

    function place(r) {
      r.el.style.transform = `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`;
    }

    function moveRocks(dt) {
      for (const r of g.rocks) {
        if (r.state === 'hit' || r.state === 'dead') continue;
        r.t += dt;
        const p = r.t / r.dur;
        if (p >= 1) {
          escaped(r);
          continue;
        }
        // Wobble fades in and out so asteroids enter and leave fully off-screen.
        const wob = r.amp ? Math.sin(r.phase + r.t * r.freq) * r.amp * Math.min(1, p * 8, (1 - p) * 8) : 0;
        r.x = r.sx + (r.ex - r.sx) * p + r.nx * wob;
        r.y = r.sy + (r.ey - r.sy) * p + r.ny * wob;
        place(r);
      }
    }

    function isVisible(r) {
      return r.x < dims.W - 8 && r.x + r.w > 8 && r.y + r.h > 8;
    }

    // Takes an asteroid out of play (keeps keyboard focus inside the arena if it had it).
    function disable(r) {
      if (r.el.contains(document.activeElement)) arena.focus({ preventScroll: true });
      r.el.disabled = true;
    }

    function removeRock(r) {
      if (r.state === 'dead') return;
      if (r.el.contains(document.activeElement)) arena.focus({ preventScroll: true });
      r.state = 'dead';
      r.el.remove();
      g.rocks = g.rocks.filter((x) => x !== r);
    }

    // Fades out what's left of a finished wave.
    function fadeWave(wave) {
      for (const r of g.rocks) {
        if (r.wave !== wave || (r.state !== 'live' && r.state !== 'wrong')) continue;
        r.state = 'fading';
        disable(r);
        r.el.classList.add('is-fading');
        after(380, () => removeRock(r));
      }
    }

    function escaped(r) {
      const wasLive = r.state === 'live';
      removeRock(r);
      if (r.correct && wasLive && !r.wave.done && !g.over) missWave(r.wave);
    }

    /* --- Shooting --- */

    function shoot(r) {
      if (!g.running || g.paused || g.over || r.state !== 'live' || r.wave !== g.wave || r.wave.done) return;
      fireLaser(r);
      if (r.correct) hit(r);
      else wrongShot(r);
    }

    function hit(r) {
      const wave = r.wave;
      wave.done = true;
      r.state = 'hit';
      disable(r);
      r.el.classList.add('is-hit');

      g.correct++;
      g.streak++;
      g.bestStreak = Math.max(g.bestStreak, g.streak);
      const points = 100 * g.level + 25 * g.streak;
      g.score += points;

      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      explode(cx, cy);
      floatText(cx, cy, `+${fmt(points)}`, g.streak > 1 ? `${g.streak} in a row` : '');
      fadeWave(wave);
      after(450, () => removeRock(r));

      const levelUp = g.correct % PER_LEVEL === 0;
      if (levelUp) {
        g.level++;
        after(350, () => banner(`Level ${g.level}`, 'Faster asteroids'));
      }
      updateHud(true);
      announce(levelUp ? `Correct! Level ${g.level}` : 'Correct!');
      after(NEXT_WAVE_MS + (levelUp ? LEVEL_UP_EXTRA_MS : 0), () => {
        if (g.wave === wave) nextWave();
      });
    }

    function wrongShot(r) {
      r.state = 'wrong';
      disable(r);
      r.el.classList.add('is-wrong');
      r.el.setAttribute('aria-label', `Answer ${r.index + 1}: ${r.text} (wrong)`);
      r.key.replaceChildren(icon('close'));
      if (!reduced) animate(r.inner, SHAKE, { duration: 380, easing: 'ease-out' });

      g.wrong++;
      g.streak = 0;
      const left = loseLife();
      announce(left ? `Wrong — ${plural(left, 'life', 'lives')} left` : 'Wrong');
      if (!left) gameOver(GAME_OVER_MS);
    }

    function missWave(wave) {
      wave.done = true;
      g.missed++;
      g.streak = 0;
      fadeWave(wave);
      revealText.textContent = wave.q.answer;
      reveal.classList.add('is-visible');
      const left = loseLife();
      announce(`Missed it — the answer was ${wave.q.answer}`);
      after(REVEAL_MS, () => {
        reveal.classList.remove('is-visible');
        if (!g.over && g.wave === wave) nextWave();
      });
      if (!left) gameOver(REVEAL_MS + 300);
    }

    function loseLife() {
      g.lives = Math.max(0, g.lives - 1);
      updateHud();
      const heart = hearts[g.lives];
      if (!reduced) animate(heart, [{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
      animate(damage, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 600, easing: 'ease-out' });
      if (!reduced) animate(shipCard, SHAKE, { duration: 380, easing: 'ease-out' });
      return g.lives;
    }

    function gameOver(delay) {
      g.over = true;
      pauseBtn.disabled = true;
      if (g.wave) {
        g.wave.done = true;
        fadeWave(g.wave);
      }
      after(350, () => banner('Game over', ''));
      after(delay, finish);
    }

    function finish() {
      const stats = {
        score: g.score,
        correct: g.correct,
        attempts: g.correct + g.wrong + g.missed,
        level: g.level,
        bestStreak: g.bestStreak,
      };
      destroy();
      onEnd(stats);
    }

    /* --- Effects --- */

    function fireLaser(r) {
      const tx = r.x + r.w / 2;
      const ty = r.y + r.h / 2;
      const dx = tx - dims.gunX;
      const dy = ty - dims.gunY;
      const beam = h('div', { class: 'blast-laser' });
      beam.style.cssText = `left:${dims.gunX.toFixed(1)}px;top:${dims.gunY.toFixed(1)}px;`
        + `width:${Math.hypot(dx, dy).toFixed(1)}px;transform:rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`;
      fx.append(beam);
      after(260, () => beam.remove());
      if (!reduced) {
        animate(cannon, [{ transform: 'translateY(3px) scale(1.35)' }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
      }
    }

    function explode(cx, cy) {
      const boom = h('div', { class: 'blast-boom' },
        h('span', { class: 'blast-boom__flash' }),
        h('span', { class: 'blast-boom__ring' }),
      );
      boom.style.cssText = `left:${cx.toFixed(1)}px;top:${cy.toFixed(1)}px`;
      if (!reduced) {
        for (let k = 0; k < 14; k++) {
          const chunk = k >= 10;
          const angle = (k / (chunk ? 4 : 10)) * Math.PI * 2 + rand(-0.3, 0.3);
          const dist = chunk ? rand(30, 60) : rand(45, 95);
          const spark = h('span', { class: `blast-spark${chunk ? ' is-chunk' : ''}` });
          spark.style.cssText = `--dx:${(Math.cos(angle) * dist).toFixed(1)}px;--dy:${(Math.sin(angle) * dist).toFixed(1)}px;`
            + `--rot:${Math.round(rand(-260, 260))}deg;--c:${SPARK_COLORS[k % SPARK_COLORS.length]};`
            + `animation-duration:${Math.round(rand(450, 750))}ms`;
          boom.append(spark);
        }
      }
      fx.append(boom);
      after(800, () => boom.remove());
    }

    function floatText(cx, cy, text, sub) {
      const el = h('div', { class: 'blast-float' }, text, sub && h('small', {}, sub));
      el.style.cssText = `left:${clamp(cx, 56, dims.W - 56).toFixed(1)}px;top:${Math.max(cy, 40).toFixed(1)}px`;
      fx.append(el);
      after(1000, () => el.remove());
    }

    /* --- Pause --- */

    function pause() {
      if (!g.running || g.paused || g.over) return;
      g.paused = true;
      if (g.raf) cancelAnimationFrame(g.raf);
      g.raf = 0;
      arena.classList.add('is-paused');
      hud.inert = true;
      field.inert = true;
      pauseOverlay.classList.add('is-visible');
      resumeBtn.focus({ preventScroll: true });
      announce('Paused');
    }

    function resume() {
      if (!g.running || !g.paused) return;
      g.paused = false;
      arena.classList.remove('is-paused');
      hud.inert = false;
      field.inert = false;
      pauseOverlay.classList.remove('is-visible');
      arena.focus({ preventScroll: true });
      kick();
    }

    function onKey(e) {
      if (!g.running || e.repeat) return;
      const k = e.key;
      if (k === 'Escape' || k === 'p' || k === 'P') {
        if (g.over) return;
        e.preventDefault();
        if (g.paused) resume();
        else pause();
        return;
      }
      if (g.paused || g.over || !/^[1-9]$/.test(k)) return;
      const index = Number(k) - 1;
      const r = g.rocks.find((x) => x.wave === g.wave && x.index === index && x.state === 'live' && isVisible(x));
      if (r) {
        e.preventDefault();
        shoot(r);
      }
    }

    /* --- Lifecycle --- */

    function start() {
      if (g.running) return;
      g.running = true;
      if ('ResizeObserver' in window) {
        resizeObserver = new ResizeObserver(() => measure());
        resizeObserver.observe(field);
        resizeObserver.observe(ship);
      }
      measure();
      updateHud();
      banner('Level 1', 'Get ready');
      after(900, nextWave);
      arena.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
      arena.focus({ preventScroll: true });
      kick();
    }

    function destroy() {
      g.running = false;
      if (g.raf) cancelAnimationFrame(g.raf);
      g.raf = 0;
      g.timers = [];
      resizeObserver?.disconnect();
      resizeObserver = null;
    }

    return { el: arena, start, pause, destroy, onKey };
  }

  /* ------------------------------------------------------------
     The page: start screen → game → results.
     ------------------------------------------------------------ */

  function render(set, root) {
    document.title = `Blast · ${set.title} · Flashcards`;

    let settings = getSettings(set.id, MODE, DEFAULTS);
    if (!ANSWER_SIDES.includes(settings.answerWith)) settings.answerWith = DEFAULTS.answerWith;
    let game = null;
    let keyHandler = null;

    const screen = h('div', { class: 'blast__screen' });
    const live = h('div', { class: 'blast-sr', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    root.append(h('div', { class: 'mode blast' }, modeHeader(set, MODE, { onOptions: openOptions }), screen, live));

    // Alternate a trailing no-break space so repeating the same message is still announced.
    let flip = false;
    const announce = (message) => {
      flip = !flip;
      live.textContent = flip ? message : `${message} `;
    };

    // The modal's own Escape handler runs first (capture) and marks the event handled.
    listenKeys((e) => {
      if (!e.defaultPrevented) keyHandler?.(e);
    });

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') game?.pause();
    };
    document.addEventListener('visibilitychange', onVisibility);
    onLeave(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      stopGame();
    });

    // Enter runs `fn` unless it's about to press a focused button or link anyway.
    const onEnter = (fn) => (e) => {
      if (e.key !== 'Enter' || e.repeat) return;
      if (e.target.closest?.('button, a, input, select, textarea, [role="button"]')) return;
      e.preventDefault();
      fn();
    };

    const stat = (value, label) =>
      h('div', { class: 'stat' }, h('div', { class: 'stat__value' }, value), h('div', { class: 'stat__label' }, label));

    function stopGame() {
      if (!game) return;
      game.destroy();
      game = null;
    }

    function showStart() {
      stopGame();
      const pool = studyPool(set, settings.starredOnly);
      const starredOnly = settings.starredOnly && starredCards(set).length > 0;
      const best = getBest(set.id, MODE);

      screen.replaceChildren(
        h('div', { class: 'panel blast-intro' },
          h('div', { class: 'result' },
            h('div', { class: 'result__icon' }, icon('blast')),
            h('h2', {}, 'Blast'),
            h('p', { class: 'blast-intro__text' },
              'A prompt appears at the bottom. Shoot the asteroid carrying the right answer before it flies off-screen. '
              + 'Wrong shots and escaped answers cost a life.'),
            h('p', { class: 'blast-intro__meta' },
              `Answer with ${ANSWER_NAMES[settings.answerWith]} · ${plural(pool.length, starredOnly ? 'starred term' : 'term')}`),
            best != null && h('div', { class: 'blast-best' }, icon('trophy'), `Best score: ${fmt(best)}`),
            h('div', { class: 'result__actions' },
              h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: startGame }, icon('play'), 'Start'),
            ),
            h('p', { class: 'kbd-hint' }, 'Press ', h('kbd', {}, 'Enter'), ' to start'),
          ),
        ),
      );
      keyHandler = onEnter(startGame);
    }

    function startGame() {
      stopGame();
      game = createGame(set, settings, { announce, onEnd: showResult });
      screen.replaceChildren(
        game.el,
        h('p', { class: 'kbd-hint blast-hint' },
          'Click an asteroid or press ', h('kbd', {}, '1'), '–', h('kbd', {}, '4'), ' to shoot · ',
          h('kbd', {}, 'P'), ' to pause'),
      );
      keyHandler = game.onKey;
      game.start();
    }

    function showResult({ score, correct, attempts, level }) {
      game = null;
      const isRecord = score > 0 && recordBest(set.id, MODE, score);
      const best = getBest(set.id, MODE);
      const accuracy = attempts ? Math.round((100 * correct) / attempts) : 0;
      const again = h('button', { type: 'button', class: 'btn btn-primary btn-lg', onclick: startGame },
        icon('restart'), 'Play again');

      screen.replaceChildren(
        h('div', { class: 'panel blast-result' },
          h('div', { class: 'result' },
            h('div', { class: 'result__icon' }, icon(isRecord ? 'trophy' : 'blast')),
            h('h2', {}, 'Game over'),
            h('div', { class: 'blast-final' },
              h('div', { class: 'blast-final__value' }, fmt(score)),
              h('div', { class: 'blast-final__label' }, score === 1 ? 'point' : 'points'),
            ),
            isRecord && h('div', { class: 'blast-record' }, icon('trophy'), 'New high score!'),
            h('div', { class: 'stat-row' },
              stat(String(correct), 'Correct'),
              stat(`${accuracy}%`, 'Accuracy'),
              stat(String(level), 'Highest level'),
              !isRecord && best != null && stat(fmt(best), 'Best'),
            ),
            h('div', { class: 'result__actions' },
              again,
              h('a', { class: 'btn btn-secondary btn-lg', href: `#/set/${set.id}` }, 'Back to set'),
            ),
          ),
        ),
      );
      announce(`Game over — ${fmt(score)} ${score === 1 ? 'point' : 'points'}${isRecord ? '. New high score!' : ''}`);
      if (!document.querySelector('.modal')) again.focus({ preventScroll: true });
      keyHandler = onEnter(startGame);
    }

    function openOptions() {
      game?.pause();
      const draft = { ...settings };
      openModal({
        title: 'Blast options',
        body: [
          optionGroup('Answer with',
            answerWithControl(draft.answerWith, (v) => { draft.answerWith = v; }),
            'The asteroids carry this side of each card; the prompt shows the other.'),
          optionGroup('Terms', starredOnlySwitch(set, draft.starredOnly, (v) => { draft.starredOnly = v; })),
        ],
        actions: [
          { label: 'Cancel' },
          {
            label: 'Apply',
            primary: true,
            onClick: () => {
              settings = { answerWith: draft.answerWith, starredOnly: draft.starredOnly };
              saveSettings(set.id, MODE, settings);
              showStart();
            },
          },
        ],
      });
    }

    showStart();
  }

  registerMode(MODE, {
    title: 'Blast',
    icon: 'blast',
    order: 5,
    description: 'Shoot the right answer before it flies away',
    render,
  });
})();
