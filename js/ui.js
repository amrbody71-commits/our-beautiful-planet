/* ui.js — draw the site's own interface into a capture frame.

   The reel has to show what a visitor actually sees: the title the planet
   eclipses, the UTC clock, the Beautiful News rail down the left, and the
   monitor docked right with a camera playing in it. The first cut showed a
   bare globe on a starfield and read as a screensaver rather than a site.

   None of that can be screen-recorded. The browser pane does not composite,
   so a GL canvas screenshots black and DOM screenshots time out; and the
   monitor's picture is a cross-origin YouTube iframe, which cannot be read
   back at any resolution by anything running in the page.

   So the interface is redrawn here on a 2D canvas, from the same data and
   the same webfonts the live page uses, and the live picture is composited
   into the monitor afterwards by ffmpeg — screenRect() is where it goes.

   Everything is expressed in the 1920x1080 design space the CSS was written
   against and multiplied by `s`, so a 2560-wide supersampled capture lays
   out identically to a 1920 viewport instead of re-flowing.

   Canvas cannot set a variable font's width axis, and this page leans on it
   hard (the title is Archivo at wdth 125). Text that needs a width axis is
   therefore drawn through `stretched()`, which measures the string and
   scales it horizontally to the width the real element occupies. */

const DW = 1920;
const DH = 1080;

/* ---- palette, lifted from the page's custom properties -------------- */
const C = {
  bone: '#e8e3d8',
  dim: '#7d8b99',
  tally: '#ff8c42',
  glacier: '#a8c8d8',
  signal: '#ff3ea8',
  sig: '#ff3b30',
  line: '#1e2a38',
  slate: '#101a26',
};

/* Archivo's width axis, approximated by horizontal scale. Measured against
   the live page: wdth 125 runs ~1.10x the default advance, wdth 112 ~1.05x. */
const WDTH = { 125: 1.10, 112: 1.05, 100: 1 };

function stretched(ctx, text, cx, y, factor, align = 'center') {
  const w = ctx.measureText(text).width * factor;
  let x = cx;
  if (align === 'center') x = cx - w / 2;
  else if (align === 'right') x = cx - w;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(factor, 1);
  ctx.textAlign = 'left';
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return w;
}

/* Canvas has no letter-spacing in most engines; tracked runs are set glyph
   by glyph so the page's wide mono labels survive. */
function tracked(ctx, text, x, y, spacing, align = 'left') {
  const chars = [...text];
  const total = chars.reduce((sum, ch) => sum + ctx.measureText(ch).width + spacing, -spacing);
  let px = x;
  if (align === 'center') px = x - total / 2;
  else if (align === 'right') px = x - total;
  for (const ch of chars) {
    ctx.fillText(ch, px, y);
    px += ctx.measureText(ch).width + spacing;
  }
  return total;
}

/* The page's chrome is set in --dim and --bone straight onto the void,
   which works on a dark sky and disappears the moment the planet's daylit
   limb slides under it. A soft shadow costs nothing on the site's own look
   and keeps the readouts legible for the whole shot. */
function shade(ctx, s, strength = 0.66, blur = 18) {
  ctx.shadowColor = `rgba(0,0,0,${strength})`;
  ctx.shadowBlur = blur * s;
}

/* Reused across frames: allocating a 560x511 canvas 1000 times is pure
   garbage-collector pressure. */
let blurPad = null;

/* CSS gives the monitor `backdrop-filter: blur(10px)`, and without it the
   coastlines behind the panel stay razor sharp through the .92 fill and
   the whole thing reads as a flat rectangle pasted on top. */
