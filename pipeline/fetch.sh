#!/bin/bash
# Fetch live XO, Polymarket and FPL data into raw/. Each file is replaced only when the new download is valid JSON.
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
done = {r["slug"] for r in json.load(open(rp))} if os.path.exists(rp) else set()
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

# FPL
get https://fantasy.premierleague.com/api/bootstrap-static/ > "$tmp/b.json" && valid "$tmp/b.json" && mv "$tmp/b.json" raw/fpl_bootstrap.json
get https://fantasy.premierleague.com/api/fixtures/ > "$tmp/f.json" && valid "$tmp/f.json" && mv "$tmp/f.json" raw/fpl_fixtures.json
rm -rf "$tmp"; echo "fetched $(date -u +%FT%TZ)"
