// Story page: five scroll-driven acts.
// GSAP ScrollTrigger drives every scene from the scroll position; Lenis smooths
// the wheel. Layers inside a scene move at different rates for depth.
// See ../STORY-BRIEF.md for the plan behind each act.

import { createMouth, mouthGeometry, shapeFor, REST, SHAPES } from './mouth.js';

const { gsap, ScrollTrigger, Lenis } = window;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const qs = (s, root = document) => root.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';

const C = {
  ink: '#17161c',
  paper: '#f4f3ef',
  butter: '#ffd447',
  fog: '#cfdbe8',
  slate: '#55546a',
};

// The stroke widths createNoise gives its lines, so a transition can hand them back.
const lineWidth = (i) => 2 + (i % 4) * 1.6;
// Wide enough that the wobbly lines overlap and fill the whole screen.
const floodWidth = () => innerHeight * 0.5;

if (!gsap || !ScrollTrigger) {
  // Libraries failed to load (offline): the page stays readable, just static.
  document.documentElement.classList.add('no-motion');
} else {
  main();
}

function main() {
  gsap.registerPlugin(ScrollTrigger);

  if (!reduce && Lenis) {
    const lenis = new Lenis({ lerp: 0.085, smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  buildDrawings();
  actNoise();
  actSilence();
  actFocus();
  actHow();
  actClose();
}

/* ---------- Helpers ---------- */

// Seeded random, so generated drawings look the same on every visit.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  parent?.append(el);
  return el;
}

function splitChars(el) {
  const text = el.textContent;
  el.textContent = '';
  el.setAttribute('aria-label', text);
  return [...text].map((ch) => {
    const span = document.createElement('span');
    span.className = 'ch';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = ch === ' ' ? ' ' : ch;
    el.append(span);
    return span;
  });
}

function splitWords(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.setAttribute('aria-label', el.textContent.trim());
  el.textContent = '';
  return words.map((word, i) => {
    const outer = document.createElement('span');
    outer.className = 'w';
    outer.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('span');
    inner.textContent = word;
    outer.append(inner);
    el.append(outer);
    if (i < words.length - 1) el.append(' ');
    return inner;
  });
}

/**
 * Scribbled "noise" lines drawn every frame. `level` scales how wild they are;
 * `converge` pulls every line flat onto `targetY`.
 */
function createNoise(svg, { count, colors, seed }) {
  const r = rng(seed);
  const W = 1600;
  const H = 900;
  const lines = Array.from({ length: count }, (_, i) =>
    ({
      el: svgEl(
        'path',
        {
          fill: 'none',
          stroke: colors[i % colors.length],
          'stroke-width': lineWidth(i),
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
        svg,
      ),
      y: 90 + r() * (H - 180),
      f1: 1 + r() * 2.5,
      f2: 4 + r() * 7,
      phase: r() * Math.PI * 2,
      speed: (0.25 + r() * 0.9) * (i % 2 ? 1 : -1),
      amp: 30 + r() * 80,
    }),
  );
  const state = { level: 0, converge: 0, targetY: H * 0.75 };
  let active = false;
  let time = 0;

  function render(_, deltaMs = 16) {
    if (!active) return;
    if (!reduce) time += deltaMs / 1000;
    const c = state.converge;
    const pull = c * c * (3 - 2 * c);
    for (const line of lines) {
      const amp = line.amp * state.level * (1 - pull);
      const base = line.y + (state.targetY - line.y) * pull;
      let d = '';
      for (let k = 0; k <= 72; k++) {
        const u = k / 72;
        const x = -60 + (W + 120) * u;
        const y =
          base +
          amp *
            (0.7 * Math.sin(u * line.f1 * Math.PI * 2 + line.phase + time * line.speed) +
              0.3 * Math.sin(u * line.f2 * Math.PI * 2 - time * line.speed * 1.8));
        d += `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      line.el.setAttribute('d', d);
    }
  }

  gsap.ticker.add(render);
  return {
    state,
    setActive(on) {
      active = on;
      if (on) render(0, 0);
    },
  };
}

/* ---------- Generated drawings ---------- */

function buildDrawings() {
  // Skyline: flat buildings with a few lit windows.
  const skyline = qs('.n-skyline');
  const sg = svgEl('g', { class: 'in' }, skyline);
  const r = rng(7);
  for (let x = -20; x < 1620; ) {
    const w = 60 + r() * 120;
    const h = 120 + r() * 300;
    svgEl('rect', { x, y: 500 - h, width: w, height: h + 4, fill: '#f04b2b' }, sg);
    for (let wy = 500 - h + 26; wy < 470; wy += 36) {
      for (let wx = x + 14; wx < x + w - 22; wx += 28) {
        if (r() < 0.22) svgEl('rect', { x: wx, y: wy, width: 10, height: 16, rx: 2, fill: '#ff8466' }, sg);
      }
    }
    x += w + 8 + r() * 26;
  }

  drawCrowd(qs('.n-crowd-back'), { width: 2400, seed: 21, color: '#dc4022', size: 0.85 });
  drawCrowd(qs('.n-crowd-front'), { width: 2800, seed: 42, color: '#b52f18', size: 1.35 });

  // "Read." panel: an open mouth from the shared mouth drawing.
  const open = mouthGeometry(SHAPES.open);
  qs('#r-inner').setAttribute('d', open.opening);
  qs('#r-upper').setAttribute('d', open.upper);
  qs('#r-lower').setAttribute('d', open.lower);
}

function drawCrowd(svg, { width, seed, color, size }) {
  const r = rng(seed);
  const g = svgEl('g', { class: 'in' }, svg);
  for (let x = 30; x < width; x += (90 + r() * 70) * size) {
    const w = (44 + r() * 22) * size;
    const h = (86 + r() * 60) * size;
    const head = (24 + r() * 10) * size;
    const top = 300 - h;
    svgEl(
      'path',
      { d: `M${x - w} 302C${x - w} ${top + 20} ${x - w * 0.55} ${top} ${x} ${top}S${x + w} ${top + 20} ${x + w} 302Z`, fill: color },
      g,
    );
    svgEl('circle', { cx: x + (r() - 0.5) * 8, cy: top - head * 0.85, r: head, fill: color }, g);
  }
}

/* ---------- Act 1: noise ---------- */

function actNoise() {
  const chars = splitChars(qs('.n-bubble'));
  const noise = createNoise(qs('.n-noise'), {
    count: reduce ? 8 : 16,
    colors: [C.paper, C.paper, C.ink, C.butter],
    seed: 3,
  });
  noise.state.level = 0.1;

  ScrollTrigger.create({
    trigger: '#noise',
    start: 'top bottom',
    end: 'bottom top',
    onToggle: (self) => noise.setActive(self.isActive),
  });

  // Opening: layers arrive at different speeds.
  if (!reduce) {
    gsap.from('.n-stage .in', {
      y: (i) => [70, 50, 90, 30, 40, 0, 0][i] ?? 40,
      opacity: 0,
      duration: 1.4,
      stagger: 0.09,
      ease: 'power3.out',
      delay: 0.1,
    });
  }

  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '#noise',
      start: 'top top',
      end: 'bottom bottom',
      scrub: reduce ? true : 0.7,
      invalidateOnRefresh: true,
    },
  });



  tl.to('.n-chrome', { autoAlpha: 0, y: -16, duration: 0.06 }, 0.01)
    .fromTo('.n-noise', { opacity: 0.22 }, { opacity: 1, duration: 0.3 }, 0.02)
    .to(noise.state, { level: 1, duration: 0.55 }, 0.04)
    // Depth: far planes crawl, near planes rush past.
    .fromTo('.n-skyline', { yPercent: 0 }, { yPercent: 9, duration: 1 }, 0)
    .fromTo('.n-crowd-back', { xPercent: 0 }, { xPercent: -16, duration: 1 }, 0)
    .fromTo('.n-crowd-front', { xPercent: 0 }, { xPercent: -46, duration: 1 }, 0)
    .to('.n-figure', { scale: 0.9, duration: 0.8 }, 0);

  // The words come apart one letter at a time.
  chars.forEach((ch, i) => {
    const r = rng(100 + i);
    tl.to(
      ch,
      {
        x: (r() - 0.5) * 560,
        y: (r() - 0.5) * 380,
        rotation: reduce ? 0 : (r() - 0.5) * 150,
        opacity: 0,
        duration: 0.26,
        ease: 'power2.in',
      },
      0.3 + i * 0.013,
    );
  });

  tl.to('.n-bubble', { scale: 0.7, opacity: 0, duration: 0.12, ease: 'power2.in' }, 0.6)
    .to(['.n-figure', '.n-crowd-back', '.n-skyline'], { opacity: 0, y: 80, duration: 0.14, stagger: 0.03, ease: 'power1.in' }, 0.78)
    .to('.n-crowd-front', { yPercent: 50, opacity: 0, duration: 0.15 }, 0.8)
    // Transition: the wobbly lines turn to fog and swell until they cover the screen.
    .to('.n-noise path', { stroke: C.fog, duration: 0.1 }, 0.76)
    .fromTo(
      '.n-noise path',
      { attr: { 'stroke-width': lineWidth } },
      { attr: { 'stroke-width': floodWidth }, duration: 0.18, ease: 'power2.in' },
      0.78,
    )
    .to('.n-fade', { opacity: 1, duration: 0.03 }, 0.96);
}

/* ---------- Act 2: silence ---------- */

function actSilence() {
  // Parallax: speed < 1 lags behind the page, > 1 runs ahead.
  gsap.utils.toArray('#silence [data-speed]').forEach((el) => {
    const shift = (1 - parseFloat(el.dataset.speed)) * 0.6;
    gsap.fromTo(
      el,
      { y: () => -shift * innerHeight },
      {
        y: () => shift * innerHeight,
        ease: 'none',
        scrollTrigger: { trigger: '#silence', start: 'top bottom', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
      },
    );
  });

  // An empty speech bubble draws itself: the mouth moves, nothing comes out.
  gsap.fromTo(
    '.s-bubble path',
    { strokeDashoffset: 1 },
    { strokeDashoffset: 0, ease: 'none', scrollTrigger: { trigger: '#silence', start: 'top 70%', end: 'top 5%', scrub: true } },
  );
  gsap.fromTo(
    '.s-line path',
    { strokeDashoffset: 1 },
    { strokeDashoffset: 0, ease: 'none', scrollTrigger: { trigger: '#silence', start: 'top 60%', end: 'center center', scrub: true } },
  );

  const words = splitWords(qs('.s-text'));
  gsap.from(words, {
    yPercent: 110,
    duration: reduce ? 0.01 : 1,
    stagger: 0.07,
    ease: 'power4.out',
    scrollTrigger: { trigger: '.s-text', start: 'top 82%' },
  });
}

/* ---------- Act 3: focus (the peak) ---------- */

function actFocus() {
  const caption = 'Can you hear me now?';
  const text = qs('.f-text');
  const line = qs('.f-line');
  const stage = qs('.f-stage');
  const mouth = createMouth({ animate: !reduce });
  const noise = createNoise(qs('.f-noise'), { count: reduce ? 6 : 14, colors: [C.paper], seed: 11 });
  noise.state.level = 1;
  const lines = qs('.f-noise').querySelectorAll('path');

  // The grey lines drift in over the fog as the act scrolls into view.
  gsap.fromTo(lines, { opacity: 0 }, {
    opacity: 1,
    ease: 'none',
    scrollTrigger: { trigger: '#focus', start: 'top 70%', end: 'top top', scrub: true },
  });

  // The noise lines settle exactly onto the caption line.
  const measure = () => {
    const s = stage.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    noise.state.targetY = ((l.top + l.height / 2 - s.top) / s.height) * 900;
  };
  measure();
  ScrollTrigger.addEventListener('refresh', measure);

  ScrollTrigger.create({
    trigger: '#focus',
    start: 'top bottom',
    end: 'bottom top',
    onToggle: (self) => noise.setActive(self.isActive),
  });

  // Signature move: the scroll position types the caption, and the mouth
  // takes the shape of each letter. Scroll back and it un-says it.
  const typing = { n: 0 };
  let shown = -1;
  let restTimer;
  const renderTyping = () => {
    const n = Math.round(typing.n);
    if (n === shown) return;
    shown = n;
    text.textContent = caption.slice(0, n);
    mouth.setTarget(n > 0 && n < caption.length ? shapeFor(caption[n - 1]) : REST);
    clearTimeout(restTimer);
    restTimer = setTimeout(() => mouth.setTarget(REST), 200);
  };

  gsap
    .timeline({
      defaults: { ease: 'none' },
      scrollTrigger: {
        trigger: '#focus',
        start: 'top top',
        end: 'bottom bottom',
        scrub: reduce ? true : 0.7,
        invalidateOnRefresh: true,
      },
    })
    // Transition: the grey lines swell into ink and take over the screen,
    // then thin back out into the noise the mouth has to read through.
    .fromTo(
      lines,
      { stroke: C.slate, attr: { 'stroke-width': lineWidth } },
      { stroke: C.ink, attr: { 'stroke-width': floodWidth }, duration: 0.09, ease: 'power2.in' },
      0,
    )
    .to('.f-ink', { opacity: 1, duration: 0.04 }, 0.05)
    .to(lines, { attr: { 'stroke-width': lineWidth }, duration: 0.05, ease: 'power2.out' }, 0.095)
    .to(lines, { stroke: C.paper, duration: 0.04 }, 0.125)
    .fromTo('.f-noise', { opacity: 1 }, { opacity: 0.55, duration: 0.04 }, 0.125)
    // The lips ease in: a soft fade, rise and focus pull.
    .fromTo(
      '.f-lens',
      { opacity: 0, scale: 0.94, y: 36, filter: 'blur(14px)' },
      { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', duration: 0.17, ease: 'power2.out' },
      0.13,
    )
    .fromTo(
      '.f-brackets',
      { scale: 1.2, opacity: 0, transformOrigin: '50% 50%' },
      { scale: 1, opacity: 1, duration: 0.12, ease: 'power2.out' },
      0.23,
    )
    .to(noise.state, { converge: 1, duration: 0.24, ease: 'power2.inOut' }, 0.28)
    .fromTo('.f-line', { scaleX: 0.1, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.06 }, 0.49)
    .to('.f-noise', { opacity: 0, duration: 0.05 }, 0.53)
    .to(typing, { n: caption.length, duration: 0.28, onUpdate: renderTyping }, 0.57)
    .fromTo('.f-claim', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.06 }, 0.87)
    .fromTo('.f-wipe', { clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.07, ease: 'power2.in' }, 0.93);
}

/* ---------- Act 4: how (horizontal pan) ---------- */

function actHow() {
  const section = qs('#how');
  const rail = qs('.h-rail');
  const travel = () => Math.max(0, rail.scrollWidth - innerWidth);
  const sizeSection = () => {
    section.style.height = `${travel() * 1.15 + innerHeight}px`;
  };
  sizeSection();
  ScrollTrigger.addEventListener('refreshInit', sizeSection);

  const pan = gsap.to(rail, {
    x: () => -travel(),
    ease: 'none',
    scrollTrigger: {
      trigger: section,
      start: 'top top',
      end: 'bottom bottom',
      scrub: reduce ? true : 0.6,
      invalidateOnRefresh: true,
    },
  });

  // Inside each panel the word and the drawing travel at different speeds.
  gsap.utils.toArray('.h-panel').forEach((panel) => {
    const along = { trigger: panel, containerAnimation: pan, start: 'left right', end: 'right left', scrub: true };
    const shift = () => Math.min(180, innerWidth * 0.1);
    gsap.fromTo(
      qs('.h-word', panel),
      { x: () => shift() },
      { x: () => -shift(), ease: 'none', scrollTrigger: { ...along, invalidateOnRefresh: true } },
    );
    gsap.fromTo(
      qs('.h-art svg', panel),
      { x: () => -shift() * 0.3, rotation: reduce ? 0 : -4 },
      { x: () => shift() * 0.3, rotation: reduce ? 0 : 4, ease: 'none', scrollTrigger: { ...along, invalidateOnRefresh: true } },
    );
  });

  gsap.fromTo(
    '.h-waves path',
    { opacity: 0.15, scale: 0.85, transformOrigin: '0% 50%' },
    {
      opacity: 1,
      scale: 1,
      stagger: 0.15,
      ease: 'none',
      scrollTrigger: { trigger: qs('.h-art--vermilion'), containerAnimation: pan, start: 'left 90%', end: 'center 50%', scrub: true },
    },
  );
}

/* ---------- Act 5: close ---------- */

function actClose() {
  const enter = { trigger: '#start', start: 'top 65%' };
  gsap.from('.c-mark .q1', { x: -60, rotation: -24, opacity: 0, duration: 1.1, ease: 'power3.out', scrollTrigger: enter });
  gsap.from('.c-mark .q2', { x: 60, rotation: 24, opacity: 0, duration: 1.1, delay: 0.08, ease: 'power3.out', scrollTrigger: enter });
  gsap.from(['.c-title', '.c-actions'], {
    y: 40,
    opacity: 0,
    duration: 1,
    stagger: 0.12,
    delay: 0.15,
    ease: 'power3.out',
    scrollTrigger: enter,
  });

  // Magnetic primary button, only for a real mouse.
  if (reduce || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  for (const button of document.querySelectorAll('[data-magnet]')) {
    const toX = gsap.quickTo(button, 'x', { duration: 0.4, ease: 'power3.out' });
    const toY = gsap.quickTo(button, 'y', { duration: 0.4, ease: 'power3.out' });
    button.addEventListener('pointermove', (event) => {
      const box = button.getBoundingClientRect();
      toX((event.clientX - box.left - box.width / 2) * 0.3);
      toY((event.clientY - box.top - box.height / 2) * 0.3);
    });
    button.addEventListener('pointerleave', () => {
      toX(0);
      toY(0);
    });
  }
}
