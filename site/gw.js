/* PL Fair Price, gameweek page. Needs common.js. Charts are plain HTML/CSS and one inline SVG, no libraries.
   Encoding: one accent (pink) against grey/ink. Text stays in ink tokens; the colored mark beside it carries identity. */

const COL = { pink: '#ff87a6', ink: '#0a0a0a', grey: '#8a8a93', hair: '#ececf0', furniture: '#b9b9c2' };
const SVGNS = 'http://www.w3.org/2000/svg';

/* ---------- tooltip: enhances, never gates (every value is also in a table view) ---------- */

const tipEl = () => document.getElementById('tip');

function showTip(target, lines, at) {
  const t = tipEl();
  t.replaceChildren(...lines.map((l, i) => h('div', { class: i === 0 ? 'tip-v' : 'tip-l', text: l })));
  t.hidden = false;
  const r = at || target.getBoundingClientRect();
  const w = t.offsetWidth, hgt = t.offsetHeight;
  let x = r.left + (r.width || 0) / 2 - w / 2;
  x = Math.max(8, Math.min(x, document.documentElement.clientWidth - w - 8));
  let y = r.top - hgt - 8;
  if (y < 8) y = r.bottom + 8;
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
const hideTip = () => { tipEl().hidden = true; };

function attachTip(el, lines) {
  el.tabIndex = 0;
  el.addEventListener('pointerenter', () => showTip(el, lines));
  el.addEventListener('focus', () => showTip(el, lines));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('blur', hideTip);
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') showTip(el, lines); });
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest || !e.target.closest('[tabindex="0"], .sc')) hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });

/* ---------- small shared pieces ---------- */

function key(cls, text) {
  return h('span', { class: 'lg' }, h('i', { class: 'lgd ' + cls }), text);
}

function tableView(cols, rows) {
  const t = h('table', { class: 'tv' },
    h('thead', null, h('tr', null, cols.map((c, i) => h('th', { class: i ? 'n' : '', text: c })))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'n' : '', text: String(c) }))))));
  return h('details', { class: 'tview' }, h('summary', { text: 'Table view' }), t);
}

const kickoffFmt = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
};
const pct0 = (p) => Math.round(p * 100) + '%';

/* ---------- (b) doubts: FPL's injury flags and news, nothing else ---------- */

function doubtRow(f) {
  const chance = Math.round(Number(f.fpl_chance));
  const tier = chance >= 75 ? 'c75' : chance >= 50 ? 'c50' : chance >= 25 ? 'c25' : 'c0';
  const own = num(f.owned_pct) !== null ? `${Number(f.owned_pct).toFixed(f.owned_pct >= 10 ? 0 : 1)}% owned` : null;
  return h('li', { class: 'db' },
    h('div', { class: 'db-top' },
      h('span', { class: 'db-id' }, crest(f.team, 20), h('span', { class: 'db-name', text: f.name }), h('span', { class: 'db-pos', text: f.pos })),
      h('span', { class: 'fpl-pill ' + tier, text: `FPL ${chance}%`, title: `FPL's chance of playing: ${chance}%` })),
    f.news ? h('p', { class: 'db-news', text: f.news }) : null,
    h('div', { class: 'db-foot' }, own ? h('span', { class: 'db-own', text: own }) : null, xoChips(f)));
}

function renderDoubts(proj) {
  const body = document.getElementById('fl-body');
  const flags = ((proj && proj.flags) || []).filter((f) => num(f.fpl_chance) !== null)
    .sort((a, b) => (num(b.owned_pct) || 0) - (num(a.owned_pct) || 0));
  if (!flags.length) { body.replaceChildren(h('p', { class: 'empty', text: 'No injury doubts flagged by FPL for this gameweek.' })); return; }
  const top = flags.slice(0, 12), rest = flags.slice(12);
  const kids = [h('p', { class: 'db-legend' }, 'The pill is FPL\'s chance of playing. ', h('span', { class: 'fpl-pill c75', text: '75%' }), h('span', { class: 'fpl-pill c50', text: '50%' }), h('span', { class: 'fpl-pill c25', text: '25%' }), h('span', { class: 'fpl-pill c0', text: '0%' }), ' Greyer is safer, pinker is riskier. Sorted by ownership.'),
    h('ul', { class: 'db-list' }, top.map(doubtRow))];
  if (rest.length) kids.push(h('details', { class: 'more' }, h('summary', { text: `${rest.length} more doubt${rest.length === 1 ? '' : 's'}` }), h('ul', { class: 'db-list' }, rest.map(doubtRow))));
  body.replaceChildren(...kids);
}

