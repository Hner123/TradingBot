/**
 * Aegis 1H Trend Pullback Strategy.
 *
 * Rule layer: checks trend, pullback, momentum, candle, volume, and risk.
 * Scoring layer: converts those checks into a 0-100 confidence score.
 *
 * The module accepts 1H candles and derives 4H candles internally so it can fit
 * the existing single-series backtester without a second data feed.
 */

const { calcEMA, calcRSI } = require('./signals');

const DEFAULT_CONFIG = {
  emaShort: 20,
  emaMedium: 50,
  emaLong: 200,
  rsiPeriod: 14,
  atrPeriod: 14,
  volumeMAPeriod: 20,
  minimumConfidenceScore: 70,
  strongSignalScore: 80,
  minimumRiskReward: 2,
  defaultRiskPercent: 1,
  maxRiskPercent: 1,
  accountBalance: 1000,
  maxStopAtr: 3,
  nearAtrMultiple: 0.65,
  useAIConfirmation: true,
  useNewsFilter: false,
  use15mEntry: false,
};

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function close(c) { return parseFloat(c[4]); }
function high(c) { return parseFloat(c[2]); }
function low(c) { return parseFloat(c[3]); }
function open(c) { return parseFloat(c[1]); }
function volume(c) { return parseFloat(c[5] || 0); }

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = high(candles[i]);
    const l = low(candles[i]);
    const prevClose = close(candles[i - 1]);
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  return avg(trs.slice(-period));
}

function aggregateTo4h(candles) {
  const out = [];
  for (let i = 0; i + 3 < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    out.push([
      chunk[0][0],
      chunk[0][1],
      String(Math.max(...chunk.map(high))),
      String(Math.min(...chunk.map(low))),
      chunk[chunk.length - 1][4],
      String(chunk.reduce((sum, c) => sum + volume(c), 0)),
    ]);
  }
  return out;
}

function recentSwingLow(candles, lookback = 12) {
  return Math.min(...candles.slice(-lookback).map(low));
}

function recentSwingHigh(candles, lookback = 12) {
  return Math.max(...candles.slice(-lookback).map(high));
}

function marketStructure(candles, direction) {
  const recent = candles.slice(-40);
  if (recent.length < 40) return false;
  const first = recent.slice(0, 20);
  const last = recent.slice(20);
  const firstHigh = Math.max(...first.map(high));
  const firstLow = Math.min(...first.map(low));
  const lastHigh = Math.max(...last.map(high));
  const lastLow = Math.min(...last.map(low));
  return direction === 'BUY'
    ? lastHigh >= firstHigh && lastLow >= firstLow
    : lastHigh <= firstHigh && lastLow <= firstLow;
}

function isNear(value, level, atr, pct = 0.006, atrMultiple = 0.65) {
  if (!level || !value) return false;
  const distance = Math.abs(value - level);
  return distance <= Math.max(value * pct, atr * atrMultiple);
}

function bullishConfirmation(candles) {
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = close(c) - open(c);
  const range = high(c) - low(c);
  const engulf = close(c) > open(p) && open(c) <= close(p) && close(p) < open(p);
  const strongClose = body > 0 && range > 0 && body / range >= 0.55 && close(c) > (low(c) + range * 0.65);
  const brokePrevHigh = close(c) > high(p);
  return engulf || strongClose || brokePrevHigh;
}

function bearishConfirmation(candles) {
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const body = open(c) - close(c);
  const range = high(c) - low(c);
  const engulf = close(c) < open(p) && open(c) >= close(p) && close(p) > open(p);
  const strongClose = body > 0 && range > 0 && body / range >= 0.55 && close(c) < (low(c) + range * 0.35);
  const brokePrevLow = close(c) < low(p);
  return engulf || strongClose || brokePrevLow;
}

