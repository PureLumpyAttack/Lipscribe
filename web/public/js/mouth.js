// The illustrated mouth used on the story page.
// One connected shape: the upper lip, lower lip, opening and teeth all share
// the same corners, so it opens like a real mouth instead of splitting apart.
//
// Coordinates are for a 960×540 drawing with the mouth centred at (480, 281).

// w: half-width at the corners, u: how far the upper lip lifts, d: how far the lower lip drops.
export const REST = { w: 184, u: 1.5, d: 3 };
export const SHAPES = {
  open: { w: 176, u: 12, d: 36 }, // a, e, i, h
  round: { w: 138, u: 9, d: 26 }, // o, u, w
  closed: { w: 186, u: 0, d: 0 }, // m, b, p
  bite: { w: 180, u: 5, d: 7 }, // f, v
  mid: { w: 180, u: 6, d: 16 }, // other consonants
};

export function shapeFor(char = '') {
  const c = char.toLowerCase();
  if (!c) return REST;
  if ('aeih'.includes(c)) return SHAPES.open;
  if ('ouwq'.includes(c)) return SHAPES.round;
  if ('mbp'.includes(c)) return SHAPES.closed;
  if ('fv'.includes(c)) return SHAPES.bite;
  if (/[a-z]/.test(c)) return SHAPES.mid;
  return REST;
}

/** Path data and teeth/shine geometry for one mouth shape. */
export function mouthGeometry({ w, u, d }) {
  const cx = 480;
  const cy = 281;
  const k = w / 184;
  const lift = u * 0.5;
  const X = (dx) => (cx + dx * k).toFixed(1);
  const Y = (dy) => (cy + dy).toFixed(1);
  const U = (dy) => Y(dy - lift);
  const B = 91 + d * 0.85; // depth of the lower lip

  const upperInner = `C${X(92)} ${Y(-u)} ${X(-92)} ${Y(-u)} ${X(-184)} ${Y(0)}`;
  const lowerInner = `C${X(-101)} ${Y(d)} ${X(101)} ${Y(d)} ${X(184)} ${Y(0)}`;
  const top = cy - 0.75 * u;

  return {
    upper:
      `M${X(-184)} ${Y(0)}` +
      `C${X(-136)} ${U(-52)} ${X(-84)} ${U(-81)} ${X(-44)} ${U(-77)}` +
      `C${X(-26)} ${U(-75)} ${X(-12)} ${U(-66)} ${X(0)} ${U(-55)}` +
      `C${X(12)} ${U(-66)} ${X(26)} ${U(-75)} ${X(44)} ${U(-77)}` +
      `C${X(84)} ${U(-81)} ${X(136)} ${U(-52)} ${X(184)} ${Y(0)}` +
      `${upperInner}Z`,
    lower:
      `M${X(-184)} ${Y(0)}${lowerInner}` +
      `C${X(144)} ${Y(B * 0.69)} ${X(76)} ${Y(B)} ${X(0)} ${Y(B)}` +
      `S${X(-144)} ${Y(B * 0.69)} ${X(-184)} ${Y(0)}Z`,
    opening:
      `M${X(-184)} ${Y(0)}C${X(-92)} ${Y(-u)} ${X(92)} ${Y(-u)} ${X(184)} ${Y(0)}` +
      `C${X(101)} ${Y(d)} ${X(-101)} ${Y(d)} ${X(-184)} ${Y(0)}Z`,
    teeth: {
      cy: top - 2,
      rx: 118 * k,
      ry: 4 + 0.75 * (u + d) * 0.4,
      // Hidden while the lips are together, so no white line shows between them.
      opacity: Math.min(1, Math.max(0, (u + d - 8) / 12)),
    },
    shine: { cy: cy + B * 0.55, rx: 72 * k },
  };
}

/**
 * Animates a mouth drawn with these element ids:
 * m-inner, m-clip, m-teeth, m-upper, m-lower, and optionally m-shine.
 * Call setTarget(shape) and it eases there on its own.
 */
export function createMouth({ animate = true } = {}) {
  const el = {
    inner: document.getElementById('m-inner'),
    clip: document.getElementById('m-clip'),
    teeth: document.getElementById('m-teeth'),
    upper: document.getElementById('m-upper'),
    lower: document.getElementById('m-lower'),
    shine: document.getElementById('m-shine'),
  };
  const current = { ...REST };
  let target = REST;

  function draw(shape) {
    const g = mouthGeometry(shape);
    el.upper.setAttribute('d', g.upper);
    el.lower.setAttribute('d', g.lower);
    el.inner.setAttribute('d', g.opening);
    el.clip.setAttribute('d', g.opening);
    el.teeth.setAttribute('cy', g.teeth.cy.toFixed(1));
    el.teeth.setAttribute('rx', g.teeth.rx.toFixed(1));
    el.teeth.setAttribute('ry', g.teeth.ry.toFixed(1));
    el.teeth.setAttribute('opacity', g.teeth.opacity.toFixed(2));
    el.shine?.setAttribute('cy', g.shine.cy.toFixed(1));
    el.shine?.setAttribute('rx', g.shine.rx.toFixed(1));
  }

  function tick() {
    let moving = false;
    for (const key of ['w', 'u', 'd']) {
      const delta = target[key] - current[key];
      if (Math.abs(delta) > 0.05) moving = true;
      current[key] += delta * 0.32;
    }
    if (moving) draw(current);
    requestAnimationFrame(tick);
  }

  draw(REST);
  if (animate) requestAnimationFrame(tick);

  return {
    setTarget(shape) {
      target = shape;
      if (!animate) draw(shape);
    },
  };
}
