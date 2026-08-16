/* fallback.js — the no-WebGL2 path, and what `?grid=1` shows on request.

   Deliberately minimal for now: the flat contact sheet in preview.html has
   already proven this interaction, and U10 folds its thumbnail/iframe
   lifecycle in here properly. What matters at this stage is that the
   dynamic import in boot.js resolves — a missing module would leave a
   browser without WebGL2 staring at the loader forever. */

export async function start() {
  const root = document.createElement('main');
  root.className = 'fallback';
  root.innerHTML =
    '<h1>Our Beautiful Planet</h1>' +
    '<p>Your browser cannot run the 3D globe, so here are the cameras as a list.</p>' +
    '<p class="loading">Loading…</p>';
  document.body.appendChild(root);

  const title = document.getElementById('title');
  if (title) title.style.display = 'none';

  try {
    const res = await fetch('./livecams.json');
    const doc = await res.json();
    const cams = (doc.cams || []).filter((c) => c && c.id && c.url);
    root.querySelector('.loading').remove();

    const list = document.createElement('ul');
    list.style.cssText = 'list-style:none;margin-top:1.6em';
    for (const cam of cams) {
      const li = document.createElement('li');
      li.style.cssText = 'border-bottom:1px solid var(--line);padding:.55em 0';
      const a = document.createElement('a');
      a.href = cam.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'color:var(--bone);text-decoration:none';
      a.textContent = `${cam.name} — ${cam.place}, ${cam.country}`;
      li.appendChild(a);
      list.appendChild(li);
    }
    root.appendChild(list);
  } catch (err) {
    const p = root.querySelector('.loading');
    if (p) p.textContent = 'The camera list could not be loaded.';
    console.error('[planet] fallback failed:', err);
  }

  dispatchEvent(new Event('planet:ready'));
}
