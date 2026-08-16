/* globe.js — the planet body, the starfield behind it, and the camera
   controls that spin and dolly it.

   Two conventions the rest of the app depends on:

     radius is exactly 1.0   — every dot product against a unit normal then
                               comes for free (the terminator in U4, the limb
                               fade and the picker in U5/U6 all rely on it).
     fov is 32               — a long lens. At fov 50+ the sphere bulges into
                               a cartoon planet; at 32 it reads like an
                               instrument looking at a world.

   Rotation lives on the globe GROUP, not the camera, so the camera stays a
   fixed observer and world-space lighting stays trivially correct.

   The starfield is a 2D canvas, not geometry, because it sits UNDER the
   title in the page's z-stack — the WebGL canvas is transparent and paints
   only the planet, which is what lets the planet eclipse the title. */

import * as THREE from 'three';
import { globeVertex, globeFragment, cloudsVertex, cloudsFragment } from './shaders/globe.glsl.js';

export const GLOBE_RADIUS = 1;
export const CAMERA_FOV = 32;

/* Framing: at fov 32 the visible half-height at distance d is d*tan(16°).
   DEFAULT_DIST puts the globe at roughly 62% of viewport height, leaving
   the title room to breathe above it. */
export const DEFAULT_DIST = 5.6;
export const MIN_DIST = 3.2;
export const MAX_DIST = 11;

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPIN_RATE = REDUCED ? 0 : 0.045;   // radians/second, ~140s per turn
const PITCH_LIMIT = 1.15;
const MAX_FLING = 3.5;      // rad/s ceiling on a throw
const GLIDE_DECAY = 0.04;   // fraction of fling velocity surviving one second

/* Deterministic star placement — the sky should be identical every load. */
function mulberry32(seed) {
  return function rnd() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function paintStars(canvas, count) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const rnd = mulberry32(0x5eed1);
  for (let i = 0; i < count; i += 1) {
    const x = rnd() * w;
    const y = rnd() * h;
    const m = rnd();
    const r = (m > 0.97 ? 1.9 : m > 0.85 ? 1.25 : 0.75) * dpr;
    /* A faint blue-white bias keeps the sky from reading as grey noise. */
    ctx.globalAlpha = 0.16 + m * 0.5;
    ctx.fillStyle = m > 0.93 ? '#cfe2ee' : '#8fa4b6';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* The planet body. The land mask arrives with the atlas, well after the
   first frame, so the material starts on a 1x1 black stand-in — an all-
   ocean world — and swaps to the real mask when it lands.

   Every shader here ends with colorspace_fragment: THREE.Color converts an
   sRGB hex to linear on assignment, and a raw ShaderMaterial gets no
   automatic output transform, so skipping it renders everything about
   three times too dark. */
function blankMask() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

function createBody(segments) {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, segments[0], segments[1]);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uLandMask: { value: blankMask() },
      uDayMap: { value: blankMask() },
      uNightMap: { value: blankMask() },
      uHasDay: { value: 0 },
      uHasNight: { value: 0 },
      uCloudMap: { value: blankMask() },
      uHasClouds: { value: 0 },
      uCloudShift: { value: 0 },
      uOceanDay: { value: new THREE.Color('#122b3f') },
      uOceanNight: { value: new THREE.Color('#060c14') },
      uLandDay: { value: new THREE.Color('#1d3a4a') },
      uLandNight: { value: new THREE.Color('#0c1420') },
      uCityGlow: { value: new THREE.Color('#ff9d5c') },
      uTwilight: { value: new THREE.Color('#ff7a4d') },
      uAtmo: { value: new THREE.Color('#5fa8d3') },
      /* The particle field carries the night signal from real data now, so
         the body only needs enough warmth to keep unlit land faintly
         distinguishable from ocean. */
      uCityAmount: { value: 0.035 },
    },
    vertexShader: globeVertex,
    fragmentShader: globeFragment,
  });
  return new THREE.Mesh(geometry, material);
}

