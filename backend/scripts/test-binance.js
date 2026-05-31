/**
 * Binance Futures connectivity test.
 *
 * Public check (no keys needed):
 *   node scripts/test-binance.js
 *
 * Authenticated testnet check (verifies your testnet API keys + balance):
 *   node scripts/test-binance.js <API_KEY> <API_SECRET>
 */

const BinanceService = require('../binance');
const axios = require('axios');

const API_KEY = process.argv[2];
const API_SECRET = process.argv[3];
const TESTNET = process.env.MAINNET !== '1';

(async () => {
  const base = TESTNET
    ? (process.env.BINANCE_TESTNET_URL || 'https://demo-fapi.binance.com')
    : 'https://fapi.binance.com';
  console.log(`\nTesting Binance Futures (${TESTNET ? 'DEMO' : 'MAINNET'})  ${base}\n`);

  // 1) Public — server time
  try {
    const t = await axios.get(`${base}/fapi/v1/time`, { timeout: 8000 });
    console.log(`✓ Server reachable — serverTime ${new Date(t.data.serverTime).toISOString()}`);
  } catch (e) {
    console.error(`✗ Cannot reach ${base}: ${e.message}`);
    console.error('  (Check internet / VPN / firewall.)');
    process.exit(1);
  }

  // 2) Public — ticker + klines via the service
  const svc = new BinanceService(API_KEY || '', API_SECRET || '', TESTNET);
  try {
    const ticker = await svc.getTicker('BTCUSDT');
    console.log(`✓ Ticker BTCUSDT: $${parseFloat(ticker.lastPrice).toLocaleString()}  (24h ${(parseFloat(ticker.price24hPcnt) * 100).toFixed(2)}%)`);
  } catch (e) {
    console.error(`✗ Ticker failed: ${e.response?.data?.msg || e.message}`);
  }
  try {
    const klines = await svc.getKlines('BTCUSDT', '240', 5);
    console.log(`✓ Klines: ${klines.length} × 4H candles, latest close $${parseFloat(klines[klines.length - 1][4]).toLocaleString()}`);
  } catch (e) {
    console.error(`✗ Klines failed: ${e.response?.data?.msg || e.message}`);
  }
  try {
    const inst = await svc.getInstrumentInfo('BTCUSDT');
    console.log(`✓ Instrument BTCUSDT: qtyStep ${inst.qtyStep}, minQty ${inst.minOrderQty}, tickSize ${inst.tickSize}`);
  } catch (e) {
    console.error(`✗ Instrument info failed: ${e.response?.data?.msg || e.message}`);
  }

  // 3) Authenticated — only if keys provided
  if (!API_KEY || !API_SECRET) {
    console.log('\n(no API key/secret passed — skipping authenticated checks)');
    console.log('Get demo keys at https://demo.binance.com → Account → API Management → Create API\n');
    return;
  }

  console.log('\n── Authenticated checks ──');
  try {
    const bal = await svc.getBalance();
    const w = bal.result.list[0];
    console.log(`✓ Wallet: total $${parseFloat(w.totalWalletBalance).toFixed(2)}  available $${parseFloat(w.totalAvailableBalance).toFixed(2)}  uPnL $${parseFloat(w.totalPerpUPL).toFixed(2)}`);
  } catch (e) {
    console.error(`✗ Balance failed: ${e.response?.data?.msg || e.message}`);
    console.error('  → Bad key/secret, wrong testnet/mainnet, or IP restriction.');
    return;
  }
  try {
    const open = await svc.getAllOpenPositions();
    console.log(`✓ Open positions: ${open.length}${open.length ? ' → ' + open.map((p) => `${p.symbol}:${p.size}`).join(', ') : ''}`);
  } catch (e) {
    console.error(`✗ Positions failed: ${e.response?.data?.msg || e.message}`);
  }
  console.log('\nAll good — these keys are ready to paste into the bot Settings.\n');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
