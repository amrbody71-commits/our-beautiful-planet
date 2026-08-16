/* atlas.js — Natural Earth (public domain, via world-atlas) into geometry.

   Two line layers come out of ONE file, and the whole trick is the mesh
   filter:

     (a, b) => a !== b   interior borders — every shared arc emitted once,
                         so no double-drawn coastlines and no z-fighting
     (a, b) => a === b   exterior rings, i.e. coastlines

   Drawing the coastline bright and the borders dim is what makes a
   wireframe globe read as cartography instead of a mesh. Each layer merges
   into a single LineSegments, so the entire world map costs 2 draw calls. */

import * as THREE from 'three';
import { mesh, feature } from 'topojson-client';
import { densifyRing } from './geo.js';

/* 0.75° between vertices. Below this the chord error is under a pixel at
   any zoom this app allows; above it, long Siberian arcs visibly cut
   through the sphere. */
const MAX_SEGMENT_ANGLE = 0.75 * Math.PI / 180;
const LINE_RADIUS = 1.0015;

function buildLayer(topology, object, filter) {
  const geo = mesh(topology, object, filter);
  const verts = [];
  const lines = geo.type === 'MultiLineString' ? geo.coordinates
    : geo.type === 'LineString' ? [geo.coordinates] : [];
  for (const line of lines) densifyRing(line, LINE_RADIUS, MAX_SEGMENT_ANGLE, verts);

  const buffer = new THREE.BufferGeometry();
  buffer.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  return buffer;
}

export async function loadAtlas({ url }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`atlas ${res.status} for ${url}`);
  const topology = await res.json();
  const countries = topology.objects.countries;

  return {
    topology,
    countries,
    coastline: buildLayer(topology, countries, (a, b) => a === b),
    borders: buildLayer(topology, countries, (a, b) => a !== b),
  };
}

/* ------------------------------------------------------------------ */
/* land mask                                                           */
/* ------------------------------------------------------------------ */

/* Rasterise land into an equirectangular mask rather than triangulating
   it. No earcut, no spherical tessellation, and the result does triple
   duty later: it decides where land particles may sit (U3), where the
   night-side city glow is allowed to appear, and where the ocean gets its
   specular (U4).

   Two things bite here, both worth stating plainly:

   1. ANTIMERIDIAN. A ring crossing the date line has longitudes that jump
      +179 -> -179. Drawn naively that jump smears the shape straight
      across the whole map — Russia and Fiji turn into horizontal bars. The
      fix is to unwrap: accumulate deltas, and whenever one exceeds 180°
      treat it as the short way round. The unwrapped ring then runs off one
      edge, so it is stamped three times at -W, 0 and +W and the half that
      left one side clips back in on the other.

   2. ANTARCTICA. Its ring closes along the -90° parallel, which is a point
      on a sphere but a full-width line in equirectangular space. Clamping
      y keeps that inside the canvas instead of painting a stray band. */
export function buildLandMask(topology, width) {
  const height = Math.round(width / 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';

  /* topojson's feature() hands back a Feature (or a FeatureCollection for a
     GeometryCollection), never a bare geometry — reading `.coordinates`
     straight off it yields undefined and silently rasterises nothing. */
  const polys = [];
  const collect = (geom) => {
    if (!geom) return;
    if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
    else if (geom.type === 'Polygon') polys.push(geom.coordinates);
  };
  const built = feature(topology, topology.objects.land);
  if (built.type === 'FeatureCollection') built.features.forEach((f) => collect(f.geometry));
  else if (built.type === 'Feature') collect(built.geometry);
  else collect(built);

  if (!polys.length) throw new Error('land mask: no polygons in topology.objects.land');

  const yOf = (lat) => Math.max(0, Math.min(height, (90 - lat) / 180 * height));

  for (const poly of polys) {
    for (const offset of [-width, 0, width]) {
      ctx.beginPath();
      for (const ring of poly) {
        if (ring.length < 3) continue;
        let unwrapped = ring[0][0];
        let prevLon = ring[0][0];
        ctx.moveTo((unwrapped + 180) / 360 * width + offset, yOf(ring[0][1]));
        for (let i = 1; i < ring.length; i += 1) {
          const lon = ring[i][0];
          let d = lon - prevLon;
          if (d > 180) d -= 360;
          else if (d < -180) d += 360;
          unwrapped += d;
          prevLon = lon;
          ctx.lineTo((unwrapped + 180) / 360 * width + offset, yOf(ring[i][1]));
        }
        ctx.closePath();
      }
      /* evenodd so lakes and other interior rings punch holes. */
      ctx.fill('evenodd');
    }
  }

  const pixels = ctx.getImageData(0, 0, width, height).data;
  /* One byte per texel is all we need, and it keeps the hot sampling loop
     out of the 4-byte RGBA stride. */
  const alpha = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < alpha.length; i += 1, p += 4) alpha[i] = pixels[p];

  return {
    canvas,
    width,
    height,
    data: alpha,
    isLand(lat, lon) {
      const x = Math.min(width - 1, Math.max(0, ((lon + 180) / 360 * width) | 0));
      const y = Math.min(height - 1, Math.max(0, ((90 - lat) / 180 * height) | 0));
      return alpha[y * width + x] > 127;
    },
    /* Fraction of the sphere the mask calls land — a cheap correctness
       assertion, since Earth's true land fraction is ~0.29. */
    landFraction() {
      let sum = 0;
      for (let y = 0; y < height; y += 1) {
        /* weight by cos(lat): equirect rows near the poles cover far less
           surface than rows at the equator */
        const lat = 90 - (y + 0.5) / height * 180;
        const w = Math.cos(lat * Math.PI / 180);
        let row = 0;
        for (let x = 0; x < width; x += 1) if (alpha[y * width + x] > 127) row += 1;
        sum += (row / width) * w;
      }
      let norm = 0;
      for (let y = 0; y < height; y += 1) {
        norm += Math.cos((90 - (y + 0.5) / height * 180) * Math.PI / 180);
      }
      return sum / norm;
    },
  };
}

export function createAtlasLines(atlas) {
  const group = new THREE.Group();

  /* depthWrite off so the lines never occlude the pins that sit just above
     them; depthTest on so the far side of the globe still hides them. */
  const coast = new THREE.LineSegments(atlas.coastline, new THREE.LineBasicMaterial({
    color: new THREE.Color('#9fc2d8'),
    transparent: true,
    /* Over a photograph the map is chrome, not terrain — a whisper. */
    opacity: 0.30,
    depthWrite: false,
  }));
  const borders = new THREE.LineSegments(atlas.borders, new THREE.LineBasicMaterial({
    color: new THREE.Color('#7d97ab'),
    transparent: true,
    opacity: 0.13,
    depthWrite: false,
  }));

  coast.renderOrder = 2;
  borders.renderOrder = 1;
  group.add(borders, coast);
  return { group, coast, borders };
}