/* Land particles: rejection-sample the sphere uniformly and keep the points
   that land on real ground.

   Uniform sampling means z = 2u-1 (NOT a uniform latitude, which would
   bunch points at the poles). Land is ~29% of the surface, so reaching N
   land points takes ~3.4N tries; the budget cap stops a bad mask from
   spinning forever.

   LUMINANCE, not stipple. A field of hard opaque dots reads as printed
   texture — illustration. What makes a particle earth read as something
   luminous is that each point GLOWS: a bright tight core plus a wide soft
   halo, accumulated additively so overlapping points build brightness the
   way real light does.

   Proper bloom would be a post-processing pass, but EffectComposer renders
   through opaque targets and would destroy the transparent canvas the
   title eclipse depends on. Drawing the same geometry twice — once tight,
   once wide and dim — buys the same read for one extra draw call and keeps
   alpha intact. */
const PARTICLE_RADIUS = 1.0009;

function particleMaterial({ size, alpha, soft, hardness }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uDay: { value: new THREE.Color('#bfe4f5') },
      uNight: { value: new THREE.Color('#ffab6b') },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uScale: { value: 1 },
      uSize: { value: size },
      uAlpha: { value: alpha },
      uSoft: { value: soft },
      uHardness: { value: hardness },
    },
    vertexShader: /* glsl */`
      attribute float aBright;
      attribute float aLights;
      uniform float uScale;
      uniform float uSize;
      uniform vec3 uSunDir;
      uniform vec3 uDay;
      uniform vec3 uNight;
      varying float vBright;
      varying vec3 vTint;
      void main(){
        vec3 n = normalize(position);
        float day = smoothstep(-0.105, 0.105, dot(n, normalize(uSunDir)));
        vTint = mix(uNight, uDay, day);
        /* Night brightness comes from the Black Marble composite, not from
           noise: a gentle gamma lifts small settlements without letting the
           megacities clip, and the floor keeps unlit coastline faintly
           readable rather than absent. Day brightness stays uniform-ish,
           because sunlight does not care where the cities are. */
        float city = pow(aLights, 0.62);
        /* The floor has to be very low. It is paid by EVERY land point, and
           tens of thousands of them accumulate additively, so a floor that
           looks negligible per point renders unlit continents as a warm
           haze. Near-black between the cities is the truthful picture. */
        float night = 0.012 + city * 2.2;
        /* The photograph owns the day side now — particles survive only
           where they read as light, which is the night. They fade out
           through the twilight band rather than cutting at the line. */
        vBright = night * (1.0 - day);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(uSize * (0.65 + aBright * 0.35) * (uScale / -mv.z), 1.0, 22.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform float uAlpha;
      uniform float uSoft;
      uniform float uHardness;
      varying float vBright;
      varying vec3 vTint;
      void main(){
        float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
        if (r > 1.0) discard;
        /* A gaussian-ish falloff, not a disc: the soft shoulder is the
           whole difference between a glowing point and a printed dot. */
        float fall = pow(max(0.0, 1.0 - r), uSoft);
        float a = fall * uAlpha * clamp(vBright, 0.0, 1.4);

        /* Additive blending contributes rgb*alpha, so ALPHA alone carries
           the exposure and rgb stays near the intended hue. Budget it for
           overlap, not for a single point: the wide pass covers roughly
           thirty times the land area it is drawn over, so a per-point alpha
           that looks right in isolation saturates the continent to white. */
        gl_FragColor = vec4(vTint * uHardness, a);
        #include <colorspace_fragment>
      }`,
  });
}

