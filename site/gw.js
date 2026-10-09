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

function tableView(cols, rows, opts = {}) {
  const t = h('table', { class: 'tv' },
    h('thead', null, h('tr', null, cols.map((c, i) => h('th', { class: [i ? 'n' : '', (opts.hide || []).includes(i) ? 'tv-low' : ''].filter(Boolean).join(' '), text: c })))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => {
      const cls = [i ? 'n' : '', (opts.hide || []).includes(i) ? 'tv-low' : '', opts.diff === i ? (Number(c) > 0 ? 'tv-pos' : 'tv-neg') : ''].filter(Boolean).join(' ');
      if (i === 0 && c && typeof c === 'object') return h('td', { class: cls }, h('span', { class: 'tv-player' }, h('b', { text: c.name }), h('i', { text: `${c.team} · ${c.pos}` })));
      return h('td', { class: cls, text: String(c) });
    })))));
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

function captainParts(c, p) {
  const pp = num(p.p_start), goalP = num(c.p_goal), assistP = num(c.p_assist);
  if (pp === null || pp <= 0 || goalP === null || assistP === null) return [];
  const lambda = (prob) => -Math.log(Math.max(0.000001, 1 - Math.min(prob / pp, 0.999999)));
  const goalPts = { FWD: 4, MID: 5, DEF: 6, GK: 6 }[p.pos] || 0;
  const csPts = { FWD: 0, MID: 1, DEF: 4, GK: 4 }[p.pos] || 0;
  return [
    { key: 'appearance', label: 'Appearance', value: pp * 2 },
    { key: 'goals', label: 'Goals', value: pp * lambda(goalP) * goalPts },
    { key: 'assists', label: 'Assists', value: pp * lambda(assistP) * 3 },
    { key: 'clean', label: 'Clean sheet', value: pp * (num(p.p_cs) || 0) * csPts },
    { key: 'defcon', label: 'DEFCON', value: pp * 2 * (num(c.p_defcon) || 0) },
    { key: 'bonus', label: 'Bonus', value: num(c.xbonus) || 0 },
  ];
}

function breakdownBar(c, p) {
  const parts = captainParts(c, p), total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!parts.length || total <= 0) return null;
  return h('div', { class: 'xbreak', role: 'img', 'aria-label': parts.map((part) => `${part.label} ${part.value.toFixed(1)} points`).join(', ') },
    parts.map((part) => h('i', { class: 'xb-' + part.key, style: `width:${(part.value / total) * 100}%`, title: `${part.label}: ${part.value.toFixed(1)}` })));
}

