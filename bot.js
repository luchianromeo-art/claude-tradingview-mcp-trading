// bot.js — PC11 | VWAP + EMA8 + RSI3 | BitGet USDT-M Futures | Railway
// PC11: TP 0.8% / SL 0.5% | EXIT_NEGATIVE 2 runuri | TIMEOUT 3h stagnare | positionsChanged la trailing

const ccxt   = require('ccxt');
const https  = require('https');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SYMBOLS        = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT'];
const TIMEFRAME      = '1h';
const TRADE_SIZE     = parseFloat(process.env.TRADE_SIZE || '10');
const PAPER_TRADING  = process.env.PAPER_TRADING === 'true';
const TP_PCT         = 0.008;
const SL_PCT         = 0.005;
const TRAIL_ACTIVATE = 0.005;
const TRAIL_STEP     = 0.004;
const COOLDOWN_MS    = 35 * 60 * 1000;
const MAX_OPEN_MS    = 3 * 60 * 60 * 1000;
const NEG_RUNS_LIMIT = 2;
const STAG_RUNS_LIMIT= 2;
const STAG_MIN_PCT   = 0.001;
const MIN_QTY        = { 'BTC/USDT:USDT': 0.001, 'ETH/USDT:USDT': 0.01, 'SOL/USDT:USDT': 0.1, 'DOGE/USDT:USDT': 1 };
const CSV_FILE       = 'data/trades.csv';
const POSITIONS_FILE = 'data/positions_bot1.json';
const OTHER_POS_FILE = 'data/positions_bot2.json';
const GITHUB_REPO    = 'luchianromeo-art/claude-tradingview-mcp-trading';
const BOT_NAME       = 'Bot1';

const exchange = new ccxt.bitget({
  apiKey:   process.env.BITGET_API_KEY,
  secret:   process.env.BITGET_SECRET,
  password: process.env.BITGET_PASSPHRASE,
  options:  { defaultType: 'swap' },
});

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
  try { const res = await githubGet(filename); if (res.content) return { data: JSON.parse(Buffer.from(res.content, 'base64').toString('utf8')), sha: res.sha }; } catch (e) {}
  return { data: {}, sha: null };
}

async function savePositions(filename, positions, sha) {
  try {
    let freshSha = sha;
    try { const c = await githubGet(filename); if (c && c.sha) freshSha = c.sha; } catch (e) {}
    await githubPut(filename, JSON.stringify(positions, null, 2), freshSha);
  } catch (e) { console.error(`[${BOT_NAME}] savePositions error:`, e.message); }
}

async function loadCSV() {
  try { const res = await githubGet(CSV_FILE); if (res.content) return { text: Buffer.from(res.content, 'base64').toString('utf8'), sha: res.sha }; } catch (e) {}
  return { text: 'Data intrare,Symbol,Semnal,Pret intrare,TP,SL,Size,Rezultat,Data iesire,PnL $,PnL %\n', sha: null };
}

async function appendCSV(row, existingCSV) {
  const lines = existingCSV.text.trim().split('\n');
  const newContent = lines[0] + '\n' + row + (lines.slice(1).join('\n') ? '\n' + lines.slice(1).join('\n') : '') + '\n';
  let freshSha = existingCSV.sha;
  try { const c = await githubGet(CSV_FILE); if (c && c.sha) freshSha = c.sha; } catch (e) {}
  await githubPut(CSV_FILE, newContent, freshSha);
}

async function sendTelegram(msg) {
  const token = process.env.TELEGRAM_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text: `🔵 [BOT1] ${msg}` });
    await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', reject); req.write(body); req.end();
    });
  } catch (e) { console.error(`[${BOT_NAME}] Telegram error:`, e.message); }
}

function bitgetSign(ts, method, path, body = '') {
  return crypto.createHmac('sha256', process.env.BITGET_SECRET).update(ts + method.toUpperCase() + path + body).digest('base64');
}

