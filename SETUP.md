# 🤖 Binance Futures Swing Trading Bot — Setup Guide

## Prerequisites
- Node.js 18+
- MySQL 8+
- Binance Futures **Testnet** account — https://testnet.binancefuture.com
  (free, no KYC, faucet gives test USDT)

---

## 1️⃣ Database Setup

```bash
# Login to MySQL
mysql -u root -p

# Run the schema
source /path/to/trading-bot/database/schema.sql
```

---

## 2️⃣ Backend Setup

```bash
cd trading-bot/backend

# Copy env file
cp .env.example .env

# Edit .env with your MySQL credentials
nano .env

# Install dependencies
npm install

# Start the server
npm run dev
# Server: http://localhost:3001
# WebSocket: ws://localhost:3001/ws
```

---

## 3️⃣ Frontend Setup

```bash
cd trading-bot/frontend

# Install dependencies
npm install

# Install Tailwind (if needed)
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p

# Start the React app
npm start
# App: http://localhost:3000
```

---

## 4️⃣ Get Binance Futures Testnet API Keys

1. Go to https://testnet.binancefuture.com and log in (GitHub/Google login works)
2. Scroll to the bottom **API Key** panel → copy the **API Key** and **API Secret**
3. The testnet account starts pre-funded with test USDT (use the faucet if empty)

## 5️⃣ Configure the Bot (in the UI)

1. Open http://localhost:3000
2. Click the ⚙️ Settings icon
3. Enter your **Binance API Key & Secret**
4. Enable **Testnet** (strongly recommended — points at testnet.binancefuture.com)
5. Set your **risk parameters**
6. Click **Save Config**

---

## 5️⃣ Running the Bot

### Manual Mode
- Click **Scan** to analyze all watchlist symbols on demand
- Review signals in the **Signals** tab

### Auto Mode
- Click **START** to enable the bot
- It will automatically scan every 5 minutes
- Signals with **≥60% confidence** will trigger trade alerts

---

## Architecture Overview

```
┌──────────────────┐     HTTP/REST      ┌──────────────────────┐
│   React Frontend │ ◄─────────────────► │  Node.js + Express   │
│   (Port 3000)    │                     │  (Port 3001)         │
│                  │ ◄─── WebSocket ───► │                      │
└──────────────────┘                     └──────┬───────────────┘
                                                │
                                    ┌───────────┼────────────┐
                                    │           │            │
                                  MySQL     Binance      Signal
                                  (DB)       API         Engine
```

---

## Signal Logic

| Indicator | Bullish Condition | Bearish Condition | Score |
|-----------|------------------|------------------|-------|
| EMA 9/21 Cross | EMA9 crosses above EMA21 | EMA9 crosses below EMA21 | ±2 |
| EMA Position | EMA9 > EMA21 | EMA9 < EMA21 | ±1 |
| RSI | RSI < 35 (oversold) | RSI > 65 (overbought) | ±2 |
| RSI Trend | RSI > 50 | RSI < 50 | ±0.5 |
| MACD | MACD > Signal + positive hist | MACD < Signal + negative hist | ±1 |

**Score ≥ 3 → BUY** | **Score ≤ -3 → SELL** | **Otherwise → HOLD**

---

## ⚠️ Risk Disclaimer

This is for educational purposes. Always:
- Start with **Testnet** before real trading
- Never risk more than you can afford to lose
- Monitor the bot actively — never leave it fully unattended
- Start with minimal position sizes (0.5-1% risk per trade)
