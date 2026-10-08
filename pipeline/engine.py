#!/usr/bin/env python3
"""PL Fair Price engine.

Reads pipeline/raw/{xo_convictions,poly_events,fpl_bootstrap,fpl_fixtures}.json and writes
site/data/board.json, site/data/projections.json, appends site/data/history.jsonl and writes VERIFY.md.

Fair prices come from Polymarket's EPL markets (match 1X2 and season events), a Poisson match
model fitted to those prices, FPL xG/xA player shares, Tan's FPL flag study and a shared
Monte Carlo simulation of every remaining fixture. Markets without a defensible reference stay unpriced.
"""
import csv
import datetime as dt
import json
import math
import re
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson as _poisson

poisson_cdf = _poisson.cdf

TOOL = Path(__file__).resolve().parent.parent
RAW, OUT = TOOL / "pipeline" / "raw", TOOL / "site" / "data"
REFD = TOOL / "pipeline" / "ref"
REF = "cryptotan01"
N = 20000
RNG = np.random.default_rng(20261008)
FH_SHARE = 0.45  # share of goals scored in the first half (assumption)
RHO = -0.12  # Dixon-Coles low-score correction; plain Poisson fitted to 1X2 understates goals
LAST = REFD / "last_season_2025_26.csv"
CAPTAIN = REFD / "captain_odds.json"
BONUS = json.loads((REFD / "bonus_model.json").read_text())
DC_CAL = 0.89  # Poisson DEFCON estimate ran 2.4 pts high vs 309 players in 2025/26
POLY = "https://polymarket.com/event/"
FPL = "https://fantasy.premierleague.com/api/bootstrap-static/"
FPL_FIX = "https://fantasy.premierleague.com/api/fixtures/"
BAND = {"high": 0.03, "medium": 0.06, "low": 0.10}
REPO = "https://github.com/tannnnnnnnnnnnn/pl-fair-price"
VERIFY_URL = REPO + "/blob/main/VERIFY.md"


