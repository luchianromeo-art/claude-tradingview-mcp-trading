// bot2.js — EMA20 + EMA50 + RSI14 + Bollinger Bands + Volume | TP 3% | SL 1.5%
// Exchange: BitGet | Timeframe: 1H | Symbols: BTCUSDT, ETHUSDT, SOLUSDT, DOGEUSDT
// Results: trades2.csv | Paper Trading Spot

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  exchange: 'bitget',
  symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'DOGE/USDT'],
  timeframe: '1h',
  limit: 100,
  takeProfitPct: 0.03,  // 3%
  stopLossPct: 0.015,   // 1.5%
  tradeSize: 100,       // USDT per trade (paper)
  bbPeriod: 20,         // Bollinger Bands period
  bbStdDev: 2,          // Bollinger Bands std dev multiplier
  rsiPeriod: 14,
  emaFast: 20,
  emaSlow: 50,
  volumeMultiplier: 1.2, // volume must be 20% above average to confirm signal
  csvFile: path.join(__dirname, 'trades2.csv'),
  paperTrading: true,
};

// ─── EXCHANGE SETUP ───────────────────────────────────────────────────────────
const exchange = new ccxt.bitget({
  apiKey: process.env.BITGET_API_KEY || '',
  secret: process.env.BITGET_SECRET || '',
  password: process.env.BITGET_PASSPHRASE || '',
  options: { defaultType: 'spot' },
});

// ─── INDICATORS ───────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  // Initial average
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcBollingerBands(closes, period = 20, stdDevMult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + stdDevMult * stdDev,
    middle: mean,
    lower: mean - stdDevMult * stdDev,
    bandwidth: (2 * stdDevMult * stdDev) / mean, // normalized bandwidth
  };
}

function calcAverageVolume(candles, period = 20) {
  const vols = candles.slice(-period).map(c => c[5]);
  return vols.reduce((a, b) => a + b, 0) / period;
}

// ─── CSV HELPERS ──────────────────────────────────────────────────────────────
function ensureCSV() {
  if (!fs.existsSync(CONFIG.csvFile)) {
    fs.writeFileSync(
      CONFIG.csvFile,
      'timestamp,symbol,signal,price,tp,sl,size_usdt,ema20,ema50,rsi14,bb_upper,bb_lower,bb_width,vol_ratio,result,pnl_pct\n'
    );
  }
}

function appendTrade(row) {
  const line = [
    row.timestamp, row.symbol, row.signal, row.price,
    row.tp, row.sl, row.size_usdt,
    row.ema20, row.ema50, row.rsi14,
    row.bb_upper, row.bb_lower, row.bb_width,
    row.vol_ratio, row.result, row.pnl_pct,
  ].join(',') + '\n';
  fs.appendFileSync(CONFIG.csvFile, line);
}

// ─── POSITION STORE ───────────────────────────────────────────────────────────
const positionsFile = path.join(__dirname, 'positions_bot2.json');

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(positionsFile, 'utf8'));
  } catch {
    return {};
  }
}

function savePositions(positions) {
  fs.writeFileSync(positionsFile, JSON.stringify(positions, null, 2));
}

// ─── SIGNAL LOGIC ─────────────────────────────────────────────────────────────
function getSignal(candles) {
  const closes = candles.map(c => c[4]);
  const ema20 = calcEMA(closes, CONFIG.emaFast);
  const ema50 = calcEMA(closes, CONFIG.emaSlow);
  const rsi14 = calcRSI(closes, CONFIG.rsiPeriod);
  const bb = calcBollingerBands(closes, CONFIG.bbPeriod, CONFIG.bbStdDev);
  const lastClose = closes[closes.length - 1];
  const avgVol = calcAverageVolume(candles, 20);
  const lastVol = candles[candles.length - 1][5];
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const volumeConfirm = volRatio >= CONFIG.volumeMultiplier;

  console.log(
    `  EMA20=${ema20.toFixed(4)} EMA50=${ema50.toFixed(4)} RSI14=${rsi14.toFixed(2)}` +
    ` BB[${bb.lower.toFixed(4)}-${bb.upper.toFixed(4)}] Vol=${volRatio.toFixed(2)}x Close=${lastClose.toFixed(4)}`
  );

  // ── BUY CONDITIONS ──
  // 1. EMA20 crosses above EMA50 (bullish trend)
  // 2. Price bounces off/near BB lower band (oversold mean-reversion)
  // 3. RSI below 50 but recovering (not overbought)
  // 4. Volume confirms (above average)
  const bullishTrend = ema20 > ema50;
  const nearBBLower = lastClose <= bb.lower * 1.01; // within 1% of lower band
  const rsiRecovering = rsi14 > 30 && rsi14 < 55;

  if (bullishTrend && nearBBLower && rsiRecovering && volumeConfirm) {
    return { signal: 'BUY', ema20, ema50, rsi14, bb, volRatio };
  }

  // ── SELL CONDITIONS ──
  // 1. EMA20 crosses below EMA50 (bearish trend)
  // 2. Price touches/near BB upper band (overbought mean-reversion)
  // 3. RSI above 50 and overheating
  // 4. Volume confirms
  const bearishTrend = ema20 < ema50;
  const nearBBUpper = lastClose >= bb.upper * 0.99;
  const rsiOverbought = rsi14 > 55 && rsi14 < 80;

  if (bearishTrend && nearBBUpper && rsiOverbought && volumeConfirm) {
    return { signal: 'SELL', ema20, ema50, rsi14, bb, volRatio };
  }

  return { signal: 'HOLD', ema20, ema50, rsi14, bb, volRatio };
}

