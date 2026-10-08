/* PL Fair Price, markets page. Needs common.js. */

async function init() {
  setupPage();
  document.querySelectorAll('.pill').forEach((b) => b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll('.pill').forEach((x) => {
      const on = x === b;
      x.classList.toggle('is-on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderMarkets();
  }));

  if (!(await loadData())) { document.getElementById('mk-list').replaceChildren(h('p', { class: 'empty', text: 'Could not load the board. Try again in a minute.' })); return; }

  const search = document.getElementById('market-search');
  search.addEventListener('input', () => { state.query = search.value.trim().toLowerCase(); renderMarkets(); });

  document.getElementById('sample').hidden = !state.mock;
  setGwLabels();
  startCountdown(document.getElementById('dl-label'), document.getElementById('dl-boxes'), document.getElementById('deadline'), (state.board.gw || {}).deadline_utc, (state.board.gw || {}).id);
  renderGaps();
  renderMarkets();
  renderReceipts();
  updateLiveStatus(false);
  startPolling();
}

/* ---------- market row ---------- */

const isRough = (m) => !!m.fair && m.fair.confidence === 'low';
const showChip = (m) => m.fair && m.gap_pts !== null && (m.fair.confidence === 'high' || m.fair.confidence === 'medium') && Math.abs(m.gap_pts) >= CONFIG.minGapPts;

function closesText(exp) {
  if (!exp) return null;
  const diff = exp - Date.now();
  if (diff <= 0) return 'Closed';
  const mins = Math.floor(diff / 60000), hrs = Math.floor(diff / 3600000), days = Math.floor(diff / 86400000);
  if (days >= 45) return 'Closes ' + new Date(exp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (days >= 1) return `Closes ${days}d`;
  if (hrs >= 1) return `Closes ${hrs}h`;
  return `Closes ${Math.max(1, mins)}m`;
}

function liquidityText(v) {
  if (v === null) return null;
  if (v <= 0) return 'No liquidity';
  if (v < 1) return '<$1 liquidity';
  return '$' + Math.round(v).toLocaleString('en-US') + ' liquidity';
}

function paysText(p) {
  if (p === null || p <= 0 || p >= 1) return null;
  return `Pays ×${(1 / p).toFixed(2)} YES · ×${(1 / (1 - p)).toFixed(2)} NO`;
}

const levels = (m, side, kind) => ((((m.books || {})[side] || {})[kind]) || []);
const best = (m, side, kind) => {
  const ps = levels(m, side, kind).map((x) => num(x.price)).filter((x) => x !== null);
  return ps.length ? (kind === 'asks' ? Math.min(...ps) : Math.max(...ps)) : null;
};
const last = (m, side) => num((((m.books || {})[side] || {}).last));
function edgePick(m) {
  if (!m.fair) return null;
  const options = [{ side: 'yes', buy: best(m, 'yes', 'asks'), fair: m.fair.p },
    { side: 'no', buy: best(m, 'no', 'asks'), fair: 1 - m.fair.p }].filter((x) => x.buy !== null);
  if (!options.length) return null;
  return options.map((x) => ({ ...x, edge: x.fair - x.buy })).sort((a, b) => b.edge - a.edge)[0];
}

function stakePanel(m) {
  const pick = edgePick(m), panel = h('div', { class: 'calc' });
  let side = pick ? pick.side : 'yes';
  const amount = h('input', { type: 'number', min: '0', step: '1', value: '10', 'aria-label': 'Stake in dollars' });
  const yes = h('button', { type: 'button', class: 'toggle', text: 'YES' }), no = h('button', { type: 'button', class: 'toggle', text: 'NO' });
  const out = h('div', { class: 'calc-out' });
  const draw = () => {
    yes.classList.toggle('is-on', side === 'yes'); no.classList.toggle('is-on', side === 'no');
    const stake = Math.max(0, Number(amount.value) || 0);
    const r = calculateStake(stake, side, levels(m, side, 'asks'), m.taker_fee_bps / 10000, m.fair);
    const money = (x, plus) => `${plus && x >= 0 ? '+' : x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`;
    const rows = [`${r.shares.toFixed(2)} shares · average ${r.averagePrice === null ? '–' : pct(r.averagePrice)}`,
      `Fee $${r.fee.toFixed(2)} · total cost $${r.cost.toFixed(2)}`,
      `If it wins: $${r.payout.toFixed(2)} (profit ${money(r.profit, false)})`];
    if (m.fair) {
      rows.push(`Expected value at fair: ${money(r.ev, true)} (range ${money(r.evLow, true)} to ${money(r.evHigh, true)})`);
      rows.push(`ROI ${r.roi === null ? '–' : (r.roi * 100).toFixed(1) + '%'}`);
    } else rows.push('No fair price for this market');
    if (r.unfilled > 0.005) rows.push(`Only $${r.cost.toFixed(2)} can fill right now. The book is empty above ${r.topPrice === null ? '–' : pct(r.topPrice)}.`);
    out.replaceChildren(...rows.map((x) => h('p', { text: x })));
  };
  yes.addEventListener('click', () => { side = 'yes'; draw(); }); no.addEventListener('click', () => { side = 'no'; draw(); }); amount.addEventListener('input', draw);
  const chips = h('span', { class: 'stake-chips' }, [5, 10, 25, 50].map((x) => h('button', { type: 'button', text: `$${x}`, onclick: () => { amount.value = x; draw(); } })));
  panel.append(h('h4', { text: 'What would I win?' }), h('div', { class: 'calc-controls' }, amount, chips, yes, no), out);
  draw();
  return panel;
}

function gapText(m) { return `Fair price is ${Math.abs(m.gap_pts)} pts ${m.gap_pts > 0 ? 'higher' : 'lower'}`; }

function track(m) {
  const rail = h('div', { class: 'rail' });
  const xo = m.xo_price, fp = m.fair ? m.fair.p : null;
  if (xo !== null && fp !== null) {
    const a = Math.min(xo, fp), b = Math.max(xo, fp);
    rail.append(h('i', { class: 'seg' + (isRough(m) ? ' rough' : ''), style: `left:${a * 100}%;width:${(b - a) * 100}%` }));
  }
  if (xo !== null) rail.append(h('i', { class: 'dot', style: `left:${xo * 100}%` }));
  if (fp !== null) rail.append(h('i', { class: 'ring' + (isRough(m) ? ' rough' : ''), style: `left:${fp * 100}%` }));
  const label = `XO ${xo !== null ? pct(xo) : 'no trades yet'}, ${isRough(m) ? 'rough estimate' : 'fair'} ${fp !== null ? pct(fp) : 'not available yet'}${showChip(m) ? '. ' + gapText(m) : ''}`;
  return h('div', { class: 'track', role: 'img', 'aria-label': label }, rail);
}

function safeLink(url, text, cls) {
  const u = safeUrl(url);
  return u ? h('a', { href: u, target: '_blank', rel: 'noopener', class: cls || null, text }) : null;
}

function whyDetails(m, open) {
  const pays = paysText(m.xo_price);
  const body = h('div', { class: 'why-body' });
  let label;
  if (m.fair) {
    label = 'How we priced it';
    if (isRough(m)) body.append(h('p', { class: 'why-rough', text: 'Rough estimate: heavy assumptions, treat with care.' }));
    if (pays) body.append(h('p', { class: 'why-pays', text: pays }));
    if (m.fair.method_text) body.append(h('p', { class: 'why-text', text: m.fair.method_text }));
    if (m.fair.inputs.length) {
      body.append(h('ul', { class: 'inputs' }, m.fair.inputs.map((i) => h('li', null,
        h('span', { class: 'in-l', text: i.label || '' }),
        i.value !== undefined && i.value !== '' ? h('span', { class: 'in-v', text: ' ' + i.value }) : null,
        i.source_url ? safeLink(i.source_url, 'source', 'in-src') : null,
      ))));
    }
    const range = m.fair.low !== null && m.fair.high !== null ? ` · Range ${pct(m.fair.low)} to ${pct(m.fair.high)}` : '';
    body.append(h('p', { class: 'conf' }, h('i', { class: 'cdot c-' + m.fair.confidence }), `Confidence: ${m.fair.confidence}${range}`));
  } else {
    label = 'Why no fair price yet';
    if (pays) body.append(h('p', { class: 'why-pays', text: pays }));
    body.append(h('p', { class: 'why-text', text: m.fair_reason || 'No clean reference market exists for this question yet.' }));
  }
  const source = Array.isArray(m.resolution_sources) ? m.resolution_sources.find(safeUrl) : null;
  if (m.description || source) body.append(h('div', { class: 'resolution' },
    m.description ? h('h4', { text: 'How it resolves' }) : null,
    m.description ? h('p', { class: 'resolution-text', text: m.description }) : null,
    source ? safeLink(source, 'Resolution source', 'in-src') : null));
  body.append(stakePanel(m));
  return h('details', { class: 'why', open: open ? true : null }, h('summary', { text: label }), body);
}

function marketRow(m, extra, openWhy) {
  const hasFair = !!m.fair;
  const chipCls = 'chip' + (m.gap_pts > 0 ? ' up' : ' down');
  const gap = showChip(m) ? gapText(m) : null;
  const pays = m.fair && m.xo_price ? `XO pays ×${(1 / m.xo_price).toFixed(2)} · fair ×${(1 / m.fair.p).toFixed(2)}` : paysText(m.xo_price);
  const closes = closesText(m.exp), liq = liquidityText(m.liquidity_usd);

  const q = h('h3', { class: 'q' }, h('span', { class: 'qt', text: m.title }), m.is_ours ? h('span', { class: 'ours', text: 'ours' }) : null);
  const buy = best(m, 'yes', 'asks'), sell = best(m, 'yes', 'bids'), traded = last(m, 'yes');
  const edge = edgePick(m);
  const vals = h('div', { class: 'vals book-vals' },
    h('span', { class: 'v-xo', text: `Buy ${pct(buy)}` }), h('span', { text: `Sell ${pct(sell)}` }), h('span', { text: `Last ${pct(traded)}` }),
    gap ? h('span', { class: chipCls + ' chip-d', 'aria-hidden': 'true', text: gap }) : null,
    h('span', { class: 'v-fair' + (hasFair ? '' : ' none') + (isRough(m) ? ' rough' : ''), text: hasFair ? `${isRough(m) ? 'Rough' : 'Fair'} ${pct(m.fair.p)}` : 'Fair coming' }),
  );
  const info = h('div', { class: 'mi' },
    gap ? h('span', { class: chipCls + ' chip-m', 'aria-hidden': 'true', text: gap }) : null,
    closes ? h('span', { text: closes }) : null,
    liq ? h('span', { text: liq }) : null,
    edge ? h('span', { class: 'edge', text: edge.edge > 0 ? `Buy ${edge.side.toUpperCase()} at ${pct(edge.buy)} · fair ${pct(edge.fair)}` : 'No edge after the spread' }) : null);
  const act = h('div', { class: 'act' },
    h('button', { type: 'button', class: 'win', text: 'What would I win?', onclick: (e) => { const d = e.currentTarget.closest('.mrow').querySelector('.why'); d.open = true; d.scrollIntoView({ block: 'nearest' }); } }),
    h('a', { class: 'trade', href: tradeUrl(m), target: '_blank', rel: 'noopener', 'aria-label': 'Trade on XO' }, 'Trade on', wordmark('wm')),
    pays ? h('p', { class: 'pays-out', text: pays }) : null,
  );
  return h('article', { id: m.slug, class: 'mrow' + (extra ? ' ' + extra : '') + (m.is_ours ? ' is-ours' : '') },
    q, h('div', { class: 'cmp' }, track(m), vals), act, h('div', { class: 'meta' }, info, whyDetails(m, openWhy)));
}

/* ---------- Biggest gaps ---------- */

function renderGaps() {
  const sec = document.getElementById('gaps');
  const list = state.markets.filter((m) => m.fair && ['high', 'medium'].includes(m.fair.confidence)).map((m) => {
    const choices = ['yes', 'no'].map((side) => ({ side, r: calculateStake(10, side, levels(m, side, 'asks'), m.taker_fee_bps / 10000, m.fair) }));
    return { m, ...choices.sort((a, b) => (b.r.ev || -Infinity) - (a.r.ev || -Infinity))[0] };
  }).filter((x) => x.r.ev > 0).sort((a, b) => b.r.ev - a.r.ev).slice(0, 5);
  sec.hidden = false;
  const el = document.getElementById('gaps-list');
  if (!list.length) { el.replaceChildren(h('p', { class: 'empty', text: 'No positive-value trades right now' })); return; }
  el.replaceChildren(...list.map(({ m, side, r }) => h('article', { class: 'value-row' },
    h('a', { href: `#${m.slug}`, text: m.title }),
    h('b', { text: side.toUpperCase() }),
    h('span', { text: `buy ${pct(r.averagePrice)} · fair ${pct(side === 'yes' ? m.fair.p : 1 - m.fair.p)}` }),
    h('span', { text: `EV ${r.ev >= 0 ? '+' : ''}$${r.ev.toFixed(2)} (${r.evLow >= 0 ? '+' : ''}$${r.evLow.toFixed(2)} to ${r.evHigh >= 0 ? '+' : ''}$${r.evHigh.toFixed(2)}) · fills $${r.cost.toFixed(2)}` }))));
}

/* ---------- All markets ---------- */

const kickoffFmt = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${t}`;
};

const rank = (m) => (m.is_ours ? 0 : 2) + (m.fair ? 0 : 1);
const byOursPriced = (a, b) => rank(a) - rank(b);

function groupHead(left, meta) {
  return h('div', { class: 'ghead' }, left, h('div', { class: 'gmeta', text: meta }));
}

function renderMarkets() {
  const root = document.getElementById('mk-list');
  const all = state.markets.filter((m) => !state.query || `${m.title} ${m.fixture ? `${m.fixture.home_name} ${m.fixture.away_name}` : ''}`.toLowerCase().includes(state.query));
  document.getElementById('mk-count').textContent = `${all.length} live market${all.length === 1 ? '' : 's'} on XO`;
  if (!all.length) { root.replaceChildren(h('p', { class: 'empty', text: 'No markets match' })); return; }
  const frag = document.createDocumentFragment();
  const addGroup = (head, rows, after) => {
    frag.append(h('section', { class: 'group' }, head, rows.length ? h('div', { class: 'list' }, rows.map((m) => marketRow(m))) : null, after || null));
  };
  const plural = (n) => `${n} market${n === 1 ? '' : 's'}`;

  if (state.sort === 'closing') {
    const now = new Date();
    const sorted = [...all].sort((a, b) => (a.exp ?? Infinity) - (b.exp ?? Infinity));
    const groups = new Map();
    sorted.forEach((m) => {
      let key = 'Later', label = 'Close date unknown';
      if (m.exp) {
        const d = new Date(m.exp);
        const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
        if (days <= 0) { key = 'today'; label = 'Closing today'; }
        else if (days === 1) { key = 'tomorrow'; label = 'Closing tomorrow'; }
        else if (days < 7) { key = d.toDateString(); label = 'Closing ' + d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }); }
        else { key = d.getFullYear() + '-' + d.getMonth(); label = 'Closing ' + d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
      }
      if (!groups.has(key)) groups.set(key, { label, rows: [] });
      groups.get(key).rows.push(m);
    });
    groups.forEach((g) => addGroup(groupHead(h('div', { class: 'gname', text: g.label }), plural(g.rows.length)), g.rows));
    root.replaceChildren(frag);
    return;
  }

  const fixtures = new Map(), weekend = [], long = [];
  all.forEach((m) => {
    if (m.fixture && m.group !== 'season') {
      const k = `${m.fixture.home}|${m.fixture.away}|${m.fixture.kickoff_utc}`;
      if (!fixtures.has(k)) fixtures.set(k, { f: m.fixture, rows: [] });
      fixtures.get(k).rows.push(m);
    } else if (m.horizon === 'weekend') weekend.push(m);
    else long.push(m);
  });
  [...fixtures.values()].sort((a, b) => new Date(a.f.kickoff_utc) - new Date(b.f.kickoff_utc)).forEach(({ f, rows }) => {
    rows.sort(byOursPriced);
    const left = h('div', { class: 'gmatch' }, crest(f.home, 24), h('span', { class: 'gname', text: `${f.home_name || teamName(f.home)} v ${f.away_name || teamName(f.away)}` }), crest(f.away, 24));
    const isLive = state.live.has(`${f.home}-${f.away}`);
    const et = elevenText(f.home, f.away);
    const head = groupHead(isLive ? h('div', { class: 'gmatch' }, left, h('span', { class: 'live' }, 'Live')) : left, `${f.kickoff_utc ? kickoffFmt(f.kickoff_utc) + ' · ' : ''}${plural(rows.length)}`);
    if (isLive) head.append(h('p', { class: 'gnote', text: 'Prices update every 20 minutes during matches.' }));
    if (et) head.append(h('p', { class: 'gnote', text: et }));
    addGroup(head, rows);
  });
  if (weekend.length) { weekend.sort(byOursPriced); addGroup(groupHead(h('div', { class: 'gname', text: 'Across the weekend' }), plural(weekend.length)), weekend); }
  if (long.length) {
    const priced = long.filter((m) => m.fair).sort((a, b) => Math.abs(b.gap_pts ?? 0) - Math.abs(a.gap_pts ?? 0));
    const unpriced = long.filter((m) => !m.fair);
    const box = unpriced.length ? h('details', { class: 'unpriced' },
      h('summary', { text: `${unpriced.length} market${unpriced.length === 1 ? '' : 's'} we can't price yet (and why)` }),
      h('div', { class: 'list' }, unpriced.map((m) => marketRow(m, '', true)))) : null;
    addGroup(groupHead(h('div', { class: 'gname', text: 'Longer range' }), plural(long.length)), priced, box);
  }
  root.replaceChildren(frag);
}

