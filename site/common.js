/* PL Fair Price, shared by index.html and gw.html. Vanilla JS, no build step.
   All text goes in through textContent, never innerHTML. */

const CONFIG = {
  name: 'PL Fair Price',
  tagline: 'What every Premier League market on XO should cost, priced from the markets with real money.',
  ref: 'cryptotan01',
  minGapPts: 8,
};

const CHANGELOG = [
  { version: 'v1', date: 'Thu 8 Oct 2026', notes: 'First public version: XO vs Fair for every Premier League market, GW numbers for FPL managers.' },
  { version: 'v1.1', date: 'Thu 8 Oct 2026', notes: 'Gameweek numbers moved to their own page. Low-confidence prices now read "Rough".' },
];

const TEAMS = {
  ARS: 'Arsenal', AVL: 'Aston Villa', BHA: 'Brighton', BOU: 'Bournemouth', BRE: 'Brentford',
  BUR: 'Burnley', CHE: 'Chelsea', COV: 'Coventry', CRY: 'Crystal Palace', EVE: 'Everton',
  FUL: 'Fulham', HUL: 'Hull', IPS: 'Ipswich', LEE: 'Leeds', LEI: 'Leicester', LIV: 'Liverpool',
  MCI: 'Man City', MUN: 'Man United', NEW: 'Newcastle', NFO: "Nott'm Forest", SOU: 'Southampton',
  SUN: 'Sunderland', TOT: 'Spurs', WHU: 'West Ham', WOL: 'Wolves',
};
// Data may carry 3-letter codes or club names; both resolve to a code.
const ALIASES = {
  'brighton & hove albion': 'BHA', 'brighton and hove albion': 'BHA', 'afc bournemouth': 'BOU', 'coventry city': 'COV',
  'hull city': 'HUL', 'ipswich town': 'IPS', 'leeds united': 'LEE', 'leicester city': 'LEI', 'manchester city': 'MCI',
  'man utd': 'MUN', 'manchester united': 'MUN', 'manchester utd': 'MUN', 'newcastle united': 'NEW', 'nottingham forest': 'NFO',
  "nott'm forest": 'NFO', 'nottm forest': 'NFO', 'forest': 'NFO', 'tottenham': 'TOT', 'tottenham hotspur': 'TOT',
  'west ham united': 'WHU', 'wolverhampton wanderers': 'WOL', 'wolverhampton': 'WOL', 'sunderland afc': 'SUN',
};
const NAME2CODE = {};
Object.keys(TEAMS).forEach((c) => { NAME2CODE[TEAMS[c].toLowerCase()] = c; });
Object.assign(NAME2CODE, ALIASES);
const teamCode = (x) => {
  if (!x) return null;
  const t = String(x).trim();
  if (TEAMS[t.toUpperCase()] && t.length === 3) return t.toUpperCase();
  return NAME2CODE[t.toLowerCase().replace(/\s+fc$/, '')] || null;
};
const CRESTS = new Set(['ARS', 'AVL', 'BHA', 'BOU', 'BRE', 'CHE', 'COV', 'CRY', 'EVE', 'FUL', 'HUL', 'IPS', 'LEE', 'LIV', 'MCI', 'MUN', 'NEW', 'NFO', 'SUN', 'TOT']);

const state = { board: null, proj: null, markets: [], live: new Set(), bySlug: {}, players: {}, sort: 'match', mock: false };

/* ---------- tiny helpers ---------- */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (p) => (p >= 0.995 ? '>99%' : p <= 0.005 ? '<1%' : Math.round(p * 100) + '%');
const safeUrl = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; }
};
const teamName = (x) => TEAMS[teamCode(x)] || x;

function crest(team, size) {
  const code = teamCode(team);
  if (!code || !CRESTS.has(code)) return null;
  const img = h('img', { class: 'crest', src: `assets/crests/${code}.webp`, width: size, height: size, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.remove());
  return img;
}

function wordmark(cls) {
  return h('img', { class: cls || 'wm', src: 'assets/logos/xo-wordmark-white.webp', width: 56, height: 20, alt: 'XO' });
}

function tradeUrl(m) {
  const base = safeUrl(m.url) || `https://beta.xo.market/event/${encodeURIComponent(m.slug)}`;
  const u = new URL(base);
  u.searchParams.set('r', CONFIG.ref);
  return u.href;
}

/* ---------- data ---------- */

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}

