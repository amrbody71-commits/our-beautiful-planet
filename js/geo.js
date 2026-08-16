/* geo.js — pure geometry. No three.js scene objects, no DOM, no state.

   Convention (matched by every other module):

       x = -cos(lat) * cos(lon)
       y =  sin(lat)
       z =  cos(lat) * sin(lon)

   Y is up, the sphere is unit radius, longitude runs eastward.

   THE MINUS SIGN ON X IS LOAD-BEARING. Without it the sphere is mirrored
   east-west: longitude increases to the LEFT, so you are looking at the
   Earth from the inside. It stays perfectly self-consistent — coastlines,
   land mask, pins and sun all agree with each other — so nothing looks
   broken. Africa is simply backwards, and Cairo renders west of Lagos.

   With the minus sign, at yaw 0 the meridian facing a camera on +Z is
   90°E, and the longitude facing the camera is  lon = 90 - yaw(deg).

   js/selftest.js asserts this on demand (?check=1) so it cannot silently
   regress again. */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function latLonToVec3(lat, lon, radius = 1, out = [0, 0, 0]) {
  const p = lat * D2R;
  const t = lon * D2R;
  const cp = Math.cos(p);
  out[0] = -cp * Math.cos(t) * radius;
  out[1] = Math.sin(p) * radius;
  out[2] = cp * Math.sin(t) * radius;
  return out;
}

export function vec3ToLatLon(x, y, z) {
  const r = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, y / r))) * R2D,
    lon: Math.atan2(z, -x) * R2D,
  };
}

/* Camera yaw that brings a meridian to face the viewer. */
export function yawForLon(lon) {
  return (90 - lon) * D2R;
}

export function normalize180(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/* Great-circle interpolation between two unit vectors.

   This is what keeps a coastline ON the sphere: a straight line between two
   points 5° apart cuts a visible chord through the surface. It also means
   the LINE layer needs no antimeridian special-casing — slerp always takes
   the short way around, so a segment from 179°E to 179°W crosses the date
   line correctly rather than sweeping the long way across the Pacific. (The
   raster in atlas.js is a different story; see the unwrap there.) */
export function slerpInto(a, b, t, out = [0, 0, 0]) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.max(-1, Math.min(1, dot));
  const omega = Math.acos(dot);
  if (omega < 1e-6) {
    out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
    return out;
  }
  const so = Math.sin(omega);
  const k0 = Math.sin((1 - t) * omega) / so;
  const k1 = Math.sin(t * omega) / so;
  out[0] = a[0] * k0 + b[0] * k1;
  out[1] = a[1] * k0 + b[1] * k1;
  out[2] = a[2] * k0 + b[2] * k1;
  return out;
}

/* Normalizes defensively. Feeding this vectors at radius 1.0015 makes the
   raw dot product exceed 1 for any angle under ~4.4°, which clamps to 1 and
   reports an angle of zero — silently disabling any subdivision that keys
   off it. */
export function angleBetween(a, b) {
  const la = Math.hypot(a[0], a[1], a[2]) || 1;
  const lb = Math.hypot(b[0], b[1], b[2]) || 1;
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/* Walk a lon/lat ring and emit LineSegments vertex pairs onto `sink`,
   inserting slerped intermediates wherever a span exceeds maxAngle. */
export function densifyRing(ring, radius, maxAngle, sink) {
  if (ring.length < 2) return;
  /* All the maths runs in UNIT space and scales to `radius` only at emit
     time, so angle comparisons stay exact regardless of the draw radius. */
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const mid = [0, 0, 0];

  latLonToVec3(ring[0][1], ring[0][0], 1, a);
  for (let i = 1; i < ring.length; i += 1) {
    latLonToVec3(ring[i][1], ring[i][0], 1, b);
    const omega = angleBetween(a, b);
    const steps = Math.max(1, Math.ceil(omega / maxAngle));

    let px = a[0], py = a[1], pz = a[2];
    for (let s = 1; s <= steps; s += 1) {
      if (s === steps) {
        mid[0] = b[0]; mid[1] = b[1]; mid[2] = b[2];
      } else {
        slerpInto(a, b, s / steps, mid);
        const len = Math.hypot(mid[0], mid[1], mid[2]) || 1;
        mid[0] /= len; mid[1] /= len; mid[2] /= len;
      }
      sink.push(px * radius, py * radius, pz * radius,
                mid[0] * radius, mid[1] * radius, mid[2] * radius);
      px = mid[0]; py = mid[1]; pz = mid[2];
    }
    a[0] = b[0]; a[1] = b[1]; a[2] = b[2];
  }
}

/* World-space point → screen pixels. Returns null when the point is behind
   the camera. `facing` is the dot product used to reject the far side of
   the globe (positive means the point's outward normal faces the viewer);
   with a unit-radius sphere the position IS the normal, which is why the
   radius convention matters. */
export function projectToScreen(v, camera, width, height, out = { x: 0, y: 0, depth: 0, facing: 0 }) {
  const cam = camera.position;
  const dx = cam.x - v.x;
  const dy = cam.y - v.y;
  const dz = cam.z - v.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  out.facing = (v.x * dx + v.y * dy + v.z * dz) / len;

  const p = v.clone().project(camera);
  out.depth = p.z;
  out.x = (p.x * 0.5 + 0.5) * width;
  out.y = (-p.y * 0.5 + 0.5) * height;
  return out;
}
