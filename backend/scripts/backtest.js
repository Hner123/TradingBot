/**
 * Backtest the signal engine against historical Binance Futures data.
 *
 * Usage:
 *   node scripts/backtest.js [symbol] [interval] [days] [tp%] [sl%] [conf] [reverse]
 *   node scripts/backtest.js ETHUSDT 240 365 3 1.5 60
 *   node scripts/backtest.js ETHUSDT 240 365 3 1.5 60 reverse   # fade every signal
 *
 * Defaults match the bot's recommended config.
 * Fetches Binance mainnet klines (public endpoint, no auth) — testnet history is sparse.
 */

const axios = require('axios');
const { calcMACD } = require('../signals');
const { mapInterval } = require('../binance');

const SIGNAL_ENGINE = (process.env.SIGNAL_ENGINE || 'classic').toLowerCase();
const { generateSignal } = SIGNAL_ENGINE === 'meanrev'
  ? require('../signals_meanrev')
  : require('../signals');

const SYMBOL    = process.argv[2] || 'ETHUSDT';
const INTERVAL  = process.argv[3] || '240';   // 4H
const DAYS      = parseInt(process.argv[4] || '365', 10);
const TP_PCT    = parseFloat(process.argv[5] || '3');
const SL_PCT    = parseFloat(process.argv[6] || '1.5');
const CONF_MIN  = parseInt(process.argv[7] || '60', 10);
const REVERSE   = process.argv[8] === 'reverse';
const LEVERAGE  = parseInt(process.env.LEVERAGE || '1', 10);
const EXIT_MODE = process.env.EXIT_MODE || 'fixed';   // 'fixed' or 'macd'
const RISK_PCT  = parseFloat(process.env.RISK_PCT || '1');
const LOOKBACK  = SIGNAL_ENGINE === 'meanrev' ? 250 : 100;
const START_BAL = parseFloat(process.env.BALANCE || '1000');
// Margin-denominated knobs
let   MART_BASE = parseFloat(process.env.MART_BASE || '0');  // 0 = disabled, else base margin USDT
let   MART_INC  = parseFloat(process.env.MART_INC  || '0');  // increment per loss/win
const MART_MODE = (process.env.MART_MODE || 'classic').toLowerCase();  // 'classic' | 'anti'
let   FIX_MARGIN = parseFloat(process.env.FIX_MARGIN || '0');  // fixed $ margin per trade (overrides RISK_PCT)
const REGIME    = process.env.REGIME === '1';  // EMA200-slope filter

const USE_BB_EXIT = process.env.USE_BB_EXIT === '1';  // exit at BB middle (mean-rev natural target)

// Binance USDⓈ-M Futures fees (regular tier). Override via env as percent.
const FEE_MAKER_PCT = parseFloat(process.env.FEE_MAKER || '0.020');  // 0.020% = 2 bps
const FEE_TAKER_PCT = parseFloat(process.env.FEE_TAKER || '0.040');  // 0.040% = 4 bps
const FEE_MODE      = (process.env.FEE_MODE || 'taker').toLowerCase(); // 'taker' | 'maker' | 'none'

function feeRate(side, reason) {
  if (FEE_MODE === 'none') return 0;
  if (FEE_MODE === 'taker') return FEE_TAKER_PCT;
  // 'maker' mode: entry is maker, exits are maker for profit-target fills, taker for stops/liquidations
  if (side === 'entry') return FEE_MAKER_PCT;
  // exit
  if (reason === 'TP' || reason === 'BB_MIDDLE') return FEE_MAKER_PCT;
  // SL / LIQUIDATED / MACD_REVERSE → must be market = taker
  return FEE_TAKER_PCT;
}

// Notional-denominated convenience knobs (auto-divided by LEVERAGE to get margin)
const NOTIONAL_BASE = parseFloat(process.env.NOTIONAL_BASE || '0');
const NOTIONAL_INC  = parseFloat(process.env.NOTIONAL_INC  || '0');
const FIX_NOTIONAL  = parseFloat(process.env.FIX_NOTIONAL  || '0');
if (NOTIONAL_BASE > 0) {
  MART_BASE = NOTIONAL_BASE / parseInt(process.env.LEVERAGE || '1', 10);
  MART_INC  = NOTIONAL_INC  / parseInt(process.env.LEVERAGE || '1', 10);
}
if (FIX_NOTIONAL > 0) {
  FIX_MARGIN = FIX_NOTIONAL / parseInt(process.env.LEVERAGE || '1', 10);
}

