/* sun.js — where the sun actually is, right now.

   This is the honest engine behind the page's one big idea: the globe is
   not lit from a decorative angle, it is lit from the real subsolar point,
   so half the cameras are genuinely in darkness and you can see which.

   Low-precision solar position (NOAA / Astronomical Almanac form). Good to
   ~0.01° in declination, which is three orders of magnitude better than a
   one-pixel terminator needs.

   SPACE CONVENTION — the thing that silently breaks this feature:

   The sun direction is computed in EARTH-FIXED space, the same space
   latLonToVec3 produces, and the shader compares it against the OBJECT
   normal. Both rotate with the globe group, so dragging the planet leaves
   the lit region over the same countries. Mixing spaces — a world-space
   sun against an object normal, or vice versa — makes the terminator
   rotate with the continents, which looks plausible and is wrong. */

import { latLonToVec3, normalize180 } from './geo.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/* Days since the J2000.0 epoch. */
function daysSinceJ2000(date) {
  return date.getTime() / 86400000 + 2440587.5 - 2451545.0;
}

export function subsolarPoint(date = new Date()) {
  const n = daysSinceJ2000(date);

  const meanLon = 280.460 + 0.9856474 * n;
  const meanAnom = (357.528 + 0.9856003 * n) * D2R;
  const eclipticLon = (meanLon + 1.915 * Math.sin(meanAnom)
    + 0.020 * Math.sin(2 * meanAnom)) * D2R;
  const obliquity = (23.439 - 0.0000004 * n) * D2R;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
  const rightAsc = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLon),
    Math.cos(eclipticLon));

  /* Greenwich mean sidereal time, in hours. */
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;

  return {
    lat: declination * R2D,
    lon: normalize180(rightAsc * R2D - gmst * 15),
  };
}

/* Earth-fixed unit vector pointing at the sun. */
export function sunDirection(date = new Date(), out = [0, 0, 0]) {
  const { lat, lon } = subsolarPoint(date);
  return latLonToVec3(lat, lon, 1, out);
}

/* Solar elevation in degrees at a place. Negative is below the horizon.
   This needs no timezone database, which is why the cards can state a
   camera's day/night state exactly even where the tz is unknown. */
export function solarElevation(lat, lon, date = new Date()) {
  const sun = subsolarPoint(date);
  const a = latLonToVec3(lat, lon, 1);
  const b = latLonToVec3(sun.lat, sun.lon, 1);
  const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return 90 - Math.acos(Math.max(-1, Math.min(1, cos))) * R2D;
}

/* The qualitative state, on the standard twilight boundaries. */
export function solarState(lat, lon, date = new Date()) {
  const e = solarElevation(lat, lon, date);
  if (e > 6) return 'day';
  if (e > -0.833) return 'golden';
  if (e > -6) return 'dusk';
  if (e > -18) return 'night';
  return 'deep night';
}

/* `?utc=2026-06-21T12:00:00Z` freezes the sun so the terminator can be
   asserted against a known solstice rather than eyeballed. */
export function createClock(frozenIso) {
  const frozen = frozenIso ? new Date(frozenIso) : null;
  const valid = frozen && !Number.isNaN(frozen.getTime());
  if (frozenIso && !valid) console.warn('[planet] ignoring bad ?utc=', frozenIso);
  return {
    frozen: !!valid,
    now: () => (valid ? frozen : new Date()),
  };
}

/* Local wall-clock time at a camera.

   Uses the IANA zone when the dataset carries one — the browser already
   ships the full tz database including DST rules, so this is exact. Falls
   back to the longitude approximation when it does not, because a re-run
   of refresh.py that drops the field must never break the page. The
   fallback is visibly worse and labelled as approximate: it cannot express
   India's UTC+5:30 at all and knows nothing about daylight saving. */
export function localTime(cam, date = new Date()) {
  if (cam.tz) {
    try {
      return {
        text: new Intl.DateTimeFormat('en-GB', {
          timeZone: cam.tz, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(date),
        exact: true,
      };
    } catch (err) {
      /* an unknown zone name falls through to the approximation */
    }
  }
  const shifted = new Date(date.getTime() + Math.round(cam.lon / 15) * 3600000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return { text: `${hh}:${mm}`, exact: false };
}
