#!/usr/bin/env python3
"""Projection consensus: next-gameweek expected points from free public sources, side by side.

Reads site/data/projections.json (ours, plus FPL's ep_next) and pipeline/raw/fpl_bootstrap.json, fetches
Solio Analytics (JSON) and Fantasy Football Pundit (the page's embedded data) with curl, and writes
site/data/consensus.json: the top players by average of ours, Solio and Pundit.

Usage: consensus.py            fetch Solio and Pundit, save raw copies to raw/solio.json and raw/pundit.html
       consensus.py --cached   reuse those raw copies (fetches only a file that is missing)
GET only, public pages, no login. A failed source becomes null; if both external sources fail the
previous consensus.json is kept.
"""
import datetime as dt
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent
RAW, OUT = TOOL / "pipeline" / "raw", TOOL / "site" / "data"
UA = "pl-fair-price/1.0"
SOLIO_PAGE = "https://fpl.solioanalytics.com"
SOLIO_URL = SOLIO_PAGE + "/api/data/latest.json"  # listed in https://fpl.solioanalytics.com/llms.txt
PUNDIT_URL = "https://www.fantasyfootballpundit.com/fpl-points-predictor/"
TOP = 15
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


def log(msg):
    print("consensus: " + msg, file=sys.stderr)


def fold(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().strip()


def num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v else None


def curl(url):
    out = subprocess.run(["curl", "-sfL", "--retry", "3", "--max-time", "30", "-A", UA, url], capture_output=True)
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"curl failed ({out.returncode}) for {url}")
    return out.stdout


# ---------------------------------------------------------------- sources


def get_raw(name, url, parse, cached):
    """Return parse(bytes). Reuse raw/<name> when cached; save a fetched copy only after it parses."""
    path = RAW / name
    if cached and path.exists():
        return parse(path.read_bytes())
    data = curl(url)
    parsed = parse(data)
    RAW.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return parsed


def parse_solio(data):
    """-> (gameweek, [{name, team, pos, pts}]). Every list in the file carries players with prPoints; union them."""
    d = json.loads(data)
    seen = {}
    for v in d.values():
        if not isinstance(v, list):
            continue
        for x in v:
            if isinstance(x, dict) and x.get("name") and x.get("team") and num(x.get("prPoints")) is not None:
                seen[(x["name"], x["team"], x.get("position"))] = num(x["prPoints"])
    if not seen:
        raise ValueError("no players in Solio data")
    return d.get("gameweek"), [dict(name=k[0], team=k[1], pos=k[2], pts=v) for k, v in seen.items()]