const INTERVAL_MS = {
  '1': 60_000, '3': 180_000, '5': 300_000, '15': 900_000, '30': 1_800_000,
  '60': 3_600_000, '120': 7_200_000, '240': 14_400_000,
  '360': 21_600_000, '720': 43_200_000,
  'D': 86_400_000, 'W': 604_800_000,
}[INTERVAL];

if (!INTERVAL_MS) {
  console.error(`Unknown interval ${INTERVAL}`);
  process.exit(1);
}

async function fetchHistory() {
  const baseUrl = 'https://fapi.binance.com';
  const interval = mapInterval(INTERVAL);
  const now = Date.now();
  const startMs = now - DAYS * 86_400_000;
  const candles = [];
  let cursor = startMs;

  // Binance returns oldest-first, max 1500/call. Paginate forward by startTime.
  while (cursor < now) {
    const res = await axios.get(`${baseUrl}/fapi/v1/klines`, {
      params: {
        symbol: SYMBOL,
        interval,
        startTime: cursor,
        endTime: now,
        limit: 1500,
      },
    });
    const batch = res.data || []; // [openTime, o, h, l, c, v, closeTime, ...]
    if (batch.length === 0) break;
    candles.push(...batch);
    const lastOpen = parseInt(batch[batch.length - 1][0], 10);
    if (lastOpen + INTERVAL_MS >= now || batch.length < 1500) break;
    cursor = lastOpen + INTERVAL_MS;
  }

  // Dedupe and sort oldest-first
  const seen = new Set();
  const unique = [];
  for (const c of candles) {
    if (seen.has(c[0])) continue;
    seen.add(c[0]);
    unique.push(c);
  }
  unique.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
  return unique;
}

function computeEMASeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function backtest(candles) {
  let balance = START_BAL;
  let peak = balance;
  let maxDD = 0;
  const trades = [];
  const equity = [];
  let position = null;

  // Precompute EMA200 once for regime filter
  const allCloses = candles.map((c) => parseFloat(c[4]));
  const ema200 = REGIME ? computeEMASeries(allCloses, 200) : null;

  // Martingale state
  const martingale = MART_BASE > 0;
  const isAnti = MART_MODE === 'anti';
  let currentMargin = MART_BASE;
  let maxMarginReached = MART_BASE;
  let skippedInsufficient = 0;
  let skippedRegime = 0;
  let blewUp = false;

  for (let i = LOOKBACK; i < candles.length; i++) {
    const [ts, open, high, low, close] = candles[i].map(parseFloat);

    // Exit logic
    if (position) {
      const { side, entry, sl, tp, qty, liqPrice, entryTs } = position;
      let exit = null, outcome = null, reason = null;

      // 1) Liquidation check (intra-bar) — applies in MACD mode at high leverage
      if (liqPrice !== undefined) {
        if (side === 'BUY' && low <= liqPrice) { exit = liqPrice; outcome = 'LOSS'; reason = 'LIQUIDATED'; }
        else if (side === 'SELL' && high >= liqPrice) { exit = liqPrice; outcome = 'LOSS'; reason = 'LIQUIDATED'; }
      }

      // 2) BB middle exit (mean-rev natural target) — only if signal recorded one
      if (exit === null && USE_BB_EXIT && position.bbMiddle !== undefined) {
        if (side === 'BUY' && high >= position.bbMiddle) {
          exit = position.bbMiddle; outcome = 'WIN'; reason = 'BB_MIDDLE';
        } else if (side === 'SELL' && low <= position.bbMiddle) {
          exit = position.bbMiddle; outcome = 'WIN'; reason = 'BB_MIDDLE';
        }
      }

      // 3) TP / fixed-SL check (TP=0 disables fixed TP)
      if (exit === null) {
        if (side === 'BUY') {
          if (sl !== undefined && low <= sl) { exit = sl; outcome = 'LOSS'; reason = 'SL'; }
          else if (tp !== undefined && high >= tp) { exit = tp; outcome = 'WIN'; reason = 'TP'; }
        } else {
          if (sl !== undefined && high >= sl) { exit = sl; outcome = 'LOSS'; reason = 'SL'; }
          else if (tp !== undefined && low <= tp) { exit = tp; outcome = 'WIN'; reason = 'TP'; }
        }
      }

      // 3) MACD reversal exit (only in macd mode, evaluated at candle close)
      if (exit === null && EXIT_MODE === 'macd') {
        const closes = candles.slice(i - LOOKBACK + 1, i + 1).map((c) => parseFloat(c[4]));
        const m = calcMACD(closes);
        const macdBullish = m.macd > m.signal;
        if ((side === 'BUY' && !macdBullish) || (side === 'SELL' && macdBullish)) {
          exit = close;
          const movedFavorably = side === 'BUY' ? close > entry : close < entry;
          outcome = movedFavorably ? 'WIN' : 'LOSS';
          reason = 'MACD_REVERSE';
        }
      }

      if (exit !== null) {
        let pnl = (side === 'BUY' ? (exit - entry) : (entry - exit)) * qty;
        // Cap loss at margin used (liquidation guard)
        if (position.marginUsed !== undefined && pnl < -position.marginUsed) {
          pnl = -position.marginUsed;
        }
        // Fees: charged on notional at both entry and exit
        const entryFee = (entry * qty) * (feeRate('entry', null) / 100);
        const exitFee  = (exit  * qty) * (feeRate('exit',  reason) / 100);
        const fees = entryFee + exitFee;
        const netPnl = pnl - fees;
        // Re-classify outcome based on net P&L (small "wins" can flip to losses after fees)
        const netOutcome = netPnl >= 0 ? 'WIN' : 'LOSS';
        balance += netPnl;
        trades.push({
          side, entry, exit, qty, pnl: netPnl, grossPnl: pnl, fees,
          outcome: netOutcome, reason,
          entryTs, exitTs: ts,
          pnlPct: (netPnl / START_BAL) * 100,
          margin: position.marginUsed,
        });

        // Martingale: classic ramps on loss, anti-martingale ramps on win
        if (martingale) {
          if (isAnti) {
            if (outcome === 'WIN') {
              currentMargin += MART_INC;
              if (currentMargin > maxMarginReached) maxMarginReached = currentMargin;
            } else {
              currentMargin = MART_BASE;
            }
          } else {
            if (outcome === 'WIN') {
              currentMargin = MART_BASE;
            } else {
              currentMargin += MART_INC;
              if (currentMargin > maxMarginReached) maxMarginReached = currentMargin;
            }
          }
        }
        position = null;
      }
    }

    // Entry logic
    if (!position && !blewUp) {
      const window = candles.slice(i - LOOKBACK + 1, i + 1);
      const sig = generateSignal(window);
      if (sig.signal !== 'HOLD' && sig.confidence >= CONF_MIN) {
        const rawSide = REVERSE
          ? (sig.signal === 'BUY' ? 'SELL' : 'BUY')
          : sig.signal;

        // Regime filter — only take BUY in uptrends, SELL in downtrends (slope of EMA200)
        if (REGIME && ema200) {
          const cur = ema200[i];
          const prev = ema200[i - 10];
          if (cur === null || prev === null) {
            // not enough history yet; skip
            equity.push({ ts, balance });
            continue;
          }
          const trendingUp = cur > prev;
          const trendingDown = cur < prev;
          const allow = (rawSide === 'BUY' && trendingUp) || (rawSide === 'SELL' && trendingDown);
          if (!allow) {
            skippedRegime++;
            equity.push({ ts, balance });
            continue;
          }
        }

        const side = rawSide;
        const entry = close;

        let qty, sl, liqPrice, marginUsed;
        if (EXIT_MODE === 'macd') {
          // Determine margin: martingale > fixed > risk-pct
          let margin;
          if (martingale) margin = currentMargin;
          else if (FIX_MARGIN > 0) margin = FIX_MARGIN;
          else margin = balance * (RISK_PCT / 100);

          if (margin > balance) {
            skippedInsufficient++;
            if (martingale) blewUp = true;
          } else {
            const notional = margin * LEVERAGE;
            qty = notional / entry;
            marginUsed = margin;
            liqPrice = side === 'BUY'
              ? entry * (1 - 1 / LEVERAGE)
              : entry * (1 + 1 / LEVERAGE);
            // Optional fixed SL inside MACD mode (acts as a hard stop ahead of liquidation)
            if (SL_PCT > 0) {
              sl = side === 'BUY'
                ? entry * (1 - SL_PCT / 100)
                : entry * (1 + SL_PCT / 100);
            }
          }
        } else {
          const riskUsdt = balance * (RISK_PCT / 100);
          const stopDistance = entry * (SL_PCT / 100);
          qty = riskUsdt / stopDistance;
          sl = side === 'BUY'
            ? entry * (1 - SL_PCT / 100)
            : entry * (1 + SL_PCT / 100);
        }

        if (qty !== undefined) {
          const tp = TP_PCT > 0
            ? (side === 'BUY' ? entry * (1 + TP_PCT / 100) : entry * (1 - TP_PCT / 100))
            : undefined;

          position = { side, entry, sl, tp, qty, liqPrice, marginUsed, entryTs: ts, bbMiddle: sig.bb_middle };
        }
      }
    }

    // Track drawdown
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
    equity.push({ ts, balance });
  }

  return { trades, finalBalance: balance, maxDD, equity, maxMarginReached, skippedInsufficient, skippedRegime, blewUp };
}

