#!/usr/bin/env python3
"""elevenify: public Datawrapper charts from https://www.elevenify.com, as a credited second opinion.

Fetches six charts, saves raw copies to raw/elevenify_<ID>.csv (plus raw/elevenify_<ID>.json with the chart's title,
version and last-modified time), and writes site/data/elevenify.json:
  matches       match_predictions  next gameweek's fixtures: goals, clean sheet %, win % and draw %   -> H/D/A shown on both pages
  goals         team_goals         predicted goals per team for the next few gameweeks                 -> shown on both pages
  clean_sheets  team_clean_sheets  clean-sheet chance per team for the next few gameweeks (0 to 1)    -> GW page, clean-sheet chart
  wins          team_wins          win chance per team for the next few gameweeks (0 to 1)
  ratings       team_ratings       attack / defence / overall, goals per match vs an average opponent
  players       player_baselines   goal / assist / goal-involvement rates per match vs an average opponent
Only the parts that exist are written. Teams become FPL short codes (ARS, MCI...). Chances are fractions, not percents.

Each chart page redirects to its latest version; that page names the live data file (static.dwcdn.net/data/<ID>.csv),
which is fresher than the version's own dataset.csv. The live file's Last-Modified header is the chart's "updated".

Usage: elevenify.py            fetch the charts
       elevenify.py --cached   reuse the raw copies (fetches only a chart that is missing)
GET only, public pages, no login. On any failure the previous elevenify.json is kept.
"""
import csv
import datetime as dt
import email.utils
import io
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent
RAW, OUT = TOOL / "pipeline" / "raw", TOOL / "site" / "data"
UA = "pl-fair-price/1.0"
DW = "https://datawrapper.dwcdn.net"
SOURCE = dict(name="elevenify", url="https://www.elevenify.com")
CHARTS = ["tDC0G", "O4DLP", "KB9uj", "MirAO", "rx5q8", "8wCgy"]  # players, ratings, goals, clean sheets, wins, match predictions
PART = {"match_predictions": "matches", "team_goals": "goals", "team_clean_sheets": "clean_sheets", "team_wins": "wins",
        "team_ratings": "ratings", "player_baselines": "players"}
# Names not covered by FPL's name / short_name (Polymarket-style long forms).
ALIASES = {"manchester city": "MCI", "manchester united": "MUN", "manchester utd": "MUN", "tottenham": "TOT",
           "tottenham hotspur": "TOT", "nottingham forest": "NFO", "nottm forest": "NFO", "newcastle united": "NEW",
           "leeds united": "LEE", "brighton and hove albion": "BHA", "brighton & hove albion": "BHA", "bournemouth": "BOU"}


def log(msg):
    print("elevenify: " + msg, file=sys.stderr)


