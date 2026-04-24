// bot.js — VWAP + EMA8 + RSI3 | TP 3% | SL 1.5% | Paper Trading Spot
// Exchange: BitGet | Timeframe: 1H | Symbols: BTCUSDT, ETHUSDT, SOLUSDT, DOGEUSDT

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG = {
  exchange: 'bitget',
  symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT'],
  timeframe: '1h',
  limit: 100,
  takeProfitPct: 0.03,
  stopLossPct: 0.015,
  tradeSize: 10,
  csvFile: path.join(__dirname, 'trades.csv'),
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: 'luchianromeo-art',
    repo: 'claude-tradingview-mcp-trading',
    path: 'trades.csv',
  },
};

const exchange = new ccxt.bitget({
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  options: { defaultType: 'spot' },
});

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) { const tp = (c[2] + c[3] + c[4]) / 3; cumTPV += tp * c[5]; cumVol += c[5]; }
  return cumVol === 0 ? 0 : cumTPV / cumVol;
}

async function getGitHubSHA() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${CONFIG.github.path}`,
      method: 'GET',
      headers: { 'Authorization': `token ${CONFIG.github.token}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data).sha || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function pushCSVToGitHub(content) {
  const sha = await getGitHubSHA();
  const body = JSON.stringify({ message: `trades.csv update ${new Date().toISOString()}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${CONFIG.github.path}`,
      method: 'PUT',
      headers: { 'Authorization': `token ${CONFIG.github.token}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { console.log(`  GitHub sync trades.csv: ${[200,201].includes(res.statusCode) ? '✅' : '❌ ' + res.statusCode}`); resolve(); });
    });
    req.on('error', (e) => { console.error('  GitHub sync error:', e.message); resolve(); });
    req.write(body); req.end();
  });
}

const CSV_HEADER = 'timestamp,symbol,signal,price,tp,sl,size_usdt,result,pnl_pct\n';

function ensureCSV() {
  if (!fs.existsSync(CONFIG.csvFile)) fs.writeFileSync(CONFIG.csvFile, CSV_HEADER);
}

function appendTrade(row) {
  fs.appendFileSync(CONFIG.csvFile, [row.timestamp, row.symbol, row.signal, row.price, row.tp, row.sl, row.size_usdt, row.result, row.pnl_pct].join(',') + '\n');
}

const positionsFile = path.join(__dirname, 'positions_bot1.json');
function loadPositions() { try { return JSON.parse(fs.readFileSync(positionsFile, 'utf8')); } catch { return {}; } }
function savePositions(p) { fs.writeFileSync(positionsFile, JSON.stringify(p, null, 2)); }

function getSignal(candles) {
  const closes = candles.map(c => c[4]);
  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);
  const vwap = calcVWAP(candles);
  const lastClose = closes[closes.length - 1];
  console.log(`  EMA8=${ema8.toFixed(4)} | RSI3=${rsi3.toFixed(2)} | VWAP=${vwap.toFixed(4)} | Close=${lastClose.toFixed(4)}`);
  if (lastClose > vwap && lastClose > ema8 && rsi3 < 40) return 'BUY';
  if (lastClose < vwap && lastClose < ema8 && rsi3 > 60) return 'SELL';
  return 'HOLD';
}

async function run() {
  console.log(`\n[bot.js] Run started: ${new Date().toISOString()}`);
  ensureCSV();
  const positions = loadPositions();

  for (const symbol of CONFIG.symbols) {
    try {
      console.log(`\n[${symbol}] Fetching candles...`);
      const candles = await exchange.fetchOHLCV(symbol, CONFIG.timeframe, undefined, CONFIG.limit);
      if (!candles || candles.length < 20) continue;

      const lastClose = candles[candles.length - 1][4];
      const signal = getSignal(candles);
      const pos = positions[symbol];
      const now = new Date().toISOString();

      if (pos) {
        const pnlPct = ((lastClose - pos.entryPrice) / pos.entryPrice) * (pos.side === 'LONG' ? 1 : -1);
        if (pnlPct >= CONFIG.takeProfitPct || pnlPct <= -CONFIG.stopLossPct) {
          const result = pnlPct >= CONFIG.takeProfitPct ? 'TP_HIT' : 'SL_HIT';
          console.log(`  [${result}] Closing ${pos.side} @ ${lastClose} | PnL: ${(pnlPct * 100).toFixed(2)}%`);
          appendTrade({ timestamp: now, symbol, signal: `CLOSE_${pos.side}`, price: lastClose.toFixed(6), tp: pos.tp, sl: pos.sl, size_usdt: CONFIG.tradeSize, result, pnl_pct: (pnlPct * 100).toFixed(2) });
          delete positions[symbol]; savePositions(positions);
        } else {
          console.log(`  Holding ${pos.side} | PnL=${(pnlPct * 100).toFixed(2)}%`);
        }
        continue;
      }

      if (signal === 'BUY') {
        const tp = +(lastClose * (1 + CONFIG.takeProfitPct)).toFixed(6);
        const sl = +(lastClose * (1 - CONFIG.stopLossPct)).toFixed(6);
        positions[symbol] = { side: 'LONG', entryPrice: lastClose, tp, sl, openedAt: now };
        savePositions(positions);
        console.log(`  ✅ BUY | Entry=${lastClose} TP=${tp} SL=${sl}`);
        appendTrade({ timestamp: now, symbol, signal: 'BUY', price: lastClose.toFixed(6), tp, sl, size_usdt: CONFIG.tradeSize, result: 'OPEN', pnl_pct: '0' });
      } else if (signal === 'SELL') {
        const tp = +(lastClose * (1 - CONFIG.takeProfitPct)).toFixed(6);
        const sl = +(lastClose * (1 + CONFIG.stopLossPct)).toFixed(6);
        positions[symbol] = { side: 'SHORT', entryPrice: lastClose, tp, sl, openedAt: now };
        savePositions(positions);
        console.log(`  ✅ SELL | Entry=${lastClose} TP=${tp} SL=${sl}`);
        appendTrade({ timestamp: now, symbol, signal: 'SELL', price: lastClose.toFixed(6), tp, sl, size_usdt: CONFIG.tradeSize, result: 'OPEN', pnl_pct: '0' });
      } else {
        console.log(`  HOLD — no trade.`);
      }
    } catch (err) {
      console.error(`  Error ${symbol}:`, err.message);
    }
  }

  await pushCSVToGitHub(fs.readFileSync(CONFIG.csvFile, 'utf8'));
  console.log(`\n[bot.js] Run complete: ${new Date().toISOString()}`);
}

run().catch(console.error);
