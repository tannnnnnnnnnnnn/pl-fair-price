#!/usr/bin/env bash
# Render share cards (1200x675 PNG) for X posts.
# Cards: the top 6 "Biggest gaps" (same rule as the site) plus every market with is_ours.
# Usage: pipeline/cards.sh            -> writes tool/cards/<slug>.png
#        pipeline/cards.sh <slug> ... -> only those slugs
# Needs: python3 and Google Chrome (override with CHROME=/path/to/chrome).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$HERE/../site"
OUT="$HERE/../cards"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p "$OUT"

if [ "$#" -gt 0 ]; then
  SLUGS="$(printf '%s\n' "$@")"
else
  SLUGS="$(python3 - "$SITE/data/board.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
def f(v):
    try: return float(v)
    except (TypeError, ValueError): return None
def gap(m):
    g = f(m.get("gap_pts"))
    if g is None and m.get("fair") and f(m["fair"].get("p")) is not None and f(m.get("xo_price")) is not None:
        g = round((f(m["fair"]["p"]) - f(m["xo_price"])) * 100)
    return g
def untraded(m):
    return not f(m.get("volume_usd")) and f(m.get("best_bid")) is None and f(m.get("best_ask")) is None
gaps = [m for m in b["markets"] if m.get("fair") and f(m["fair"].get("p")) is not None
        and m["fair"].get("confidence") in ("high", "medium")
        and gap(m) is not None and abs(gap(m)) >= 8 and not untraded(m)]
gaps.sort(key=lambda m: -abs(gap(m)))
seen, out = set(), []
for m in gaps[:6] + [m for m in b["markets"] if m.get("is_ours")]:
    if m["slug"] not in seen:
        seen.add(m["slug"]); out.append(m["slug"])
print("\n".join(out))
PY
)"
fi

# Serve site/ on a free local port (own process; only this script's server is stopped on exit).
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SITE" >/dev/null 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
sleep 1

n=0
while IFS= read -r slug; do
  [ -z "$slug" ] && continue
  "$CHROME" --headless=new --hide-scrollbars --window-size=1200,675 --virtual-time-budget=10000 \
    --screenshot="$OUT/$slug.png" "http://127.0.0.1:$PORT/card.html?slug=$slug" >/dev/null 2>&1
  echo "card: $OUT/$slug.png"
  n=$((n+1))
done <<< "$SLUGS"
echo "$n cards written to $OUT"
