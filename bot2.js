// bot2.js — PC7 | EMA20 + EMA50 + BB + RSI14 + Volume | BitGet USDT-M Futures
// Fix principal PC7: TP/SL nativ prin endpoint /api/v2/mix/order/place-tpsl-order
// volumeMultiplier per simbol: BTC/ETH=1.0x, SOL/DOGE=1.2x
// Toate fix-urile PC6 incluse

const ccxt = require('ccxt');
const https = require('https');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SYMBOLS        = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT'];
const TIMEFRAME      = '1h';
const TRADE_SIZE     = parseFloat(process.env.TRADE_SIZE || '10');
const PAPER_TRADING  = process.env.PAPER_TRADING === 'true';
const TP_PCT         = 0.03;
const SL_PCT         = 0.015;
const MIN_QTY        = { 'BTC/USDT:USDT': 0.001, 'ETH/USDT:USDT': 0.01, 'SOL/USDT:USDT': 0.1, 'DOGE/USDT:USDT': 1 };
const VOL_MULTIPLIER = { 'BTC/USDT:USDT': 1.0, 'ETH/USDT:USDT': 1.0, 'SOL/USDT:USDT': 1.2, 'DOGE/USDT:USDT': 1.2 };
const CSV_FILE       = 'data/trades2.csv';
const POSITIONS_FILE = 'data/positions_bot2.json';
const OTHER_POSITIONS_FILE = 'data/positions_bot1.json';
const GITHUB_REPO    = 'luchianromeo-art/claude-tradingview-mcp-trading';
const BOT_NAME       = 'Bot2';

// ─── EXCHANGE ────────────────────────────────────────────────────────────────
const exchange = new ccxt.bitget({
  apiKey:   process.env.BITGET_API_KEY,
  secret:   process.env.BITGET_SECRET,
  password: process.env.BITGET_PASSPHRASE,
  options:  { defaultType: 'swap' },
});

// ─── GITHUB API ──────────────────────────────────────────────────────────────
async function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'trading-bot',
        'Accept': 'application/vnd.github.v3+json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function githubPut(path, content, sha) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      message: `${BOT_NAME} update ${path}`,
      content: Buffer.from(content).toString('base64'),
      sha: sha || undefined,
    });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: 'PUT',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'User-Agent': 'trading-bot',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function loadPositions(filename) {
  try {
    const res = await githubGet(filename);
    if (res.content) {
      const text = Buffer.from(res.content, 'base64').toString('utf8');
      return { data: JSON.parse(text), sha: res.sha };
    }
  } catch (e) {}
  return { data: {}, sha: null };
}

async function savePositions(filename, positions, sha) {
  try {
    let freshSha = sha;
    try {
      const current = await githubGet(filename);
      if (current && current.sha) freshSha = current.sha;
    } catch (e) {}
    await githubPut(filename, JSON.stringify(positions, null, 2), freshSha);
  } catch (e) {
    console.error(`[${BOT_NAME}] savePositions error:`, e.message);
  }
}

async function loadCSV() {
  try {
    const res = await githubGet(CSV_FILE);
    if (res.content) {
      return { text: Buffer.from(res.content, 'base64').toString('utf8'), sha: res.sha };
    }
  } catch (e) {}
  return { text: 'Data intrare,Symbol,Semnal,Pret intrare,TP,SL,Size,EMA20,EMA50,RSI14,BB_Upper,BB_Lower,BB_Width,Vol_Ratio,Rezultat,Data iesire,PnL $,PnL %\n', sha: null };
}

async function appendCSV(row, existingCSV) {
  const lines = existingCSV.text.trim().split('\n');
  const header = lines[0];
  const rest   = lines.slice(1).join('\n');
  const newContent = header + '\n' + row + (rest ? '\n' + rest : '') + '\n';
  await githubPut(CSV_FILE, newContent, existingCSV.sha);
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text: msg });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error(`[${BOT_NAME}] Telegram error:`, e.message);
  }
}

