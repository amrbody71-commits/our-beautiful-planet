/* news.js — the Beautiful News rail up the left edge.

   The globe shows the world as it is right now; this shows the world
   getting better. Same thesis, other medium.

   Drift is one transform on a single wrapper, not an animation per card:
   the list is rendered twice and the wrapper travels exactly half its own
   height, so the second copy is in the first copy's place at the moment
   the animation restarts and the loop has no seam. Animating each card
   separately would cost a composite layer per card and still show a jump.

   Fails quietly by design. If the cache is missing, empty, or malformed
   the rail hides itself — a courtesy panel must never take the planet down
   with it. */

const SECONDS_PER_CARD = 7;

export async function mountNewsRail({ url = './data/beautiful-news.json' } = {}) {
  const rail = document.getElementById('news');
  if (!rail) return null;

  let doc;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    doc = await res.json();
  } catch (err) {
    console.warn('[planet] beautiful news unavailable:', err.message);
    rail.remove();
    return null;
  }

  const stories = (doc.stories || []).filter((s) => s && s.title && s.image && s.url);
  if (!stories.length) {
    rail.remove();
    return null;
  }

  /* Hovering a card opens the chart big enough to actually read. The rail
     is 172px wide, where a data visualisation is decoration rather than
     information — you would have to leave the page to learn anything from
     it. The full-size file is the same URL the card already loaded, so the
     browser serves it from cache and the panel appears instantly. */
  const zoom = document.getElementById('news-zoom');
  const zoomImg = document.getElementById('news-zoom-img');
  const zoomCap = document.getElementById('news-zoom-cap');
  let zoomTimer = 0;

  function openZoom(story, card) {
    clearTimeout(zoomTimer);
    zoomImg.src = story.image;
    zoomImg.alt = story.title;
    zoomCap.innerHTML = '';
    zoomCap.append(story.title);
    const note = document.createElement('span');
    note.textContent = 'Information is Beautiful · CC BY-SA 4.0 · click to open';
    zoomCap.append(note);

    zoom.hidden = false;

    /* Centre on the card, then keep the whole panel on screen. Position is
       applied twice on purpose: once now for an immediate placement, and
       again when the image reports its real dimensions — before it loads
       the panel has no height, so the clamp would pin it to the top of the
       screen. */
    const place = () => {
      const box = card.getBoundingClientRect();
      const h = zoom.offsetHeight;
      if (!h) return;
      const top = Math.max(12, Math.min(innerHeight - h - 12, box.top + box.height / 2 - h / 2));
      zoom.style.top = `${top}px`;
    };
    place();
    zoomImg.onload = place;

    /* Reading offsetHeight forces layout, so the class change animates
       from the state just set. requestAnimationFrame would be the usual
       idiom, but it does not fire in a background tab — and a panel that
       never becomes visible is a worse failure than one that appears
       without its transition. */
    void zoom.offsetHeight;
    zoom.classList.add('on');
  }

  function closeZoom() {
    clearTimeout(zoomTimer);
    zoom.classList.remove('on');
    zoomTimer = setTimeout(() => { zoom.hidden = true; }, 200);
  }

  rail.addEventListener('pointerleave', closeZoom);

  const track = rail.querySelector('.news-track');
  const build = () => stories.map((s) => {
    const a = document.createElement('a');
    a.className = 'news-card';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener';

    const img = document.createElement('img');
    img.src = s.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    /* Their S3 does not need a referrer, and not sending one is the
       politer default for an asset we are borrowing. */
    img.referrerPolicy = 'no-referrer';

    const cap = document.createElement('span');
    cap.className = 'news-cap';
    cap.textContent = s.title;

    a.append(img, cap);
    a.addEventListener('pointerenter', () => openZoom(s, a));
    /* Keyboard reaches the same view, since the rail is a list of links. */
    a.addEventListener('focus', () => openZoom(s, a));
    a.addEventListener('blur', closeZoom);
    return a;
  });

  /* Two identical passes — the second is what the loop lands on. */
  track.append(...build(), ...build());
  track.style.animationDuration = `${stories.length * SECONDS_PER_CARD}s`;
  rail.hidden = false;

  return {
    rail,
    count: stories.length,
    generated: doc.generated || null,
  };
}