def fold(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().strip()
    return re.sub(r"^afc\s+|\s+fc$", "", s)


def num(x):
    """'1.95' -> 1.95, '67%' -> 0.67, '' -> None."""
    x = (x or "").strip()
    if x.endswith("%"):
        return round(float(x[:-1]) / 100, 4)
    return float(x) if x else None


def curl(url):
    """-> (body bytes, Last-Modified of the final response as an ISO UTC string or None)."""
    with tempfile.NamedTemporaryFile() as hdr:
        out = subprocess.run(["curl", "-sfL", "--retry", "3", "--max-time", "30", "-A", UA, "-D", hdr.name, url], capture_output=True)
        heads = Path(hdr.name).read_text("latin-1")
    if out.returncode != 0 or not out.stdout:
        raise RuntimeError(f"curl failed ({out.returncode}) for {url}")
    lm = re.findall(r"(?im)^last-modified:\s*(.+?)\s*$", heads)
    when = email.utils.parsedate_to_datetime(lm[-1]).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if lm else None
    return out.stdout, when


# ---------------------------------------------------------------- fetch


def fetch_chart(cid):
    """-> (csv text, meta). Follows the chart's redirect to its latest version, then reads its title and live data URL."""
    page, _ = curl(f"{DW}/{cid}/")
    m = re.search(rf"{re.escape(DW)}/{cid}/(\d+)/", page.decode("utf-8", "replace"))
    if not m:
        raise ValueError(f"{cid}: no version in the chart page")
    ver = m.group(1)
    html = curl(f"{DW}/{cid}/{ver}/")[0].decode("utf-8", "replace")
    i = html.index("__DW_SVELTE_PROPS__")
    lit, _ = json.JSONDecoder().raw_decode(html[html.index("JSON.parse(", i) + len("JSON.parse("):])
    chart = json.loads(lit)["chart"]
    data_url = chart.get("externalData") or f"{DW}/{cid}/{ver}/dataset.csv"
    body, updated = curl(data_url)
    meta = dict(id=cid, title=" ".join(re.sub(r"<[^>]+>", "", chart["title"]).split()), version=int(ver), updated=updated, data_url=data_url)
    return body.decode("utf-8-sig"), meta


def get_chart(cid, cached):
    csv_path, meta_path = RAW / f"elevenify_{cid}.csv", RAW / f"elevenify_{cid}.json"
    if cached and csv_path.exists() and meta_path.exists():
        return csv_path.read_text(), json.loads(meta_path.read_text())
    text, meta = fetch_chart(cid)
    return text, meta


# ---------------------------------------------------------------- parse


class Teams:
    def __init__(self):
        boot = json.loads((RAW / "fpl_bootstrap.json").read_text())
        self.by_badge = {t["code"]: t["short_name"] for t in boot["teams"]}
        self.names = dict(ALIASES)
        for t in boot["teams"]:
            self.names[fold(t["name"])] = self.names[fold(t["short_name"])] = t["short_name"]
        self.full = {fold(t["name"]): t["short_name"] for t in boot["teams"]}

    def code(self, name, badge):
        """FPL short code from the Premier League badge number (t43) and/or the team name; both must agree."""
        by_b = self.by_badge.get(badge) if badge is not None else None
        n = fold(name)
        by_n = self.names.get(n)
        if by_n is None:  # "Hull" -> "Hull City", "Ipswich" -> "Ipswich Town"
            hits = {c for full, c in self.full.items() if full.startswith(n + " ")}
            by_n = hits.pop() if len(hits) == 1 else None
        if by_b and by_n and by_b != by_n:
            raise ValueError(f"team {name!r}: badge says {by_b}, name says {by_n}")
        if not (by_b or by_n):
            raise ValueError(f"team {name!r} (badge {badge}) is not an FPL team")
        return by_b or by_n


def read_rows(text):
    """CSV -> (header, [(label, badge number or None, [remaining cells])]). Blank rows are dropped."""
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    out = []
    for r in rows[1:]:
        b = re.search(r"/badges/\d+/t(\d+)\.png", r[1]) if len(r) > 1 else None
        out.append((r[0].strip(), int(b.group(1)) if b else None, r[2:]))
    return [c.strip() for c in rows[0]], out


def parse_chart(text, teams, title):
    """-> (kind, part). Raises on a layout we do not know, so a changed chart never produces wrong numbers."""
    head, rows = read_rows(text)
    if head[0] == "Player":
        cols = {c: head.index(c) - 2 for c in ("Goal Baseline", "Assist Baseline", "Goal Involvement Baseline")}
        part = [dict(name=n, team=teams.by_badge[b], goal=num(v[cols["Goal Baseline"]]), assist=num(v[cols["Assist Baseline"]]),
                     gi=num(v[cols["Goal Involvement Baseline"]])) for n, b, v in rows]
        return "player_baselines", part
    if head[0] == "Team" and any(c.startswith("Attack") for c in head):
        idx = {k: next(i for i, c in enumerate(head) if c.startswith(w)) - 2 for k, w in (("attack", "Attack"), ("defence", "Defence"), ("overall", "Overall"))}
        part = [dict(team=teams.code(n, b), **{k: num(v[i]) for k, i in idx.items()}) for n, b, v in rows]
        return "team_ratings", part
    if head[0] == "Team" and "Draw %" in head:  # blocks of three rows: home team, "v" with the draw %, away team
        i = {c: head.index(c) - 2 for c in ("Goals", "Clean Sheet", "Win %", "Draw %")}
        if len(rows) % 3 or any(rows[k][0] != "v" for k in range(1, len(rows), 3)):
            raise ValueError("match predictions are not in home / v / away blocks")
        part = []
        for k in range(0, len(rows), 3):
            (hn, hb, hv), (_, _, dv), (an, ab, av) = rows[k:k + 3]
            m = dict(home=teams.code(hn, hb), away=teams.code(an, ab), p_home=num(hv[i["Win %"]]), p_draw=num(dv[i["Draw %"]]), p_away=num(av[i["Win %"]]),
                     goals_home=num(hv[i["Goals"]]), goals_away=num(av[i["Goals"]]), cs_home=num(hv[i["Clean Sheet"]]), cs_away=num(av[i["Clean Sheet"]]))
            if not 0.97 <= m["p_home"] + m["p_draw"] + m["p_away"] <= 1.03:
                raise ValueError(f"{m['home']} v {m['away']}: win / draw / win does not add to 100%")
            part.append(m)
        return "match_predictions", part
    if head[0] == "Team" and head[-1].upper() == "TOTAL" and all(c.isdigit() for c in head[2:-1]) and len(head) > 3:
        pct = rows[0][2][0].strip().endswith("%")  # goals are plain numbers; clean sheets and wins are percents
        t = title.lower()
        kind = "team_clean_sheets" if "clean sheet" in t and pct else "team_wins" if "win" in t and pct else "team_goals" if "goal" in t and not pct else None
        if kind is None:
            raise ValueError(f"unknown per-gameweek chart: {title!r}")
        part = [dict(team=teams.code(n, b), gw={g: num(v[i]) for i, g in enumerate(head[2:-1]) if num(v[i]) is not None}, total=num(v[-1])) for n, b, v in rows]
        return kind, part
    raise ValueError(f"unknown chart layout: {head}")


# ---------------------------------------------------------------- build


def build(cached):
    teams, charts, parts, fetched = Teams(), [], {}, {}
    for cid in CHARTS:
        text, meta = get_chart(cid, cached)
        kind, part = parse_chart(text, teams, meta["title"])
        if kind not in ("player_baselines", "match_predictions") and len({r["team"] for r in part}) != len(teams.by_badge):
            raise ValueError(f"{cid}: {kind} has {len({r['team'] for r in part})} teams, expected {len(teams.by_badge)}")
        fetched[cid] = (text, meta)
        charts.append(dict(id=cid, title=meta["title"], updated=meta["updated"], kind=kind))
        parts[PART[kind]] = part
        log(f"{cid} {kind}: {len(part)} rows, updated {meta['updated']}, {meta['title']}")
    RAW.mkdir(parents=True, exist_ok=True)  # raw copies only once every chart has parsed
    for cid, (text, meta) in fetched.items():
        (RAW / f"elevenify_{cid}.csv").write_text(text)
        (RAW / f"elevenify_{cid}.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    return dict(generated_at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), source=SOURCE, charts=charts, **parts)


def main():
    try:
        res = build("--cached" in sys.argv[1:])
    except Exception as e:  # noqa: BLE001
        log(f"failed: {e}; keeping the previous elevenify.json")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "elevenify.json.tmp"
    tmp.write_text(json.dumps(res, indent=1, ensure_ascii=False))
    tmp.replace(OUT / "elevenify.json")
    for r in sorted(res.get("goals", []), key=lambda r: -r["total"])[:5]:
        print(f"{r['team']} goals {r['gw']} total={r['total']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
