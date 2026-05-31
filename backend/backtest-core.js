/**
 * Reusable backtest engine — returns structured results (summary / trades / equity)
 * for the API + Backtest UI. Shares the same signal engines as the live bot.
 *
 * Data: Binance mainnet public klines (no auth). Candles cached per (symbol, tf).
 */

const axios = require('axios');
const { generateSignal: classicSignal, calcMACD } = require('./signals');
const { generateSignal: meanrevSignal } = require('./signals_meanrev');
const { generateSignal: macdRsiEmaSignal } = require('./signals_macd_rsi_ema');
const { generateSignal: aegisSignal } = require('./signals_aegis');
const { mapInterval } = require('./binance');

const FEE = { taker: 0.0004, maker: 0.0002 };
const INTERVAL_MS = {
  '1': 60_000, '5': 300_000, '15': 900_000, '30': 1_800_000,
  '60': 3_600_000, '120': 7_200_000, '240': 14_400_000,
  '360': 21_600_000, '720': 43_200_000, 'D': 86_400_000, 'W': 604_800_000,
};

// ── Candle cache (symbol|tf|days bucket) ───────────────────────────────────────
const candleCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

async function fetchHistory(symbol, tf, days) {
  const key = `${symbol}|${tf}|${days}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const interval = mapInterval(tf);
  const stepMs = INTERVAL_MS[tf];
  if (!stepMs) throw new Error(`Unsupported timeframe ${tf}`);
  const now = Date.now();
  const startMs = now - days * 86_400_000;
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
  candleCache.set(key, { at: Date.now(), data: uniq });
  return uniq;
}

// Fetch an explicit [startMs, endMs] range (used for single calendar-year backtests).
const rangeCache = new Map();
async function fetchRange(symbol, tf, startMs, endMs) {
  const key = `${symbol}|${tf}|${startMs}|${endMs}`;
  const hit = rangeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const interval = mapInterval(tf);
  const stepMs = INTERVAL_MS[tf];
  if (!stepMs) throw new Error(`Unsupported timeframe ${tf}`);
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
      params: { symbol, interval, startTime: cursor, endTime: endMs, limit: 1500 },
    });
    const batch = res.data || [];
    if (!batch.length) break;
    out.push(...batch);
    const lastOpen = parseInt(batch[batch.length - 1][0], 10);
    if (batch.length < 1500 || lastOpen + stepMs >= endMs) break;
    cursor = lastOpen + stepMs;
  }
  const seen = new Set();
  const uniq = out.filter((c) => (seen.has(c[0]) ? false : seen.add(c[0])));
  uniq.sort((a, b) => a[0] - b[0]);
  rangeCache.set(key, { at: Date.now(), data: uniq });
  return uniq;
}

// Convert real candles to Heikin Ashi (for SIGNALS only — never for execution prices).
function toHeikinAshi(candles) {
  const ha = [];
  let prevOpen, prevClose;
  for (let i = 0; i < candles.length; i++) {
    const o = parseFloat(candles[i][1]), h = parseFloat(candles[i][2]);
    const l = parseFloat(candles[i][3]), c = parseFloat(candles[i][4]);
    const haClose = (o + h + l + c) / 4;
    const haOpen = i === 0 ? (o + c) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(h, haOpen, haClose);
    const haLow = Math.min(l, haOpen, haClose);
    ha.push([candles[i][0], haOpen, haHigh, haLow, haClose, candles[i][5]]);
    prevOpen = haOpen; prevClose = haClose;
  }
  return ha;
}

// ── Run a backtest. params shape documented in server.js endpoint. ──────────────
async function runBacktest(params) {
  const p = {
    symbol: 'BTCUSDT', timeframe: '240', days: 730,
    engine: 'meanrev', reverse: false,
    tp: 0, sl: 0, exitMode: 'macd', useBBExit: true, trailPercent: 0,
    conf: 60, startBalance: 100, leverage: 10,
    sizing: 'martingale', fixedNotional: 0, riskPct: 1,
    martBase: 15, martInc: 5, martCap: 8, martStart: 1,
    feeMode: 'taker', heikinAshi: false, year: null,
    ...params,
  };

  const lookback = p.engine === 'aegis' ? 900 : p.engine === 'meanrev' ? 250 : 120;

  // Single calendar-year mode: fetch [Jan 1 .. Dec 31] of the year, plus a warmup
  // buffer before it so signals are valid from Jan 1. Entries are gated to the year.
  let candles, yearStartMs = null;
  if (p.year) {
    const ms = INTERVAL_MS[p.timeframe];
    yearStartMs = Date.UTC(p.year, 0, 1);
    const yearEndMs = Date.UTC(p.year + 1, 0, 1);
    candles = await fetchRange(p.symbol, p.timeframe, yearStartMs - lookback * ms * 2, yearEndMs);
  } else {
    candles = await fetchHistory(p.symbol, p.timeframe, p.days);
  }
  if (candles.length < lookback + 5) throw new Error('Not enough history for this timeframe/year.');

  const gen = p.engine === 'meanrev' ? meanrevSignal
    : p.engine === 'macd_rsi_ema' ? macdRsiEmaSignal
    : p.engine === 'aegis' ? aegisSignal
    : classicSignal;

  // Heikin Ashi: signals computed on smoothed HA candles, but ALL execution
  // (entries/exits/stops) uses the REAL candle prices below. Never fill at HA prices.
  const sigCandles = p.heikinAshi ? toHeikinAshi(candles) : candles;
  const closes = sigCandles.map((c) => parseFloat(c[4]));
  const feeRate = FEE[p.feeMode] != null ? FEE[p.feeMode] : FEE.taker;

  let balance = p.startBalance;
  let peak = balance, maxDD = 0;
  let pos = null;
  let lossRun = 0; // consecutive losses; drives the martingale ramp
  const trades = [];
  const equity = [{ ts: parseInt(candles[lookback][0], 10), balance }];

  for (let i = lookback; i < candles.length; i++) {
    const ts = parseInt(candles[i][0], 10);
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const close = parseFloat(candles[i][4]);

    // signal + macd state for this bar (computed on HA candles if enabled)
    const window = sigCandles.slice(i - lookback + 1, i + 1);
    const s = p.engine === 'aegis'
      ? gen(window, { minimumConfidenceScore: p.conf, symbol: p.symbol })
      : gen(window);
    let macdBull;
    if (p.engine === 'meanrev') {
      const m = calcMACD(closes.slice(i - lookback + 1, i + 1));
      macdBull = m.macd > m.signal;
    } else {
      macdBull = s.macd > s.macdSignal;
    }

    // ── Exit ──
    if (pos) {
      let exit = null, reason = null, exitMaker = false;
      const { side, entry, sl, tp, qty, bbMiddle, liqPrice, marginUsed } = pos;

      // update trailing-stop extremes
      if (p.trailPercent > 0) {
        if (side === 'BUY') pos.peak = Math.max(pos.peak, high);
        else pos.trough = Math.min(pos.trough, low);
      }

      if (liqPrice != null) {
        if (side === 'BUY' && low <= liqPrice) { exit = liqPrice; reason = 'LIQUIDATED'; }
        else if (side === 'SELL' && high >= liqPrice) { exit = liqPrice; reason = 'LIQUIDATED'; }
      }
      // trailing stop (follows price by trailPercent from the best point reached)
      if (exit == null && p.trailPercent > 0) {
        if (side === 'BUY') {
          const stop = pos.peak * (1 - p.trailPercent / 100);
          if (low <= stop) { exit = stop; reason = 'TRAIL'; }
        } else {
          const stop = pos.trough * (1 + p.trailPercent / 100);
          if (high >= stop) { exit = stop; reason = 'TRAIL'; }
        }
      }
      if (exit == null && p.useBBExit && bbMiddle != null) {
        if (side === 'BUY' && high >= bbMiddle) { exit = bbMiddle; reason = 'BB_MIDDLE'; exitMaker = true; }
        else if (side === 'SELL' && low <= bbMiddle) { exit = bbMiddle; reason = 'BB_MIDDLE'; exitMaker = true; }
      }
      if (exit == null) {
        if (side === 'BUY') {
          if (sl != null && low <= sl) { exit = sl; reason = 'SL'; }
          else if (tp != null && high >= tp) { exit = tp; reason = 'TP'; exitMaker = true; }
        } else {
          if (sl != null && high >= sl) { exit = sl; reason = 'SL'; }
          else if (tp != null && low <= tp) { exit = tp; reason = 'TP'; exitMaker = true; }
        }
      }
      if (exit == null && p.exitMode === 'macd') {
        if ((side === 'BUY' && !macdBull) || (side === 'SELL' && macdBull)) { exit = close; reason = 'MACD_REVERSE'; }
      }

      if (exit != null) {
        const dir = side === 'BUY' ? 1 : -1;
        let gross = (exit - entry) * dir * qty;
        if (marginUsed != null && gross < -marginUsed) gross = -marginUsed; // liquidation floor
        const entryFee = entry * qty * (p.feeMode === 'maker' ? FEE.maker : FEE.taker);
        const exitFee = exit * qty * (p.feeMode === 'maker' && exitMaker ? FEE.maker : FEE.taker);
        const fees = entryFee + exitFee;
        const net = gross - fees;
        balance += net;
        const outcome = net >= 0 ? 'WIN' : 'LOSS';

        trades.push({
          entryTs: pos.entryTs, exitTs: ts, side, entry, exit, qty,
          pnl: net, fees, outcome, reason,
          pnlPct: entry > 0 ? ((exit - entry) / entry) * 100 * dir : 0,
          balanceAfter: balance,
        });
        equity.push({ ts, balance });

        // martingale streak tracking. Margin is computed at entry from lossRun.
        // martCap <= 0 disables the cap (unbounded ramp — blow-up risk).
        if (p.sizing === 'martingale') {
          if (outcome === 'WIN') lossRun = 0;
          else {
            lossRun++;
            if (p.martCap > 0 && lossRun >= p.martCap) lossRun = 0; // hard cap: reset streak after N losses
          }
        }
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDD) maxDD = dd;

        pos = null;
      }
    }

    // ── Entry ──
    if (!pos && s.signal !== 'HOLD' && s.confidence >= p.conf && (yearStartMs === null || ts >= yearStartMs)) {
      let side = s.signal;
      if (p.reverse) side = side === 'BUY' ? 'SELL' : 'BUY';
      const entry = close;

      let notional, marginUsed = null, liqPrice = null, sl = null;
      if (p.sizing === 'fixed') {
        notional = p.fixedNotional > 0 ? p.fixedNotional : p.startBalance;
      } else if (p.sizing === 'risk') {
        notional = balance * (p.riskPct / 100) * p.leverage;
        marginUsed = balance * (p.riskPct / 100);
      } else { // martingale — ramp only after `martStart` consecutive losses
        const steps = Math.max(0, lossRun - (p.martStart - 1));
        const wantMargin = p.martBase + p.martInc * steps;
        const margin = Math.min(wantMargin, balance);
        notional = margin * p.leverage;
        marginUsed = margin;
      }
      if (notional <= 0 || (marginUsed != null && marginUsed > balance)) {
        equity.push({ ts, balance });
        continue;
      }
      const qty = notional / entry;
      if (p.leverage > 1 && marginUsed != null) {
        liqPrice = side === 'BUY' ? entry * (1 - 1 / p.leverage) : entry * (1 + 1 / p.leverage);
      }
      if (p.engine === 'aegis' && s.stopLoss) sl = s.stopLoss;
      if (p.sl > 0) sl = side === 'BUY' ? entry * (1 - p.sl / 100) : entry * (1 + p.sl / 100);
      let tp = p.engine === 'aegis' && s.takeProfit1 ? s.takeProfit1 : null;
      if (p.tp > 0) tp = side === 'BUY' ? entry * (1 + p.tp / 100) : entry * (1 - p.tp / 100);

      pos = { side, entry, sl, tp, qty, bbMiddle: s.bb_middle, liqPrice, marginUsed, entryTs: ts, peak: entry, trough: entry };
    }
  }

  // ── Aggregate stats ──
  const wins = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  let curLoss = 0, maxLossStreak = 0, curWin = 0, maxWinStreak = 0;
  let streakStart = null, worstStreakStart = null, worstStreakEnd = null, runLoss = 0, worstLoss = 0;
  for (const t of trades) {
    if (t.outcome === 'WIN') {
      curWin++; if (curWin > maxWinStreak) maxWinStreak = curWin;
      curLoss = 0; runLoss = 0; streakStart = null;
    } else {
      curLoss++; curWin = 0;
      if (streakStart == null) streakStart = t.entryTs;
      runLoss += t.pnl;
      if (curLoss > maxLossStreak) { maxLossStreak = curLoss; worstStreakStart = streakStart; worstStreakEnd = t.exitTs; worstLoss = runLoss; }
    }
  }
  const exitReasons = {};
  for (const t of trades) exitReasons[t.reason] = (exitReasons[t.reason] || 0) + 1;

  // Monthly P&L breakdown (grouped by exit month; trades are chronological)
  const monthly = [];
  let curM = null;
  for (const t of trades) {
    const m = new Date(t.exitTs).toISOString().slice(0, 7); // YYYY-MM
    if (!curM || curM.month !== m) {
      curM = { month: m, pnl: 0, trades: 0, wins: 0, balanceEnd: t.balanceAfter };
      monthly.push(curM);
    }
    curM.pnl += t.pnl;
    curM.trades++;
    if (t.outcome === 'WIN') curM.wins++;
    curM.balanceEnd = t.balanceAfter;
  }

  const strategyLabel = buildLabel(p);
  return {
    summary: {
      symbol: p.symbol, timeframe: p.timeframe, days: p.days, engine: p.engine,
      strategyLabel,
      startBalance: p.startBalance,
      finalBalance: balance,
      returnPct: ((balance - p.startBalance) / p.startBalance) * 100,
      trades: trades.length,
      wins: wins.length, losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      maxDD,
      maxLossStreak, maxWinStreak,
      worstStreakStart, worstStreakEnd, worstStreakLoss: worstLoss,
      totalFees: trades.reduce((a, t) => a + t.fees, 0),
      grossPnl: trades.reduce((a, t) => a + t.pnl + t.fees, 0),
      firstDate: candles.length ? parseInt(candles[0][0], 10) : null,
      lastDate: candles.length ? parseInt(candles[candles.length - 1][0], 10) : null,
      exitReasons,
      sizing: p.sizing, leverage: p.leverage, feeMode: p.feeMode,
    },
    monthly,
    trades,
    equity,
  };
}

function buildLabel(p) {
  const eng = p.engine === 'meanrev' ? 'Mean-Reversion'
    : p.engine === 'macd_rsi_ema' ? 'MACD+RSI+EMA'
    : p.engine === 'aegis' ? 'Aegis 1H Pullback'
    : (p.reverse ? 'Trend-Reverse' : 'Trend-Follow');
  const exit = p.trailPercent > 0 ? `${p.trailPercent}% trail`
    : p.useBBExit ? 'BB-mid' : p.exitMode === 'macd' ? 'MACD-trail' : `TP${p.tp}/SL${p.sl}`;
  const size = p.sizing === 'martingale'
    ? `Martingale $${p.martBase}+$${p.martInc} (start@${p.martStart}, cap ${p.martCap})`
    : p.sizing === 'risk' ? `Risk ${p.riskPct}%` : `Fixed $${p.fixedNotional || p.startBalance}`;
  return `${eng} · ${exit} · ${p.leverage}x · ${size} · conf≥${p.conf}`;
}

module.exports = { runBacktest, fetchHistory };
