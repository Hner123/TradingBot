require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  const [[cfg]] = await conn.query(
    'SELECT is_active, testnet, trading_pair, timeframe, ' +
    'CASE WHEN api_key IS NULL OR api_key = "" THEN "NO" ELSE "YES" END AS has_key, ' +
    'CASE WHEN api_secret IS NULL OR api_secret = "" THEN "NO" ELSE "YES" END AS has_secret ' +
    'FROM bot_config WHERE id = 1'
  );
  console.log('Bot config:', cfg);

  const [[sigCount]] = await conn.query('SELECT COUNT(*) AS n FROM signals');
  console.log(`Signals logged: ${sigCount.n}`);

  const [recent] = await conn.query(
    'SELECT symbol, `signal`, ROUND(price, 2) AS price, ROUND(rsi, 1) AS rsi, confidence, created_at ' +
    'FROM signals ORDER BY created_at DESC LIMIT 5'
  );
  console.log('Last 5 signals:');
  recent.forEach((r) => console.log(' ', r));

  const [[tradeCount]] = await conn.query('SELECT COUNT(*) AS n FROM trades');
  console.log(`Trades logged: ${tradeCount.n}`);

  await conn.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
