require("dotenv").config();
// bot.js — VWAP + EMA8 + RSI3 | TP 3% | SL 1.5%
// Exchange: BitGet USDT-M Futures | Levier: 1x | Timeframe: 1H
// PC6 fix:
//   [1] closePosition foloseste qty din positions_bot1.json — fara fetchPositions()
//   [2] 22002 = succes in orice situatie — sterge din JSON
//   [3] qty salvat la deschidere in positions
//   [4] TP/SL confirmare dupa deschidere
//   [5] Verificare conflict directie cu bot2

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
  csvFile: path.join(__dirname, 'trades.csv'),
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: 'luchianromeo-art',
    repo: 'claude-tradingview-mcp-trading',
    csvPath: 'trades.csv',
    positionsPath: 'positions_bot1.json',
    positionsBot2Path: 'positions_bot2.json',
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
function calcRSI(closes, period = 3) {
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
function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) { const tp = (c[2] + c[3] + c[4]) / 3; cumTPV += tp * c[5]; cumVol += c[5]; }
  return cumVol === 0 ? 0 : cumTPV / cumVol;
}
function getSignal(candles) {
  const closes = candles.map(c => c[4]);
  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);
  const vwap = calcVWAP(candles);
  const lastClose = closes[closes.length - 1];
  let signal = 'HOLD';
  if (lastClose > vwap && lastClose > ema8 && rsi3 < 40) signal = 'BUY';
  if (lastClose < vwap && lastClose < ema8 && rsi3 > 60) signal = 'SELL';
  return { signal, ema8, rsi3, vwap, lastClose };
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
      takeProfit: { triggerPrice: tp },
      stopLoss: { triggerPrice: sl },
    });
    if (!order || !order.id) { console.error(`  ❌ Order failed: no id`); return null; }
    console.log(`  ✅ Order placed: ${order.id}`);

    // [FIX PC6] Confirmare TP/SL dupa 2s
    await sleep(2000);
    try {
      const openOrders = await exchange.fetchOpenOrders(symbol);
      const hasTp = openOrders.some(o => o.type && o.type.toLowerCase().includes('take_profit'));
      const hasSl = openOrders.some(o => o.type && o.type.toLowerCase().includes('stop'));
      console.log(`  TP: ${hasTp ? '✅' : '⚠️ NU gasit'} | SL: ${hasSl ? '✅' : '⚠️ NU gasit'}`);
      if (!hasTp || !hasSl) {
        await sendTelegram(`⚠️ <b>BOT1 TP/SL partial</b>\n📊 ${symbol} | ${signal}\nTP:${hasTp?'✅':'❌'} SL:${hasSl?'✅':'❌'}\nVerifica manual!`);
      }
    } catch (e) { console.log(`  TP/SL check skip: ${e.message}`); }

    return { id: order.id, qty };
  } catch (e) {
    console.error(`  ❌ Order failed: ${e.message}`);
    return null;
  }
}