async function loadSet(dir) {
  const bust = Math.floor(Date.now() / 60000);
  const board = await getJSON(`${dir}/board.json?v=${bust}`);
  const v = encodeURIComponent(board.generated_at || bust);
  const proj = await getJSON(`${dir}/projections.json?v=${v}`).catch(() => null);
  return { board, proj };
}

function cleanMarket(m) {
  const fair = m.fair && num(m.fair.p) !== null ? {
    p: num(m.fair.p), low: num(m.fair.low), high: num(m.fair.high),
    confidence: m.fair.confidence || 'low', method: m.fair.method || '',
    method_text: m.fair.method_text || '', inputs: Array.isArray(m.fair.inputs) ? m.fair.inputs : [],
  } : null;
  const xo = num(m.xo_price);
  let gap = num(m.gap_pts);
  if (gap === null && fair && xo !== null) gap = Math.round((fair.p - xo) * 100);
  return {
    ...m, xo_price: xo, fair, gap_pts: gap,
    liquidity_usd: num(m.liquidity_usd), volume_usd: num(m.volume_usd), best_bid: num(m.best_bid), best_ask: num(m.best_ask),
    exp: m.expires_at ? new Date(m.expires_at).getTime() : null,
    fixture: m.fixture && m.fixture.home ? m.fixture : null,
  };
}

/* ---------- page setup, shared ---------- */

// Loads data/ (or data_mock/ when data/ is empty or ?mock=1) into `state`. Returns false if nothing loaded.
async function loadData() {
  const forceMock = new URLSearchParams(location.search).has('mock');
  let set = null;
  if (!forceMock) {
    try { set = await loadSet('data'); } catch (e) { set = null; }
  }
  if (!set || !set.board || !Array.isArray(set.board.markets) || !set.board.markets.length) {
    try { set = await loadSet('data_mock'); state.mock = true; } catch (e) { console.error('No data', e); }
  }
  if (!set) return false;
  state.board = set.board;
  state.proj = set.proj;
  state.live = new Set(Array.isArray(set.board.live) ? set.board.live : []);
  state.markets = set.board.markets.map(cleanMarket);
  state.markets.forEach((m) => { state.bySlug[m.slug] = m; });
  ((set.proj && set.proj.players) || []).forEach((p) => { state.players[p.id] = p; });
  return true;
}

function setupPage() {
  const name = document.getElementById('site-name'), tag = document.getElementById('site-tagline');
  if (name) name.textContent = CONFIG.name;
  if (tag) tag.textContent = CONFIG.tagline;
  const cl = document.getElementById('changelog');
  if (cl) cl.replaceChildren(...CHANGELOG.map((e) => h('li', null, h('b', { text: e.version }), ` · ${e.date} · ${e.notes}`)));
}

// Fills every "GW numbers" label from the data so the number is never hard-coded.
function setGwLabels() {
  const id = (state.board.gw || {}).id;
  document.querySelectorAll('[data-gw-label]').forEach((el) => { el.textContent = `GW${id || ''} numbers`; });
  document.querySelectorAll('[data-gw]').forEach((el) => { el.textContent = id ? `GW${id}` : 'GW'; });
}

function startCountdown(labelEl, boxEl, wrapEl, endIso, gwId) {
  const end = endIso ? new Date(endIso).getTime() : null;
  if (!end || !boxEl) { if (wrapEl) wrapEl.hidden = true; return; }
  if (labelEl) labelEl.textContent = `GW${gwId || ''} deadline`;
  const draw = () => {
    const diff = end - Date.now();
    boxEl.replaceChildren();
    if (diff <= 0) { boxEl.append(h('span', { class: 'dl-done', text: 'Passed' })); return; }
    const d = Math.floor(diff / 86400000), hr = Math.floor((diff % 86400000) / 3600000), mi = Math.floor((diff % 3600000) / 60000);
    [[d, 'D'], [hr, 'H'], [mi, 'M']].forEach(([v, u]) => {
      boxEl.append(h('span', { class: 'dl-box' }, h('b', { text: String(v).padStart(2, '0') }), h('i', { text: u })));
    });
  };
  draw();
  setInterval(draw, 20000);
}
