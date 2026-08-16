/* monitor.js — the docked preview and the leader line that ties it to a pin.

   Lifecycle is an explicit state machine because the quality of this
   interaction lives entirely in its timing:

     IDLE  -> HOVER   on acquiring a pin: metadata at once, and the player
                      mounted a moment later
     HOVER -> IDLE    after a leave GRACE, not instantly — otherwise
                      crossing a gap between two pins collapses the panel
                      and re-opens it, which reads as a flicker

   There is deliberately NO still-frame placeholder. Showing our own
   thumbnail and then swapping it for the player produced a visible
   double-take: you saw one picture, then a different picture of the same
   place. The player draws its own poster while it loads, so letting it
   own the whole panel means one image arrives and simply starts moving.
   The cost is that a stream which dies or revokes embedding now shows
   black rather than a still — acceptable while refresh.py keeps every
   entry verified as embeddable, and worth revisiting if that stops being
   true.

   Acquiring a DIFFERENT pin while open re-anchors in place instead of
   closing and re-opening. That continuity is the difference between an
   instrument and a tooltip.

   U7 extends this with the dwell -> live-video transition. */

const GRACE_MS = 180;
/* Short enough that the player is already arriving by the time the eye has
   settled, long enough that sweeping the pointer across a continent does
   not mount a player for every camera it crosses. */
const DWELL_MS = 200;

/* Strip the player back to just the picture.

   controls=0 removes the scrubber and the centre play button;
   iv_load_policy=3 drops annotations; rel=0 and modestbranding=1 trim the
   end-screen and watermark; fs and disablekb remove affordances for a
   player nobody is meant to operate here.

   The overlays that survive all of that — the title bar, "More videos",
   the share row — are HOVER states, so the last step is the decisive one:
   the iframe takes pointer-events:none, the player never learns the
   pointer is over it, and none of them ever appear. Clicks land on the
   panel instead, which sends them to YouTube. */
const PLAYER_PARAMS = 'autoplay=1&mute=1&playsinline=1&controls=0'
  + '&modestbranding=1&rel=0&iv_load_policy=3&fs=0&disablekb=1';

function embedUrl(cam) {
  if (cam.id) return `https://www.youtube.com/embed/${cam.id}?${PLAYER_PARAMS}`;
  /* Older data without an id: fall back to the stored URL. */
  return cam.embed;
}

