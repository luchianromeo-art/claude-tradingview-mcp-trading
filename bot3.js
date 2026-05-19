// bot3.js — v2 | Regime + Direction + Pullback + Volume/ATR | BitGet USDT-M Futures | Railway
// PC14: ETH+SOL+DOGE+XRP | Cross-bot conflict | RSI fix | Math.floor | GitHub retry | Scor granular
//       notExtended 0.55 ATR | EXIT_NEGATIVE 2 runuri | EXIT_ABSOLUTE -3% dupa 2h | fara setLeverage

const ccxt   = require('ccxt');
const https  = require('https');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SYMBOLS        = ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT', 'XRP/USDT:USDT'];
const TIMEFRAME      = '15m';
const CANDLES_LIMIT  = 140;
const TRADE_SIZE     = parseFloat(process.env.TRADE_SIZE || '10');
const PAPER_TRADING  = process.env.PAPER_TRADING === 'true';
const MIN_SCORE      = 55;
const COOLDOWN_SL_MS = 240 * 60 * 1000;  // 4h dupa SL
const COOLDOWN_TP_MS = 30  * 60 * 1000;  // 30min dupa TP
const NEG_RUNS_LIMIT = 2;
const NEG_RESET_PCT  = 0.002;
const EXIT_ABS_PCT   = -0.03;
const EXIT_ABS_MS    = 2 * 60 * 60 * 1000;
const NOT_EXTENDED   = 0.80;   // marit de la 0.55 — prinde si situatii de crash/oversold
const BOT_NAME       = 'Bot3';
const CSV_FILE       = 'data/trades3.csv';
const POSITIONS_FILE = 'data/positions_bot3.json';
const BOT1_POS_FILE  = 'data/positions_bot1.json';
const BOT2_POS_FILE  = 'data/positions_bot2.json';
const GITHUB_REPO    = 'luchianromeo-art/claude-tradingview-mcp-trading';

const MIN_QTY = {
  'ETH/USDT:USDT':  0.01,
  'SOL/USDT:USDT':  0.1,
  'DOGE/USDT:USDT': 1,
  'XRP/USDT:USDT':  1,
};

const exchange = new ccxt.bitget({
  apiKey:   process.env.BITGET_API_KEY,
  secret:   process.env.BITGET_SECRET,
  password: process.env.BITGET_PASSPHRASE,
  options:  { defaultType: 'swap' },
});

// ─── ORA ROMANIA ─────────────────────────────────────────────────────────────
function getRoTime() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}

function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth()+1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ─── GITHUB API ───────────────────────────────────────────────────────────────
async function githubGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${GITHUB_REPO}/contents/${path}`, method: 'GET',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json' },
    }, (res) => { let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data))); });
    req.on('error', reject); req.end();
  });
}

async function githubPut(path, content, sha) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message: `${BOT_NAME} update ${path}`, content: Buffer.from(content).toString('base64'), sha: sha || undefined });
    const req = https.request({
      hostname: 'api.github.com', path: `/repos/${GITHUB_REPO}/contents/${path}`, method: 'PUT',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'trading-bot', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function loadPositions(filename) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await githubGet(filename);
      if (res.content) {
        const data = JSON.parse(Buffer.from(res.content, 'base64').toString('utf8'));
        console.log(`[${BOT_NAME}] loadPositions ${filename}: ${Object.keys(data).length} pozitii`);
        return { data, sha: res.sha };
      }
    } catch (e) {
      console.log(`[${BOT_NAME}] loadPositions error attempt ${attempt}: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { data: {}, sha: null };
}

async function savePositions(filename, positions, sha) {
  try {
    let freshSha = sha;
    try { const c = await githubGet(filename); if (c && c.sha) freshSha = c.sha; } catch (e) {}
    const result = await githubPut(filename, JSON.stringify(positions, null, 2), freshSha);
    // Retry pe 409 conflict SHA
    if (result && result.message && result.message.includes('409')) {
      const c = await githubGet(filename);
      await githubPut(filename, JSON.stringify(positions, null, 2), c.sha);
    }
  } catch (e) { console.error(`[${BOT_NAME}] savePositions error:`, e.message); }
}

async function loadCSV() {
  try { const res = await githubGet(CSV_FILE); if (res.content) return { text: Buffer.from(res.content, 'base64').toString('utf8'), sha: res.sha }; } catch (e) {}
  return { text: 'Data,Symbol,Semnal,Pret intrare,TP,SL,Size,Regim,Score,ATR%,Rezultat,Data iesire,PnL $,PnL %\n', sha: null };
}

