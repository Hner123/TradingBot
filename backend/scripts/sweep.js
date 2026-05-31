/**
 * Strategy sweep — finds the most effective config over ~2 years of Binance data.
 *
 *   node scripts/sweep.js
 *
 * For each (symbol, timeframe) it fetches history ONCE, precomputes the signal series
 * per engine ONCE (the expensive part), then simulates a large matrix of
 * direction / exit / confidence configs cheaply. Ranks by net return AFTER fees.
 *
 * Fees modeled both ways:  taker (current bot uses market orders) and maker (limit).
 * Ranking is on TAKER net (the honest, deployable-today number).
 */

const axios = require('axios');
const { generateSignal: classicSignal, calcMACD } = require('../signals');
const { generateSignal: meanrevSignal } = require('../signals_meanrev');
const { mapInterval } = require('../binance');

const DAYS = parseInt(process.env.DAYS || '730', 10);
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const TIMEFRAMES = (process.env.TFS || '240,D').split(',');     // 4h, 1d (cheap); add 60 for 1h
const NOTIONAL = 1000;          // fixed notional per trade — isolates edge from sizing
const FEE_TAKER = 0.0004;       // 0.04% per side
const FEE_MAKER = 0.0002;       // 0.02% per side

const INTERVAL_MS = {
  '1': 60_000, '5': 300_000, '15': 900_000, '30': 1_800_000,
  '60': 3_600_000, '120': 7_200_000, '240': 14_400_000,
  '360': 21_600_000, '720': 43_200_000, 'D': 86_400_000, 'W': 604_800_000,
};

async function fetchHistory(symbol, tf) {
  const interval = mapInterval(tf);
  const stepMs = INTERVAL_MS[tf];
  const now = Date.now();
  const startMs = now - DAYS * 86_400_000;
  const out = [];
  let cursor = startMs;
  while (cursor < now) {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval, startTime: cursor, endTime: now, limit: 1500 },
    });
    const batch = res.data || [];
    if (!batch.length) break;
    out.push(...batch);
    const lastOpen = parseInt(batch[batch.length - 1][0], 10);
    if (batch.length < 1500 || lastOpen + stepMs >= now) break;
    cursor = lastOpen + stepMs;
  }
  const seen = new Set();
  const uniq = out.filter((c) => (seen.has(c[0]) ? false : seen.add(c[0])));
  uniq.sort((a, b) => a[0] - b[0]);
  return uniq;
}

// Precompute signal + macd-state per index (the expensive O(n*window) pass, done once)
function precompute(candles, engine) {
  const lookback = engine === 'meanrev' ? 250 : 120;
  const gen = engine === 'meanrev' ? meanrevSignal : classicSignal;
  const closes = candles.map((c) => parseFloat(c[4]));
  const sig = new Array(candles.length).fill(null);
  for (let i = lookback; i < candles.length; i++) {
    const window = candles.slice(i - lookback + 1, i + 1);
    const s = gen(window);
    // macd state for trailing exit (classic exposes it; recompute for meanrev)
    let macdBull;
    if (engine === 'meanrev') {
      const m = calcMACD(closes.slice(i - lookback + 1, i + 1));
      macdBull = m.macd > m.signal;
    } else {
      macdBull = s.macd > s.macdSignal;
    }
    sig[i] = {
      signal: s.signal,
      confidence: s.confidence,
      bbMiddle: s.bb_middle,
      macdBull,
    };
  }
  return { sig, lookback };
}