export function createLandParticles({ mask, lights, count, seed = 0x51de }) {
  /* Three independent streams rather than consecutive draws from one.
     Taking latitude, longitude and brightness from successive values of a
     single small PRNG correlates them, and correlated pairs show up on a
     sphere as faint concentric structure in the field. */
  const rndLat = mulberry32(seed);
  const rndLon = mulberry32(seed ^ 0x9e3779b9);
  const rndBright = mulberry32(seed ^ 0x7f4a7c15);
  const pos = new Float32Array(count * 3);
  const bright = new Float32Array(count);
  const glowAt = new Float32Array(count);

  const budget = count * 8;
  let kept = 0;
  let tries = 0;
  while (kept < count && tries < budget) {
    tries += 1;
    const y = 2 * rndLat() - 1;
    const lat = Math.asin(y) * 180 / Math.PI;
    const lon = (2 * rndLon() - 1) * 180;
    if (!mask.isLand(lat, lon)) continue;

    const cp = Math.sqrt(Math.max(0, 1 - y * y));
    const t = lon * Math.PI / 180;
    const i = kept * 3;
    /* same convention as geo.latLonToVec3 — the minus on x is what
       keeps the world from being mirrored east-west */
    pos[i] = -cp * Math.cos(t) * PARTICLE_RADIUS;
    pos[i + 1] = y * PARTICLE_RADIUS;
    pos[i + 2] = cp * Math.sin(t) * PARTICLE_RADIUS;
    /* Two separate signals. aBright is arbitrary variation so the DAY
       field is not a flat stipple. aLights is real: how much light this
       place actually emits at night. */
    bright[kept] = 0.55 + rndBright() * 0.45;
    glowAt[kept] = lights ? lights.sample(lat, lon) : 0.5;
    kept += 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, kept * 3), 3));
  geometry.setAttribute('aBright', new THREE.BufferAttribute(bright.subarray(0, kept), 1));
  geometry.setAttribute('aLights', new THREE.BufferAttribute(glowAt.subarray(0, kept), 1));

  /* Two passes over one geometry: a tight bright core and a wide dim
     halo, both additive. Together they read as light rather than ink.

     Exposure is normalised against the point count. Under additive
     blending total brightness scales with density, so a fixed per-point
     alpha would make the high tier — with three times the particles —
     three times brighter than base. Tiers should differ in DETAIL, never
     in exposure. */
  const exposure = 60000 / Math.max(1, kept);
  const material = particleMaterial({ size: 2.1, alpha: 0.125 * exposure, soft: 1.4, hardness: 1.3 });
  const glowMaterial = particleMaterial({ size: 8.5, alpha: 0.0105 * exposure, soft: 3.0, hardness: 1.0 });

  const points = new THREE.Points(geometry, material);
  const glow = new THREE.Points(geometry, glowMaterial);
  points.frustumCulled = false;
  glow.frustumCulled = false;
  points.renderOrder = 4;
  glow.renderOrder = 3;

  return { geometry, points, glow, material, glowMaterial, kept, tries };
}

/* The air. A back-faced shell slightly larger than the planet, glowing
   where the surface turns away — the single cheapest cue that this is a
   world with an atmosphere rather than a textured ball. Sunward limb burns
   brighter than the night limb, so it also reinforces the terminator. */
