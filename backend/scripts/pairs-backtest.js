/**
 * ETH/BTC ratio pairs trade — market-neutral statistical arbitrage.
 *
 * Idea: ratio R = ETH/BTC tends to mean-revert. Measure how stretched it is with a
 * z-score over a rolling window. When R is unusually HIGH (z > +entry) ETH is rich vs
 * BTC -> SHORT the spread (short ETH / long BTC). When R is unusually LOW (z < -entry)
 * -> LONG the spread (long ETH / short BTC). Exit when z reverts toward the mean.
 *
 * Dollar-neutral: equal $ notional per leg. P&L = relative move of the two legs.
 * Fees: 4 events per round trip (open+close on BOTH legs) — modeled honestly.
 *
 *   node scripts/pairs-backtest.js
 */

const axios = require('axios');
const { mapInterval } = require('../binance');

const DAYS = parseInt(process.env.DAYS || '1095', 10);   // 3yr default
const TFS = (process.env.TFS || '240,D').split(',');
const NOTIONAL = 1000;        // $ per leg
const FEE = parseFloat(process.env.FEE || '0.0004'); // taker per side per leg
const A = process.env.A || 'ETHUSDT';
const B = process.env.B || 'BTCUSDT';
const INTERVAL_MS = { '60': 3_600_000, '240': 14_400_000, 'D': 86_400_000 };

async function fetchHistory(symbol, tf) {
  const interval = mapInterval(tf), stepMs = INTERVAL_MS[tf], now = Date.now();
  const startMs = now - DAYS * 86_400_000, out = [];
  let cursor = startMs;
  while (cursor < now) {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval, startTime: cursor, endTime: now, limit: 1500 },
    });
    const batch = res.data || [];
    if (!batch.length) break;
    out.push(...batch);
    const last = parseInt(batch[batch.length - 1][0], 10);
    if (batch.length < 1500 || last + stepMs >= now) break;
    cursor = last + stepMs;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c[0]) ? false : seen.add(c[0]))).sort((a, b) => a[0] - b[0]);
}

// Align two candle series on shared timestamps -> [{ts, a, b}]
function align(aC, bC) {
  const bMap = new Map(bC.map((c) => [c[0], parseFloat(c[4])]));
  const out = [];
  for (const c of aC) {
    const bClose = bMap.get(c[0]);
    if (bClose != null) out.push({ ts: parseInt(c[0], 10), a: parseFloat(c[4]), b: bClose });
  }
  return out;
}

function simulate(series, { lookback, entryZ, exitZ }) {
  let bal = NOTIONAL, peak = NOTIONAL, maxDD = 0, gw = 0, gl = 0, wins = 0, n = 0;
  let curLoss = 0, maxLoss = 0;
  let pos = null;
  const equity = [];

  for (let i = lookback; i < series.length; i++) {
    const R = series[i].a / series[i].b;
    // rolling stats over previous `lookback` ratios
    let sum = 0, sum2 = 0;
    for (let k = i - lookback; k < i; k++) { const r = series[k].a / series[k].b; sum += r; sum2 += r * r; }
    const mean = sum / lookback;
    const variance = Math.max(1e-12, sum2 / lookback - mean * mean);
    const std = Math.sqrt(variance);
    const z = (R - mean) / std;

    if (pos) {
      // exit when reverted toward mean
      const revert = (pos.dir === 'LONG' && z >= -exitZ) || (pos.dir === 'SHORT' && z <= exitZ);
      if (revert) {
        const aRet = series[i].a / pos.aEntry - 1;
        const bRet = series[i].b / pos.bEntry - 1;
        const spread = pos.dir === 'LONG' ? (aRet - bRet) : (bRet - aRet);
        const gross = spread * NOTIONAL;
        const fees = 4 * NOTIONAL * FEE; // open+close on both legs
        const net = gross - fees;
        bal += net; n++;
        if (net >= 0) { wins++; gw += net; curLoss = 0; } else { gl += -net; curLoss++; if (curLoss > maxLoss) maxLoss = curLoss; }
        if (bal > peak) peak = bal;
        const dd = (peak - bal) / peak * 100; if (dd > maxDD) maxDD = dd;
        pos = null;
      }
    }
    if (!pos) {
      if (z > entryZ) pos = { dir: 'SHORT', aEntry: series[i].a, bEntry: series[i].b }; // ratio high -> short spread
      else if (z < -entryZ) pos = { dir: 'LONG', aEntry: series[i].a, bEntry: series[i].b }; // ratio low -> long spread
    }
    equity.push({ ts: series[i].ts, balance: bal });
  }
  return {
    trades: n, winRate: n ? wins / n * 100 : 0,
    ret: (bal - NOTIONAL) / NOTIONAL * 100,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    maxDD, maxLoss, equity,
  };
}

(async () => {
  console.log(`\nETH/BTC PAIRS TRADE (market-neutral) — ${DAYS}d, $${NOTIONAL}/leg, fee ${FEE * 100}%/side ×4 per round trip\n`);
  const grid = [];
  for (const lookback of [30, 50, 100]) for (const entryZ of [1.5, 2, 2.5]) grid.push({ lookback, entryZ, exitZ: 0.5 });

  for (const tf of TFS) {
    process.stdout.write(`Fetching ${A} & ${B} ${tf}... `);
    const [aC, bC] = await Promise.all([fetchHistory(A, tf), fetchHistory(B, tf)]);
    const series = align(aC, bC);
    const tfl = { '60': '1h', '240': '4h', 'D': '1d' }[tf];
    console.log(`${series.length} aligned bars (${new Date(series[0].ts).toISOString().slice(0,10)} -> ${new Date(series[series.length-1].ts).toISOString().slice(0,10)})`);
    console.log(`   lookback entryZ   Return   WinRate  PF     maxDD  streak  trades`);
    for (const g of grid) {
      const r = simulate(series, g);
      const tag = r.ret > 0 && r.pf > 1.1 ? ' ✓' : '';
      console.log(`   ${String(g.lookback).padStart(4)}    ${g.entryZ.toFixed(1)}    ` +
        `${((r.ret >= 0 ? '+' : '') + r.ret.toFixed(1) + '%').padStart(8)}   ${r.winRate.toFixed(0).padStart(3)}%    ${r.pf.toFixed(2)}   ${r.maxDD.toFixed(0).padStart(2)}%    ${String(r.maxLoss).padStart(2)}     ${String(r.trades).padStart(3)}${tag}`);
    }
    console.log('');
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
