/* lights.js — where people actually are.

   The night side was the weakest part of the picture: a land mask says
   only "ground here", so every continent glowed evenly and the Sahara
   looked as inhabited as the Nile. No amount of shader tuning fixes that,
   because the information simply is not in the mask.

   This reads NASA's Black Marble composite (public domain, vendored from
   the three-globe example assets) purely as DATA — never drawn to screen.
   Its luminance weights each land particle's brightness, so the night side
   inherits the real distribution of human light: the Nile a bright thread
   through dark desert, the Ganges, the eastern seaboard, Java, Europe
   ablaze, the Sahara and Amazon and Siberia genuinely dark.

   The globe stays a particle globe. The photograph is a lookup table. */

export async function loadNightLights(url = './data/earth-night.jpg') {
  /* fetch + createImageBitmap rather than an <img> and decode().

     An <img> decodes lazily and on the main thread's terms: in a
     background or non-compositing tab the browser defers it indefinitely,
     so decode() simply never settles and the load hangs forever.
     createImageBitmap decodes off-thread from the bytes themselves and
     resolves regardless of whether anything is being painted. */
  const res = await fetch(url);
  if (!res.ok) throw new Error(`night lights ${res.status}: ${url}`);
  const bitmap = await Promise.race([
    createImageBitmap(await res.blob()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('decode timed out')), 10000)),
  ]);

  /* Capped resolution: this weights particles, it is not a texture, so the
     extra detail would cost memory and buy nothing. */
  const width = Math.min(2048, bitmap.width);
  const height = Math.round(width / 2);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const lum = new Uint8Array(width * height);
  let max = 1;
  for (let i = 0, p = 0; i < lum.length; i += 1, p += 4) {
    /* Rec.709 luminance; the source is a colour composite, not greyscale. */
    const v = (rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722) | 0;
    lum[i] = v;
    if (v > max) max = v;
  }

  /* This composite is not a pure lights product — bright SURFACES bleed
     into it. Measured on the raw raster: London 0.96 and Tokyo 0.91 as
     expected, but empty Sahara reads 0.49 and Greenland ice 0.48, against
     Amazon 0.14 and Siberia 0.04. Taken at face value that lights the
     world's two great empty places as though they were cities.

     So the floor is cut where sand and ice sit and below, and only what
     rises clearly above it counts as human light. Some genuinely dim
     settlement is lost with it; a glowing Sahara would be a worse lie. */
  const FLOOR = 0.52;
  const CEIL = 0.92;

  return {
    width,
    height,
    max,
    raw(lat, lon) {
      const x = Math.min(width - 1, Math.max(0, ((lon + 180) / 360 * width) | 0));
      const y = Math.min(height - 1, Math.max(0, ((90 - lat) / 180 * height) | 0));
      return lum[y * width + x] / max;
    },
    /* 0..1 human light, with surface albedo removed. */
    sample(lat, lon) {
      const v = this.raw(lat, lon);
      const t = (v - FLOOR) / (CEIL - FLOOR);
      return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    },
  };
}
