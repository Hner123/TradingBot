/**
 * MACD + RSI + EMA momentum strategy (ported from a TradingView Pine script).
 *
 *   LONG  when: MACD line crosses ABOVE signal line  AND  RSI > 50  AND  close > EMA50
 *   SHORT when: MACD line crosses BELOW signal line  AND  RSI < 50  AND  close < EMA50
 *
 * Exit is a trailing stop (handled by the backtester / live executor), default 1.5%.
 *
 * Tunable via opts: { fast, slow, signal, rsiLength, rsiThreshold, emaLength }.
 */

const { calcEMA, calcRSI, calcMACD } = require('./signals');

function generateSignal(candles, opts = {}) {
  const {
    fast = 12, slow = 26, signal = 9,
    rsiLength = 14, rsiThreshold = 50,
    emaLength = 50,
  } = opts;

  const closes = candles.map((c) => parseFloat(c[4]));
  const price = closes[closes.length - 1];

  // MACD now vs previous bar — to detect the crossover
  const mNow = calcMACD(closes, fast, slow, signal);
  const mPrev = calcMACD(closes.slice(0, -1), fast, slow, signal);

  const rsi = calcRSI(closes, rsiLength);
  const ema = calcEMA(closes, emaLength);

  const bullishCross = mPrev.macd <= mPrev.signal && mNow.macd > mNow.signal;
  const bearishCross = mPrev.macd >= mPrev.signal && mNow.macd < mNow.signal;

  let sig = 'HOLD';
  let confidence = 0;
  const reasons = [];

  if (bullishCross && rsi > rsiThreshold && price > ema) {
    sig = 'BUY';
    confidence = Math.min(95, 60 + Math.round(rsi - rsiThreshold)); // stronger when RSI further above 50
    reasons.push(`BUY: MACD bullish cross, RSI ${rsi.toFixed(1)} > ${rsiThreshold}, price > EMA${emaLength}`);
  } else if (bearishCross && rsi < rsiThreshold && price < ema) {
    sig = 'SELL';
    confidence = Math.min(95, 60 + Math.round(rsiThreshold - rsi));
    reasons.push(`SELL: MACD bearish cross, RSI ${rsi.toFixed(1)} < ${rsiThreshold}, price < EMA${emaLength}`);
  }

  return {
    signal: sig,
    confidence,
    price,
    rsi,
    macd: mNow.macd,
    macdSignal: mNow.signal,
    ema9: 0, ema21: 0,
    ema,
    bb_middle: 0,
    reasons,
  };
}

module.exports = { generateSignal };
