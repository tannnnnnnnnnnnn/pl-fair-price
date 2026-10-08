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

  document.getElementById('sample').hidden = !state.mock;
  setGwLabels();
  startCountdown(document.getElementById('dl-label'), document.getElementById('dl-boxes'), document.getElementById('deadline'), (state.board.gw || {}).deadline_utc, (state.board.gw || {}).id);
  renderGaps();
  renderMarkets();
  renderReceipts();
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
  return h('details', { class: 'why', open: open ? true : null }, h('summary', { text: label }), body);
}

function marketRow(m, extra, openWhy) {
  const hasFair = !!m.fair;
  const chipCls = 'chip' + (m.gap_pts > 0 ? ' up' : ' down');
  const gap = showChip(m) ? gapText(m) : null;
  const pays = paysText(m.xo_price);
  const closes = closesText(m.exp), liq = liquidityText(m.liquidity_usd);

  const q = h('h3', { class: 'q' }, h('span', { class: 'qt', text: m.title }), m.is_ours ? h('span', { class: 'ours', text: 'ours' }) : null);
  const vals = h('div', { class: 'vals' },
    h('span', { class: 'v-xo' + (m.xo_price === null ? ' none' : ''), text: m.xo_price !== null ? `XO ${pct(m.xo_price)}` : 'No trades yet' }),
    gap ? h('span', { class: chipCls + ' chip-d', 'aria-hidden': 'true', text: gap }) : null,
    h('span', { class: 'v-fair' + (hasFair ? '' : ' none') + (isRough(m) ? ' rough' : ''), text: hasFair ? `${isRough(m) ? 'Rough' : 'Fair'} ${pct(m.fair.p)}` : 'Fair coming' }),
  );
  const info = h('div', { class: 'mi' },
    gap ? h('span', { class: chipCls + ' chip-m', 'aria-hidden': 'true', text: gap }) : null,
    closes ? h('span', { text: closes }) : null,
    liq ? h('span', { text: liq }) : null);
  const act = h('div', { class: 'act' },
    h('a', { class: 'trade', href: tradeUrl(m), target: '_blank', rel: 'noopener', 'aria-label': 'Trade on XO' }, 'Trade on', wordmark('wm')),
    pays ? h('p', { class: 'pays-out', text: pays }) : null,
  );
  return h('article', { class: 'mrow' + (extra ? ' ' + extra : '') + (m.is_ours ? ' is-ours' : '') },
    q, h('div', { class: 'cmp' }, track(m), vals), act, h('div', { class: 'meta' }, info, whyDetails(m, openWhy)));
}

/* ---------- Biggest gaps ---------- */

function renderGaps() {
  const sec = document.getElementById('gaps');
  const noTrades = (m) => !m.volume_usd && m.best_bid === null && m.best_ask === null;
  const list = state.markets.filter((m) => showChip(m) && !noTrades(m)).sort((a, b) => Math.abs(b.gap_pts) - Math.abs(a.gap_pts)).slice(0, 5);
  sec.hidden = !list.length;
  const el = document.getElementById('gaps-list');
  el.replaceChildren(...list.map((m) => marketRow(m, 'is-gap')));
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
  const all = state.markets;
  document.getElementById('mk-count').textContent = `${all.length} live market${all.length === 1 ? '' : 's'} on XO`;
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
