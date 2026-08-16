"""Re-verify every cam in livecams.json and flag the dead ones.

Run this before a build (or on a schedule). Live streams do end -- a channel
restarts the encoder, a hotel takes its camera down, a volcano eruption cam
wraps up -- and a dead video id in the globe is a black iframe.

    python refresh.py           # report only
    python refresh.py --write   # also update livecams.json in place

Costs 1 YouTube Data API quota unit per 50 cams (~3 units for the whole file).

Auth is reused from the `yt` CLI (~/.yt-studio), so there is no key to set here.
Point YTCLI_PATH at that checkout if it is not already importable:

    YTCLI_PATH=/path/to/youtube-py python refresh.py
"""
import argparse, datetime as dt, json, os, sys
from pathlib import Path

if os.environ.get("YTCLI_PATH"):
    sys.path.insert(0, os.environ["YTCLI_PATH"])
from ytcli.client import data_service

HERE = Path(__file__).parent
DATA = HERE / "livecams.json"
NOW = dt.datetime.now(dt.timezone.utc)


def fetch(ids):
    svc = data_service()
    info = {}
    for i in range(0, len(ids), 50):
        r = svc.videos().list(part="snippet,status,liveStreamingDetails",
                              id=",".join(ids[i:i + 50]), maxResults=50).execute()
        for it in r.get("items", []):
            sn, st = it["snippet"], it["status"]
            ls = it.get("liveStreamingDetails") or {}
            start = ls.get("actualStartTime")
            up = None
            if start:
                t = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
                up = round((NOW - t).total_seconds() / 86400, 1)
            info[it["id"]] = {
                "live": sn.get("liveBroadcastContent") == "live",
                "embeddable": st.get("embeddable"),
                "viewers": int(ls["concurrentViewers"]) if ls.get("concurrentViewers") else None,
                "started": start, "uptime_days": up, "channel": sn["channelTitle"],
            }
    return info


def tier(d):
    if d is None:
        return "unknown"
    return "proven" if d >= 365 else ("solid" if d >= 90 else "recent")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true",
                    help="update livecams.json with fresh numbers and drop dead cams")
    args = ap.parse_args()

    doc = json.loads(DATA.read_text(encoding="utf-8"))
    cams = doc["cams"]
    ids = [c["id"] for c in cams]
    ids += [a["id"] for c in cams for a in c.get("alternates", [])]
    info = fetch(ids)

    ok, dead, promoted = [], [], []
    for c in cams:
        d = info.get(c["id"])
        healthy = bool(d and d["live"] and d["embeddable"])
        if healthy:
            c["viewers"] = d["viewers"]
            c["stream_started"] = d["started"]
            c["uptime_days"] = d["uptime_days"]
            c["stability"] = tier(d["uptime_days"])
            ok.append(c)
            continue
        # try a failover feed for the same viewpoint before giving up
        swap = next((a for a in c.get("alternates", [])
                     if (info.get(a["id"]) or {}).get("live")
                     and (info.get(a["id"]) or {}).get("embeddable")), None)
        if swap:
            a = info[swap["id"]]
            c["alternates"] = [x for x in c["alternates"] if x["id"] != swap["id"]] + \
                              [{"id": c["id"], "channel": c["channel"],
                                "url": c["url"], "uptime_days": c.get("uptime_days")}]
            c.update(id=swap["id"], channel=a["channel"],
                     url=f"https://www.youtube.com/watch?v={swap['id']}",
                     embed=f"https://www.youtube.com/embed/{swap['id']}?autoplay=1&mute=1&playsinline=1",
                     live_thumb=f"https://i.ytimg.com/vi/{swap['id']}/hqdefault_live.jpg",
                     viewers=a["viewers"], stream_started=a["started"],
                     uptime_days=a["uptime_days"], stability=tier(a["uptime_days"]))
            promoted.append(c)
            ok.append(c)
        else:
            dead.append(c)

    for c in dead:
        print(f"DEAD      {c['place']:<22} {c['name']}  ({c['url']})")
    for c in promoted:
        print(f"FAILOVER  {c['place']:<22} {c['name']} -> {c['url']}")
    print(f"\n{len(ok)}/{len(cams)} healthy, {len(promoted)} failed over, {len(dead)} dead")

    if args.write:
        doc["cams"] = ok
        doc["count"] = len(ok)
        doc["generated"] = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
        DATA.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {DATA}")


if __name__ == "__main__":
    main()
