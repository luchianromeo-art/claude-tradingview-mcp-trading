// bot.js — PC9 | VWAP + EMA8 + RSI3 | BitGet USDT-M Futures | Railway
// Baza: PC7 (API calls, GitHub, structura)
// Adaugat din PC8: Trailing Stop, Cooldown, RSI3 fix, calcQty Math.floor, setTpSl silentios

const ccxt   = require('ccxt');
const https  = require('https');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SYMBOLS        = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT'];
const TIMEFRAME      = '1h';
const TRADE_SIZE     = parseFloat(process.env.TRADE_SIZE || '10');
const PAPER_TRADING  = process.env.PAPER_TRADING === 'true';
const TP_PCT         = 0.02;    // +2%
const SL_PCT         = 0.01;    // -1%
const TRAIL_ACTIVATE = 0.005;   // +0.5% profit => activeaza trailing
const TRAIL_STEP     = 0.005;   // -0.5% fata de maxim => inchide
const COOLDOWN_MS    = 35 * 60 * 1000; // 35 minute
const MIN_QTY        = { 'BTC/USDT:USDT': 0.001, 'ETH/USDT:USDT': 0.01, 'SOL/USDT:USDT': 0.1, 'DOGE/USDT:USDT': 1 };
const CSV_FILE       = 'data/trades.csv';
const POSITIONS_FILE = 'data/positions_bot1.json';
const OTHER_POS_FILE = 'data/positions_bot2.json';
const GITHUB_REPO    = 'luchianromeo-art/claude-tradingview-mcp-trading';
const BOT_NAME       = 'Bot1';

// ─── EXCHANGE ────────────────────────────────────────────────────────────────
const exchange = new ccxt.bitget({
  apiKey:   process.env.BITGET_API_KEY,
  secret:   process.env.BITGET_SECRET,
  password: process.env.BITGET_PASSPHRASE,
  options:  { defaultType: 'swap' },
});

