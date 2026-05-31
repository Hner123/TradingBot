const axios = require('axios');
const crypto = require('crypto');

/**
 * Binance USDⓈ-M Futures service.
 *
 * Mirrors the previous BybitService interface so server.js stays largely unchanged:
 * getKlines / getTicker / getBalance / getPositions / getAllOpenPositions /
 * getInstrumentInfo / setLeverage / placeOrder / closePosition.
 *
 * Demo (paper):  https://demo-fapi.binance.com   (Binance Demo Trading — demo.binance.com)
 * Mainnet:       https://fapi.binance.com
 *
 * Override the demo endpoint with env BINANCE_TESTNET_URL if Binance changes it.
 *
 * Notes vs Bybit:
 *  - Klines come oldest-first already (no reverse needed); close is index 4.
 *  - SL/TP are SEPARATE conditional orders (STOP_MARKET / TAKE_PROFIT_MARKET),
 *    not inline fields — placeOrder submits the entry then attaches them.
 *  - Signed requests: HMAC-SHA256 over the full query string; key in X-MBX-APIKEY.
 */

// Bybit-style interval codes (stored in DB) -> Binance interval strings
const INTERVAL_MAP = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m',
  '60': '1h', '120': '2h', '240': '4h', '360': '6h', '720': '12h',
  'D': '1d', 'W': '1w', 'M': '1M',
};

function mapInterval(interval) {
  return INTERVAL_MAP[interval] || interval; // allow native Binance codes too
}

class BinanceService {
  constructor(apiKey, apiSecret, testnet = true) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = testnet
      ? (process.env.BINANCE_TESTNET_URL || 'https://demo-fapi.binance.com')
      : 'https://fapi.binance.com';
    this.timeOffset = 0;
    this._timeSynced = false;
  }

  // ── Signing helpers ──────────────────────────────────────────────────────
  async _syncTime() {
    if (this._timeSynced) return;
    try {
      const res = await axios.get(`${this.baseUrl}/fapi/v1/time`);
      this.timeOffset = res.data.serverTime - Date.now();
      this._timeSynced = true;
    } catch (_) {
      this.timeOffset = 0; // best effort
    }
  }

  _sign(queryString) {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  async _signed(method, endpoint, params = {}) {
    await this._syncTime();
    const all = { ...params, timestamp: Date.now() + this.timeOffset, recvWindow: 5000 };
    const qs = new URLSearchParams(all).toString();
    const signature = this._sign(qs);
    const url = `${this.baseUrl}${endpoint}?${qs}&signature=${signature}`;
    const res = await axios({
      method,
      url,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });
    return res.data;
  }

  // ── Public market data ───────────────────────────────────────────────────
  async getKlines(symbol, interval = '240', limit = 200) {
    const res = await axios.get(`${this.baseUrl}/fapi/v1/klines`, {
      params: { symbol, interval: mapInterval(interval), limit },
    });
    // Binance returns oldest-first already; shape [openTime, o, h, l, c, v, ...]
    return res.data;
  }

  async getTicker(symbol) {
    const res = await axios.get(`${this.baseUrl}/fapi/v1/ticker/24hr`, {
      params: { symbol },
    });
    const t = res.data;
    return {
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      // Binance gives percent (e.g. "2.5"); normalize to fraction to match prior Bybit semantics
      price24hPcnt: String(parseFloat(t.priceChangePercent) / 100),
      volume24h: t.volume,
    };
  }

  // ── Account ───────────────────────────────────────────────────────────────
  async getBalance() {
    const acct = await this._signed('GET', '/fapi/v2/account');
    // Normalize to the shape server.js expects (Bybit-style)
    return {
      result: {
        list: [{
          totalWalletBalance: acct.totalWalletBalance,
          totalAvailableBalance: acct.availableBalance,
          totalPerpUPL: acct.totalUnrealizedProfit,
        }],
      },
    };
  }

  async getPositions(symbol) {
    const list = await this._signed('GET', '/fapi/v2/positionRisk', { symbol });
    const p = Array.isArray(list) ? list[0] : null;
    const size = p ? Math.abs(parseFloat(p.positionAmt)) : 0;
    return {
      result: {
        list: [{
          size,
          side: p && parseFloat(p.positionAmt) < 0 ? 'Sell' : 'Buy',
          entryPrice: p?.entryPrice,
        }],
      },
    };
  }

  async getAllOpenPositions() {
    const list = await this._signed('GET', '/fapi/v2/positionRisk');
    return (Array.isArray(list) ? list : [])
      .filter((p) => Math.abs(parseFloat(p.positionAmt)) > 0)
      .map((p) => ({ symbol: p.symbol, size: Math.abs(parseFloat(p.positionAmt)) }));
  }

  async getInstrumentInfo(symbol) {
    const res = await axios.get(`${this.baseUrl}/fapi/v1/exchangeInfo`, {
      params: { symbol },
    });
    const info = (res.data?.symbols || []).find((s) => s.symbol === symbol);
    if (!info) throw new Error(`No instrument info for ${symbol}`);
    const lot = info.filters.find((f) => f.filterType === 'LOT_SIZE') || {};
    const priceFilter = info.filters.find((f) => f.filterType === 'PRICE_FILTER') || {};
    return {
      symbol: info.symbol,
      qtyStep: parseFloat(lot.stepSize || '0.001'),
      minOrderQty: parseFloat(lot.minQty || '0.001'),
      tickSize: parseFloat(priceFilter.tickSize || '0.01'),
    };
  }

  async setLeverage(symbol, leverage) {
    return await this._signed('POST', '/fapi/v1/leverage', {
      symbol,
      leverage: parseInt(leverage, 10),
    });
  }

  // ── Orders ──────────────────────────────────────────────────────────────
  async placeOrder({ symbol, side, qty, stopLoss, takeProfit }) {
    const orderSide = side === 'BUY' ? 'BUY' : 'SELL';
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

    let entry;
    try {
      entry = await this._signed('POST', '/fapi/v1/order', {
        symbol,
        side: orderSide,
        type: 'MARKET',
        quantity: String(qty),
      });
    } catch (e) {
      const data = e.response?.data;
      return { retCode: data?.code || -1, retMsg: data?.msg || e.message, result: {} };
    }

    // Attach SL / TP as reduce-only conditional close orders (best effort)
    const attached = {};
    if (stopLoss) {
      try {
        const sl = await this._signed('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: 'STOP_MARKET',
          stopPrice: String(stopLoss), closePosition: 'true', workingType: 'MARK_PRICE',
        });
        attached.stopOrderId = sl.orderId;
      } catch (e) { attached.stopError = e.response?.data?.msg || e.message; }
    }
    if (takeProfit) {
      try {
        const tp = await this._signed('POST', '/fapi/v1/order', {
          symbol, side: closeSide, type: 'TAKE_PROFIT_MARKET',
          stopPrice: String(takeProfit), closePosition: 'true', workingType: 'MARK_PRICE',
        });
        attached.takeProfitOrderId = tp.orderId;
      } catch (e) { attached.tpError = e.response?.data?.msg || e.message; }
    }

    return { retCode: 0, retMsg: 'OK', result: { orderId: entry.orderId, ...attached } };
  }

  async closePosition(symbol, side, qty) {
    return await this._signed('POST', '/fapi/v1/order', {
      symbol,
      side: side === 'BUY' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: String(qty),
      reduceOnly: 'true',
    });
  }
}

module.exports = BinanceService;
module.exports.mapInterval = mapInterval;
module.exports.INTERVAL_MAP = INTERVAL_MAP;
