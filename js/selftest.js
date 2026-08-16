/* selftest.js — geographic invariants, asserted on demand with ?check=1.

   This exists because a globe can be confidently, self-consistently WRONG.
   Every layer agreed with every other layer while the whole world was
   mirrored east-west: coastlines matched the land mask, pins matched the
   coastlines, the terminator matched the pins. Nothing looked broken. Cairo
   simply rendered west of Lagos.

   Checks that only compare the app to itself cannot catch that. Each
   assertion below compares the app to something known about the actual
   Earth, so the class of bug that survives internal consistency gets
   caught. Run it after touching geo.js, the shaders, or the sampler.

       http://localhost:8777/?check=1        (results land in the console) */

import * as THREE from 'three';
import { latLonToVec3 } from './geo.js';
import { subsolarPoint, solarElevation } from './sun.js';

const PLACES = {
  dakar: [14.7, -17.4], lagos: [6.5, 3.4], cairo: [30.0, 31.2], nairobi: [-1.3, 36.8],
};

export function runSelfTest(P) {
  const out = [];
  const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail });

  const canvas = P.renderer.domElement;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;

  /* Face 10E on the equator, north up, and render so the camera matrices
     are current — project() reads matrixWorldInverse, which only the
     renderer refreshes. */
  const s = P.globe.state;
  const keep = { yaw: s.yaw, pitch: s.pitch, dist: s.dist, target: s.targetDist };
  s.yaw = (90 - 10) * Math.PI / 180;
  s.pitch = 0;
  s.dist = 5.0;
  s.targetDist = 5.0;
  P.globe.update(16);
  P.globe.group.updateMatrixWorld(true);
  P.renderer.render(P.scene, P.camera);

  const screen = (lat, lon) => {
    const v = latLonToVec3(lat, lon, 1);
    const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(P.globe.group.matrixWorld);
    const q = p.clone().project(P.camera);
    return { x: (q.x * 0.5 + 0.5) * w, y: (-q.y * 0.5 + 0.5) * h };
  };

  /* 1. ORIENTATION — the invariant that was broken. */
  const d = screen(...PLACES.dakar);
  const l = screen(...PLACES.lagos);
  const c = screen(...PLACES.cairo);
  const n = screen(...PLACES.nairobi);
  ok('east is right (Dakar 17W < Lagos 3E < Cairo 31E)',
    d.x < l.x && l.x < c.x,
    `Dakar ${d.x | 0}, Lagos ${l.x | 0}, Cairo ${c.x | 0}, Nairobi ${n.x | 0}`);

  const np = screen(89, 0);
  const sp = screen(-89, 0);
  ok('north is up', np.y < sp.y, `N ${np.y | 0} above S ${sp.y | 0}`);
  ok('Cairo north of Nairobi', c.y < n.y, `Cairo ${c.y | 0}, Nairobi ${n.y | 0}`);

  s.yaw = keep.yaw; s.pitch = keep.pitch; s.dist = keep.dist; s.targetDist = keep.target;

  /* 2. LAND MASK — against the real world, not against our own coastlines. */
  if (P.mask) {
    const land = [['Sahara', 23, 13], ['Amazon', -3, -60], ['Siberia', 65, 100],
      ['Greenland', 72, -40], ['Sicily', 37.6, 14.0], ['Fiji', -17.8, 178.0]];
    const sea = [['Pacific', 0, -140], ['Atlantic', 30, -40], ['Indian', -20, 80],
      ['Bay of Bengal', 15, 88]];
    const bad = [
      ...land.filter(([, a, o]) => !P.mask.isLand(a, o)).map(([k]) => `${k} not land`),
      ...sea.filter(([, a, o]) => P.mask.isLand(a, o)).map(([k]) => `${k} not ocean`),
    ];
    ok('land mask matches the world', bad.length === 0, bad.join(', ') || '10/10 probes');
    const frac = P.mask.landFraction();
    ok('land is ~29% of the sphere', Math.abs(frac - 0.29) < 0.03, frac.toFixed(3));
  }

  /* 3. NIGHT LIGHTS — cities lit, wilderness dark. */
  if (P.lights) {
    const lit = ['London', 51.5, -0.1];
    const dark = ['Sahara', 23, 13];
    const a = P.lights.sample(lit[1], lit[2]);
    const b = P.lights.sample(dark[1], dark[2]);
    ok('city lights are where people are', a > 0.6 && b < 0.05,
      `London ${a.toFixed(2)}, Sahara ${b.toFixed(2)}`);
  }

  /* 4. SUN — against known solar geometry, not against our own shader. */
  const june = new Date('2026-06-21T12:00:00Z');
  const jun = subsolarPoint(june);
  ok('June solstice sun over the Tropic of Cancer',
    Math.abs(jun.lat - 23.44) < 0.2, `${jun.lat.toFixed(2)}°`);
  ok('Arctic Circle fully lit at the June solstice',
    [-180, -90, 0, 90].every((lo) => solarElevation(66.56, lo, june) > -0.9),
    'every longitude above the horizon');
  ok('Antarctica dark at the June solstice',
    [-180, -90, 0, 90].every((lo) => solarElevation(-80, lo, june) < 0), 'all below');

  /* 5. PINS — placed by the same convention as everything else. */
  if (P.pins && P.data) {
    let worst = 0;
    for (const cam of P.data.cams) {
      const v = latLonToVec3(cam.lat, cam.lon, 1);
      const i = cam.index * 3;
      worst = Math.max(worst, Math.hypot(
        v[0] - P.pins.positions[i], v[1] - P.pins.positions[i + 1], v[2] - P.pins.positions[i + 2]));
    }
    ok('every pin sits at its own coordinates', worst < 1e-5, `worst ${worst.toExponential(1)}`);
  }

  /* 6. COASTLINES — real capes fall on the drawn outline. */
  if (P.atlas) {
    const pos = P.atlas.coastline.getAttribute('position');
    const caps = { "Land's End": [50.07, -5.72], 'Cape York': [-10.69, 142.53],
      'Cape of Good Hope': [-34.36, 18.47], 'Diomede': [65.78, -168.93] };
    let worstDeg = 0;
    for (const [lat, lon] of Object.values(caps)) {
      const t = latLonToVec3(lat, lon, 1);
      let best = Math.PI;
      for (let i = 0; i < pos.count; i += 1) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const len = Math.hypot(x, y, z) || 1;
        const dot = (x * t[0] + y * t[1] + z * t[2]) / len;
        best = Math.min(best, Math.acos(Math.max(-1, Math.min(1, dot))));
      }
      worstDeg = Math.max(worstDeg, best * 180 / Math.PI);
    }
    ok('coastline passes through known capes', worstDeg < 1.5, `worst ${worstDeg.toFixed(2)}°`);
  }

  const failed = out.filter((r) => !r.pass);
  console.group(`[planet] self-test — ${out.length - failed.length}/${out.length} passed`);
  for (const r of out) {
    console[r.pass ? 'info' : 'error'](`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
  }
  console.groupEnd();
  return { passed: out.length - failed.length, total: out.length, failed, results: out };
}
