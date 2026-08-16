/* titles.js — render the reel's text cards and the Beautiful News panorama.

   Text is drawn in the browser rather than by ffmpeg's drawtext because
   this is where the real fonts live: Archivo at width 125 and Italianno
   are loaded by the page, and ffmpeg would otherwise substitute something
   generic. Each card is a transparent 1920x1080 PNG that the edit lays
   over the footage, so type and footage stay independently adjustable. */

const W = 1920;
const H = 1080;

function card(draw) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  x.textBaseline = 'alphabetic';
  draw(x);
  return c;
}

/* Canvas has no letter-spacing in most engines, so tracked lines are set
   glyph by glyph. */
function tracked(ctx, text, cx, y, spacing) {
  const chars = [...text];
  const total = chars.reduce((sum, ch) => sum + ctx.measureText(ch).width + spacing, -spacing);
  let x = cx - total / 2;
  for (const ch of chars) {
    ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width + spacing;
  }
  return total;
}

/* A soft band of shade behind the text block.

   A drop shadow alone is not enough: the type has to hold over a daylit
   ocean, over Blue Marble ice, and over Beautiful News charts in saturated
   yellow and magenta. This is the standard lower-third answer — a vertical
   gradient that peaks behind the words and fades to nothing well before the
   frame edge, so it reads as depth rather than as a drawn box. */
function scrim(ctx, yTop, yBottom) {
  const pad = 130;
  const g = ctx.createLinearGradient(0, yTop - pad, 0, yBottom + pad);
  g.addColorStop(0, 'rgba(4,8,14,0)');
  g.addColorStop(0.32, 'rgba(4,8,14,0.52)');
  g.addColorStop(0.68, 'rgba(4,8,14,0.52)');
  g.addColorStop(1, 'rgba(4,8,14,0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, yTop - pad, W, (yBottom - yTop) + pad * 2);
  ctx.restore();
}

function headline(ctx, text, y, size, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#f2efe8';
  ctx.font = `800 ${size}px Archivo`;
  ctx.textAlign = 'center';
  /* A soft shadow keeps white type legible over a bright daylit ocean. */
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 34;
  ctx.fillText(text, W / 2, y);
  ctx.restore();
}

/* 19px was unreadable at any sensible viewing size — on a phone the place
   names were a pink smear. 27px with wider tracking keeps the instrument
   voice and can actually be read. */
function eyebrow(ctx, text, y, alpha = 1, colour = '#ff5cb8') {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  ctx.font = '600 27px "IBM Plex Mono"';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.72)';
  ctx.shadowBlur = 24;
  tracked(ctx, text.toUpperCase(), W / 2, y, 9);
  ctx.restore();
}

