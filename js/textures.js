/* textures.js — the photographic earth: NASA Blue Marble by day, Black
   Marble by night, a NASA-derived cloud layer over both.

   Loaded the same way lights.js learned to: fetch + createImageBitmap,
   never an <img> — an <img> defers decoding indefinitely in a background
   tab and the load then simply never settles.

   Every bitmap is drawn through a canvas before upload. Two reasons:
   canvas uploads respect flipY (ImageBitmap uploads ignore it in some
   browsers, which would flip the planet), and it is where the base tier
   halves the 4096-wide day map instead of paying 32 MB of VRAM. */

import * as THREE from 'three';

function fetchBitmap(url, timeoutMs = 15000) {
  return fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return res.blob();
    })
    .then((blob) => Promise.race([
      createImageBitmap(blob),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`decode timed out: ${url}`)), timeoutMs)),
    ]));
}

function toTexture(bitmap, { maxWidth = 4096, srgb = true, bloom = false } = {}) {
  const w = Math.min(maxWidth, bitmap.width);
  const h = Math.round(w * bitmap.height / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  /* City-light bloom, baked once at load. In orbital photography a bright
     city core bleeds into its surroundings; the raw composite is crisper
     than any camera. Two additive blurred passes — a tight halo and a wide
     faint one — put that atmosphere back for zero runtime cost. */
  if (bloom) {
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    base.getContext('2d').drawImage(canvas, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(5px)';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(base, 0, 0);
    ctx.filter = 'blur(14px)';
    ctx.globalAlpha = 0.30;
    ctx.drawImage(base, 0, 0);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  const tex = new THREE.CanvasTexture(canvas);
  /* Geometry-UV sampling (see globe.glsl.js) has no shader-side seam, so
     these can carry full mipmaps — that is the whole point of the switch:
     a spinning 4096-wide texture without mips shimmers. */
  tex.wrapS = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Resolves piecemeal: each texture applies the moment it arrives, so the
   planet upgrades progressively rather than waiting on the largest file. */
export function loadEarthTextures({ dayMax = 4096, onDay, onNight, onClouds } = {}) {
  const jobs = [
    fetchBitmap('./data/earth-blue-marble.jpg')
      .then((b) => onDay && onDay(toTexture(b, { maxWidth: dayMax })))
      .catch((err) => console.warn('[planet] day texture unavailable:', err.message)),
    fetchBitmap('./data/earth-night.jpg')
      .then((b) => onNight && onNight(toTexture(b, { maxWidth: 2048, bloom: true })))
      .catch((err) => console.warn('[planet] night texture unavailable:', err.message)),
    /* Luminance-as-alpha data, not colour: stays linear so mid-grey clouds
       keep their weight instead of sinking in an sRGB decode. */
    fetchBitmap('./data/earth-clouds.jpg')
      .then((b) => onClouds && onClouds(toTexture(b, { maxWidth: 2048, srgb: false })))
      .catch((err) => console.warn('[planet] clouds unavailable:', err.message)),
  ];
  return Promise.all(jobs);
}