function backdropBlur(ctx, x, y, w, h, radius, s) {
  const px = Math.round(x);
  const py = Math.round(y);
  const pw = Math.ceil(w);
  const ph = Math.ceil(h);
  if (pw <= 0 || ph <= 0) return;

  if (!blurPad || blurPad.width < pw || blurPad.height < ph) {
    blurPad = document.createElement('canvas');
    blurPad.width = pw;
    blurPad.height = ph;
  }
  const pad = blurPad.getContext('2d');
  pad.clearRect(0, 0, pw, ph);
  pad.drawImage(ctx.canvas, px, py, pw, ph, 0, 0, pw, ph);

  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.filter = `blur(${10 * s}px)`;
  /* Drawn slightly oversized so the blur does not pull transparent pixels
     in from beyond the panel's own edges. */
  ctx.drawImage(blurPad, 0, 0, pw, ph, px - 6 * s, py - 6 * s, pw + 12 * s, ph + 12 * s);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---- monitor geometry ------------------------------------------------
   Held as constants rather than measured off the DOM: the capture runs in
   a pane that is not 1920 wide, so getBoundingClientRect would report a
   different layout than the one being drawn. These mirror the CSS —
   right:22px, width:min(560px,40vw), top:50% with translateY(-50%). */
const MON = {
  w: 560,
  right: 22,
  screenH: 315,          // 560 at 16/9
  padX: 15,
  padTop: 13,
  padBottom: 15,
};
MON.x = DW - MON.right - MON.w;
MON.bodyH = 199;
MON.h = MON.screenH + MON.bodyH;
MON.y = (DH - MON.h) / 2;

export function screenRect() {
  return { x: MON.x, y: MON.y, w: MON.w, h: MON.screenH };
}

/* ---- the eclipsed title --------------------------------------------- */
function drawTitle(ctx, s, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha * 0.93;
  ctx.fillStyle = C.bone;
  ctx.textBaseline = 'alphabetic';

  /* top:20vh, and the CSS caps the size at 6.4rem before 5.7vw overtakes
     it, so at 1920 the type is 102.4px on a .92 line box. */
  const size = 102.4;
  const top = DH * 0.20;
  ctx.font = `800 ${size * s}px Archivo`;
  /* The measured target: 94% of the viewport, which is what wdth 125 buys. */
  const target = DW * 0.94 * s;
  const natural = ctx.measureText('OUR BEAUTIFUL PLANET').width;
  stretched(ctx, 'OUR BEAUTIFUL PLANET', (DW / 2) * s, (top + size * 0.78) * s,
    target / natural);

  ctx.globalAlpha = alpha * 0.75;
  ctx.fillStyle = C.dim;
  ctx.font = `400 ${12.48 * s}px "IBM Plex Mono"`;
  tracked(ctx, 'LIVE CAMERAS · RIGHT NOW', (DW / 2) * s,
    (top + size * 0.78 + 12.48 * 1.1 + 14) * s, 12.48 * 0.34 * s, 'center');
  ctx.restore();
}

/* ---- clock, tally, signature ---------------------------------------- */
function drawClock(ctx, s, alpha, text) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  shade(ctx, s, 0.7, 22);
  const baseline = (26 + 27) * s;

  ctx.font = `700 ${34 * s}px Archivo`;
  const utcW = ctx.measureText('UTC').width; // measured in the mono face below
  ctx.font = `400 ${10 * s}px "IBM Plex Mono"`;
  const labelW = [...'UTC'].reduce((a, ch) => a + ctx.measureText(ch).width + 10 * 0.28 * s, -10 * 0.28 * s);

  ctx.font = `700 ${34 * s}px Archivo`;
  const timeW = ctx.measureText(text).width * WDTH[125];
  const gap = 10 * s;
  const total = timeW + gap + labelW;
  const left = (DW / 2) * s - total / 2;

  ctx.fillStyle = '#ffffff';
  stretched(ctx, text, left, baseline, WDTH[125], 'left');

  ctx.fillStyle = C.dim;
  ctx.font = `400 ${10 * s}px "IBM Plex Mono"`;
  tracked(ctx, 'UTC', left + timeW + gap, baseline, 10 * 0.28 * s, 'left');
  ctx.restore();
  void utcW;
}

