require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const schemaPath = path.resolve(__dirname, '..', '..', 'database', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  console.log(`Connected to ${process.env.DB_HOST}:${process.env.DB_PORT} as ${process.env.DB_USER}`);
  console.log(`Loading schema from ${schemaPath}`);

  await conn.query(sql);
  console.log('Schema loaded successfully.');

  const [dbs] = await conn.query("SHOW DATABASES LIKE 'trading_bot'");
  console.log('trading_bot exists:', dbs.length > 0);

  await conn.query('USE trading_bot');
  const [tables] = await conn.query('SHOW TABLES');
  console.log('Tables:', tables.map((r) => Object.values(r)[0]));

  await conn.end();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
