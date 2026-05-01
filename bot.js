// BOT 1 — VWAP + EMA8 + RSI3
// PC8 | 02.05.2026 | BitGet USDT-M Futures | Railway
// NOU PC8: Trailing Stop (+0.5% activ / -0.5% trail), Cooldown 1 run, Fix qty DOGE, RSI3=100 fix

const ccxt = require('ccxt');
require('dotenv').config();

const SYMBOLS = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT'];
const TIMEFRAME = '1h';
const TP_PCT         = 0.02;
const SL_PCT         = 0.01;
const TRAIL_ACTIVATE = 0.005;  // +0.5% — activeaza trailing
const TRAIL_STEP     = 0.005;  // -0.5% fata de maxim => inchide
const TRADE_SIZE = parseFloat(process.env.TRADE_SIZE || '10');
const PAPER      = process.env.PAPER_TRADING === 'true';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'luchianromeo-art/claude-tradingview-mcp-trading';

const MIN_QTY = {
  'BTC/USDT:USDT': 0.001, 'ETH/USDT:USDT': 0.01,
  'SOL/USDT:USDT': 0.1,   'DOGE/USDT:USDT': 1
};
const PRICE_DEC = {
  'BTC/USDT:USDT': 0, 'ETH/USDT:USDT': 2,
  'SOL/USDT:USDT': 2, 'DOGE/USDT:USDT': 5
};

const exchange = new ccxt.bitget({
  apiKey: process.env.BITGET_API_KEY,
  secret: process.env.BITGET_SECRET,
  password: process.env.BITGET_PASSPHRASE,
  options: { defaultType: 'swap' }
});

// ─── GITHUB ───────────────────────────────────────────────────────────────────

async function ghGet(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!res.ok) return null;
  return res.json();
}

async function ghSave(path, content, sha) {
  const body = { message: `bot1 ${path}`, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.ok;
}

async function loadJSON(path) {
  const f = await ghGet(path);
  if (!f) return {};
  return JSON.parse(Buffer.from(f.content, 'base64').toString());
}

async function saveJSON(path, data) {
  const f = await ghGet(path);       // SHA proaspata — fix conflict Railway auto-commit
  const sha = f ? f.sha : undefined;
  return ghSave(path, JSON.stringify(data, null, 2), sha);
}

async function loadPositions()     { return loadJSON('data/positions_bot1.json'); }
async function savePositions(p)    { return saveJSON('data/positions_bot1.json', p); }
async function loadBot2Positions() { return loadJSON('data/positions_bot2.json'); }

async function prependCSV(row) {
  const path = 'data/trades.csv';
  const f = await ghGet(path);
  const header = 'Data intrare,Symbol,Semnal,Pret intrare,TP,SL,Size,Rezultat,Data iesire,PnL $,PnL %\n';
  let content = f ? Buffer.from(f.content, 'base64').toString() : header;
  const sha   = f ? f.sha : undefined;
  if (!content.startsWith('Data')) content = header + content;
  const lines = content.split('\n');
  lines.splice(1, 0, row);
  await ghSave(path, lines.join('\n'), sha);
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────

async function tg(msg) {
  if (!process.env.TELEGRAM_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `🔵 [BOT1] ${msg}` })
    });
  } catch {}
}

// ─── INDICATORI ───────────────────────────────────────────────────────────────