def load(name):
    return json.loads((RAW / name).read_text())


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def fold(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def resolution_description(row):
    """Load and lightly format immutable XO resolution rules from the metadata cache."""
    market = row.get("market") or {}
    uri = market.get("metadataUri") or (row.get("metadata") or {}).get("metadataUri")
    name = Path(urlparse(uri or "").path).name
    path = RAW / "xo_meta" / name
    if not name or not path.is_file():
        return ""
    try:
        description = json.loads(path.read_text()).get("rules", {}).get("description") or ""
    except (OSError, json.JSONDecodeError, AttributeError):
        return ""
    # Space after a full stop or colon glued to the next word, but not inside times (22:00) or decimals.
    description = re.sub(r"(?<!\d)([.:])(?=[A-Za-z0-9])|([.:])(?=[A-Za-z])", lambda m: (m.group(1) or m.group(2)) + " ", str(description).strip())
    # Numbered items ("1. ", "2. ") start a new line; years like "2026." are left alone.
    return re.sub(r"(?<=[.:])\s*(?=\b\d{1,2}\.\s)", "\n", description)


def clean_book(book):
    """Small, stable order-book shape used by the static site and live refresh."""
    return dict(
        bids=[dict(price=num(x.get("price")), size=num(x.get("size"))) for x in (book or {}).get("bids", [])
              if num(x.get("price")) is not None and num(x.get("size")) is not None],
        asks=[dict(price=num(x.get("price")), size=num(x.get("size"))) for x in (book or {}).get("asks", [])
              if num(x.get("price")) is not None and num(x.get("size")) is not None],
        last=num((book or {}).get("lastTradePrice")),
    )


def stake_result(stake, side, asks, fee_base, fair):
    """Walk asks with fees included in the spend. This does not affect fair pricing."""
    remaining = stake
    shares = fill_cost = fee = 0.0
    for level in sorted(asks, key=lambda x: x["price"]):
        p, available = level["price"], level["size"]
        unit_fee = fee_base * p * (1 - p)
        take = min(available, remaining / (p + unit_fee))
        shares += take
        fill_cost += take * p
        fee += take * unit_fee
        remaining -= take * (p + unit_fee)
        if remaining <= 1e-9:
            break
    cost = fill_cost + fee
    f, lo, hi = fair["p"], fair["low"], fair["high"]
    if side == "no":
        f, lo, hi = 1 - f, 1 - hi, 1 - lo
    return dict(side=side.upper(), ev=shares * f - cost, ev_low=shares * lo - cost,
                ev_high=shares * hi - cost, roi=(shares * f - cost) / cost if cost else 0,
                buy_price=fill_cost / shares if shares else None, fillable=cost)


# ---------------------------------------------------------------- FPL data
boot, fixtures = load("fpl_bootstrap.json"), load("fpl_fixtures.json")
TEAMS = {t["id"]: t["short_name"] for t in boot["teams"]}
TNAME = {t["short_name"]: t["name"] for t in boot["teams"]}
SHORT = sorted(TEAMS.values())
NEXT = next(e for e in boot["events"] if e["is_next"])
GW, DEADLINE = NEXT["id"], ts(NEXT["deadline_time"])
done = [x for x in fixtures if x["finished"]]
todo = sorted((x for x in fixtures if not x["finished"] and x["kickoff_time"] and x["event"]),
              key=lambda x: x["kickoff_time"])

table = {s: dict(p=0, w=0, pts=0, gf=0, ga=0) for s in SHORT}
for x in done:
    h, a = TEAMS[x["team_h"]], TEAMS[x["team_a"]]
    for t, gf, ga in ((h, x["team_h_score"], x["team_a_score"]), (a, x["team_a_score"], x["team_h_score"])):
        r = table[t]
        r["p"] += 1; r["gf"] += gf; r["ga"] += ga
        r["w"] += gf > ga; r["pts"] += 3 if gf > ga else 1 if gf == ga else 0

# ---------------------------------------------------------------- Polymarket
POLY_NAMES = [("Manchester City", "MCI"), ("Manchester United", "MUN"), ("Arsenal", "ARS"), ("Aston Villa", "AVL"),
              ("Bournemouth", "BOU"), ("Brentford", "BRE"), ("Brighton", "BHA"), ("Chelsea", "CHE"),
              ("Coventry", "COV"), ("Crystal Palace", "CRY"), ("Everton", "EVE"), ("Fulham", "FUL"), ("Hull", "HUL"),
              ("Ipswich", "IPS"), ("Leeds", "LEE"), ("Liverpool", "LIV"), ("Newcastle", "NEW"),
              ("Nottingham", "NFO"), ("Sunderland", "SUN"), ("Tottenham", "TOT")]


def code(name):
    return next((c for k, c in POLY_NAMES if k in name), None)


def pprice(m):
    """Polymarket YES price: bid/ask mid when the spread is 4c or less, else the displayed price."""
    b, a = num(m.get("bestBid")), num(m.get("bestAsk"))
    if b is not None and a is not None and 0 <= a - b <= 0.04:
        return (a + b) / 2, a - b
    try:
        return float(json.loads(m["outcomePrices"])[0]), (a - b if a is not None and b is not None else None)
    except (KeyError, ValueError, TypeError):
        return None, None


poly = load("poly_events.json")
POLY_EV = {e["title"]: e for e in poly}
odds = {}
for e in poly:
    t = e["title"]
    if " vs. " not in t or " - " in t or len(e.get("markets", [])) != 3:
        continue
    hn, an = (s.strip() for s in t.split(" vs. "))
    h, a = code(hn), code(an)
    if not h or not a or h not in SHORT or a not in SHORT:
        continue
    got = {}
    for m in e["markets"]:
        q = m["question"]
        key = "D" if "draw" in q.lower() else "H" if hn in q else "A" if an in q else None
        if key:
            got[key] = pprice(m)[0]
    if len(got) == 3 and None not in got.values():
        s = got["H"] + got["D"] + got["A"]
        odds[(h, a)] = dict(p=(got["H"] / s, got["D"] / s, got["A"] / s), raw=(got["H"], got["D"], got["A"]),
                            vol=e.get("volume") or 0, url=POLY + e["slug"])

# ---------------------------------------------------------------- match model
K = np.arange(11)
FACT = np.array([math.factorial(k) for k in K], float)


def pois(l):
    return np.exp(-l) * l ** K / FACT


def grid(lh, la):
    g = np.outer(pois(lh), pois(la))  # rows: home goals, cols: away goals
    g[0, 0] *= 1 - lh * la * RHO; g[0, 1] *= 1 + lh * RHO; g[1, 0] *= 1 + la * RHO; g[1, 1] *= 1 - RHO
    return g / g.sum()


def hda(g):
    return np.tril(g, -1).sum(), np.trace(g), np.triu(g, 1).sum()


def fit_pair(p):
    loss = lambda x: sum((o - t) ** 2 for o, t in zip(hda(grid(*np.exp(x))), p))
    r = minimize(loss, np.log([1.4, 1.1]), method="Nelder-Mead", options=dict(xatol=1e-7, fatol=1e-12, maxiter=4000))
    return tuple(float(v) for v in np.exp(r.x))


# Calibrate the Dixon-Coles rho so the fitted matches average the league's real goals per game.
LEAGUE_AVG = sum(x["team_h_score"] + x["team_a_score"] for x in done) / max(len(done), 1)
_best = None
for _r in np.arange(-0.20, 0.051, 0.01):
    RHO = float(_r)
    _m = np.mean([sum(fit_pair(o["p"])) for o in odds.values()])
    if _best is None or abs(_m - LEAGUE_AVG) < _best[0]:
        _best = (abs(_m - LEAGUE_AVG), RHO)
RHO = round(_best[1], 2)
for o in odds.values():
    o["lam"] = fit_pair(o["p"])
    o["fit"] = hda(grid(*o["lam"]))

# Team ratings (ridge regression on the fitted log-lambdas) price fixtures Polymarket doesn't list yet.
idx = {s: i for i, s in enumerate(SHORT)}
nT = len(SHORT)
rows, ys = [], []
for (h, a), o in odds.items():
    r1, r2 = np.zeros(2 + 2 * nT), np.zeros(2 + 2 * nT)
    r1[0] = r1[1] = 1; r1[2 + idx[h]] = 1; r1[2 + nT + idx[a]] = -1
    r2[0] = 1; r2[2 + idx[a]] = 1; r2[2 + nT + idx[h]] = -1
    rows += [r1, r2]; ys += [math.log(o["lam"][0]), math.log(o["lam"][1])]
W_RESULT = 0.25  # weight of one finished match vs one Polymarket-priced match
for x in done:
    h, a = TEAMS[x["team_h"]], TEAMS[x["team_a"]]
    r1, r2 = np.zeros(2 + 2 * nT), np.zeros(2 + 2 * nT)
    r1[0] = r1[1] = 1; r1[2 + idx[h]] = 1; r1[2 + nT + idx[a]] = -1
    r2[0] = 1; r2[2 + idx[a]] = 1; r2[2 + nT + idx[h]] = -1
    rows += [r1 * W_RESULT ** 0.5, r2 * W_RESULT ** 0.5]
    ys += [math.log(max(x["team_h_score"], 0.3)) * W_RESULT ** 0.5, math.log(max(x["team_a_score"], 0.3)) * W_RESULT ** 0.5]
A, Y = np.array(rows), np.array(ys)
beta = np.linalg.solve(A.T @ A + np.diag([0, 0] + [0.5] * (2 * nT)), A.T @ Y)


def rated(h, a):
    mu, ha = beta[0], beta[1]
    return (math.exp(mu + ha + beta[2 + idx[h]] - beta[2 + nT + idx[a]]),
            math.exp(mu + beta[2 + idx[a]] - beta[2 + nT + idx[h]]))


rating_err = [abs(math.log(rated(h, a)[i]) - math.log(o["lam"][i])) for (h, a), o in odds.items() for i in (0, 1)]

FX = []
for x in todo:
    h, a = TEAMS[x["team_h"]], TEAMS[x["team_a"]]
    o = odds.get((h, a))
    lh, la = o["lam"] if o else rated(h, a)
    live = bool(x.get("started"))
    left = max(0.0, 1 - (x.get("minutes") or 0) / 90) if live else 1.0
    FX.append(dict(gw=x["event"], h=h, a=a, ko=ts(x["kickoff_time"]), lh=lh, la=la,
                   vol=o["vol"] if o else 0, url=o["url"] if o else None, live=live, left=left,
                   base=(x.get("team_h_score") or 0, x.get("team_a_score") or 0) if live else (0, 0)))
GH, GA = np.zeros((N, len(FX)), np.int16), np.zeros((N, len(FX)), np.int16)
for _i, _z in enumerate(FX):  # sample exact scores from each fixture's Dixon-Coles grid
    if _z["left"] > 0.01:
        _s = RNG.choice(K.size ** 2, size=N, p=grid(_z["lh"] * _z["left"], _z["la"] * _z["left"]).ravel())
        GH[:, _i], GA[:, _i] = _s // K.size, _s % K.size
    GH[:, _i] += _z["base"][0]; GA[:, _i] += _z["base"][1]


def sel(team=None, until=None, gws=None, date=None, month=None, first=None):
    out = [i for i, z in enumerate(FX)
           if (not team or team in (z["h"], z["a"])) and (not until or z["ko"] <= until)
           and (not gws or z["gw"] in gws) and (not date or z["ko"].date().isoformat() == date)
           and (not month or z["ko"].strftime("%Y-%m") == month)]
    return out[:first] if first else out


def gf(team, i):
    return GH[:, i] if FX[i]["h"] == team else GA[:, i]


def ga(team, i):
    return GA[:, i] if FX[i]["h"] == team else GH[:, i]


def goals(team, ix):
    return sum((gf(team, i).astype(np.int32) for i in ix), np.zeros(N, np.int32))


def points(team, ix):
    return sum((np.where(gf(team, i) > ga(team, i), 3, np.where(gf(team, i) == ga(team, i), 1, 0)) for i in ix),
               np.zeros(N, np.int32))


def next_fx(team):
    return sel(team=team, first=1)[0]


def table_after(gw):
    """Simulated table after matchweek `gw`: ranks (N, teams), points (N, teams)."""
    ix = [i for i, z in enumerate(FX) if z["gw"] <= gw]
    P = np.array([[table[s]["pts"]] * N for s in SHORT], np.int32).T
    GD = np.array([[table[s]["gf"] - table[s]["ga"]] * N for s in SHORT], np.int32).T
    GF = np.array([[table[s]["gf"]] * N for s in SHORT], np.int32).T
    for i in ix:
        h, a = idx[FX[i]["h"]], idx[FX[i]["a"]]
        hg, ag = GH[:, i].astype(np.int32), GA[:, i].astype(np.int32)
        P[:, h] += np.where(hg > ag, 3, np.where(hg == ag, 1, 0)); P[:, a] += np.where(ag > hg, 3, np.where(hg == ag, 1, 0))
        GD[:, h] += hg - ag; GD[:, a] += ag - hg; GF[:, h] += hg; GF[:, a] += ag
    key = P * 1_000_000 + (GD + 500) * 1_000 + GF + RNG.random(P.shape)  # points, GD, goals, then random
    rank = (-key).argsort(axis=1).argsort(axis=1) + 1
    return rank, P


TAB9, PTS9 = table_after(9)
TAB8, _ = table_after(8)

# ---------------------------------------------------------------- players
EL = {p["id"]: p for p in boot["elements"]}
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
GOAL_PTS, CS_PTS = {1: 6, 2: 6, 3: 5, 4: 4}, {1: 4, 2: 4, 3: 1, 4: 0}
PRIOR_G, PRIOR_A = {1: 0.0, 2: 0.04, 3: 0.15, 4: 0.38}, {1: 0.01, 2: 0.06, 3: 0.15, 4: 0.12}
team_xg = {s: 0.0 for s in SHORT}
for p in boot["elements"]:
    team_xg[TEAMS[p["team"]]] += num(p["expected_goals"]) or 0
last = {}  # 2025/26 totals by player name: minutes, xG, goals, xA, assists
for r in csv.DictReader(LAST.open()):
    last[r["name"]] = [float(r[c]) for c in ("minutes", "xg", "goals", "xa", "assists")]

def flag_start(p, regular):
    """Flagged players: FPL's own chance of playing, as published. No historical adjustment."""
    c = p["chance_of_playing_next_round"]
    if c is None or c == 100:
        return None, None
    return c / 100, f"FPL: {c}% chance of playing"


def player(pid):
    p = EL[pid]
    t, pos = TEAMS[p["team"]], p["element_type"]
    g = max(table[t]["p"], 1)
    # Rates from xG/xA only (actual goals are too noisy over 5 games): this season plus 2025/26 at 60% weight,
    # shrunk toward a positional prior worth 4 matches. The team's xG per game is shrunk toward the league
    # average (5 matches' weight), so a team that has barely scored can't inflate one player's share.
    lm, lxg, lg_, lxa, la_ = last.get(fold(f'{p["first_name"]} {p["second_name"]}'), [0.0] * 5)
    n90 = (p["minutes"] + 0.6 * lm) / 90
    xg90 = ((num(p["expected_goals"]) or 0) + 0.6 * lxg + 4 * PRIOR_G[pos]) / (n90 + 4)
    xa90 = ((num(p["expected_assists"]) or 0) + 0.6 * lxa + 4 * PRIOR_A[pos]) / (n90 + 4)
    txg = (team_xg[t] + 5 * LEAGUE_AVG / 2) / (g + 5)
    start_rate = min(p["starts"] / g, 1.0)
    regular = start_rate >= 0.6
    em = p["minutes"] / (g * 90)  # share of the team's minutes he has played
    base = min(max(start_rate, 3 * em), 0.95)  # bench players get cameos; nailed starters keep a 5% miss chance
    mpg = min(em / base, 1.0) if base else 0.0
    fs, why = flag_start(p, regular)
    nxt = base * fs if fs is not None else (0.0 if p["status"] in ("i", "s", "u", "n") else base)
    dc90 = num(p.get("defensive_contribution_per_90")) or 0
    thr = BONUS["defcon_threshold"]["DEF" if pos == 2 else "MID"]
    p_dc = 0.0 if pos == 1 or p["minutes"] < 90 else DC_CAL * float(1 - poisson_cdf(thr - 1, dc90 * mpg))
    return dict(id=pid, name=p["web_name"], team=t, pos=pos, p_dc=p_dc, qg=min(xg90 / txg, 0.8) * mpg,
                qa=min(xa90 / txg, 0.6) * mpg, p_next=nxt, p_later=base, flag_note=why,
                xg=num(p["expected_goals"]) or 0, xa=num(p["expected_assists"]) or 0, mins=p["minutes"],
                starts=p["starts"], team_games=g, regular=regular)


def find(name, team=None):
    n = fold(name)
    for p in boot["elements"]:
        full = fold(f'{p["first_name"]} {p["second_name"]}')
        if (n == fold(p["web_name"]) or n in full) and (not team or TEAMS[p["team"]] == team):
            return p["id"]
    return None


def psim(pid, ix):
    """Per-fixture simulated goals and assists for one player (binomial thinning of team goals)."""
    m = player(pid)
    first = next_fx(m["team"])
    G, AS = np.zeros((N, len(ix)), np.int16), np.zeros((N, len(ix)), np.int16)
    for k, i in enumerate(ix):
        tg = gf(m["team"], i).astype(np.int64)
        played = RNG.random(N) < (m["p_next"] if i == first else m["p_later"])
        g = RNG.binomial(tg, m["qg"]) * played
        a = RNG.binomial(tg - g, min(m["qa"] / max(1 - m["qg"], 1e-6), 1.0)) * played
        G[:, k], AS[:, k] = g, a
    return G, AS, m


def fpl_points(pid, ix):
    G, AS, m = psim(pid, ix)
    tot = np.zeros(N, np.int32)
    for k, i in enumerate(ix):
        played = (G[:, k] + AS[:, k] > 0) | (RNG.random(N) < (m["p_next"] if i == next_fx(m["team"]) else m["p_later"]))
        cs = ga(m["team"], i) == 0
        tot += played * (2 + CS_PTS[m["pos"]] * cs) + G[:, k] * GOAL_PTS[m["pos"]] + AS[:, k] * 3
    return tot, m


# ---------------------------------------------------------------- pricing helpers
def res(p, conf, method, text, inputs, fx=None):
    return dict(p=float(p), conf=conf, method=method, text=text, inputs=inputs, fx=fx)


def unp(reason):
    return dict(p=None, reason=reason)


def fx_in(i):
    z = FX[i]
    src = (dict(label=f'Polymarket {TNAME[z["h"]]} v {TNAME[z["a"]]} (${z["vol"]:,.0f} traded)', value="1X2 prices",
                source_url=z["url"]) if z["url"] else
           dict(label=f'{TNAME[z["h"]]} v {TNAME[z["a"]]}', value="team ratings (no Polymarket market yet)",
                source_url=FPL_FIX))
    lam = dict(label=f'Model expected goals {z["h"]}-{z["a"]}', value=f'{z["lh"]:.2f}-{z["la"]:.2f}', source_url=VERIFY_URL)
    return [src, lam]


def fx_conf(ix):
    if all(FX[i]["vol"] > 20000 for i in ix):
        return "high"
    # medium needs a real Polymarket price ($1,000+ traded) on every fixture; thin or ratings-only fixtures are low
    return "medium" if all(FX[i]["url"] and FX[i]["vol"] >= 1000 for i in ix) else "low"


def team_fx(team, gw=GW):
    return sel(team=team, gws={gw})[0]


def p_in(m):
    note = f' ({m["flag_note"]})' if m["flag_note"] else ""
    return dict(label=f'{m["name"]}: xG {m["xg"]:.2f}, xA {m["xa"]:.2f} in {m["mins"]} min, {m["starts"]}/{m["team_games"]} starts{note}',
                value=f'{m["qg"]:.0%} of team goals, plays {m["p_next"]:.0%} next match', source_url=FPL)


def poly_ev(title, picks):
    e = POLY_EV.get(title)
    if not e:
        return None
    out = []
    for m in e["markets"]:
        if any(k in m["question"] for k in picks):
            pr, spread = pprice(m)
            out.append((m["question"], pr, spread, num(m.get("volume")) or 0))
    return e, out


def direct(title, pick, xo_side=True, note=""):
    got = poly_ev(title, [pick])
    if not got or not got[1]:
        return unp("Matching Polymarket market not found")
    e, ms = got
    q, pr, spread, vol = ms[0]
    spread = spread if spread is not None else 1
    conf = "high" if vol > 20000 and spread <= 0.04 else "medium" if spread <= 0.04 else "low"
    p = pr if xo_side else 1 - pr
    return res(p, conf, "polymarket", f"Taken straight from Polymarket's matching market: \"{q}\"" + (f" {note}" if note else ""),
               [dict(label=q, value=f"{pr:.1%} (spread {spread*100:.0f}c, ${vol:,.0f} traded on this market)",
                     source_url=POLY + e["slug"])])


def deduction(threshold_low):
    e = POLY_EV.get("How many EPL points will Man City be deducted?")
    buckets = [(m["question"], pprice(m)[0]) for m in e["markets"]]
    tot = sum(p for _, p in buckets)
    yes = 0.0
    for q, p in buckets:
        lo = re.search(r"deducted (\d+)", q)
        if not lo or "expelled" in q:
            continue
        a = int(lo.group(1))
        hi = re.search(r"deducted \d+-(\d+)", q)
        b = int(hi.group(1)) if hi else 999 if "or more" in q else a
        if a >= threshold_low:
            yes += p
        elif b >= threshold_low:  # partial bucket: spread evenly across its points
            yes += p * (b - threshold_low + 1) / (b - a + 1)
    return res(yes / tot, "low", "polymarket",
               f"Sum of Polymarket's deduction buckets at {threshold_low}+ points, normalised to 100%. Expulsion is not counted as points docked, and Polymarket doesn't say which season a deduction would apply to.",
               [dict(label=q, value=f"{p:.1%}", source_url=POLY + e["slug"]) for q, p in buckets])


# ---------------------------------------------------------------- market pricers
def m_single_score(team, kind, k=1):
    i = team_fx(team)
    z = FX[i]
    if kind == "concede_ge":
        v = (ga(team, i) >= k).mean(); txt = f"Chance {TNAME[team]} concede {k}+ in the match."
    elif kind == "no_cs":
        v = (ga(team, i) >= 1).mean(); txt = f"Chance {TNAME[team]} concede at least once, so no clean sheet."
    elif kind == "fail_fh":
        lam = (z["lh"] if z["h"] == team else z["la"]) * FH_SHARE
        return res(math.exp(-lam), "low", "match_model",
                   f"Chance {TNAME[team]} don't score before half-time, assuming {FH_SHARE:.0%} of goals come in the first half.",
                   fx_in(i), i)
    elif kind == "first_goal_2h":
        lam = z["lh"] if z["h"] == team else z["la"]
        v = math.exp(-lam * FH_SHARE) * (1 - math.exp(-lam * (1 - FH_SHARE)))
        return res(v, "low", "match_model",
                   f"Chance {TNAME[team]} score none before half-time but at least one after, assuming {FH_SHARE:.0%} of goals come in the first half. No goal at all counts as NO.",
                   fx_in(i), i)
    return res(v, fx_conf([i]), "match_model", txt + " Poisson model fitted to Polymarket's match prices.", fx_in(i), i)


def m_player_goal(name, team, need=1, of=1, ga_=False, each=False):
    pid = find(name, team)
    if not pid:
        return unp(f"{name} not found in FPL data")
    ix = sel(team=team, first=of)
    G, AS, m = psim(pid, ix)
    hits = (G + AS) if ga_ else G
    hit = hits >= 1
    v = hit.all(axis=1).mean() if each else (hit.sum(axis=1) >= need).mean()
    what = "score or assist" if ga_ else "score"
    txt = (f"Chance {m['name']} {what} in {'each' if each else f'{need}+'} of the next {of} league matches. "
           f"His share of the team's goals comes from FPL xG/xA; team goals come from the match model.")
    # Low until calibrated: the xG-share model rates elite strikers below bookmakers (Haaland 0.50 vs ~0.6-0.69 expected goals at Anfield).
    return res(v, "low", "player_model", txt + " Bookmakers usually rate star strikers a little higher.", [p_in(m)] + sum((fx_in(i) for i in ix[:2]), []),
               ix[0] if of == 1 else None) | dict(pid=pid)


def m_player_total(name, team, need, until):
    pid = find(name, team)
    if not pid:
        return unp(f"{name} not found in FPL data")
    ix = sel(team=team, until=until)
    G, _, m = psim(pid, ix)
    have = EL[pid]["goals_scored"]
    v = (G.sum(axis=1) >= need).mean()
    if have > 0:
        return readings((have + G.sum(axis=1) >= need).mean(), v, f"season total (he has {have} already)",
                        "only goals from now", "low", "player_model", [p_in(m)]) | dict(pid=pid)
    return res(v, "low", "player_model",
               f"Chance {m['name']} scores {need}+ more league goals by {until:%d %b} across {len(ix)} fixtures. He has {have} already; the market opened during the international break, so we count only new goals (our reading).",
               [p_in(m), dict(label="Goals so far", value=str(have), source_url=FPL)]) | dict(pid=pid)


def m_player_vs(a, ta, b, tb, until=None, gws=None, ga_=False, season=False):
    pa, pb = find(a, ta), find(b, tb)
    if not pa or not pb:
        return unp("Player not found in FPL data")
    ta, tb = TEAMS[EL[pa]["team"]], TEAMS[EL[pb]["team"]]
    ia, ib = sel(team=ta, until=until, gws=gws), sel(team=tb, until=until, gws=gws)
    Ga, Aa, ma = psim(pa, ia)
    Gb, Ab, mb = psim(pb, ib)
    sa = Ga.sum(1) + (Aa.sum(1) if ga_ else 0) + (EL[pa]["goals_scored"] if season else 0)
    sb = Gb.sum(1) + (Ab.sum(1) if ga_ else 0) + (EL[pb]["goals_scored"] if season else 0)
    span = f"by {until:%d %b}" if until else f"in GW{min(gws)}-{max(gws)}"
    what = "goals + assists" if ga_ else "goals"
    return res((sa > sb).mean(), "low", "player_model",
               f"Chance {ma['name']} has strictly more {what} than {mb['name']} {span}{' (season totals)' if season else ''}. A tie counts as NO.",
               [p_in(ma), p_in(mb)]) | dict(pid=pa, pid2=pb)


def m_player_vs_team(name, pteam, team, until):
    pid = find(name, pteam)
    ix_p, ix_t = sel(team=pteam, until=until), sel(team=team, until=until)
    G, _, m = psim(pid, ix_p)
    have_p, have_t = EL[pid]["goals_scored"], table[team]["gf"]
    v = (have_p + G.sum(1) > have_t + goals(team, ix_t)).mean()
    return res(v, "low", "player_model",
               f"Season league goals {until:%d %b}: {m['name']} (now {have_p}) vs {TNAME[team]} (now {have_t}). Strictly more counts as YES.",
               [p_in(m), dict(label=f"{TNAME[team]} goals so far", value=str(have_t), source_url=FPL_FIX)]) | dict(pid=pid)


def m_team_table(kind):
    if kind == "city_clear":
        c = idx["MCI"]
        second = np.sort(PTS9, axis=1)[:, -2]
        v = ((TAB9[:, c] == 1) & (PTS9[:, c] - second >= 3)).mean()
        txt = "City top after MW9 with a lead of 3+ points over second place."
    elif kind == "spurs_b3":
        v = (TAB9[:, idx["TOT"]] >= 18).mean(); txt = "Spurs 18th, 19th or 20th after MW9."
    else:
        v = (TAB8[:, idx["COV"]] < TAB8[:, idx["TOT"]]).mean(); txt = "Coventry above Spurs after GW8."
    return res(v, "medium", "table_sim",
               txt + f" {N:,} simulated seasons from today's table; points, then goal difference, then goals scored.",
               [dict(label="Matches", value="GW6-7 from Polymarket prices, GW8-9 from fitted team ratings", source_url=FPL_FIX)])


def m_captain():
    c = json.loads(CAPTAIN.read_text())
    lg, la_, sub = c["lambda_g"], c["lambda_a"], c["p_sub60"]
    v = sub + (1 - sub) * math.exp(-lg - la_)
    i = next_fx("MCI")
    return res(v, "medium", "captain_model",
               "Assumes Haaland is GW6's most-captained player (he was in GW5). Blank = no goal and no assist; "
               "goal and assist rates come from bookmaker odds for Liverpool v City (Tan's captain model, 6 Oct), "
               f"plus a {sub:.0%} chance he misses out or plays under 60 minutes.",
               [dict(label="Haaland expected goals at Anfield (bookmaker anytime-scorer odds, 6 Oct)", value=f"{lg:.2f}",
                     source_url=REPO + "/blob/main/pipeline/ref/captain_odds.json"),
                dict(label="Haaland expected assists (bookmaker assist odds, 6 Oct)", value=f"{la_:.2f}",
                     source_url=REPO + "/blob/main/pipeline/ref/captain_odds.json")] + fx_in(i), i) | dict(pid=411)


def m_fpl_vs(a, ta, b, tb, gws):
    pa, pb = find(a, ta), find(b, tb)
    if not pa or not pb:
        return unp("Player not found in FPL data")
    ta, tb = TEAMS[EL[pa]["team"]], TEAMS[EL[pb]["team"]]
    sa, ma = fpl_points(pa, sel(team=ta, gws=gws))
    sb, mb = fpl_points(pb, sel(team=tb, gws=gws))
    return res((sa > sb).mean(), "low", "fpl_points",
               f"Simulated FPL points (appearance, goals, assists, clean sheets; no bonus or defensive points), GW{min(gws)}-{max(gws)}. A tie counts as NO.",
               [p_in(ma), p_in(mb)]) | dict(pid=pa, pid2=pb)


def gw_day(date):
    ix = sel(date=date)
    tot = sum((GH[:, i].astype(np.int32) + GA[:, i] for i in ix), np.zeros(N, np.int32))
    return ix, tot


LONDON = ["ARS", "CHE", "CRY", "FUL", "BRE", "TOT"]
NORTH = ["LIV", "MCI", "MUN", "NEW", "LEE", "EVE", "SUN", "HUL"]
END_OCT = dt.datetime(2026, 10, 31, 23, 59, tzinfo=dt.timezone.utc)
NOV1 = dt.datetime(2026, 11, 1, 23, 59, tzinfo=dt.timezone.utc)
XMAS = dt.datetime(2026, 12, 24, 23, 59, tzinfo=dt.timezone.utc)
BOXING = dt.datetime(2026, 12, 26, 23, 59, tzinfo=dt.timezone.utc)


def m_london_north():
    ix = sel(gws={GW})
    lon = sum((goals(t, [i for i in ix if t in (FX[i]["h"], FX[i]["a"])]) for t in LONDON), np.zeros(N, np.int32))
    nor = sum((goals(t, [i for i in ix if t in (FX[i]["h"], FX[i]["a"])]) for t in NORTH), np.zeros(N, np.int32))
    return res((lon > nor).mean(), fx_conf(ix), "match_model",
               f"GW{GW} goals by London clubs ({', '.join(LONDON)}) vs northern clubs ({', '.join(NORTH)}); strictly more counts as YES. Club lists are our reading of the question.",
               [dict(label="All GW6 matches", value="Polymarket 1X2 prices", source_url=POLY)])


def m_lowest_game():
    i = sel(team="MUN", gws={GW})[0]
    ix = sel(date=FX[i]["ko"].date().isoformat())
    tot = {j: GH[:, j].astype(np.int32) + GA[:, j] for j in ix}
    others = np.min(np.array([tot[j] for j in ix if j != i]), axis=0)
    return readings((tot[i] <= others).mean(), (tot[i] < others).mean(), f"joint-lowest of the {len(ix)} games that day counts",
                    "only the strict lowest counts", "low", "match_model", fx_in(i), i)


def m_goals_on(date, need):
    ix, tot = gw_day(date)
    return res((tot >= need).mean(), fx_conf(ix), "match_model",
               f"Total goals across the {len(ix)} league games on {date}; needs {need}+.",
               [dict(label=f"{len(ix)} matches", value="Polymarket 1X2 prices", source_url=POLY)])


def m_cov_lowest():
    ix = sel(gws={6, 7, 8, 9})
    g = {t: goals(t, [i for i in ix if t in (FX[i]["h"], FX[i]["a"])]) for t in SHORT}
    others = np.min(np.array([g[t] for t in SHORT if t != "COV"]), axis=0)
    return res((g["COV"] <= others).mean(), fx_conf(ix), "match_model",
               "Coventry score the fewest (or joint-fewest) league goals across MW6-9.",
               [dict(label="MW6-9 fixtures", value="Polymarket prices (GW6-7) and team ratings (GW8-9)", source_url=FPL_FIX)])


def m_team_count(team, kind, need=None, ix=None, txt=""):
    ix = ix if ix is not None else []
    if kind == "goals_ge":
        v = (goals(team, ix) >= need).mean()
    elif kind == "pts_ge":
        v = (points(team, ix) >= need).mean()
    elif kind == "score_each":
        v = np.all(np.array([gf(team, i) >= 1 for i in ix]), axis=0).mean()
    elif kind == "wins_lt":
        w = sum((gf(team, i) > ga(team, i) for i in ix), np.zeros(N, np.int32))
        v = (table[team]["w"] + w < need).mean()
    return res(v, fx_conf(ix), "match_model", txt + f" ({len(ix)} fixtures)",
               [dict(label="Fixtures", value=", ".join(f'{FX[i]["h"]}-{FX[i]["a"]}' for i in ix[:6]), source_url=FPL_FIX)])


def m_team_vs(a, b, ix_a, ix_b, kind, txt):
    va = goals(a, ix_a) if kind == "goals" else points(a, ix_a)
    vb = goals(b, ix_b) if kind == "goals" else points(b, ix_b)
    return res((va > vb).mean(), fx_conf(ix_a + ix_b), "match_model", txt + " A tie counts as NO.",
               [dict(label="Fixtures", value=f"{len(ix_a)} for {a}, {len(ix_b)} for {b}", source_url=FPL_FIX)])


def m_any_cs_oct():
    gws = sorted({FX[i]["gw"] for i in sel(month="2026-10")})
    hit = np.zeros(N, bool)
    for t in SHORT:
        ok = np.ones(N, bool)
        for g in gws:
            for i in sel(team=t, gws={g}):
                ok &= ga(t, i) == 0
        hit |= ok
    return res(hit.mean(), fx_conf(sel(month="2026-10")), "match_model",
               f"Chance at least one club keeps a clean sheet in every one of GW{gws[0]}-{gws[-1]}.",
               [dict(label="October gameweeks", value=", ".join(map(str, gws)), source_url=FPL_FIX)])


def m_any_big3_lose():
    i1, i2 = sel(team="MCI", gws={GW})[0], sel(team="MUN", gws={GW})[0]
    lose_mci = ga("MCI", i1) > gf("MCI", i1)
    lose_liv = ga("LIV", i1) > gf("LIV", i1) if "LIV" in (FX[i1]["h"], FX[i1]["a"]) else np.zeros(N, bool)
    lose_mun = ga("MUN", i2) > gf("MUN", i2)
    return readings((lose_mci | lose_liv | lose_mun).mean(), lose_mun.mean(), "whole matchweek (Liverpool v City only avoids a loser with a draw)",
                    "only games before the XO market closes on Saturday (just Man Utd v Spurs)", "low", "match_model",
                    fx_in(i1) + fx_in(i2))


def m_ipswich_coventry():
    got = poly_ev("Premier League: Teams relegated (2026-27)", ["Ipswich", "Coventry"])
    e, ms = got
    p = {("IPS" if "Ipswich" in q else "COV"): pr for q, pr, _, _ in ms}
    return res(p["IPS"] * p["COV"], "low", "polymarket",
               "Polymarket's relegation prices for each club multiplied together. With only three relegation places the two "
               "compete, so the true chance is a few points lower (about 21% under a correlated model).",
               [dict(label=q, value=f"{pr:.1%}", source_url=POLY + e["slug"]) for q, pr, _, _ in ms])


def m_chelsea_spurs():
    c, t = sel(team="CHE", until=NOV1), sel(team="TOT", until=NOV1)
    conc = sum((ga("CHE", i).astype(np.int32) for i in c), np.zeros(N, np.int32))
    sc = goals("TOT", t)
    season = ((table["CHE"]["ga"] + conc) > (table["TOT"]["gf"] + sc)).mean()
    fresh = (conc > sc).mean()
    return readings(season, fresh, f"season totals (Chelsea have conceded {table['CHE']['ga']}, Spurs have scored {table['TOT']['gf']})",
                    "only goals from now to 1 Nov", "low", "match_model",
                    [dict(label="Fixtures to 1 Nov", value=f"{len(c)} Chelsea, {len(t)} Spurs", source_url=FPL_FIX)])


def readings(a, b, label_a, label_b, conf, method, inputs, fx=None):
    """Two fair readings of an ambiguous question: no number if they differ by more than 25 pts."""
    txt = f"Two readings: {label_a}: {a:.0%}. {label_b}: {b:.0%}."
    if abs(a - b) > 0.25:
        return unp(txt + " They differ too much to show one number.")
    return res(a, "low", method, txt + " We show the first, at low confidence.", inputs, fx)


UNPRICED = {
    "var": "No reliable public source prices VAR decisions.",
    "stats": "Needs match stats (possession, distance, shots) we don't model.",
    "minutes": "Minutes questions need team news; check the press conference.",
    "contract": "Contract news has no market or data reference.",
    "manager": "No Polymarket market prices this manager's job by this date.",
    "setpiece": "No clean data on set-piece or corner goals.",
    "pen": "Too few penalties for a reliable base rate.",
    "captain_share": "FPL publishes captaincy only after the deadline.",
    "ambiguous": "The question's wording is open to more than one reading.",
    "offtopic": "Not a football question we can price.",
}


def U(k):
    return unp(UNPRICED[k])


SPECS = [
    (r"VAR", lambda: U("var")),
    (r"London's clubs outscore", m_london_north),
    (r"De Zerbi be sacked before", lambda: unp("Only reference is a $212 Polymarket market with a 37-point spread.")),
    (r"Coventry City be the lowest or joint lowest-scoring", m_cov_lowest),
    (r"lowest-scoring game of the day", m_lowest_game),
    (r"19\+ goals be scored across all Premier League games on 10th October", lambda: m_goals_on("2026-10-10", 19)),
    (r"score directly from a corner", lambda: U("setpiece")),
    (r"under 30% possession", lambda: U("stats")),
    (r"clean-sheet drought reach 22", lambda: m_single_score("CHE", "no_cs")),
    (r"Tottenham score at least 3 goals in October", lambda: m_team_count("TOT", "goals_ge", 3, sel(team="TOT", month="2026-10"), "Spurs score 3+ league goals in October.")),
    (r"Mainoo play at least 180", lambda: U("minutes")),
    (r"contract for Kevin Schade", lambda: U("contract")),
    (r"Liverpool earn at least 7 points in their next 4", lambda: m_team_count("LIV", "pts_ge", 7, sel(team="LIV", first=4), "Liverpool take 7+ points from their next 4 league matches.")),
    (r"more possession & shots", lambda: U("stats")),
    (r"Both teams to score before two-goal lead", lambda: unp("Depends on the order of goals, which our model doesn't track.")),
    (r"non-penalty set piece", lambda: U("setpiece")),
    (r"Gy.keres score in each of Arsenal", lambda: m_player_goal("Gyökeres", "ARS", of=3, each=True)),
    (r"Joelinton play 30\+", lambda: U("minutes")),
    (r"Arsenal's first goal against Leeds come after half-time", lambda: m_single_score("ARS", "first_goal_2h")),
    (r"Pascal Gro. score or assist in at least 2", lambda: m_player_goal("Groß", "BHA", need=2, of=4, ga_=True)),
    (r"Brighton outscore Arsenal across", lambda: m_team_vs("BHA", "ARS", sel(team="BHA", gws={6, 7, 8}), sel(team="ARS", gws={6, 7, 8}), "goals", "Brighton score more league goals than Arsenal across MW6-8.")),
    (r"Cole Palmer score against Bournemouth", lambda: m_player_goal("Palmer", "CHE")),
    (r"Man City Sanctions announced before Nov 6", lambda: direct("Manchester City punishment announced by...?", "November 6")),
    (r"Brighton score in every Premier League match they play in October", lambda: m_team_count("BHA", "score_each", ix=sel(team="BHA", month="2026-10"), txt="Brighton score in every October league match.")),
    (r"degaard record a G/A in each", lambda: m_player_goal("Ødegaard", "ARS", of=3, ga_=True, each=True)),
    (r"Richarlison start a match", lambda: U("minutes")),
    (r"Lampard still be Coventry", lambda: U("manager")),
    (r"Erling Haaland score vs Liverpool", lambda: m_player_goal("Haaland", "MCI")),
    (r"Carrick or De Zerbi be sacked", lambda: U("manager")),
    (r"Arsenal fail to score a First-Half goal", lambda: m_single_score("ARS", "fail_fh")),
    (r"Chelsea concede 2 or more goals this Matchweek", lambda: m_single_score("CHE", "concede_ge", 2)),
    (r"Cherki get more PL goals \+ assists than Wirtz", lambda: m_player_vs("Cherki", "MCI", "Wirtz", "LIV", gws={6, 7, 8, 9}, ga_=True)),
    (r"Total Distance", lambda: U("stats")),
    (r"Shots on Target", lambda: U("stats")),
    (r"Carrick still be Manchester United manager on 31 October", lambda: direct("Michael Carrick out as Manchester United manager by...?", "October 31", xo_side=False)),
    (r"Merino play more minutes", lambda: U("minutes")),
    (r"Man United earn more PL points than Spurs", lambda: m_team_vs("MUN", "TOT", sel(team="MUN", gws={6, 7, 8, 9}), sel(team="TOT", gws={6, 7, 8, 9}), "points", "Man Utd take more league points than Spurs in MW6-9.")),
    (r"Haaland score in at least 2 of Man City's next 3", lambda: m_player_goal("Haaland", "MCI", need=2, of=3)),
    (r"Gyokeres outscore Bruno Fernandes", lambda: m_player_vs("Gyökeres", "ARS", "Fernandes", "MUN", gws={6, 7})),
    (r"Haaland have more Premier League goals than Tottenham by November 1", lambda: m_player_vs_team("Haaland", "MCI", "TOT", NOV1)),
    (r"coach be sacked before November 1", lambda: U("manager")),
    (r"clean sheet in all four October gameweeks", m_any_cs_oct),
    (r"Chelsea concede more Premier League goals than Spurs score", lambda: m_chelsea_spurs()),
    (r"Gonzalo Garcia outscore Josh King in FPL points", lambda: m_fpl_vs("Gonzalo", None, "King", "FUL", {6, 7, 8})),
    (r"Coventry be above Tottenham", lambda: m_team_table("cov_tot")),
    (r"Tottenham be in the Premier League bottom three after Matchweek 9", lambda: m_team_table("spurs_b3")),
    (r"Man City be 3\+ points clear at the top", lambda: m_team_table("city_clear")),
    (r"most-captained player score 3 or fewer", m_captain),
    (r"Jo.o Pedro start for Chelsea vs Bournemouth", lambda: unp("Comes down to team news: the press conference, then lineups 75 minutes before kick-off.")),
    (r"Haaland be the most selected Captain", lambda: U("captain_share")),
    (r"Josh King score more FPL points than Pascal", lambda: m_fpl_vs("King", "FUL", "Groß", "BHA", {6})),
    (r"outscore Chelsea, Arsenal, and Man Utd combined in GW7", lambda: (lambda c: res((goals("MCI", sel(team="MCI", gws={7})) > sum((goals(t, sel(team=t, gws={7})) for t in ("CHE", "ARS", "MUN")), np.zeros(N, np.int32))).mean(), fx_conf(sum((sel(team=t, gws={7}) for t in ("MCI", "CHE", "ARS", "MUN")), [])), "match_model", "City's GW7 goals vs Chelsea, Arsenal and Man Utd combined; strictly more counts as YES.", fx_in(sel(team="MCI", gws={7})[0])))(None)),
    (r"manager lose their job before GW11", lambda: U("manager")),
    (r"De Zerbi still be Spurs manager", lambda: U("manager")),
    (r"Next Premier League Hat-Trick", lambda: U("ambiguous")),
    (r"Saka score 3\+ EPL goals", lambda: m_player_total("Saka", "ARS", 3, XMAS)),
    (r"over 20 points docked", lambda: deduction(21)),
    (r"Man City Premier League title be stripped", lambda: direct("Man City to be stripped of EPL title by June 30, 2027?", "stripped", note="Polymarket only covers up to 30 Jun 2027 while this XO market runs longer, so treat it as a floor.") | dict(conf="low")),
    (r"10 or more points deducted", lambda: deduction(10)),
    (r"Isak vs Jo.o Pedro", lambda: m_player_vs("Isak", "LIV", "João Pedro", "CHE", until=dt.datetime(2027, 5, 31, tzinfo=dt.timezone.utc), season=True)),
    (r"Haaland \+ Saka outscore Tottenham", lambda: (lambda: (lambda h, s, t: res(((h[0].sum(1) + s[0].sum(1)) > goals("TOT", t)).mean(), "low", "player_model", "Haaland's and Saka's GW6 goals combined vs Spurs' GW6 goals; strictly more counts as YES.", [p_in(h[2]), p_in(s[2])] + fx_in(t[0])))(psim(411, sel(team="MCI", gws={6})), psim(find("Saka", "ARS"), sel(team="ARS", gws={6})), sel(team="TOT", gws={6})))()),
    (r"any of Man City, Man United or Liverpool lose", m_any_big3_lose),
    (r"Haaland will score more goals than Tottenham Hotspurs by Boxing Day", lambda: m_player_vs_team("Haaland", "MCI", "TOT", BOXING)),
    (r"Miss Their Next Penalty", lambda: U("pen")),
    (r"Haaland vs Bruno Fernandes", lambda: m_player_vs("Haaland", "MCI", "Fernandes", "MUN", until=XMAS, season=True)),
    (r"fewer than 4 Premier League wins by Christmas", lambda: m_team_count("TOT", "wins_lt", 4, sel(team="TOT", until=XMAS), f"Spurs (now {table['TOT']['w']} wins) have fewer than 4 league wins by Christmas.")),
    (r"Man Utd win fewer than 2 Premier League matches in October", lambda: (lambda ix: res(
        (sum((gf("MUN", i) > ga("MUN", i) for i in ix), np.zeros(N, np.int32)) < 2).mean(), fx_conf(ix), "match_model",
        f"Man Utd win 0 or 1 of their {len(ix)} October league matches.",
        [dict(label="October fixtures", value=", ".join(f'{FX[i]["h"]}-{FX[i]["a"]}' for i in ix), source_url=FPL_FIX)]))(
        sel(team="MUN", month="2026-10"))),
    (r"both Ipswich Town and Coventry City be relegated", m_ipswich_coventry),
    (r"Fulham to sack or replace", lambda: U("manager")),
    (r"Luke Shaw injury", lambda: U("offtopic")),
    (r"Will Arsenal win the 2026/27 Premier League", lambda: direct("EPL: 2027 Champion", "Arsenal")),
]

# ---------------------------------------------------------------- board
xo = [r for r in load("xo_convictions.json")
      if any(c.get("id") == 27 for c in (r.get("market") or {}).get("categoryPath") or [])
      and (r.get("market") or {}).get("status") == "ACTIVE"]
board, verify_rows, player_links = [], [], {}
gw_idx = [i for i, z in enumerate(FX) if z["gw"] == GW]
ALIASES = {s: {fold(TNAME[s]), s.lower()} for s in SHORT}
for s_, extra in {"MUN": ["man utd", "man united", "manchester united", "united"], "MCI": ["man city", "manchester city", "city"],
                  "TOT": ["tottenham", "spurs"], "NFO": ["forest"], "BHA": ["brighton"], "NEW": ["newcastle"],
                  "CRY": ["palace"], "AVL": ["villa"], "LIV": ["liverpool"], "LEE": ["leeds"], "COV": ["coventry"],
                  "IPS": ["ipswich"], "HUL": ["hull"], "SUN": ["sunderland"], "BOU": ["bournemouth"], "CHE": ["chelsea"],
                  "ARS": ["arsenal"], "EVE": ["everton"], "FUL": ["fulham"], "BRE": ["brentford"]}.items():
    ALIASES[s_] |= set(extra)
ALIASES = {k: {a for a in v if len(a) > 3} for k, v in ALIASES.items()}
for r in xo:
    mk = r["market"]
    outs = mk.get("outcomes") or []
    yes = next((o for o in outs if str(o.get("title", "")).lower() == "yes"), outs[0] if outs else {})
    no = next((o for o in outs if str(o.get("title", "")).lower() == "no"), outs[1] if len(outs) > 1 else {})
    raw_books = r.get("books") or []
    yes_book = next((b for b in raw_books if str(b.get("assetId")) == str(yes.get("outcomeTokenId"))), {})
    no_book = next((b for b in raw_books if str(b.get("assetId")) == str(no.get("outcomeTokenId"))), {})
    book = yes_book
    bids = [num(b["price"]) for b in book.get("bids") or [] if num(b.get("price"))]
    asks = [num(a["price"]) for a in book.get("asks") or [] if num(a.get("price"))]
    bb, ba = (max(bids) if bids else None), (min(asks) if asks else None)
    cp = num(yes.get("currentPrice"))
    cp = cp / 1e6 if cp is not None and cp > 1 else cp
    ltp = num(book.get("lastTradePrice"))
    xo_p = cp if cp is not None else ltp  # XO's own displayed price; never a wide bid/ask midpoint
    spec = next((fn for pat, fn in SPECS if re.search(pat, r["title"], re.I)), None)
    try:
        out = spec() if spec else unp("Fair price coming: not modelled yet.")
    except Exception as e:  # never let one market break the board
        out = unp(f"Model error: {type(e).__name__}")
    fair = None
    fx = None
    if out.get("p") is not None:
        p = min(max(out["p"], 0.001), 0.999)
        b = BAND[out["conf"]]
        fair = dict(p=round(p, 4), low=round(max(p - b, 0), 4), high=round(min(p + b, 1), 4), confidence=out["conf"],
                    method=out["method"], method_text=out["text"], inputs=out["inputs"])
        if out.get("fx") is not None and FX[out["fx"]]["gw"] == GW:
            z = FX[out["fx"]]
            fx = dict(home=z["h"], away=z["a"], home_name=TNAME[z["h"]], away_name=TNAME[z["a"]],
                      kickoff_utc=z["ko"].isoformat().replace("+00:00", "Z"))
        for k in ("pid", "pid2"):
            if out.get(k):
                player_links.setdefault(out[k], []).append(r["slug"])
    if fx is None:  # unpriced or multi-match markets: attach the GW fixture when the title names both clubs
        hits = [i for i in gw_idx if all(any(al in fold(r["title"]) for al in ALIASES[t]) for t in (FX[i]["h"], FX[i]["a"]))]
        if len(hits) == 1:
            z = FX[hits[0]]
            fx = dict(home=z["h"], away=z["a"], home_name=TNAME[z["h"]], away_name=TNAME[z["a"]],
                      kickoff_utc=z["ko"].isoformat().replace("+00:00", "Z"))
    horizon = "weekend" if ts(mk["expiresAt"]) <= max(FX[i]["ko"] for i in gw_idx) + dt.timedelta(days=1) else "long"
    row = dict(slug=r["slug"], title=r["title"], url=f'https://beta.xo.market/event/{r["slug"]}?r={REF}',
               creator=mk["creator"]["username"], is_ours=mk["creator"]["username"].lower() == REF,
               xo_price=None if xo_p is None else round(xo_p, 4), best_bid=bb, best_ask=ba,
               liquidity_usd=round(num(book.get("totalLiquidity")) or 0, 2),
               volume_usd=round(num(mk.get("totalVolumeInUSD")) or 0, 2), expires_at=mk["expiresAt"],
               group="fixture" if fx else "season", fixture=fx, fair=fair,
               fair_reason=None if fair else out.get("reason"),
               gap_pts=round((fair["p"] - xo_p) * 100) if fair and xo_p is not None else None, status=mk["status"],
               horizon=horizon, taker_fee_bps=int((mk.get("effectiveFeeConfig") or {}).get("takerFeeBps") or 0),
               description=resolution_description(r),
               resolution_sources=mk.get("resolutionSources") or [],
               books=dict(yes=clean_book(yes_book), no=clean_book(no_book)))
    board.append(row)

best_value = []
for b in board:
    if not b["fair"] or b["fair"]["confidence"] not in ("high", "medium"):
        continue
    fee_base = b["taker_fee_bps"] / 10000
    choices = [stake_result(10, side, b["books"][side]["asks"], fee_base, b["fair"]) for side in ("yes", "no")]
    pick = max(choices, key=lambda x: x["ev"])
    if pick["ev"] > 0:
        best_value.append(dict(slug=b["slug"], title=b["title"], fair=b["fair"]["p"], **{
            k: (round(v, 4) if isinstance(v, float) else v) for k, v in pick.items()}))
best_value.sort(key=lambda x: x["ev"], reverse=True)

GEN = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
tracked_path, receipts_path = OUT / "tracked.json", OUT / "receipts.json"
tracked = json.loads(tracked_path.read_text()) if tracked_path.exists() else {}
receipts = json.loads(receipts_path.read_text()) if receipts_path.exists() else []
ids = {r["slug"]: r["market"]["id"] for r in xo}
for b in board:
    tracked[b["slug"]] = dict(id=ids[b["slug"]], title=b["title"], url=b["url"], creator=b["creator"], is_ours=b["is_ours"],
                              expires_at=b["expires_at"], xo=b["xo_price"],
                              fair=b["fair"]["p"] if b["fair"] else tracked.get(b["slug"], {}).get("fair"),
                              confidence=b["fair"]["confidence"] if b["fair"] else None)
done_slugs = {r["slug"] for r in receipts}
for slug, t in tracked.items():
    f = RAW / "closed" / f'{t["id"]}.json'
    if slug in done_slugs or not f.exists():
        continue
    d = json.loads(f.read_text())
    win = (d.get("winningOutcome") or {}).get("title")
    if not win:
        continue
    yes = win.strip().lower() == "yes"
    receipts.append(dict(slug=slug, title=t["title"], url=t["url"], creator=t["creator"], is_ours=t["is_ours"],
                         outcome="YES" if yes else "NO", xo_close=t["xo"], fair_close=t["fair"], confidence=t["confidence"],
                         resolved_at=d.get("resolvedAt")))
receipts.sort(key=lambda r: r.get("resolved_at") or "", reverse=True)
tracked_path.write_text(json.dumps(tracked))
receipts_path.write_text(json.dumps(receipts, indent=1))
scored = [r for r in receipts if r["xo_close"] is not None and r["fair_close"] is not None]
o = lambda r: 1.0 if r["outcome"] == "YES" else 0.0
RECEIPT_SUMMARY = dict(resolved=len(receipts), compared=len(scored),
                       fair_closer=sum(abs(r["fair_close"] - o(r)) < abs(r["xo_close"] - o(r)) for r in scored),
                       brier_fair=round(float(np.mean([(r["fair_close"] - o(r)) ** 2 for r in scored])), 4) if scored else None,
                       brier_xo=round(float(np.mean([(r["xo_close"] - o(r)) ** 2 for r in scored])), 4) if scored else None)
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "board.json").write_text(json.dumps(dict(
    generated_at=GEN, name="PL Fair Price",
    tagline="What every Premier League market on XO should cost, priced from the markets with real money.",
    gw=dict(id=GW, deadline_utc=NEXT["deadline_time"]), markets=board, receipts=receipts,
    receipt_summary=RECEIPT_SUMMARY, best_value=best_value[:5],
    live=[f'{z["h"]}-{z["a"]}' for z in FX if z["live"]]), indent=1))

