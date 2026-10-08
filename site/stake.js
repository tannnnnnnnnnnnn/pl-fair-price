/* Shared order-book stake maths for the calculator and Best value. */

function calculateStake(stake, side, asks, feeBase, fair) {
  const target = Math.max(0, Number(stake) || 0);
  let remaining = target, shares = 0, fillCost = 0, fee = 0, top = null;
  const levels = (Array.isArray(asks) ? asks : []).map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => x.price > 0 && x.price < 1 && x.size > 0).sort((a, b) => a.price - b.price);
  levels.forEach((level) => {
    if (remaining <= 1e-9) return;
    const unitFee = Number(feeBase || 0) * level.price * (1 - level.price);
    const bought = Math.min(level.size, remaining / (level.price + unitFee));
    shares += bought;
    fillCost += bought * level.price;
    fee += bought * unitFee;
    remaining -= bought * (level.price + unitFee);
    if (bought > 0) top = level.price;
  });
  const cost = fillCost + fee;
  const result = {
    shares, averagePrice: shares ? fillCost / shares : null, fee, cost, payout: shares,
    profit: shares - cost, unfilled: Math.max(0, target - cost), topPrice: top,
    ev: null, evLow: null, evHigh: null, roi: null,
  };
  if (fair && Number.isFinite(Number(fair.p))) {
    let point = Number(fair.p), low = Number(fair.low), high = Number(fair.high);
    if (side === 'no') [point, low, high] = [1 - point, 1 - high, 1 - low];
    result.ev = shares * point - cost;
    result.evLow = shares * low - cost;
    result.evHigh = shares * high - cost;
    result.roi = cost ? result.ev / cost : null;
  }
  return result;
}

if (typeof module !== 'undefined') module.exports = { calculateStake };
