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
  renderMyMarkets();
  renderMarkets();
  renderReceipts();
  updateLiveStatus(false);
  startPolling();
}

/* ---------- market row ---------- */

const isRough = (m) => !!m.fair && m.fair.confidence === 'low';

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

function volumeText(v) {
  if (v === null) return 'Volume unavailable';
  return `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} traded`;
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

function valuePick(m, stake) {
  if (!m.fair) return null;
  return ['yes', 'no'].map((side) => ({ side, r: calculateStake(stake || 10, side, levels(m, side, 'asks'), m.taker_fee_bps / 10000, m.fair) }))
    .filter((x) => x.r.ev !== null).sort((a, b) => b.r.ev - a.r.ev)[0] || null;
}

function money(x, plus) {
  if (x === null || !Number.isFinite(Number(x))) return '–';
  return `${plus && x >= 0 ? '+' : x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`;
}

function verdict(m) {
  if (!m.fair || m.fair.p == null || !Number.isFinite(Number(m.fair.p))) return h('span', { class: 'verdict neutral', text: 'No price from us yet' });
  const pick = valuePick(m, 10);
  const good = pick && pick.r.ev > 0.005;
  return h('span', { class: 'verdict ' + (good ? 'good' : 'neutral'), text: good ? `Good value on ${pick.side.toUpperCase()}` : 'No value right now' });
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
    const main = h('p', { class: 'calc-win', text: `If it wins: you get $${r.payout.toFixed(2)} (profit ${money(r.profit, false)})` });
    const worth = m.fair ? h('p', { class: 'calc-worth ' + (r.ev >= 0 ? 'positive' : 'negative') }, 'Worth it? ', explain('Expected value', 'ev'), ` ${money(r.ev, true)}`)
      : h('p', { class: 'calc-worth neutral', text: "We can't price this market yet" });
    const maths = h('div', { class: 'calc-maths-body' },
      h('p', { text: `${r.shares.toFixed(2)} shares · average price ${r.averagePrice === null ? '–' : pct(r.averagePrice)}` }),
      h('p', null, explain('Fee', 'fee'), ` $${r.fee.toFixed(2)} · total cost $${r.cost.toFixed(2)}`),
      m.fair ? h('p', { text: `Likely value range ${money(r.evLow, true)} to ${money(r.evHigh, true)} · ROI ${r.roi === null ? '–' : (r.roi * 100).toFixed(1) + '%'}` }) : null,
      r.unfilled > 0.005 ? h('p', { class: 'fill-note', text: `Only $${r.cost.toFixed(2)} can fill now; the book is empty above ${r.topPrice === null ? '–' : pct(r.topPrice)}.` }) : null);
    out.replaceChildren(main, worth, h('details', { class: 'calc-maths' }, h('summary', { text: 'Show the maths' }), maths));
  };
  yes.addEventListener('click', () => { side = 'yes'; draw(); }); no.addEventListener('click', () => { side = 'no'; draw(); }); amount.addEventListener('input', draw);
  const chips = h('span', { class: 'stake-chips' }, [5, 10, 25, 50].map((x) => h('button', { type: 'button', text: `$${x}`, onclick: () => { amount.value = x; draw(); } })));
  panel.append(h('h4', { text: 'What would I win?' }), h('div', { class: 'calc-controls' }, amount, chips, yes, no), out);
  draw();
  return panel;
}

function safeLink(url, text, cls) {
  const u = safeUrl(url);
  return u ? h('a', { href: u, target: '_blank', rel: 'noopener', class: cls || null, text }) : null;
}

function marketLink(m, cls) {
  return h('a', { href: tradeUrl(m), target: '_blank', rel: 'noopener', class: cls || null, text: m.title });
}

function pricePair(m) {
  return h('div', { class: 'price-pair' },
    h('span', { class: 'price xo-price' }, h('i', { text: 'XO price' }), h('b', { text: pct(m.xo_price) })),
    h('span', { class: 'price our-price' }, h('i', { text: 'Our price' }), h('b', { text: m.fair ? pct(m.fair.p) : '–' })));
}

