"""Cache Beautiful News stories into data/beautiful-news.json.

Why a script and not a fetch from the page:

  * informationisbeautiful.net sends no Access-Control-Allow-Origin, so a
    browser cannot read it directly. Neither can it read their FeedBurner
    feed, which in any case returns a valid RSS document containing zero
    <item> entries — there is no live feed to subscribe to.
  * Their own grid endpoint (components/grid.php) returns a 132-byte empty
    shell; the listing is built client-side and renders nothing to scrape.

What does work: story pages are numbered, a bare id redirects to its slug
(/beautifulnews/1360/ -> /beautifulnews/1360-bhutan-carbon-negative/), and
each page carries clean Open Graph tags. So walk the ids.

Content is CC BY-SA 4.0 and the site says so explicitly: "Feel free to use,
download and spread these images as much as you like." The page keeps the
attribution visible, which that licence requires.

    python news.py                 # report only
    python news.py --write         # update data/beautiful-news.json
    python news.py --write --n 60  # keep 60 stories
"""
import argparse, json, re, sys, time, urllib.error, urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "data" / "beautiful-news.json"
BASE = "https://informationisbeautiful.net/beautifulnews"
UA = "Mozilla/5.0 (compatible; our-beautiful-planet/1.0; +https://informationisbeautiful.net)"
FLOOR = 1300          # known-good id to search upward from
GAP_TOLERANCE = 12    # consecutive misses before we accept we found the end


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.geturl(), res.read().decode("utf-8", "replace")


def og(html, prop):
    m = re.search(rf'<meta property="og:{prop}" content="([^"]*)"', html)
    return m.group(1).strip() if m else None


def story(story_id):
    """Return the story dict, or None when that id does not exist."""
    try:
        final, html = fetch(f"{BASE}/{story_id}/")
    except (urllib.error.URLError, TimeoutError):
        return None
    # A missing id lands back on the index rather than a slug page.
    if not re.search(rf"/beautifulnews/{story_id}-", final):
        return None
    title, image, url = og(html, "title"), og(html, "image"), og(html, "url")
    if not title or not image:
        return None
    return {
        "id": story_id,
        # The site separates title and suffix with an em dash + NBSP, so a
        # literal " — Beautiful News" never matches. \s covers the NBSP.
        "title": re.sub(r"\s*[—–-]\s*Beautiful News\s*$", "", title).strip(),
        "url": url or final,
        "image": image,
    }


def find_newest(start=FLOOR):
    """Walk up until the ids run out. Polite: stops at the first real gap."""
    newest, misses, probe = None, 0, start
    while misses < GAP_TOLERANCE:
        s = story(probe)
        if s:
            newest, misses = probe, 0
        else:
            misses += 1
        probe += 1
        time.sleep(0.12)
    return newest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--n", type=int, default=40, help="how many stories to keep")
    args = ap.parse_args()

    print(f"probing upward from {FLOOR}…")
    newest = find_newest()
    if not newest:
        print("no stories found — the site's URL shape may have changed")
        return 1
    print(f"newest story id: {newest}")

    stories, sid = [], newest
    while len(stories) < args.n and sid > 0:
        s = story(sid)
        if s:
            stories.append(s)
            print(f"  {s['id']}  {s['title'][:64]}")
        sid -= 1
        time.sleep(0.12)

    print(f"\n{len(stories)} stories")
    if args.write:
        OUT.parent.mkdir(exist_ok=True)
        OUT.write_text(json.dumps({
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": f"{BASE}/",
            "licence": "CC BY-SA 4.0 — Information is Beautiful",
            "count": len(stories),
            "stories": stories,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