/* ---------- (c) captain picks ---------- */

function xoChips(p) {
  const chips = (Array.isArray(p.xo_markets) ? p.xo_markets : []).map((s) => state.bySlug[s]).filter(Boolean).map((m) => {
    const t = m.title.toLowerCase();
    const kind = /\bstart\b/.test(t) ? 'Starts' : /\bvs\b/.test(t) && /(more|most|outscore)/.test(t) ? 'Head to head' : /assist/.test(t) ? 'Assist' : /clean sheet/.test(t) ? 'Clean sheet' : /(score|goal)/.test(t) ? 'Goal' : /captain/.test(t) ? 'Captain' : 'Market';
    return h('a', { class: 'xchip', href: tradeUrl(m), target: '_blank', rel: 'noopener', title: m.title },
      `${kind} · XO ${m.xo_price !== null ? pct(m.xo_price) : 'no trades'}`);
  });
  return chips.length ? h('div', { class: 'xchips' }, chips) : null;
}

function renderCaptain(proj) {
  const body = document.getElementById('cp-body');
  const rows = ((proj && proj.captain) || []).map((c) => ({ c, p: state.players[c.id] || {} }))
    .sort((a, b) => Number(b.c.xpts) - Number(a.c.xpts)).slice(0, 10);
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: 'Captain picks appear once the model has run for this gameweek.' })); return; }
  const max = Math.max(...rows.map((r) => Number(r.c.xpts))) || 1;
  const list = h('ol', { class: 'plist' }, rows.map(({ c, p }, i) => {
    const sub = [c.team, p.pos, p.price ? '£' + Number(p.price).toFixed(1) + 'm' : null, num(p.owned_pct) !== null ? Math.round(p.owned_pct) + '% owned' : null].filter(Boolean).join(' · ');
    const news = num(p.chance_playing) !== null && p.chance_playing < 1 ? h('p', { class: 'pnews', text: `${Math.round(p.chance_playing * 100)}% chance of playing${p.news ? ': ' + p.news : ''}` }) : null;
    const li = h('li', { class: 'pcard' },
      h('span', { class: 'prank', text: String(i + 1) }),
      h('div', { class: 'pmain' },
        h('div', { class: 'pname' }, crest(c.team, 20), h('span', { text: c.name })),
        h('p', { class: 'psub', text: sub }),
        h('div', { class: 'xbar', role: 'img', 'aria-label': `${Number(c.xpts).toFixed(1)} expected points` }, h('i', { style: `width:${(Number(c.xpts) / max) * 100}%` })),
        h('div', { class: 'stats' },
          num(c.p_goal) !== null ? h('span', { class: 'stat' }, h('b', { text: pct0(c.p_goal) }), ' goal') : null,
          num(c.p_assist) !== null ? h('span', { class: 'stat' }, h('b', { text: pct0(c.p_assist) }), ' assist') : null,
          num(c.p_blank) !== null ? h('span', { class: 'stat' }, h('b', { text: pct0(c.p_blank) }), ' blank') : null),
        news, xoChips(p)),
      h('div', { class: 'pbig' }, h('b', { text: Number(c.xpts).toFixed(1) }), h('i', { text: 'xPts' })));
    return li;
  }));
  body.replaceChildren(list, tableView(['Player', 'xPts', 'Goal', 'Assist', 'Blank'], rows.map(({ c }) => [`${c.name} (${c.team})`, Number(c.xpts).toFixed(1), pct0(c.p_goal), pct0(c.p_assist), pct0(c.p_blank)])));
}

/* ---------- (c2) projection consensus: our xPts next to free public models ---------- */

const CONS_COLS = [['ours', 'Ours'], ['solio', 'Solio'], ['pundit', 'Pundit'], ['fpl', 'FPL']];
const pts1 = (v) => (num(v) === null ? '–' : Number(v).toFixed(1));

