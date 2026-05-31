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

  const [cols] = await conn.query(
    "SHOW COLUMNS FROM bot_config LIKE 'auto_trade'"
  );
  if (cols.length === 0) {
    await conn.query(
      'ALTER TABLE bot_config ADD COLUMN auto_trade BOOLEAN DEFAULT FALSE AFTER is_active'
    );
    console.log('Added auto_trade column.');
  } else {
    console.log('auto_trade column already exists.');
  }

  const [[row]] = await conn.query(
    'SELECT auto_trade FROM bot_config WHERE id = 1'
  );
  console.log('auto_trade =', row.auto_trade);

  await conn.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
