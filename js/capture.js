/* capture.js — record the site, deterministically.

   Screen recording was never an option: the browser pane does not
   composite, so requestAnimationFrame never fires and a recorder would
   capture a frozen canvas.

   MediaRecorder was the obvious route and it is the wrong one: it stamps
   frames by WALL CLOCK, so a loop that renders slower than real time
   produces a plate at the wrong speed, and its encoder silently dropped
   113 of 150 frames when the pane was not compositing.

   So this writes a FRAME SEQUENCE instead. Every frame is rendered, read
   back, and posted as its own JPEG; ffmpeg assembles them at exactly 30fps
   afterwards. Nothing can be dropped, and the render may take as long as it
   likes without affecting a single output frame.

   Each frame is the site's real z-stack:
       stars → title → globe (GL readback) → leader → chrome → monitor
   with the monitor's picture left as a dark plate. ffmpeg composites the
   actual camera footage into ui.screenRect() afterwards, because that
   picture is a cross-origin iframe on the live page and nothing running
   inside the page can read it back.

   Load from the console; never from index.html:
     const c = await import('./js/capture.js'); await c.recordShots();

   Frames land in reel/frames/ via serve.py's POST endpoint. */

import * as THREE from 'three';
import { latLonToVec3, projectToScreen, yawForLon } from './geo.js';
import { paintStars } from './globe.js';
import { solarState, localTime } from './sun.js';
import { drawChrome, loadCharts } from './ui.js';

const FPS = 30;

/* Render above delivery resolution and let ffmpeg downsample. The globe's
   limb, the coastlines and the pin rings all alias badly at 1:1, and a
   2560-wide buffer resolved down to 1920 is the cheapest real anti-alias
   available here. */
const CAPTURE_W = 2560;
const CAPTURE_H = 1440;

/* Resizing the renderer by hand is not enough.

   app.js derives the particle-size and pin-size uniforms from the drawing
   buffer height inside its own resize(), and that function reads the CSS
   box — which is the pane's size, not the capture's. Calling setSize alone
   leaves both uniforms stale, so land points and pins render at the scale
   of a much smaller viewport. The starfield is a plain 2D canvas and is
   cleared by any resize, so it has to be repainted too. */
