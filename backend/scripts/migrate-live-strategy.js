require('dotenv').config();
const mysql = require('mysql2/promise');

// Adds strategy-config columns so the LIVE bot can run the MACD+RSI+EMA+Martingale
// strategy (signal engine, confidence threshold, martingale sizing params).
(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const defs = {
    signal_engine: "signal_engine VARCHAR(30) DEFAULT 'macd_rsi_ema'",
    confidence_min: 'confidence_min INT DEFAULT 80',
    sizing_mode: "sizing_mode VARCHAR(20) DEFAULT 'martingale'",
    mart_base: 'mart_base DECIMAL(10,2) DEFAULT 20.00',
    mart_inc: 'mart_inc DECIMAL(10,2) DEFAULT 10.00',
    mart_cap: 'mart_cap INT DEFAULT 8',
    mart_start: 'mart_start INT DEFAULT 3',
  };

  for (const [name, def] of Object.entries(defs)) {
    const [cols] = await conn.query(`SHOW COLUMNS FROM bot_config LIKE '${name}'`);
    if (cols.length === 0) {
      await conn.query(`ALTER TABLE bot_config ADD COLUMN ${def}`);
      console.log(`Added column: ${name}`);
    } else {
      console.log(`Column exists: ${name}`);
    }
  }

  // Align the live bot defaults to the backtested strategy (only fields that make
  // sense to default; leaves api keys / is_active / auto_trade untouched).
  await conn.query(
    `UPDATE bot_config SET timeframe = '60', leverage = 20, stop_loss = 1.00, take_profit = 0.00
     WHERE id = 1`
  );
  console.log('Set timeframe=1H, leverage=20, stop_loss=1%, take_profit=0 (MACD exit) on row 1.');

  const [[row]] = await conn.query('SELECT * FROM bot_config WHERE id = 1');
  console.log('\nLive strategy config:');
  console.log({
    signal_engine: row.signal_engine, confidence_min: row.confidence_min,
    sizing_mode: row.sizing_mode, mart_base: row.mart_base, mart_inc: row.mart_inc,
    mart_cap: row.mart_cap, mart_start: row.mart_start, timeframe: row.timeframe,
    leverage: row.leverage, stop_loss: row.stop_loss, auto_trade: row.auto_trade,
  });

  await conn.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
