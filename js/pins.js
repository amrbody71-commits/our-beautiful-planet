/* pins.js — one instanced marker per camera, plus the masts they stand on.

   Two draw calls for the whole field regardless of how many cameras the
   dataset grows to. The mast is a small thing that does a lot of work: a
   bare dot sits ON the map like a printed symbol, while a dot raised on a
   hairline reads as equipment mounted at a place. */

import * as THREE from 'three';
import { pinVertex, pinFragment } from './shaders/pin.glsl.js';
import { latLonToVec3 } from './geo.js';

const MAST_INNER = 1.0025;
const MAST_OUTER = 1.021;

export function createPins({ cams, camera }) {
  const count = cams.length;

  /* A single unit quad, instanced. position.xy spans -0.5..0.5 and the
     vertex shader billboards it. */
  const quad = new THREE.InstancedBufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  quad.instanceCount = count;

  const aPos = new Float32Array(count * 3);
  const aPhase = new Float32Array(count);
  const aState = new Float32Array(count);
  const aDim = new Float32Array(count);
  const unit = [0, 0, 0];

  const mast = new Float32Array(count * 6);
  for (let i = 0; i < count; i += 1) {
    const cam = cams[i];
    latLonToVec3(cam.lat, cam.lon, 1, unit);
    aPos[i * 3] = unit[0];
    aPos[i * 3 + 1] = unit[1];
    aPos[i * 3 + 2] = unit[2];
    aPhase[i] = (i * 2.399963) % (Math.PI * 2);   // golden-angle spread
    aState[i] = 0;
    aDim[i] = 1;

    mast[i * 6] = unit[0] * MAST_INNER;
    mast[i * 6 + 1] = unit[1] * MAST_INNER;
    mast[i * 6 + 2] = unit[2] * MAST_INNER;
    mast[i * 6 + 3] = unit[0] * MAST_OUTER;
    mast[i * 6 + 4] = unit[1] * MAST_OUTER;
    mast[i * 6 + 5] = unit[2] * MAST_OUTER;
  }

  quad.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
  quad.setAttribute('aPhase', new THREE.InstancedBufferAttribute(aPhase, 1));
  quad.setAttribute('aState', new THREE.InstancedBufferAttribute(aState, 1));
  quad.setAttribute('aDim', new THREE.InstancedBufferAttribute(aDim, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uPixelScale: { value: 1 },
      uTime: { value: 0 },
      uBase: { value: 9 },
      uHover: { value: 19 },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      /* A marker has to survive TWO backgrounds that are opposites: warm
         amber city-light at night, and pale blue-white land by day. Amber
         vanished into the first, cyan into the second, because each was
         only ever contrasted against one of them.

         What survives both is a white core carrying an ink outline — value
         contrast, which works against anything — ringed in a hue that
         simply does not occur in terrain or in daylight. Magenta appears
         nowhere on this globe by nature, so it never blends into it. */
      uCore: { value: new THREE.Color('#ffffff') },
      uRing: { value: new THREE.Color('#ff3ea8') },
      uHot: { value: new THREE.Color('#ff8ccb') },
      uInk: { value: new THREE.Color('#01040a') },
    },
    vertexShader: pinVertex,
    fragmentShader: pinFragment,
  });

  const mesh = new THREE.Mesh(quad, material);
  mesh.frustumCulled = false;      // instances live outside the base geometry's bounds
  mesh.renderOrder = 6;

  const mastGeo = new THREE.BufferGeometry();
  mastGeo.setAttribute('position', new THREE.Float32BufferAttribute(mast, 3));
  const masts = new THREE.LineSegments(mastGeo, new THREE.LineBasicMaterial({
    color: new THREE.Color('#ff3ea8'),
    transparent: true,
    opacity: 0.30,
    depthWrite: false,
  }));
  masts.renderOrder = 5;

  const group = new THREE.Group();
  group.add(masts, mesh);

  const stateAttr = quad.getAttribute('aState');
  const dimAttr = quad.getAttribute('aDim');
  let hovered = -1;

  return {
    group,
    mesh,
    masts,
    material,
    count,
    positions: aPos,
    get hovered() { return hovered; },

    /* Hover is a target, not a jump: update() eases towards it so the
       marker grows rather than snapping. */
    setHovered(index) { hovered = index; },

    setDim(index, value) {
      dimAttr.array[index] = value;
      dimAttr.needsUpdate = true;
    },

    setPixelScale(heightPx) {
      const fov = camera.fov * Math.PI / 180;
      material.uniforms.uPixelScale.value = (heightPx * 0.5) / Math.tan(fov / 2);
    },

    setSun(x, y, z) { material.uniforms.uSunDir.value.set(x, y, z); },

    update(dtMs, elapsedS) {
      material.uniforms.uTime.value = elapsedS;
      const ease = 1 - Math.pow(0.0008, Math.min(dtMs, 64) / 1000);
      let dirty = false;
      for (let i = 0; i < count; i += 1) {
        const target = i === hovered ? 1 : 0;
        const cur = stateAttr.array[i];
        if (Math.abs(target - cur) < 0.002) {
          if (cur !== target) { stateAttr.array[i] = target; dirty = true; }
          continue;
        }
        stateAttr.array[i] = cur + (target - cur) * ease;
        dirty = true;
      }
      if (dirty) stateAttr.needsUpdate = true;
    },

    dispose() {
      quad.dispose();
      material.dispose();
      mastGeo.dispose();
      masts.material.dispose();
    },
  };
}
