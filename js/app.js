/* app.js — the spine: renderer, scene, camera, the single rAF, and resize.

   Everything else is a module this file wires together. There is exactly
   one animation loop and one resize path in the whole app; if you find
   yourself adding a second rAF, the thing you are building wants to be a
   function called from this one instead. */

import * as THREE from 'three';
import { createGlobe, paintStars, CAMERA_FOV } from './globe.js';
import { createGovernor } from './quality.js';
import { loadAtlas, createAtlasLines, buildLandMask } from './atlas.js';
import { sunDirection, subsolarPoint, createClock } from './sun.js';
import { loadNightLights } from './lights.js';
import { loadEarthTextures } from './textures.js';
import { loadCams } from './data.js';
import { createPins } from './pins.js';
import { createPicker } from './pick.js';
import { createMonitor } from './monitor.js';
import { mountNewsRail } from './news.js';
import { solarState, localTime } from './sun.js';

export function start() {
  const flags = window.PLANET_FLAGS;
  let quality = flags.quality;

  const canvas = document.getElementById('scene');
  const starCanvas = document.getElementById('stars');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,          // the title reads through everywhere the globe isn't
    powerPreference: 'high-performance',
  });
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  camera.position.set(0, 0, 5.6);

  const globe = createGlobe({ scene, camera, canvas, quality });
  const governor = createGovernor(quality);

  /* Declared up here because resize() runs before the cameras load and
     already has to ask whether the pin field exists yet. */
  let pins = null;
  let picker = null;
  let playing = false;
  const monitor = createMonitor({
    onClose() {
      globe.setSpin(1);
      if (pins) pins.setHovered(-1);
      if (picker) picker.clear();
    },
    /* A live decode can take a third of a core. Dropping resolution while
       one plays is a performance fix wearing a design beat: the planet
       quietens down while you watch something on it.

       The drop goes through resize(), never setPixelRatio directly: the
       particle and pin size uniforms are derived from the drawing-buffer
       height inside resize(), and poking the ratio alone left them stale —
       the audit measured every marker and land point swelling 33% the
       moment a video started. Folding the factor into resize() also means
       a window resize mid-playback keeps the reduction instead of
       silently undoing it. */
    onPlay() { playing = true; resize(); },
    onStop() { playing = false; resize(); },
  });

  /* ---- sizing ------------------------------------------------------ */
  function resize() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality.dpr) * (playing ? 0.75 : 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    globe.setViewportHeight(renderer.domElement.height);
    if (pins) pins.setPixelScale(renderer.domElement.height);
    paintStars(starCanvas, quality.stars);
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  /* ---- context loss ------------------------------------------------
     Without preventDefault the restore event never fires and the page is
     dead until reload. */
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[planet] webgl context lost');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('[planet] webgl context restored');
    resize();
  });

  /* ---- the loop ---------------------------------------------------- */
  let raf = 0;
  let last = performance.now();
  let firstFrame = true;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(64, now - last);
    last = now;

    applySun();
    globe.update(dt);
    if (pins) pins.update(dt, now / 1000);

    /* The globe keeps turning under a stationary pointer, so both the hit
       test and the leader line have to be re-evaluated every frame rather
       than only on pointermove. */
    if (picker) {
      picker.refresh();
      if (monitor.isOpen && picker.index >= 0) {
        const p = picker.screenOf(picker.index, canvas.clientWidth, canvas.clientHeight);
        monitor.anchorTo(p.x, p.y, p.visible);
      } else if (monitor.isOpen) {
        /* Open with nothing hovered: without this the leader line froze
           at its last coordinates, pointing at empty space while the
           planet turned underneath. */
        monitor.anchorTo(0, 0, false);
      }
    }

    renderer.render(scene, camera);

    const demoted = governor.sample(dt, now);
    if (demoted) {
      quality = demoted;
      globe.setQuality(quality);
      resize();
      console.info('[planet] demoted to tier', quality.name);
    }

    if (firstFrame) {
      firstFrame = false;
      dispatchEvent(new Event('planet:ready'));
    }
  }
  raf = requestAnimationFrame(frame);

  /* ---- the sun ------------------------------------------------------
     Recomputed every frame rather than on a 60s timer with interpolation
     between samples: the whole calculation is a handful of trig calls, so
     the timer would only add state and a chance to pop. */
  const clock = createClock(flags.utc);
  const sunVec = [0, 0, 0];
  function applySun() {
    sunDirection(clock.now(), sunVec);
    globe.setSun(sunVec[0], sunVec[1], sunVec[2]);
    if (pins) pins.setSun(sunVec[0], sunVec[1], sunVec[2]);
  }
  applySun();

  /* ---- the world map ------------------------------------------------
     Loaded after the first frame is already on screen: the globe spins
     immediately and the coastlines arrive a beat later, rather than the
     page holding on a blank canvas until 108 KB of TopoJSON lands. */
  let mask = null;
  let lights = null;

  /* The land field is built from the mask alone, then rebuilt once the
     night-lights raster arrives. The two loads are deliberately NOT joined:
     gating the world's geography on a decorative 715 KB image means a slow
     or undecodable image costs you the planet, not just its city lights.
     (It also hangs outright in a background tab, where decoding is
     deferred.) */
  function buildLand() {
    if (!mask) return;
    const land = globe.setLand(mask, quality.particles, lights);
    globe.setViewportHeight(renderer.domElement.height);
    window.PLANET.land = land;
  }

  loadAtlas({ url: `./data/countries-${flags.borders}.json` })
    .then((atlas) => {
      const lines = createAtlasLines(atlas);
      globe.group.add(lines.group);

      mask = buildLandMask(atlas.topology, quality.mask);
      globe.setLandMask(mask.canvas);
      buildLand();
      applySun();

      window.PLANET.atlas = atlas;
      window.PLANET.lines = lines;
      window.PLANET.mask = mask;
      dispatchEvent(new Event('planet:atlas'));
    })
    .catch((err) => console.error('[planet] atlas failed:', err));

  loadNightLights()
    .then((l) => {
      lights = l;
      window.PLANET.lights = l;
      buildLand();
      dispatchEvent(new Event('planet:lights'));
    })
    .catch((err) => console.warn('[planet] night lights unavailable:', err.message));

  /* ---- the cameras --------------------------------------------------
     Loaded in parallel with the atlas; neither waits on the other. */
  loadCams()
    .then((data) => {
      pins = createPins({ cams: data.cams, camera });
      pins.setPixelScale(renderer.domElement.height);
      pins.setSun(sunVec[0], sunVec[1], sunVec[2]);
      globe.group.add(pins.group);

      picker = createPicker({
        canvas, camera, globe, pins,
        onHover(index) {
          const cam = data.cams[index];
          pins.setHovered(index);
          monitor.show(cam, solarState(cam.lat, cam.lon, clock.now()),
            localTime(cam, clock.now()).text);
          /* The machine settles while you look at something. */
          globe.setSpin(0);
        },
        onLeave() {
          pins.setHovered(-1);
          monitor.hide();
          globe.setSpin(1);
        },
        onSelect(index) {
          const cam = data.cams[index];
          if (!cam) return;
          /* On touch there is no hover, so a tap IS the hover: it opens the
             panel and nothing else. Navigating away on first tap would be
             the worst bug in the app — you would never get to see anything
             before being thrown to YouTube. The panel's own button carries
             the second, deliberate tap. */
          if (matchMedia('(pointer: coarse)').matches) {
            monitor.show(cam, solarState(cam.lat, cam.lon, clock.now()),
              localTime(cam, clock.now()).text);
            return;
          }
          window.open(cam.url, '_blank', 'noopener');
        },
      });

      /* HUD: the count is read from the data, never hardcoded, and the
         file's age is surfaced rather than hidden — a stale list means the
         streams may have rotted, and the reader should be able to see that
         instead of wondering why a camera is black. */
      const countEl = document.getElementById('hud-count');
      const whereEl = document.getElementById('hud-where');
      const utcEl = document.getElementById('hud-utc');
      const countries = new Set(data.cams.map((c) => c.country)).size;
      const stale = data.ageDays != null && data.ageDays > 45;
      countEl.textContent = String(data.cams.length);
      whereEl.innerHTML = `live cameras in ${countries} countries`
        + (stale ? ` &middot; <span class="stale">list ${data.ageDays}d old</span>` : '');

      const tick = () => {
        const d = clock.now();
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        utcEl.textContent = `${hh}:${mm}:${ss} UTC`;
        const cam = monitor.current;
        if (cam) monitor.setClock(localTime(cam, d).text);
      };
      tick();
      setInterval(tick, 1000);

      window.PLANET.data = data;
      window.PLANET.pins = pins;
      window.PLANET.picker = picker;
      dispatchEvent(new CustomEvent('planet:cams', { detail: { count: data.cams.length } }));
    })
    .catch((err) => console.error('[planet] cams failed:', err));

  /* ?check=1 — assert the geographic invariants once everything has
     loaded. Kept out of the default path so it costs nothing normally. */
  if (flags.check) {
    let ready = 0;
    const maybeRun = () => {
      ready += 1;
      if (ready < 2) return;
      import('./selftest.js').then((m) => { window.PLANET.selftest = m.runSelfTest(window.PLANET); });
    };
    addEventListener('planet:atlas', maybeRun, { once: true });
    addEventListener('planet:cams', maybeRun, { once: true });
  }

  /* The photographs load progressively and independently — the flat
     cartographic look upgrades to satellite imagery as each file lands,
     and a failed download costs realism, never the planet. */
  loadEarthTextures({
    dayMax: quality.mask >= 2048 ? 4096 : 2048,
    onDay: (t) => globe.setDayMap(t),
    onNight: (t) => globe.setNightMap(t),
    onClouds: (t) => globe.setClouds(t),
  });

  /* Independent of everything else: the rail is a courtesy panel and must
     never delay or break the globe. */
  mountNewsRail()
    .then((rail) => { window.PLANET.news = rail; })
    .catch((err) => console.warn('[planet] news rail failed:', err.message));

  if (flags.stats) {
    setInterval(() => {
      const i = renderer.info;
      console.info('[planet] draws=%d tris=%d tier=%s',
        i.render.calls, i.render.triangles, quality.name);
    }, 2000);
  }

  /* Exposed for the browser-side verification probes — reading pixels beats
     looking at a screenshot when the pane cannot composite a GL canvas. */
  window.PLANET = {
    renderer, scene, camera, globe, clock,
    get quality() { return quality; },
    get subsolar() { return subsolarPoint(clock.now()); },
  };

  return {
    stop() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      globe.dispose();
      renderer.dispose();
    },
  };
}