// ─── GITHUB API (PC7 — https nativ) ──────────────────────────────────────────
async function githubGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GITHUB_REPO}/contents/${path}`,
      method:   'GET',
      headers: {
        'Authorization': `token ${process.env.GITHUB_TOKEN}`,
        'User-Agent':    'trading-bot',
        'Accept':        'application/vnd.github.v3+json',
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
      sha:     sha || undefined,
    });
    const options = {
      hostname: 'api.github.com',
      path:     `/repos/${GITHUB_REPO}/contents/${path}`,
      method:   'PUT',
      headers: {
        'Authorization':  `token ${process.env.GITHUB_TOKEN}`,
        'User-Agent':     'trading-bot',
        'Accept':         'application/vnd.github.v3+json',
        'Content-Type':   'application/json',
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
    // SHA proaspata inainte de salvare — fix conflict Railway auto-commit (PC7)
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
  return { text: 'Data intrare,Symbol,Semnal,Pret intrare,TP,SL,Size,Rezultat,Data iesire,PnL $,PnL %\n', sha: null };
}

async function appendCSV(row, existingCSV) {
  const lines     = existingCSV.text.trim().split('\n');
  const header    = lines[0];
  const rest      = lines.slice(1).join('\n');
  const newContent = header + '\n' + row + (rest ? '\n' + rest : '') + '\n';
  // SHA proaspata pentru CSV
  let freshSha = existingCSV.sha;
  try {
    const current = await githubGet(CSV_FILE);
    if (current && current.sha) freshSha = current.sha;
  } catch (e) {}
  await githubPut(CSV_FILE, newContent, freshSha);
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text: `🔵 [BOT1] ${msg}` });
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path:     `/bot${token}/sendMessage`,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.error(`[${BOT_NAME}] Telegram error:`, e.message);
  }
}

// ─── BITGET DIRECT API — TP/SL nativ (PC7) ───────────────────────────────────
function bitgetSign(timestamp, method, requestPath, body = '') {
  const prehash = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac('sha256', process.env.BITGET_SECRET).update(prehash).digest('base64');
}

async function placeBitgetTPSL({ symbol, side, entryPrice, qty }) {
  const tpPrice = side === 'buy'
    ? (entryPrice * (1 + TP_PCT)).toFixed(2)
    : (entryPrice * (1 - TP_PCT)).toFixed(2);
  const slPrice = side === 'buy'
    ? (entryPrice * (1 - SL_PCT)).toFixed(2)
    : (entryPrice * (1 + SL_PCT)).toFixed(2);

  const productId = symbol.replace('/USDT:USDT', 'USDT');
  const holdSide  = side === 'buy' ? 'long' : 'short';
  const path      = '/api/v2/mix/order/place-tpsl-order';

  for (const [planType, triggerPrice] of [['profit_plan', tpPrice], ['loss_plan', slPrice]]) {
    try {
      const timestamp = Date.now().toString();
      const bodyObj   = { symbol: productId, productType: 'USDT-FUTURES', marginMode: 'crossed', marginCoin: 'USDT', planType, triggerPrice, executePrice: triggerPrice, holdSide, size: String(qty) };
      const bodyStr   = JSON.stringify(bodyObj);
      const sign      = bitgetSign(timestamp, 'POST', path, bodyStr);

      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.bitget.com',
          path,
          method:  'POST',
          headers: {
            'Content-Type':     'application/json',
            'ACCESS-KEY':       process.env.BITGET_API_KEY,
            'ACCESS-SIGN':      sign,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-PASSPHRASE': process.env.BITGET_PASSPHRASE,
            'Content-Length':   Buffer.byteLength(bodyStr),
          },
        }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
      });
      console.log(`[${BOT_NAME}] TP/SL nativ ok: ${planType} ${triggerPrice}`);
    } catch (e) {
      // Silentios — fallback PnL% la fiecare run (PC8)
      console.log(`[${BOT_NAME}] TP/SL nativ skip ${planType}: ${e.message}`);
    }
  }
  return { tpPrice, slPrice };
}

// ─── INDICATORI ──────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let v = closes[0];
  for (let i = 1; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function calcRSI3(closes) {
  // PC8 fix: losses=0 => 99, gains=0 => 1, ambele=0 => 50
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
  for (const c of candles) {
    const tp = (c[2] + c[3] + c[4]) / 3;
    sumPV += tp * c[5]; sumV += c[5];
  }
  return sumV === 0 ? 0 : sumPV / sumV;
}

// ─── UTILITARE ────────────────────────────────────────────────────────────────
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
  // PC8: Math.floor pentru toate simbolurile
  const min      = MIN_QTY[symbol] || 0.001;
  const decStr   = String(min).split('.')[1] || '';
  const decimals = symbol === 'DOGE/USDT:USDT' ? 0 : decStr.length;
  const factor   = Math.pow(10, decimals);
  let qty        = Math.floor((TRADE_SIZE / price) * factor) / factor;
  if (qty < min) qty = min;
  return qty;
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

// ─── CLOSE POSITION (PC7) ────────────────────────────────────────────────────
async function closePosition(symbol, side, qty) {
  const closeSide = side === 'buy' ? 'sell' : 'buy';
  try {
    await exchange.createMarketOrder(symbol, closeSide, qty, undefined, {
      reduceOnly: true,
      tradeSide:  'close',
    });
    console.log(`[${BOT_NAME}] Pozitie inchisa: ${symbol} qty=${qty}`);
    return true;
  } catch (e) {
    if (e.message && e.message.includes('22002')) {
      console.log(`[${BOT_NAME}] 22002 — pozitie deja inchisa: ${symbol}`);
      return true;
    }
    console.error(`[${BOT_NAME}] closePosition error ${symbol}:`, e.message);
    return false;
  }
}

// ─── TRAILING STOP (PC8 logica) ───────────────────────────────────────────────
function checkTrailing(symbol, pos, curPrice) {
  if (pos.side === 'buy') {
    if (curPrice > pos.maxPrice) pos.maxPrice = curPrice;
    if (!pos.trailingActive && (curPrice - pos.entryPrice) / pos.entryPrice >= TRAIL_ACTIVATE) {
      pos.trailingActive = true;
      console.log(`[${BOT_NAME}] Trailing ACTIVAT ${symbol} maxPrice=${pos.maxPrice}`);
    }
    if (pos.trailingActive && curPrice <= pos.maxPrice * (1 - TRAIL_STEP)) return true;
  } else {
    if (curPrice < pos.minPrice) pos.minPrice = curPrice;
    if (!pos.trailingActive && (pos.entryPrice - curPrice) / pos.entryPrice >= TRAIL_ACTIVATE) {
      pos.trailingActive = true;
      console.log(`[${BOT_NAME}] Trailing ACTIVAT ${symbol} minPrice=${pos.minPrice}`);
    }
    if (pos.trailingActive && curPrice >= pos.minPrice * (1 + TRAIL_STEP)) return true;
  }
  return false;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[${BOT_NAME}] === PC9 START ${new Date().toISOString()} ===`);
  console.log(`[${BOT_NAME}] PAPER_TRADING=${PAPER_TRADING} | TRADE_SIZE=${TRADE_SIZE}`);

  const csv                               = await loadCSV();
  const { data: positions, sha: posSha } = await loadPositions(POSITIONS_FILE);
  const { data: otherPositions }          = await loadPositions(OTHER_POS_FILE);
  if (!positions._cooldown) positions._cooldown = {};
  let positionsChanged = false;

  for (const symbol of SYMBOLS) {
    try {
      console.log(`\n[${BOT_NAME}] --- ${symbol} ---`);
      const symShort = symbol.split('/')[0] + 'USDT';

      // ── 1. Fetch price ───────────────────────────────────────────────────
      const candles = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, 50);
      if (candles.length < 20) { console.log(`[${BOT_NAME}] Date insuficiente ${symbol}`); continue; }
      const closes   = candles.map(c => c[4]);
      const curPrice = closes[closes.length - 1];

      // ── 2. Gestioneaza pozitie existenta ────────────────────────────────
      if (positions[symbol]) {
        const pos = positions[symbol];

        // PC7: verifica daca BitGet a inchis nativ prin TP/SL
        if (!PAPER_TRADING) {
          try {
            const openPos    = await exchange.fetchPositions([symbol]);
            const stillOpen  = openPos.some(p => p.symbol === symbol && Math.abs(p.contracts) > 0);
            if (!stillOpen) {
              const pnlPct = pos.side === 'buy'
                ? (curPrice - pos.entryPrice) / pos.entryPrice
                : (pos.entryPrice - curPrice) / pos.entryPrice;
              const result = pnlPct >= 0 ? 'TP_HIT' : 'SL_HIT';
              const pnlUsd = (pnlPct * TRADE_SIZE).toFixed(2);
              const row    = `${formatDate(new Date())},${symShort},${result},${formatPrice(symShort, pos.entryPrice)},${formatPrice(symShort, pos.tp)},${formatPrice(symShort, pos.sl)},${TRADE_SIZE}$,${result},${formatDate(new Date())},${pnlUsd}$,${(pnlPct*100).toFixed(2)}%`;
              await appendCSV(row, csv);
              await sendTelegram(`${result === 'TP_HIT' ? '✅' : '❌'} ${result} ${symShort} | ${pnlUsd}$ (${(pnlPct*100).toFixed(2)}%)`);
              delete positions[symbol];
              positions._cooldown[symbol] = Date.now();
              positionsChanged = true;
              console.log(`[${BOT_NAME}] ${result} detectat nativ: ${symbol} PnL=${(pnlPct*100).toFixed(2)}%`);
              continue;
            }
          } catch (e) {
            console.warn(`[${BOT_NAME}] fetchPositions warn ${symbol}: ${e.message}`);
          }
        }

        // PC8: Trailing Stop
        const trailHit = checkTrailing(symbol, pos, curPrice);
        if (trailHit) {
          const pnlPct = pos.side === 'buy'
            ? (curPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - curPrice) / pos.entryPrice;
          const pnlUsd = (pnlPct * TRADE_SIZE).toFixed(2);
          const closed = PAPER_TRADING ? true : await closePosition(symbol, pos.side, pos.qty);
          if (closed) {
            const row = `${formatDate(new Date())},${symShort},TRAIL_STOP,${formatPrice(symShort, pos.entryPrice)},${formatPrice(symShort, pos.tp)},${formatPrice(symShort, pos.sl)},${TRADE_SIZE}$,TRAIL_STOP,${formatDate(new Date())},${pnlUsd}$,${(pnlPct*100).toFixed(2)}%`;
            await appendCSV(row, csv);
            await sendTelegram(`🔒 TRAIL_STOP ${symShort} | ${pnlUsd}$ (${(pnlPct*100).toFixed(2)}%)`);
            delete positions[symbol];
            positions._cooldown[symbol] = Date.now();
            positionsChanged = true;
          }
          continue;
        }

        // Fallback TP/SL prin PnL%
        const pnlPct = pos.side === 'buy'
          ? (curPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - curPrice) / pos.entryPrice;

        console.log(`[${BOT_NAME}] Pozitie deschisa: ${symbol} ${pos.side.toUpperCase()} entry=${pos.entryPrice} cur=${curPrice} pnl=${(pnlPct*100).toFixed(2)}% trailing=${pos.trailingActive}`);

        let result = null;
        if (pnlPct >= TP_PCT)  result = 'TP_HIT';
        if (pnlPct <= -SL_PCT) result = 'SL_HIT';

        if (result) {
          const pnlUsd = (pnlPct * TRADE_SIZE).toFixed(2);
          const closed = PAPER_TRADING ? true : await closePosition(symbol, pos.side, pos.qty);
          if (closed) {
            const row = `${formatDate(new Date())},${symShort},${result},${formatPrice(symShort, pos.entryPrice)},${formatPrice(symShort, pos.tp)},${formatPrice(symShort, pos.sl)},${TRADE_SIZE}$,${result},${formatDate(new Date())},${pnlUsd}$,${(pnlPct*100).toFixed(2)}%`;
            await appendCSV(row, csv);
            await sendTelegram(`${result === 'TP_HIT' ? '✅' : '❌'} ${result} ${symShort} | ${pnlUsd}$ (${(pnlPct*100).toFixed(2)}%)`);
            delete positions[symbol];
            positions._cooldown[symbol] = Date.now();
            positionsChanged = true;
          }
        }
        continue;
      }

      // ── 3. Cooldown check (PC8) ──────────────────────────────────────────
      if (positions._cooldown[symbol]) {
        const elapsed = Date.now() - positions._cooldown[symbol];
        if (elapsed < COOLDOWN_MS) {
          console.log(`[${BOT_NAME}] Cooldown activ ${symbol} — ${Math.round((COOLDOWN_MS - elapsed) / 60000)} min ramasi`);
          continue;
        }
        delete positions._cooldown[symbol];
      }

      // ── 4. Calculeaza indicatori ─────────────────────────────────────────
      const vwap  = calcVWAP(candles);
      const ema8  = calcEMA(closes, 8);
      const rsi3  = calcRSI3(closes);
      const price = curPrice;

      console.log(`[${BOT_NAME}] ${symbol} | Price=${price.toFixed(4)} VWAP=${vwap.toFixed(4)} EMA8=${ema8.toFixed(4)} RSI3=${rsi3.toFixed(1)}`);

      let signal = null;
      if (price > vwap && price > ema8 && rsi3 < 40) signal = 'BUY';
      if (price < vwap && price < ema8 && rsi3 > 60) signal = 'SELL';

      if (!signal) { console.log(`[${BOT_NAME}] HOLD — no signal`); continue; }

      // ── 5. Conflict cross-bot ────────────────────────────────────────────
      if (otherPositions[symbol]) {
        const otherSide = otherPositions[symbol].side;
        const thisSide  = signal === 'BUY' ? 'buy' : 'sell';
        if (otherSide === thisSide) {
          console.log(`[${BOT_NAME}] BLOCAT — Bot2 are deja ${otherSide} pe ${symbol}`);
          continue;
        }
      }

      // ── 6. Calculeaza qty si preturi ─────────────────────────────────────
      const side    = signal === 'BUY' ? 'buy' : 'sell';
      const qty     = calcQty(symbol, price);
      const tpPrice = side === 'buy' ? price * (1 + TP_PCT) : price * (1 - TP_PCT);
      const slPrice = side === 'buy' ? price * (1 - SL_PCT) : price * (1 + SL_PCT);

      console.log(`[${BOT_NAME}] SEMNAL: ${signal} | ${symbol} | qty=${qty} | TP=${tpPrice.toFixed(4)} | SL=${slPrice.toFixed(4)}`);

      if (!PAPER_TRADING) {
        // setLeverage eliminat — setat manual Cross 1x pe BitGet, permanent
        await exchange.createMarketOrder(symbol, side, qty, undefined, {
          tradeSide:  'open',
          marginCoin: 'USDT',
        });
        await placeBitgetTPSL({ symbol, side, entryPrice: price, qty });
      }

      // ── 7. Salveaza pozitia ──────────────────────────────────────────────
      positions[symbol] = {
        side, entryPrice: price, qty, tp: tpPrice, sl: slPrice,
        openTime: Date.now(),
        maxPrice: price, minPrice: price, trailingActive: false,
      };
      positionsChanged = true;

      // ── 8. Salveaza in CSV ───────────────────────────────────────────────
      const row = `${formatDate(new Date())},${symShort},${signal},${formatPrice(symShort, price)},${formatPrice(symShort, tpPrice)},${formatPrice(symShort, slPrice)},${TRADE_SIZE}$,OPEN,,0.00$,0.00%`;
      await appendCSV(row, csv);
      await sendTelegram(`${signal === 'BUY' ? '🟢' : '🔴'} ${signal} ${symShort} @ ${formatPrice(symShort, price)} | TP=${formatPrice(symShort, tpPrice)} SL=${formatPrice(symShort, slPrice)} | ${PAPER_TRADING ? 'PAPER' : 'REAL'}`);

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