// Simulate one config over precomputed signals. Returns stats under taker & maker fees.
function simulate(candles, pre, cfg) {
  const { sig, lookback } = pre;
  const trades = [];
  let pos = null;

  for (let i = lookback; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const close = parseFloat(candles[i][4]);
    const s = sig[i];

    // ── Exit ──
    if (pos) {
      let exit = null, exitMaker = false;
      const { side, entry, sl, tp, qty, bbMiddle } = pos;
      // SL / TP (taker — stop/target market fills; TP can be maker via limit)
      if (side === 'BUY') {
        if (sl != null && low <= sl) { exit = sl; }
        else if (tp != null && high >= tp) { exit = tp; exitMaker = true; }
      } else {
        if (sl != null && high >= sl) { exit = sl; }
        else if (tp != null && low <= tp) { exit = tp; exitMaker = true; }
      }
      // BB middle target (maker-able)
      if (exit == null && cfg.bbExit && bbMiddle != null) {
        if (side === 'BUY' && high >= bbMiddle) { exit = bbMiddle; exitMaker = true; }
        else if (side === 'SELL' && low <= bbMiddle) { exit = bbMiddle; exitMaker = true; }
      }
      // MACD trailing reversal (taker — market)
      if (exit == null && cfg.macdExit && s) {
        if ((side === 'BUY' && !s.macdBull) || (side === 'SELL' && s.macdBull)) exit = close;
      }
      if (exit != null) {
        const dir = side === 'BUY' ? 1 : -1;
        const gross = (exit - entry) * dir * qty;
        trades.push({ gross, notional: entry * qty, exitMaker, idx: i });
        pos = null;
      }
    }

    // ── Entry ──
    if (!pos && s && s.signal !== 'HOLD' && s.confidence >= cfg.conf) {
      let side = s.signal;
      if (cfg.reverse) side = side === 'BUY' ? 'SELL' : 'BUY';
      const entry = close;
      const qty = NOTIONAL / entry;
      const sl = cfg.sl ? (side === 'BUY' ? entry * (1 - cfg.sl / 100) : entry * (1 + cfg.sl / 100)) : null;
      const tp = cfg.tp ? (side === 'BUY' ? entry * (1 + cfg.tp / 100) : entry * (1 - cfg.tp / 100)) : null;
      pos = { side, entry, sl, tp, qty, bbMiddle: s.bbMiddle };
    }
  }

  // Tally over a subset of trades under a fee model
  function tally(subset, makerForTargets) {
    let eq = NOTIONAL, peak = NOTIONAL, maxDD = 0, gw = 0, gl = 0, wins = 0;
    let curLoss = 0, maxLossStreak = 0;
    for (const t of subset) {
      const entryRate = makerForTargets ? FEE_MAKER : FEE_TAKER;
      const exitRate = makerForTargets && t.exitMaker ? FEE_MAKER : FEE_TAKER;
      const fee = t.notional * entryRate + t.notional * exitRate;
      const net = t.gross - fee;
      eq += net;
      if (net >= 0) { wins++; gw += net; curLoss = 0; }
      else { gl += -net; curLoss++; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
      if (eq > peak) peak = eq;
      const dd = ((peak - eq) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }
    return {
      trades: subset.length,
      winRate: subset.length ? (wins / subset.length) * 100 : 0,
      ret: ((eq - NOTIONAL) / NOTIONAL) * 100,
      pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      maxDD, maxLossStreak,
    };
  }

  // Train/test split at 70% of candle range
  const splitIdx = lookback + Math.floor((candles.length - lookback) * 0.7);
  const isTrades = trades.filter((t) => t.idx < splitIdx);
  const oosTrades = trades.filter((t) => t.idx >= splitIdx);

  return {
    taker: tally(trades, false),
    maker: tally(trades, true),
    is: tally(isTrades, false),     // in-sample, taker
    oos: tally(oosTrades, false),   // out-of-sample, taker
  };
}

// Strategy matrix
function buildConfigs() {
  const configs = [];
  const rrSet = [
    { tp: 1.5, sl: 1.5 }, { tp: 2, sl: 1 }, { tp: 3, sl: 1.5 },
    { tp: 4, sl: 2 }, { tp: 6, sl: 2 }, { tp: 2, sl: 3 },
  ];
  const confs = [60, 70];

  // classic trend + classic reverse
  for (const reverse of [false, true]) {
    for (const conf of confs) {
      for (const rr of rrSet) {
        configs.push({ engine: 'classic', reverse, conf, ...rr, label: `classic${reverse ? '-rev' : ''} TP${rr.tp}/SL${rr.sl} c${conf}` });
      }
      configs.push({ engine: 'classic', reverse, conf, macdExit: true, label: `classic${reverse ? '-rev' : ''} MACD-trail c${conf}` });
    }
  }

  // mean reversion
  for (const conf of confs) {
    configs.push({ engine: 'meanrev', conf, bbExit: true, sl: 2, label: `meanrev BBmid SL2 c${conf}` });
    configs.push({ engine: 'meanrev', conf, bbExit: true, macdExit: true, sl: 2, label: `meanrev BBmid+MACD SL2 c${conf}` });
    configs.push({ engine: 'meanrev', conf, tp: 1.5, sl: 1, label: `meanrev TP1.5/SL1 c${conf}` });
    configs.push({ engine: 'meanrev', conf, tp: 2, sl: 1.5, label: `meanrev TP2/SL1.5 c${conf}` });
    configs.push({ engine: 'meanrev', conf, macdExit: true, label: `meanrev MACD-trail c${conf}` });
  }
  return configs;
}

function works(s) {
  // Real edge survives OUT-OF-SAMPLE: profitable in both train and test halves,
  // with edge (PF>1) and a meaningful OOS sample. This is the anti-overfit bar.
  return (
    s.is.ret > 0 && s.is.pf > 1.05 &&
    s.oos.ret > 0 && s.oos.pf > 1.05 &&
    s.oos.trades >= 15 && s.taker.maxDD < 45
  );
}

// Martingale-ready: decent win rate + SHORT bounded losing streak + survives OOS.
// Short streak is what keeps a Martingale from blowing up.
const MAX_STREAK_OK = parseInt(process.env.MAX_STREAK || '6', 10);
function martingaleReady(s) {
  return (
    s.taker.winRate >= 50 &&
    s.taker.maxLossStreak <= MAX_STREAK_OK &&
    s.is.ret > 0 && s.oos.ret > 0 &&
    s.taker.pf > 1.15 &&
    s.taker.trades >= 40
  );
}

(async () => {
  console.log(`\n══ Strategy Sweep — ${DAYS} days, symbols ${SYMBOLS.join(',')}, TFs ${TIMEFRAMES.join(',')} ══`);
  console.log(`Fixed $${NOTIONAL} notional/trade. Fees: taker ${FEE_TAKER * 100}%/side, maker ${FEE_MAKER * 100}%/side.`);
  console.log(`Ranking on TAKER net return (honest/deployable). "WORKS" = ret>0, PF>1.1, maxDD<40%, trades>=30.\n`);

  const configs = buildConfigs();
  const results = [];

  for (const symbol of SYMBOLS) {
    for (const tf of TIMEFRAMES) {
      process.stdout.write(`Fetching ${symbol} ${tf} ... `);
      const candles = await fetchHistory(symbol, tf);
      const first = new Date(parseInt(candles[0][0])).toISOString().slice(0, 10);
      const last = new Date(parseInt(candles[candles.length - 1][0])).toISOString().slice(0, 10);
      console.log(`${candles.length} candles (${first}→${last}), precomputing signals...`);

      const preByEngine = {
        classic: precompute(candles, 'classic'),
        meanrev: precompute(candles, 'meanrev'),
      };

      for (const cfg of configs) {
        const stats = simulate(candles, preByEngine[cfg.engine], cfg);
        results.push({ symbol, tf, cfg, stats, ok: works(stats) });
      }
    }
  }

  // Rank by OUT-OF-SAMPLE return (what matters for deployment)
  results.sort((a, b) => b.stats.oos.ret - a.stats.oos.ret);

  const tfLabel = (tf) => ({ '60': '1h', '240': '4h', 'D': '1d' }[tf] || tf);
  const row = (r) => {
    const f = r.stats.taker, is = r.stats.is, o = r.stats.oos;
    return `${r.ok ? '✓' : ' '} ${r.symbol.padEnd(8)} ${tfLabel(r.tf).padEnd(3)} ${r.cfg.label.padEnd(30)} ` +
      `IS ${is.ret >= 0 ? '+' : ''}${is.ret.toFixed(0)}%/PF${is.pf.toFixed(2)}  ` +
      `OOS ${o.ret >= 0 ? '+' : ''}${o.ret.toFixed(0)}%/PF${o.pf.toFixed(2)}/n${o.trades}  ` +
      `full ${f.ret >= 0 ? '+' : ''}${f.ret.toFixed(0)}% DD${f.maxDD.toFixed(0)}%`;
  };
  const martRow = (r) => {
    const f = r.stats.taker;
    return `  ${r.symbol.padEnd(9)} ${tfLabel(r.tf).padEnd(3)} ${r.cfg.label.padEnd(30)} ` +
      `WR ${f.winRate.toFixed(0)}%  maxLossStreak ${String(f.maxLossStreak).padStart(2)}  ` +
      `PF ${f.pf.toFixed(2)}  full ${f.ret >= 0 ? '+' : ''}${f.ret.toFixed(0)}%  DD ${f.maxDD.toFixed(0)}%  n=${f.trades}`;
  };

  console.log('\n════════ TOP 25 (ranked by OUT-OF-SAMPLE return) ════════');
  console.log('  IS = in-sample (first 70%), OOS = out-of-sample (last 30%, never selected on)\n');
  results.slice(0, 25).forEach((r) => console.log(row(r)));

  const passing = results.filter((r) => r.ok);
  console.log(`\n════════ SURVIVED OUT-OF-SAMPLE (profitable in BOTH halves): ${passing.length} ════════`);
  if (passing.length === 0) {
    console.log('  None. Every in-sample winner failed to generalize → no robust edge found.');
  } else {
    passing.forEach((r) => console.log(row(r)));

    const byLabel = {};
    for (const r of passing) {
      const key = `${r.cfg.label} @ ${tfLabel(r.tf)}`;
      (byLabel[key] = byLabel[key] || []).push(r.symbol);
    }
    const robust = Object.entries(byLabel).filter(([, s]) => s.length > 1);
    console.log('\n──── Robust across MULTIPLE symbols (strongest evidence) ────');
    if (robust.length === 0) console.log('  None — each survivor is symbol-specific. Treat with caution.');
    else robust.forEach(([k, s]) => console.log(`  ${k}  →  ${s.join(', ')}`));
  }

  // ── Martingale-ready candidates ──
  const mart = results.filter((r) => martingaleReady(r.stats))
    .sort((a, b) => b.stats.taker.ret - a.stats.taker.ret);
  console.log(`\n════════ MARTINGALE-READY (WR≥50%, maxLossStreak≤${MAX_STREAK_OK}, OOS+, PF>1.15): ${mart.length} ════════`);
  if (mart.length === 0) {
    console.log('  None met all criteria. Loosen MAX_STREAK or accept lower WR.');
  } else {
    mart.forEach((r) => console.log(martRow(r)));
    const worst = Math.max(...mart.map((r) => r.stats.taker.maxLossStreak));
    console.log(`\n  Worst losing streak among candidates: ${worst} trades.`);
    console.log(`  Plan Martingale capital for ~${Math.ceil(worst * 1.7)} consecutive losses (1.7× safety margin).`);
  }
  console.log('');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
