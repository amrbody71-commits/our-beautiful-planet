/* data.js — load livecams.json and refuse to trust it.

   refresh.py rewrites this file: it drops dead streams, promotes failover
   alternates, and can be re-run at any time. So the page treats it as
   untrusted input — filter anything missing the fields the globe needs,
   never index by array position, and tolerate absent optional fields
   rather than throwing.

   The camera count is data, not a constant. Nothing here or downstream may
   hardcode it. */

const CATEGORY_FAMILY = {
  city: 'urban', street: 'urban', plaza: 'urban', skyline: 'urban',
  town: 'urban', landmark: 'urban',
  beach: 'water', coast: 'water', harbor: 'water', river: 'water',
  underwater: 'water', aquarium: 'water', waterfall: 'water',
  wildlife: 'wild', rainforest: 'wild', desert: 'wild', park: 'wild',
  airport: 'transit', rail: 'transit',
  volcano: 'earth', mountain: 'earth', glacier: 'earth', ice: 'earth',
  geyser: 'earth',
  aurora: 'sky',
};

export const FAMILIES = ['urban', 'water', 'wild', 'transit', 'earth', 'sky'];

function valid(cam) {
  return cam
    && typeof cam.id === 'string' && cam.id.length > 3
    && Number.isFinite(cam.lat) && Math.abs(cam.lat) <= 90
    && Number.isFinite(cam.lon) && Math.abs(cam.lon) <= 180
    && typeof cam.url === 'string';
}

export async function loadCams(url = './livecams.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`livecams ${res.status}`);
  const doc = await res.json();

  const raw = Array.isArray(doc.cams) ? doc.cams : [];
  const cams = raw.filter(valid).map((cam, index) => ({
    ...cam,
    index,
    family: CATEGORY_FAMILY[cam.category] || 'urban',
    /* Optional fields the globe reads; give them defined shapes so no
       consumer has to null-check per frame. */
    viewers: Number.isFinite(cam.viewers) ? cam.viewers : null,
    uptime_days: Number.isFinite(cam.uptime_days) ? cam.uptime_days : null,
    stability: cam.stability || 'unknown',
    alternates: Array.isArray(cam.alternates) ? cam.alternates : [],
  }));

  const dropped = raw.length - cams.length;
  if (dropped > 0) console.warn(`[planet] dropped ${dropped} malformed cam entries`);

  return {
    cams,
    dropped,
    generated: doc.generated || null,
    /* Freshness is surfaced rather than hidden: an old file means the
       stream list may have rotted, and the reader should be able to see
       that instead of wondering why a camera is black. */
    ageDays: doc.generated
      ? Math.round((Date.now() - new Date(doc.generated).getTime()) / 86400000)
      : null,
  };
}