export function createMonitor({ onOpen, onClose, onPlay, onStop } = {}) {
  const root = document.getElementById('monitor');
  const viewers = document.getElementById('mon-viewers');
  const name = document.getElementById('mon-name');
  const where = document.getElementById('mon-where');
  const coords = document.getElementById('mon-coords');
  const uptime = document.getElementById('mon-uptime');
  const light = document.getElementById('mon-light');
  const local = document.getElementById('mon-local');
  const go = document.getElementById('mon-go');

  const screen = root.querySelector('.screen');
  const svg = document.getElementById('leader');
  const line = svg.querySelector('line');
  const ring = svg.querySelector('circle');

  let current = null;
  let graceTimer = 0;
  /* Module-scope singleton. Sweeping ten pins must never leave ten players
     alive — each embed is a megabyte of player plus a live video decode. */
  let frame = null;
  let dwellTimer = 0;
  let anchor = null;
  function killFrame() {
    clearTimeout(dwellTimer);
    if (!frame) return;
    /* about:blank before removal so the player stops fetching immediately
       rather than whenever the element is collected. */
    frame.src = 'about:blank';
    frame.remove();
    frame = null;
    if (onStop) onStop();
  }

  function mountFrame(cam) {
    killFrame();
    frame = document.createElement('iframe');
    frame.title = `Live view of ${cam.name}`;
    /* allow=autoplay is REQUIRED for muted autoplay; without it the player
       loads and then sits on a play button. */
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'origin-when-cross-origin';
    /* Fade in on the player's own load event rather than on a timer. A
       fixed delay either shows an empty panel or cuts in mid-paint,
       because how long the player takes depends on the network. */
    frame.addEventListener('load', () => { if (frame) frame.classList.add('up'); }, { once: true });
    frame.src = embedUrl(cam);
    screen.appendChild(frame);
    if (onPlay) onPlay(cam);
  }

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

  function show(cam, solar, clockText) {
    clearTimeout(graceTimer);
    const changed = !current || current.id !== cam.id;
    current = cam;

    if (changed) {
      name.textContent = cam.name;
      where.textContent = `${cam.place}, ${cam.country}`;
      coords.textContent = fmtCoords(cam.lat, cam.lon);
      uptime.textContent = fmtUptime(cam.uptime_days);
      viewers.textContent = cam.viewers != null ? `${cam.viewers} WATCHING` : 'LIVE';
      go.href = cam.url;
      go.setAttribute('aria-label', `Watch ${cam.name} on YouTube`);
    }
    if (solar) light.textContent = solar;
    if (clockText) local.textContent = clockText;

    root.classList.add('on');
    if (changed) {
      killFrame();
      dwellTimer = setTimeout(() => mountFrame(cam), DWELL_MS);
      if (onOpen) onOpen(cam);
    } else if (!frame) {
      /* Same camera, no player: a brief hover loss inside the dwell had
         its timer cancelled by hide(), and without this branch nothing
         ever re-armed it — the audit mapped an exact dead window (loss
         starting < 200ms in, lasting < the 180ms grace) where the video
         never played again for that camera. */
      clearTimeout(dwellTimer);
      dwellTimer = setTimeout(() => mountFrame(cam), DWELL_MS);
    }
  }

  function hide(immediate = false) {
    clearTimeout(graceTimer);
    const close = () => {
      killFrame();
      root.classList.remove('on');
      svg.style.opacity = '0';
      const cam = current;
      current = null;
      anchor = null;
      if (cam && onClose) onClose(cam);
    };
    /* Cancel a pending dwell right away — leaving should never start a
       video moments after the pointer has gone. */
    clearTimeout(dwellTimer);
    if (immediate) close();
    else graceTimer = setTimeout(close, GRACE_MS);
  }

  /* Called every frame while open: the pin moves as the globe turns, so
     the line has to be redrawn rather than placed once. */
  function anchorTo(x, y, visible) {
    anchor = visible ? { x, y } : null;
    if (!current || !anchor || root.classList.contains('on') === false) {
      svg.style.opacity = '0';
      return;
    }
    const box = root.getBoundingClientRect();
    if (box.width === 0) { svg.style.opacity = '0'; return; }
    const tx = box.left;
    const ty = box.top + box.height / 2;
    line.setAttribute('x1', x);
    line.setAttribute('y1', y);
    line.setAttribute('x2', tx);
    line.setAttribute('y2', ty);
    ring.setAttribute('cx', x);
    ring.setAttribute('cy', y);
    ring.setAttribute('r', 11);
    svg.style.opacity = '1';
  }

  /* The panel is a hover target too: moving the pointer onto it must not
     dismiss the thing you are reaching for. */
  root.addEventListener('pointerenter', () => clearTimeout(graceTimer));
  root.addEventListener('pointerleave', () => hide());

  /* With the player deaf to the pointer, the picture itself carries the
     click through to YouTube — which is what people try first anyway. */
  const openCurrent = () => {
    if (current) window.open(current.url, '_blank', 'noopener');
  };
  screen.addEventListener('click', openCurrent);
  screen.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCurrent(); }
  });

  return {
    root,
    show,
    hide,
    anchorTo,
    /* The clock has to keep ticking while the panel sits open. */
    setClock(text) { if (current) local.textContent = text; },
    get current() { return current; },
    get isOpen() { return root.classList.contains('on'); },
    get isPlaying() { return !!frame; },
  };
}