function assessRules(candles, config, side) {
  const closes = candles.map(close);
  const price = closes[closes.length - 1];
  const ema20 = calcEMA(closes, config.emaShort);
  const ema50 = calcEMA(closes, config.emaMedium);
  const rsi = calcRSI(closes, config.rsiPeriod);
  const prevRsi = calcRSI(closes.slice(0, -1), config.rsiPeriod);
  const atr = calcATR(candles, config.atrPeriod);
  const vol = volume(candles[candles.length - 1]);
  const volMA = avg(candles.slice(-config.volumeMAPeriod).map(volume));
  const prevVol = volume(candles[candles.length - 2]);
  const swingLow = recentSwingLow(candles);
  const swingHigh = recentSwingHigh(candles);
  const recentSupport = recentSwingLow(candles, 30);
  const recentResistance = recentSwingHigh(candles, 30);
  const candles4h = aggregateTo4h(candles);
  const closes4h = candles4h.map(close);

  if (candles4h.length < config.emaLong + 5 || atr <= 0) {
    return { enoughData: false, price, atr, reason: ['Not enough 1H/derived 4H history for Aegis.'] };
  }

  const ema50_4h = calcEMA(closes4h, config.emaMedium);
  const ema200_4h = calcEMA(closes4h, config.emaLong);
  const close4h = closes4h[closes4h.length - 1];
  const nearCross = Math.abs(ema50_4h - ema200_4h) / ema200_4h <= 0.01;

  const bullishTrend = close4h > ema200_4h && (ema50_4h > ema200_4h || nearCross);
  const bearishTrend = close4h < ema200_4h && (ema50_4h < ema200_4h || nearCross);
  const trendOk = side === 'BUY' ? bullishTrend : bearishTrend;
  const structureOk = marketStructure(candles4h, side);

  const pullbackBuy = (low(candles[candles.length - 1]) <= ema20 || isNear(price, ema20, atr, 0.006, config.nearAtrMultiple) ||
    isNear(price, ema50, atr, 0.008, config.nearAtrMultiple) || isNear(price, recentSupport, atr, 0.006, config.nearAtrMultiple)) &&
    price >= ema50 * 0.985;
  const pullbackSell = (high(candles[candles.length - 1]) >= ema20 || isNear(price, ema20, atr, 0.006, config.nearAtrMultiple) ||
    isNear(price, ema50, atr, 0.008, config.nearAtrMultiple) || isNear(price, recentResistance, atr, 0.006, config.nearAtrMultiple)) &&
    price <= ema50 * 1.015;
  const pullbackOk = side === 'BUY' ? pullbackBuy : pullbackSell;

  const momentumOk = side === 'BUY'
    ? rsi >= 40 && rsi <= 62 && rsi >= prevRsi && rsi > 40
    : rsi >= 38 && rsi <= 60 && rsi <= prevRsi && rsi < 60;

  const candleOk = side === 'BUY' ? bullishConfirmation(candles) : bearishConfirmation(candles);
  const volumeOk = vol >= volMA || vol > prevVol;

  const entry = price;
  const stop = side === 'BUY'
    ? Math.min(swingLow - atr * 0.1, entry - atr)
    : Math.max(swingHigh + atr * 0.1, entry + atr);
  const risk = Math.abs(entry - stop);
  const stopAtr = risk / atr;
  const tp1 = side === 'BUY'
    ? entry + risk * config.minimumRiskReward
    : entry - risk * config.minimumRiskReward;
  const tp2 = side === 'BUY'
    ? entry + risk * 3
    : entry - risk * 3;
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  const rrOk = rr >= config.minimumRiskReward;
  const stopOk = risk > 0 && stopAtr <= config.maxStopAtr;

  const chop = Math.abs(ema20 - ema50) / price < 0.0015 && Math.abs(close4h - ema200_4h) / ema200_4h < 0.01;
  const overextended = side === 'BUY' ? rsi > 72 : rsi < 28;
  const cleanMarket = !chop && !overextended;

  const reasons = [];
  const invalid = [];
  if (trendOk) reasons.push(`4H trend is ${side === 'BUY' ? 'bullish' : 'bearish'} and aligned with EMA200.`);
  else invalid.push('4H trend is not aligned.');
  if (structureOk) reasons.push(`4H market structure supports ${side}.`);
  if (pullbackOk) reasons.push(`1H price pulled back near EMA/support-resistance zone.`);
  else invalid.push('No clean 1H pullback.');
  if (momentumOk) reasons.push(`RSI momentum is acceptable at ${rsi.toFixed(1)}.`);
  else invalid.push(`RSI momentum is not aligned (${rsi.toFixed(1)}).`);
  if (candleOk) reasons.push(`${side === 'BUY' ? 'Bullish' : 'Bearish'} candle confirmation appeared.`);
  else invalid.push('No candle confirmation.');
  if (volumeOk) reasons.push('Volume confirms or is improving.');
  else invalid.push('Volume is weak.');
  if (rrOk) reasons.push(`Reward-to-risk is at least ${config.minimumRiskReward}:1.`);
  else invalid.push('Reward-to-risk is below minimum.');
  if (!stopOk) invalid.push(`Stop is too wide at ${stopAtr.toFixed(2)} ATR.`);
  if (!cleanMarket) invalid.push('Market is choppy or overextended.');

  return {
    enoughData: true,
    side,
    price,
    entry,
    stop,
    tp1,
    tp2,
    rr,
    atr,
    stopAtr,
    ema20,
    ema50,
    ema50_4h,
    ema200_4h,
    rsi,
    checks: {
      trendOk,
      structureOk,
      pullbackOk,
      momentumOk,
      candleOk,
      volumeOk,
      rrOk,
      stopOk,
      cleanMarket,
    },
    reasons,
    invalid,
  };
}