# ---------------------------------------------------------------- projections
gw_fx = [i for i, z in enumerate(FX) if z["gw"] == GW]
proj_fx = []
for i in gw_fx:
    z = FX[i]
    g = grid(z["lh"], z["la"])
    ph, pd, pa = hda(g)
    proj_fx.append(dict(home=z["h"], away=z["a"], home_name=TNAME[z["h"]], away_name=TNAME[z["a"]],
                        kickoff_utc=z["ko"].isoformat().replace("+00:00", "Z"), p_home=round(ph, 4),
                        p_draw=round(pd, 4), p_away=round(pa, 4), lam_home=round(z["lh"], 3), lam_away=round(z["la"], 3),
                        cs_home=round(g[:, 0].sum(), 4), cs_away=round(g[0, :].sum(), 4),
                        poly_volume=round(z["vol"]), source_url=z["url"]))
players = []
for pid, p in EL.items():
    t = TEAMS[p["team"]]
    ix = [i for i in gw_fx if t in (FX[i]["h"], FX[i]["a"])]
    if not ix or p["status"] == "u":
        continue
    m, z = player(pid), FX[ix[0]]
    lam_t, lam_o = (z["lh"], z["la"]) if z["h"] == t else (z["la"], z["lh"])
    pp, lg, la_ = m["p_next"], lam_t * m["qg"], lam_t * m["qa"]
    _g = grid(z["lh"], z["la"])
    pcs = float(_g[:, 0].sum() if z["h"] == t else _g[0, :].sum())
    p_goal, p_ast = pp * (1 - math.exp(-lg)), pp * (1 - math.exp(-la_))
    cs_def = pcs if m["pos"] in (1, 2) else 0.0
    bonus = max(0.0, BONUS["const"] + BONUS["goal"] * lg + BONUS["assist"] * la_ + BONUS["cs_def"] * cs_def + BONUS["defcon"] * m["p_dc"])
    xpts = pp * (2 + lg * GOAL_PTS[m["pos"]] + la_ * 3 + pcs * CS_PTS[m["pos"]] + 2 * m["p_dc"] + bonus)
    blank = (1 - pp) + pp * math.exp(-lg - la_) * ((1 - pcs) if CS_PTS[m["pos"]] >= 4 else 1) * (1 - m["p_dc"])
    own = num(p["selected_by_percent"]) or 0
    if p_goal > 0.03 or own > 5 or m["pos"] in (1, 2) and pp > 0.5 and own > 1:
        opponent = z["a"] if z["h"] == t else z["h"]
        players.append(dict(id=pid, name=m["name"], team=t, opponent=opponent, pos=POS[m["pos"]], price=p["now_cost"] / 10,
                            owned_pct=own, chance_playing=p["chance_of_playing_next_round"], news=p["news"],
                            p_start=round(pp, 3), p_goal=round(p_goal, 4), p_assist=round(p_ast, 4),
                            p_cs=round(pcs, 4), p_defcon=round(m["p_dc"], 3), xbonus=round(pp * bonus, 2),
                            xpts=round(xpts, 2), p_blank=round(blank, 4), fpl_ep=num(p.get("ep_next")),
                            xo_markets=player_links.get(pid, [])))
