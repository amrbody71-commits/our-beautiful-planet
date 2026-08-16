"""Add an IANA `tz` to every camera in livecams.json.

Why not just derive it from longitude at runtime: `round(lon/15)` cannot
represent India's UTC+5:30 at all, puts Spain an hour out (it sits at ~3W on
CET), spreads China across five zones when it runs one, and knows nothing
about daylight saving — which in August is an hour wrong across most of the
European and North American cameras. Displaying "14:00 local" beside a
night-lit frame destroys exactly the credibility the feature exists to build.

With a real IANA name the browser does the rest: Intl.DateTimeFormat already
ships the full tz database including DST rules, so this costs ~20 bytes per
camera and no runtime dependency.

Most countries in this dataset run a single zone. The handful that do not are
resolved by longitude below.

    python tz.py            # report only
    python tz.py --write    # update livecams.json in place
"""
import json, sys
from pathlib import Path

DATA = Path(__file__).parent / "livecams.json"

# One zone for the whole country.
SINGLE = {
    "JP": "Asia/Tokyo", "KR": "Asia/Seoul", "HK": "Asia/Hong_Kong",
    "SG": "Asia/Singapore", "SA": "Asia/Riyadh", "IL": "Asia/Jerusalem",
    "TW": "Asia/Taipei", "NP": "Asia/Kathmandu", "TH": "Asia/Bangkok",
    "IN": "Asia/Kolkata", "MV": "Indian/Maldives", "PH": "Asia/Manila",
    "IT": "Europe/Rome", "FR": "Europe/Paris", "NL": "Europe/Amsterdam",
    "CH": "Europe/Zurich", "IS": "Atlantic/Reykjavik", "FI": "Europe/Helsinki",
    "CZ": "Europe/Prague", "HR": "Europe/Zagreb", "GR": "Europe/Athens",
    "IE": "Europe/Dublin", "NO": "Europe/Oslo", "DE": "Europe/Berlin",
    "PL": "Europe/Warsaw", "AT": "Europe/Vienna", "GB": "Europe/London",
    "BE": "Europe/Brussels", "GL": "America/Nuuk", "RU": "Europe/Moscow",
    "ZA": "Africa/Johannesburg", "NA": "Africa/Windhoek", "KE": "Africa/Nairobi",
    "ZW": "Africa/Harare", "BW": "Africa/Gaborone", "TZ": "Africa/Dar_es_Salaam",
    "AR": "America/Argentina/Buenos_Aires", "PA": "America/Panama",
    "CR": "America/Costa_Rica", "GT": "America/Guatemala", "AW": "America/Aruba",
    "CW": "America/Curacao", "SX": "America/Lower_Princes", "JM": "America/Jamaica",
    "AU": "Australia/Sydney", "NZ": "Pacific/Auckland",
}


def resolve(cam):
    iso, lat, lon = cam["iso2"], cam["lat"], cam["lon"]
    if iso in SINGLE:
        return SINGLE[iso]

    if iso == "US":
        if lat < 25 and lon < -150:
            return "Pacific/Honolulu"
        if lon < -141:
            return "America/Anchorage"
        if lon < -115:
            return "America/Los_Angeles"
        if lon < -102:
            return "America/Denver"
        if lon < -87:
            return "America/Chicago"
        return "America/New_York"
    if iso == "CA":
        if lon < -115:
            return "America/Vancouver"
        if lon < -90:
            return "America/Winnipeg"
        return "America/Toronto"
    if iso == "MX":
        return "America/Mexico_City" if lon > -101 else "America/Mazatlan"
    if iso == "BR":
        return "America/Manaus" if lon < -55 else "America/Sao_Paulo"
    if iso == "ES":
        return "Atlantic/Canary" if lon < -12 else "Europe/Madrid"
    if iso == "PT":
        return "Atlantic/Madeira" if lon < -15 else "Europe/Lisbon"
    if iso == "ID":
        # Bali and eastward run UTC+8; Java runs UTC+7.
        return "Asia/Makassar" if lon >= 115 else "Asia/Jakarta"
    return None


def main():
    doc = json.loads(DATA.read_text(encoding="utf-8"))
    missing, changed = [], 0
    for cam in doc["cams"]:
        tz = resolve(cam)
        if not tz:
            missing.append(f'{cam["place"]}, {cam["country"]} ({cam["iso2"]})')
            continue
        if cam.get("tz") != tz:
            cam["tz"] = tz
            changed += 1

    print(f"{len(doc['cams'])} cams, {changed} tz values set, {len(missing)} unresolved")
    for m in sorted(set(missing)):
        print("  no zone:", m)

    if "--write" in sys.argv:
        DATA.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {DATA}")


if __name__ == "__main__":
    main()
