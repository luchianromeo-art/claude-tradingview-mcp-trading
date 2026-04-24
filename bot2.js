// bot2.js — EMA20 + EMA50 + RSI14 + Bollinger Bands + Volume | TP 3% | SL 1.5%
// Exchange: BitGet | Timeframe: 1H | Results: trades2.csv

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
  bbPeriod: 20,
  bbStdDev: 2,
  rsiPeriod: 14,
  emaFast: 20,
  emaSlow: 50,
  volumeMultiplier: 1.2,
  csvFile: path.join(__dirname, 'trades2.csv'),
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: 'luchianromeo-art',
    repo: 'claude-tradingview-mcp-trading',
    path: 'trades2.csv',
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

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const rs = (losses / period) === 0 ? 100 : (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcBB(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * stdDev, middle: mean, lower: mean - mult * stdDev, bandwidth: (2 * mult * stdDev) / mean };
}

function calcAvgVol(candles, period = 20) {
  const vols = candles.slice(-period).map(c => c[5]);
  return vols.reduce((a, b) => a + b, 0) / period;
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
  const body = JSON.stringify({ message: `trades2.csv update ${new Date().toISOString()}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
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
      res.on('end', () => { console.log(`  GitHub sync trades2.csv: ${[200,201].includes(res.statusCode) ? '✅' : '❌ ' + res.statusCode}`); resolve(); });
    });
    req.on('error', (e) => { console.error('  GitHub sync error:', e.message); resolve(); });
    req.write(body); req.end();
  });
}

const CSV_HEADER = 'timestamp,symbol,signal,price,tp,sl,size_usdt,ema20,ema50,rsi14,bb_upper,bb_lower,bb_width,vol_ratio,result,pnl_pct\n';

function ensureCSV() {
  if (!fs.existsSync(CONFIG.csvFile)) fs.writeFileSync(CONFIG.csvFile, CSV_HEADER);
}

function appendTrade(row) {
  fs.appendFileSync(CONFIG.csvFile, [row.timestamp, row.symbol, row.signal, row.price, row.tp, row.sl, row.size_usdt, row.ema20, row.ema50, row.rsi14, row.bb_upper, row.bb_lower, row.bb_width, row.vol_ratio, row.result, row.pnl_pct].join(',') + '\n');
}

const positionsFile = path.join(__dirname, 'positions_bot2.json');
function loadPositions() { try { return JSON.parse(fs.readFileSync(positionsFile, 'utf8')); } catch { return {}; } }
function savePositions(p) { fs.writeFileSync(positionsFile, JSON.stringify(p, null, 2)); }

function getSignal(candles) {
  const closes = candles.map(c => c[4]);
  const ema20 = calcEMA(closes, CONFIG.emaFast);
  const ema50 = calcEMA(closes, CONFIG.emaSlow);
  const rsi14 = calcRSI(closes, CONFIG.rsiPeriod);
  const bb = calcBB(closes, CONFIG.bbPeriod, CONFIG.bbStdDev);
  const lastClose = closes[closes.length - 1];
  const avgVol = calcAvgVol(candles, 20);
  const lastVol = candles[candles.length - 1][5];
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const volOk = volRatio >= CONFIG.volumeMultiplier;

  console.log(`  EMA20=${ema20.toFixed(4)} EMA50=${ema50.toFixed(4)} RSI14=${rsi14.toFixed(2)} BB[${bb.lower.toFixed(4)}-${bb.upper.toFixed(4)}] Vol=${volRatio.toFixed(2)}x Close=${lastClose.toFixed(4)}`);

  if (ema20 > ema50 && lastClose <= bb.lower * 1.01 && rsi14 > 30 && rsi14 < 55 && volOk)
    return { signal: 'BUY', ema20, ema50, rsi14, bb, volRatio };
  if (ema20 < ema50 && lastClose >= bb.upper * 0.99 && rsi14 > 55 && rsi14 < 80 && volOk)
    return { signal: 'SELL', ema20, ema50, rsi14, bb, volRatio };

  return { signal: 'HOLD', ema20, ema50, rsi14, bb, volRatio };
}

async function run() {
  console.log(`\n[bot2.js] Run started: ${new Date().toISOString()}`);
  ensureCSV();
  const positions = loadPositions();

  for (const symbol of CONFIG.symbols) {
    try {
      console.log(`\n[${symbol}] Fetching candles...`);
      const candles = await exchange.fetchOHLCV(symbol, CONFIG.timeframe, undefined, CONFIG.limit);
      if (!candles || candles.length < 55) continue;

      const lastClose = candles[candles.length - 1][4];
      const { signal, ema20, ema50, rsi14, bb, volRatio } = getSignal(candles);
      const pos = positions[symbol];
      const now = new Date().toISOString();

      if (pos) {
        const pnlPct = ((lastClose - pos.entryPrice) / pos.entryPrice) * (pos.side === 'LONG' ? 1 : -1);
        if (pnlPct >= CONFIG.takeProfitPct || pnlPct <= -CONFIG.stopLossPct) {
          const result = pnlPct >= CONFIG.takeProfitPct ? 'TP_HIT' : 'SL_HIT';
          console.log(`  [${result}] Closing ${pos.side} @ ${lastClose} | PnL: ${(pnlPct * 100).toFixed(2)}%`);
          appendTrade({ timestamp: now, symbol, signal: `CLOSE_${pos.side}`, price: lastClose.toFixed(6), tp: pos.tp, sl: pos.sl, size_usdt: CONFIG.tradeSize, ema20: ema20.toFixed(4), ema50: ema50.toFixed(4), rsi14: rsi14.toFixed(2), bb_upper: bb.upper.toFixed(4), bb_lower: bb.lower.toFixed(4), bb_width: bb.bandwidth.toFixed(4), vol_ratio: volRatio.toFixed(2), result, pnl_pct: (pnlPct * 100).toFixed(2) });
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
        appendTrade({ timestamp: now, symbol, signal: 'BUY', price: lastClose.toFixed(6), tp, sl, size_usdt: CONFIG.tradeSize, ema20: ema20.toFixed(4), ema50: ema50.toFixed(4), rsi14: rsi14.toFixed(2), bb_upper: bb.upper.toFixed(4), bb_lower: bb.lower.toFixed(4), bb_width: bb.bandwidth.toFixed(4), vol_ratio: volRatio.toFixed(2), result: 'OPEN', pnl_pct: '0' });
      } else if (signal === 'SELL') {
        const tp = +(lastClose * (1 - CONFIG.takeProfitPct)).toFixed(6);
        const sl = +(lastClose * (1 + CONFIG.stopLossPct)).toFixed(6);
        positions[symbol] = { side: 'SHORT', entryPrice: lastClose, tp, sl, openedAt: now };
        savePositions(positions);
        console.log(`  ✅ SELL | Entry=${lastClose} TP=${tp} SL=${sl}`);
        appendTrade({ timestamp: now, symbol, signal: 'SELL', price: lastClose.toFixed(6), tp, sl, size_usdt: CONFIG.tradeSize, ema20: ema20.toFixed(4), ema50: ema50.toFixed(4), rsi14: rsi14.toFixed(2), bb_upper: bb.upper.toFixed(4), bb_lower: bb.lower.toFixed(4), bb_width: bb.bandwidth.toFixed(4), vol_ratio: volRatio.toFixed(2), result: 'OPEN', pnl_pct: '0' });
      } else {
        console.log(`  HOLD — no trade.`);
      }
    } catch (err) {
      console.error(`  Error ${symbol}:`, err.message);
    }
  }

  await pushCSVToGitHub(fs.readFileSync(CONFIG.csvFile, 'utf8'));
  console.log(`\n[bot2.js] Run complete: ${new Date().toISOString()}`);
}

run().catch(console.error);