players.sort(key=lambda x: -x["xpts"])
captain = [dict(id=x["id"], name=x["name"], team=x["team"], xpts=x["xpts"], p_goal=x["p_goal"],
                p_assist=x["p_assist"], p_blank=x["p_blank"], p_defcon=x["p_defcon"], xbonus=x["xbonus"],
                fpl_ep=x["fpl_ep"]) for x in players[:10]]
set_pieces = []
for team_id, team in TEAMS.items():
    row = dict(team=team, penalties=[], direct_freekicks=[], corners=[])
    for p in boot["elements"]:
        if p["team"] != team_id:
            continue
        if p.get("penalties_order") == 1:
            row["penalties"].append(p["web_name"])
        if p.get("direct_freekicks_order") == 1:
            row["direct_freekicks"].append(p["web_name"])
        if p.get("corners_and_indirect_freekicks_order") == 1:
            row["corners"].append(p["web_name"])
    set_pieces.append(row)
flags = []  # every flagged player owned by 1%+: FPL's published chance and news
for pid, p in EL.items():
    c = p["chance_of_playing_next_round"]
    if c is None or c == 100 or (num(p["selected_by_percent"]) or 0) < 1:
        continue
    m = player(pid)
    flags.append(dict(id=pid, name=m["name"], team=m["team"], pos=POS[m["pos"]], owned_pct=num(p["selected_by_percent"]),
                      fpl_chance=c, news=p["news"], regular=m["regular"],
                      xo_markets=[b["slug"] for b in board if fold(p["web_name"]) in fold(b["title"])
                                  or fold(f'{p["first_name"]} {p["second_name"]}') in fold(b["title"])]))
