-- ============================================
-- Bybit Swing Trading Bot - MySQL Schema
-- ============================================

CREATE DATABASE IF NOT EXISTS trading_bot;
USE trading_bot;

-- Bot Configuration
CREATE TABLE IF NOT EXISTS bot_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  api_key VARCHAR(255),
  api_secret VARCHAR(255),
  testnet BOOLEAN DEFAULT TRUE,
  trading_pair VARCHAR(50) DEFAULT 'BTCUSDT',
  timeframe VARCHAR(10) DEFAULT '60',
  risk_per_trade DECIMAL(5,2) DEFAULT 1.50,
  take_profit DECIMAL(5,2) DEFAULT 0.00,
  stop_loss DECIMAL(5,2) DEFAULT 1.00,
  leverage INT DEFAULT 20,
  max_open_trades INT DEFAULT 3,
  is_active BOOLEAN DEFAULT FALSE,
  auto_trade BOOLEAN DEFAULT FALSE,
  -- live strategy config
  signal_engine VARCHAR(30) DEFAULT 'macd_rsi_ema',
  confidence_min INT DEFAULT 80,
  sizing_mode VARCHAR(20) DEFAULT 'martingale',
  mart_base DECIMAL(10,2) DEFAULT 20.00,
  mart_inc DECIMAL(10,2) DEFAULT 10.00,
  mart_cap INT DEFAULT 8,
  mart_start INT DEFAULT 3,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Trades
CREATE TABLE IF NOT EXISTS trades (
  id INT PRIMARY KEY AUTO_INCREMENT,
  order_id VARCHAR(100),
  symbol VARCHAR(50),
  side ENUM('BUY', 'SELL'),
  entry_price DECIMAL(18,8),
  exit_price DECIMAL(18,8),
  quantity DECIMAL(18,8),
  pnl DECIMAL(18,8),
  pnl_percent DECIMAL(8,4),
  stop_loss DECIMAL(18,8),
  take_profit DECIMAL(18,8),
  estimated_fee DECIMAL(18,8),
  status ENUM('OPEN', 'CLOSED', 'CANCELLED') DEFAULT 'OPEN',
  signal_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP NULL
);

-- Signals Log
CREATE TABLE IF NOT EXISTS signals (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(50),
  timeframe VARCHAR(10),
  `signal` ENUM('BUY', 'SELL', 'HOLD'),
  ema_9 DECIMAL(18,8),
  ema_21 DECIMAL(18,8),
  rsi DECIMAL(8,4),
  macd DECIMAL(18,8),
  macd_signal DECIMAL(18,8),
  price DECIMAL(18,8),
  confidence INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Portfolio Snapshots
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INT PRIMARY KEY AUTO_INCREMENT,
  total_balance DECIMAL(18,8),
  available_balance DECIMAL(18,8),
  unrealized_pnl DECIMAL(18,8),
  realized_pnl DECIMAL(18,8),
  snapshot_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Watchlist
CREATE TABLE IF NOT EXISTS watchlist (
  id INT PRIMARY KEY AUTO_INCREMENT,
  symbol VARCHAR(50) UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Custom saved strategies (built-ins live in the frontend)
CREATE TABLE IF NOT EXISTS strategies (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  config JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default watchlist (BTC + ETH — the validated coins for the live strategy)
INSERT IGNORE INTO watchlist (symbol) VALUES
  ('BTCUSDT'), ('ETHUSDT');

-- Insert default config
INSERT IGNORE INTO bot_config (id) VALUES (1);