async function appendCSV(row, existingCSV) {
  const lines = existingCSV.text.trim().split('\n');
  const newContent = lines[0] + '\n' + row + (lines.slice(1).join('\n') ? '\n' + lines.slice(1).join('\n') : '') + '\n';
  let freshSha = existingCSV.sha;
  try { const c = await githubGet(CSV_FILE); if (c && c.sha) freshSha = c.sha; } catch (e) {}
  await githubPut(CSV_FILE, newContent, freshSha);
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text: `🟣 [BOT3] ${msg}` });
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', reject); req.write(body); req.end();
    });
  } catch (e) { console.error(`[${BOT_NAME}] Telegram error:`, e.message); }
}

// ─── BITGET SIGN + CLOSE ─────────────────────────────────────────────────────
function bitgetSign(ts, method, path, body = '') {
  return crypto.createHmac('sha256', process.env.BITGET_SECRET).update(ts + method.toUpperCase() + path + body).digest('base64');
}

async function cancelBitgetTPSL(symbol, side) {
  const productId = symbol.replace('/USDT:USDT', 'USDT');
  const holdSide  = side === 'long' ? 'long' : 'short';
  const path      = '/api/v2/mix/order/cancel-plan-order';
  const ts        = Date.now().toString();
  const bodyStr   = JSON.stringify({ symbol: productId, productType: 'USDT-FUTURES', marginCoin: 'USDT', holdSide });
  try {
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.bitget.com', path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ACCESS-KEY': process.env.BITGET_API_KEY, 'ACCESS-SIGN': bitgetSign(ts, 'POST', path, bodyStr), 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE, 'Content-Length': Buffer.byteLength(bodyStr) } },
        (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
      req.on('error', reject); req.write(bodyStr); req.end();
    });
  } catch (e) { console.log(`[${BOT_NAME}] cancelTPSL skip: ${e.message}`); }
}

async function closePosition(symbol, side, qty) {
  await cancelBitgetTPSL(symbol, side);
  try { await exchange.cancelAllOrders(symbol); } catch (e) {}
  const productId = symbol.replace('/USDT:USDT', 'USDT');
  const path      = '/api/v2/mix/order/place-order';
  const ts        = Date.now().toString();
  const closeSide = side === 'long' ? 'sell' : 'buy';
  const bodyStr   = JSON.stringify({ symbol: productId, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT', side: closeSide, tradeSide: 'close', orderType: 'market', size: String(qty) });
  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.bitget.com', path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ACCESS-KEY': process.env.BITGET_API_KEY, 'ACCESS-SIGN': bitgetSign(ts, 'POST', path, bodyStr), 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE, 'Content-Length': Buffer.byteLength(bodyStr) } },
        (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
      req.on('error', reject); req.write(bodyStr); req.end();
    });
    if (result.code === '00000') { console.log(`[${BOT_NAME}] Pozitie inchisa OK: ${symbol}`); return true; }
    if (result.code === '22002') { console.log(`[${BOT_NAME}] closePosition 22002 — pozitie inexistenta: ${symbol}`); return false; }
    console.error(`[${BOT_NAME}] closePosition error: ${JSON.stringify(result)}`);
    return false;
  } catch (e) { console.error(`[${BOT_NAME}] closePosition error: ${e.message}`); return false; }
}

// ─── INDICATORI ──────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  // Fix simetric: gains=0 => 1, losses=0 => 99, ambele=0 => 50
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 99;
  if (gains  === 0) return 1;
  return 100 - 100 / (1 + gains / losses);
}

function calcATR(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i][2], low = candles[i][3], prevClose = candles[i-1][4];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcBB(closes, period = 20) {
  const mid = calcSMA(closes, period);
  if (!mid) return null;
  const slice = closes.slice(-period);
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
  return { upper: mid + 2 * std, lower: mid - 2 * std, mid };
}

function calcRollingVWAP(candles, period = 48) {
  const slice = candles.slice(-period);
  let pv = 0, vol = 0;
  for (const c of slice) { const tp = (c[2] + c[3] + c[4]) / 3; pv += tp * c[5]; vol += c[5]; }
  return vol > 0 ? pv / vol : null;
}