function drawTally(ctx, s, alpha, count, where) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  shade(ctx, s, 0.7, 18);
  const baseline = (DH - 24 - 3) * s;

  ctx.font = `800 ${15 * s}px Archivo`;
  const numW = ctx.measureText(count).width * WDTH[125];
  ctx.font = `500 ${11 * s}px Archivo`;
  const label = where.toUpperCase();
  const trackPx = 11 * 0.2 * s;
  const labelW = [...label].reduce((a, ch) => a + ctx.measureText(ch).width * WDTH[112] + trackPx, -trackPx);

  const gap = 6 * s;
  const left = (DW / 2) * s - (numW + gap + labelW) / 2;

  ctx.fillStyle = C.bone;
  ctx.font = `800 ${15 * s}px Archivo`;
  stretched(ctx, count, left, baseline, WDTH[125], 'left');

  ctx.fillStyle = C.dim;
  ctx.font = `500 ${11 * s}px Archivo`;
  let px = left + numW + gap;
  for (const ch of label) {
    ctx.save();
    ctx.translate(px, baseline);
    ctx.scale(WDTH[112], 1);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    px += ctx.measureText(ch).width * WDTH[112] + trackPx;
  }
  ctx.restore();
}

function drawCredit(ctx, s, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  shade(ctx, s, 0.65, 16);
  const right = (DW - 26) * s;

  ctx.fillStyle = '#55616e';
  ctx.font = `400 ${8.5 * s}px "IBM Plex Mono"`;
  tracked(ctx, 'MADE BY', right, (DH - 20 - 32) * s, 8.5 * 0.2 * s, 'right');

  ctx.fillStyle = '#ffffff';
  ctx.font = `400 ${30 * s}px Italianno`;
  ctx.textAlign = 'right';
  ctx.fillText('Abdelrahman Shaaban', right, (DH - 20 - 4) * s);
  ctx.restore();
}

/* ---- Beautiful News rail --------------------------------------------
   The live rail drifts a full list length every 240s, which over a
   five-second shot is nearly still; `drift` carries the same slow travel
   so the column is visibly alive without becoming the subject. */
function drawNews(ctx, s, alpha, charts, drift) {
  if (alpha <= 0 || !charts.length) return;
  const x = 22;
  const w = 172;
  const top = 96;
  const bottom = DH - 20;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  shade(ctx, s, 0.6, 14);

  /* head */
  ctx.fillStyle = C.tally;
  ctx.fillRect(x * s, top * s, 2 * s, 15 * s);
  ctx.fillStyle = C.bone;
  ctx.font = `700 ${12 * s}px Archivo`;
  stretched(ctx, 'Beautiful News ↗', (x + 11) * s, (top + 11) * s, WDTH[112], 'left');

  /* window, masked top and bottom so cards enter and leave */
  const winTop = top + 26;
  const winBottom = bottom - 26;
  const winH = winBottom - winTop;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x * s, winTop * s, w * s, winH * s);
  ctx.clip();

  let y = winTop - (drift % 260);
  for (let i = 0; y < winBottom + 120; i += 1) {
    const c = charts[i % charts.length];
    if (c.img) {
      const ih = Math.min(w * c.img.height / c.img.width, 118);
      ctx.save();
      ctx.globalAlpha = alpha * 0.92;
      ctx.filter = 'brightness(1.16) saturate(1.08)';
      roundRect(ctx, x * s, y * s, w * s, ih * s, 4 * s);
      ctx.clip();
      ctx.drawImage(c.img, x * s, y * s, w * s, ih * s);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#2a3846';
      ctx.lineWidth = Math.max(1, s);
      roundRect(ctx, x * s, y * s, w * s, ih * s, 4 * s);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#a9b6c3';
      ctx.font = `300 ${10.5 * s}px "IBM Plex Sans"`;
      const t = c.title.length > 30 ? `${c.title.slice(0, 28)}…` : c.title;
      ctx.fillText(t, x * s, (y + ih + 14) * s);
      y += ih + 14 + 12 + 6;
    } else {
      y += 120;
    }
  }
  ctx.restore();

  /* The CSS masks the ends of the window; reproduce it by painting the
     page ground back over the top and bottom with a gradient. */
  const fade = 22;
  for (const [gy, gh, dir] of [[winTop, fade, 1], [winBottom - fade, fade, -1]]) {
    const g = ctx.createLinearGradient(0, gy * s, 0, (gy + gh) * s);
    g.addColorStop(dir > 0 ? 0 : 1, 'rgba(7,11,18,1)');
    g.addColorStop(dir > 0 ? 1 : 0, 'rgba(7,11,18,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x * s, gy * s, w * s, gh * s);
  }

  ctx.fillStyle = '#7a8794';
  ctx.font = `400 ${8.5 * s}px "IBM Plex Mono"`;
  ctx.fillText('A project by Information is', x * s, (bottom - 12) * s);
  ctx.fillText('Beautiful · CC BY-SA 4.0', x * s, (bottom - 2) * s);
  ctx.restore();
}

