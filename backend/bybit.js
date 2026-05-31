const axios = require('axios');
const crypto = require('crypto');

class BybitService {
  constructor(apiKey, apiSecret, testnet = true) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseUrl = testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
  }

  _sign(params) {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const queryStr = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const signPayload = `${timestamp}${this.apiKey}${recvWindow}${queryStr}`;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(signPayload)
      .digest('hex');
    return { timestamp, recvWindow, signature };
  }

  async _get(endpoint, params = {}) {
    const { timestamp, recvWindow, signature } = this._sign(params);
    const query = new URLSearchParams({ ...params }).toString();
    const res = await axios.get(`${this.baseUrl}${endpoint}?${query}`, {
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
    });
    return res.data;
  }

  async _post(endpoint, body = {}) {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const bodyStr = JSON.stringify(body);
    const signPayload = `${timestamp}${this.apiKey}${recvWindow}${bodyStr}`;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(signPayload)
      .digest('hex');
    const res = await axios.post(`${this.baseUrl}${endpoint}`, body, {
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'Content-Type': 'application/json',
      },
    });
    return res.data;
  }

  // Get OHLCV candles
  async getKlines(symbol, interval = '240', limit = 200) {
    const data = await axios.get(`${this.baseUrl}/v5/market/kline`, {
      params: { category: 'linear', symbol, interval, limit },
    });
    return data.data.result.list.reverse(); // oldest first
  }

  // Get ticker price
  async getTicker(symbol) {
    const data = await axios.get(`${this.baseUrl}/v5/market/tickers`, {
      params: { category: 'linear', symbol },
    });
    return data.data.result.list[0];
  }

  // Get wallet balance
  async getBalance() {
    return await this._get('/v5/account/wallet-balance', {
      accountType: 'UNIFIED',
    });
  }

  // Get open positions for a symbol
  async getPositions(symbol) {
    return await this._get('/v5/position/list', {
      category: 'linear',
      symbol,
    });
  }

  // Get all open USDT-perp positions (for max-open-trades enforcement)
  async getAllOpenPositions() {
    const res = await this._get('/v5/position/list', {
      category: 'linear',
      settleCoin: 'USDT',
    });
    const list = res?.result?.list || [];
    return list.filter((p) => parseFloat(p.size) > 0);
  }

  // Get instrument info (qtyStep, minOrderQty, etc.) — public endpoint
  async getInstrumentInfo(symbol) {
    const res = await axios.get(`${this.baseUrl}/v5/market/instruments-info`, {
      params: { category: 'linear', symbol },
    });
    const info = res.data?.result?.list?.[0];
    if (!info) throw new Error(`No instrument info for ${symbol}`);
    return {
      symbol: info.symbol,
      qtyStep: parseFloat(info.lotSizeFilter?.qtyStep || '0.001'),
      minOrderQty: parseFloat(info.lotSizeFilter?.minOrderQty || '0.001'),
      tickSize: parseFloat(info.priceFilter?.tickSize || '0.01'),
    };
  }

  // Set leverage on a symbol (both buy and sell side, same value)
  async setLeverage(symbol, leverage) {
    return await this._post('/v5/position/set-leverage', {
      category: 'linear',
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
  }

  // Place order
  async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit }) {
    return await this._post('/v5/order/create', {
      category: 'linear',
      symbol,
      side: side === 'BUY' ? 'Buy' : 'Sell',
      orderType: 'Market',
      qty: String(qty),
      stopLoss: stopLoss ? String(stopLoss) : undefined,
      takeProfit: takeProfit ? String(takeProfit) : undefined,
      timeInForce: 'GoodTillCancel',
    });
  }

  // Close position
  async closePosition(symbol, side, qty) {
    return await this._post('/v5/order/create', {
      category: 'linear',
      symbol,
      side: side === 'BUY' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty: String(qty),
      reduceOnly: true,
      timeInForce: 'GoodTillCancel',
    });
  }
}

module.exports = BybitService;