function renderCaptain(models, w) {
  const body = document.getElementById('cp-body');
  const oursOnly = MIX_SRC.every(([k]) => k === 'ours' || !w[k]);
  const rows = models.map((m) => ({ m, v: mixValue(m, w), p: state.players[m.id] || {} })).filter((r) => r.v !== null)
    .sort((a, b) => b.v - a.v).slice(0, 10);
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: Object.values(w).some((x) => x > 0) ? 'Captain picks appear once the model has run for this gameweek.' : 'Move a slider above 0% to pick a source.' })); return; }
  const list = h('ol', { class: 'plist' }, rows.map(({ m, v, p }, i) => {
    const sub = [m.team, m.pos, p.price ? '£' + Number(p.price).toFixed(1) + 'm' : null, num(p.owned_pct) !== null ? Math.round(p.owned_pct) + '% owned' : null].filter(Boolean).join(' · ');
    const tag = num(p.owned_pct) >= 25 ? 'Template' : num(p.owned_pct) < 10 ? 'Punt' : null;
    const news = num(p.chance_playing) !== null && p.chance_playing < 1 ? h('p', { class: 'pnews', text: `${Math.round(p.chance_playing * 100)}% chance of playing${p.news ? ': ' + p.news : ''}` }) : null;
    const srcs = oursOnly ? null : h('p', { class: 'msrc' }, MIX_SRC.filter(([k]) => w[k] > 0).map(([k]) => h('span', null, MIX_SHORT[k] + ' ', h('b', { text: pts1(m[k]) }))));
    return h('li', { class: 'pcard' },
      h('span', { class: 'prank', text: String(i + 1) }),
      h('div', { class: 'pmain' },
        h('div', { class: 'pname' }, crest(m.team, 20), h('span', { text: m.name }), tag ? h('span', { class: 'pick-tag' }, explain(tag, 'template_punt')) : null),
        h('p', { class: 'psub', text: sub }),
        breakdownBar(p, p),
        h('div', { class: 'stats' },
          num(p.p_goal) !== null ? h('span', { class: 'stat' }, h('b', { text: pct0(p.p_goal) }), ' goal') : null,
          num(p.p_assist) !== null ? h('span', { class: 'stat' }, h('b', { text: pct0(p.p_assist) }), ' assist') : null,
          num(p.p_blank) !== null ? h('span', { class: 'stat' }, h('b', { text: pct0(p.p_blank) }), ' blank') : null),
        srcs, news, xoChips(p)),
      h('div', { class: 'pbig' }, h('b', { text: v.toFixed(1) }), h('i', null, explain('xPts', 'xpts'))));
  }));
  const breakdownLabels = {
    appearance: 'appearance', goals: 'goals', assists: 'assists',
    clean: explain('clean-sheet chance', 'clean_sheet'), defcon: explain('DEFCON', 'defcon'), bonus: explain('expected bonus', 'expected_bonus'),
  };
  const breakdownLegend = h('div', { class: 'break-legend' },
    Object.keys(breakdownLabels).map((x) => h('span', null, h('i', { class: 'xb-' + x }), breakdownLabels[x])));
  body.replaceChildren(h('p', { class: 'note' }, explain('Template / Punt', 'template_punt'), ' tags are based on ownership.', oursOnly ? null : ' The bar and the goal, assist and blank chances come from our model.'), breakdownLegend, list,
    tableView(['Player', 'xPts', 'Goal', 'Assist', 'Blank'], rows.map(({ m, v, p }) => [`${m.name} (${m.team})`, v.toFixed(1), num(p.p_goal) !== null ? pct0(p.p_goal) : '–', num(p.p_assist) !== null ? pct0(p.p_assist) : '–', num(p.p_blank) !== null ? pct0(p.p_blank) : '–'])));
}

/* ---------- requested FPL shortlists ---------- */

function playerList(id, rows, value) {
  const body = document.getElementById(id);
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: 'No qualifying players.' })); return; }
  const list = h('ol', { class: 'mini-list' }, rows.map((p, i) => h('li', { class: 'mini-row' },
    h('span', { class: 'prank', text: String(i + 1) }), crest(p.team, 20),
    h('span', { class: 'mini-name' }, h('b', { text: p.name }), h('i', { text: `${p.team} · v ${p.opponent || '–'} · ${Number(p.owned_pct).toFixed(1)}% owned` })),
    h('strong', { text: value(p) }))));
  body.replaceChildren(list);
  document.getElementById(id.replace('-body', '-top')).textContent = `Top: ${rows[0].name} · ${value(rows[0])}`;
}

function renderFridayLists(proj) {
  const players = (proj.players || []).filter((p) => num(p.xpts) !== null);
  playerList('dc-body', players.filter((p) => ['DEF', 'MID'].includes(p.pos)).sort((a, b) => b.p_defcon - a.p_defcon).slice(0, 10), (p) => pct0(p.p_defcon));
  playerList('bn-body', [...players].sort((a, b) => b.xbonus - a.xbonus).slice(0, 10), (p) => `${Number(p.xbonus).toFixed(2)} pts`);
  playerList('df-body', players.filter((p) => p.owned_pct < 5).sort((a, b) => b.xpts - a.xpts).slice(0, 10), (p) => `${Number(p.xpts).toFixed(1)} pts`);
  playerList('vl-body', players.filter((p) => p.xpts >= 2 && p.price > 0).sort((a, b) => b.xpts / b.price - a.xpts / a.price).slice(0, 10), (p) => `${(p.xpts / p.price).toFixed(2)} pts / £m`);
  const sp = document.getElementById('sp-body');
  const rows = proj.set_pieces || [];
  sp.replaceChildren(rows.length ? h('div', { class: 'set-grid' }, rows.map((r) => h('article', { class: 'set-row' },
    h('h3', null, crest(r.team, 20), teamName(r.team)),
    h('p', { text: `Pens: ${(r.penalties || []).join(', ') || '–'}` }),
    h('p', { text: `Free kicks: ${(r.direct_freekicks || []).join(', ') || '–'}` }),
    h('p', { text: `Corners: ${(r.corners || []).join(', ') || '–'}` })))) : h('p', { class: 'empty', text: 'Set-piece data is not available.' }));
  document.getElementById('sp-top').textContent = rows.length ? `${rows.length} teams` : '';
}