/* ---- the enlarged chart ---------------------------------------------
   Hovering a card in the rail opens the chart at a size you can actually
   read, beside the rail rather than over it. Without it the news beat is
   just the globe with the line "Good news, every day" over it, and the
   thing being named never appears at a size anyone can see. Mirrors the
   CSS: left:206px, width min(470px, 38vw), centred on its card. */
function drawNewsZoom(ctx, s, alpha, chart) {
  if (alpha <= 0 || !chart || !chart.img) return;
  const x = 206;
  const w = 470;
  const pad = 10;
  const imgW = w - pad * 2;
  const imgH = Math.round(imgW * chart.img.height / chart.img.width);
  const capH = 46;
  const h = imgH + pad * 2 + capH;
  const y = Math.max(12, Math.min(DH - h - 12, (DH - h) / 2));

  ctx.save();
  ctx.globalAlpha = alpha;

  /* box-shadow: 0 18px 50px rgba(0,0,0,.6) */
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 50 * s;
  ctx.shadowOffsetY = 18 * s;
  backdropBlur(ctx, x * s, y * s, w * s, h * s, 8 * s, s);
  ctx.fillStyle = 'rgba(11,18,27,0.96)';
  roundRect(ctx, x * s, y * s, w * s, h * s, 8 * s);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = '#2a3846';
  ctx.lineWidth = Math.max(1, s);
  roundRect(ctx, x * s, y * s, w * s, h * s, 8 * s);
  ctx.stroke();

  ctx.save();
  roundRect(ctx, (x + pad) * s, (y + pad) * s, imgW * s, imgH * s, 4 * s);
  ctx.clip();
  ctx.drawImage(chart.img, (x + pad) * s, (y + pad) * s, imgW * s, imgH * s);
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.bone;
  ctx.font = `300 ${12 * s}px "IBM Plex Sans"`;
  const title = chart.title.length > 58 ? `${chart.title.slice(0, 56)}…` : chart.title;
  ctx.fillText(title, (x + pad) * s, (y + pad + imgH + 20) * s);

  ctx.fillStyle = '#7a8794';
  ctx.font = `400 ${9 * s}px "IBM Plex Mono"`;
  tracked(ctx, 'INFORMATION IS BEAUTIFUL · CC BY-SA 4.0',
    (x + pad) * s, (y + pad + imgH + 36) * s, 9 * 0.08 * s, 'left');
  ctx.restore();
}

/* ---- the docked monitor --------------------------------------------- */
function fmtUptime(days) {
  if (days == null) return 'unverified';
  if (days >= 365) return `${(days / 365).toFixed(1)}y unbroken`;
  if (days >= 1) return `${Math.round(days)}d unbroken`;
  return 'just restarted';
}