// Keys of the highest of the three models in the average (FPL is not one of them). No highlight when they all agree.
function topModels(p) {
  const v = ['ours', 'solio', 'pundit'].filter((k) => num(p[k]) !== null).map((k) => [k, pts1(p[k])]);
  const mx = Math.max(...v.map((x) => Number(x[1])));
  return v.length > 1 && v.some((x) => Number(x[1]) < mx) ? new Set(v.filter((x) => Number(x[1]) === mx).map((x) => x[0])) : new Set();
}

function renderConsensus(cons, gwId) {
  const body = document.getElementById('co-body');
  const rows = cons && cons.gw === gwId && Array.isArray(cons.players) ? cons.players.filter((p) => num(p.avg) !== null).sort((a, b) => b.avg - a.avg) : [];
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: 'The consensus appears once the free sources have published numbers for this gameweek.' })); return; }
  const hiTitle = 'Highest of the three models';

  const cards = h('ol', { class: 'cons-cards' }, rows.map((p, i) => {
    const hi = topModels(p);
    return h('li', { class: 'ccard' },
      h('div', { class: 'ctop' },
        h('span', { class: 'prank', text: String(i + 1) }),
        h('div', { class: 'pmain' }, h('div', { class: 'pname' }, crest(p.team, 20), h('span', { text: p.name })), h('p', { class: 'psub', text: `${p.team} · ${p.pos}` })),
        h('div', { class: 'pbig' }, h('b', { text: pts1(p.avg) }), h('i', { text: 'Average' }))),
      h('div', { class: 'cvals' }, CONS_COLS.map(([k, label]) =>
        h('div', { class: 'cv' + (hi.has(k) ? ' hi' : '') + (k === 'fpl' ? ' off' : ''), title: hi.has(k) ? hiTitle : null }, h('i', { text: label }), h('b', { text: pts1(p[k]) })))));
  }));

  const table = h('table', { class: 'ctable', 'aria-label': 'Expected points by source' },
    h('thead', null, h('tr', null, h('th', { class: 'cp', text: 'Player' }), CONS_COLS.map(([k, label]) => h('th', { class: 'n' + (k === 'fpl' ? ' off' : ''), text: label })), h('th', { class: 'n', text: 'Average' }))),
    h('tbody', null, rows.map((p, i) => {
      const hi = topModels(p);
      return h('tr', null,
        h('td', { class: 'cp' }, h('span', { class: 'cpid' }, h('span', { class: 'prank', text: String(i + 1) }), crest(p.team, 20), h('span', { class: 'cpn' }, h('b', { text: p.name }), h('i', { text: `${p.team} · ${p.pos}` })))),
        CONS_COLS.map(([k]) => h('td', { class: 'n' + (k === 'fpl' ? ' off' : '') }, h('span', { class: 'v' + (hi.has(k) ? ' hi' : ''), title: hi.has(k) ? hiTitle : null, text: pts1(p[k]) }))),
        h('td', { class: 'n avg' }, h('span', { class: 'v', text: pts1(p.avg) })));
    })));

  body.replaceChildren(cards, table,
    h('p', { class: 'note', text: `Top ${rows.length} by average. The average is the mean of Ours, Solio and Pundit. FPL is shown but left out of it: its number is form-based and erratic. The shaded number is the highest of those three. A dash means that source does not publish the player.` }));
}

/* ---------- (d) clean-sheet chances, all teams ---------- */

