require("dotenv").config();
// bot2.js — EMA20 + EMA50 + BB + RSI14 + Volume | TP 3% | SL 1.5%
// Exchange: BitGet USDT-M Futures | Levier: 1x | Timeframe: 1H
// PC6 — structura identica cu bot1, strategie mai restrictiva la intrare
// Fix-uri:
//   [1] defaultType: swap (Futures)
//   [2] simboluri BTC/USDT:USDT
//   [3] positions salvate pe GitHub (positions_bot2.json)
//   [4] placeOrder() cu ordine reale + TP/SL native + confirmare
//   [5] closePosition() cu qty din JSON, fara fetchPositions()
//   [6] 22002 = succes, sterge din JSON
//   [7] qty salvat la deschidere
//   [8] Telegram notificari
//   [9] Verificare conflict directie cu bot1

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PAPER_TRADING = process.env.PAPER_TRADING !== "false";
const TRADE_SIZE_USD = parseInt(process.env.TRADE_SIZE) || 10;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => { console.log('  Telegram: ✅'); resolve(); });
    });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

const CONFIG = {
  symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT'],
  timeframe: '1h',
  limit: 100,
  takeProfitPct: 0.03,
  stopLossPct: 0.015,
  leverage: 1,
  bbPeriod: 20,
  bbStdDev: 2,
  rsiPeriod: 14,
  emaFast: 20,
  emaSlow: 50,
  volumeMultiplier: { 'BTC/USDT:USDT': 1.0, 'ETH/USDT:USDT': 1.0, 'SOL/USDT:USDT': 1.2, 'DOGE/USDT:USDT': 1.2 },
  csvFile: path.join(__dirname, 'trades2.csv'),
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: 'luchianromeo-art',
    repo: 'claude-tradingview-mcp-trading',
    csvPath: 'trades2.csv',
    positionsPath: 'positions_bot2.json',
    positionsBot1Path: 'positions_bot1.json',
  },
};

const exchange = new ccxt.bitget({
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  options: { defaultType: 'swap' },
});

