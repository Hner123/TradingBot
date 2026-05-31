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

  const [cols] = await conn.query("SHOW COLUMNS FROM trades LIKE 'estimated_fee'");
  if (cols.length === 0) {
    await conn.query(
      'ALTER TABLE trades ADD COLUMN estimated_fee DECIMAL(18,8) AFTER take_profit'
    );
    console.log('Added estimated_fee column to trades.');
  } else {
    console.log('estimated_fee column already exists.');
  }

  await conn.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