function fmtCoords(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

function drawMonitor(ctx, s, alpha, cam, slide, pulse) {
  if (alpha <= 0 || !cam) return;
  const x = MON.x + slide * 14;
  const y = MON.y;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';

  /* panel */
  backdropBlur(ctx, x * s, y * s, MON.w * s, MON.h * s, 8 * s, s);
  ctx.fillStyle = 'rgba(16,26,38,0.92)';
  roundRect(ctx, x * s, y * s, MON.w * s, MON.h * s, 8 * s);
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = Math.max(1, s);
  ctx.stroke();

  /* The screen is left as a dark plate — ffmpeg lays the real camera into
     this exact rectangle afterwards. */
  ctx.save();
  roundRect(ctx, x * s, y * s, MON.w * s, MON.h * s, 8 * s);
  ctx.clip();
  ctx.fillStyle = '#05090f';
  ctx.fillRect(x * s, y * s, MON.w * s, MON.screenH * s);
  ctx.restore();

  /* tally badge */
  const bx = x + 8;
  const by = y + 8;
  ctx.fillStyle = 'rgba(0,0,0,0.66)';
  ctx.font = `400 ${10.5 * s}px "IBM Plex Mono"`;
  const label = cam.viewers != null ? `${cam.viewers} WATCHING` : 'LIVE';
  const tw = [...label].reduce((a, ch) => a + ctx.measureText(ch).width + 10.5 * 0.06 * s, -10.5 * 0.06 * s);
  roundRect(ctx, bx * s, by * s, (tw / s + 14 + 12) * s, 17 * s, 4 * s);
  ctx.fill();
  ctx.save();
  ctx.globalAlpha = alpha * pulse;
  ctx.fillStyle = C.sig;
  ctx.beginPath();
  ctx.arc((bx + 11) * s, (by + 8.5) * s, 3 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = C.bone;
  tracked(ctx, label, (bx + 20) * s, (by + 12) * s, 10.5 * 0.06 * s, 'left');

  /* body */
  const tx = x + MON.padX;
  let ty = y + MON.screenH + MON.padTop;

  ctx.fillStyle = C.bone;
  ctx.font = `700 ${17 * s}px Archivo`;
  stretched(ctx, cam.name, tx * s, (ty + 14) * s, WDTH[112], 'left');
  ty += 19.55 + 4;

  ctx.fillStyle = C.dim;
  ctx.font = `300 ${13 * s}px "IBM Plex Sans"`;
  ctx.fillText(`${cam.place}, ${cam.country}`, tx * s, (ty + 11) * s);
  ty += 15.6 + 10;

  ctx.strokeStyle = C.line;
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  ctx.moveTo(tx * s, ty * s);
  ctx.lineTo((x + MON.w - MON.padX) * s, ty * s);
  ctx.stroke();
  ty += 10;

  const rows = [
    ['LOCAL TIME', cam.localText || '—', C.tally],
    ['POSITION', fmtCoords(cam.lat, cam.lon), C.glacier],
    ['RUNNING', fmtUptime(cam.uptime_days), C.glacier],
    ['LIGHT', cam.lightText || '—', C.tally],
  ];
  ctx.font = `400 ${11 * s}px "IBM Plex Mono"`;
  for (const [dt, dd, colour] of rows) {
    ctx.fillStyle = '#5f6b78';
    tracked(ctx, dt, tx * s, (ty + 9) * s, 11 * 0.05 * s, 'left');
    ctx.fillStyle = colour;
    ctx.textAlign = 'right';
    ctx.fillText(dd, (x + MON.w - MON.padX) * s, (ty + 9) * s);
    ctx.textAlign = 'left';
    ty += 17.3;
  }

  /* watch button */
  ty += 11;
  const bw = MON.w - MON.padX * 2;
  ctx.strokeStyle = C.tally;
  ctx.lineWidth = Math.max(1, s);
  roundRect(ctx, tx * s, ty * s, bw * s, 30 * s, 4 * s);
  ctx.stroke();
  ctx.fillStyle = C.tally;
  ctx.font = `400 ${11.5 * s}px "IBM Plex Mono"`;
  tracked(ctx, 'WATCH ON YOUTUBE', (tx + bw / 2) * s, (ty + 19) * s, 11.5 * 0.12 * s, 'center');

  ctx.restore();
}

/* ---- leader line ----------------------------------------------------
   Drawn before the monitor so the panel occludes its end, exactly as the
   z-order does on the page (#leader is z-index 3, #monitor is 4). */
function drawLeader(ctx, s, alpha, pin, ring) {
  if (alpha <= 0 || !pin) return;
  ctx.save();
  ctx.globalAlpha = alpha * 0.55;
  ctx.strokeStyle = C.signal;
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  ctx.moveTo(pin.x, pin.y);
  ctx.lineTo(MON.x * s, (MON.y + MON.screenH / 2) * s);
  ctx.stroke();

  ctx.globalAlpha = alpha * 0.85;
  ctx.beginPath();
  ctx.arc(pin.x, pin.y, ring * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* ---- narrative type -------------------------------------------------
   Sits in the corridor between the rail and the monitor rather than the
   middle of the frame, so it never lands on either. */
export const TEXT_CX = (22 + 172 + (DW - 22 - MON.w)) / 2;

function drawNarrative(ctx, s, alpha, lines, eyebrow, centre) {
  if (alpha <= 0 || !lines.length) return;
  const cx = centre * s;
  const baseY = 872;

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  /* A soft band of shade so the type holds over a daylit ocean. */
  const top = (baseY - 78) * s;
  const height = (lines.length * 54 + 96) * s;
  const g = ctx.createLinearGradient(0, top, 0, top + height);
  g.addColorStop(0, 'rgba(4,8,14,0)');
  g.addColorStop(0.35, `rgba(4,8,14,${0.5 * alpha})`);
  g.addColorStop(0.65, `rgba(4,8,14,${0.5 * alpha})`);
  g.addColorStop(1, 'rgba(4,8,14,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, top, DW * s, height);

  ctx.globalAlpha = alpha;
  if (eyebrow) {
    ctx.fillStyle = C.signal;
    ctx.font = `600 ${21 * s}px "IBM Plex Mono"`;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 20 * s;
    tracked(ctx, eyebrow.toUpperCase(), cx, (baseY - 34) * s, 7 * s, 'center');
  }
  ctx.fillStyle = '#f2efe8';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 30 * s;
  lines.forEach((ln, i) => {
    ctx.font = `800 ${52 * s}px Archivo`;
    stretched(ctx, ln, cx, (baseY + 22 + i * 58) * s, WDTH[112]);
  });
  ctx.restore();
}

/* ---- entry point ----------------------------------------------------- */
export function drawChrome(ctx, width, opts) {
  const s = width / DW;
  const {
    uiAlpha = 1, titleAlpha = 1, monitorAlpha = 0, monitorSlide = 0,
    cam = null, clockText = '--:--:--', count = '284',
    where = 'live cameras · 53 countries', charts = [], drift = 0, railAlpha = null,
    pin = null, ring = 9, pulse = 1,
    lines = [], eyebrow = '', textAlpha = 0,
    zoomAlpha = 0, zoomIndex = 0,
  } = opts;

  drawTitle(ctx, s, titleAlpha);
  drawLeader(ctx, s, monitorAlpha, pin, ring);
  /* The rail sits over the title's first letter — true of the live page
     too, where #news (z3) covers #title (z1) between x 22 and 194. Faithful,
     but on the closing beat it turns OUR into UR, so the rail steps aside
     while the title is the subject. */
  drawNews(ctx, s, railAlpha == null ? uiAlpha : railAlpha, charts, drift);
  drawClock(ctx, s, uiAlpha, clockText);
  drawTally(ctx, s, uiAlpha, count, where);
  drawCredit(ctx, s, uiAlpha);
  drawNewsZoom(ctx, s, zoomAlpha, charts[zoomIndex % (charts.length || 1)]);
  drawMonitor(ctx, s, monitorAlpha, cam, monitorSlide, pulse);
  drawNarrative(ctx, s, textAlpha, lines, eyebrow,
    monitorAlpha > 0.15 ? TEXT_CX : DW / 2);
}

/* Chart artwork for the rail, from the local copies — the S3 originals
   refuse the cross-origin request and every image would fail silently. */
export async function loadCharts() {
  const stories = await (await fetch('./reel/charts/index.json')).json();
  return Promise.all(stories.map((st) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve({ ...st, img: im });
    im.onerror = () => resolve({ ...st, img: null });
    im.src = `./${st.file}`;
  })));
}