function tgOpen(signal, symbol, price, tp, sl) {
  const emoji = signal === 'BUY' ? '🟢' : '🔴';
  const symShort = symbol.replace('/USDT:USDT', 'USDT');
  return `🔴 [BOT2] ${emoji} ${signal}\n📊 ${symShort}\n💰 Entry: ${price}\n🎯 TP: ${tp} (+${(TP_PCT*100).toFixed(0)}%)\n🛑 SL: ${sl} (-${(SL_PCT*100).toFixed(0)}%)\n💵 Size: ${TRADE_SIZE} USDT\n💰 REAL`;
}

function tgClose(result, symbol, pnlPct, pnlUsd) {
  const emoji = result === 'TP_HIT' ? '✅' : '❌';
  const symShort = symbol.replace('/USDT:USDT', 'USDT');
  return `🔴 [BOT2] ${emoji} ${result}\n📊 ${symShort}\n💵 PnL: ${pnlUsd}$ (${pnlPct}%)`;
}

function tgTPSLPartial(symbol, tpOk, slOk) {
  const symShort = symbol.replace('/USDT:USDT', 'USDT');
  return `⚠️ BOT2 TP/SL partial\n📊 ${symShort}\nTP:${tpOk?'✅':'❌'} SL:${slOk?'✅':'❌'}\nVerifica manual!`;
}

// ─── BITGET DIRECT API (pentru TP/SL nativ PC7) ──────────────────────────────
function bitgetSign(timestamp, method, requestPath, body = '') {
  const prehash = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', process.env.BITGET_SECRET).update(prehash).digest('base64');
}

async function placeBitgetTPSL({ symbol, side, entryPrice }) {
  const tpPrice = side === 'buy'
    ? (entryPrice * (1 + TP_PCT)).toFixed(2)
    : (entryPrice * (1 - TP_PCT)).toFixed(2);
  const slPrice = side === 'buy'
    ? (entryPrice * (1 - SL_PCT)).toFixed(2)
    : (entryPrice * (1 + SL_PCT)).toFixed(2);

  const productId = symbol.replace('/USDT:USDT', 'USDT');
  const holdSide  = side === 'buy' ? 'long' : 'short';
  const timestamp = Date.now().toString();
  const path      = '/api/v2/mix/order/place-tpsl-order';

  let tpOk = false, slOk = false;

  for (const [planType, triggerPrice] of [['profit_plan', tpPrice], ['loss_plan', slPrice]]) {
    const bodyObj = {
      symbol:       productId,
      productType:  'USDT-FUTURES',
      marginMode:   'crossed',
      marginCoin:   'USDT',
      planType,
      triggerPrice,
      holdSide,
      size:         String(qty),
    };
    const bodyStr = JSON.stringify(bodyObj);
    const sign    = bitgetSign(timestamp, 'POST', path, bodyStr);

    await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.bitget.com',
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ACCESS-KEY': process.env.BITGET_API_KEY,
          'ACCESS-SIGN': sign,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
          'locale': 'en-US',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.code === '00000') {
              console.log(`[${BOT_NAME}] TP/SL nativ setat: ${planType} @ ${triggerPrice}`);
              if (planType === 'profit_plan') tpOk = true;
              if (planType === 'loss_plan') slOk = true;
            } else {
              console.warn(`[${BOT_NAME}] TP/SL ${planType} warning: ${parsed.msg}`);
            }
          } catch (e) {}
          resolve();
        });
      });
      req.on('error', (e) => { console.warn(`[${BOT_NAME}] TP/SL request error: ${e.message}`); resolve(); });
      req.write(bodyStr);
      req.end();
    });
  }

  if (!tpOk || !slOk) {
    await sendTelegram(tgTPSLPartial(symbol, tpOk, slOk));
  }

  return { tpPrice, slPrice };
}

