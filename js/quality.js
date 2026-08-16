/* quality.js — the tier table, boot-time detection, and the demote-only
   runtime governor.

   TIERS holds every knob the render path reads (app.js fans the object out
   to the renderer, the globe, and later the pin field). `floor` is NOT a
   render tier — it means "no WebGL2", and boot.js routes it to the flat
   grid in fallback.js instead of importing the app at all.

   Detection here is deliberately dependency-free: omr races a detect-gpu
   CDN import against a timeout, but this page's budget is smaller and a
   coarse heuristic picks the same tier often enough that the extra network
   dependency is not worth its failure mode. ?tier= always wins. */

export const TIERS = {
  base: {
    name: 'base',
    dpr: 1.25,
    segments: [64, 48],   // globe sphere widthSegments, heightSegments
    particles: 60000,     // land points (U3)
    mask: 1024,           // land-mask raster width (height is half)
    stars: 260,
  },
  mid: {
    name: 'mid',
    dpr: 1.5,
    segments: [96, 64],
    particles: 130000,
    mask: 2048,
    stars: 420,
  },
  high: {
    name: 'high',
    dpr: 2,
    segments: [96, 64],
    particles: 200000,
    mask: 2048,
    stars: 620,
  },
};

/* Not a render tier: no WebGL2 → boot.js imports fallback.js. */
export const FLOOR = { name: 'floor' };

const ORDER = ['base', 'mid', 'high'];
const OVERRIDES = { base: 'base', mid: 'mid', high: 'high', 1: 'base', 2: 'mid', 3: 'high' };

/* Feature-detect, never UA-sniff: three r170 requires WebGL2. */
export function webgl2Available() {
  try {
    if (typeof WebGL2RenderingContext === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch (err) {
    return false;
  }
}

/* Coarse but honest: a phone gets base, a thin laptop mid, a real GPU high.
   deviceMemory and hardwareConcurrency are absent on some browsers, so both
   default to the middle of the road rather than to the optimistic end. */
export function detectTier(override) {
  if (!webgl2Available()) return FLOOR;

  const forced = override != null && OVERRIDES[String(override).toLowerCase()];
  if (forced) return TIERS[forced];

  const coarse = matchMedia('(pointer: coarse)').matches;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;

  if (coarse || mem <= 2 || cores <= 2) return TIERS.base;
  if (mem <= 4 || cores <= 4) return TIERS.mid;
  return TIERS.high;
}

/* Demote-only governor. A sustained fps deficit drops ONE ladder step and
   never climbs back — a step down is for the session. Pure over supplied
   timestamps so it can be traced without a renderer. */
export function createGovernor(tier, { minFps = 34, window = 90, cooldownMs = 4000 } = {}) {
  let current = tier.name;
  let frames = 0;
  let elapsed = 0;
  let lastChange = -Infinity;

  return {
    get tier() { return TIERS[current] || tier; },
    /* Returns the new tier when it demotes, else null. */
    sample(dtMs, nowMs) {
      if (current === ORDER[0]) return null;
      frames += 1;
      elapsed += dtMs;
      if (frames < window) return null;

      const fps = 1000 / (elapsed / frames);
      frames = 0;
      elapsed = 0;
      if (fps >= minFps) return null;
      if (nowMs - lastChange < cooldownMs) return null;

      const next = ORDER[Math.max(0, ORDER.indexOf(current) - 1)];
      if (next === current) return null;
      current = next;
      lastChange = nowMs;
      return TIERS[current];
    },
  };
}