/* ---------- source mix: which projections drive the captain picks and the consensus ---------- */

const MIX_SRC = [['ours', 'Our model'], ['eleven', 'elevenify'], ['solio', 'Solio'], ['pundit', 'Pundit']];
const MIX_SHORT = { ours: 'Ours', eleven: 'elevenify', solio: 'Solio', pundit: 'Pundit' };
const EQUAL = { ours: 25, eleven: 25, solio: 25, pundit: 25 };
const pts1 = (v) => (num(v) === null ? '–' : Number(v).toFixed(1));

// One row per player with every source's number: ours from projections.json, the rest from consensus.json.
function buildModels(proj, cons, gwId) {
  const out = {};
  (proj.players || []).forEach((p) => { out[p.id] = { id: p.id, name: p.name, team: p.team, pos: p.pos, ours: num(p.xpts) }; });
  if (cons && cons.gw === gwId && Array.isArray(cons.players)) cons.players.forEach((c) => {
    const m = out[c.id] || (out[c.id] = { id: c.id, name: c.name, team: c.team, pos: c.pos, ours: null });
    m.eleven = num(c.eleven); m.solio = num(c.solio); m.pundit = num(c.pundit); m.fpl = num(c.fpl);
  });
  return Object.values(out);
}

// Weighted mean of the sources in the mix; null unless every one of them has a number for this player,
// so a source that leaves a player out (Solio lists only its top players) cannot lift him up the ranking.
function mixValue(m, w) {
  let sum = 0, all = 0;
  for (const [k] of MIX_SRC) {
    const wk = w[k] || 0;
    if (!wk) continue;
    if (num(m[k]) === null) return null;
    sum += wk * m[k];
    all += wk;
  }
  return all ? sum / all : null;
}

// Pills pick one source or Blend; Blend shows a slider per source. The choice is kept per section in this browser.
function mixPicker(el, id, avail, def, onChange) {
  let mix = def;
  try { const v = JSON.parse(localStorage.getItem('mix-' + id)); if (v && v.mode && v.w) mix = v; } catch (e) { /* storage is optional */ }
  if (mix.mode !== 'blend' && !avail.includes(mix.mode)) mix = def;
  const weights = () => (mix.mode === 'blend' ? Object.fromEntries(avail.map((k) => [k, mix.w[k] || 0])) : { [mix.mode]: 100 });
  const save = () => { try { localStorage.setItem('mix-' + id, JSON.stringify(mix)); } catch (e) { /* storage is optional */ } };
  const draw = () => {
    const pill = (mode, label) => {
      const b = h('button', { type: 'button', class: 'pill' + (mix.mode === mode ? ' is-on' : ''), 'aria-pressed': String(mix.mode === mode), text: label });
      b.addEventListener('click', () => { mix = { ...mix, mode }; save(); draw(); });
      return b;
    };
    const kids = [h('div', { class: 'mix-row' }, h('span', { class: 'mix-l', text: 'Numbers from' }),
      h('div', { class: 'pills', role: 'group', 'aria-label': 'Projection source' },
        MIX_SRC.filter(([k]) => avail.includes(k)).map(([k, label]) => pill(k, label)), pill('blend', 'Blend')))];
    if (mix.mode === 'blend') {
      const shares = {};
      const sliders = avail.map((k) => {
        const input = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(mix.w[k] || 0), 'aria-label': `${MIX_SRC.find((x) => x[0] === k)[1]} weight` });
        shares[k] = h('b', { class: 'mix-pct' });
        input.addEventListener('input', () => { mix = { ...mix, w: { ...mix.w, [k]: Number(input.value) } }; save(); update(); });
        return h('label', { class: 'mix-s' }, h('span', { text: MIX_SRC.find((x) => x[0] === k)[1] }), input, shares[k]);
      });
      const update = () => {
        const w = weights(), total = Object.values(w).reduce((x, y) => x + y, 0);
        avail.forEach((k) => { shares[k].textContent = total ? Math.round((w[k] / total) * 100) + '%' : '0%'; });
        onChange(w);
      };
      kids.push(h('div', { class: 'mix-sl' }, sliders), h('p', { class: 'mix-note', text: 'Shares rescale to 100%. Only players that every source in your mix covers are ranked; Solio publishes only its top players.' }));
      el.replaceChildren(...kids);
      update();
      return;
    }
    el.replaceChildren(...kids);
    onChange(weights());
  };
  draw();
}