// ─── INDICATORI ──────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  return 100 - (100 / (1 + gains / losses));
}

function calcBB(closes, period = 20, stdMult = 2) {
  const slice = closes.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / period;
  const std   = Math.sqrt(variance);
  return { upper: mean + stdMult * std, middle: mean, lower: mean - stdMult * std };
}

function calcAvgVolume(candles, period = 20) {
  const vols = candles.slice(-period).map(c => c[5]);
  return vols.reduce((a, b) => a + b, 0) / period;
}

// ─── FORMAT DATA ─────────────────────────────────────────────────────────────
function formatDate(d) {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

function formatPrice(symbol, price) {
  if (symbol.startsWith('BTC') || symbol.startsWith('ETH')) {
    return Math.round(price).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  if (symbol.startsWith('SOL')) return price.toFixed(2);
  return price.toFixed(5);
}

// ─── CLOSE POSITION ──────────────────────────────────────────────────────────
async function closePosition(symbol, side, qty) {
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  try {
    await exchange.createMarketOrder(symbol, closeSide, qty, undefined, {
      reduceOnly: true,
      tradeSide: 'close',
    });
    console.log(`[${BOT_NAME}] Poziție închisă: ${symbol} qty=${qty}`);
    return true;
  } catch (e) {
    if (e.message && e.message.includes('22002')) {
      console.log(`[${BOT_NAME}] 22002 — poziție deja închisă (TP/SL nativ): ${symbol}`);
      return true;
    }
    console.error(`[${BOT_NAME}] closePosition error ${symbol}:`, e.message);
    return false;
  }
}

// ─── LEVERAGE ────────────────────────────────────────────────────────────────
async function setLeverage(symbol) {
  try {
    await exchange.setLeverage(1, symbol, { marginCoin: 'USDT', holdSide: 'long' });
    await exchange.setLeverage(1, symbol, { marginCoin: 'USDT', holdSide: 'short' });
  } catch (e) {
    console.warn(`[${BOT_NAME}] setLeverage warn ${symbol}: ${e.message}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[${BOT_NAME}] === PC7 START ${new Date().toISOString()} ===`);
  console.log(`[${BOT_NAME}] PAPER_TRADING=${PAPER_TRADING} | TRADE_SIZE=${TRADE_SIZE}`);

  const csv                               = await loadCSV();
  const { data: positions, sha: posSha } = await loadPositions(POSITIONS_FILE);
  const { data: otherPositions }          = await loadPositions(OTHER_POSITIONS_FILE);
  let positionsChanged = false;

  for (const symbol of SYMBOLS) {
    try {
      console.log(`\n[${BOT_NAME}] --- ${symbol} ---`);
      const symShort = symbol.split('/')[0] + 'USDT';

      // ── 1. Verifică TP/SL pentru pozițiile deschise ──────────────────────
      if (positions[symbol]) {
        const pos      = positions[symbol];
        const ticker   = await exchange.fetchTicker(symbol);
        const curPrice = ticker.last;
        const pnlPct   = pos.side === 'buy'
          ? (curPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - curPrice) / pos.entryPrice;

        console.log(`[${BOT_NAME}] Poziție deschisă: ${symbol} ${pos.side.toUpperCase()} entry=${pos.entryPrice} cur=${curPrice} pnl=${(pnlPct * 100).toFixed(2)}%`);

        // ── PC7 FIX: verifică dacă BitGet a închis deja prin TP/SL nativ ──
        if (!PAPER_TRADING) {
          try {
            const openPos = await exchange.fetchPositions([symbol]);
            const stillOpen = openPos.some(p => p.symbol === symbol && Math.abs(p.contracts) > 0);
            if (!stillOpen) {
              const result = pnlPct >= 0 ? 'TP_HIT' : 'SL_HIT';
              const pnlUsd = (pnlPct * TRADE_SIZE).toFixed(2);
              const row = `${formatDate(new Date())},${symShort},${result},${formatPrice(symShort, curPrice)},${formatPrice(symShort, pos.tp)},${formatPrice(symShort, pos.sl)},${TRADE_SIZE}$,${pos.ema20||''},${pos.ema50||''},${pos.rsi14||''},${pos.bbUpper||''},${pos.bbLower||''},${pos.bbWidth||''},${pos.volRatio||''},${result},${formatDate(new Date())},${pnlUsd}$,${(pnlPct * 100).toFixed(2)}%`;
              await appendCSV(row, csv);
              csv.text = row + '\n' + csv.text;
              await sendTelegram(tgClose(result, symbol, (pnlPct * 100).toFixed(2), pnlUsd));
              delete positions[symbol];
              positionsChanged = true;
              console.log(`[${BOT_NAME}] ${result} detectat via BitGet nativ: ${symbol} PnL=${(pnlPct * 100).toFixed(2)}%`);
              continue;
            }
          } catch (e) {
            console.warn(`[${BOT_NAME}] fetchPositions warn ${symbol}: ${e.message}`);
          }
        }

        let result = null;
        if (pnlPct >= TP_PCT) result = 'TP_HIT';
        if (pnlPct <= -SL_PCT) result = 'SL_HIT';

        if (result) {
          const closed = PAPER_TRADING ? true : await closePosition(symbol, pos.side, pos.qty);
          if (closed) {
            const pnlUsd = (pnlPct * TRADE_SIZE).toFixed(2);
            const row = `${formatDate(new Date())},${symShort},${result},${formatPrice(symShort, curPrice)},${formatPrice(symShort, pos.tp)},${formatPrice(symShort, pos.sl)},${TRADE_SIZE}$,${pos.ema20||''},${pos.ema50||''},${pos.rsi14||''},${pos.bbUpper||''},${pos.bbLower||''},${pos.bbWidth||''},${pos.volRatio||''},${result},${formatDate(new Date())},${pnlUsd}$,${(pnlPct * 100).toFixed(2)}%`;
            await appendCSV(row, csv);
            csv.text = row + '\n' + csv.text;
            await sendTelegram(tgClose(result, symbol, (pnlPct * 100).toFixed(2), pnlUsd));
            delete positions[symbol];
            positionsChanged = true;
          }
        }
        continue;
      }

      // ── 2. Calculează indicatori ─────────────────────────────────────────
      const candles  = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, 60);
      if (candles.length < 50) { console.log(`[${BOT_NAME}] Date insuficiente ${symbol}`); continue; }

      const closes   = candles.map(c => c[4]);
      const ema20    = calcEMA(closes, 20);
      const ema50    = calcEMA(closes, 50);
      const rsi14    = calcRSI(closes, 14);
      const bb       = calcBB(closes, 20);
      const curVol   = candles[candles.length - 1][5];
      const avgVol   = calcAvgVolume(candles, 20);
      const volRatio = avgVol > 0 ? curVol / avgVol : 0;
      const price    = closes[closes.length - 1];
      const volThreshold = VOL_MULTIPLIER[symbol];

      console.log(`[${BOT_NAME}] ${symbol} | Price=${price.toFixed(4)} EMA20=${ema20.toFixed(4)} EMA50=${ema50.toFixed(4)} RSI14=${rsi14.toFixed(1)} BB_L=${bb.lower.toFixed(4)} BB_U=${bb.upper.toFixed(4)} Vol=${volRatio.toFixed(2)}x (prag ${volThreshold}x)`);

      let signal = null;
      const volOk = volRatio >= volThreshold;

      if (ema20 > ema50 && price <= bb.lower * 1.01 && rsi14 >= 30 && rsi14 <= 55 && volOk) signal = 'BUY';
      if (ema20 < ema50 && price >= bb.upper * 0.99 && rsi14 >= 55 && rsi14 <= 80 && volOk) signal = 'SELL';

      if (!signal) { console.log(`[${BOT_NAME}] HOLD — no trade (volOk=${volOk} ratio=${volRatio.toFixed(2)}x)`); continue; }

      // ── 3. Verifică conflict cross-bot ───────────────────────────────────
      if (otherPositions[symbol]) {
        const otherSide = otherPositions[symbol].side;
        const thisSide  = signal === 'BUY' ? 'buy' : 'sell';
        if (otherSide === thisSide) {
          console.log(`[${BOT_NAME}] BLOCAT — Bot1 are deja ${otherSide} pe ${symbol}`);
          continue;
        }
      }

      // ── 4. Calculează qty și TP/SL ───────────────────────────────────────
      const side  = signal === 'BUY' ? 'buy' : 'sell';
      let qty     = Math.max(TRADE_SIZE / price, MIN_QTY[symbol]);
      qty         = parseFloat(qty.toFixed(symbol.startsWith('BTC') ? 3 : symbol.startsWith('ETH') ? 2 : symbol.startsWith('SOL') ? 1 : 0));

      const tpPrice = side === 'buy' ? price * (1 + TP_PCT) : price * (1 - TP_PCT);
      const slPrice = side === 'buy' ? price * (1 - SL_PCT) : price * (1 + SL_PCT);

      console.log(`[${BOT_NAME}] SEMNAL: ${signal} | ${symbol} | qty=${qty} | TP=${tpPrice.toFixed(4)} | SL=${slPrice.toFixed(4)}`);

      if (!PAPER_TRADING) {
        await setLeverage(symbol);
        await exchange.createMarketOrder(symbol, side, qty, undefined, {
          tradeSide: 'open',
          marginCoin: 'USDT',
        });

        // PC7 FIX: TP/SL nativ
        const { tpPrice: tpNative, slPrice: slNative } = await placeBitgetTPSL({ symbol, side, entryPrice: price, qty });
        console.log(`[${BOT_NAME}] TP/SL nativ: TP=${tpNative} SL=${slNative}`);
      }

      // ── 5. Salvează poziția ───────────────────────────────────────────────
      const bbWidth = ((bb.upper - bb.lower) / bb.middle * 100).toFixed(2);
      positions[symbol] = { side, entryPrice: price, qty, tp: tpPrice, sl: slPrice, openTime: Date.now(),
        ema20: ema20.toFixed(4), ema50: ema50.toFixed(4), rsi14: rsi14.toFixed(2),
        bbUpper: bb.upper.toFixed(4), bbLower: bb.lower.toFixed(4), bbWidth, volRatio: volRatio.toFixed(2) };
      positionsChanged = true;

      // ── 6. Salvează în CSV ────────────────────────────────────────────────
      const row = `${formatDate(new Date())},${symShort},${signal},${formatPrice(symShort, price)},${formatPrice(symShort, tpPrice)},${formatPrice(symShort, slPrice)},${TRADE_SIZE}$,${ema20.toFixed(4)},${ema50.toFixed(4)},${rsi14.toFixed(2)},${bb.upper.toFixed(4)},${bb.lower.toFixed(4)},${bbWidth},${volRatio.toFixed(2)},OPEN,,0.00$,0.00`;
      await appendCSV(row, csv);
      await sendTelegram(tgOpen(signal, symbol, formatPrice(symShort, price), formatPrice(symShort, tpPrice), formatPrice(symShort, slPrice)));

    } catch (e) {
      console.error(`[${BOT_NAME}] Eroare ${symbol}:`, e.message);
    }
  }

  if (positionsChanged) {
    await savePositions(POSITIONS_FILE, positions, posSha);
  }

  console.log(`\n[${BOT_NAME}] === DONE ${new Date().toISOString()} ===\n`);
}

main().catch(e => { console.error(`[${BOT_NAME}] FATAL:`, e.message); process.exit(1); });