flags.sort(key=lambda x: -x["owned_pct"])
xg_table = sorted((dict(id=p["id"], name=p["web_name"], team=TEAMS[p["team"]], pos=POS[p["element_type"]], minutes=p["minutes"],
                        goals=p["goals_scored"], xg=round(num(p["expected_goals"]) or 0, 2), assists=p["assists"],
                        xa=round(num(p["expected_assists"]) or 0, 2), owned_pct=num(p["selected_by_percent"]))
                   for p in EL.values() if p["minutes"] >= 180), key=lambda x: -(x["xg"] + x["xa"]))[:40]
(OUT / "projections.json").write_text(json.dumps(dict(generated_at=GEN, gw=GW, deadline_utc=NEXT["deadline_time"],
                                                      fixtures=proj_fx, players=players, captain=captain, flags=flags,
                                                      set_pieces=set_pieces,
                                                      xg_table=xg_table, league_avg_goals=round(LEAGUE_AVG, 2)), indent=1))
# Detailed order-book history for charts added from Friday onward; preserve prior runs and cap per slug.
history_path = OUT / "history.json"
history = json.loads(history_path.read_text()) if history_path.exists() else {}
for b in board:
    yes = b["books"]["yes"]
    bids = [x["price"] for x in yes["bids"]]
    asks = [x["price"] for x in yes["asks"]]
    history.setdefault(b["slug"], []).append([GEN, b["xo_price"], max(bids) if bids else None,
                                               min(asks) if asks else None, b["fair"]["p"] if b["fair"] else None])
    history[b["slug"]] = history[b["slug"]][-600:]