export function setupCapture(width = CAPTURE_W, height = CAPTURE_H) {
  const P = window.PLANET;
  if (!P) throw new Error('PLANET not ready');

  P.renderer.setPixelRatio(1);
  P.renderer.setSize(width, height, false);
  P.camera.aspect = width / height;
  P.camera.updateProjectionMatrix();

  const buf = P.renderer.domElement.height;
  P.globe.setViewportHeight(buf);
  if (P.pins) P.pins.setPixelScale(buf);

  const starCanvas = document.getElementById('stars');
  if (starCanvas) {
    starCanvas.width = width;
    starCanvas.height = height;
    paintStars(starCanvas, P.quality.stars);
  }

  const gl = P.renderer.getContext();
  return `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
}

/* Ease-in-out on a normalised t. Every move uses it, so the camera never
   starts or stops abruptly — the single biggest tell between a designed
   move and a scripted one. */
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));

/* A ramp that is 0 before `a`, 1 after `b`, eased between. Used for every
   element that fades in or out inside a shot. */
const ramp = (t, a, b) => ease(clamp01((t - a) / (b - a || 1)));

/* Shortest-path interpolation, so a move from 170° to -170° crosses the
   date line rather than travelling the long way around the planet. */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* Longitude → yaw, matching geo.yawForLon. */
const Y = (lon) => yawForLon(lon);
/* Latitude → the pitch that centres it.

   Solved numerically against the real projection rather than guessed: the
   answer is simply pitch = latitude in radians, landing every target
   within 0.8px of frame centre. An earlier guess of -lat*0.62 was wrong in
   both sign and magnitude, which framed southern Africa for a shot that
   was supposed to push into Sicily. */
const PT = (lat) => lat * Math.PI / 180;

export async function recordShot(shot, ctxState, onProgress, run = null) {
  const P = window.PLANET;
  const gl = P.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;

  /* Composite into a 2D canvas so the plate carries the starfield behind
     the planet — the WebGL canvas itself is transparent by design. */
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { alpha: false });

  const stars = document.getElementById('stars');
  const flip = document.createElement('canvas');
  flip.width = w;
  flip.height = h;
  const fctx = flip.getContext('2d');
  const raw = new Uint8Array(w * h * 4);

  const total = Math.round(shot.seconds * FPS);
  const s = P.globe.state;
  const { from, to, drift = 0.04, cam = null } = shot;
  const now = P.clock.now();
  const scale = w / 1920;

  /* Everything the monitor shows is the same value the live panel would
     show for this camera at this instant. */
  const camView = cam ? {
    ...cam,
    localText: localTime(cam, now).text,
    lightText: solarState(cam.lat, cam.lon, now),
  } : null;

  const pinVec = cam ? new THREE.Vector3(...latLonToVec3(cam.lat, cam.lon, 1.016)) : null;
  const proj = { x: 0, y: 0, depth: 0, facing: 0 };
  let bytes = 0;

  for (let i = 0; i < total; i += 1) {
    const t = total === 1 ? 1 : i / (total - 1);
    const e = ease(t);

    /* The camera is set absolutely each frame rather than integrated, so
       the path is identical no matter how long the render takes. */
    s.yaw = lerpAngle(from.yaw, to.yaw, e) + drift * t;
    s.pitch = lerp(from.pitch, to.pitch, e);
    s.dist = lerp(from.dist, to.dist, e);
    s.targetDist = s.dist;
    s.targetSpin = 0;
    s.spinScale = 0;

    P.globe.group.rotation.set(s.pitch, s.yaw, 0);
    P.camera.position.set(0, 0, s.dist);
    P.globe.group.updateMatrixWorld(true);
    /* Keep the pin pulse and cloud drift alive at a true 1/fps step. */
    if (P.pins) P.pins.update(1000 / FPS, i / FPS);
    P.renderer.render(P.scene, P.camera);

    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    fctx.putImageData(new ImageData(new Uint8ClampedArray(raw.buffer), w, h), 0, 0);

    ctx.fillStyle = '#070b12';
    ctx.fillRect(0, 0, w, h);
    if (stars) ctx.drawImage(stars, 0, 0, w, h);
    ctx.save();
    ctx.translate(0, h);
    ctx.scale(1, -1);            // WebGL origin is bottom-left
    ctx.drawImage(flip, 0, 0);
    ctx.restore();

    /* Where the pin has landed on screen this frame — the leader line has
       to be redrawn every frame because the globe is turning under it. */
    let pin = null;
    if (pinVec) {
      const v = pinVec.clone().applyMatrix4(P.globe.group.matrixWorld);
      projectToScreen(v, P.camera, w, h, proj);
      if (proj.facing > 0.06) pin = { x: proj.x, y: proj.y };
    }

    const secs = i / FPS;
    drawChrome(ctx, w, {
      titleAlpha: shot.titleAlpha ? shot.titleAlpha(t) : 1,
      uiAlpha: shot.uiAlpha ? shot.uiAlpha(t) : 1,
      monitorAlpha: shot.monAlpha ? shot.monAlpha(t) : (cam ? 1 : 0),
      monitorSlide: shot.monAlpha ? 1 - shot.monAlpha(t) : 0,
      cam: camView,
      clockText: ctxState.clockText(secs),
      count: ctxState.count,
      where: ctxState.where,
      charts: ctxState.charts,
      railAlpha: shot.railAlpha ? shot.railAlpha(t) : null,
      drift: ctxState.driftBase + secs * 1.1,
      pin,
      ring: 9 + Math.sin(secs * 3.1) * 1.4,
      pulse: 0.55 + 0.45 * Math.abs(Math.cos(secs * Math.PI / 1.2)),
      lines: shot.lines || [],
      eyebrow: shot.eyebrow || '',
      textAlpha: shot.textAlpha ? shot.textAlpha(t) : 0,
      zoomAlpha: shot.zoomAlpha ? shot.zoomAlpha(t) : 0,
      zoomIndex: shot.zoomIndex || 0,
    });
    void scale;

    /* JPEG at 0.94 — visually indistinguishable from PNG on photographic
       content at a fraction of the bytes, and these are intermediates that
       get re-encoded anyway. */
    const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.94));
    const idx = String(i).padStart(4, '0');
    await fetch(`/_shot/frames/${shot.name}-${idx}.jpg`, { method: 'POST', body: blob });
    bytes += blob.size;
    if (onProgress) onProgress(shot.name, i + 1, total);
    if (run && run.aborted) return `${shot.name}: ABORTED at ${i + 1}/${total}`;
  }

  return `${shot.name}: ${total}f ${(bytes / 1e6).toFixed(1)}MB`;
}

/* ---- the cameras the reel visits ------------------------------------
   Chosen against what these feeds were actually showing at capture time,
   not from the map: the first pass framed Etna and Kilauea, and both were
   in the dark. Fuego is a textbook cone in morning light, Shibuya is at
   full neon, Ilulissat has icebergs in open water. */
export const CAMS = {
  fuego: {
    id: 'volc_fuego', name: 'Volcán de Fuego', place: 'Chimaltenango',
    country: 'Guatemala', lat: 14.473, lon: -90.88, uptime_days: 54.4,
    tz: 'America/Guatemala', viewers: null,
  },
  shibuya: {
    id: 'city', name: 'Shibuya crossing', place: 'Tokyo', country: 'Japan',
    lat: 35.6595, lon: 139.7005, uptime_days: 1420, tz: 'Asia/Tokyo',
    viewers: null,
  },
  fairbanks: {
    id: 'aurora2', name: 'Fairbanks aurora', place: 'Alaska',
    country: 'United States', lat: 64.858, lon: -147.85, uptime_days: 890,
    tz: 'America/Anchorage', viewers: null,
  },
  ilulissat: {
    id: 'greenland', name: 'Ilulissat icebergs', place: 'Ilulissat',
    country: 'Greenland', lat: 69.217, lon: -51.1, uptime_days: 412,
    tz: 'America/Nuuk', viewers: null,
  },
};

/* ---- the shot list ---------------------------------------------------
   Seven beats. The first is the planet alone; the interface arrives on the
   second and stays for the rest, because the piece is about the site and
   not about a globe. */
export const SHOTS = [
  {
    name: '01-open', seconds: 5.0, drift: 0.10,
    from: { yaw: Y(-42), pitch: PT(20), dist: 6.4 },
    to: { yaw: Y(-6), pitch: PT(15), dist: 5.1 },
    titleAlpha: (t) => ramp(t, 0.02, 0.30),
    uiAlpha: (t) => ramp(t, 0.55, 0.95) * 0.9,
    /* No narrative type here. The opening card already says "I built a
       globe full of live webcams", and repeating it over the planet said
       the same thing twice in the first ten seconds. The page's own title
       still rises behind the globe, which is the site's line, not a caption
       on top of it. */
    textAlpha: () => 0,
  },
  {
    name: '02-fuego', seconds: 5.0, drift: 0.02, cam: CAMS.fuego,
    from: { yaw: Y(-72), pitch: PT(24), dist: 5.2 },
    to: { yaw: Y(-90.88), pitch: PT(14.47), dist: 3.2 },
    titleAlpha: (t) => 1 - ramp(t, 0.0, 0.35),
    monAlpha: (t) => ramp(t, 0.30, 0.55),
    textAlpha: (t) => ramp(t, 0.42, 0.62) * (1 - ramp(t, 0.86, 1.0)),
    eyebrow: 'Volcán de Fuego · Guatemala',
    lines: ['From volcanoes'],
  },
  {
    name: '03-shibuya', seconds: 4.5, drift: 0.02, cam: CAMS.shibuya,
    from: { yaw: Y(122), pitch: PT(28), dist: 5.2 },
    to: { yaw: Y(139.70), pitch: PT(35.66), dist: 3.2 },
    titleAlpha: () => 0,
    monAlpha: () => 1,
    textAlpha: (t) => ramp(t, 0.30, 0.50) * (1 - ramp(t, 0.86, 1.0)),
    eyebrow: 'Shibuya Crossing · Tokyo',
    lines: ['to festival streets'],
  },
  {
    name: '04-aurora', seconds: 4.0, drift: 0.02, cam: CAMS.fairbanks,
    from: { yaw: Y(-128), pitch: PT(52), dist: 5.2 },
    to: { yaw: Y(-147.85), pitch: PT(64.86), dist: 3.3 },
    titleAlpha: () => 0,
    monAlpha: () => 1,
    textAlpha: (t) => ramp(t, 0.28, 0.48) * (1 - ramp(t, 0.86, 1.0)),
    eyebrow: 'Fairbanks · Alaska',
    lines: ['and if you are lucky,', 'the northern lights'],
  },
  {
    name: '05-greenland', seconds: 4.5, drift: 0.02, cam: CAMS.ilulissat,
    from: { yaw: Y(-30), pitch: PT(52), dist: 5.2 },
    to: { yaw: Y(-51.1), pitch: PT(69.22), dist: 3.3 },
    titleAlpha: () => 0,
    monAlpha: () => 1,
    textAlpha: (t) => ramp(t, 0.28, 0.48) * (1 - ramp(t, 0.86, 1.0)),
    eyebrow: 'Ilulissat · Greenland',
    lines: ['Check out Greenland'],
  },
  {
    /* The one beat that leaves the planet: the camera drifts right so the
       Beautiful News rail on the left edge becomes the subject. */
    name: '06-news', seconds: 4.5, drift: 0.03,
    /* The planet is pushed right and away so the left half of the frame
       belongs to the rail and its enlarged chart. */
    from: { yaw: Y(-40), pitch: PT(22), dist: 4.6 },
    to: { yaw: Y(-14), pitch: PT(16), dist: 6.2 },
    titleAlpha: () => 0,
    monAlpha: () => 0,
    zoomAlpha: (t) => ramp(t, 0.10, 0.32) * (1 - ramp(t, 0.78, 0.97)),
    zoomIndex: 2,
    textAlpha: (t) => ramp(t, 0.22, 0.42) * (1 - ramp(t, 0.86, 1.0)),
    eyebrow: 'Beautiful News · Information is Beautiful',
    lines: ['Good news, every day'],
  },
  /* Cut from the edit: it summarised what the page's own tally line
     already says and delayed the call to action by five seconds. Left here
     because the camera move is worth keeping if the piece is ever recut. */
  {
    name: '07-close', seconds: 5.5, drift: 0.12,
    from: { yaw: Y(-24), pitch: PT(14), dist: 4.6 },
    to: { yaw: Y(-86), pitch: PT(19), dist: 6.9 },
    titleAlpha: (t) => ramp(t, 0.35, 0.75) * 0.9,
    railAlpha: (t) => 1 - ramp(t, 0.30, 0.62),
    monAlpha: () => 0,
    textAlpha: (t) => ramp(t, 0.12, 0.34),
    eyebrow: '284 cameras · 53 countries',
    lines: ['All live. All from YouTube.'],
  },
];

/* Fire-and-forget: a full render outruns any console call timeout, so
   progress lands on window.CAPTURE and is polled from outside. */
/* `startIso` and `elapsed0` exist so a single beat can be re-cut without
   re-rendering the other six. The on-screen clock runs continuously across
   the whole piece, so a beat rendered later in the day would otherwise jump
   the time forward mid-cut and jump back again at the next dissolve. */
export function recordShots(list = SHOTS, { startIso = null, elapsed0 = 0 } = {}) {
  /* A second run started while the first is still going drives the same
     globe state and writes the same filenames, so the two interleave and
     every frame is garbage. Retire the previous run before starting. */
  if (window.CAPTURE && !window.CAPTURE.finished) window.CAPTURE.aborted = true;

  const state = {
    done: [], current: null, frame: 0, total: 0, finished: false, error: null,
    aborted: false,
  };
  window.CAPTURE = state;

  /* Silence the app's own animation loop for the duration.

     If the pane is visible, requestAnimationFrame fires and app.js keeps
     rendering its own camera state — and calls resize(), which resets the
     drawing buffer back to the CSS size. Both land between this loop's
     render and its readPixels, so frames come back torn: half of one
     camera position spliced onto half of another.

     app.js re-arms itself from inside its own callback, so replacing rAF
     with a no-op lets the loop retire after its current frame and leaves
     this the only thing rendering. */
  const realRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;

  (async () => {
    try {
      setupCapture();
      const charts = await loadCharts();
      const P = window.PLANET;
      const start = startIso ? new Date(startIso) : P.clock.now();
      const countEl = document.getElementById('hud-count');
      const whereEl = document.getElementById('hud-where');

      /* The clock has to keep ticking across the whole piece rather than
         restarting each shot, or the reel cuts back and forth in time. */
      let elapsed = elapsed0;
      const ctxState = {
        charts,
        driftBase: elapsed0 * 1.1,
        count: (countEl && countEl.textContent.trim()) || '284',
        where: (whereEl && whereEl.textContent.trim()) || 'live cameras · 53 countries',
        clockText(secs) {
          const d = new Date(start.getTime() + (elapsed + secs) * 1000);
          return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
            .map((n) => String(n).padStart(2, '0')).join(':');
        },
      };

      for (const shot of list) {
        state.current = shot.name;
        /* eslint-disable no-await-in-loop */
        if (state.aborted) break;
        const line = await recordShot(shot, ctxState, (n, i, t) => {
          state.frame = i;
          state.total = t;
        }, state);
        elapsed += shot.seconds;
        ctxState.driftBase += shot.seconds * 1.1;
        state.done.push(line);
        console.info('[capture]', line);
      }
    } catch (err) {
      state.error = String((err && err.message) || err);
      console.error('[capture]', err);
    } finally {
      window.requestAnimationFrame = realRaf;
      state.finished = true;
      state.current = null;
    }
  })();
  return state;
}
