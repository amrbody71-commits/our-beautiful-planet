/* shot.js — dev-only page capture.

   The browser pane cannot screenshot a WebGL canvas (it comes back black
   when the pane is not compositing), and the page itself cannot write
   files. So this composites the real z-stack — stars, title, globe — into
   a 2D canvas via readPixels and POSTs the PNG to serve.py.

   Load it from the console, never from index.html:
     const { capture } = await import('./js/shot.js'); await capture('u3');

   Caveat worth knowing when reading the output: canvas text cannot apply a
   variable-font width axis, so the title renders narrower here than the
   real page, where it is set at wdth 125. Everything else is pixel-true. */

export async function capture(name = 'shot') {
  const P = window.PLANET;
  if (!P) throw new Error('PLANET not ready');

  const gl = P.renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;

  P.renderer.render(P.scene, P.camera);
  const raw = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');

  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim() || '#070b12';
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, w, h);

  const stars = document.getElementById('stars');
  if (stars) ctx.drawImage(stars, 0, 0, w, h);

  /* Title, under the globe layer — this is the eclipse. */
  const titleEl = document.getElementById('title');
  if (titleEl && getComputedStyle(titleEl).display !== 'none') {
    const scale = w / document.documentElement.clientWidth;
    const cs = getComputedStyle(titleEl);
    const px = parseFloat(cs.fontSize) * scale;
    ctx.save();
    ctx.globalAlpha = parseFloat(cs.opacity) || 1;
    ctx.fillStyle = cs.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `800 ${px}px Archivo, sans-serif`;
    ctx.fillText('OUR BEAUTIFUL PLANET', w / 2, titleEl.getBoundingClientRect().top * scale);
    ctx.restore();
  }

  /* The maker's mark sits above the globe layer, so it is drawn after it
     below — but measure it now while the DOM is untouched. */
  const creditEl = document.getElementById('credit');
  const creditBox = creditEl && getComputedStyle(creditEl).display !== 'none'
    ? creditEl.getBoundingClientRect() : null;

  /* WebGL's origin is bottom-left; flip into the 2D canvas. */
  const img = new ImageData(new Uint8ClampedArray(raw.buffer), w, h);
  const flip = document.createElement('canvas');
  flip.width = w;
  flip.height = h;
  flip.getContext('2d').putImageData(img, 0, 0);
  ctx.save();
  ctx.translate(0, h);
  ctx.scale(1, -1);
  ctx.drawImage(flip, 0, 0);
  ctx.restore();

  if (creditBox) {
    const scale = w / document.documentElement.clientWidth;
    const label = creditEl.querySelector('span');
    const name = creditEl.querySelector('b');
    const ls = getComputedStyle(label);
    const ns = getComputedStyle(name);
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    const right = creditBox.right * scale;

    ctx.fillStyle = ls.color;
    ctx.font = `${parseFloat(ls.fontSize) * scale}px ${ls.fontFamily}`;
    /* Canvas has no letter-spacing in every engine, so the tracked label is
       drawn glyph by glyph to match what the page actually shows. */
    const track = parseFloat(ls.letterSpacing) * scale || 0;
    const text = label.textContent.toUpperCase();
    let x = right;
    for (let i = text.length - 1; i >= 0; i -= 1) {
      const ch = text[i];
      x -= ctx.measureText(ch).width + track;
      ctx.textAlign = 'left';
      ctx.fillText(ch, x, (creditBox.top + parseFloat(ls.fontSize)) * scale);
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = ns.color;
    ctx.font = `${parseFloat(ns.fontSize) * scale}px ${ns.fontFamily}`;
    ctx.fillText(name.textContent, right, (creditBox.bottom - 4) * scale);
    ctx.restore();
  }

  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const res = await fetch(`/_shot/${name}.png`, { method: 'POST', body: blob });
  return `${await res.text()} [${w}x${h}]`;
}