async function placeBitgetTPSL({ symbol, side, entryPrice, qty }) {
  const tpPrice = side === 'buy' ? (entryPrice * (1 + TP_PCT)).toFixed(2) : (entryPrice * (1 - TP_PCT)).toFixed(2);
  const slPrice = side === 'buy' ? (entryPrice * (1 - SL_PCT)).toFixed(2) : (entryPrice * (1 + SL_PCT)).toFixed(2);
  const productId = symbol.replace('/USDT:USDT', 'USDT');
  const holdSide  = side === 'buy' ? 'long' : 'short';
  const path      = '/api/v2/mix/order/place-tpsl-order';
  for (const [planType, triggerPrice] of [['profit_plan', tpPrice], ['loss_plan', slPrice]]) {
    try {
      const ts = Date.now().toString();
      const bodyStr = JSON.stringify({ symbol: productId, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT', planType, triggerPrice, executePrice: triggerPrice, holdSide, size: String(qty) });
      await new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'api.bitget.com', path, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'ACCESS-KEY': process.env.BITGET_API_KEY, 'ACCESS-SIGN': bitgetSign(ts, 'POST', path, bodyStr), 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE, 'Content-Length': Buffer.byteLength(bodyStr) } },
          (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
        req.on('error', reject); req.write(bodyStr); req.end();
      });
      console.log(`[${BOT_NAME}] TP/SL nativ ok: ${planType} ${triggerPrice}`);
    } catch (e) { console.log(`[${BOT_NAME}] TP/SL nativ skip: ${e.message}`); }
  }
  return { tpPrice, slPrice };
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1); let v = closes[0];
  for (let i = 1; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function calcRSI3(closes) {
  const period = 3;
  if (closes.length < period + 1) return 50;
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

function calcVWAP(candles) {
  let sumPV = 0, sumV = 0;
  for (const c of candles) { const tp = (c[2] + c[3] + c[4]) / 3; sumPV += tp * c[5]; sumV += c[5]; }
  return sumV === 0 ? 0 : sumPV / sumV;
}

function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatPrice(symbol, price) {
  const sym = symbol.replace('/USDT:USDT', '');
  if (sym === 'BTC' || sym === 'ETH') return Math.round(price).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (sym === 'SOL') return price.toFixed(2);
  return price.toFixed(5);
}

function calcQty(symbol, price) {
  const min = MIN_QTY[symbol] || 0.001;
  const decimals = symbol === 'DOGE/USDT:USDT' ? 0 : (String(min).split('.')[1] || '').length;
  const factor = Math.pow(10, decimals);
  let qty = Math.floor((TRADE_SIZE / price) * factor) / factor;
  if (qty < min) qty = min;
  return qty;
}

async function closePosition(symbol, side, qty) {
  try {
    await exchange.createMarketOrder(symbol, side === 'buy' ? 'sell' : 'buy', qty, undefined, { reduceOnly: true, tradeSide: 'close' });
    console.log(`[${BOT_NAME}] Pozitie inchisa: ${symbol}`);
    return true;
  } catch (e) {
    if (e.message && e.message.includes('22002')) {
      try {
        const openPos = await exchange.fetchPositions([symbol]);
        const stillOpen = openPos.some(p => p.symbol === symbol && Math.abs(p.contracts) > 0);
        if (stillOpen) {
          console.log(`[${BOT_NAME}] 22002 dar pozitia INCA EXISTA — retry fara reduceOnly`);
          try {
            await exchange.createMarketOrder(symbol, side === 'buy' ? 'sell' : 'buy', qty, undefined, { tradeSide: 'close' });
            console.log(`[${BOT_NAME}] Retry inchidere reusit: ${symbol}`);
            return true;
          } catch (e3) { console.error(`[${BOT_NAME}] Retry esuat: ${e3.message}`); return false; }
        }
      } catch (e2) { console.log(`[${BOT_NAME}] 22002 fetchPositions error: ${e2.message}`); }
      console.log(`[${BOT_NAME}] 22002 — confirmata inchisa`); return true;
    }
    console.error(`[${BOT_NAME}] closePosition error:`, e.message);
    return false;
  }
}

function checkTrailing(symbol, pos, curPrice) {
  let changed = false;
  if (pos.side === 'buy') {
    if (curPrice > pos.maxPrice) { pos.maxPrice = curPrice; changed = true; }
    if (!pos.trailingActive && (curPrice - pos.entryPrice) / pos.entryPrice >= TRAIL_ACTIVATE) {
      pos.trailingActive = true; changed = true;
      console.log(`[${BOT_NAME}] Trailing ACTIVAT ${symbol} maxPrice=${pos.maxPrice}`);
    }
    if (pos.trailingActive && curPrice <= pos.maxPrice * (1 - TRAIL_STEP)) return { hit: true, changed };
  } else {
    if (curPrice < pos.minPrice) { pos.minPrice = curPrice; changed = true; }
    if (!pos.trailingActive && (pos.entryPrice - curPrice) / pos.entryPrice >= TRAIL_ACTIVATE) {
      pos.trailingActive = true; changed = true;
      console.log(`[${BOT_NAME}] Trailing ACTIVAT ${symbol} minPrice=${pos.minPrice}`);
    }
    if (pos.trailingActive && curPrice >= pos.minPrice * (1 + TRAIL_STEP)) return { hit: true, changed };
  }
  return { hit: false, changed };
}

async function closeAndRecord(symbol, pos, curPrice, reason, csv) {
  const symShort = symbol.split('/')[0] + 'USDT';
  const pnlPct = pos.side === 'buy' ? (curPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - curPrice) / pos.entryPrice;
  const pnlUsd = (pnlPct * TRADE_SIZE).toFixed(2);
  const closed = PAPER_TRADING ? true : await closePosition(symbol, pos.side, pos.qty);
  if (closed) {
    const row = `${formatDate(new Date())},${symShort},${reason},${formatPrice(symbol, pos.entryPrice)},${formatPrice(symbol, pos.tp)},${formatPrice(symbol, pos.sl)},${TRADE_SIZE}$,${reason},${formatDate(new Date())},${pnlUsd}$,${(pnlPct*100).toFixed(2)}%`;
    await appendCSV(row, csv);
    const emoji = reason === 'TP_HIT' ? '✅' : reason === 'TRAIL_STOP' ? '🔒' : reason === 'EXIT_NEGATIVE' ? '🚫' : reason === 'TIMEOUT' ? '⏱' : '❌';
    await sendTelegram(`${emoji} ${reason} ${symShort} | ${pnlUsd}$ (${(pnlPct*100).toFixed(2)}%)`);
  }
  return closed;
}

async function main() {
  console.log(`\n[${BOT_NAME}] === PC11 START ${new Date().toISOString()} ===`);
  console.log(`[${BOT_NAME}] PAPER_TRADING=${PAPER_TRADING} | TRADE_SIZE=${TRADE_SIZE}`);

  const csv                               = await loadCSV();
  const { data: positions, sha: posSha } = await loadPositions(POSITIONS_FILE);
  const { data: otherPositions }          = await loadPositions(OTHER_POS_FILE);
  if (!positions._cooldown) positions._cooldown = {};
  let positionsChanged = false;

  for (const symbol of SYMBOLS) {
    try {
      const symShort = symbol.split('/')[0] + 'USDT';
      console.log(`\n[${BOT_NAME}] --- ${symShort} ---`);

      const candles  = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, 50);
      if (candles.length < 20) { console.log(`[${BOT_NAME}] Date insuficiente`); continue; }
      const closes   = candles.map(c => c[4]);
      const curPrice = closes[closes.length - 1];

      if (positions[symbol]) {
        const pos = positions[symbol];

        if (!PAPER_TRADING) {
          try {
            const openPos   = await exchange.fetchPositions([symbol]);
            const stillOpen = openPos.some(p => p.symbol === symbol && Math.abs(p.contracts) > 0);
            if (!stillOpen) {
              await closeAndRecord(symbol, pos, curPrice, curPrice >= pos.entryPrice ? 'TP_HIT' : 'SL_HIT', csv);
              delete positions[symbol]; positions._cooldown[symbol] = Date.now(); positionsChanged = true;
              continue;
            }
          } catch (e) { console.warn(`[${BOT_NAME}] fetchPositions warn: ${e.message}`); }
        }

        const { hit: trailHit, changed: trailChanged } = checkTrailing(symbol, pos, curPrice);
        if (trailChanged) positionsChanged = true;
        if (trailHit) {
          const closed = await closeAndRecord(symbol, pos, curPrice, 'TRAIL_STOP', csv);
          if (closed) { delete positions[symbol]; positions._cooldown[symbol] = Date.now(); positionsChanged = true; }
          continue;
        }

        const pnlPct = pos.side === 'buy' ? (curPrice - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - curPrice) / pos.entryPrice;
        console.log(`[${BOT_NAME}] Pozitie: ${symShort} ${pos.side.toUpperCase()} entry=${pos.entryPrice} cur=${curPrice} pnl=${(pnlPct*100).toFixed(2)}% trailing=${pos.trailingActive} negRuns=${pos.negativeRuns||0}`);

        if (pnlPct >= TP_PCT) {
          const closed = await closeAndRecord(symbol, pos, curPrice, 'TP_HIT', csv);
          if (closed) { delete positions[symbol]; positions._cooldown[symbol] = Date.now(); positionsChanged = true; }
          continue;
        }
        if (pnlPct <= -SL_PCT) {
          const closed = await closeAndRecord(symbol, pos, curPrice, 'SL_HIT', csv);
          if (closed) { delete positions[symbol]; positions._cooldown[symbol] = Date.now(); positionsChanged = true; }
          continue;
        }

        if (pnlPct < 0) {
          pos.negativeRuns = (pos.negativeRuns || 0) + 1;
          pos.stagnantRuns = 0;
          positionsChanged = true;
          console.log(`[${BOT_NAME}] negativeRuns=${pos.negativeRuns}/${NEG_RUNS_LIMIT}`);
          if (pos.negativeRuns >= NEG_RUNS_LIMIT) {
            const closed = await closeAndRecord(symbol, pos, curPrice, 'EXIT_NEGATIVE', csv);
            if (closed) { delete positions[symbol]; positions._cooldown[symbol] = Date.now(); positionsChanged = true; }
            continue;
          }
        } else {
          if ((pos.negativeRuns || 0) > 0) { pos.negativeRuns = 0; positionsChanged = true; }
        }

        const openMs = Date.now() - pos.openTime;
        if (openMs >= MAX_OPEN_MS) {
          const lastPnl = pos.lastPnl || 0;
          const progress = Math.abs(pnlPct - lastPnl);
          if (progress < STAG_MIN_PCT) {
            pos.stagnantRuns = (pos.stagnantRuns || 0) + 1;
            positionsChanged = true;
            console.log(`[${BOT_NAME}] stagnantRuns=${pos.stagnantRuns}/${STAG_RUNS_LIMIT}`);
            if (pos.stagnantRuns >= STAG_RUNS_LIMIT) {
              const closed = await closeAndRecord(symbol, pos, curPrice, 'TIMEOUT', csv);
              if (closed) { delete positions[symbol]; positions._cooldown[symbol] = Date.now(); positionsChanged = true; }
              continue;
            }
          } else {
            if ((pos.stagnantRuns || 0) > 0) { pos.stagnantRuns = 0; positionsChanged = true; }
          }
        }

        pos.lastPnl = pnlPct;
        positionsChanged = true;
        continue;
      }

      if (positions._cooldown[symbol]) {
        const elapsed = Date.now() - positions._cooldown[symbol];
        if (elapsed < COOLDOWN_MS) { console.log(`[${BOT_NAME}] Cooldown ${symShort} — ${Math.round((COOLDOWN_MS-elapsed)/60000)} min`); continue; }
        delete positions._cooldown[symbol];
      }

      const vwap  = calcVWAP(candles);
      const ema8  = calcEMA(closes, 8);
      const rsi3  = calcRSI3(closes);

      console.log(`[${BOT_NAME}] ${symShort} | Price=${curPrice.toFixed(4)} VWAP=${vwap.toFixed(4)} EMA8=${ema8.toFixed(4)} RSI3=${rsi3.toFixed(1)}`);

      let signal = null;
      if (curPrice > vwap && curPrice > ema8 && rsi3 < 40) signal = 'BUY';
      if (curPrice < vwap && curPrice < ema8 && rsi3 > 60) signal = 'SELL';
      if (!signal) { console.log(`[${BOT_NAME}] HOLD — no signal`); continue; }

      const thisSide = signal === 'BUY' ? 'buy' : 'sell';
      if (otherPositions[symbol] && otherPositions[symbol].side === thisSide) {
        console.log(`[${BOT_NAME}] BLOCAT — Bot2 are deja ${thisSide} pe ${symShort}`); continue;
      }

      const side    = signal === 'BUY' ? 'buy' : 'sell';
      const qty     = calcQty(symbol, curPrice);
      const tpPrice = side === 'buy' ? curPrice * (1 + TP_PCT) : curPrice * (1 - TP_PCT);
      const slPrice = side === 'buy' ? curPrice * (1 - SL_PCT) : curPrice * (1 + SL_PCT);

      console.log(`[${BOT_NAME}] SEMNAL: ${signal} | ${symShort} | qty=${qty} | TP=${tpPrice.toFixed(4)} | SL=${slPrice.toFixed(4)}`);

      if (!PAPER_TRADING) {
        await exchange.createMarketOrder(symbol, side, qty, undefined, { tradeSide: 'open', marginCoin: 'USDT' });
        await placeBitgetTPSL({ symbol, side, entryPrice: curPrice, qty });
      }

      positions[symbol] = {
        side, entryPrice: curPrice, qty, tp: tpPrice, sl: slPrice,
        openTime: Date.now(),
        maxPrice: curPrice, minPrice: curPrice, trailingActive: false,
        negativeRuns: 0, stagnantRuns: 0, lastPnl: 0,
      };
      positionsChanged = true;

      const row = `${formatDate(new Date())},${symShort},${signal},${formatPrice(symbol, curPrice)},${formatPrice(symbol, tpPrice)},${formatPrice(symbol, slPrice)},${TRADE_SIZE}$,OPEN,,0.00$,0.00%`;
      await appendCSV(row, csv);
      await sendTelegram(`${signal === 'BUY' ? '🟢' : '🔴'} ${signal} ${symShort} @ ${formatPrice(symbol, curPrice)} | TP=${formatPrice(symbol, tpPrice)} SL=${formatPrice(symbol, slPrice)} | ${PAPER_TRADING ? 'PAPER' : 'REAL'}`);

    } catch (e) { console.error(`[${BOT_NAME}] Eroare ${symbol}:`, e.message); }
  }

  if (positionsChanged) await savePositions(POSITIONS_FILE, positions, posSha);

  const nowMin = new Date().getMinutes();
  if (nowMin < 10) {
    const { data: freshPos } = await loadPositions(POSITIONS_FILE);
    const openPos = Object.entries(freshPos).filter(([k]) => k !== '_cooldown');
    if (openPos.length > 0) {
      let msg = `📊 Status Bot1 (ora ${new Date().getHours()}:00):\n`;
      for (const [sym, pos] of openPos) {
        if (!pos || !pos.entryPrice) continue;
        try {
          const symShort = sym.split('/')[0] + 'USDT';
          const c = await exchange.fetchOHLCV(sym, TIMEFRAME, undefined, 2);
          const cur = c[c.length - 1][4];
          const pnl = pos.side === 'buy' ? (cur - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - cur) / pos.entryPrice * 100;
          const maxPnl = pos.side === 'buy' ? (pos.maxPrice - pos.entryPrice) / pos.entryPrice * 100 : (pos.entryPrice - pos.minPrice) / pos.entryPrice * 100;
          msg += `${pos.side === 'buy' ? '🟢' : '🔴'} ${symShort} ${pos.side.toUpperCase()} @ ${pos.entryPrice} | cur=${cur.toFixed(4)} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% (fata de max: ${Math.min(0, pnl-maxPnl).toFixed(2)}%) negRuns=${pos.negativeRuns||0}\n`;
        } catch (e) {}
      }
      await sendTelegram(msg.trim());
    }
  }

  console.log(`\n[${BOT_NAME}] === DONE ${new Date().toISOString()} ===\n`);
}

main().catch(e => { console.error(`[${BOT_NAME}] FATAL:`, e.message); process.exit(1); });
