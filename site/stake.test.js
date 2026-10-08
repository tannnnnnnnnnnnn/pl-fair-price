const assert = require('node:assert/strict');
const { calculateStake } = require('./stake.js');

const got = calculateStake(10, 'yes', [{ price: 0.25, size: 20 }], 0.04, { p: 0.20, low: 0.20, high: 0.20 });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
close(got.shares, 20);
close(got.averagePrice, 0.25);
close(got.fee, 0.15);
close(got.cost, 5.15);
close(got.payout, 20);
close(got.profit, 14.85);
close(got.unfilled, 4.85);
close(got.ev, -1.15);
console.log('stake maths: ok');