/* ---------- (c2) projection consensus: every model side by side, ranked by the chosen mix ---------- */

const CONS_COLS = [['ours', 'Ours'], ['eleven', 'elevenify'], ['solio', 'Solio'], ['pundit', 'Pundit'], ['fpl', 'FPL form']];

// Keys of the highest model (FPL form is not a model). No highlight when they all agree.
function topModels(p) {
  const v = MIX_SRC.map(([k]) => k).filter((k) => num(p[k]) !== null).map((k) => [k, pts1(p[k])]);
  const mx = Math.max(...v.map((x) => Number(x[1])));
  return v.length > 1 && v.some((x) => Number(x[1]) < mx) ? new Set(v.filter((x) => Number(x[1]) === mx).map((x) => x[0])) : new Set();
}

function renderConsensus(models, w) {
  const body = document.getElementById('co-body');
  const rows = models.filter((m) => MIX_SRC.filter(([k]) => num(m[k]) !== null).length >= 2)
    .map((m) => ({ ...m, mix: mixValue(m, w) })).filter((m) => m.mix !== null).sort((a, b) => b.mix - a.mix).slice(0, 15);
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: Object.values(w).some((x) => x > 0) ? 'The consensus appears once the free sources have published numbers for this gameweek.' : 'Move a slider above 0% to pick a source.' })); return; }
  const hiTitle = 'Highest of the models';

  const cards = h('ol', { class: 'cons-cards' }, rows.map((p, i) => {
    const hi = topModels(p);
    return h('li', { class: 'ccard' },
      h('div', { class: 'ctop' },
        h('span', { class: 'prank', text: String(i + 1) }),
        h('div', { class: 'pmain' }, h('div', { class: 'pname' }, crest(p.team, 20), h('span', { text: p.name })), h('p', { class: 'psub', text: `${p.team} · ${p.pos}` })),
        h('div', { class: 'pbig' }, h('b', { text: pts1(p.mix) }), h('i', { text: 'Your mix' }))),
      h('div', { class: 'cvals' }, CONS_COLS.map(([k, label]) =>
        h('div', { class: 'cv' + (hi.has(k) ? ' hi' : '') + (k === 'fpl' ? ' off' : ''), title: hi.has(k) ? hiTitle : null }, h('i', { text: label }), h('b', { text: pts1(p[k]) })))));
  }));

  const table = h('table', { class: 'ctable', 'aria-label': 'Expected points by source' },
    h('thead', null, h('tr', null, h('th', { class: 'cp', text: 'Player' }), CONS_COLS.map(([k, label]) => h('th', { class: 'n' + (k === 'fpl' ? ' off' : ''), text: label })), h('th', { class: 'n', text: 'Your mix' }))),
    h('tbody', null, rows.map((p, i) => {
      const hi = topModels(p);
      return h('tr', null,
        h('td', { class: 'cp' }, h('span', { class: 'cpid' }, h('span', { class: 'prank', text: String(i + 1) }), crest(p.team, 20), h('span', { class: 'cpn' }, h('b', { text: p.name }), h('i', { text: `${p.team} · ${p.pos}` })))),
        CONS_COLS.map(([k]) => h('td', { class: 'n' + (k === 'fpl' ? ' off' : '') }, h('span', { class: 'v' + (hi.has(k) ? ' hi' : ''), title: hi.has(k) ? hiTitle : null, text: pts1(p[k]) }))),
        h('td', { class: 'n avg' }, h('span', { class: 'v', text: pts1(p.mix) })));
    })));

  body.replaceChildren(cards, table,
    h('p', { class: 'note', text: `Top ${rows.length} by your mix, among players with at least two models. The shaded number is the highest model. A dash means that source does not publish the player. FPL form is shown but never in the mix: it is form-based and erratic.` }));
}

/* ---------- (d) clean-sheet chances, all teams ---------- */