history_path.write_text(json.dumps(history, indent=1))

# Legacy compact history continues to feed receipts.
hist_path = OUT / "history.jsonl"
hist = [json.loads(l) for l in hist_path.read_text().splitlines() if l.strip()] if hist_path.exists() else []
hist += [dict(ts=GEN, slug=b["slug"], xo_price=b["xo_price"], fair=b["fair"]["p"] if b["fair"] else None) for b in board]
kept, lastk = [], {}
for h in hist:
    prev = lastk.get(h["slug"])
    if (prev is None or (prev["xo_price"], prev["fair"] and round(prev["fair"], 3)) != (h["xo_price"], h["fair"] and round(h["fair"], 3))
            or ts(h["ts"]) - ts(prev["ts"]) >= dt.timedelta(hours=3)):
        kept.append(h); lastk[h["slug"]] = h
hist_path.write_text("".join(json.dumps(h) + "\n" for h in kept))

# ---------------------------------------------------------------- checks + VERIFY.md
for b in board:
    if b["fair"]:
        assert 0 <= b["fair"]["p"] <= 1 and not math.isnan(b["fair"]["p"]), b["slug"]
for z in FX:
    assert 0.2 <= z["lh"] <= 4 and 0.2 <= z["la"] <= 4, z
fit_err = max(abs(a - b) for o in odds.values() for a, b in zip(o["p"], o["fit"])) * 100