/* ---------- live XO ---------- */

let liveAt = null, liveTimer = null, boardTimer = null;
function updateLiveStatus(live) {
  const el = document.getElementById('live-status');
  if (!el) return;
  if (live && liveAt) el.textContent = `Live · updated ${Math.max(0, Math.floor((Date.now() - liveAt) / 1000))}s ago`;
  else {
    const d = new Date((state.board && state.board.generated_at) || Date.now());
    el.textContent = `XO prices from ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}

function liveBook(raw, token) {
  const b = (raw.books || []).find((x) => String(x.assetId) === String(token)) || {};
  return { bids: b.bids || [], asks: b.asks || [], last: num(b.lastTradePrice) };
}

async function fetchXO() {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const payload = await getJSON(`https://api-mainnet.xo.market/api/convictions?take=50&page=${page}`);
    rows.push(...(payload.data || []));
    if (!(payload.meta || {}).hasNextPage) break;
  }
  rows.forEach((raw) => {
    const m = state.bySlug[raw.slug];
    if (!m) return;
    const outcomes = (raw.market || {}).outcomes || [];
    const yes = outcomes.find((x) => String(x.title).toLowerCase() === 'yes') || outcomes[0] || {};
    const no = outcomes.find((x) => String(x.title).toLowerCase() === 'no') || outcomes[1] || {};
    m.books = { yes: liveBook(raw, yes.outcomeTokenId), no: liveBook(raw, no.outcomeTokenId) };
    const cp = num(yes.currentPrice);
    m.xo_price = cp !== null ? (cp > 1 ? cp / 1e6 : cp) : m.books.yes.last;
    m.best_bid = best(m, 'yes', 'bids'); m.best_ask = best(m, 'yes', 'asks');
    m.liquidity_usd = (raw.books || []).reduce((s, x) => s + (num(x.totalLiquidity) || 0), 0);
  });
  liveAt = Date.now(); updateLiveStatus(true); renderGaps(); renderMarkets();
}

