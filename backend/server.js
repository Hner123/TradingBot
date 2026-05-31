require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./db');
const BinanceService = require('./binance');
const { generateSignal } = require('./signals');
const { runBacktest } = require('./backtest-core');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(cors());
app.use(express.json());

// ─── WebSocket Broadcast ─────────────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({ type: 'connected', data: { msg: 'Bot connected' } }));
  ws.on('close', () => console.log('Client disconnected'));
});

// ─── Helper: get active config ───────────────────────────────────────────────
async function getConfig() {
  const [rows] = await db.query('SELECT * FROM bot_config WHERE id = 1');
  const config = rows[0] || {};
  // .env can supply exchange keys (takes priority over DB) — convenient for single-user setups.
  // Leave these unset to manage keys from the Settings UI instead.
  if (process.env.BINANCE_API_KEY) config.api_key = process.env.BINANCE_API_KEY;
  if (process.env.BINANCE_API_SECRET) config.api_secret = process.env.BINANCE_API_SECRET;
  if (process.env.BINANCE_TESTNET !== undefined) {
    config.testnet = process.env.BINANCE_TESTNET !== '0' && process.env.BINANCE_TESTNET !== 'false';
  }
  return config;
}

function getExchange(config) {
  return new BinanceService(config.api_key, config.api_secret, config.testnet);
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/config
app.get('/api/config', async (req, res) => {
  try {
    const config = await getConfig();
    // Mask secret
    if (config) config.api_secret = config.api_secret ? '••••••••' : '';
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/config
const ALLOWED_CONFIG_FIELDS = new Set([
  'api_key', 'api_secret', 'testnet', 'trading_pair', 'timeframe',
  'risk_per_trade', 'take_profit', 'stop_loss', 'leverage',
  'max_open_trades', 'is_active', 'auto_trade',
]);

app.put('/api/config', async (req, res) => {
  try {
    const fields = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (!ALLOWED_CONFIG_FIELDS.has(k)) continue;
      if (k === 'api_secret' && (v === '' || v === '••••••••')) continue;
      fields[k] = v;
    }
    if (Object.keys(fields).length === 0) {
      return res.json({ success: true, updated: 0 });
    }
    const sets = Object.keys(fields).map((k) => `\`${k}\` = ?`).join(', ');
    const vals = Object.values(fields);
    await db.query(`UPDATE bot_config SET ${sets} WHERE id = 1`, vals);
    res.json({ success: true, updated: Object.keys(fields).length });
    broadcast('config_updated', fields);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bot/start
app.post('/api/bot/start', async (req, res) => {
  try {
    await db.query('UPDATE bot_config SET is_active = TRUE WHERE id = 1');
    broadcast('bot_status', { active: true });
    res.json({ success: true, active: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bot/stop
app.post('/api/bot/stop', async (req, res) => {
  try {
    await db.query('UPDATE bot_config SET is_active = FALSE WHERE id = 1');
    broadcast('bot_status', { active: false });
    res.json({ success: true, active: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/trades
app.get('/api/trades', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM trades ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/signals
app.get('/api/signals', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM signals ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/portfolio
app.get('/api/portfolio', async (req, res) => {
  try {
    const config = await getConfig();
    if (!config.api_key) return res.json({ balance: 0, pnl: 0 });
    const bybit = getExchange(config);
    const data = await bybit.getBalance();
    const wallet = data?.result?.list?.[0];
    res.json({
      totalBalance: parseFloat(wallet?.totalWalletBalance || 0),
      availableBalance: parseFloat(wallet?.totalAvailableBalance || 0),
      unrealizedPnl: parseFloat(wallet?.totalPerpUPL || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/watchlist
app.get('/api/watchlist', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM watchlist WHERE is_active = TRUE');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/watchlist
app.post('/api/watchlist', async (req, res) => {
  try {
    const { symbol } = req.body;
    await db.query(
      'INSERT INTO watchlist (symbol) VALUES (?) ON DUPLICATE KEY UPDATE is_active = TRUE',
      [symbol.toUpperCase()]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ticker/:symbol
app.get('/api/ticker/:symbol', async (req, res) => {
  try {
    const config = await getConfig();
    const bybit = getExchange(config);
    const ticker = await bybit.getTicker(req.params.symbol);
    res.json(ticker);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/klines/:symbol
app.get('/api/klines/:symbol', async (req, res) => {
  try {
    const config = await getConfig();
    const bybit = getExchange(config);
    const klines = await bybit.getKlines(
      req.params.symbol,
      req.query.interval || '240',
      100
    );
    res.json(klines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/signal/analyze
app.post('/api/signal/analyze', async (req, res) => {
  try {
    const { symbol, force } = req.body;
    const config = await getConfig();
    const bybit = getExchange(config);
    const klines = await bybit.getKlines(symbol, config.timeframe, 100);
    const result = generateSignal(klines);

    await db.query(
      `INSERT INTO signals (symbol, timeframe, \`signal\`, ema_9, ema_21, rsi, macd, macd_signal, price, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        symbol,
        config.timeframe,
        result.signal,
        result.ema9,
        result.ema21,
        result.rsi,
        result.macd,
        result.macdSignal,
        result.price,
        result.confidence,
      ]
    );

    broadcast('signal', { symbol, ...result });

    // If auto_trade is on (or caller forces it), execute the trade immediately
    let trade = null;
    if (
      result.signal !== 'HOLD' &&
      result.confidence >= 60 &&
      (config.auto_trade || force)
    ) {
      try {
        trade = await executeTrade(bybit, config, symbol, result.signal, broadcast);
      } catch (tradeErr) {
        trade = { error: tradeErr.message };
        console.error(`[BOT] manual scan trade failed for ${symbol}:`, tradeErr.message);
      }
    }

    res.json({ ...result, trade });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/trade/manual — place a market order on demand (BUY or SELL)
app.post('/api/trade/manual', async (req, res) => {
  try {
    const { symbol, side } = req.body;
    if (!symbol || !['BUY', 'SELL'].includes(side)) {
      return res.status(400).json({ error: 'symbol and side (BUY|SELL) required' });
    }
    const config = await getConfig();
    if (!config.api_key) {
      return res.status(400).json({ error: 'API key not configured' });
    }
    const bybit = getExchange(config);
    const outcome = await executeTrade(bybit, config, symbol, side, broadcast);
    res.json(outcome);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/trade/close — close an open position (reduce-only market) and settle the trade row
app.post('/api/trade/close', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });

    const config = await getConfig();
    if (!config.api_key) return res.status(400).json({ error: 'API key not configured' });

    const exchange = getExchange(config);

    // Live position on the exchange
    const pos = await exchange.getPositions(symbol);
    const live = pos?.result?.list?.[0];
    const size = parseFloat(live?.size || '0');
    if (size <= 0) {
      // Nothing open on the exchange — just settle any stale OPEN rows
      await db.query(
        `UPDATE trades SET status = 'CLOSED', closed_at = NOW() WHERE symbol = ? AND status = 'OPEN'`,
        [symbol]
      );
      return res.json({ closed: true, note: 'no live position; settled open rows' });
    }

    const side = live.side === 'Sell' ? 'SELL' : 'BUY'; // direction we are currently holding
    const closeOrder = await exchange.closePosition(symbol, side, size);

    // Exit price from current ticker
    const ticker = await exchange.getTicker(symbol);
    const exitPrice = parseFloat(ticker.lastPrice);

    // Settle the most recent OPEN row for this symbol
    const [[openRow]] = await db.query(
      `SELECT * FROM trades WHERE symbol = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
      [symbol]
    );

    let pnl = 0, pnlPercent = 0;
    if (openRow) {
      const entry = parseFloat(openRow.entry_price);
      const qty = parseFloat(openRow.quantity);
      const dir = openRow.side === 'BUY' ? 1 : -1;
      const gross = (exitPrice - entry) * dir * qty;
      const fee = parseFloat(openRow.estimated_fee || 0);
      pnl = gross - fee;
      pnlPercent = entry > 0 ? ((exitPrice - entry) / entry) * 100 * dir : 0;
      await db.query(
        `UPDATE trades SET exit_price = ?, pnl = ?, pnl_percent = ?, status = 'CLOSED', closed_at = NOW() WHERE id = ?`,
        [exitPrice, pnl, pnlPercent, openRow.id]
      );
    }

    broadcast('trade_closed', { symbol, exitPrice, pnl, pnlPercent });
    console.log(`[BOT] ✖ Closed ${symbol} @ ${exitPrice} → PnL $${pnl.toFixed(4)} (${pnlPercent.toFixed(2)}%)`);
    res.json({ closed: true, symbol, exitPrice, pnl, pnlPercent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Strategy library (custom, user-saved) ───────────────────────────────────
app.get('/api/strategies', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM strategies ORDER BY created_at DESC');
    const out = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      created_at: r.created_at,
      ...(typeof r.config === 'string' ? JSON.parse(r.config) : r.config),
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/strategies', async (req, res) => {
  try {
    const { name, description, ...config } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const [r] = await db.query(
      'INSERT INTO strategies (name, description, config) VALUES (?, ?, ?)',
      [name, description || '', JSON.stringify(config)]
    );
    res.json({ success: true, id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/strategies/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM strategies WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/backtest — run a backtest and return summary + trades + equity curve
const DURATION_DAYS = { '3m': 91, '6m': 182, '1y': 365, '2y': 730, '3y': 1095, '5y': 1825 };
app.post('/api/backtest', async (req, res) => {
  try {
    const b = req.body || {};
    // period can be a duration ("2y") or a specific calendar year ("y2023")
    let year = null, days;
    if (/^y\d{4}$/.test(b.period || '')) year = parseInt(b.period.slice(1), 10);
    else days = DURATION_DAYS[b.period] || b.days || 730;
    const result = await runBacktest({
      year,
      symbol: b.symbol || 'BTCUSDT',
      timeframe: b.timeframe || '240',
      days,
      engine: b.engine || 'meanrev',
      reverse: !!b.reverse,
      tp: parseFloat(b.tp || 0),
      sl: parseFloat(b.sl || 0),
      exitMode: b.exitMode || 'macd',
      useBBExit: b.useBBExit !== false,
      trailPercent: parseFloat(b.trailPercent || 0),
      conf: parseInt(b.conf || 60, 10),
      startBalance: parseFloat(b.startBalance || 100),
      leverage: parseInt(b.leverage || 10, 10),
      sizing: b.sizing || 'martingale',
      fixedNotional: parseFloat(b.fixedNotional || 0),
      riskPct: parseFloat(b.riskPct || 1),
      martBase: parseFloat(b.martBase || 15),
      martInc: parseFloat(b.martInc || 5),
      martCap: parseInt(b.martCap || 8, 10),
      martStart: parseInt(b.martStart || 1, 10),
      feeMode: b.feeMode || 'taker',
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const [[totals]] = await db.query(`
      SELECT 
        COUNT(*) AS total_trades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS winning_trades,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS losing_trades,
        ROUND(SUM(pnl), 4) AS total_pnl,
        ROUND(AVG(pnl_percent), 2) AS avg_pnl_percent
      FROM trades WHERE status = 'CLOSED'
    `);
    const winRate = totals.total_trades > 0
      ? ((totals.winning_trades / totals.total_trades) * 100).toFixed(1)
      : 0;
    res.json({ ...totals, win_rate: winRate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Trade Execution Helpers ─────────────────────────────────────────────────
const instrumentCache = new Map();
const leverageSet = new Map(); // symbol -> leverage value last pushed

async function getInstrument(bybit, symbol) {
  if (!instrumentCache.has(symbol)) {
    instrumentCache.set(symbol, await bybit.getInstrumentInfo(symbol));
  }
  return instrumentCache.get(symbol);
}

function roundDownToStep(value, step) {
  return Math.floor(value / step) * step;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function fmt(value, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toFixed(decimals);
}

async function executeTrade(bybit, config, symbol, signal, broadcastFn) {
  // Already in a position on this symbol? Skip.
  const existing = await bybit.getPositions(symbol);
  const existingSize = parseFloat(existing?.result?.list?.[0]?.size || '0');
  if (existingSize > 0) {
    return { skipped: 'already in position' };
  }

  // Max open trades cap
  const openPositions = await bybit.getAllOpenPositions();
  if (openPositions.length >= config.max_open_trades) {
    return { skipped: `max_open_trades (${config.max_open_trades}) reached` };
  }

  // Get balance for sizing
  const balanceRes = await bybit.getBalance();
  const wallet = balanceRes?.result?.list?.[0];
  const available = parseFloat(wallet?.totalAvailableBalance || '0');
  if (available <= 0) {
    return { skipped: 'no available balance' };
  }

  // Push leverage if not yet set this session
  const lev = parseInt(config.leverage, 10) || 1;
  if (leverageSet.get(symbol) !== lev) {
    try {
      await bybit.setLeverage(symbol, lev);
    } catch (e) {
      // 110043 = leverage not modified — safe to ignore
      if (!/not modified|110043/i.test(e.message)) throw e;
    }
    leverageSet.set(symbol, lev);
  }

  const inst = await getInstrument(bybit, symbol);
  const ticker = await bybit.getTicker(symbol);
  const price = parseFloat(ticker.lastPrice);

  // Risk-based position sizing (margin scaled by leverage)
  const riskUsdt = available * (parseFloat(config.risk_per_trade) / 100);
  const stopDistance = price * (parseFloat(config.stop_loss) / 100);
  const rawQty = riskUsdt / stopDistance;
  const qty = roundDownToStep(rawQty, inst.qtyStep);

  if (qty < inst.minOrderQty) {
    return { skipped: `qty ${qty} below minOrderQty ${inst.minOrderQty}` };
  }

  const sl = signal === 'BUY'
    ? price * (1 - config.stop_loss / 100)
    : price * (1 + config.stop_loss / 100);
  const tp = signal === 'BUY'
    ? price * (1 + config.take_profit / 100)
    : price * (1 - config.take_profit / 100);

  const order = await bybit.placeOrder({
    symbol,
    side: signal,
    qty: fmt(qty, inst.qtyStep),
    stopLoss: fmt(roundToStep(sl, inst.tickSize), inst.tickSize),
    takeProfit: fmt(roundToStep(tp, inst.tickSize), inst.tickSize),
  });

  if (order.retCode !== 0) {
    throw new Error(`Binance order failed (${order.retCode}): ${order.retMsg}`);
  }

  // Binance USDⓈ-M Futures taker fee = 0.04%. Market entry + triggered SL/TP are taker.
  // Estimate round-trip fee at entry price (good enough for accounting; TP/SL prices are close)
  const TAKER_FEE = 0.0004;
  const notional = price * qty;
  const estimatedFee = notional * TAKER_FEE * 2; // entry + exit

  await db.query(
    `INSERT INTO trades (order_id, symbol, side, entry_price, quantity, stop_loss, take_profit, estimated_fee, status, signal_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
    [order.result?.orderId, symbol, signal, price, qty, sl, tp, estimatedFee, 'AUTO']
  );

  broadcastFn('trade_executed', {
    symbol, side: signal, qty, price, sl, tp, orderId: order.result?.orderId,
    notional, estimatedFee,
  });
  console.log(`[BOT] ✅ ${signal} ${symbol} qty=${qty} @ ${price} SL=${sl.toFixed(2)} TP=${tp.toFixed(2)} (est. fee $${estimatedFee.toFixed(4)})`);
  return {
    executed: true,
    orderId: order.result?.orderId,
    qty,
    price,
    sl,
    tp,
    notional,
    estimatedFee,
  };
}

// ─── Bot Loop (runs every 30 sec via cron) ───────────────────────────────────
cron.schedule('*/30 * * * * *', async () => {
  try {
    const config = await getConfig();
    if (!config.is_active || !config.api_key) return;

    const [watchlist] = await db.query(
      'SELECT symbol FROM watchlist WHERE is_active = TRUE'
    );
    const bybit = getExchange(config);

    for (const { symbol } of watchlist) {
      try {
        const klines = await bybit.getKlines(symbol, config.timeframe, 100);
        const result = generateSignal(klines);

        await db.query(
          `INSERT INTO signals (symbol, timeframe, \`signal\`, ema_9, ema_21, rsi, macd, macd_signal, price, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [symbol, config.timeframe, result.signal, result.ema9, result.ema21,
           result.rsi, result.macd, result.macdSignal, result.price, result.confidence]
        );

        broadcast('signal', { symbol, ...result });

        if (result.signal !== 'HOLD' && result.confidence >= 60) {
          broadcast('trade_signal', { symbol, signal: result.signal, price: result.price });
          console.log(`[BOT] ${result.signal} signal for ${symbol} at ${result.price} (confidence ${result.confidence}%)`);

          if (config.auto_trade) {
            const outcome = await executeTrade(bybit, config, symbol, result.signal, broadcast);
            if (outcome.skipped) {
              console.log(`[BOT] skipped ${symbol}: ${outcome.skipped}`);
            }
          }
        }
      } catch (symErr) {
        console.error(`[BOT] ${symbol} error:`, symErr.message);
        broadcast('error', { symbol, msg: symErr.message });
      }
    }
  } catch (err) {
    console.error('[BOT CRON ERROR]', err.message);
    broadcast('error', { msg: err.message });
  }
});

// ─── Price ticker broadcast every 10s ────────────────────────────────────────
cron.schedule('*/10 * * * * *', async () => {
  try {
    const config = await getConfig();
    if (!config.api_key) return;
    const bybit = getExchange(config);
    const [watchlist] = await db.query(
      'SELECT symbol FROM watchlist WHERE is_active = TRUE'
    );
    const prices = {};
    for (const { symbol } of watchlist) {
      const t = await bybit.getTicker(symbol);
      prices[symbol] = {
        price: t.lastPrice,
        change: t.price24hPcnt,
        volume: t.volume24h,
      };
    }
    broadcast('prices', prices);
  } catch (_) {}
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket on ws://localhost:${PORT}/ws`);
});