def parse_pundit(data):
    """-> {gw: {player_code: start-weighted points}}. The page embeds its table in Next.js flight chunks."""
    html = data.decode("utf-8", "replace")
    chunks = [json.loads(m.group(1)) for m in re.finditer(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', html)]
    flight = "".join(chunks)
    i = flight.find('"rows":[{"gw"')
    if i < 0:
        raise ValueError("no embedded rows in Pundit page")
    rows, _ = json.JSONDecoder().raw_decode(flight[i + len('"rows":'):])
    by_gw = {}
    for r in rows:
        pts = num(r.get("predicted_points_start"))
        if pts is not None and r.get("player_code") is not None:
            by_gw.setdefault(r["gw"], {})[r["player_code"]] = pts
    if not by_gw:
        raise ValueError("no usable Pundit rows")
    return by_gw


# ---------------------------------------------------------------- build


def build(cached):
    boot = json.loads((RAW / "fpl_bootstrap.json").read_text())
    teams = {t["id"]: t["short_name"] for t in boot["teams"]}
    els = {e["id"]: e for e in boot["elements"]}
    by_code = {e["code"]: e["id"] for e in boot["elements"]}

    ours, gw = {}, None
    try:
        proj = json.loads((OUT / "projections.json").read_text())
        gw = proj["gw"]
        ours = {p["id"]: p for p in proj["players"]}
    except Exception as e:  # noqa: BLE001
        log(f"our projections unavailable: {e}")
    if gw is None:
        gw = next(ev["id"] for ev in boot["events"] if ev["is_next"])

    solio, solio_total, solio_hit = {}, 0, 0
    try:
        sgw, rows = get_raw("solio.json", SOLIO_URL, parse_solio, cached)
        if sgw != gw:
            raise ValueError(f"Solio is on GW{sgw}, not GW{gw}")
        idx = {}
        for e in els.values():
            idx.setdefault((fold(e["web_name"]), teams[e["team"]], POS[e["element_type"]]), []).append(e["id"])
        solio_total = len(rows)
        for r in rows:
            ids = idx.get((fold(r["name"]), r["team"], "GK" if r["pos"] in ("GK", "GKP") else r["pos"]), [])
            if len(ids) == 1:
                solio[ids[0]] = r["pts"]
                solio_hit += 1
            else:
                log(f"Solio player not matched: {r['name']} {r['team']} {r['pos']} ({len(ids)} candidates)")
    except Exception as e:  # noqa: BLE001
        log(f"Solio failed: {e}")

    pundit, pundit_total, pundit_hit = {}, 0, 0
    try:
        rows = get_raw("pundit.html", PUNDIT_URL, parse_pundit, cached).get(gw)
        if not rows:
            raise ValueError(f"no GW{gw} rows")
        pundit_total = len(rows)
        for code, pts in rows.items():
            if code in by_code:
                pundit[by_code[code]] = pts
                pundit_hit += 1
            else:
                log(f"Pundit player_code not in FPL: {code}")
    except Exception as e:  # noqa: BLE001
        log(f"Pundit failed: {e}")

    print(f"match rate: Solio {solio_hit}/{solio_total}, Pundit {pundit_hit}/{pundit_total}, ours {len(ours)} players")
    if not solio and not pundit:
        return None

    need = min(2, bool(ours) + bool(solio) + bool(pundit))  # at least two models, or all that are live
    cand = []
    for pid in set(ours) | set(solio) | set(pundit):
        if pid not in els:
            continue
        o = ours.get(pid)
        vals = dict(ours=num(o["xpts"]) if o else None, solio=solio.get(pid), pundit=pundit.get(pid))
        got = [v for v in vals.values() if v is not None]
        if len(got) < need:
            continue
        e = els[pid]
        fpl = num(o["fpl_ep"]) if o and num(o.get("fpl_ep")) is not None else num(e.get("ep_next"))
        cand.append(dict(id=pid, name=o["name"] if o else e["web_name"], team=teams[e["team"]], pos=POS[e["element_type"]],
                         **{k: (round(v, 2) if v is not None else None) for k, v in vals.items()},
                         fpl=fpl, avg=round(sum(got) / len(got), 2)))
    cand.sort(key=lambda p: (-p["avg"], p["name"]))

    sources = [
        dict(key="ours", name="Our model", url=None,
             note="Match odds from Polymarket, player shares from FPL xG and xA, plus clean sheets, defensive contribution and bonus."),
        dict(key="solio", name="Solio Analytics", url=SOLIO_PAGE,
             note="Solio's public projected points for the gameweek. It publishes only its top players, so some rows are blank."),
        dict(key="pundit", name="Fantasy Football Pundit", url=PUNDIT_URL,
             note="Fantasy Football Pundit's start-weighted projected points for the gameweek."),
        dict(key="fpl", name="FPL", url=None,
             note="FPL's own expected points (ep_next). Form-based and erratic, so it is shown but left out of the average."),
    ]
    return dict(generated_at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), gw=gw,
                sources=sources, players=cand[:TOP])


def main():
    cached = "--cached" in sys.argv[1:]
    res = build(cached)
    if res is None:
        log("every external source failed; keeping the previous consensus.json")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "consensus.json.tmp"
    tmp.write_text(json.dumps(res, indent=1, ensure_ascii=False))
    tmp.replace(OUT / "consensus.json")
    for i, p in enumerate(res["players"], 1):
        print(f"{i:>2} {p['name']:<14}{p['team']} {p['pos']:<4} ours={p['ours']} solio={p['solio']} pundit={p['pundit']} fpl={p['fpl']} avg={p['avg']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