function shortSymbol(symbol) { return symbol.split('/')[0]; }
function formatSizeUsd(value) { return `${Number(value).toFixed(2).replace(/\.00$/, '')}$`; }
function formatPnlUsd(pnlPct) {
  const value = TRADE_SIZE_USD * (pnlPct / 100);
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}$`;
}
function formatPrice(symbol, price) {
  if (symbol.includes('BTC') || symbol.includes('ETH')) return Math.round(price).toLocaleString('en-US').replace(/,/g, '.');
  if (symbol.includes('SOL')) return price.toFixed(2);
  return price.toFixed(5);
}
function formatPct(pct) { return parseFloat(pct).toFixed(2); }
function formatDate(isoString) {
  const d = new Date(isoString);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  if (gains === 0 && losses === 0) return 50;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}
function calcBB(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * stdDev, lower: mean - mult * stdDev, mid: mean };
}
function calcAvgVol(candles, period = 20) {
  const vols = candles.slice(-period).map(c => c[5]);
  return vols.reduce((a, b) => a + b, 0) / period;
}

function getSignal(candles, symbol) {
  const closes = candles.map(c => c[4]);
  const ema20 = calcEMA(closes, CONFIG.emaFast);
  const ema50 = calcEMA(closes, CONFIG.emaSlow);
  const rsi14 = calcRSI(closes, CONFIG.rsiPeriod);
  const bb = calcBB(closes, CONFIG.bbPeriod, CONFIG.bbStdDev);
  const avgVol = calcAvgVol(candles, 20);
  const lastVol = candles[candles.length - 1][5];
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const volThreshold = CONFIG.volumeMultiplier[symbol] || 1.2;
  const volOk = volRatio >= volThreshold;
  const lastClose = closes[closes.length - 1];

  console.log(`  EMA20=${ema20.toFixed(4)} | EMA50=${ema50.toFixed(4)} | RSI14=${rsi14.toFixed(2)}`);
  console.log(`  BB[${bb.lower.toFixed(4)}-${bb.upper.toFixed(4)}] | Vol=${volRatio.toFixed(2)}x | Close=${lastClose}`);

  let signal = 'HOLD';
  if (ema20 > ema50 && lastClose <= bb.lower * 1.01 && rsi14 > 30 && rsi14 < 55 && volOk) signal = 'BUY';
  if (ema20 < ema50 && lastClose >= bb.upper * 0.99 && rsi14 > 55 && rsi14 < 80 && volOk) signal = 'SELL';

  return { signal, ema20, ema50, rsi14, bb, volRatio, lastClose };
}

async function setLeverage(symbol) {
  try {
    await exchange.setLeverage(CONFIG.leverage, symbol, { marginCoin: 'USDT', holdSide: 'long' });
    await exchange.setLeverage(CONFIG.leverage, symbol, { marginCoin: 'USDT', holdSide: 'short' });
    console.log(`  Leverage set: ${CONFIG.leverage}x (long+short)`);
  } catch (e) { console.log(`  Leverage note: ${e.message}`); }
}

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function placeOrder(symbol, signal, lastClose) {
  const minSizes = { 'BTC/USDT:USDT': 0.001, 'ETH/USDT:USDT': 0.01, 'SOL/USDT:USDT': 0.1, 'DOGE/USDT:USDT': 1 };
  const minSize = minSizes[symbol] || 0.01;
  let qty = parseFloat((TRADE_SIZE_USD / lastClose).toFixed(6));
  if (qty < minSize) qty = minSize;
  if (symbol.includes('BTC')) qty = parseFloat(qty.toFixed(3));
  else if (symbol.includes('ETH')) qty = parseFloat(qty.toFixed(2));
  else if (symbol.includes('SOL')) qty = parseFloat(qty.toFixed(1));
  else qty = parseFloat(qty.toFixed(0));

  const side = signal === 'BUY' ? 'buy' : 'sell';
  const tp = signal === 'BUY'
    ? parseFloat((lastClose * (1 + CONFIG.takeProfitPct)).toFixed(6))
    : parseFloat((lastClose * (1 - CONFIG.takeProfitPct)).toFixed(6));
  const sl = signal === 'BUY'
    ? parseFloat((lastClose * (1 - CONFIG.stopLossPct)).toFixed(6))
    : parseFloat((lastClose * (1 + CONFIG.stopLossPct)).toFixed(6));

  console.log(`  Placing ${side}: ${qty} @ ~${lastClose} | TP=${tp} SL=${sl}`);
  try {
    await setLeverage(symbol);
    const order = await exchange.createMarketOrder(symbol, side, qty, undefined, {
      tradeSide: 'open',
    });
    if (!order || !order.id) { console.error(`  ❌ Order failed: no id`); return null; }
    console.log(`  ✅ Order placed: ${order.id}`);

    // TP/SL nativ BitGet — apeluri separate dupa deschidere
    await sleep(1000);
    const closeSideTP = side === 'buy' ? 'sell' : 'buy';
    let tpOk = false, slOk = false;
    try {
      await exchange.createOrder(symbol, 'limit', closeSideTP, qty, tp, {
        tradeSide: 'close',
        reduceOnly: true,
        stopPrice: tp,
        triggerType: 'mark_price',
      });
      tpOk = true;
      console.log(`  ✅ TP setat @ ${tp}`);
    } catch (e) { console.log(`  ⚠️ TP eroare: ${e.message}`); }
    try {
      await exchange.createOrder(symbol, 'stop_market', closeSideTP, qty, undefined, {
        tradeSide: 'close',
        reduceOnly: true,
        stopPrice: sl,
        triggerType: 'mark_price',
      });
      slOk = true;
      console.log(`  ✅ SL setat @ ${sl}`);
    } catch (e) { console.log(`  ⚠️ SL eroare: ${e.message}`); }
    if (!tpOk || !slOk) {
      await sendTelegram(`⚠️ <b>BOT2 TP/SL partial</b>\n📊 ${symbol} | ${signal}\nTP:${tpOk?'✅':'❌'} SL:${slOk?'✅':'❌'}\nVerifica manual!`);
    }

    return { id: order.id, qty };
  } catch (e) {
    console.error(`  ❌ Order failed: ${e.message}`);
    return null;
  }
}

// qty din positions_bot2.json — fara fetchPositions()
// 22002 = deja inchisa = SUCCES
async function closePosition(symbol, side, qty, maxRetries = 3) {
  const closeSide = side === 'LONG' ? 'sell' : 'buy';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`  Close attempt ${attempt}/${maxRetries} | ${symbol} | qty=${qty} | ${closeSide}`);
      if (!qty || qty <= 0) { console.error(`  ❌ qty invalid: ${qty}`); return false; }
      const order = await exchange.createMarketOrder(symbol, closeSide, qty, undefined, { tradeSide: 'close' });
      if (order && order.id) { console.log(`  ✅ closed: ${order.id}`); return true; }
      console.error(`  ❌ no confirmation`);
    } catch (e) {
      if (e.message && e.message.includes('22002')) {
        console.log(`  ✅ 22002 — deja inchisa (manual sau nativ) — sterg din JSON`);
        return true;
      }
      console.error(`  ❌ attempt ${attempt}: ${e.message}`);
    }
    if (attempt < maxRetries) await sleep(1500);
  }
  return false;
}

async function getGitHubFileSHA(filePath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${filePath}`,
      method: 'GET',
      headers: { 'Authorization': `token ${CONFIG.github.token}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data).sha || null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function pushFileToGitHub(filePath, content, message) {
  const sha = await getGitHubFileSHA(filePath);
  const body = JSON.stringify({ message, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${filePath}`,
      method: 'PUT',
      headers: { 'Authorization': `token ${CONFIG.github.token}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { console.log(`  GitHub sync ${filePath}: ${[200,201].includes(res.statusCode)?'✅':'❌ '+res.statusCode}`); resolve(); });
    });
    req.on('error', e => { console.error(`  GitHub error:`, e.message); resolve(); });
    req.write(body); req.end();
  });
}

async function loadJSON(githubPath) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${githubPath}`,
      method: 'GET',
      headers: { 'Authorization': `token ${CONFIG.github.token}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content) resolve(JSON.parse(Buffer.from(parsed.content, 'base64').toString('utf8')));
          else resolve({});
        } catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.end();
  });
}

async function savePositions(positions) {
  await pushFileToGitHub(CONFIG.github.positionsPath, JSON.stringify(positions, null, 2), `positions_bot2 update ${new Date().toISOString()}`);
}

const CSV_HEADER = 'Data intrare,Symbol,Semnal,Pret intrare,TP,SL,Size,Rezultat,Data iesire,PnL $,PnL %\n';
function ensureCSV() { if (!fs.existsSync(CONFIG.csvFile)) fs.writeFileSync(CONFIG.csvFile, CSV_HEADER); }
function appendTrade(row) {
  const newLine = [row.dataIntrare, row.symbol, row.semnal, row.pretIntrare, row.tp, row.sl, row.sizeUsdt, row.rezultat, row.dataIesire, row.pnlUsd, row.pnl].join(',') + '\n';
  const existing = fs.readFileSync(CONFIG.csvFile, 'utf8');
  const rest = existing.split('\n').slice(1).join('\n');
  fs.writeFileSync(CONFIG.csvFile, CSV_HEADER + newLine + (rest.trim() ? rest.trim() + '\n' : ''));
}

async function run() {
  console.log(`\n[bot2.js] Run started: ${new Date().toISOString()}`);
  console.log(`  Mode: ${PAPER_TRADING ? '📄 PAPER TRADING' : '💰 REAL TRADING — BitGet Futures 1x'}`);
  ensureCSV();

  const positions = await loadJSON(CONFIG.github.positionsPath);
  const posBot1 = await loadJSON(CONFIG.github.positionsBot1Path);
  console.log(`  Positions loaded: ${Object.keys(positions).length} open`);
  let positionsChanged = false;

  for (const symbol of CONFIG.symbols) {
    try {
      console.log(`\n[${symbol}] Fetching candles...`);
      const candles = await exchange.fetchOHLCV(symbol, CONFIG.timeframe, undefined, CONFIG.limit);
      if (!candles || candles.length < 55) { console.log(`  Date insuficiente`); continue; }

      const lastClose = candles[candles.length - 1][4];
      const now = new Date().toISOString();
      const pos = positions[symbol];

      if (pos) {
        const pnlPct = ((lastClose - pos.entryPrice) / pos.entryPrice) * (pos.side === 'LONG' ? 1 : -1);
        const tpHit = pnlPct >= CONFIG.takeProfitPct;
        const slHit = pnlPct <= -CONFIG.stopLossPct;

        if (tpHit || slHit) {
          const result = tpHit ? 'TP_HIT' : 'SL_HIT';
          const emoji = tpHit ? '✅' : '🔴';
          console.log(`  [${result}] ${pos.side} @ ${lastClose} | PnL: ${(pnlPct*100).toFixed(2)}%`);

          if (!PAPER_TRADING) {
            const closed = await closePosition(symbol, pos.side, pos.qty);
            if (!closed) {
              console.error(`  ❌ Close failed — skip`);
              await sendTelegram(`⚠️ <b>BOT2 CLOSE FAILED</b>\n📊 ${symbol} | ${pos.side}\nVerifica manual!`);
              continue;
            }
          }

          appendTrade({
            dataIntrare: formatDate(pos.openedAt), symbol: shortSymbol(symbol),
            semnal: `CLOSE_${pos.side}`, pretIntrare: formatPrice(symbol, pos.entryPrice),
            tp: formatPrice(symbol, pos.tp), sl: formatPrice(symbol, pos.sl),
            sizeUsdt: formatSizeUsd(TRADE_SIZE_USD), rezultat: result,
            dataIesire: formatDate(now), pnlUsd: formatPnlUsd(pnlPct*100), pnl: formatPct(pnlPct*100),
          });
          await sendTelegram(`${emoji} <b>BOT2 ${result}</b>\n📊 ${symbol} | ${pos.side}\n💰 Entry: ${formatPrice(symbol, pos.entryPrice)}\n📍 Exit: ${formatPrice(symbol, lastClose)}\n📈 PnL: ${(pnlPct*100).toFixed(2)}%\n💵 ${tpHit?'+':''}${(pnlPct*TRADE_SIZE_USD).toFixed(3)} USDT`);
          delete positions[symbol];
          positionsChanged = true;
        } else {
          console.log(`  Holding ${pos.side} | Entry=${pos.entryPrice} | Now=${lastClose} | PnL=${(pnlPct*100).toFixed(2)}%`);
        }
        continue;
      }

      const signalData = getSignal(candles, symbol);
      const signal = signalData.signal;
      if (signal !== 'BUY' && signal !== 'SELL') { console.log(`  HOLD — no trade.`); continue; }

      // Verifica conflict directie cu bot1
      const b1pos = posBot1[symbol];
      if (b1pos) {
        const conflict = (signal === 'BUY' && b1pos.side === 'LONG') || (signal === 'SELL' && b1pos.side === 'SHORT');
        if (conflict) { console.log(`  ⚠️ SKIP — conflict cu Bot1 (${b1pos.side})`); continue; }
      }

      const side = signal === 'BUY' ? 'LONG' : 'SHORT';
      const tp = signal === 'BUY' ? +(lastClose*(1+CONFIG.takeProfitPct)).toFixed(6) : +(lastClose*(1-CONFIG.takeProfitPct)).toFixed(6);
      const sl = signal === 'BUY' ? +(lastClose*(1-CONFIG.stopLossPct)).toFixed(6) : +(lastClose*(1+CONFIG.stopLossPct)).toFixed(6);

      let qty;
      if (!PAPER_TRADING) {
        const order = await placeOrder(symbol, signal, lastClose);
        if (!order) { console.error(`  ❌ Order failed — skip`); continue; }
        qty = order.qty;
      } else {
        const minSizes = { 'BTC/USDT:USDT': 0.001, 'ETH/USDT:USDT': 0.01, 'SOL/USDT:USDT': 0.1, 'DOGE/USDT:USDT': 1 };
        qty = parseFloat((TRADE_SIZE_USD / lastClose).toFixed(6));
        if (qty < (minSizes[symbol]||0.01)) qty = minSizes[symbol]||0.01;
        console.log(`  [PAPER] ${signal} qty=${qty} TP=${tp} SL=${sl}`);
      }

      positions[symbol] = { side, entryPrice: lastClose, qty, tp, sl, openedAt: now };
      positionsChanged = true;
      console.log(`  ✅ ${signal} | Entry=${lastClose} TP=${tp} SL=${sl} qty=${qty}`);

      appendTrade({
        dataIntrare: formatDate(now), symbol: shortSymbol(symbol), semnal: signal,
        pretIntrare: formatPrice(symbol, lastClose), tp: formatPrice(symbol, tp), sl: formatPrice(symbol, sl),
        sizeUsdt: formatSizeUsd(TRADE_SIZE_USD), rezultat: 'OPEN', dataIesire: '', pnlUsd: '0.00$', pnl: '0.00',
      });
      const emoji = signal === 'BUY' ? '🟢' : '🔴';
      await sendTelegram(`${emoji} <b>BOT2 ${signal}</b>\n📊 ${symbol}\n💰 Entry: ${formatPrice(symbol, lastClose)}\n🎯 TP: ${formatPrice(symbol, tp)} (+3%)\n🛑 SL: ${formatPrice(symbol, sl)} (-1.5%)\n💵 Size: ${TRADE_SIZE_USD} USDT\n${PAPER_TRADING?'📄 PAPER':'💰 REAL'}`);

    } catch (err) {
      console.error(`  Error ${symbol}:`, err.message);
    }
  }

  if (positionsChanged) await savePositions(positions);
  await pushFileToGitHub(CONFIG.github.csvPath, fs.readFileSync(CONFIG.csvFile, 'utf8'), `trades2.csv update ${new Date().toISOString()}`);
  console.log(`\n[bot2.js] Run complete: ${new Date().toISOString()}`);
}

run().catch(console.error);