export const CARDS = {
  open: () => card((x) => {
    scrim(x, 440, 680);
    eyebrow(x, 'Our Beautiful Planet', 470);
    headline(x, 'I built a globe', 560, 96);
    headline(x, 'of live webcams', 664, 96);
  }),

  volcano: () => card((x) => {
    scrim(x, 536, 676);
    eyebrow(x, 'Mount Etna · Sicily', 566);
    headline(x, 'From volcanoes', 660, 88);
  }),

  city: () => card((x) => {
    scrim(x, 536, 676);
    eyebrow(x, 'Shibuya Crossing · Tokyo', 566);
    headline(x, 'to festival streets', 660, 88);
  }),

  aurora: () => card((x) => {
    scrim(x, 516, 742);
    eyebrow(x, 'Kilpisjärvi · Lapland', 546);
    headline(x, 'and if you are lucky,', 640, 76);
    headline(x, 'the northern lights', 726, 76);
  }),

  greenland: () => card((x) => {
    scrim(x, 536, 676);
    eyebrow(x, 'Ilulissat · Greenland', 566);
    headline(x, 'Check out Greenland', 660, 84);
  }),

  news: () => card((x) => {
    /* This card lands over saturated chart artwork, so its shade runs
       deeper and wider than the ones that sit over ocean. */
    x.save();
    const g = x.createLinearGradient(0, 400, 0, 800);
    g.addColorStop(0, 'rgba(4,8,14,0)');
    g.addColorStop(0.35, 'rgba(4,8,14,0.78)');
    g.addColorStop(0.65, 'rgba(4,8,14,0.78)');
    g.addColorStop(1, 'rgba(4,8,14,0)');
    x.fillStyle = g;
    x.fillRect(0, 400, W, 400);
    x.restore();
    eyebrow(x, 'Beautiful News · Information is Beautiful', 566);
    headline(x, 'Good news, every day', 660, 80);
  }),

  close: () => card((x) => {
    scrim(x, 470, 830);
    headline(x, '284 live cameras', 512, 100);
    headline(x, '53 countries. All from YouTube.', 606, 58, 0.92);
    x.save();
    x.globalAlpha = 1;
    x.fillStyle = '#ff5cb8';
    x.font = '600 26px "IBM Plex Mono"';
    x.shadowColor = 'rgba(0,0,0,0.7)';
    x.shadowBlur = 22;
    tracked(x, 'OURBEAUTIFULPLANET.VERCEL.APP', W / 2, 706, 9);
    x.restore();
    /* The signature, in the same hand as the site itself. At 46px it was
       lost against the planet; this is the last thing on screen and it
       should be legible. */
    x.save();
    x.globalAlpha = 1;
    x.fillStyle = '#ffffff';
    x.font = '400 78px Italianno';
    x.textAlign = 'center';
    x.shadowColor = 'rgba(0,0,0,0.6)';
    x.shadowBlur = 26;
    x.fillText('Abdelrahman Shaaban', W / 2, 812);
    x.restore();
  }),
};

/* A wide plate the edit pans across: the site's news rail, built from the
   real cached stories and their real chart artwork. */
export async function newsPanorama(scale = 1) {
  /* Charts are read from local copies, not from their S3 home: that host
     refuses the cross-origin request, so every image failed silently and
     the panorama came out empty. */
  const res = await fetch('./reel/charts/index.json');
  const stories = await res.json();

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');

  x.fillStyle = '#070b12';
  x.fillRect(0, 0, W, H);

  const imgs = await Promise.all(stories.map((s) => new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = `./${s.file}`;
  })));

  const cols = 3;
  const cw = 470;
  const gap = 44;
  const startX = (W - (cols * cw + (cols - 1) * gap)) / 2;
  let col = 0;
  let row = 0;

  for (let i = 0; i < imgs.length; i += 1) {
    const im = imgs[i];
    if (!im) continue;
    const px = startX + col * (cw + gap);
    const ch = Math.round(cw * im.height / im.width);
    const py = 150 + row * 430;
    x.save();
    x.globalAlpha = 0.96;
    x.filter = 'brightness(1.12) saturate(1.06)';
    x.drawImage(im, px, py, cw, Math.min(ch, 300));
    x.restore();
    x.fillStyle = '#a9b6c3';
    x.font = '400 17px "IBM Plex Sans"';
    x.textAlign = 'left';
    const t = stories[i].title;
    x.fillText(t.length > 46 ? `${t.slice(0, 44)}…` : t, px, py + Math.min(ch, 300) + 28);
    col += 1;
    if (col === cols) { col = 0; row += 1; }
  }
  return c;
}

export async function renderAll() {
  await document.fonts.ready;
  const out = [];
  for (const [name, make] of Object.entries(CARDS)) {
    const canvas = make();
    /* eslint-disable no-await-in-loop */
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await fetch(`/_shot/titles/${name}.png`, { method: 'POST', body: blob });
    out.push(`${name} ${(blob.size / 1024).toFixed(0)}KB`);
  }
  const pano = await newsPanorama();
  const pblob = await new Promise((r) => pano.toBlob(r, 'image/png'));
  await fetch('/_shot/titles/news-panorama.png', { method: 'POST', body: pblob });
  out.push(`news-panorama ${(pblob.size / 1024).toFixed(0)}KB`);
  return out;
}