L = [f"# VERIFY — PL Fair Price ({GEN})", "",
     f"GW{GW} deadline {NEXT['deadline_time']}. {len(board)} XO PL markets; "
     f"{sum(1 for b in board if b['fair'])} priced "
     f"(high {sum(1 for b in board if b['fair'] and b['fair']['confidence'] == 'high')}, "
     f"medium {sum(1 for b in board if b['fair'] and b['fair']['confidence'] == 'medium')}, "
     f"low {sum(1 for b in board if b['fair'] and b['fair']['confidence'] == 'low')}).", "",
     f"## 1X2 fit (Polymarket de-vigged vs Poisson model), max error {fit_err:.1f} pts", "",
     "| Fixture | GW | Poly raw H/D/A | Market H/D/A | Model H/D/A | λ | Volume |", "|---|---|---|---|---|---|---|"]
for (h, a), o in sorted(odds.items(), key=lambda kv: next((z["ko"] for z in FX if (z["h"], z["a"]) == kv[0]), DEADLINE)):
    gwn = next((z["gw"] for z in FX if (z["h"], z["a"]) == (h, a)), "-")
    L.append(f"| {h}-{a} | {gwn} | {'/'.join(f'{x*100:.1f}' for x in o['raw'])} | {'/'.join(f'{x*100:.1f}' for x in o['p'])} | "
             f"{'/'.join(f'{x*100:.1f}' for x in o['fit'])} | {o['lam'][0]:.2f}-{o['lam'][1]:.2f} | ${o['vol']:,.0f} |")