// [FIX PC6] qty din positions_bot1.json — fara fetchPositions()
// [FIX PC6] 22002 = pozitie deja inchisa = SUCCES, sterge din JSON
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
  await pushFileToGitHub(CONFIG.github.positionsPath, JSON.stringify(positions, null, 2), `positions_bot1 update ${new Date().toISOString()}`);
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
  console.log(`\n[bot.js] Run started: ${new Date().toISOString()}`);
  console.log(`  Mode: ${PAPER_TRADING ? '📄 PAPER TRADING' : '💰 REAL TRADING — BitGet Futures 1x'}`);
  ensureCSV();

  const positions = await loadJSON(CONFIG.github.positionsPath);
  const posBot2 = await loadJSON(CONFIG.github.positionsBot2Path);
  console.log(`  Positions loaded: ${Object.keys(positions).length} open`);
  let positionsChanged = false;

  for (const symbol of CONFIG.symbols) {
    try {
      console.log(`\n[${symbol}] Fetching candles...`);
      const candles = await exchange.fetchOHLCV(symbol, CONFIG.timeframe, undefined, CONFIG.limit);
      if (!candles || candles.length < 20) continue;

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
            // [FIX PC6] qty din JSON, fara fetchPositions
            const closed = await closePosition(symbol, pos.side, pos.qty);
            if (!closed) {
              console.error(`  ❌ Close failed — skip`);
              await sendTelegram(`⚠️ <b>BOT1 CLOSE FAILED</b>\n📊 ${symbol} | ${pos.side}\nVerifica manual!`);
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
          await sendTelegram(`${emoji} <b>BOT1 ${result}</b>\n📊 ${symbol} | ${pos.side}\n💰 Entry: ${formatPrice(symbol, pos.entryPrice)}\n📍 Exit: ${formatPrice(symbol, lastClose)}\n📈 PnL: ${(pnlPct*100).toFixed(2)}%\n💵 ${tpHit?'+':''}${(pnlPct*TRADE_SIZE_USD).toFixed(3)} USDT`);
          delete positions[symbol];
          positionsChanged = true;
        } else {
          console.log(`  Holding ${pos.side} | Entry=${pos.entryPrice} | Now=${lastClose} | PnL=${(pnlPct*100).toFixed(2)}%`);
        }
        continue;
      }

      const signalData = getSignal(candles);
      const signal = signalData.signal;
      console.log(`  EMA8=${signalData.ema8.toFixed(4)} | RSI3=${signalData.rsi3.toFixed(2)} | VWAP=${signalData.vwap.toFixed(4)} | Close=${signalData.lastClose}`);

      if (signal !== 'BUY' && signal !== 'SELL') { console.log(`  HOLD — no trade.`); continue; }

      // [FIX PC6] Verifica conflict directie cu bot2
      const b2pos = posBot2[symbol];
      if (b2pos) {
        const conflict = (signal === 'BUY' && b2pos.side === 'LONG') || (signal === 'SELL' && b2pos.side === 'SHORT');
        if (conflict) { console.log(`  ⚠️ SKIP — conflict cu Bot2 (${b2pos.side})`); continue; }
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

      // [FIX PC6] qty salvat in positions
      positions[symbol] = { side, entryPrice: lastClose, qty, tp, sl, openedAt: now };
      positionsChanged = true;
      console.log(`  ✅ ${signal} | Entry=${lastClose} TP=${tp} SL=${sl} qty=${qty}`);

      appendTrade({
        dataIntrare: formatDate(now), symbol: shortSymbol(symbol), semnal: signal,
        pretIntrare: formatPrice(symbol, lastClose), tp: formatPrice(symbol, tp), sl: formatPrice(symbol, sl),
        sizeUsdt: formatSizeUsd(TRADE_SIZE_USD), rezultat: 'OPEN', dataIesire: '', pnlUsd: '0.00$', pnl: '0.00',
      });
      const emoji = signal === 'BUY' ? '🟢' : '🔴';
      await sendTelegram(`${emoji} <b>BOT1 ${signal}</b>\n📊 ${symbol}\n💰 Entry: ${formatPrice(symbol, lastClose)}\n🎯 TP: ${formatPrice(symbol, tp)} (+3%)\n🛑 SL: ${formatPrice(symbol, sl)} (-1.5%)\n💵 Size: ${TRADE_SIZE_USD} USDT\n${PAPER_TRADING?'📄 PAPER':'💰 REAL'}`);

    } catch (err) {
      console.error(`  Error ${symbol}:`, err.message);
    }
  }

  if (positionsChanged) await savePositions(positions);
  await pushFileToGitHub(CONFIG.github.csvPath, fs.readFileSync(CONFIG.csvFile, 'utf8'), `trades.csv update ${new Date().toISOString()}`);
  console.log(`\n[bot.js] Run complete: ${new Date().toISOString()}`);
}

run().catch(console.error);
