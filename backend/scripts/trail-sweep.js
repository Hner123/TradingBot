/**
 * Find the optimal trailing-stop width for the MACD+RSI+EMA strategy.
 * Precomputes entry signals ONCE per (symbol, tf), then tests every trail % cheaply.
 *
 *   node scripts/trail-sweep.js
 */

const axios = require('axios');
const { generateSignal } = require('../signals_macd_rsi_ema');
const { mapInterval } = require('../binance');

const DAYS = parseInt(process.env.DAYS || '730', 10);
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const TFS = (process.env.TFS || '60,240').split(',');
const TRAILS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15];
const NOTIONAL = 1000, FEE = 0.0004, LOOKBACK = 120;
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

function precompute(candles) {
  const sig = new Array(candles.length).fill(null);
  for (let i = LOOKBACK; i < candles.length; i++) {
    const s = generateSignal(candles.slice(i - LOOKBACK + 1, i + 1));
    sig[i] = s.signal === 'HOLD' ? null : { side: s.signal, conf: s.confidence };
  }
  return sig;
}

function simulate(candles, sig, trail) {
  let bal = NOTIONAL, peak = NOTIONAL, maxDD = 0, gw = 0, gl = 0, wins = 0, n = 0;
  let curLoss = 0, maxLoss = 0;
  let pos = null;
  for (let i = LOOKBACK; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]), low = parseFloat(candles[i][3]), close = parseFloat(candles[i][4]);
    if (pos) {
      if (pos.side === 'BUY') pos.peak = Math.max(pos.peak, high); else pos.trough = Math.min(pos.trough, low);
      let exit = null;
      if (pos.side === 'BUY') { const stop = pos.peak * (1 - trail / 100); if (low <= stop) exit = stop; }
      else { const stop = pos.trough * (1 + trail / 100); if (high >= stop) exit = stop; }
      if (exit != null) {
        const dir = pos.side === 'BUY' ? 1 : -1;
        const gross = (exit - pos.entry) * dir * pos.qty;
        const fee = (pos.entry + exit) * pos.qty * FEE;
        const net = gross - fee;
        bal += net; n++;
        if (net >= 0) { wins++; gw += net; curLoss = 0; } else { gl += -net; curLoss++; if (curLoss > maxLoss) maxLoss = curLoss; }
        if (bal > peak) peak = bal;
        const dd = ((peak - bal) / peak) * 100; if (dd > maxDD) maxDD = dd;
        pos = null;
      }
    }
    if (!pos && sig[i] && sig[i].conf >= 60) {
      const entry = close;
      pos = { side: sig[i].side, entry, qty: NOTIONAL / entry, peak: entry, trough: entry };
    }
  }
  return {
    trades: n, winRate: n ? wins / n * 100 : 0,
    ret: (bal - NOTIONAL) / NOTIONAL * 100,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    maxDD, maxLoss,
  };
}

(async () => {
  console.log(`\nMACD+RSI+EMA — optimal trailing-stop sweep (${DAYS}d, $${NOTIONAL} notional, taker ${FEE * 100}%/side)\n`);
  const best = [];
  for (const symbol of SYMBOLS) {
    for (const tf of TFS) {
      process.stdout.write(`Fetching ${symbol} ${tf}... `);
      const candles = await fetchHistory(symbol, tf);
      const sig = precompute(candles);
      console.log(`${candles.length} candles. Trail results:`);
      const tfl = { '60': '1h', '240': '4h', 'D': '1d' }[tf];
      let bestRow = null;
      for (const trail of TRAILS) {
        const r = simulate(candles, sig, trail);
        const tag = r.ret > 0 && r.pf > 1.1 ? ' ✓' : '';
        console.log(`   trail ${String(trail).padStart(4)}%  ret ${(r.ret >= 0 ? '+' : '') + r.ret.toFixed(1)}%`.padEnd(28) +
          `  WR ${r.winRate.toFixed(0)}%  PF ${r.pf.toFixed(2)}  DD ${r.maxDD.toFixed(0)}%  streak ${r.maxLoss}  n=${r.trades}${tag}`);
        if (!bestRow || r.ret > bestRow.ret) bestRow = { ...r, trail };
      }
      best.push({ symbol, tf: tfl, ...bestRow });
      console.log('');
    }
  }
  console.log('════ BEST TRAIL PER MARKET (by return) ════');
  best.forEach((b) => console.log(`  ${b.symbol.padEnd(9)} ${b.tf}  →  trail ${b.trail}%   ret ${(b.ret >= 0 ? '+' : '') + b.ret.toFixed(1)}%  PF ${b.pf.toFixed(2)}  DD ${b.maxDD.toFixed(0)}%  streak ${b.maxLoss}`));
  console.log('');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