L += ["", f"League average {LEAGUE_AVG:.2f} goals per game from {len(done)} finished matches; Dixon-Coles rho {RHO}; "
      f"mean fitted total {np.mean([sum(o['lam']) for o in odds.values()]):.2f}."]
L += ["", f"Team-ratings refit error on the priced matches: mean |Δlog λ| {np.mean(rating_err):.3f}, max {max(rating_err):.3f}.",
      "", "## Current table (from finished FPL fixtures)", "", "| Team | P | W | Pts | GF | GA |", "|---|---|---|---|---|---|"]
for s in sorted(SHORT, key=lambda s: (-table[s]["pts"], -(table[s]["gf"] - table[s]["ga"]), -table[s]["gf"])):
    t = table[s]
    L.append(f"| {s} | {t['p']} | {t['w']} | {t['pts']} | {t['gf']} | {t['ga']} |")
L += ["", "## Table sim after MW9", "", "| Team | P(1st) | P(bottom 3) | mean pts |", "|---|---|---|---|"]
for s in ("MCI", "ARS", "LIV", "TOT", "COV", "IPS"):
    c = idx[s]
    L.append(f"| {s} | {(TAB9[:, c] == 1).mean():.1%} | {(TAB9[:, c] >= 18).mean():.1%} | {PTS9[:, c].mean():.1f} |")
h = player(411)
L += ["", "## Captain inputs (Haaland)", "",
      f"qg {h['qg']:.3f}, qa {h['qa']:.3f}, plays {h['p_next']:.2f}; xG {h['xg']}, xA {h['xa']}, {h['mins']} min, {h['starts']}/{h['team_games']} starts.",
      "", "## Markets", "", "| Conf | XO | Fair | Gap | Method | Title | Note |", "|---|---|---|---|---|---|---|"]
for b in sorted(board, key=lambda b: (b["fair"] is None, b["title"])):
    f_ = b["fair"]
    L.append(f"| {f_['confidence'] if f_ else '-'} | {'' if b['xo_price'] is None else f'{b['xo_price']*100:.0f}'} | "
             f"{f'{f_['p']*100:.1f}' if f_ else '-'} | {'' if b['gap_pts'] is None else b['gap_pts']} | "
             f"{f_['method'] if f_ else '-'} | {b['title']} | {(f_['method_text'] if f_ else b['fair_reason'])[:140]} |")
(TOOL / "VERIFY.md").write_text("\n".join(L) + "\n")
print(f"ok: {len(board)} markets, {sum(1 for b in board if b['fair'])} priced, fit error {fit_err:.1f} pts, "
      f"{len(players)} players, GW{GW}")
