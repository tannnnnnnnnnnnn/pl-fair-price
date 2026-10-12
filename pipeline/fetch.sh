#!/bin/bash
# Fetch live XO, Polymarket, Kalshi and FPL data into raw/. Each file is replaced only when the new download is valid JSON.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p raw; tmp=$(mktemp -d)
get() { curl -sf --retry 3 --max-time 30 -A "pl-fair-price/1.0" "$1"; }
valid() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d else 1)" "$1"; }

# XO: every live conviction market, paged
python3 - "$tmp/xo.json" <<'PY'
import json, subprocess, sys
rows, page = [], 1
while True:
    out = subprocess.run(["curl", "-sf", "--retry", "3", "--max-time", "30",
                          f"https://api-mainnet.xo.market/api/convictions?take=50&page={page}"], capture_output=True, check=True)
    d = json.loads(out.stdout); rows += d.get("data", [])
    if not d.get("meta", {}).get("hasNextPage"): break
    page += 1
json.dump(rows, open(sys.argv[1], "w"))
PY
valid "$tmp/xo.json" && mv "$tmp/xo.json" raw/xo_convictions.json

# XO resolution rules live in immutable metadata documents, separate from conviction pitches.
# Cache Premier League metadata individually; a missing document must not abort the wider fetch.
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path
from urllib.parse import urlparse

rows = json.load(open("raw/xo_convictions.json"))
cache = Path("raw/xo_meta")
cache.mkdir(parents=True, exist_ok=True)
for row in rows:
    market = row.get("market") or {}
    if not any(category.get("id") == 27 for category in market.get("categoryPath") or []):
        continue
    uri = market.get("metadataUri") or (row.get("metadata") or {}).get("metadataUri")
    name = Path(urlparse(uri or "").path).name
    if not uri or not name or not name.endswith(".json") or (cache / name).exists():
        continue
    out = subprocess.run(["curl", "-sf", "--retry", "3", "--max-time", "30", uri], capture_output=True)
    if out.returncode != 0:
        print(f"warning: could not fetch XO metadata {uri}")
        continue
    try:
        data = json.loads(out.stdout)
        if not data:
            raise ValueError("empty JSON")
    except (json.JSONDecodeError, ValueError):
        print(f"warning: invalid XO metadata {uri}")
        continue
    temp = cache / (name + ".tmp")
    temp.write_bytes(out.stdout)
    os.replace(temp, cache / name)
PY

# Closed or expired markets we priced: fetch their result once (XO keeps them at /api/markets/{id})
python3 - <<'PY'
import datetime as dt, json, os, subprocess
tp, rp = "../site/data/tracked.json", "../site/data/receipts.json"
tracked = json.load(open(tp)) if os.path.exists(tp) else {}
# XO can re-resolve a market after a dispute, so results from the last 3 days are checked again.
recent = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)).isoformat()
done = {r["slug"] for r in json.load(open(rp)) if (r.get("resolved_at") or "") < recent} if os.path.exists(rp) else set()
active = {r["slug"] for r in json.load(open("raw/xo_convictions.json"))}
now = dt.datetime.now(dt.timezone.utc).isoformat()
os.makedirs("raw/closed", exist_ok=True)
for slug, t in tracked.items():
    if slug in done or (slug in active and t["expires_at"] > now):
        continue
    out = subprocess.run(["curl", "-sf", "--max-time", "20", f"https://api-mainnet.xo.market/api/markets/{t['id']}"], capture_output=True)
    if out.returncode == 0 and out.stdout:
        open(f"raw/closed/{t['id']}.json", "wb").write(out.stdout)
PY

# Polymarket: open EPL events, paged
python3 - "$tmp/poly.json" <<'PY'
import json, subprocess, sys
ev, off = [], 0
while True:
    out = subprocess.run(["curl", "-sf", "--retry", "3", "--max-time", "30",
                          f"https://gamma-api.polymarket.com/events?tag_slug=epl&closed=false&limit=100&offset={off}"], capture_output=True, check=True)
    d = json.loads(out.stdout)
    if not d: break
    ev += d; off += 100
json.dump(ev, open(sys.argv[1], "w"))
PY
valid "$tmp/poly.json" && mv "$tmp/poly.json" raw/poly_events.json

# Kalshi: open EPL match events, paged (public, no key). A failed download keeps the previous file; the engine then
# prices from Polymarket alone, so this must not abort the fetch.
python3 - "$tmp/kalshi.json" <<'PY' && valid "$tmp/kalshi.json" && mv "$tmp/kalshi.json" raw/kalshi_epl.json || echo "warning: Kalshi fetch failed; keeping previous raw/kalshi_epl.json"
import json, subprocess, sys
from urllib.parse import urlencode
ev, cursor = [], ""
while True:
    q = dict(series_ticker="KXEPLGAME", status="open", with_nested_markets="true", limit=200)
    if cursor: q["cursor"] = cursor
    out = subprocess.run(["curl", "-sf", "--retry", "3", "--retry-all-errors", "--max-time", "30", "-A", "pl-fair-price/1.0",
                          "https://api.elections.kalshi.com/trade-api/v2/events?" + urlencode(q)], capture_output=True, check=True)
    d = json.loads(out.stdout); ev += d.get("events", [])
    cursor = d.get("cursor") or ""
    if not cursor: break
json.dump(dict(events=ev), open(sys.argv[1], "w"))
PY

# FPL
get https://fantasy.premierleague.com/api/bootstrap-static/ > "$tmp/b.json" && valid "$tmp/b.json" && mv "$tmp/b.json" raw/fpl_bootstrap.json
get https://fantasy.premierleague.com/api/fixtures/ > "$tmp/f.json" && valid "$tmp/f.json" && mv "$tmp/f.json" raw/fpl_fixtures.json
rm -rf "$tmp"; echo "fetched $(date -u +%FT%TZ)"