async function refreshFair() {
  const board = await getJSON(`data/board.json?v=${Date.now()}`);
  (board.markets || []).forEach((raw) => {
    const m = state.bySlug[raw.slug];
    if (!m) return;
    const clean = cleanMarket(raw);
    m.fair = clean.fair; m.fair_reason = clean.fair_reason; m.gap_pts = clean.gap_pts;
    m.description = clean.description; m.resolution_sources = clean.resolution_sources;
  });
  state.board.generated_at = board.generated_at; renderGaps(); renderMarkets();
}

function startPolling() {
  const poll = () => { if (!document.hidden) fetchXO().catch(() => updateLiveStatus(false)); };
  fetchXO().catch(() => updateLiveStatus(false));
  liveTimer = setInterval(poll, 30000);
  boardTimer = setInterval(() => { if (!document.hidden) refreshFair().catch(() => {}); }, 300000);
  setInterval(() => { if (liveAt) updateLiveStatus(true); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}

/* ---------- Receipts ---------- */

function renderReceipts() {
  const sec = document.getElementById('receipts');
  const rows = (state.board.receipts || []).filter((r) => r && (r.outcome === 'YES' || r.outcome === 'NO') && num(r.xo_close) !== null);
  sec.hidden = !rows.length;
  if (!rows.length) return;
  const slot = document.getElementById('rc-deek-slot');
  if (slot) slot.replaceWith(h('img', { class: 'rc-deek', src: 'assets/deek/deek-receipts.webp', width: 60, height: 80, alt: '', decoding: 'async' }));

  const sum = state.board.receipt_summary;
  const sumEl = document.getElementById('rc-sum');
  const parts = [];
  if (sum && num(sum.compared) > 0) {
    parts.push(h('p', { class: 'rc-line', text: `Fair price was closer on ${sum.fair_closer} of ${sum.compared} resolved markets` }));
    if (num(sum.brier_fair) !== null && num(sum.brier_xo) !== null) {
      parts.push(h('details', { class: 'brier' },
        h('summary', { text: 'Brier score' }),
        h('p', { text: `Brier score: fair ${Number(sum.brier_fair).toFixed(3)} vs XO ${Number(sum.brier_xo).toFixed(3)} (lower is better)` }),
        h('p', { class: 'brier-note', text: 'The average squared gap between a price and what happened. 0 is perfect.' })));
    }
  }
  sumEl.replaceChildren(...parts);

  document.getElementById('rc-list').replaceChildren(...rows.map((r) => {
    const y = r.outcome === 'YES' ? 1 : 0;
    const xo = num(r.xo_close), fair = num(r.fair_close);
    let closer = null;
    if (fair !== null) closer = Math.abs(y - fair) < Math.abs(y - xo) ? 'fair' : Math.abs(y - xo) < Math.abs(y - fair) ? 'xo' : null;
    const tick = h('i', { class: 'tick', title: 'Closer to the result', role: 'img', 'aria-label': 'closer to the result' });
    return h('article', { class: 'rcard' },
      h('div', { class: 'rc-main' },
        h('h3', { class: 'q', text: r.title }),
        h('div', { class: 'rc-nums' },
          h('span', { class: 'v-xo' }, `XO said ${pct(xo)}`, closer === 'xo' ? tick.cloneNode() : null),
          h('span', { class: 'v-fair' + (fair === null ? ' none' : '') }, fair !== null ? `${r.confidence === 'low' ? 'Rough' : 'Fair'} said ${pct(fair)}` : 'No fair price', closer === 'fair' ? tick.cloneNode() : null))),
      h('span', { class: 'outcome ' + r.outcome.toLowerCase(), text: r.outcome }));
  }));
}

init();