function whyDetails(m, open) {
  const pays = paysText(m.xo_price);
  const body = h('div', { class: 'why-body' });
  const buy = best(m, 'yes', 'asks'), sell = best(m, 'yes', 'bids'), traded = last(m, 'yes');
  body.append(h('div', { class: 'detail-stats' },
    h('p', null, explain('Buy', 'buy_sell_last'), h('b', { text: pct(buy) })),
    h('p', null, explain('Sell', 'buy_sell_last'), h('b', { text: pct(sell) })),
    h('p', null, explain('Last price', 'buy_sell_last'), h('b', { text: pct(traded) })),
    h('p', null, explain('Liquidity', 'liquidity'), h('b', { text: liquidityText(m.liquidity_usd) || '–' })),
    pays ? h('p', { class: 'detail-wide' }, h('span', { text: pays })) : null));
  const worked = h('details', { class: 'worked' }, h('summary', { text: 'How we worked this out' }));
  worked.append(researchBody(m));
  body.append(worked);
  body.append(stakePanel(m));
  return h('details', { class: 'why market-details', open: open ? true : null }, h('summary', { text: 'Details' }), body);
}

/* How our price was built: method, inputs, sources and resolution rules. */
function researchBody(m) {
  const workedBody = h('div', { class: 'worked-body' });
  if (m.fair) {
    if (isRough(m)) workedBody.append(h('p', { class: 'why-rough' }, explain('Rough', 'rough'), ': bigger assumptions, so treat this price with care.'));
    workedBody.append(h('p', null, explain('Fair price', 'fair_price'), ` range ${pct(m.fair.low)} to ${pct(m.fair.high)}`));
    workedBody.append(h('p', null, explain('Confidence', 'confidence'), `: ${m.fair.confidence}`));
    if (m.fair.method_text) workedBody.append(h('p', { class: 'why-text', text: m.fair.method_text }));
    if (m.fair.inputs.length) {
      workedBody.append(h('ul', { class: 'inputs' }, m.fair.inputs.map((i) => h('li', null,
        h('span', { class: 'in-l', text: i.label || '' }),
        i.value !== undefined && i.value !== '' ? h('span', { class: 'in-v', text: ' ' + i.value }) : null,
        i.source_url ? safeLink(i.source_url, 'source', 'in-src') : null,
      ))));
    }
  } else {
    workedBody.append(h('p', { class: 'why-text', text: m.fair_reason || 'No clean reference market exists for this question yet.' }));
  }
  const source = Array.isArray(m.resolution_sources) ? m.resolution_sources.find(safeUrl) : null;
  if (m.description || source) workedBody.append(h('div', { class: 'resolution' },
    m.description ? h('h4', { text: 'How it resolves' }) : null,
    m.description ? h('p', { class: 'resolution-text', text: m.description }) : null,
    source ? safeLink(source, 'Resolution source', 'in-src') : null));
  return workedBody;
}

