import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area,
  BarChart, Bar, Cell
} from 'recharts';
import {
  Activity, TrendingUp, TrendingDown, Zap, Settings, Bell,
  Play, Square, RefreshCw, Eye, Plus, Minus, BarChart2,
  DollarSign, Percent, AlertTriangle, CheckCircle, XCircle,
  ChevronUp, ChevronDown, Cpu, Wifi, WifiOff
} from 'lucide-react';

// Dev (CRA on :3000) talks to the backend on :3002. In production the backend
// serves this build on the same origin (behind Caddy/HTTPS), so use relative
// origin + wss:// automatically.
const IS_DEV = window.location.port === '3000';
const API = IS_DEV ? 'http://localhost:3002/api' : `${window.location.origin}/api`;
const WS_URL = IS_DEV
  ? 'ws://localhost:3002/ws'
  : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useWebSocket(url) {
  const [messages, setMessages] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectRef.current = setTimeout(connect, 3000);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          setMessages((prev) => [msg, ...prev].slice(0, 100));
        } catch (_) {}
      };
    } catch (_) {}
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { messages, connected };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPnl(n) {
  const v = parseFloat(n);
  const sign = v >= 0 ? '+' : '';
  return `${sign}${fmt(v, 4)}`;
}

function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── Signal Badge ─────────────────────────────────────────────────────────────