const elevenLink = () => h('a', { href: 'https://www.elevenify.com', target: '_blank', rel: 'noopener', text: 'elevenify' });

function modelLegend(hasEleven) {
  return h('div', { class: 'model-legend' },
    h('strong', { text: 'Our model (from Polymarket odds)' }),
    hasEleven ? h('span', null, h('span', { class: 'eleven-badge', text: 'elevenify' }), ' separate second opinion') : null);
}

function renderCS(proj) {
  const body = document.getElementById('cs-body');
  const rows = [];
  ((proj && proj.fixtures) || []).forEach((f) => {
    if (num(f.cs_home) !== null) rows.push({ team: f.home, name: f.home_name || teamName(f.home), opp: f.away_name || teamName(f.away), home: true, p: Number(f.cs_home) });
    if (num(f.cs_away) !== null) rows.push({ team: f.away, name: f.away_name || teamName(f.away), opp: f.home_name || teamName(f.home), home: false, p: Number(f.cs_away) });
  });
  if (!rows.length) { body.replaceChildren(h('p', { class: 'empty', text: 'Clean-sheet chances appear once the match model has run.' })); return; }
  rows.sort((a, b) => b.p - a.p);
  rows.forEach((r) => { r.e = elevenTeam('clean_sheets', r.team); });
  const hasE = rows.some((r) => r.e !== null);
  const top = Math.min(1, Math.ceil(Math.max(...rows.map((r) => Math.max(r.p, r.e || 0))) * 10) / 10);
  const list = h('ul', { class: 'cs-list' }, rows.map((r) => {
    const li = h('li', { class: 'csr' },
      crest(r.team, 20) || h('span', { class: 'crest-ph' }),
      h('div', { class: 'cs-t' }, h('b', { text: r.name }), h('span', { text: `${r.home ? 'v' : 'at'} ${r.opp}` })),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${r.name} clean sheet ${pct0(r.p)}${r.e !== null ? `, elevenify ${pct0(r.e)}` : ''}` },
        h('i', { style: `width:${(r.p / top) * 100}%` }), r.e !== null ? h('b', { class: 'emk', style: `left:${(r.e / top) * 100}%` }) : null),
      h('b', { class: 'cs-v', text: pct0(r.p) }),
      r.e !== null ? elevenLine(pct0(r.e)) : null);
    attachTip(li, [`${pct0(r.p)} clean sheet`, `${r.name} ${r.home ? 'v' : 'at'} ${r.opp}`, r.e !== null ? `elevenify ${pct0(r.e)}` : null].filter(Boolean));
    return li;
  }));
  body.replaceChildren(...[modelLegend(hasE), list, h('p', { class: 'note', text: `Bars run from 0% to ${Math.round(top * 100)}%.` }),
    tableView(['Team', 'Opponent', 'Clean sheet', ...(hasE ? ['elevenify'] : [])], rows.map((r) => [r.name, `${r.home ? 'v' : 'at'} ${r.opp}`, pct0(r.p), ...(hasE ? [r.e !== null ? pct0(r.e) : '–'] : [])]))].filter(Boolean));
}

/* ---------- (e) goals expected per match ---------- */

function renderGoals(proj) {
  const body = document.getElementById('gl-body');
  const fx = [...((proj && proj.fixtures) || [])].filter((f) => num(f.lam_home) !== null && num(f.lam_away) !== null)
    .sort((a, b) => new Date(a.kickoff_utc) - new Date(b.kickoff_utc));
  if (!fx.length) { body.replaceChildren(h('p', { class: 'empty', text: 'Match numbers appear once the match model has run.' })); return; }
  const legend = h('div', { class: 'legend2' }, key('home', 'Home'), key('draw', 'Draw'), key('away', 'Away'));
  const list = h('ul', { class: 'gm-list' }, fx.map((f) => {
    const hn = f.home_name || teamName(f.home), an = f.away_name || teamName(f.away);
    const vol = num(f.poly_volume), et = elevenText(f.home, f.away);
    const volText = vol === null ? 'Polymarket volume not available' : `${vol < 2000 ? 'Thin market: ' : ''}$${Math.round(vol).toLocaleString('en-US')} traded on Polymarket`;
    const li = h('li', { class: 'gm' },
      h('div', { class: 'gm-head' }, h('span', { class: 'gm-teams' }, crest(f.home, 20), h('b', { text: `${hn} v ${an}` }), crest(f.away, 20)), h('span', { class: 'gm-ko', text: f.kickoff_utc ? kickoffFmt(f.kickoff_utc) : '' })),
      h('div', { class: 'gm-xg', 'aria-label': `Expected goals ${Number(f.lam_home).toFixed(1)} to ${Number(f.lam_away).toFixed(1)}` },
        h('span', null, h('b', { text: Number(f.lam_home).toFixed(1) }), h('i', { text: 'expected goals' })),
        h('span', null, h('b', { text: Number(f.lam_away).toFixed(1) }), h('i', { text: 'expected goals' }))),
      h('div', { class: 'gm-1x2', role: 'img', 'aria-label': `${hn} ${pct0(f.p_home)}, draw ${pct0(f.p_draw)}, ${an} ${pct0(f.p_away)}` },
        h('i', { class: 'home', style: `flex:${f.p_home}` }), h('i', { class: 'draw', style: `flex:${f.p_draw}` }), h('i', { class: 'away', style: `flex:${f.p_away}` })),
      h('div', { class: 'gm-p' }, h('span', { text: `${hn} ${pct0(f.p_home)}` }), h('span', { text: `Draw ${pct0(f.p_draw)}` }), h('span', { text: `${an} ${pct0(f.p_away)}` })),
      elevenLine(et),
      h('p', { class: 'gm-note' }, volText, safeUrl(f.source_url) ? h('a', { href: safeUrl(f.source_url), target: '_blank', rel: 'noopener', text: ' source' }) : null));
    attachTip(li, [`${Number(f.lam_home).toFixed(2)} to ${Number(f.lam_away).toFixed(2)} expected goals`, `${hn} ${pct0(f.p_home)} · Draw ${pct0(f.p_draw)} · ${an} ${pct0(f.p_away)}`]);
    return li;
  }));
  const shown = fx.some((f) => elevenText(f.home, f.away));
  body.replaceChildren(...[modelLegend(shown), legend, list, h('p', { class: 'note', text: `The numbers are expected goals; the single bar shows home-win, draw and away-win chances.` + (shown ? " elevenify's H, D and A are its separate result chances." : '') }),
    tableView(['Match', 'xG H', 'xG A', 'H / D / A'], fx.map((f) => [`${f.home} v ${f.away}`, Number(f.lam_home).toFixed(2), Number(f.lam_away).toFixed(2), `${pct0(f.p_home)} / ${pct0(f.p_draw)} / ${pct0(f.p_away)}`]))].filter(Boolean));
}

/* ---------- (f) over- and under-performers: scatter with a parity line ---------- */

function sv(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  return e;
}

/* Shared clean scatter used by all three expected-v-actual charts. */
function drawScatter(allPts, config) {
  const pts = [...allPts].sort((a, b) => b.x - a.x).slice(0, 40);
  const W = 360, M = { l: 36, r: 14, t: 10, b: 40 };
  const maxV = Math.max(...pts.map((p) => Math.max(p.x, p.y)));
  const top = Math.max(4, Math.ceil(maxV / 2) * 2);
  const pw = W - M.l - M.r, H = pw + M.t + M.b, s = pw / top;
  const X = (v) => M.l + v * s, Y = (v) => M.t + pw - v * s;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sc', role: 'img', 'aria-label': config.aria });

  for (let t = 0; t <= top; t += 2) {
    svg.append(sv('line', { x1: X(0), x2: X(top), y1: Y(t), y2: Y(t), stroke: COL.hair, 'stroke-width': 1 }));
    svg.append(sv('line', { x1: X(t), x2: X(t), y1: Y(0), y2: Y(top), stroke: COL.hair, 'stroke-width': 1 }));
    svg.append(sv('text', { x: M.l - 6, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'tk' }, String(t)));
    svg.append(sv('text', { x: X(t), y: Y(0) + 15, 'text-anchor': 'middle', class: 'tk' }, String(t)));
  }
  svg.append(sv('text', { x: M.l + pw / 2, y: H - 6, 'text-anchor': 'middle', class: 'ax' }, config.xLabel));
  svg.append(sv('text', { transform: `translate(11 ${M.t + pw / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'ax' }, config.yLabel));
  svg.append(sv('line', { x1: X(0), y1: Y(0), x2: X(top), y2: Y(top), stroke: COL.furniture, 'stroke-width': 1.5 }));

  const cls = (p) => (p.y - p.x >= 1 ? 'over' : p.y - p.x <= -1 ? 'under' : 'even');
  const fill = { over: COL.pink, under: COL.ink, even: '#b4b4bd' };
  [...pts].sort((a, b) => Math.abs(a.y - a.x) - Math.abs(b.y - b.x)).forEach((p) => {
    p.el = sv('circle', { cx: X(p.x), cy: Y(p.y), r: 4.5, fill: fill[cls(p)], stroke: '#fff', 'stroke-width': 1.5 });
    svg.append(p.el);
  });

  const boxes = [];
  [...pts].sort((a, b) => Math.abs(b.y - b.x) - Math.abs(a.y - a.x)).slice(0, 6).forEach((p) => {
    const w = p.name.length * 6 + 4, hh = 13, cx = X(p.x), cy = Y(p.y);
    const opts = [[cx + 8, cy - hh / 2], [cx - 8 - w, cy - hh / 2], [cx - w / 2, cy - 9 - hh], [cx - w / 2, cy + 9], [cx + 8, cy - hh - 6], [cx + 8, cy + 4]];
    let pick = null;
    for (const [bx, by] of opts) {
      const b = { x: bx, y: by, w, h: hh };
      const hitsDot = pts.some((q) => q !== p && X(q.x) > b.x - 4 && X(q.x) < b.x + w + 4 && Y(q.y) > b.y - 4 && Y(q.y) < b.y + hh + 4);
      if (b.x >= 2 && b.x + w <= W - 2 && b.y >= 2 && b.y + hh <= H - 20 && !hitsDot && !boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y)) { pick = b; break; }
    }
    if (!pick) pick = { x: Math.min(cx + 8, W - w - 2), y: cy - hh / 2, w, h: hh };
    boxes.push(pick);
    svg.append(sv('text', { x: pick.x, y: pick.y + 10.5, class: 'pl' }, p.name));
  });

  const hit = sv('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  svg.append(hit);
  let hot = null;
  const reset = () => { if (hot) hot.el.setAttribute('r', 4.5); hot = null; hideTip(); };
  const move = (e) => {
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const point = svg.createSVGPoint(); point.x = e.clientX; point.y = e.clientY;
    const q = point.matrixTransform(matrix.inverse());
    let nearest = null, distance = Infinity;
    pts.forEach((p) => { const d = Math.hypot(X(p.x) - q.x, Y(p.y) - q.y); if (d < distance) { distance = d; nearest = p; } });
    if (hot && hot !== nearest) hot.el.setAttribute('r', 4.5);
    if (nearest && distance <= 30) {
      hot = nearest; hot.el.setAttribute('r', 6.5);
      showTip(hot.el, config.tooltip(hot), hot.el.getBoundingClientRect());
    } else reset();
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', reset);

  const sorted = [...pts].sort((a, b) => (b.y - b.x) - (a.y - a.x));
  return [
    h('div', { class: 'legend2' }, key('over', config.over), key('under', config.under), key('even', 'About as expected')),
    h('div', { class: 'scwrap' }, svg),
    h('p', { class: 'note', text: config.note }),
    tableView(['Player', config.xCol, config.yCol, 'Difference'], sorted.map((p) => [{ name: p.name, team: p.team, pos: p.pos }, p.x.toFixed(1), p.y, `${p.y - p.x >= 0 ? '+' : ''}${(p.y - p.x).toFixed(1)}`]), { diff: 3, hide: [2] }),
  ];
}

function perfRank(title, rows) {
  return h('section', { class: 'perf-rank' }, h('h3', { text: title }), h('ol', null, rows.map((p, i) => {
    const gap = p.y - p.x;
    return h('li', null, h('span', { class: 'prank', text: String(i + 1) }), h('span', { class: 'perf-name' }, h('b', { text: p.name }), h('i', { text: `${p.team} · ${p.pos} · ${Number(p.owned_pct || 0).toFixed(1)}% owned` })), h('strong', { text: `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}` }), h('small', { text: `${p.y} G+A / ${p.x.toFixed(1)} xG+xA` }));
  })));
}

function renderPerf(proj) {
  const all = (proj.xg_table || []).map((p) => ({ ...p, x: Number(p.xg) + Number(p.xa), y: Number(p.goals) + Number(p.assists) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!all.length) { document.getElementById('pf-body').replaceChildren(h('p', { class: 'empty', text: 'Expected-involvement numbers are not available yet.' })); return; }
  const parts = drawScatter(all, { aria: 'Scatter of expected against actual goal involvements', xLabel: 'Expected: xG + xA', yLabel: 'Actual: goals + assists', xCol: 'xG+xA', yCol: 'G+A', over: 'Scoring more than chances suggest', under: 'Unlucky so far', note: 'Above the line = scoring more than chances suggest (may cool off). Below = unlucky so far.', tooltip: (p) => [`${p.y} goals + assists from ${p.x.toFixed(1)} expected`, `${p.name}, ${teamName(p.team)}`, `${p.minutes} minutes`] });
  const hot = [...all].filter((p) => p.y > p.x).sort((a, b) => (b.y - b.x) - (a.y - a.x)).slice(0, 8);
  const due = [...all].filter((p) => p.y < p.x).sort((a, b) => (a.y - a.x) - (b.y - b.x)).slice(0, 8);
  document.getElementById('pf-body').replaceChildren(...parts.slice(0, 3), h('div', { class: 'perf-lists' }, perfRank('Running hot (may cool off)', hot), perfRank('Due a goal (unlucky so far)', due)), parts[3], h('p', { class: 'note', text: 'Source: FPL (Opta) data.' }));
}

function renderExtraScatters(proj) {
  const rows = proj.xg_table || [];
  const charts = [
    ['fn-body', 'xg', 'goals', { aria: 'Scatter of goals against expected goals', xLabel: 'Expected goals: xG', yLabel: 'Actual goals', xCol: 'xG', yCol: 'Goals', over: 'Finishing above chances', under: 'Fewer goals than expected', note: 'Above the line = finishing above chances. Below = fewer goals than expected.', tooltip: (p) => [`${p.y} goals from ${p.x.toFixed(1)} xG`, `${p.name}, ${teamName(p.team)}`, `${p.minutes} minutes`] }],
    ['cr-body', 'xa', 'assists', { aria: 'Scatter of assists against expected assists', xLabel: 'Expected assists: xA', yLabel: 'Actual assists', xCol: 'xA', yCol: 'Assists', over: 'More assists than expected', under: 'Fewer assists than expected', note: 'Above the line = more assists than chances suggest. Below = fewer assists than expected.', tooltip: (p) => [`${p.y} assists from ${p.x.toFixed(1)} xA`, `${p.name}, ${teamName(p.team)}`, `${p.minutes} minutes`] }],
  ];
  charts.forEach(([id, xKey, yKey, config]) => {
    const pts = rows.map((p) => ({ ...p, x: Number(p[xKey]), y: Number(p[yKey]) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    document.getElementById(id).replaceChildren(...drawScatter(pts, config), h('p', { class: 'note', text: 'Source: FPL (Opta) data.' }));
  });
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
    document.getElementById('how-text').textContent = `Match odds come from Polymarket. Average goals are calibrated to the league's ${Number(proj.league_avg_goals).toFixed(2)} goals per game. Player shares and defensive contributions come from FPL; bonus is modelled from last season.`;
  }
  const consP = state.mock ? Promise.resolve(null) : getJSON(`data/consensus.json?v=${Math.floor(Date.now() / 60000)}`).catch(() => null);
  renderDoubts(proj);
  renderFridayLists(proj);
  renderCS(proj);
  renderGoals(proj);
  renderPerf(proj);
  renderExtraScatters(proj);
  const models = buildModels(proj, await consP, gwId);
  const avail = MIX_SRC.map(([k]) => k).filter((k) => models.some((m) => num(m[k]) !== null));
  if (avail.length > 1) mixPicker(document.getElementById('cp-mix'), 'captain', avail, { mode: 'ours', w: EQUAL }, (w) => renderCaptain(models, w));
  else renderCaptain(models, { ours: 100 });
  if (avail.length > 1) mixPicker(document.getElementById('co-mix'), 'consensus', avail, { mode: 'blend', w: EQUAL }, (w) => renderConsensus(models, w));
  else renderConsensus([], EQUAL);
}

init();
