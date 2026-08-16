/* pick.js — which camera is under the pointer.

   Screen-space projection, not a raycaster. Every pointermove projects the
   pin positions and takes the nearest within a pixel threshold. That wins
   three ways:

     - the hit radius is a tunable number of PIXELS, not a world-space
       threshold that changes meaning as you zoom
     - "nearest wins" is deterministic where pins overlap. Europe carries
       ~90 cameras; with a raycaster, overlapping hits resolve by z-order
       lottery and the same gesture picks a different camera each time
     - it produces the screen coordinate the leader line needs anyway, so
       there is no second projection pass

   Cost is one vec3 transform per camera per pointermove — a few hundred
   multiplies, far below a frame budget. */

import * as THREE from 'three';

const FINE_RADIUS = 18;     // mouse / trackpad
const COARSE_RADIUS = 26;   // touch
/* Hysteresis: a held pin is released at a wider radius than it was
   acquired at, so a marker sitting exactly on the boundary cannot flicker
   between held and dropped. */
const RELEASE_FACTOR = 2.2;
/* A different pin must be decisively closer before the hover moves to it.
   Cameras cluster hard: five Tokyo cameras land within 0.7px of each other
   at normal zoom, and Europe carries dozens more like that. Without a
   margin, a single pixel of hand-tremor swaps which one is "nearest" — the
   panel then re-opens on a different camera several times a second and the
   player is destroyed and remounted before it can ever finish loading. */
const SWITCH_MARGIN_PX = 8;
/* A pin exactly on the limb has an ambiguous screen position and is half
   behind the planet; requiring a small positive facing keeps the pick from
   grabbing something the user cannot really see. */
const MIN_FACING = 0.06;

export function createPicker({ canvas, camera, globe, pins, onHover, onLeave, onSelect }) {
  const v = new THREE.Vector3();
  const cameraPos = new THREE.Vector3();
  let pointer = null;
  let lastIndex = -1;
  let downAt = null;

  const radius = () => (matchMedia('(pointer: coarse)').matches ? COARSE_RADIUS : FINE_RADIUS);

  function projectAll(width, height) {
    if (!pins) return { index: -1, x: 0, y: 0 };
    cameraPos.copy(camera.position);
    const matrix = globe.group.matrixWorld;
    const pos = pins.positions;
    let best = -1;
    let bestDist = radius() * radius();
    let bx = 0;
    let by = 0;

    for (let i = 0; i < pins.count; i += 1) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(matrix);

      /* Unit sphere: the position IS the outward normal, so facing is a
         single dot product with no normal buffer to maintain. */
      const dx = cameraPos.x - v.x;
      const dy = cameraPos.y - v.y;
      const dz = cameraPos.z - v.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      if ((v.x * dx + v.y * dy + v.z * dz) / len <= MIN_FACING) continue;

      v.project(camera);
      const sx = (v.x * 0.5 + 0.5) * width;
      const sy = (-v.y * 0.5 + 0.5) * height;
      const d = (sx - pointer.x) ** 2 + (sy - pointer.y) ** 2;
      if (d < bestDist) { bestDist = d; best = i; bx = sx; by = sy; }
    }
    return { index: best, x: bx, y: by };
  }

  /* Screen position of one pin, for keeping the leader line attached as
     the globe turns under it. */
  function screenOf(index, width, height) {
    const pos = pins.positions;
    v.set(pos[index * 3], pos[index * 3 + 1], pos[index * 3 + 2])
      .applyMatrix4(globe.group.matrixWorld);
    const dx = camera.position.x - v.x;
    const dy = camera.position.y - v.y;
    const dz = camera.position.z - v.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const facing = (v.x * dx + v.y * dy + v.z * dz) / len;
    v.project(camera);
    return {
      x: (v.x * 0.5 + 0.5) * width,
      y: (-v.y * 0.5 + 0.5) * height,
      visible: facing > MIN_FACING,
    };
  }

  const onMove = (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    /* Dragging is navigation, not inspection. */
    if (globe.state.dragging) return;
    evaluate(true);
  };

  /* `fromMove` is the whole fix for a nasty feedback loop.

     Hovering a pin makes the camera pan aside so the panel does not cover
     it. That pan moves the pin roughly a hundred pixels across the screen.
     Re-running the hit test on camera motion therefore revoked the very
     hover that caused the motion, which reset the pan, which put the pin
     back under the pointer, which re-acquired it — the globe shook side to
     side and the player was killed and remounted before it could ever
     load. Measured at 27 hover flips in 50 frames.

     So: once a pin is held, only real pointer movement may change it.
     Frame-driven re-tests still run when nothing is held, which is what
     lets a spinning globe bring a new pin under a stationary pointer. */
  function evaluate(fromMove = false) {
    if (!pointer || !pins) return;
    if (!fromMove && lastIndex >= 0) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const hit = projectAll(w, h);

    /* Nothing new under the pointer, but the held pin is still nearby:
       keep it rather than dropping into empty space. */
    if (hit.index < 0 && lastIndex >= 0) {
      const held = screenOf(lastIndex, w, h);
      const r = radius() * RELEASE_FACTOR;
      if (held.visible && Math.hypot(held.x - pointer.x, held.y - pointer.y) < r) return;
    }

    /* A rival pin is nearest, but only barely. Keep what is held unless the
       newcomer is decisively closer — otherwise coincident markers trade
       the hover back and forth on hand-tremor alone. */
    if (hit.index >= 0 && lastIndex >= 0 && hit.index !== lastIndex) {
      const held = screenOf(lastIndex, w, h);
      if (held.visible) {
        const heldDist = Math.hypot(held.x - pointer.x, held.y - pointer.y);
        const newDist = Math.hypot(hit.x - pointer.x, hit.y - pointer.y);
        if (newDist > heldDist - SWITCH_MARGIN_PX) return;
      }
    }

    if (hit.index === lastIndex) return;
    lastIndex = hit.index;
    if (hit.index >= 0) onHover(hit.index, hit.x, hit.y);
    else onLeave();
  }

  const onDown = (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; };

  const onUp = (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const held = performance.now() - downAt.t;
    downAt = null;
    /* A click is a click; a drag that happens to end over a pin is not. */
    if (moved > 6 || held > 400) return;
    if (lastIndex >= 0 && onSelect) onSelect(lastIndex);
  };

  const onOut = (e) => {
    /* The panel opens over the cursor by design (it is the click target),
       and the canvas fires pointerleave the moment it does. Treating that
       as a real leave wiped the hover, cancelled the pending player, and
       — because the panel's own pointerenter then cancelled the closing
       grace — latched an open, empty, permanently dead panel. The audit
       measured 30% of visible pins inside the panel rectangle. A leave
       whose destination is the panel keeps the hover alive. */
    if (e && e.relatedTarget) {
      const mon = document.getElementById('monitor');
      if (mon && mon.contains(e.relatedTarget)) return;
    }
    pointer = null;
    lastIndex = -1;
    onLeave();
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onOut);

  return {
    /* Re-run the hit test without pointer movement — the globe spins, so
       a stationary pointer still changes what it is over. */
    refresh: () => evaluate(false),
    /* Reset without firing onLeave — for when the panel is already
       closing and the callbacks would loop. */
    clear() { lastIndex = -1; },
    screenOf,
    get index() { return lastIndex; },
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onOut);
    },
  };
}