function SignalBadge({ signal }) {
  const map = {
    BUY: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40',
    SELL: 'bg-red-500/20 text-red-400 border border-red-500/40',
    HOLD: 'bg-amber-500/20 text-amber-400 border border-amber-500/40',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold tracking-wider ${map[signal] || map.HOLD}`}>
      {signal}
    </span>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color = 'cyan', change }) {
  const colors = {
    cyan: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
    green: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    red: 'text-red-400 bg-red-400/10 border-red-400/20',
    amber: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  };
  return (
    <div className="bg-[#0d1117] border border-white/5 rounded-xl p-4 flex items-center gap-4">
      <div className={`p-3 rounded-lg border ${colors[color]}`}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">{label}</p>
        <p className="text-xl font-bold text-white font-mono">{value}</p>
        {sub && <p className="text-xs text-slate-500 truncate">{sub}</p>}
      </div>
      {change !== undefined && (
        <div className={`text-sm font-mono font-bold ${parseFloat(change) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {parseFloat(change) >= 0 ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {Math.abs(parseFloat(change)).toFixed(2)}%
        </div>
      )}
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────

function SettingsModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    api_key: '', api_secret: '', testnet: true, auto_trade: false,
    trading_pair: 'BTCUSDT', timeframe: '240',
    risk_per_trade: 1.5, take_profit: 4.0, stop_loss: 2.0,
    leverage: 1, max_open_trades: 3,
  });

  useEffect(() => {
    fetch(`${API}/config`).then(r => r.json()).then(d => {
      if (d) setForm(f => ({ ...f, ...d, api_secret: '' }));
    });
  }, []);

  const save = async () => {
    await fetch(`${API}/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    onSave();
    onClose();
  };

  const field = (label, key, type = 'text', opts = {}) => (
    <div>
      <label className="block text-xs text-slate-400 mb-1 uppercase tracking-wide">{label}</label>
      {type === 'select' ? (
        <select
          className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50"
          value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        >
          {opts.options?.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      ) : type === 'checkbox' ? (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form[key]}
            onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))}
            className="w-4 h-4 accent-cyan-500" />
          <span className="text-sm text-slate-300">Enabled</span>
        </label>
      ) : (
        <input
          type={type} value={form[key]}
          onChange={e => setForm(f => ({ ...f, [key]: type === 'number' ? parseFloat(e.target.value) : e.target.value }))}
          className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50 font-mono"
          {...opts}
        />
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#0d1117] border border-white/10 rounded-2xl w-full max-w-lg p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Settings size={18} className="text-cyan-400" /> Bot Configuration
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><XCircle size={20} /></button>
        </div>

        <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-4">
            {field('API Key', 'api_key', 'password', { placeholder: 'Enter Binance API Key' })}
            {field('API Secret', 'api_secret', 'password', { placeholder: 'Enter API Secret' })}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {field('Testnet Mode', 'testnet', 'checkbox')}
            {field('Auto Trade (Live)', 'auto_trade', 'checkbox')}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {field('Default Pair', 'trading_pair', 'select', { options: [
              { v: 'BTCUSDT', l: 'BTC/USDT' }, { v: 'ETHUSDT', l: 'ETH/USDT' },
              { v: 'SOLUSDT', l: 'SOL/USDT' }, { v: 'BNBUSDT', l: 'BNB/USDT' }
            ]})}
            {field('Timeframe', 'timeframe', 'select', { options: [
              { v: '60', l: '1H' }, { v: '240', l: '4H' }, { v: 'D', l: '1D' }
            ]})}
          </div>
          <div className="grid grid-cols-3 gap-4">
            {field('Risk %', 'risk_per_trade', 'number', { min: 0.1, max: 5, step: 0.1 })}
            {field('Take Profit %', 'take_profit', 'number', { min: 0.5, max: 20, step: 0.5 })}
            {field('Stop Loss %', 'stop_loss', 'number', { min: 0.5, max: 10, step: 0.5 })}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {field('Leverage', 'leverage', 'number', { min: 1, max: 10, step: 1 })}
            {field('Max Open Trades', 'max_open_trades', 'number', { min: 1, max: 10, step: 1 })}
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-sm font-medium transition-colors">Cancel</button>
          <button onClick={save} className="flex-1 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-sm font-bold transition-colors">Save Config</button>
        </div>
      </div>
    </div>
  );
}

// ─── Manual Trade Panel ───────────────────────────────────────────────────────

function TradePanel({ watchlist, prices, defaultSymbol, onTrade }) {
  const symbols = watchlist?.length ? watchlist.map((w) => w.symbol) : ['BTCUSDT', 'ETHUSDT'];
  const [symbol, setSymbol] = useState(defaultSymbol || symbols[0]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (defaultSymbol && !symbol) setSymbol(defaultSymbol);
  }, [defaultSymbol, symbol]);

  const fire = async (side) => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/trade/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, side }),
      });
      const data = await res.json();
      setResult({ ok: res.ok && !data.error && !data.skipped, data });
      onTrade?.();
    } catch (e) {
      setResult({ ok: false, data: { error: e.message } });
    } finally {
      setBusy(false);
    }
  };

  const livePrice = prices?.[symbol]?.price;

  return (
    <div className="bg-[#0d1117] border border-white/10 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Zap size={15} className="text-cyan-400" /> Manual Trade
        </h3>
        {livePrice && (
          <span className="text-xs text-slate-400 font-mono">
            {symbol} @ ${parseFloat(livePrice).toLocaleString()}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="bg-[#161b22] border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-cyan-500/50"
        >
          {symbols.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={() => fire('BUY')}
          disabled={busy}
          className="py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-emerald-500/40 text-black text-sm font-bold transition-colors flex items-center justify-center gap-2"
        >
          <TrendingUp size={15} /> BUY
        </button>
        <button
          onClick={() => fire('SELL')}
          disabled={busy}
          className="py-2.5 rounded-lg bg-red-500 hover:bg-red-400 disabled:bg-red-500/40 text-white text-sm font-bold transition-colors flex items-center justify-center gap-2"
        >
          <TrendingDown size={15} /> SELL
        </button>
      </div>

      {busy && (
        <p className="mt-3 text-xs text-slate-400 flex items-center gap-2">
          <RefreshCw size={12} className="animate-spin" /> Placing order…
        </p>
      )}

      {result && (
        <div className={`mt-3 p-3 rounded-lg text-xs font-mono border ${
          result.ok
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            : 'bg-red-500/10 border-red-500/30 text-red-300'
        }`}>
          {result.data?.executed && (
            <div className="space-y-1">
              <div>✅ Order placed — qty {result.data.qty} @ ${parseFloat(result.data.price).toLocaleString()}</div>
              <div className="text-slate-400">
                Notional ${parseFloat(result.data.notional || 0).toFixed(2)} • SL ${parseFloat(result.data.sl).toFixed(2)} • TP ${parseFloat(result.data.tp).toFixed(2)}
              </div>
              <div className="text-amber-300">
                Estimated round-trip fee: -${parseFloat(result.data.estimatedFee || 0).toFixed(4)} (taker × 2)
              </div>
              <div className="text-slate-500">orderId {result.data.orderId}</div>
            </div>
          )}
          {result.data?.skipped && (
            <>⚠ Skipped: {result.data.skipped}</>
          )}
          {result.data?.error && (
            <>✕ {result.data.error}</>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Backtest Tab (TradingView-style strategy tester) ──────────────────────────

const BUILTIN_STRATEGIES = [
  {
    key: 'meanrev-mart',
    name: 'Mean-Reversion + Martingale',
    description: 'Buys oversold dips in uptrends and sells overbought rips in downtrends (Bollinger Bands + RSI + EMA200 trend filter). Exits when price reverts to the mean (BB middle) or MACD flips. Sizes with a linear Martingale (+$ per loss, reset on win) capped by a streak limit. Best risk-adjusted profile in our 2-year tests on 4H — high win rate, short losing streaks.',
    engine: 'meanrev', useBBExit: true, exitMode: 'macd', reverse: false,
    conf: 60, sizing: 'martingale', martBase: 7.5, martInc: 1.5, martCap: 8,
    leverage: 20, tp: 0, sl: 0,
  },
  {
    key: 'meanrev-flat',
    name: 'Mean-Reversion (flat sizing)',
    description: 'Same mean-reversion entry/exit logic as above, but every trade is the same size (no Martingale). Smoothest, safest equity curve — lower returns but the gentlest drawdowns. Good for confirming the raw edge before adding Martingale.',
    engine: 'meanrev', useBBExit: true, exitMode: 'macd', reverse: false,
    conf: 60, sizing: 'fixed', leverage: 1, tp: 0, sl: 0,
  },
  {
    key: 'trend-reverse',
    name: 'Trend-Reverse TP6/SL2',
    description: 'Fades the classic trend signal — when EMA/RSI/MACD say BUY it SELLs, and vice versa. Wide 6% take-profit vs 2% stop (3:1 reward:risk). Highest absolute returns in backtest, but LOW win rate (~31%) means long 9–14 trade losing streaks. Regime-dependent: profits in chop, loses in strong trends. NOT suitable for Martingale.',
    engine: 'classic', reverse: true, useBBExit: false, exitMode: 'fixed',
    conf: 70, tp: 6, sl: 2, sizing: 'risk', riskPct: 1, leverage: 10,
  },
  {
    key: 'trend-follow',
    name: 'Trend-Follow TP6/SL2',
    description: 'The original strategy — follows the EMA/RSI/MACD momentum signal. BUY when momentum is bullish, SELL when bearish. 6% take-profit / 2% stop. Works in trending markets, struggles in chop. Modest, classic trend-following behavior.',
    engine: 'classic', reverse: false, useBBExit: false, exitMode: 'fixed',
    conf: 70, tp: 6, sl: 2, sizing: 'risk', riskPct: 1, leverage: 10,
  },
  {
    key: 'aegis-1h-pullback',
    name: 'Aegis 1H Trend Pullback',
    description: 'Conservative 1H pullback strategy with derived 4H trend alignment. It only trades when EMA trend, controlled pullback, RSI, candle confirmation, volume, and at least 2:1 reward/risk align. Uses ATR + recent swing structure for stops and a fixed 2R first target. Designed to say NO TRADE often.',
    engine: 'aegis', reverse: false, useBBExit: false, exitMode: 'fixed',
    timeframe: '60', conf: 70, tp: 0, sl: 0, sizing: 'risk', riskPct: 1, leverage: 3,
  },
  {
    key: 'macd-rsi-ema',
    name: 'MACD + RSI + EMA (TradingView)',
    description: 'Momentum strategy ported from a TradingView Pine script. Enters LONG when the MACD line crosses ABOVE its signal line AND RSI > 50 AND price is above the EMA50; SHORT on the exact mirror. Holds the position until the NEXT opposite MACD cross flips it (MACD in, MACD out) — no trailing stop. This exit cut drawdowns to ~4–6% and beat the trailing-stop version in 2-year tests, landing near break-even (PF ~1.0–1.1) across BTC/ETH/SOL.',
    engine: 'macd_rsi_ema', reverse: false, useBBExit: false, exitMode: 'macd',
    trailPercent: 0, tp: 0, sl: 0, conf: 60, sizing: 'risk', riskPct: 1, leverage: 10,
  },
  {
    key: 'macd-rsi-ema-mart',
    name: 'MACD + RSI + EMA + Martingale',
    description: 'Same MACD+RSI+EMA entry and MACD-cross exit, but with linear Martingale sizing (+$ per loss, reset on win, streak cap). ⚠️ WARNING: this strategy has LONG losing streaks (10–14 in backtest) because its win rate is only ~32%. Martingale is risky here — a long streak ramps the bet aggressively and can cause deep drawdowns. The streak cap is your safety brake. Use small base size and keep the cap on.',
    engine: 'macd_rsi_ema', reverse: false, useBBExit: false, exitMode: 'macd',
    trailPercent: 0, tp: 0, sl: 0, conf: 60,
    sizing: 'martingale', martBase: 7.5, martInc: 1.5, martCap: 8, leverage: 20,
  },
];

const PRESETS = Object.fromEntries(
  BUILTIN_STRATEGIES.map((s) => [s.key, { label: s.name, ...s }])
);

function StatBox({ label, value, sub, tone }) {
  const color = tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-red-400' : 'text-white';
  return (
    <div className="bg-[#0d1117] border border-white/10 rounded-xl p-4">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function BacktestTab({ initialStrategy }) {
  const [custom, setCustom] = useState({});
  const [preset, setPreset] = useState('meanrev-mart');
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('240');
  const [period, setPeriod] = useState('2y');
  const [startBalance, setStartBalance] = useState(100);
  const [feeMode, setFeeMode] = useState('taker');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Editable sizing overrides (initialized from preset, user can change)
  const [leverage, setLeverage] = useState(20);
  const [martBase, setMartBase] = useState(7.5);
  const [martInc, setMartInc] = useState(1.5);
  const [martCap, setMartCap] = useState(8);
  const [martStart, setMartStart] = useState(1);
  const [conf, setConf] = useState(60);
  const [trailPercent, setTrailPercent] = useState(0);
  const [sl, setSl] = useState(0);

  // Fetch custom strategies and merge with built-ins
  useEffect(() => {
    fetch(`${API}/strategies`).then(r => r.json()).then(rows => {
      if (Array.isArray(rows)) {
        const map = {};
        rows.forEach(s => { map[`custom-${s.id}`] = { label: `★ ${s.name}`, ...s }; });
        setCustom(map);
      }
    }).catch(() => {});
  }, []);

  const ALL = { ...PRESETS, ...custom };

  // If a strategy was sent from the Strategies tab, select it
  useEffect(() => {
    if (initialStrategy && ALL[initialStrategy]) setPreset(initialStrategy);
  }, [initialStrategy]); // eslint-disable-line

  // When preset changes, sync the editable fields to its defaults
  useEffect(() => {
    const p = ALL[preset] || PRESETS['meanrev-mart'];
    setLeverage(p.leverage ?? 20);
    setMartBase(p.martBase ?? 7.5);
    setMartInc(p.martInc ?? 1.5);
    setMartCap(p.martCap ?? 8);
    setMartStart(p.martStart ?? 1);
    setConf(p.conf ?? 60);
    setTrailPercent(p.trailPercent ?? 0);
    setSl(p.sl ?? 0);
    if (p.timeframe) setTimeframe(p.timeframe);
  }, [preset, custom]); // eslint-disable-line

  const isMart = (ALL[preset] || {}).sizing === 'martingale';

  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try {
      const body = {
        ...(ALL[preset] || PRESETS['meanrev-mart']), symbol, timeframe, period,
        startBalance: parseFloat(startBalance), feeMode,
        leverage: parseInt(leverage, 10),
        conf: parseInt(conf, 10),
        martBase: parseFloat(martBase),
        martInc: parseFloat(martInc),
        martCap: parseInt(martCap, 10),
        martStart: parseInt(martStart, 10),
        trailPercent: parseFloat(trailPercent),
        sl: parseFloat(sl),
      };
      const res = await fetch(`${API}/backtest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setResult(data);
    } catch (e) { setError(e.message); }
    finally { setRunning(false); }
  };

  const s = result?.summary;
  const fmtD = (ts) => ts ? new Date(ts).toISOString().slice(0, 10) : '—';
  const fmtN = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = (d) => { // "2025-12-07" -> "Dec '25"
    const [y, m] = String(d).split('-');
    return m ? `${MONTHS[parseInt(m, 10) - 1]} '${y.slice(2)}` : d;
  };
  const equityData = (result?.equity || []).map((e) => ({ t: new Date(e.ts).toISOString().slice(0, 10), balance: Number(e.balance.toFixed(2)) }));
  const monthlyData = (result?.monthly || []).map((m) => ({
    m: monthLabel(m.month + '-01'),
    pnl: Number(m.pnl.toFixed(2)),
    trades: m.trades,
    wins: m.wins,
    balanceEnd: Number(m.balanceEnd.toFixed(2)),
  }));

  return (
    <div className="space-y-5">
      {/* Config bar */}
      <div className="bg-[#0d1117] border border-white/10 rounded-2xl p-5">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 mb-4">
          <Cpu size={15} className="text-cyan-400" /> Strategy Tester
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
          <div className="col-span-2">
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Strategy</label>
            <select value={preset} onChange={(e) => setPreset(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50">
              {Object.entries(ALL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Symbol</label>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50">
              {['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','LTCUSDT','LINKUSDT','ADAUSDT','DOGEUSDT'].map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Timeframe</label>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50">
              <option value="60">1H</option><option value="240">4H</option><option value="D">1D</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Period</label>
            <select value={period} onChange={(e) => setPeriod(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50">
              <optgroup label="Rolling (from today)">
                <option value="3m">3 Months</option>
                <option value="6m">6 Months</option>
                <option value="1y">1 Year</option>
                <option value="2y">2 Years</option>
                <option value="3y">3 Years</option>
                <option value="5y">5 Years</option>
              </optgroup>
              <optgroup label="Calendar year">
                <option value="y2021">2021 (from May)</option>
                <option value="y2022">2022</option>
                <option value="y2023">2023</option>
                <option value="y2024">2024</option>
                <option value="y2025">2025</option>
                <option value="y2026">2026 (YTD)</option>
              </optgroup>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Start $</label>
            <input type="number" value={startBalance} onChange={(e) => setStartBalance(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Fees</label>
            <select value={feeMode} onChange={(e) => setFeeMode(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50">
              <option value="taker">Taker 0.04%</option>
              <option value="maker">Maker 0.02%</option>
            </select>
          </div>
        </div>

        {/* Sizing / risk controls */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-3 pt-3 border-t border-white/5">
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Leverage</label>
            <input type="number" value={leverage} onChange={(e) => setLeverage(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Confidence ≥</label>
            <input type="number" value={conf} onChange={(e) => setConf(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Stop Loss % (0=off)</label>
            <input type="number" step="0.5" value={sl} onChange={(e) => setSl(e.target.value)}
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
          </div>
          {parseFloat(trailPercent) > 0 && (
            <div>
              <label className="block text-[10px] text-slate-400 uppercase mb-1">Trail Stop %</label>
              <input type="number" step="0.5" value={trailPercent} onChange={(e) => setTrailPercent(e.target.value)}
                className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
            </div>
          )}
          {isMart && <>
            <div>
              <label className="block text-[10px] text-slate-400 uppercase mb-1">Mart. Base $</label>
              <input type="number" value={martBase} onChange={(e) => setMartBase(e.target.value)}
                className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 uppercase mb-1">+$ per Loss</label>
              <input type="number" value={martInc} onChange={(e) => setMartInc(e.target.value)}
                className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 uppercase mb-1">Start @ Loss #</label>
              <input type="number" min="1" value={martStart} onChange={(e) => setMartStart(e.target.value)}
                className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
            </div>
            <div>
              <label className="block text-[10px] text-slate-400 uppercase mb-1">Streak Cap (0=off)</label>
              <input type="number" value={martCap} onChange={(e) => setMartCap(e.target.value)}
                className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
            </div>
          </>}
        </div>
        {isMart && (
          <p className="mt-2 text-[11px] text-slate-500">
            Margin <span className="text-slate-300 font-mono">${martBase}</span> × {leverage}x = position
            <span className="text-cyan-300 font-mono"> ${(parseFloat(martBase || 0) * parseInt(leverage || 0)).toFixed(0)}</span>.
            Liquidation at ~{leverage > 0 ? (100 / leverage).toFixed(1) : '—'}% adverse move.
          </p>
        )}

        <button onClick={run} disabled={running}
          className="mt-4 px-5 py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:bg-cyan-500/40 text-black text-sm font-bold transition-colors flex items-center gap-2">
          {running ? <><RefreshCw size={14} className="animate-spin" /> Running backtest…</> : <><Play size={14} /> Run Backtest</>}
        </button>
        {running && timeframe === '60' && ['2y', '3y', '5y'].includes(period) && (
          <p className="mt-2 text-[11px] text-amber-400/80">1H × {period.toUpperCase()} is heavy (lots of candles) — this can take 1–3 minutes. 4H/1D are much faster for long periods.</p>
        )}
        {error && <p className="mt-3 text-xs text-red-400 font-mono">✕ {error}</p>}
      </div>

      {s && (
        <>
          {/* Strategy line */}
          <div className="text-xs text-slate-400">
            <span className="text-slate-500">Strategy:</span> <span className="text-cyan-300 font-mono">{s.strategyLabel}</span>
            <span className="text-slate-600"> · </span>{s.symbol} {({'60':'1H','240':'4H','D':'1D'}[s.timeframe])}
            <span className="text-slate-600"> · </span>{fmtD(s.firstDate)} → {fmtD(s.lastDate)}
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatBox label="Net Return" value={`${s.returnPct >= 0 ? '+' : ''}${fmtN(s.returnPct)}%`} sub={`$${fmtN(s.startBalance)} → $${fmtN(s.finalBalance)}`} tone={s.returnPct >= 0 ? 'pos' : 'neg'} />
            <StatBox label="Win Rate" value={`${fmtN(s.winRate, 1)}%`} sub={`${s.wins}W / ${s.losses}L · ${s.trades} trades`} />
            <StatBox label="Profit Factor" value={s.profitFactor === null ? '—' : fmtN(s.profitFactor)} sub={s.profitFactor >= 1.1 ? 'edge' : 'weak'} tone={s.profitFactor >= 1.1 ? 'pos' : 'neg'} />
            <StatBox label="Max Drawdown" value={`${fmtN(s.maxDD, 1)}%`} sub="peak-to-trough" tone={s.maxDD < 25 ? 'pos' : 'neg'} />
            <StatBox label="Max Losing Streak" value={`${s.maxLossStreak}`} sub={s.worstStreakStart ? `${fmtD(s.worstStreakStart)}→${fmtD(s.worstStreakEnd)}` : ''} tone={s.maxLossStreak <= 6 ? 'pos' : 'neg'} />
            <StatBox label="Max Winning Streak" value={`${s.maxWinStreak}`} />
            <StatBox label="Total Fees" value={`$${fmtN(s.totalFees)}`} sub={`${s.feeMode} · gross $${fmtN(s.grossPnl)}`} />
            <StatBox label="Sizing" value={`${s.leverage}x`} sub={s.sizing} />
          </div>

          {/* Equity curve */}
          <div className="bg-[#0d1117] border border-white/10 rounded-2xl p-5">
            <div className="text-xs text-slate-400 mb-3 flex items-center gap-2"><Activity size={13} className="text-cyan-400" /> Equity Curve</div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={equityData}>
                <defs>
                  <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} minTickGap={50} tickFormatter={monthLabel} />
                <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={['auto', 'auto']} width={50} />
                <Tooltip contentStyle={{ background: '#0d1117', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }} labelFormatter={(d) => d} />
                <Area type="monotone" dataKey="balance" stroke="#22d3ee" strokeWidth={2} fill="url(#eq)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Monthly earnings */}
          {monthlyData.length > 0 && (
            <div className="bg-[#0d1117] border border-white/10 rounded-2xl p-5">
              <div className="text-xs text-slate-400 mb-3 flex items-center gap-2">
                <DollarSign size={13} className="text-cyan-400" /> Monthly Earnings (P&L per month)
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="m" tick={{ fill: '#64748b', fontSize: 10 }} minTickGap={20} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} width={50} />
                  <Tooltip contentStyle={{ background: '#0d1117', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                    formatter={(v) => [`$${v}`, 'P&L']} />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {monthlyData.map((d, i) => (
                      <Cell key={i} fill={d.pnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="overflow-x-auto mt-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500 uppercase tracking-wider border-b border-white/5">
                      {['Month', 'P&L', 'Trades', 'Win%', 'Balance End'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthlyData.map((d, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="px-3 py-1.5 text-slate-300 font-mono">{d.m}</td>
                        <td className={`px-3 py-1.5 font-mono font-bold ${d.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5 text-slate-400 font-mono">{d.trades}</td>
                        <td className="px-3 py-1.5 text-slate-400 font-mono">{d.trades ? Math.round((d.wins / d.trades) * 100) : 0}%</td>
                        <td className="px-3 py-1.5 text-slate-300 font-mono">${d.balanceEnd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Trade list */}
          <div className="bg-[#0d1117] border border-white/5 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/5 text-sm font-bold text-white flex items-center gap-2">
              <BarChart2 size={14} className="text-cyan-400" /> Trades ({result.trades.length})
            </div>
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#0d1117]">
                  <tr className="text-slate-500 uppercase tracking-wider border-b border-white/5">
                    {['#', 'Entry Date', 'Side', 'Entry', 'Exit', 'Exit Reason', 'PnL', 'PnL %', 'Balance'].map(h => (
                      <th key={h} className="px-3 py-2 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/5">
                      <td className="px-3 py-2 text-slate-600">{i + 1}</td>
                      <td className="px-3 py-2 text-slate-400">{fmtD(t.entryTs)}</td>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${t.side === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>{t.side}</span>
                      </td>
                      <td className="px-3 py-2 font-mono">${fmtN(t.entry)}</td>
                      <td className="px-3 py-2 font-mono">${fmtN(t.exit)}</td>
                      <td className="px-3 py-2 text-slate-500 text-[10px]">{t.reason}</td>
                      <td className={`px-3 py-2 font-mono font-bold ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{t.pnl >= 0 ? '+' : ''}{fmtN(t.pnl)}</td>
                      <td className={`px-3 py-2 font-mono ${t.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{t.pnlPct >= 0 ? '+' : ''}{fmtN(t.pnlPct, 2)}%</td>
                      <td className="px-3 py-2 font-mono text-slate-300">${fmtN(t.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!s && !running && !error && (
        <div className="text-center text-slate-600 py-16 text-sm">Pick a strategy and click Run Backtest to see results.</div>
      )}
    </div>
  );
}

// ─── Strategies Tab (library: built-in + custom) ───────────────────────────────

function StrategyCard({ s, builtin, onDelete, onBacktest }) {
  const badges = [
    s.engine === 'meanrev' ? 'Mean-Reversion' : s.engine === 'macd_rsi_ema' ? 'MACD+RSI+EMA' : (s.reverse ? 'Trend-Reverse' : 'Trend-Follow'),
    s.trailPercent > 0 ? `${s.trailPercent}% trail` : s.useBBExit ? 'BB-mid exit' : s.exitMode === 'macd' ? 'MACD exit' : `TP${s.tp}/SL${s.sl}`,
    `${s.leverage || 1}x`,
    s.sizing === 'martingale' ? `Martingale $${s.martBase}+$${s.martInc}` : s.sizing === 'risk' ? `Risk ${s.riskPct}%` : 'Fixed size',
    `conf≥${s.conf}`,
  ];
  return (
    <div className="bg-[#0d1117] border border-white/10 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          {builtin ? <Cpu size={15} className="text-cyan-400" /> : <Zap size={15} className="text-amber-400" />}
          {s.name}
        </h3>
        <span className={`text-[10px] px-2 py-0.5 rounded ${builtin ? 'bg-cyan-500/10 text-cyan-400' : 'bg-amber-500/10 text-amber-400'}`}>
          {builtin ? 'Built-in' : 'Custom'}
        </span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed mb-3">{s.description || 'No description.'}</p>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {badges.map((b, i) => (
          <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-white/5 text-slate-300 font-mono">{b}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={() => onBacktest(s)}
          className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-bold transition-colors flex items-center gap-1">
          <Play size={12} /> Backtest
        </button>
        {!builtin && (
          <button onClick={() => onDelete(s.id)}
            className="px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 text-xs font-bold transition-colors">
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function AddStrategyModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    name: '', description: '',
    engine: 'meanrev', reverse: false, useBBExit: true, exitMode: 'macd',
    tp: 0, sl: 0, conf: 60, sizing: 'martingale',
    leverage: 20, riskPct: 1, martBase: 7.5, martInc: 1.5, martCap: 8,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await fetch(`${API}/strategies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          tp: parseFloat(form.tp), sl: parseFloat(form.sl), conf: parseInt(form.conf, 10),
          leverage: parseInt(form.leverage, 10), riskPct: parseFloat(form.riskPct),
          martBase: parseFloat(form.martBase), martInc: parseFloat(form.martInc), martCap: parseInt(form.martCap, 10),
        }),
      });
      onSaved();
      onClose();
    } finally { setSaving(false); }
  };

  const Field = ({ label, k, type = 'text', opts }) => (
    <div>
      <label className="block text-[10px] text-slate-400 uppercase mb-1">{label}</label>
      {opts ? (
        <select value={form[k]} onChange={e => set(k, type === 'bool' ? e.target.value === 'true' : e.target.value)}
          className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50">
          {opts.map(o => <option key={String(o.v)} value={String(o.v)}>{o.l}</option>)}
        </select>
      ) : (
        <input type={type} value={form[k]} onChange={e => set(k, e.target.value)}
          className="w-full bg-[#161b22] border border-white/10 rounded-lg px-2 py-2 text-white text-xs font-mono focus:outline-none focus:border-cyan-500/50" />
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#0d1117] border border-white/10 rounded-2xl w-full max-w-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white flex items-center gap-2"><Plus size={18} className="text-amber-400" /> New Strategy</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><XCircle size={20} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Name</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. My Aggressive Mean-Rev"
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50" />
          </div>
          <div>
            <label className="block text-[10px] text-slate-400 uppercase mb-1">Description</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={2} placeholder="What does this strategy do?"
              className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-cyan-500/50" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Engine" k="engine" opts={[{ v: 'meanrev', l: 'Mean-Reversion' }, { v: 'classic', l: 'Trend (classic)' }]} />
            <Field label="Reverse signal" k="reverse" type="bool" opts={[{ v: false, l: 'No' }, { v: true, l: 'Yes (fade)' }]} />
            <Field label="Confidence ≥" k="conf" type="number" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="BB-middle exit" k="useBBExit" type="bool" opts={[{ v: true, l: 'Yes' }, { v: false, l: 'No' }]} />
            <Field label="Exit mode" k="exitMode" opts={[{ v: 'macd', l: 'MACD reversal' }, { v: 'fixed', l: 'Fixed TP/SL' }]} />
            <div />
            <Field label="Take Profit %" k="tp" type="number" />
            <Field label="Stop Loss %" k="sl" type="number" />
            <div />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Sizing" k="sizing" opts={[{ v: 'martingale', l: 'Martingale' }, { v: 'risk', l: 'Risk %' }, { v: 'fixed', l: 'Fixed' }]} />
            <Field label="Leverage" k="leverage" type="number" />
            <Field label="Risk % (if risk)" k="riskPct" type="number" />
          </div>
          {form.sizing === 'martingale' && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Mart. Base $" k="martBase" type="number" />
              <Field label="+$ per Loss" k="martInc" type="number" />
              <Field label="Streak Cap" k="martCap" type="number" />
            </div>
          )}
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-sm font-medium">Cancel</button>
          <button onClick={save} disabled={saving || !form.name.trim()}
            className="flex-1 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-amber-500/40 text-black text-sm font-bold">
            {saving ? 'Saving…' : 'Save Strategy'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StrategiesTab({ onBacktest }) {
  const [customList, setCustomList] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(() => {
    fetch(`${API}/strategies`).then(r => r.json()).then(rows => {
      setCustomList(Array.isArray(rows) ? rows : []);
    }).catch(() => setCustomList([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const del = async (id) => {
    await fetch(`${API}/strategies/${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-white">Strategy Library</h2>
          <p className="text-xs text-slate-500 mt-0.5">Built-in strategies plus your own. Custom strategies also appear in the Backtest dropdown.</p>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-sm font-bold flex items-center gap-2">
          <Plus size={15} /> Add Strategy
        </button>
      </div>

      <div className="text-[11px] text-slate-500 uppercase tracking-wider">Built-in</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {BUILTIN_STRATEGIES.map(s => (
          <StrategyCard key={s.key} s={s} builtin onBacktest={() => onBacktest(s.key)} />
        ))}
      </div>

      <div className="text-[11px] text-slate-500 uppercase tracking-wider pt-2">Custom ({customList.length})</div>
      {customList.length === 0 ? (
        <div className="text-center text-slate-600 py-10 text-sm border border-dashed border-white/10 rounded-2xl">
          No custom strategies yet. Click “Add Strategy” to create one.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {customList.map(s => (
            <StrategyCard key={s.id} s={s} builtin={false} onDelete={del} onBacktest={() => onBacktest(`custom-${s.id}`)} />
          ))}
        </div>
      )}

      {showAdd && <AddStrategyModal onClose={() => setShowAdd(false)} onSaved={load} />}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [backtestStrategy, setBacktestStrategy] = useState(null);
  const openBacktest = (key) => { setBacktestStrategy(key); setTab('backtest'); };
  const [botActive, setBotActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [stats, setStats] = useState({});
  const [portfolio, setPortfolio] = useState({});
  const [trades, setTrades] = useState([]);
  const [signals, setSignals] = useState([]);
  const [watchlist, setWatchlist] = useState([]);
  const [prices, setPrices] = useState({});
  const [liveSignals, setLiveSignals] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const { messages, connected } = useWebSocket(WS_URL);

  // Handle WS messages
  useEffect(() => {
    if (!messages.length) return;
    const msg = messages[0];
    if (msg.type === 'prices') setPrices(msg.data);
    if (msg.type === 'bot_status') setBotActive(msg.data.active);
    if (msg.type === 'signal') {
      setLiveSignals(prev => [{ ...msg.data, ts: msg.ts }, ...prev].slice(0, 20));
      addNotification(msg.data.signal, `${msg.data.signal} signal: ${msg.data.symbol}`);
    }
  }, [messages]);

  function addNotification(type, text) {
    const id = Date.now();
    setNotifications(prev => [{ id, type, text }, ...prev].slice(0, 5));
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 5000);
  }

  const loadData = useCallback(async () => {
    try {
      const [s, p, t, sig, w, cfg] = await Promise.all([
        fetch(`${API}/stats`).then(r => r.json()),
        fetch(`${API}/portfolio`).then(r => r.json()),
        fetch(`${API}/trades`).then(r => r.json()),
        fetch(`${API}/signals`).then(r => r.json()),
        fetch(`${API}/watchlist`).then(r => r.json()),
        fetch(`${API}/config`).then(r => r.json()),
      ]);
      setStats(s); setPortfolio(p);
      setTrades(Array.isArray(t) ? t : []);
      setSignals(Array.isArray(sig) ? sig : []);
      setWatchlist(Array.isArray(w) ? w : []);
      if (cfg && typeof cfg.is_active !== 'undefined') {
        setBotActive(Boolean(cfg.is_active));
      }
    } catch (_) {}
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const toggleBot = async () => {
    const endpoint = botActive ? '/bot/stop' : '/bot/start';
    await fetch(`${API}${endpoint}`, { method: 'POST' });
    setBotActive(!botActive);
  };

  const [closing, setClosing] = useState(null);
  const closeTrade = async (symbol) => {
    setClosing(symbol);
    try {
      const res = await fetch(`${API}/trade/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();
      if (data.error) addNotification('error', `Close failed: ${data.error}`);
      else addNotification('success', `Closed ${symbol} — PnL $${parseFloat(data.pnl || 0).toFixed(2)}`);
      await loadData();
    } catch (e) {
      addNotification('error', `Close failed: ${e.message}`);
    } finally {
      setClosing(null);
    }
  };

  const analyzeAll = async () => {
    setAnalyzing(true);
    for (const item of watchlist) {
      await fetch(`${API}/signal/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: item.symbol }),
      });
    }
    await loadData();
    setAnalyzing(false);
  };

  // Chart data for equity curve
  const equityData = trades.slice().reverse().map((t, i) => ({
    i: i + 1, pnl: parseFloat(t.pnl || 0),
    cumPnl: trades.slice(0, trades.length - i).reduce((a, b) => a + parseFloat(b.pnl || 0), 0),
  }));

  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'signals', label: 'Signals', icon: Zap },
    { id: 'trades', label: 'Trades', icon: BarChart2 },
    { id: 'strategies', label: 'Strategies', icon: Cpu },
    { id: 'backtest', label: 'Backtest', icon: BarChart2 },
    { id: 'watchlist', label: 'Watchlist', icon: Eye },
  ];

  return (
    <div className="min-h-screen bg-[#070b0f] text-white font-sans" style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}>
      {/* Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0d1117; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
        .glow-cyan { box-shadow: 0 0 20px rgba(6,182,212,0.15); }
        .glow-green { box-shadow: 0 0 20px rgba(52,211,153,0.15); }
        .pulse-dot { animation: pulse 2s infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
        .slide-in { animation: slideIn 0.3s ease; }
        @keyframes slideIn { from { opacity:0; transform: translateY(-8px); } to { opacity:1; transform: translateY(0); } }
      `}</style>

      {/* Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {notifications.map(n => (
          <div key={n.id} className={`slide-in flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium shadow-xl backdrop-blur
            ${n.type === 'BUY' ? 'bg-emerald-900/80 border-emerald-500/40 text-emerald-300' :
              n.type === 'SELL' ? 'bg-red-900/80 border-red-500/40 text-red-300' :
              'bg-slate-800/80 border-slate-600/40 text-slate-300'}`}>
            <Bell size={14} /> {n.text}
          </div>
        ))}
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onSave={loadData} />}

      {/* Header */}
      <header className="border-b border-white/5 px-6 py-3 flex items-center justify-between bg-[#0d1117]/80 backdrop-blur sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
            <Cpu size={16} className="text-cyan-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">BYBIT SWING BOT</h1>
            <p className="text-xs text-slate-500">Automated Signal Trading</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border
            ${connected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
            {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
            {connected ? 'LIVE' : 'OFFLINE'}
          </div>

          <button onClick={analyzeAll} disabled={analyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-white/10 rounded-lg text-xs text-slate-300 transition-colors">
            <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
            {analyzing ? 'Scanning...' : 'Scan'}
          </button>

          <button onClick={toggleBot}
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition-all
              ${botActive ? 'bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30' :
                'bg-cyan-500 hover:bg-cyan-400 text-black'}`}>
            {botActive ? <><Square size={12} /> STOP</> : <><Play size={12} /> START</>}
          </button>

          <button onClick={() => setShowSettings(true)}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/5 text-slate-400 transition-colors">
            <Settings size={15} />
          </button>
        </div>
      </header>

      {/* Bot status bar */}
      {botActive && (
        <div className="bg-cyan-500/10 border-b border-cyan-500/20 px-6 py-2 flex items-center gap-2 text-xs text-cyan-400">
          <span className="pulse-dot w-2 h-2 rounded-full bg-cyan-400 inline-block"></span>
          Bot is running — scanning markets every 5 minutes
        </div>
      )}

      {/* Nav */}
      <nav className="px-6 border-b border-white/5 flex gap-1 bg-[#0d1117]/50">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-medium transition-colors border-b-2 -mb-px
              ${tab === id ? 'border-cyan-400 text-cyan-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </nav>

      <main className="p-6 space-y-6 max-w-7xl mx-auto">

        {/* ── DASHBOARD ─────────────────────────────────────────────────────── */}
        {tab === 'dashboard' && (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard label="Total Balance" value={`$${fmt(portfolio.totalBalance)}`}
                sub="Binance Futures" icon={DollarSign} color="cyan" />
              <StatCard label="Available" value={`$${fmt(portfolio.availableBalance)}`}
                sub="Free margin" icon={DollarSign} color="green" />
              <StatCard label="Unrealized PnL" value={`$${fmtPnl(portfolio.unrealizedPnl)}`}
                sub="Open positions" icon={TrendingUp}
                color={parseFloat(portfolio.unrealizedPnl) >= 0 ? 'green' : 'red'} />
              <StatCard label="Win Rate" value={`${stats.win_rate || 0}%`}
                sub={`${stats.winning_trades || 0}W / ${stats.losing_trades || 0}L`}
                icon={Percent} color="amber" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <StatCard label="Total Trades" value={stats.total_trades || 0}
                sub="Closed positions" icon={BarChart2} color="cyan" />
              <StatCard label="Total PnL" value={`$${fmtPnl(stats.total_pnl)}`}
                sub="Realized" icon={TrendingUp}
                color={parseFloat(stats.total_pnl) >= 0 ? 'green' : 'red'} />
              <StatCard label="Avg PnL" value={`${stats.avg_pnl_percent || 0}%`}
                sub="Per trade" icon={Activity} color="amber" />
            </div>

            <TradePanel watchlist={watchlist} prices={prices} onTrade={loadData} />

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Equity Curve */}
              <div className="bg-[#0d1117] border border-white/5 rounded-xl p-4">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <TrendingUp size={13} className="text-cyan-400" /> Equity Curve
                </h3>
                {equityData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={equityData}>
                      <defs>
                        <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                      <XAxis dataKey="i" tick={{ fill: '#64748b', fontSize: 10 }} />
                      <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: '#0d1117', border: '1px solid #ffffff15', borderRadius: 8, fontSize: 11 }} />
                      <Area type="monotone" dataKey="cumPnl" stroke="#06b6d4" strokeWidth={2} fill="url(#pnlGrad)" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-40 flex items-center justify-center text-slate-600 text-sm">No trade data yet</div>
                )}
              </div>

              {/* Live Signals Feed */}
              <div className="bg-[#0d1117] border border-white/5 rounded-xl p-4">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Zap size={13} className="text-cyan-400" /> Live Signal Feed
                </h3>
                <div className="space-y-2 max-h-44 overflow-y-auto">
                  {liveSignals.length === 0 ? (
                    <p className="text-slate-600 text-sm text-center py-8">Waiting for signals...</p>
                  ) : liveSignals.map((s, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 border-b border-white/5 text-xs">
                      <div className="flex items-center gap-2">
                        <SignalBadge signal={s.signal} />
                        <span className="text-white font-bold">{s.symbol}</span>
                      </div>
                      <div className="flex items-center gap-3 text-slate-400">
                        <span>${fmt(s.price)}</span>
                        <span className="text-cyan-400">{s.confidence}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Price Board */}
            <div className="bg-[#0d1117] border border-white/5 rounded-xl p-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Activity size={13} className="text-cyan-400" /> Market Prices (Live)
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {watchlist.map(({ symbol }) => {
                  const p = prices[symbol] || {};
                  const pct = parseFloat(p.change) * 100;
                  return (
                    <div key={symbol} className="bg-[#161b22] rounded-lg p-3 border border-white/5 hover:border-cyan-500/20 transition-colors">
                      <div className="text-xs text-slate-500 mb-1">{symbol.replace('USDT', '/USDT')}</div>
                      <div className="text-sm font-bold text-white font-mono">${fmt(p.price)}</div>
                      <div className={`text-xs font-mono mt-1 ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* ── SIGNALS TAB ───────────────────────────────────────────────────── */}
        {tab === 'signals' && (
          <div className="bg-[#0d1117] border border-white/5 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Zap size={14} className="text-cyan-400" /> Signal History
              </h2>
              <button onClick={analyzeAll} disabled={analyzing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 rounded-lg text-xs transition-colors">
                <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
                {analyzing ? 'Scanning...' : 'Run Analysis'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 uppercase tracking-wider border-b border-white/5">
                    {['Time', 'Symbol', 'Signal', 'Price', 'EMA9', 'EMA21', 'RSI', 'MACD', 'Confidence'].map(h => (
                      <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {signals.map((s, i) => (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/2 transition-colors">
                      <td className="px-4 py-3 text-slate-500">{timeAgo(s.created_at)}</td>
                      <td className="px-4 py-3 text-white font-bold">{s.symbol}</td>
                      <td className="px-4 py-3"><SignalBadge signal={s.signal} /></td>
                      <td className="px-4 py-3 text-white font-mono">${fmt(s.price)}</td>
                      <td className="px-4 py-3 text-cyan-400 font-mono">{fmt(s.ema_9)}</td>
                      <td className="px-4 py-3 text-purple-400 font-mono">{fmt(s.ema_21)}</td>
                      <td className={`px-4 py-3 font-mono font-bold ${parseFloat(s.rsi) < 35 ? 'text-emerald-400' : parseFloat(s.rsi) > 65 ? 'text-red-400' : 'text-slate-300'}`}>
                        {fmt(s.rsi, 1)}
                      </td>
                      <td className={`px-4 py-3 font-mono ${parseFloat(s.macd) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {fmt(s.macd, 6)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-800 rounded-full w-16 overflow-hidden">
                            <div className={`h-full rounded-full ${s.signal === 'BUY' ? 'bg-emerald-500' : s.signal === 'SELL' ? 'bg-red-500' : 'bg-amber-500'}`}
                              style={{ width: `${s.confidence}%` }} />
                          </div>
                          <span className="text-slate-400 w-8">{s.confidence}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {signals.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-600">No signals yet. Click "Run Analysis" to start.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── TRADES TAB ────────────────────────────────────────────────────── */}
        {tab === 'trades' && (
          <div className="bg-[#0d1117] border border-white/5 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-white/5">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <BarChart2 size={14} className="text-cyan-400" /> Trade History
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 uppercase tracking-wider border-b border-white/5">
                    {['Time', 'Symbol', 'Side', 'Entry', 'Exit', 'Qty', 'PnL', 'PnL %', 'Status', 'Action'].map(h => (
                      <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/2 transition-colors">
                      <td className="px-4 py-3 text-slate-500">{timeAgo(t.created_at)}</td>
                      <td className="px-4 py-3 text-white font-bold">{t.symbol}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${t.side === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono">${fmt(t.entry_price)}</td>
                      <td className="px-4 py-3 font-mono">{t.exit_price ? `$${fmt(t.exit_price)}` : '—'}</td>
                      <td className="px-4 py-3 font-mono">{fmt(t.quantity, 6)}</td>
                      <td className={`px-4 py-3 font-mono font-bold ${parseFloat(t.pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.pnl ? fmtPnl(t.pnl) : '—'}
                      </td>
                      <td className={`px-4 py-3 font-mono ${parseFloat(t.pnl_percent) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.pnl_percent ? `${fmtPnl(t.pnl_percent)}%` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs ${t.status === 'OPEN' ? 'text-cyan-400 bg-cyan-500/10' : t.status === 'CLOSED' ? 'text-slate-400 bg-white/5' : 'text-red-400 bg-red-500/10'}`}>
                          {t.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {t.status === 'OPEN' && (
                          <button
                            onClick={() => closeTrade(t.symbol)}
                            disabled={closing === t.symbol}
                            className="px-3 py-1 rounded bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 disabled:opacity-50 text-xs font-bold transition-colors"
                          >
                            {closing === t.symbol ? 'Closing…' : 'Close'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {trades.length === 0 && (
                    <tr><td colSpan={10} className="px-4 py-12 text-center text-slate-600">No trades recorded yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── STRATEGIES TAB ────────────────────────────────────────────────── */}
        {tab === 'strategies' && <StrategiesTab onBacktest={openBacktest} />}

        {/* ── BACKTEST TAB ──────────────────────────────────────────────────── */}
        {tab === 'backtest' && <BacktestTab initialStrategy={backtestStrategy} />}

        {/* ── WATCHLIST TAB ─────────────────────────────────────────────────── */}
        {tab === 'watchlist' && (
          <div className="space-y-4">
            <AddSymbol onAdd={async (sym) => {
              await fetch(`${API}/watchlist`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: sym }),
              });
              loadData();
            }} />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {watchlist.map(({ symbol }) => {
                const p = prices[symbol] || {};
                const pct = parseFloat(p.change || 0) * 100;
                const lastSig = signals.find(s => s.symbol === symbol);
                return (
                  <div key={symbol} className="bg-[#0d1117] border border-white/5 rounded-xl p-4 hover:border-cyan-500/20 transition-all">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-bold text-white">{symbol.replace('USDT', '/USDT')}</h3>
                      {lastSig && <SignalBadge signal={lastSig.signal} />}
                    </div>
                    <div className="text-2xl font-bold text-white font-mono mb-1">${fmt(p.price)}</div>
                    <div className={`text-sm font-mono ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pct >= 0 ? '▲' : '▼'} {Math.abs(pct).toFixed(2)}% 24h
                    </div>
                    {lastSig && (
                      <div className="mt-3 pt-3 border-t border-white/5 grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <div className="text-slate-500">RSI</div>
                          <div className={`font-bold ${parseFloat(lastSig.rsi) < 35 ? 'text-emerald-400' : parseFloat(lastSig.rsi) > 65 ? 'text-red-400' : 'text-white'}`}>
                            {fmt(lastSig.rsi, 1)}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-500">EMA9</div>
                          <div className="text-cyan-400 font-bold">{fmt(lastSig.ema_9)}</div>
                        </div>
                        <div>
                          <div className="text-slate-500">Conf.</div>
                          <div className="text-amber-400 font-bold">{lastSig.confidence}%</div>
                        </div>
                      </div>
                    )}
                    <button onClick={async () => {
                      setAnalyzing(true);
                      await fetch(`${API}/signal/analyze`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ symbol }),
                      });
                      await loadData();
                      setAnalyzing(false);
                    }} className="mt-3 w-full py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-cyan-400 text-xs font-medium transition-colors">
                      Analyze Now
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function AddSymbol({ onAdd }) {
  const [val, setVal] = useState('');
  return (
    <div className="bg-[#0d1117] border border-white/5 rounded-xl p-4 flex items-center gap-3">
      <input value={val} onChange={e => setVal(e.target.value.toUpperCase())}
        placeholder="Add symbol e.g. DOTUSDT"
        className="flex-1 bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-500/50 font-mono" />
      <button onClick={() => { if (val) { onAdd(val); setVal(''); } }}
        className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black rounded-lg text-sm font-bold transition-colors flex items-center gap-2">
        <Plus size={14} /> Add
      </button>
    </div>
  );
}
