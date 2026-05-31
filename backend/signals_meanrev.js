/**
 * Mean-reversion signal engine.
 *
 * Logic:
 *   BUY  when EMA200 is rising  AND price <= lower BB AND RSI < 35
 *   SELL when EMA200 is falling AND price >= upper BB AND RSI > 65
 *
 * Confidence increases the more extreme the RSI / price-to-BB stretch.
 * Returns the BB middle as the natural reversion target (used as TP by callers).
 */

function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcBollinger(prices, period = 20, stdMult = 2) {
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, x) => s + (x - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: sma + std * stdMult,
    middle: sma,
    lower: sma - std * stdMult,
    width: (std * stdMult * 2) / sma, // % bandwidth — proxy for volatility
  };
}

function generateSignal(candles) {
  const closes = candles.map((c) => parseFloat(c[4]));
  const price = closes[closes.length - 1];

  const bb = calcBollinger(closes, 20, 2);
  const rsi = calcRSI(closes, 14);

  let trendUp = false, trendDown = false;
  if (closes.length >= 210) {
    const ema200Now = calcEMA(closes.slice(-200), 200);
    const ema200Prev = calcEMA(closes.slice(-210, -10), 200);
    trendUp = ema200Now > ema200Prev;
    trendDown = ema200Now < ema200Prev;
  }

  let signal = 'HOLD';
  let confidence = 0;
  const reasons = [];

  // Strict: requires ALL of (correct trend) + (price at the band) + (RSI extreme).
  // Rationale: high-quality only. Fee budget can't absorb noise trades.
  if (trendUp && price <= bb.lower && rsi < 30) {
    signal = 'BUY';
    confidence = 70;
    if (rsi < 25) confidence = 85;
    if (rsi < 20) confidence = 95;
    reasons.push(`BUY: price below lower BB, RSI ${rsi.toFixed(1)} deeply oversold, EMA200 rising`);
  } else if (trendDown && price >= bb.upper && rsi > 70) {
    signal = 'SELL';
    confidence = 70;
    if (rsi > 75) confidence = 85;
    if (rsi > 80) confidence = 95;
    reasons.push(`SELL: price above upper BB, RSI ${rsi.toFixed(1)} deeply overbought, EMA200 falling`);
  }

  return {
    signal,
    confidence,
    price,
    rsi,
    ema9: 0, ema21: 0,
    macd: 0, macdSignal: 0,
    bb_upper: bb.upper,
    bb_middle: bb.middle,
    bb_lower: bb.lower,
    reasons,
  };
}

module.exports = { generateSignal };