function fmt(n, d = 2) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

(async () => {
  console.log(`\nBacktesting ${SYMBOL} on ${INTERVAL} timeframe over ${DAYS} days${REVERSE ? '  (REVERSED — fade every signal)' : ''}`);
  console.log(`Signal engine: ${SIGNAL_ENGINE}`);
  if (EXIT_MODE === 'macd') {
    const tpStr = TP_PCT > 0 ? `TP=${TP_PCT}% or MACD reversal` : `MACD reversal only`;
    let sizeStr;
    if (MART_BASE > 0) {
      const label = MART_MODE === 'anti' ? 'Anti-Martingale' : 'Martingale';
      const baseStr = NOTIONAL_BASE > 0
        ? `notional $${NOTIONAL_BASE} (margin $${MART_BASE})`
        : `margin $${MART_BASE}`;
      const incStr = NOTIONAL_INC > 0
        ? `+$${NOTIONAL_INC} notional`
        : `+$${MART_INC} margin`;
      const ramp = MART_MODE === 'anti'
        ? `${incStr} per WIN, reset on loss`
        : `${incStr} per loss, reset on win`;
      sizeStr = `${label}: ${baseStr} base, ${ramp}`;
    } else if (FIX_MARGIN > 0) {
      sizeStr = FIX_NOTIONAL > 0
        ? `Fixed notional $${FIX_NOTIONAL} (margin $${FIX_MARGIN}) per trade`
        : `Fixed margin: $${FIX_MARGIN} per trade`;
    } else {
      sizeStr = `margin=${RISK_PCT}% of balance per trade`;
    }
    console.log(`Strategy: ${tpStr}  Leverage=${LEVERAGE}x  confidence≥${CONF_MIN}%${REGIME ? '  Regime filter: EMA200 slope' : ''}`);
    console.log(`Sizing:   ${sizeStr}`);
  } else {
    console.log(`Strategy: TP=${TP_PCT}%  SL=${SL_PCT}%  confidence≥${CONF_MIN}%  risk=${RISK_PCT}%/trade`);
  }
  console.log(`Starting balance: $${START_BAL}\n`);

  console.log('Fetching historical klines from Binance mainnet...');
  const candles = await fetchHistory();
  if (candles.length < LOOKBACK + 1) {
    console.error(`Not enough candles returned (${candles.length}). Check symbol/interval.`);
    process.exit(1);
  }
  const firstTs = parseInt(candles[0][0], 10);
  const lastTs = parseInt(candles[candles.length - 1][0], 10);
  console.log(`  ${candles.length} candles  ${isoDate(firstTs)} → ${isoDate(lastTs)}\n`);

  const { trades, finalBalance, maxDD, equity, maxMarginReached, skippedInsufficient, skippedRegime, blewUp } = backtest(candles);

  const wins = trades.filter((t) => t.outcome === 'WIN');
  const losses = trades.filter((t) => t.outcome === 'LOSS');
  const longs = trades.filter((t) => t.side === 'BUY');
  const shorts = trades.filter((t) => t.side === 'SELL');
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const totalReturn = ((finalBalance - START_BAL) / START_BAL) * 100;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = trades.length ? (grossWin - grossLoss) / trades.length : 0;
  const totalFees = trades.reduce((s, t) => s + (t.fees || 0), 0);
  const totalGross = trades.reduce((s, t) => s + (t.grossPnl ?? t.pnl), 0);

  // Streaks
  let curWin = 0, curLoss = 0, maxWinStreak = 0, maxLossStreak = 0;
  let worstStreakStartTs = null, worstStreakEndTs = null;
  let worstStreakLoss = 0, runStreakLoss = 0, runStreakStart = null;
  for (const t of trades) {
    if (t.outcome === 'WIN') {
      curWin++;
      curLoss = 0;
      if (curWin > maxWinStreak) maxWinStreak = curWin;
      runStreakLoss = 0;
      runStreakStart = null;
    } else {
      curLoss++;
      curWin = 0;
      if (runStreakStart === null) runStreakStart = t.entryTs;
      runStreakLoss += t.pnl;
      if (curLoss > maxLossStreak) {
        maxLossStreak = curLoss;
        worstStreakStartTs = runStreakStart;
        worstStreakEndTs = t.exitTs;
        worstStreakLoss = runStreakLoss;
      }
    }
  }

  console.log('─'.repeat(50));
  console.log('  RESULTS');
  console.log('─'.repeat(50));
  console.log(`  Final balance:     $${fmt(finalBalance)}    (${totalReturn >= 0 ? '+' : ''}${fmt(totalReturn)}%)`);
  console.log(`  Max drawdown:       ${fmt(maxDD)}%`);
  if (FEE_MODE !== 'none') {
    console.log(`  Gross P&L:          $${fmt(totalGross)}    Fees: -$${fmt(totalFees)}    Fee mode: ${FEE_MODE}`);
  }
  console.log('');
  console.log(`  Total trades:       ${trades.length}    (${longs.length} long / ${shorts.length} short)`);
  console.log(`  Wins:               ${wins.length}`);
  console.log(`  Losses:             ${losses.length}`);
  console.log(`  Win rate:           ${fmt(winRate)}%`);
  console.log('');
  console.log(`  Avg win:           +$${fmt(avgWin)}`);
  console.log(`  Avg loss:          -$${fmt(avgLoss)}`);
  console.log(`  Expectancy/trade:   $${fmt(expectancy)}`);
  console.log(`  Profit factor:      ${fmt(profitFactor)}`);
  console.log('');
  console.log(`  Max losing streak:  ${maxLossStreak} trades`);
  if (maxLossStreak > 0) {
    console.log(`    period:           ${isoDate(worstStreakStartTs)} → ${isoDate(worstStreakEndTs)}`);
    console.log(`    cumulative loss:  -$${fmt(Math.abs(worstStreakLoss))}  (${fmt(Math.abs(worstStreakLoss) / START_BAL * 100)}% of starting balance)`);
  }
  console.log(`  Max winning streak: ${maxWinStreak} trades`);

  // Exit reason breakdown (relevant for MACD mode)
  if (EXIT_MODE === 'macd') {
    const reasons = {};
    for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
    console.log('');
    console.log(`  Exit reasons:`);
    for (const r of Object.keys(reasons)) console.log(`    ${r.padEnd(14)} ${reasons[r]}`);
  }

  // Martingale stats
  if (MART_BASE > 0) {
    console.log('');
    console.log(`  ${MART_MODE === 'anti' ? 'Anti-Martingale' : 'Martingale'} stats:`);
    console.log(`    Max margin reached:  $${fmt(maxMarginReached)}`);
    console.log(`    Trades skipped (insufficient balance): ${skippedInsufficient}`);
    if (blewUp) console.log(`    ⚠ BLEW UP — balance fell below required margin; trading stopped`);
  }
  if (REGIME) {
    console.log('');
    console.log(`  Regime filter: ${skippedRegime} signals filtered out (counter-trend)`);
  }
  console.log('─'.repeat(50));

  // Verdict
  console.log('\n  Verdict:');
  if (trades.length < 20) {
    console.log('    ⚠ Too few trades — strategy not validated. Try a longer period or lower confidence threshold.');
  } else if (totalReturn > 0 && profitFactor > 1.3 && winRate > 35) {
    console.log('    ✓ Strategy looks viable on this data.');
  } else if (totalReturn < 0) {
    console.log('    ✗ Strategy lost money. Don\'t deploy this config.');
  } else {
    console.log('    △ Marginal. Profitable but low edge — consider tuning thresholds.');
  }
  console.log('');

  if (trades.length > 0) {
    console.log('  Last 5 trades:');
    trades.slice(-5).forEach((t) => {
      const sign = t.pnl >= 0 ? '+' : '';
      console.log(
        `    ${isoDate(t.entryTs)} ${t.side.padEnd(4)} ` +
        `entry=$${fmt(t.entry)} exit=$${fmt(t.exit)} ` +
        `${sign}$${fmt(t.pnl)} (${t.outcome})`
      );
    });
    console.log('');
  }
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
