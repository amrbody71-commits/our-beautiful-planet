/* boot.js — read the flags, pick a path, retire the loader.

     ?grid=1            → fallback.js (the flat contact sheet, on request)
     no WebGL2 (floor)  → fallback.js (feature-detected, never UA-sniffed)
     otherwise          → app.js with a resolved tier from quality.js

   Every flag is read here and nowhere else, so the URL surface stays
   documented in one place. */

import { detectTier } from './quality.js';

const params = new URLSearchParams(location.search);

window.PLANET_FLAGS = {
  tier: params.get('tier'),                                  // base|mid|high|1|2|3
  grid: params.has('grid') && params.get('grid') !== '0',     // force the flat list
  stats: params.has('stats'),                                 // draw-call readout
  check: params.has('check') && params.get('check') !== '0',   // geographic self-test
  utc: params.get('utc'),                                     // freeze the sun (U4)
  borders: params.get('borders') || '110m',                   // 110m | 50m (U2)
  quality: null,                                              // resolved tier object
};

const loader = document.getElementById('loader');
const retireLoader = () => loader && loader.classList.add('done');

/* Both paths dispatch `planet:ready` — the app after its first rendered
   frame, the fallback once its grid is built. */
addEventListener('planet:ready', retireLoader, { once: true });

async function boot() {
  if (window.PLANET_FLAGS.grid) {
    const fallback = await import('./fallback.js');
    return fallback.start();
  }

  const tier = detectTier(params.get('tier'));

  if (tier.name === 'floor') {
    const fallback = await import('./fallback.js');
    return fallback.start();
  }

  window.PLANET_FLAGS.tier = tier.name;
  window.PLANET_FLAGS.quality = tier;
  const app = await import('./app.js');
  return app.start();
}

boot().catch((err) => {
  console.error('[planet] boot failed:', err);
  if (loader) {
    loader.innerHTML =
      '<p class="boot-err">The globe did not start.<br>' +
      String((err && err.message) || err).slice(0, 300) + '</p>';
  }
});