// ─── MAIN RUN ─────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n[bot2.js] Run started: ${new Date().toISOString()}`);
  ensureCSV();
  const positions = loadPositions();

  for (const symbol of CONFIG.symbols) {
    try {
      console.log(`\n[${symbol}] Fetching candles...`);
      const candles = await exchange.fetchOHLCV(symbol, CONFIG.timeframe, undefined, CONFIG.limit);
      if (!candles || candles.length < 55) { // need at least 55 for EMA50
        console.log(`  Not enough candles, skipping.`);
        continue;
      }

      const lastClose = candles[candles.length - 1][4];
      const { signal, ema20, ema50, rsi14, bb, volRatio } = getSignal(candles);
      const pos = positions[symbol];
      const now = new Date().toISOString();

      // ── CHECK EXISTING POSITION FOR TP / SL ──
      if (pos) {
        const pnlPct = ((lastClose - pos.entryPrice) / pos.entryPrice) * (pos.side === 'LONG' ? 1 : -1);
        const hitTP = pnlPct >= CONFIG.takeProfitPct;
        const hitSL = pnlPct <= -CONFIG.stopLossPct;

        if (hitTP || hitSL) {
          const result = hitTP ? 'TP_HIT' : 'SL_HIT';
          console.log(`  [${result}] Closing ${pos.side} @ ${lastClose} | PnL: ${(pnlPct * 100).toFixed(2)}%`);
          appendTrade({
            timestamp: now, symbol,
            signal: `CLOSE_${pos.side}`,
            price: lastClose.toFixed(6),
            tp: pos.tp, sl: pos.sl,
            size_usdt: CONFIG.tradeSize,
            ema20: ema20.toFixed(4), ema50: ema50.toFixed(4),
            rsi14: rsi14.toFixed(2),
            bb_upper: bb.upper.toFixed(4), bb_lower: bb.lower.toFixed(4),
            bb_width: bb.bandwidth.toFixed(4),
            vol_ratio: volRatio.toFixed(2),
            result,
            pnl_pct: (pnlPct * 100).toFixed(2),
          });
          delete positions[symbol];
          savePositions(positions);
          continue;
        }

        console.log(`  Holding ${pos.side} @ entry=${pos.entryPrice} | currentPnL=${(pnlPct * 100).toFixed(2)}%`);
        continue;
      }

      // ── OPEN NEW POSITION ──
      if (signal === 'BUY') {
        const tp = +(lastClose * (1 + CONFIG.takeProfitPct)).toFixed(6);
        const sl = +(lastClose * (1 - CONFIG.stopLossPct)).toFixed(6);
        positions[symbol] = { side: 'LONG', entryPrice: lastClose, tp, sl, openedAt: now };
        savePositions(positions);
        console.log(`  ✅ BUY signal | Entry=${lastClose} TP=${tp} SL=${sl}`);
        appendTrade({
          timestamp: now, symbol, signal: 'BUY',
          price: lastClose.toFixed(6), tp, sl,
          size_usdt: CONFIG.tradeSize,
          ema20: ema20.toFixed(4), ema50: ema50.toFixed(4),
          rsi14: rsi14.toFixed(2),
          bb_upper: bb.upper.toFixed(4), bb_lower: bb.lower.toFixed(4),
          bb_width: bb.bandwidth.toFixed(4),
          vol_ratio: volRatio.toFixed(2),
          result: 'OPEN', pnl_pct: '0',
        });
      } else if (signal === 'SELL') {
        const tp = +(lastClose * (1 - CONFIG.takeProfitPct)).toFixed(6);
        const sl = +(lastClose * (1 + CONFIG.stopLossPct)).toFixed(6);
        positions[symbol] = { side: 'SHORT', entryPrice: lastClose, tp, sl, openedAt: now };
        savePositions(positions);
        console.log(`  ✅ SELL signal | Entry=${lastClose} TP=${tp} SL=${sl}`);
        appendTrade({
          timestamp: now, symbol, signal: 'SELL',
          price: lastClose.toFixed(6), tp, sl,
          size_usdt: CONFIG.tradeSize,
          ema20: ema20.toFixed(4), ema50: ema50.toFixed(4),
          rsi14: rsi14.toFixed(2),
          bb_upper: bb.upper.toFixed(4), bb_lower: bb.lower.toFixed(4),
          bb_width: bb.bandwidth.toFixed(4),
          vol_ratio: volRatio.toFixed(2),
          result: 'OPEN', pnl_pct: '0',
        });
      } else {
        console.log(`  HOLD — no trade.`);
      }

    } catch (err) {
      console.error(`  Error processing ${symbol}:`, err.message);
    }
  }

  console.log(`\n[bot2.js] Run complete: ${new Date().toISOString()}`);
}

run().catch(console.error);
