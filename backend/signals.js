/**
 * Signal Engine
 * Calculates EMA, RSI, MACD and generates BUY/SELL/HOLD signals
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
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
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

function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
  // Need enough data
  if (prices.length < slow + signal) return { macd: 0, signal: 0, hist: 0 };

  const emaFastArr = [];
  const emaSlowArr = [];

  for (let i = slow - 1; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    emaFastArr.push(calcEMA(slice.slice(-Math.max(fast * 3, fast + 10)), fast));
    emaSlowArr.push(calcEMA(slice.slice(-Math.max(slow * 3, slow + 10)), slow));
  }

  const macdLine = emaFastArr.map((f, i) => f - emaSlowArr[i]);
  const signalLine = calcEMA(macdLine.slice(-Math.max(signal * 3, signal + 5)), signal);
  const lastMacd = macdLine[macdLine.length - 1];
  const hist = lastMacd - signalLine;

  return { macd: lastMacd, signal: signalLine, hist };
}

function generateSignal(candles) {
  // candles: array of [timestamp, open, high, low, close, volume]
  const closes = candles.map((c) => parseFloat(c[4]));
  const currentPrice = closes[closes.length - 1];

  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes, 14);
  const { macd, signal: macdSignal, hist } = calcMACD(closes);

  let score = 0;
  const reasons = [];

  // EMA Crossover
  const prevEma9 = calcEMA(closes.slice(0, -1), 9);
  const prevEma21 = calcEMA(closes.slice(0, -1), 21);

  if (ema9 > ema21) {
    score += 1;
    reasons.push('EMA9 above EMA21 (bullish)');
  } else {
    score -= 1;
    reasons.push('EMA9 below EMA21 (bearish)');
  }

  // EMA crossover signal (stronger)
  if (prevEma9 <= prevEma21 && ema9 > ema21) {
    score += 2;
    reasons.push('Golden cross EMA9/21 (strong bullish)');
  } else if (prevEma9 >= prevEma21 && ema9 < ema21) {
    score -= 2;
    reasons.push('Death cross EMA9/21 (strong bearish)');
  }

  // RSI
  if (rsi < 35) {
    score += 2;
    reasons.push(`RSI oversold at ${rsi.toFixed(1)}`);
  } else if (rsi > 65) {
    score -= 2;
    reasons.push(`RSI overbought at ${rsi.toFixed(1)}`);
  } else if (rsi > 50) {
    score += 1;
    reasons.push(`RSI bullish at ${rsi.toFixed(1)}`);
  } else {
    score -= 0.5;
    reasons.push(`RSI bearish at ${rsi.toFixed(1)}`);
  }

  // MACD
  if (macd > macdSignal && hist > 0) {
    score += 1;
    reasons.push('MACD bullish crossover');
  } else if (macd < macdSignal && hist < 0) {
    score -= 1;
    reasons.push('MACD bearish crossover');
  }

  // Determine signal
  let signal = 'HOLD';
  if (score >= 3) signal = 'BUY';
  else if (score <= -3) signal = 'SELL';

  const confidence = Math.min(100, Math.abs(score) * 20);

  return {
    signal,
    score,
    confidence,
    price: currentPrice,
    ema9,
    ema21,
    rsi,
    macd,
    macdSignal,
    reasons,
  };
}

module.exports = { generateSignal, calcEMA, calcRSI, calcMACD };