function marketRow(m, extra, openWhy) {
  const closes = closesText(m.exp);
  const q = h('h3', { class: 'q' }, marketLink(m, 'market-title'), m.is_ours ? h('span', { class: 'ours', text: 'ours' }) : null,
    isRough(m) ? h('span', { class: 'rough-tag' }, explain('Rough', 'rough')) : null);
  const act = h('div', { class: 'act' },
    h('button', { type: 'button', class: 'win', text: 'What would I win?', onclick: (e) => { const d = e.currentTarget.closest('.mrow').querySelector('.market-details'); d.open = true; d.scrollIntoView({ block: 'nearest' }); } }),
    h('a', { class: 'trade', href: tradeUrl(m), target: '_blank', rel: 'noopener', 'aria-label': 'Trade on XO' }, 'Trade on', wordmark('wm')),
  );
  return h('article', { id: m.slug, class: 'mrow' + (extra ? ' ' + extra : '') + (m.is_ours ? ' is-ours' : '') },
    q, closes ? h('p', { class: 'closes', text: closes }) : null, pricePair(m), verdict(m), act, whyDetails(m, openWhy));
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
    marketLink(m),
    h('b', { text: side.toUpperCase() }),
    h('span', { text: `You'd buy at ${pct(r.averagePrice)} · our price ${pct(side === 'yes' ? m.fair.p : 1 - m.fair.p)}` }),
    h('span', null, explain('Expected value', 'ev'), ` ${money(r.ev, true)} per $10`),
    h('details', { class: 'worked research' }, h('summary', { text: 'Show the research' }),
      h('p', { class: 'why-text', text: `$10 on ${side.toUpperCase()} buys ${r.shares.toFixed(2)} shares at an average ${pct(r.averagePrice)}, plus a ${money(r.fee)} fee. If it wins you get ${money(r.payout)}. Expected value ranges from ${money(r.evLow, true)} to ${money(r.evHigh, true)} across our price range.` }),
      researchBody(m)))));
}

/* ---------- My markets ---------- */

function renderMyMarkets() {
  const root = document.getElementById('my-list');
  const rows = state.markets.filter((m) => m.is_ours);
  const wasOpen = new Set([...root.querySelectorAll('.my-card[open]')].map((x) => x.dataset.slug));
  if (!rows.length) { root.replaceChildren(h('p', { class: 'empty', text: 'No CryptoTan01 markets are live right now.' })); return; }
  root.replaceChildren(...rows.map((m) => {
    const poster = typeof POSTERS !== 'undefined' ? POSTERS[m.slug] : null;
    const card = h('details', { class: 'my-card', 'data-slug': m.slug, open: wasOpen.has(m.slug) ? true : null },
      h('summary', null,
        h('span', { class: 'my-summary-main' }, marketLink(m, 'market-title'), h('span', { class: 'my-meta', text: [closesText(m.exp), volumeText(m.volume_usd)].filter(Boolean).join(' · ') })),
        h('span', { class: 'my-summary-price' }, h('b', { text: `XO ${pct(m.xo_price)} · Ours ${m.fair ? pct(m.fair.p) : '–'}` }), verdict(m))),
      h('div', { class: 'my-body' },
        m.pitch ? h('div', { class: 'my-call' }, h('h3', { text: 'My call when I made it' }), h('p', { text: m.pitch })) : null,
        pricePair(m),
        h('div', { class: 'my-actions' }, h('a', { class: 'trade', href: tradeUrl(m), target: '_blank', rel: 'noopener' }, 'Trade on', wordmark('wm'))),
        stakePanel(m),
        poster ? h('img', { class: 'market-poster', src: poster, alt: `Poster for ${m.title}`, width: 1080, height: 1350, loading: 'lazy', decoding: 'async' }) : null));
    return card;
  }));
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
  return h('summary', { class: 'ghead' }, left, h('span', { class: 'gmeta', text: meta }));
}

function groupBest(rows) {
  const picks = rows.filter((m) => m.fair && ['high', 'medium'].includes(m.fair.confidence)).map((m) => valuePick(m, 10)).filter((x) => x && x.r.ev > 0);
  if (!picks.length) return null;
  const pick = picks.sort((a, b) => b.r.ev - a.r.ev)[0];
  return `Best: ${pick.side.toUpperCase()} ${money(pick.r.ev, true)} per $10`;
}