function calcIndicators(candles) {
  const closes  = candles.map(c => c[4]);
  const volumes = candles.map(c => c[5]);
  const last    = { open: candles[candles.length-1][1], high: candles[candles.length-1][2], low: candles[candles.length-1][3], close: candles[candles.length-1][4], volume: candles[candles.length-1][5] };

  const ema20     = calcEMA(closes, 20);
  const ema50     = calcEMA(closes, 50);
  const prevEma20 = calcEMA(closes.slice(0, -1), 20);
  const vwap      = calcRollingVWAP(candles, 48);
  const rsi14     = calcRSI(closes, 14);
  const atr14     = calcATR(candles, 14);
  const bb        = calcBB(closes, 20);
  const avgVol20  = calcSMA(volumes, 20);

  if ([ema20, ema50, prevEma20, vwap, atr14, bb, avgVol20].some(x => x === null)) return null;

  const atrPct      = (atr14 / last.close) * 100;
  const bbWidthPct  = ((bb.upper - bb.lower) / last.close) * 100;
  const volRatio    = avgVol20 > 0 ? last.volume / avgVol20 : 0;
  const trendStr    = atr14 > 0 ? Math.abs(ema20 - ema50) / atr14 : 0;
  const emaSlope    = ema20 - prevEma20;
  const distAtr     = atr14 > 0 ? Math.abs(last.close - ema20) / atr14 : 99;

  return { last, ema20, ema50, prevEma20, vwap, rsi14, atr14, bb, avgVol20, atrPct, bbWidthPct, volRatio, trendStr, emaSlope, distAtr };
}