function ema(closes, period) {
  const k = 2 / (period + 1);
  let v = closes[0];
  for (let i = 1; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function rsi3(closes) {
  // PC8 fix RSI3=100: losses=0 => returna 100 extrem; acum plafonat la 99
  // PC7 fix RSI3=0: gains=0 si losses=0 => 50 (neutral) — pastrat
  const period = 3;
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 99;   // PC8: plafon in loc de 100
  if (gains  === 0) return 1;    // simetric pentru RSI extrem jos
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcVwap(candles) {
  let sumPV = 0, sumV = 0;
  for (const c of candles) {
    const tp = (c[2] + c[3] + c[4]) / 3;
    sumPV += tp * c[5]; sumV += c[5];
  }
  return sumV === 0 ? 0 : sumPV / sumV;
}

// ─── UTILITARE ────────────────────────────────────────────────────────────────

function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth()+1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtPrice(sym, v) {
  const dec = PRICE_DEC[sym] ?? 2;
  if (dec === 0) return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return v.toFixed(dec);
}

function calcQty(sym, price) {
  const min = MIN_QTY[sym] || 0.001;
  // PC8: Math.floor pentru toate — evita qty dublu DOGE si erori rotunjire
  const decPlaces = sym === 'DOGE/USDT:USDT' ? 0 : (String(min).split('.')[1]?.length || 3);
  const factor    = Math.pow(10, decPlaces);
  let qty = Math.floor((TRADE_SIZE / price) * factor) / factor;
  if (qty < min) qty = min;
  return qty;
}

// ─── EXCHANGE ─────────────────────────────────────────────────────────────────

async function setLeverage(sym) {
  if (PAPER) return;
  try {
    await exchange.setLeverage(1, sym, { marginCoin: 'USDT', holdSide: 'long' });
    await exchange.setLeverage(1, sym, { marginCoin: 'USDT', holdSide: 'short' });
  } catch (e) { console.log(`Leverage skip ${sym}: ${e.message}`); }
}

async function setTpSl(sym, side, qty, tp, sl) {
  if (PAPER) return;
  try {
    await exchange.privatePostApiV2MixOrderPlaceTpslOrder({
      symbol:           sym.replace('/', '').replace(':USDT', 'USDT'),
      productType:      'USDT-FUTURES',
      marginMode:       'crossed',
      marginCoin:       'USDT',
      planType:         'profit_loss',
      triggerPrice:     String(tp),
      stopSurplusPrice: String(tp),
      stopLossPrice:    String(sl),
      size:             String(qty),
      holdSide:         side === 'BUY' ? 'long' : 'short'
    });
    console.log(`TP/SL ok ${sym} TP=${tp} SL=${sl}`);
  } catch (e) {
    console.log(`TP/SL err ${sym}: ${e.message}`);
    await tg(`⚠️ TP/SL eroare ${sym} — seteaza manual: TP=${tp} SL=${sl}`);
  }
}

// ─── DESCHIDE POZITIE ─────────────────────────────────────────────────────────

async function openPos(sym, side, price, pos) {
  // PC8: Cooldown — skip 1 run (35 min) dupa TP/SL/Trail pe acelasi simbol
  if (pos._cooldown && pos._cooldown[sym]) {
    const elapsed = Date.now() - pos._cooldown[sym];
    if (elapsed < 35 * 60 * 1000) {
      console.log(`[BOT1] Cooldown activ ${sym} — skip`); return;
    }
    delete pos._cooldown[sym];
  }

  const qty = calcQty(sym, price);
  const dec = PRICE_DEC[sym] ?? 2;
  const tp  = parseFloat((side === 'BUY' ? price*(1+TP_PCT) : price*(1-TP_PCT)).toFixed(dec));
  const sl  = parseFloat((side === 'BUY' ? price*(1-SL_PCT) : price*(1+SL_PCT)).toFixed(dec));

  if (!PAPER) {
    await setLeverage(sym);
    try {
      await exchange.createMarketOrder(sym, side === 'BUY' ? 'buy' : 'sell', qty, undefined, {
        tradeSide: 'open', marginMode: 'crossed', marginCoin: 'USDT'
      });
    } catch (e) {
      console.log(`Open err ${sym}: ${e.message}`);
      await tg(`❌ Eroare open ${sym}: ${e.message}`); return;
    }
    await setTpSl(sym, side, qty, tp, sl);
  }

  pos[sym] = {
    side, entryPrice: price, qty, tp, sl, size: TRADE_SIZE,
    entryTime: new Date().toISOString(),
    maxPrice: price, minPrice: price, trailingActive: false
  };

  const em = side === 'BUY' ? '🟢' : '🔴';
  await tg(`${em} ${side} ${sym.replace('/USDT:USDT','')} @ ${fmtPrice(sym,price)} | TP=${fmtPrice(sym,tp)} SL=${fmtPrice(sym,sl)} | ${PAPER?'PAPER':'REAL'}`);
  console.log(`[BOT1] OPEN ${side} ${sym} @ ${price} qty=${qty} TP=${tp} SL=${sl}`);
}

// ─── INCHIDE POZITIE ──────────────────────────────────────────────────────────

async function closePos(sym, p, reason, price, pos) {
  if (!PAPER) {
    try {
      await exchange.createMarketOrder(sym, p.side === 'BUY' ? 'sell' : 'buy', p.qty, undefined, {
        tradeSide: 'close', marginMode: 'crossed', marginCoin: 'USDT'
      });
    } catch (e) {
      if (e.message && e.message.includes('22002')) {
        console.log(`${sym} 22002 — deja inchisa, ok`);
      } else {
        console.log(`Close err ${sym}: ${e.message}`);
        await tg(`❌ Eroare close ${sym}: ${e.message}`); return;
      }
    }
  }

  const pnlPct = p.side === 'BUY'
    ? ((price - p.entryPrice) / p.entryPrice) * 100
    : ((p.entryPrice - price) / p.entryPrice) * 100;
  const pnlUsd = (pnlPct / 100) * p.size;

  await prependCSV([
    fmtDate(new Date(p.entryTime)),
    sym.replace('/USDT:USDT','/USDT'),
    p.side,
    fmtPrice(sym, p.entryPrice),
    fmtPrice(sym, p.tp),
    fmtPrice(sym, p.sl),
    p.size, reason,
    fmtDate(new Date()),
    `${pnlUsd.toFixed(2)}$`,
    `${pnlPct.toFixed(2)}%`
  ].join(','));

  const em = pnlPct >= 0 ? '✅' : '❌';
  await tg(`${em} ${reason} ${sym.replace('/USDT:USDT','')} | ${pnlUsd.toFixed(2)}$ (${pnlPct.toFixed(2)}%)`);
  console.log(`[BOT1] CLOSE ${sym} ${reason} PnL=${pnlPct.toFixed(2)}%`);

  delete pos[sym];
  if (!pos._cooldown) pos._cooldown = {};
  pos._cooldown[sym] = Date.now();
}

// ─── TRAILING STOP ────────────────────────────────────────────────────────────

function checkTrailing(sym, p, price) {
  if (p.side === 'BUY') {
    if (price > p.maxPrice) p.maxPrice = price;
    if (!p.trailingActive && (price - p.entryPrice) / p.entryPrice >= TRAIL_ACTIVATE) {
      p.trailingActive = true;
      console.log(`[BOT1] Trailing ACTIVAT ${sym} maxPrice=${p.maxPrice}`);
    }
    if (p.trailingActive && price <= p.maxPrice * (1 - TRAIL_STEP)) return true;
  } else {
    if (price < p.minPrice) p.minPrice = price;
    if (!p.trailingActive && (p.entryPrice - price) / p.entryPrice >= TRAIL_ACTIVATE) {
      p.trailingActive = true;
      console.log(`[BOT1] Trailing ACTIVAT ${sym} minPrice=${p.minPrice}`);
    }
    if (p.trailingActive && price >= p.minPrice * (1 + TRAIL_STEP)) return true;
  }
  return false;
}

// ─── CHECK INCHIDERE NATIVA BitGet ────────────────────────────────────────────

async function checkNativeClose(sym, p, pos) {
  if (PAPER) return false;
  try {
    const all    = await exchange.fetchPositions([sym]);
    const active = all.find(x => x.symbol === sym && x.contracts > 0);
    if (!active) {
      const ticker = await exchange.fetchTicker(sym);
      const price  = ticker.last;
      const pnlPct = p.side === 'BUY'
        ? ((price - p.entryPrice) / p.entryPrice) * 100
        : ((p.entryPrice - price) / p.entryPrice) * 100;
      const reason = pnlPct >= 0 ? 'TP_HIT' : 'SL_HIT';
      console.log(`[BOT1] ${sym} inchisa nativ => ${reason}`);
      await closePos(sym, p, reason, price, pos);
      return true;
    }
  } catch (e) { console.log(`checkNative err ${sym}: ${e.message}`); }
  return false;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n[BOT1] === PC8 START ${fmtDate(new Date())} | PAPER=${PAPER} ===`);

  const pos  = await loadPositions();
  const pos2 = await loadBot2Positions();
  if (!pos._cooldown) pos._cooldown = {};
  let changed = false;

  for (const sym of SYMBOLS) {
    try {
      // 1. Verifica inchidere nativa TP/SL BitGet
      if (pos[sym]) {
        const nativeClosed = await checkNativeClose(sym, pos[sym], pos);
        if (nativeClosed) { changed = true; continue; }
      }

      // 2. Fetch candle 1h
      const candles = await exchange.fetchOHLCV(sym, TIMEFRAME, undefined, 50);
      if (candles.length < 20) { console.log(`Date insuficiente ${sym}`); continue; }
      const closes = candles.map(c => c[4]);
      const price  = closes[closes.length - 1];

      // 3. Indicatori
      const ema8Val = ema(closes, 8);
      const vwapVal = calcVwap(candles);
      const rsi3Val = rsi3(closes);
      console.log(`[BOT1] ${sym} | P=${price} VWAP=${vwapVal.toFixed(2)} EMA8=${ema8Val.toFixed(2)} RSI3=${rsi3Val.toFixed(1)}`);

      // 4. Gestioneaza pozitie existenta
      if (pos[sym]) {
        const p = pos[sym];
        // Update high/low pentru trailing
        if (p.side === 'BUY'  && price > p.maxPrice) { p.maxPrice = price; changed = true; }
        if (p.side === 'SELL' && price < p.minPrice) { p.minPrice = price; changed = true; }

        const trailHit = checkTrailing(sym, p, price);
        if (trailHit) { await closePos(sym, p, 'TRAIL_STOP', price, pos); changed = true; continue; }

        // TP/SL fallback (daca nativul nu s-a atasat)
        const tpHit = p.side === 'BUY' ? price >= p.tp : price <= p.tp;
        const slHit = p.side === 'BUY' ? price <= p.sl : price >= p.sl;
        if (tpHit) { await closePos(sym, p, 'TP_HIT', price, pos); changed = true; continue; }
        if (slHit) { await closePos(sym, p, 'SL_HIT', price, pos); changed = true; continue; }

        console.log(`[BOT1] ${sym} HOLD | entry=${p.entryPrice} trailing=${p.trailingActive} max=${p.maxPrice}`);
        continue;
      }

      // 5. Semnal nou
      const sigBUY  = price > vwapVal && price > ema8Val && rsi3Val < 40;
      const sigSELL = price < vwapVal && price < ema8Val && rsi3Val > 60;

      // Conflict cross-bot: blocheaza aceeasi directie cu Bot2
      if (sigBUY  && pos2[sym]?.side === 'BUY')  { console.log(`[BOT1] BUY ${sym} BLOCAT — Bot2 LONG`);  continue; }
      if (sigSELL && pos2[sym]?.side === 'SELL') { console.log(`[BOT1] SELL ${sym} BLOCAT — Bot2 SHORT`); continue; }

      if      (sigBUY)  { await openPos(sym, 'BUY',  price, pos); changed = true; }
      else if (sigSELL) { await openPos(sym, 'SELL', price, pos); changed = true; }
      else              { console.log(`[BOT1] ${sym} HOLD — no signal`); }

    } catch (e) { console.error(`[BOT1] ERR ${sym}: ${e.message}`); }
  }

  if (changed) await savePositions(pos);
  console.log(`[BOT1] === DONE ${fmtDate(new Date())} ===\n`);
}

run().catch(e => { console.error('[BOT1] FATAL:', e.message); process.exit(1); });