function renderMarkets() {
  const root = document.getElementById('mk-list');
  const all = state.markets.filter((m) => !state.query || `${m.title} ${m.fixture ? `${m.fixture.home_name} ${m.fixture.away_name}` : ''}`.toLowerCase().includes(state.query));
  document.getElementById('mk-count').textContent = `${all.length} live market${all.length === 1 ? '' : 's'} on XO`;
  if (!all.length) { root.replaceChildren(h('p', { class: 'empty', text: 'No markets match' })); return; }
  const frag = document.createDocumentFragment();
  const addGroup = (left, meta, rows, note) => {
    const bestText = groupBest(rows);
    const head = groupHead(left, [meta, bestText].filter(Boolean).join(' · '));
    frag.append(h('details', { class: 'group', open: state.query ? true : null }, head, note || null,
      rows.length ? h('div', { class: 'list' }, rows.map((m) => marketRow(m))) : null));
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
    groups.forEach((g) => addGroup(h('span', { class: 'gname', text: g.label }), plural(g.rows.length), g.rows));
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
    const left = h('span', { class: 'gmatch' }, crest(f.home, 24), h('span', { class: 'gname', text: `${f.home_name || teamName(f.home)} v ${f.away_name || teamName(f.away)}` }), crest(f.away, 24));
    const isLive = state.live.has(`${f.home}-${f.away}`);
    const et = elevenText(f.home, f.away);
    const note = h('div', { class: 'group-notes' },
      isLive ? h('p', { class: 'gnote', text: 'Prices update every 20 minutes during matches.' }) : null,
      elevenLine(et));
    addGroup(isLive ? h('span', { class: 'gmatch' }, left, h('span', { class: 'live' }, 'Live')) : left,
      `${f.kickoff_utc ? kickoffFmt(f.kickoff_utc) + ' · ' : ''}${plural(rows.length)}`, rows, note);
  });
  if (weekend.length) { weekend.sort(byOursPriced); addGroup(h('span', { class: 'gname', text: 'Across the weekend' }), plural(weekend.length), weekend); }
  if (long.length) {
    long.sort(byOursPriced);
    addGroup(h('span', { class: 'gname', text: 'Longer range' }), plural(long.length), long);
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
  const url = (page) => `https://api-mainnet.xo.market/api/convictions?take=50&page=${page}`;
  const first = await getJSON(url(1));
  const pages = Math.min(((first.meta || {}).pageCount) || 1, 10);
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => getJSON(url(i + 2))));
  const rows = [first, ...rest].flatMap((payload) => payload.data || []);
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
    m.pitch = raw.description || m.pitch;
  });
  liveAt = Date.now(); updateLiveStatus(true); renderGaps(); renderMyMarkets(); renderMarkets();
}

async function refreshFair() {
  const board = await getJSON(`data/board.json?v=${Date.now()}`);
  (board.markets || []).forEach((raw) => {
    const m = state.bySlug[raw.slug];
    if (!m) return;
    const clean = cleanMarket(raw);
    m.fair = clean.fair; m.fair_reason = clean.fair_reason; m.gap_pts = clean.gap_pts;
    m.description = clean.description; m.resolution_sources = clean.resolution_sources; m.pitch = clean.pitch;
  });
  state.board.generated_at = board.generated_at; renderGaps(); renderMyMarkets(); renderMarkets();
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
    parts.push(h('p', { class: 'rc-line', text: `Our price was closer on ${sum.fair_closer} of ${sum.compared} resolved markets` }));
    if (num(sum.brier_fair) !== null && num(sum.brier_xo) !== null) {
      parts.push(h('details', { class: 'brier' },
        h('summary', { text: 'Brier score' }),
        h('p', { text: `Brier score: ours ${Number(sum.brier_fair).toFixed(3)} vs XO ${Number(sum.brier_xo).toFixed(3)} (lower is better)` }),
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
        h('h3', { class: 'q' }, marketLink(r, 'market-title')),
        h('div', { class: 'rc-nums' },
          h('span', { class: 'v-xo' }, `XO said ${pct(xo)}`, closer === 'xo' ? tick.cloneNode() : null),
          h('span', { class: 'v-fair' + (fair === null ? ' none' : '') }, fair !== null ? `${r.confidence === 'low' ? 'Our rough price' : 'Our price'} said ${pct(fair)}` : 'No price from us', closer === 'fair' ? tick.cloneNode() : null))),
      h('span', { class: 'outcome ' + r.outcome.toLowerCase(), text: r.outcome }));
  }));
}

init();