// ─── SCOR GRANULAR ────────────────────────────────────────────────────────────
function buildSignal(symbol, ind) {
  const c           = ind.last;
  const trendRegime = ind.trendStr >= 0.35 && ind.bbWidthPct >= 0.35;
  const rangeRegime = ind.trendStr < 0.35  && ind.bbWidthPct >= 0.25;
  const volatilityOk = ind.atrPct >= 0.08 && ind.atrPct <= 4.5 && ind.bbWidthPct >= 0.25;
  const volumeOk     = ind.volRatio >= 0.3;
  const notExtended  = ind.distAtr <= NOT_EXTENDED;  // 0.55 ATR — fix din rezumat

  const longBias  = c.close > ind.vwap && ind.ema20 > ind.ema50 && ind.emaSlope > 0;
  const shortBias = c.close < ind.vwap && ind.ema20 < ind.ema50 && ind.emaSlope < 0;

  const longPullback =
    (c.low <= ind.ema20 * 1.003 || c.low <= ind.vwap * 1.003) &&
    c.close > ind.ema20 && c.close > c.open &&
    c.close < ind.bb.upper * 0.997 &&
    ind.rsi14 >= 42 && ind.rsi14 <= 62 && notExtended;

  const shortPullback =
    (c.high >= ind.ema20 * 0.997 || c.high >= ind.vwap * 0.997) &&
    c.close < ind.ema20 && c.close < c.open &&
    c.close > ind.bb.lower * 1.003 &&
    ind.rsi14 >= 38 && ind.rsi14 <= 58 && notExtended;

  const rangeLong =
    rangeRegime && c.low <= ind.bb.lower * 1.01 &&
    c.close > c.open &&
    ind.rsi14 <= 42 && volumeOk && volatilityOk;

  const rangeShort =
    rangeRegime && c.high >= ind.bb.upper * 0.99 &&
    c.close < c.open &&
    ind.rsi14 >= 58 && volumeOk && volatilityOk;

  const candidates = [];

  // OVERSOLD_EXTREME — RSI < 25 si dist > 1.5 ATR — crash rebound long
  const oversoldExtreme = ind.rsi14 <= 25 && ind.distAtr >= 1.5 && ind.volRatio >= 0.3 &&
    c.close < ind.ema20 && ind.bbWidthPct >= 0.8;
  if (oversoldExtreme) {
    let score = 55;
    score += ind.rsi14 <= 18 ? 10 : ind.rsi14 <= 22 ? 7 : 3;
    score += ind.volRatio >= 2.0 ? 10 : ind.volRatio >= 1.3 ? 6 : 2;
    score += ind.distAtr >= 3.0 ? 8 : ind.distAtr >= 2.0 ? 5 : 2;
    score += ind.bbWidthPct >= 2.0 ? 5 : ind.bbWidthPct >= 1.5 ? 3 : 1;
    candidates.push({ side: 'long', regime: 'OVERSOLD_EXTREME', score: Math.min(100, score) });
  }

  // OVERBOUGHT_EXTREME — RSI > 75 si dist > 1.5 ATR — spike reversion short
  const overboughtExtreme = ind.rsi14 >= 75 && ind.distAtr >= 1.5 && ind.volRatio >= 0.3 &&
    c.close > ind.ema20 && ind.bbWidthPct >= 0.8;
  if (overboughtExtreme) {
    let score = 55;
    score += ind.rsi14 >= 82 ? 10 : ind.rsi14 >= 78 ? 7 : 3;
    score += ind.volRatio >= 2.0 ? 10 : ind.volRatio >= 1.3 ? 6 : 2;
    score += ind.distAtr >= 3.0 ? 8 : ind.distAtr >= 2.0 ? 5 : 2;
    score += ind.bbWidthPct >= 2.0 ? 5 : ind.bbWidthPct >= 1.5 ? 3 : 1;
    candidates.push({ side: 'short', regime: 'OVERBOUGHT_EXTREME', score: Math.min(100, score) });
  }

  // Scor granular — fiecare filtru contribuie separat, fara baseScore fix 100
  if (trendRegime && longBias && longPullback && volumeOk && volatilityOk) {
    let score = 50;  // baza trend
    score += ind.trendStr >= 0.6 ? 10 : ind.trendStr >= 0.45 ? 6 : 3;   // trend strength
    score += ind.volRatio >= 1.5 ? 10 : ind.volRatio >= 1.3 ? 7 : 4;    // volum
    score += ind.distAtr <= 0.35 ? 8 : ind.distAtr <= 0.45 ? 5 : 2;     // distanta entry curata
    score += ind.rsi14 >= 48 && ind.rsi14 <= 55 ? 6 : 3;                // RSI zona optima
    score += ind.bbWidthPct >= 0.6 ? 5 : ind.bbWidthPct >= 0.45 ? 3 : 1;// volatilitate ok
    candidates.push({ side: 'long', regime: 'TREND_PULLBACK', score: Math.min(100, score) });
  }
  if (trendRegime && shortBias && shortPullback && volumeOk && volatilityOk) {
    let score = 50;
    score += ind.trendStr >= 0.6 ? 10 : ind.trendStr >= 0.45 ? 6 : 3;
    score += ind.volRatio >= 1.5 ? 10 : ind.volRatio >= 1.3 ? 7 : 4;
    score += ind.distAtr <= 0.35 ? 8 : ind.distAtr <= 0.45 ? 5 : 2;
    score += ind.rsi14 >= 45 && ind.rsi14 <= 52 ? 6 : 3;
    score += ind.bbWidthPct >= 0.6 ? 5 : ind.bbWidthPct >= 0.45 ? 3 : 1;
    candidates.push({ side: 'short', regime: 'TREND_PULLBACK', score: Math.min(100, score) });
  }
  if (rangeLong)  {
    let score = 40;
    score += ind.volRatio >= 1.5 ? 10 : ind.volRatio >= 1.3 ? 6 : 3;
    score += ind.rsi14 <= 35 ? 8 : ind.rsi14 <= 38 ? 5 : 2;
    score += ind.distAtr <= 0.35 ? 6 : 3;
    candidates.push({ side: 'long',  regime: 'RANGE_REVERSION', score: Math.min(100, score) });
  }
  if (rangeShort) {
    let score = 40;
    score += ind.volRatio >= 1.5 ? 10 : ind.volRatio >= 1.3 ? 6 : 3;
    score += ind.rsi14 >= 65 ? 8 : ind.rsi14 >= 62 ? 5 : 2;
    score += ind.distAtr <= 0.35 ? 6 : 3;
    candidates.push({ side: 'short', regime: 'RANGE_REVERSION', score: Math.min(100, score) });
  }

  if (!candidates.length) {
    const why = [
      `trendRegime=${trendRegime}(str=${ind.trendStr.toFixed(2)},bb=${ind.bbWidthPct.toFixed(2)}%)`,
      `rangeRegime=${rangeRegime}`,
      `volOk=${volumeOk}(${ind.volRatio.toFixed(2)})`,
      `volatOk=${volatilityOk}(atr=${ind.atrPct.toFixed(2)}%,bb=${ind.bbWidthPct.toFixed(2)}%)`,
      `longBias=${longBias}(close>${ind.vwap.toFixed(2)}?${c.close > ind.vwap},slope=${ind.emaSlope.toFixed(4)})`,
      `shortBias=${shortBias}`,
      `longPB=${longPullback}`,
      `shortPB=${shortPullback}`,
      `notExt=${notExtended}(dist=${ind.distAtr.toFixed(2)})`,
      `rsi=${ind.rsi14.toFixed(1)}`,
    ].join(' | ');
    return { action: 'standby', reason: `No setup | ${why}`, score: 0 };
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (best.score < MIN_SCORE) return { action: 'standby', reason: `Score ${best.score} < min ${MIN_SCORE} | ${best.regime}`, score: best.score };

  const isTrend = best.regime === 'TREND_PULLBACK';
  const slPct   = Math.min(Math.max((ind.atr14 / ind.last.close) * (isTrend ? 1.05 : 0.85), 0.008), 0.02);
  const tpPct   = Math.min(Math.max(slPct * (isTrend ? 1.7 : 1.25), 0.012), 0.032);

  const tp = best.side === 'long' ? c.close * (1 + tpPct) : c.close * (1 - tpPct);
  const sl = best.side === 'long' ? c.close * (1 - slPct) : c.close * (1 + slPct);

  return {
    action: 'open', side: best.side, regime: best.regime, score: best.score,
    entryRef: c.close, tp, sl, atr: ind.atr14, atrPct: ind.atrPct,
    reason: `${best.regime} ${best.side.toUpperCase()} | score=${best.score} | vol=${ind.volRatio.toFixed(2)} bb=${ind.bbWidthPct.toFixed(2)}% atr=${ind.atrPct.toFixed(2)}% rsi=${ind.rsi14.toFixed(1)}`,
  };
}

// ─── FORMAT + QTY ────────────────────────────────────────────────────────────
function formatPrice(symbol, price) {
  const sym = symbol.replace('/USDT:USDT', '');
  if (sym === 'ETH') return Math.round(price).toString();
  if (sym === 'SOL') return price.toFixed(2);
  if (sym === 'XRP') return price.toFixed(4);
  if (sym === 'DOGE') return price.toFixed(5);
  return price.toFixed(4);
}

function calcQty(symbol, price) {
  const min      = MIN_QTY[symbol] || 0.001;
  const decimals = (symbol === 'DOGE/USDT:USDT' || symbol === 'XRP/USDT:USDT') ? 0 : (String(min).split('.')[1] || '').length;
  const factor   = Math.pow(10, decimals);
  let qty = Math.floor((TRADE_SIZE / price) * factor) / factor;
  if (qty < min) qty = min;
  return qty;
}

// ─── CLOSE + CSV + TELEGRAM ───────────────────────────────────────────────────
async function closeAndRecord(symbol, pos, curPrice, reason, csv) {
  const symShort = symbol.split('/')[0] + 'USDT';
  const pnlPct   = pos.side === 'long' ? (curPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - curPrice) / pos.entryPrice;
  const pnlUsd   = (pnlPct * TRADE_SIZE).toFixed(2);
  const closed   = PAPER_TRADING ? true : await closePosition(symbol, pos.side, pos.qty);
  if (closed) {
    const roNow = getRoTime();
    const row   = `${formatDate(roNow)},${symShort},${pos.side === 'long' ? 'BUY' : 'SELL'},${formatPrice(symbol, pos.entryPrice)},${formatPrice(symbol, pos.tp)},${formatPrice(symbol, pos.sl)},${TRADE_SIZE}$,${pos.regime},${pos.score},${pos.atrPct ? pos.atrPct.toFixed(2) : ''},${reason},${formatDate(roNow)},${pnlUsd}$,${(pnlPct*100).toFixed(2)}%`;
    await appendCSV(row, csv);
    const emoji = reason === 'TP_HIT' ? '✅' : reason === 'TRAIL_STOP' ? '🔒' : reason === 'EXIT_NEGATIVE' ? '🚫' : reason === 'EXIT_ABSOLUTE' ? '🛑' : reason === 'TIMEOUT' ? '⏱' : reason === 'BOT2_OVERRIDE' ? '🔄' : '❌';
    await sendTelegram(`${emoji} ${reason} ${symShort} | ${pnlUsd}$ (${(pnlPct*100).toFixed(2)}%) | score=${pos.score}`);
  }
  return closed;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const roNow = getRoTime();
  console.log(`\n[${BOT_NAME}] === v2 START ${new Date().toISOString()} | RO: ${formatDate(roNow)} ===`);
  console.log(`[${BOT_NAME}] PAPER=${PAPER_TRADING} | SIZE=${TRADE_SIZE} | TF=${TIMEFRAME} | MIN_SCORE=${MIN_SCORE}`);

  const csv                               = await loadCSV();
  const { data: positions, sha: posSha } = await loadPositions(POSITIONS_FILE);
  const { data: bot1Pos }                 = await loadPositions(BOT1_POS_FILE);
  const { data: bot2Pos }                 = await loadPositions(BOT2_POS_FILE);
  if (!positions._cooldown) positions._cooldown = {};
  let positionsChanged = false;

  for (const symbol of SYMBOLS) {
    try {
      const symShort = symbol.split('/')[0] + 'USDT';
      console.log(`\n[${BOT_NAME}] --- ${symShort} ---`);

      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, CANDLES_LIMIT);
      if (candles.length < 80) { console.log(`[${BOT_NAME}] Date insuficiente`); continue; }

      // Folosim lumânări închise (fără ultima)
      const closedCandles = candles.slice(0, -1);
      const ind           = calcIndicators(closedCandles);
      if (!ind) { console.log(`[${BOT_NAME}] Indicatori indisponibili`); continue; }

      const curPrice = ind.last.close;

      // ── Monitorizare pozitie existenta ────────────────────────────────────
      if (positions[symbol]) {
        const pos    = positions[symbol];
        const openMs = Date.now() - pos.openTime;
        const prevPnl = pos.lastPnl || 0;

        // Verifica inchidere nativa BitGet — fara CSV fictiv
        if (!PAPER_TRADING) {
          try {
            const openPos   = await exchange.fetchPositions([symbol]);
            const stillOpen = openPos.some(p => p.symbol === symbol && Math.abs(p.contracts) > 0);
            if (!stillOpen) {
              console.log(`[${BOT_NAME}] Pozitie inchisa nativ pe BitGet: ${symShort} — sterg din JSON`);
              await sendTelegram(`⚠️ Pozitie ${symShort} inchisa nativ pe BitGet`);
              delete positions[symbol]; positions._cooldown[symbol] = { until: Date.now() + COOLDOWN_TP_MS, reason: 'native' };
              positionsChanged = true; continue;
            }
          } catch (e) { console.warn(`[${BOT_NAME}] fetchPositions warn: ${e.message}`); }
        }

        // Bot3 e independent — nu se inchide de Bot2

        // Trailing stop bazat pe R-multiple
        const risk   = Math.abs(pos.entryPrice - pos.initialSl || pos.sl);
        const profit = pos.side === 'long' ? curPrice - pos.entryPrice : pos.entryPrice - curPrice;
        const rMult  = risk > 0 ? profit / risk : 0;
        let slChanged = false;

        if (rMult >= 0.8) {
          const newSl = pos.side === 'long' ? Math.max(pos.sl, pos.entryPrice) : Math.min(pos.sl, pos.entryPrice);
          if (newSl !== pos.sl) { pos.sl = newSl; slChanged = true; console.log(`[${BOT_NAME}] Trail SL la breakeven ${symShort} (${rMult.toFixed(2)}R)`); }
        }
        if (rMult >= 1.2) {
          const trailDist = ind.atr14 * 0.7;
          const newSl     = pos.side === 'long' ? Math.max(pos.sl, curPrice - trailDist) : Math.min(pos.sl, curPrice + trailDist);
          if (newSl !== pos.sl) { pos.sl = newSl; slChanged = true; console.log(`[${BOT_NAME}] Trail SL activ ${symShort} -> ${newSl.toFixed(4)} (${rMult.toFixed(2)}R)`); }
        }
        if (slChanged) { positionsChanged = true; await sendTelegram(`🔒 TRAIL ${symShort} SL->${formatPrice(symbol, pos.sl)} (${rMult.toFixed(2)}R)`); }

        // TP/SL fallback
        const pnlPct = pos.side === 'long' ? (curPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - curPrice) / pos.entryPrice;
        const deltaPnl = pnlPct - prevPnl;
        console.log(`[${BOT_NAME}] ${symShort} ${pos.side} entry=${pos.entryPrice} cur=${curPrice} pnl=${(pnlPct*100).toFixed(2)}% Δ=${deltaPnl>=0?'+':''}${(deltaPnl*100).toFixed(2)}% negR=${pos.negativeRuns||0} ${Math.round(openMs/60000)}min`);

        if ((pos.side === 'long' && curPrice >= pos.tp) || (pos.side === 'short' && curPrice <= pos.tp)) {
          const closed = await closeAndRecord(symbol, pos, curPrice, 'TP_HIT', csv);
          if (closed) { delete positions[symbol]; positions._cooldown[symbol] = { until: Date.now() + COOLDOWN_TP_MS, reason: 'TP' }; positionsChanged = true; } continue;
        }
        if ((pos.side === 'long' && curPrice <= pos.sl) || (pos.side === 'short' && curPrice >= pos.sl)) {
          const closed = await closeAndRecord(symbol, pos, curPrice, 'SL_HIT', csv);
          if (closed) { delete positions[symbol]; positions._cooldown[symbol] = { until: Date.now() + COOLDOWN_SL_MS, reason: 'SL' }; positionsChanged = true; } continue;
        }

        // EXIT_ABSOLUTE
        if (pnlPct <= EXIT_ABS_PCT && openMs >= EXIT_ABS_MS) {
          console.log(`[${BOT_NAME}] EXIT_ABSOLUTE ${symShort} pnl=${(pnlPct*100).toFixed(2)}%`);
          const closed = await closeAndRecord(symbol, pos, curPrice, 'EXIT_ABSOLUTE', csv);
          if (closed) { delete positions[symbol]; positions._cooldown[symbol] = { until: Date.now() + COOLDOWN_SL_MS, reason: 'abs' }; positionsChanged = true; } continue;
        }

        // EXIT_NEGATIVE — 2 scaderi consecutive indiferent de valoare
        if (pnlPct < prevPnl) {
          pos.negativeRuns = (pos.negativeRuns || 0) + 1;
          positionsChanged = true;
          console.log(`[${BOT_NAME}] negRuns=${pos.negativeRuns}/${NEG_RUNS_LIMIT}`);
          if (pos.negativeRuns >= NEG_RUNS_LIMIT) {
            const closed = await closeAndRecord(symbol, pos, curPrice, 'EXIT_NEGATIVE', csv);
            if (closed) { delete positions[symbol]; positions._cooldown[symbol] = { until: Date.now() + COOLDOWN_SL_MS, reason: 'neg' }; positionsChanged = true; } continue;
          }
        } else if (pnlPct >= prevPnl + NEG_RESET_PCT) {
          if ((pos.negativeRuns || 0) > 0) { pos.negativeRuns = 0; positionsChanged = true; }
        }

        pos.lastPnlStatus = pos.lastPnl || 0;
        pos.lastPnl = pnlPct;
        positionsChanged = true;
        continue;
      }

      // ── Cooldown ──────────────────────────────────────────────────────────
      if (positions._cooldown[symbol]) {
        const cd = positions._cooldown[symbol];
        const until = typeof cd === 'object' ? cd.until : cd;
        if (Date.now() < until) {
          console.log(`[${BOT_NAME}] Cooldown ${symShort} — ${Math.round((until - Date.now()) / 60000)} min`);
          continue;
        }
        console.log(`[${BOT_NAME}] Cooldown EXPIRAT ${symShort}`);
        await sendTelegram(`🔓 Cooldown expirat ${symShort} — Bot3 activ`);
        delete positions._cooldown[symbol];
        positionsChanged = true;
      }

      // ── Semnal ────────────────────────────────────────────────────────────
      const signal = buildSignal(symbol, ind);
      console.log(`[${BOT_NAME}] ${symShort} | ${signal.action} | ${signal.reason}`);
      if (signal.action !== 'open') continue;

      // Cross-bot conflict — verifica Bot1 si Bot2
      const b1 = bot1Pos[symbol], b2 = bot2Pos[symbol];
      if (b1 && b1.side === signal.side) { console.log(`[${BOT_NAME}] BLOCAT — Bot1 are deja ${signal.side} pe ${symShort}`); continue; }
      if (b2 && b2.side === signal.side) { console.log(`[${BOT_NAME}] BLOCAT — Bot2 are deja ${signal.side} pe ${symShort}`); continue; }

      // Deschide pozitie
      const qty = calcQty(symbol, signal.entryRef);
      console.log(`[${BOT_NAME}] OPEN ${signal.side.toUpperCase()} ${symShort} @ ${signal.entryRef} | qty=${qty} | TP=${formatPrice(symbol, signal.tp)} | SL=${formatPrice(symbol, signal.sl)} | score=${signal.score}`);

      if (!PAPER_TRADING) {
        const openSide = signal.side === 'long' ? 'buy' : 'sell';
        const productId = symbol.replace('/USDT:USDT', 'USDT');
        const openPath = '/api/v2/mix/order/place-order';
        const openTs = Date.now().toString();
        const openBody = JSON.stringify({ symbol: productId, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT', side: openSide, tradeSide: 'open', orderType: 'market', size: String(qty) });
        const openResult = await new Promise((resolve, reject) => {
          const req = https.request({ hostname: 'api.bitget.com', path: openPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'ACCESS-KEY': process.env.BITGET_API_KEY, 'ACCESS-SIGN': bitgetSign(openTs, 'POST', openPath, openBody), 'ACCESS-TIMESTAMP': openTs, 'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE, 'Content-Length': Buffer.byteLength(openBody) } },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
          req.on('error', reject); req.write(openBody); req.end();
        });
        if (openResult.code !== '00000') throw new Error('BitGet open error: ' + JSON.stringify(openResult));
        console.log('[Bot3] Pozitie deschisa OK: ' + symbol);
      }

      positions[symbol] = {
        side: signal.side, entryPrice: signal.entryRef, qty,
        tp: signal.tp, sl: signal.sl, initialSl: signal.sl,
        openTime: Date.now(), regime: signal.regime, score: signal.score,
        atrPct: signal.atrPct, atr: signal.atr,
        negativeRuns: 0, lastPnl: 0, lastPnlStatus: 0,
      };
      positionsChanged = true;

      const roNow2 = getRoTime();
      const row = `${formatDate(roNow2)},${symbol.split('/')[0]}USDT,${signal.side === 'long' ? 'BUY' : 'SELL'},${formatPrice(symbol, signal.entryRef)},${formatPrice(symbol, signal.tp)},${formatPrice(symbol, signal.sl)},${TRADE_SIZE}$,${signal.regime},${signal.score},${signal.atrPct.toFixed(2)},OPEN,,0.00$,0.00%`;
      await appendCSV(row, csv);
      await sendTelegram(`${signal.side === 'long' ? '🟢' : '🔴'} OPEN ${signal.side.toUpperCase()} ${symbol.split('/')[0]}USDT @ ${formatPrice(symbol, signal.entryRef)}\nTP=${formatPrice(symbol, signal.tp)} SL=${formatPrice(symbol, signal.sl)}\nScore=${signal.score} | ${signal.regime} | ${PAPER_TRADING ? 'PAPER' : 'REAL'}`);

    } catch (e) { console.error(`[${BOT_NAME}] Eroare ${symbol}:`, e.message); }
  }

  if (positionsChanged) await savePositions(POSITIONS_FILE, positions, posSha);

  // ── Status Telegram la :35 ────────────────────────────────────────────────
  const nowMin = new Date().getMinutes();
  if (nowMin >= 35 && nowMin < 45) {
    const { data: freshPos } = await loadPositions(POSITIONS_FILE);
    const openPos = Object.entries(freshPos).filter(([k]) => k !== '_cooldown');
    if (openPos.length > 0) {
      const ro = getRoTime();
      let msg = `📊 Status Bot3 (${formatDate(ro)} RO):\n`;
      for (const [sym, pos] of openPos) {
        if (!pos || !pos.entryPrice) continue;
        try {
          const symShort = sym.split('/')[0] + 'USDT';
          const c   = await exchange.fetchOHLCV(sym, TIMEFRAME, undefined, 2);
          const cur = c[c.length - 1][4];
          const pnl = pos.side === 'long'
            ? (cur - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - cur) / pos.entryPrice * 100;
          const maxPnl  = pos.side === 'long'
            ? (Math.max(pos.entryPrice, cur) - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - Math.min(pos.entryPrice, cur)) / pos.entryPrice * 100;
          const prevPnl = (pos.lastPnlStatus || 0) * 100;
          const delta   = pnl - prevPnl;
          const fromMax = Math.min(0, pnl - maxPnl);
          const openMin = Math.round((Date.now() - pos.openTime) / 60000);
          msg += `${pos.side === 'long' ? '🟢' : '🔴'} ${symShort} ${pos.side} @ ${pos.entryPrice} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% | Δ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% | de la max: ${fromMax.toFixed(2)}% | score=${pos.score} | ${openMin}min\n`;
        } catch (e) {}
      }
      await sendTelegram(msg.trim());
    }
  }

  console.log(`\n[${BOT_NAME}] === DONE ${new Date().toISOString()} | RO: ${formatDate(getRoTime())} ===\n`);
}

main().catch(e => { console.error(`[${BOT_NAME}] FATAL:`, e.message); process.exit(1); });