function createAtmosphere() {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS * 1.055, 64, 48);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uInner: { value: new THREE.Color('#63b3e0') },
      uOuter: { value: new THREE.Color('#1d4f7a') },
    },
    vertexShader: /* glsl */`
      varying vec3 vNormalO;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main(){
        vNormalO = normalize(normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - world.xyz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform vec3 uSunDir;
      uniform vec3 uInner;
      uniform vec3 uOuter;
      varying vec3 vNormalO;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main(){
        /* BackSide, so the normal points inward: negate before comparing. */
        float rim = pow(clamp(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir))), 0.0, 1.0), 3.4);
        float day = smoothstep(-0.35, 0.35, dot(normalize(-vNormalO), normalize(uSunDir)));
        vec3 col = mix(uOuter, uInner, day);
        float a = rim * (0.16 + day * 0.62);
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
  });
  return new THREE.Mesh(geometry, material);
}

export function createGlobe({ scene, camera, canvas, quality }) {
  const group = new THREE.Group();
  const body = createBody(quality.segments);
  const air = createAtmosphere();
  air.renderOrder = 8;
  group.add(body, air);
  scene.add(group);

  const state = {
    /* lon = 90 - yaw(deg): this opens on ~20W, the Atlantic, with the
       Americas and Europe/Africa both on screen. */
    yaw: 110 * Math.PI / 180,
    pitch: 0.22,
    yawVel: 0,
    pitchVel: 0,
    dist: DEFAULT_DIST,
    targetDist: DEFAULT_DIST,
    dragging: false,
    spinScale: 1,        // U6 eases this to 0 while a preview is open
    targetSpin: 1,
    /* NO PAN. Moving the globe aside when a pin is hovered was tried and
       removed: it dragged the hovered pin up to 77px out from under the
       pointer, far beyond any sane release radius, so the next flicker of
       the hand dropped the hover, which reset the pan, which brought the
       pin back — the globe shook side to side and the player was killed
       before it could load. Hover follows the pointer; anything that moves
       the target away from the pointer is fighting it. Measured cost of
       not panning: 2% of visible pins sit under the panel. */
  };

  const pointers = new Map();
  let pinchDist = 0;
  let moved = 0;
  let lastMove = 0;

  const onDown = (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      state.dragging = true;
      moved = 0;
      lastMove = performance.now();
      state.yawVel = 0;
      state.pitchVel = 0;
      canvas.classList.add('dragging');
      canvas.setPointerCapture(e.pointerId);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onMove = (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) state.targetDist = clampDist(state.targetDist * (pinchDist / d));
      pinchDist = d;
      return;
    }
    if (!state.dragging) return;

    moved += Math.abs(dx) + Math.abs(dy);
    /* Scale by distance so a drag moves the same amount of SURFACE whether
       you are zoomed out or inspecting a city. */
    const k = 0.0042 * (state.dist / DEFAULT_DIST);
    const dYaw = dx * k;
    const dPitch = dy * k;
    state.yaw += dYaw;
    state.pitch = clamp(state.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);

    /* Throw velocity is per SECOND, never per event. A per-event velocity
       makes the strength of a flick depend on how often the device happens
       to emit pointermove — a 120Hz stylus and a 60Hz mouse would fling the
       globe by very different amounts for the same physical gesture. */
    const now = performance.now();
    const dtSec = Math.max(0.008, (now - lastMove) / 1000);
    lastMove = now;
    state.yawVel = clamp(dYaw / dtSec, -MAX_FLING, MAX_FLING);
    state.pitchVel = clamp(dPitch / dtSec, -MAX_FLING, MAX_FLING);
  };

  const onUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      state.dragging = false;
      canvas.classList.remove('dragging');
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    state.targetDist = clampDist(state.targetDist * (1 + Math.sign(e.deltaY) * 0.11));
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function update(dtMs) {
    const dt = Math.min(dtMs, 64) / 1000;
    /* Frame-rate independent exponential smoothing: the same visual damping
       at 30fps and 144fps. */
    const ease = 1 - Math.pow(0.0015, dt);

    if (!state.dragging) {
      state.yaw += state.yawVel * dt;
      state.pitch = clamp(state.pitch + state.pitchVel * dt, -PITCH_LIMIT, PITCH_LIMIT);
      const decay = Math.pow(GLIDE_DECAY, dt);
      state.yawVel *= decay;
      state.pitchVel *= decay;
      if (Math.abs(state.yawVel) < 1e-4) state.yawVel = 0;
      if (Math.abs(state.pitchVel) < 1e-4) state.pitchVel = 0;

      state.spinScale += (state.targetSpin - state.spinScale) * ease;
      state.yaw += SPIN_RATE * dt * state.spinScale;
    }

    state.dist += (state.targetDist - state.dist) * ease;
    camera.position.set(0, 0, state.dist);
    group.rotation.set(state.pitch, state.yaw, 0);

    /* Weather drifts independently of the ground — slow, about 8% of the
       idle spin. Its shader lights from a CLOUD-LOCAL sun, so the
       earth-fixed sun is counter-rotated by the drift angle each frame;
       skipping that would parade the clouds' terminator around the globe
       at the drift rate, which looks plausible and is wrong. */
    if (clouds) {
      cloudDrift += 0.0035 * dt;
      clouds.rotation.y = cloudDrift;
      /* A cloud texel at longitude C sits over ground longitude C + drift,
         so the ground looks up the cover above it at u − drift/2π. */
      body.material.uniforms.uCloudShift.value = -cloudDrift / (2 * Math.PI);
      const a = cloudDrift;
      clouds.material.uniforms.uSunDir.value.set(
        Math.cos(a) * earthSun.x - Math.sin(a) * earthSun.z,
        earthSun.y,
        Math.sin(a) * earthSun.x + Math.cos(a) * earthSun.z,
      );
    }
  }

  let land = null;
  let clouds = null;
  let cloudDrift = 0;
  const earthSun = new THREE.Vector3(1, 0, 0);

  return {
    group,
    body,
    state,
    update,
    /* The atlas arrives after the first frame, so the land field is
       attached rather than constructed with the globe. */
    setLand(mask, count, lights) {
      if (land) {
        group.remove(land.points, land.glow);
        land.geometry.dispose();
        land.material.dispose();
        land.glowMaterial.dispose();
      }
      land = createLandParticles({ mask, lights, count });
      group.add(land.glow, land.points);
      return land;
    },
    get land() { return land; },
    /* Swap the all-ocean stand-in for the real raster once it exists. */
    setLandMask(canvas) {
      const tex = new THREE.CanvasTexture(canvas);
      /* No mipmaps: the atan seam at +/-180 makes the derivative explode
         across one texel column, and a mipmapped sampler resolves that to
         the blurriest level — a visible stripe down the date line. */
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      body.material.uniforms.uLandMask.value.dispose?.();
      body.material.uniforms.uLandMask.value = tex;
    },
    /* The photographs, applied as they arrive. */
    setDayMap(tex) {
      body.material.uniforms.uDayMap.value = tex;
      body.material.uniforms.uHasDay.value = 1;
    },
    setNightMap(tex) {
      body.material.uniforms.uNightMap.value = tex;
      body.material.uniforms.uHasNight.value = 1;
    },
    setClouds(tex) {
      if (clouds) {
        group.remove(clouds);
        clouds.geometry.dispose();
        clouds.material.dispose();
      }
      const geo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.012, 64, 48);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uCloudMap: { value: tex },
          uSunDir: { value: earthSun.clone() },
          uOpacity: { value: 0.85 },
        },
        vertexShader: cloudsVertex,
        fragmentShader: cloudsFragment,
      });
      clouds = new THREE.Mesh(geo, mat);
      /* Over the land field (3/4), under the camera masts and pins (5/6). */
      clouds.renderOrder = 4.5;
      group.add(clouds);
      /* The body needs the same map: night-side city light dims under the
         weather, which means the ground shader must know where the clouds
         are RIGHT NOW — hence the drift-tracking shift below. */
      body.material.uniforms.uCloudMap.value = tex;
      body.material.uniforms.uHasClouds.value = 1;
    },

    /* Earth-fixed sun direction, shared by the body and the land field. */
    setSun(x, y, z) {
      earthSun.set(x, y, z);
      body.material.uniforms.uSunDir.value.set(x, y, z);
      air.material.uniforms.uSunDir.value.set(x, y, z);
      if (land) {
        land.material.uniforms.uSunDir.value.set(x, y, z);
        land.glowMaterial.uniforms.uSunDir.value.set(x, y, z);
      }
    },
    /* gl_PointSize is in device pixels, so the attenuation scale has to
       track the drawing buffer height, not the CSS height. */
    setViewportHeight(px) {
      if (!land) return;
      land.material.uniforms.uScale.value = px * 0.5;
      land.glowMaterial.uniforms.uScale.value = px * 0.5;
    },
    /* U6 calls this to arrest the spin while a preview is open. */
    setSpin(scale) { state.targetSpin = scale; },
    /* Distinguishes a tap from a drag for the touch path in U10. */
    get dragDistance() { return moved; },
    setQuality(next) {
      const geo = new THREE.SphereGeometry(GLOBE_RADIUS, next.segments[0], next.segments[1]);
      body.geometry.dispose();
      body.geometry = geo;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onUp);
      canvas.removeEventListener('wheel', onWheel);
      body.geometry.dispose();
      body.material.dispose();
      scene.remove(group);
    },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function clampDist(v) { return clamp(v, MIN_DIST, MAX_DIST); }