function renderCS(proj) {
  const body = document.getElementById('cs-body');
  const rows = [];
  ((proj && proj.fixtures) || []).forEach((f) => {
    if (num(f.cs_home) !== null) rows.push({ team: f.home, name: f.home_name || teamName(f.home), opp: f.away_name || teamName(f.away), home: true, p: Number(f.cs_home) });
    if (num(f.cs_away) !== null) rows.push({ team: f.away, name: f.away_name || teamName(f.away), opp: f.home_name || teamName(f.home), home: false, p: Number(f.cs_away) });
  });
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: 'Clean-sheet chances appear once the match model has run.' })); return; }
  rows.sort((a, b) => b.p - a.p);
  const top = Math.min(1, Math.ceil(rows[0].p * 10) / 10);
  const list = h('ul', { class: 'cs-list' }, rows.map((r) => {
    const li = h('li', { class: 'csr' },
      crest(r.team, 20) || h('span', { class: 'crest-ph' }),
      h('div', { class: 'cs-t' }, h('b', { text: r.name }), h('span', { text: `${r.home ? 'v' : 'at'} ${r.opp}` })),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${r.name} clean sheet ${pct0(r.p)}` }, h('i', { style: `width:${(r.p / top) * 100}%` })),
      h('b', { class: 'cs-v', text: pct0(r.p) }));
    attachTip(li, [`${pct0(r.p)} clean sheet`, `${r.name} ${r.home ? 'v' : 'at'} ${r.opp}`]);
    return li;
  }));
  body.replaceChildren(list, h('p', { class: 'note', text: `Bars run from 0% to ${Math.round(top * 100)}%.` }),
    tableView(['Team', 'Opponent', 'Clean sheet'], rows.map((r) => [r.name, `${r.home ? 'v' : 'at'} ${r.opp}`, pct0(r.p)])));
}

/* ---------- (e) goals expected per match ---------- */

function renderGoals(proj) {
  const body = document.getElementById('gl-body');
  const fx = [...((proj && proj.fixtures) || [])].filter((f) => num(f.lam_home) !== null && num(f.lam_away) !== null)
    .sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc));
  if (!fx.length) { body.replaceChildren(h('p', { class: 'empty', text: 'Match numbers appear once the match model has run.' })); return; }
  const max = Math.ceil(Math.max(...fx.flatMap((f) => [f.lam_home, f.lam_away])) * 2) / 2;
  const legend = h('div', { class: 'legend2' }, key('home', 'Home'), key('draw', 'Draw'), key('away', 'Away'));
  const list = h('ul', { class: 'gm-list' }, fx.map((f) => {
    const hn = f.home_name || teamName(f.home), an = f.away_name || teamName(f.away);
    const vol = num(f.poly_volume), eg = elevenGoals(f.home, f.away);
    const volText = vol === null ? 'Polymarket volume not available' : `${vol < 2000 ? 'Thin market: ' : ''}$${Math.round(vol).toLocaleString('en-US')} traded on Polymarket`;
    const li = h('li', { class: 'gm' },
      h('div', { class: 'gm-head' }, h('span', { class: 'gm-teams' }, crest(f.home, 20), h('b', { text: `${hn} v ${an}` }), crest(f.away, 20)), h('span', { class: 'gm-ko', text: f.kickoff_utc ? kickoffFmt(f.kickoff_utc) : '' })),
      h('div', { class: 'gm-bars' },
        h('b', { class: 'gm-n', text: Number(f.lam_home).toFixed(1) }),
        h('div', { class: 'gm-axis', role: 'img', 'aria-label': `Expected goals ${Number(f.lam_home).toFixed(1)} to ${Number(f.lam_away).toFixed(1)}` },
          h('div', { class: 'gm-half l' }, h('i', { style: `width:${(f.lam_home / max) * 100}%` })),
          h('div', { class: 'gm-half r' }, h('i', { style: `width:${(f.lam_away / max) * 100}%` }))),
        h('b', { class: 'gm-n', text: Number(f.lam_away).toFixed(1) })),
      h('div', { class: 'gm-1x2', role: 'img', 'aria-label': `${hn} ${pct0(f.p_home)}, draw ${pct0(f.p_draw)}, ${an} ${pct0(f.p_away)}` },
        h('i', { class: 'home', style: `flex:${f.p_home}` }), h('i', { class: 'draw', style: `flex:${f.p_draw}` }), h('i', { class: 'away', style: `flex:${f.p_away}` })),
      h('div', { class: 'gm-p' }, h('span', { text: `${hn} ${pct0(f.p_home)}` }), h('span', { text: `Draw ${pct0(f.p_draw)}` }), h('span', { text: `${an} ${pct0(f.p_away)}` })),
      eg ? h('p', { class: 'gm-note', text: elevenText(eg) }) : null,
      h('p', { class: 'gm-note' }, volText, safeUrl(f.source_url) ? h('a', { href: safeUrl(f.source_url), target: '_blank', rel: 'noopener', text: ' source' }) : null));
    attachTip(li, [`${Number(f.lam_home).toFixed(2)} to ${Number(f.lam_away).toFixed(2)} expected goals`, `${hn} ${pct0(f.p_home)} · Draw ${pct0(f.p_draw)} · ${an} ${pct0(f.p_away)}`]);
    return li;
  }));
  const credit = fx.some((f) => elevenGoals(f.home, f.away))
    ? h('p', { class: 'credits' }, 'Second opinion on goals: ', h('a', { href: 'https://www.elevenify.com', target: '_blank', rel: 'noopener', text: 'elevenify' }), '.') : null;
  body.replaceChildren(...[credit, legend, list, h('p', { class: 'note', text: `Goal bars run from 0 to ${max.toFixed(1)}.` }),
    tableView(['Match', 'xG H', 'xG A', 'H / D / A'], fx.map((f) => [`${f.home} v ${f.away}`, Number(f.lam_home).toFixed(2), Number(f.lam_away).toFixed(2), `${pct0(f.p_home)} / ${pct0(f.p_draw)} / ${pct0(f.p_away)}`]))].filter(Boolean));
}

/* ---------- (f) over- and under-performers: scatter with a parity line ---------- */

function sv(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderPerf(proj) {
  const body = document.getElementById('pf-body');
  const pts = ((proj && proj.xg_table) || []).map((p) => ({ ...p, x: Number(p.xg) + Number(p.xa), y: Number(p.goals) + Number(p.assists) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) { body.replaceChildren(h('p', { class: 'empty', text: 'Expected-involvement numbers are not available yet.' })); return; }

  const W = 360, M = { l: 36, r: 14, t: 10, b: 40 };
  const maxV = Math.max(...pts.map((p) => Math.max(p.x, p.y)));
  const top = Math.max(4, Math.ceil(maxV / 2) * 2);
  const pw = W - M.l - M.r, H = pw + M.t + M.b, s = pw / top;
  const X = (v) => M.l + v * s, Y = (v) => M.t + pw - v * s;

  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sc', role: 'img', 'aria-label': 'Scatter of expected against actual goal involvements' });
  for (let t = 0; t <= top; t += 2) {
    svg.append(sv('line', { x1: X(0), x2: X(top), y1: Y(t), y2: Y(t), stroke: COL.hair, 'stroke-width': 1 }));
    svg.append(sv('line', { x1: X(t), x2: X(t), y1: Y(0), y2: Y(top), stroke: COL.hair, 'stroke-width': 1 }));
    svg.append(sv('text', { x: M.l - 6, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'tk' }, String(t)));
    svg.append(sv('text', { x: X(t), y: Y(0) + 15, 'text-anchor': 'middle', class: 'tk' }, String(t)));
  }
  svg.append(sv('text', { x: M.l + pw / 2, y: H - 6, 'text-anchor': 'middle', class: 'ax' }, 'Expected: xG + xA'));
  const yl = sv('text', { transform: `translate(11 ${M.t + pw / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'ax' }, 'Actual: goals + assists');
  svg.append(yl);
  svg.append(sv('line', { x1: X(0), y1: Y(0), x2: X(top), y2: Y(top), stroke: COL.furniture, 'stroke-width': 1.5 }));

  const cls = (p) => (p.y - p.x >= 1 ? 'over' : p.y - p.x <= -1 ? 'under' : 'even');
  const fill = { over: COL.pink, under: COL.ink, even: '#b4b4bd' };
  const dots = [...pts].sort((a, b) => Math.abs(a.y - a.x) - Math.abs(b.y - b.x)); // biggest gaps drawn last, on top
  dots.forEach((p) => { p.el = sv('circle', { cx: X(p.x), cy: Y(p.y), r: 4.5, fill: fill[cls(p)], stroke: '#fff', 'stroke-width': 1.5 }); svg.append(p.el); });

  // Label the 6 furthest from the line; greedy placement so labels never sit on each other or on a dot.
  const far = [...pts].sort((a, b) => Math.abs(b.y - b.x) - Math.abs(a.y - a.x)).slice(0, 6);
  const boxes = [];
  const clash = (b) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)
    || pts.some((p) => { const cx = X(p.x), cy = Y(p.y); return cx > b.x - 4 && cx < b.x + b.w + 4 && cy > b.y - 4 && cy < b.y + b.h + 4; });
  far.forEach((p) => {
    const w = p.name.length * 6 + 4, hh = 13, cx = X(p.x), cy = Y(p.y);
    const opts = [[cx + 8, cy - hh / 2, 'start'], [cx - 8 - w, cy - hh / 2, 'start'], [cx - w / 2, cy - 9 - hh, 'start'], [cx - w / 2, cy + 9, 'start'], [cx + 8, cy - hh - 6, 'start'], [cx + 8, cy + 4, 'start']];
    let pick = null;
    for (const [bx, by] of opts) {
      const b = { x: bx, y: by, w, h: hh };
      if (b.x < 2 || b.x + w > W - 2 || b.y < 2 || b.y + hh > H - 20) continue;
      const others = pts.filter((q) => q !== p);
      const hitsDot = others.some((q) => { const qx = X(q.x), qy = Y(q.y); return qx > b.x - 4 && qx < b.x + w + 4 && qy > b.y - 4 && qy < b.y + hh + 4; });
      if (!hitsDot && !boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)) { pick = b; break; }
    }
    if (!pick) pick = { x: Math.min(cx + 8, W - w - 2), y: cy - hh / 2, w, h: hh };
    boxes.push(pick);
    svg.append(sv('text', { x: pick.x, y: pick.y + 10.5, class: 'pl' }, p.name));
  });

  // Nearest-point hover layer: the pointer only has to be close, never dead-center.
  const hit = sv('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  svg.append(hit);
  let hot = null;
  const move = (e) => {
    const m = svg.getScreenCTM().inverse();
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(m);
    let best = null, bd = 1e9;
    pts.forEach((p) => { const d = Math.hypot(X(p.x) - q.x, Y(p.y) - q.y); if (d < bd) { bd = d; best = p; } });
    if (hot && hot !== best) hot.el.setAttribute('r', 4.5);
    if (best && bd <= 30) {
      hot = best; best.el.setAttribute('r', 6.5);
      const r = best.el.getBoundingClientRect();
      showTip(best.el, [`${best.y} goals + assists from ${best.x.toFixed(1)} expected`, `${best.name}, ${teamName(best.team)}`, `${best.minutes} minutes`], r);
    } else { if (hot) hot.el.setAttribute('r', 4.5); hot = null; hideTip(); }
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { if (hot) hot.el.setAttribute('r', 4.5); hot = null; hideTip(); });

  const legend = h('div', { class: 'legend2' }, key('over', 'Scoring more than chances suggest'), key('under', 'Unlucky so far'), key('even', 'About as expected'));
  const sorted = [...pts].sort((a, b) => (b.y - b.x) - (a.y - a.x));
  body.replaceChildren(legend, h('div', { class: 'scwrap' }, svg),
    h('p', { class: 'note', text: 'Above the line = scoring more than chances suggest (may cool off). Below = unlucky so far.' }),
    h('p', { class: 'note', text: 'Source: FPL (Opta) data.' }),
    tableView(['Player', 'xG+xA', 'G+A', 'Gap'], sorted.map((p) => [`${p.name} (${p.team})`, p.x.toFixed(1), p.y, (p.y - p.x >= 0 ? '+' : '') + (p.y - p.x).toFixed(1)])));
}

/* ---------- init ---------- */

async function init() {
  setupPage();
  if (!(await loadData())) { document.getElementById('fl-body').replaceChildren(h('p', { class: 'empty', text: 'Could not load the numbers. Try again in a minute.' })); return; }
  document.getElementById('sample').hidden = !state.mock;
  setGwLabels();
  const proj = state.proj || {};
  const gwId = proj.gw || (state.board.gw || {}).id;
  document.title = `GW${gwId || ''} numbers for FPL managers | PL Fair Price`;
  startCountdown(document.getElementById('dl-label'), document.getElementById('dl-boxes'), document.getElementById('deadline'),
    proj.deadline_utc || (state.board.gw || {}).deadline_utc, gwId);
  if (num(proj.league_avg_goals) !== null) {
    document.getElementById('how-text').textContent = `Match odds come from Polymarket. Average goals are calibrated to the league's ${Number(proj.league_avg_goals).toFixed(2)} goals per game. Player shares come from FPL xG and xA. Rough model, no bonus or defensive points.`;
  }
  renderDoubts(proj);
  renderCaptain(proj);
  (state.mock ? Promise.resolve(null) : getJSON(`data/consensus.json?v=${Math.floor(Date.now() / 60000)}`).catch(() => null))
    .then((cons) => renderConsensus(cons, gwId));
  renderCS(proj);
  renderGoals(proj);
  renderPerf(proj);
}

init();