function scoreRules(rules) {
  if (!rules.enoughData) return 0;
  let score = 0;
  if (rules.checks.trendOk) score += 20;
  if (rules.checks.structureOk) score += 5;
  if (rules.checks.pullbackOk) score += 20;
  if (rules.checks.momentumOk) score += 10;
  if (rules.checks.candleOk) score += 15;
  if (rules.checks.volumeOk) score += 10;
  if (rules.checks.rrOk && rules.checks.stopOk) score += 15;
  if (rules.checks.cleanMarket) score += 5;
  return Math.max(0, Math.min(100, score));
}

function buildResult(candles, side, rules, score, config, symbol) {
  const signal = score >= config.minimumConfidenceScore ? side : 'HOLD';
  const riskPercent = Math.min(config.defaultRiskPercent, config.maxRiskPercent);
  const riskAmount = config.accountBalance * (riskPercent / 100);
  const riskPerUnit = rules.stop ? Math.abs(rules.entry - rules.stop) : 0;
  const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;

  return {
    strategyName: 'Aegis 1H Trend Pullback Strategy',
    symbol: symbol || '',
    timeframe: '1H',
    signal,
    rawSignal: signal === 'HOLD' ? 'NO TRADE' : signal,
    confidence: score,
    confidenceScore: score,
    signalStrength: score >= config.strongSignalScore ? 'Strong' : score >= config.minimumConfidenceScore ? 'Moderate' : 'No Trade',
    price: rules.price,
    entryPrice: rules.entry || rules.price,
    stopLoss: rules.stop || null,
    takeProfit1: rules.tp1 || null,
    takeProfit2: rules.tp2 || null,
    riskRewardRatio: rules.rr || 0,
    riskPercent,
    positionSizeSuggestion: positionSize,
    reason: rules.reasons || [],
    invalidationReason: signal === 'HOLD'
      ? (rules.invalid || ['Aegis confidence score is below threshold.']).join(' ')
      : `Signal becomes invalid if price closes beyond the recent 1H swing ${side === 'BUY' ? 'low' : 'high'} or the 4H trend breaks EMA200.`,
    timestamp: new Date(parseInt(candles[candles.length - 1][0], 10)).toISOString(),
    ema9: 0,
    ema21: 0,
    rsi: rules.rsi || 0,
    macd: 0,
    macdSignal: 0,
    atr: rules.atr || 0,
  };
}

function noTrade(candles, confidence, reasons, symbol) {
  const price = candles.length ? close(candles[candles.length - 1]) : 0;
  return {
    strategyName: 'Aegis 1H Trend Pullback Strategy',
    symbol: symbol || '',
    timeframe: '1H',
    signal: 'HOLD',
    rawSignal: 'NO TRADE',
    confidence,
    confidenceScore: confidence,
    signalStrength: 'No Trade',
    price,
    entryPrice: price,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    riskRewardRatio: 0,
    riskPercent: DEFAULT_CONFIG.defaultRiskPercent,
    positionSizeSuggestion: 0,
    reason: [],
    invalidationReason: reasons.join(' '),
    timestamp: candles.length ? new Date(parseInt(candles[candles.length - 1][0], 10)).toISOString() : new Date().toISOString(),
    ema9: 0,
    ema21: 0,
    rsi: 0,
    macd: 0,
    macdSignal: 0,
    atr: 0,
  };
}

function generateSignal(candles, opts = {}) {
  const config = { ...DEFAULT_CONFIG, ...opts };
  if (!Array.isArray(candles) || candles.length < 820) {
    return noTrade(candles || [], 0, ['Not enough 1H candles for 4H EMA200 trend filter.'], opts.symbol);
  }

  const buyRules = assessRules(candles, config, 'BUY');
  const sellRules = assessRules(candles, config, 'SELL');
  const buyScore = scoreRules(buyRules);
  const sellScore = scoreRules(sellRules);

  const side = buyScore >= sellScore ? 'BUY' : 'SELL';
  const bestRules = side === 'BUY' ? buyRules : sellRules;
  const bestScore = Math.max(buyScore, sellScore);

  if (bestScore < config.minimumConfidenceScore) {
    const invalid = bestRules.invalid || ['Aegis confidence score is below threshold.'];
    return buildResult(candles, side, bestRules, bestScore, config, opts.symbol);
  }

  return buildResult(candles, side, bestRules, bestScore, config, opts.symbol);
}

module.exports = {
  generateSignal,
  scoreRules,
  assessRules,
  DEFAULT_CONFIG,
};
