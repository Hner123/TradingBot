require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  console.log('Connected as', process.env.DB_USER, '->', process.env.DB_HOST);

  const [dbs] = await conn.query('SHOW DATABASES');
  console.log('Visible DBs:', dbs.map((r) => Object.values(r)[0]));

  const [grants] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
  console.log('Grants:');
  grants.forEach((g) => console.log('  ' + Object.values(g)[0]));

  try {
    await conn.query('USE trading_bot');
    const [tables] = await conn.query('SHOW TABLES');
    console.log('trading_bot tables:', tables.map((r) => Object.values(r)[0]));
  } catch (e) {
    console.log('USE trading_bot failed:', e.message);
  }

  await conn.end();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
