/**
 * Binance-feed + ZebPay-trade hybrid bot
 * Strategy: SMA crossover + RSI filter  (multi-pair)
 * -----------------------------------------------
 *  • Checks INR balance before BUY
 *  • Checks coin balance before SELL
 *  • Converts Binance USDT prices → INR with USDT_INR
 *  • Skips (but logs) Binance 404 errors
 *  • Prints INR wallet once per loop (BTC-INR branch)
 */
require('dotenv').config();
const axios   = require('axios');
const crypto  = require('crypto');
const ti      = require('technicalindicators');
const { sendTelegram }     = require('./telegram');
const { BIN_PAIR, AMOUNT } = require('./coin');

/*── strategy params ────────────────────────────────────────────────*/
const SHORT      = +process.env.SHORT_PERIOD || 5;
const LONG       = +process.env.LONG_PERIOD  || 10;
const INTERVAL   = (+process.env.INTERVAL    || 30) * 1000;
const RSI_PERIOD = 14;
const USDT_INR   = +process.env.USDT_INR || 85;  // override in .env if needed
const MAX_SPEND  = +process.env.MAX_SPEND || 5_000; // ₹ cap per BUY

/*── ZebPay auth ───────────────────────────────────────────────────*/
const Z_API    = 'https://www.zebapi.com/pro/v2';
const Z_KEY    = process.env.ZEBPAY_API_KEY;
const Z_SECRET = process.env.ZEBPAY_API_SECRET;
function zbSign(path, body='') {
  const nonce = Date.now().toString();
  const sig   = crypto.createHmac('sha256', Z_SECRET)
                      .update(nonce + path + body).digest('hex');
  return { nonce, sig };
}
async function zbPriv(method, path, obj={}) {
  const body = JSON.stringify(obj);
  const { nonce, sig } = zbSign(path, body);
  return (await axios({
    url: Z_API + path,
    method,
    headers: {
      'Content-Type'  : 'application/json',
      'X-ZB-APIKEY'   : Z_KEY,
      'X-ZB-NONCE'    : nonce,
      'X-ZB-SIGNATURE': sig
    },
    data: body
  })).data;
}
/*── helpers ───────────────────────────────────────────────────────*/
async function getBalance(asset) {
  const b = await zbPriv('GET', '/user/balances');
  return parseFloat(b?.[asset]?.available || 0);
}
/* track last side to avoid duplicate orders */
const lastSide = {};

/*── wrapped trade helpers ──────────────────────────────────*/
async function executeBuy(pair, qty, priceINR, rsi) {
  await sendTelegram(`🤖 ${pair} BUY @ ₹${priceINR} (RSI ${rsi.toFixed(1)})`);
  console.log(`Inside executeBuy: pair=${pair}, qty=${qty}, priceINR=${priceINR}, rsi=${rsi}`);
  try {
    await zbPriv('POST', '/user/orders', {
      currencyPair: pair,
      type: 'market',
      side: 'buy',
      quantity: qty,
    });
    await sendTelegram(`✅ BUY ${pair} @ ₹${priceINR} (RSI ${rsi.toFixed(1)})`);
    lastSide[pair] = 'buy';
  } catch (e) {
    console.error(`[${pair}] BUY error: ${e.message}`);
    await sendTelegram(`⚠️ BUY ${pair} failed: ${e.message.slice(0,120)}`);
  }
}

async function executeSell(pair, qty, priceINR, rsi) {
  await sendTelegram(`🤖 ${pair} SELL @ ₹${priceINR} (RSI ${rsi.toFixed(1)})`);
  console.log(`Inside executeSell: pair=${pair}, qty=${qty}, priceINR=${priceINR}, rsi=${rsi}`);
  try {
    await zbPriv('POST', '/user/orders', {
      currencyPair: pair,
      type: 'market',
      side: 'sell',
      quantity: qty,
    });
    await sendTelegram(`❌ SELL ${pair} @ ₹${priceINR} (RSI ${rsi.toFixed(1)})`);
    lastSide[pair] = 'sell';
  } catch (e) {
    console.error(`[${pair}] SELL error: ${e.message}`);
    await sendTelegram(`⚠️ SELL ${pair} failed: ${e.message.slice(0,120)}`);
  }
}

/*──────────────── main worker ─────────────────────────────────────*/
async function trade(pair) {
  try {
    /* 1️⃣ fetch Binance candles */
    const lim  = Math.max(LONG, RSI_PERIOD) + 5;
    const url  = `https://api.binance.com/api/v3/klines?symbol=${BIN_PAIR[pair]}&interval=1m&limit=${lim}`;
    let rows;
    try { rows = (await axios.get(url)).data; }
    catch (e) {
      if (e.response?.status === 404) {
        console.log(`[${pair}] Binance 404 – skipping this round`);
        return;
      }
      throw e;
    }
    const closes = rows.map(r => +r[4]);

    const smaS = ti.SMA.calculate({ period: SHORT, values: closes }).pop();
    const smaL = ti.SMA.calculate({ period: LONG , values: closes }).pop();
    const rsi  = ti.RSI.calculate({ period: RSI_PERIOD, values: closes }).pop();
    const lastPriceUSDT = closes.at(-1);
    const priceINR = (lastPriceUSDT * USDT_INR).toFixed(2);

    /* log headline + INR wallet once per loop */
    if (pair === 'BTC-INR') {
      const inrBal = await getBalance('INR');
      console.log(`💰 INR balance: ₹${inrBal.toFixed(0)}`);
    }
    console.log(`[${pair}] SMA${SHORT}:${smaS?.toFixed(2)} SMA${LONG}:${smaL?.toFixed(2)} RSI:${rsi?.toFixed(1)}`);

    if (!smaS || !smaL || !rsi) return;

    /* 2️⃣ BUY block */
    if (smaS >= smaL && rsi < 90 && lastSide[pair] !== 'buy') {

      const inrAvail = await getBalance('INR');
      const estCost  = AMOUNT[pair] * lastPriceUSDT * USDT_INR;

      if (inrAvail < estCost) {
        console.log(`[${pair}] SKIP BUY – need ₹${estCost.toFixed(0)}, have ₹${inrAvail.toFixed(0)}`);
        return;
      }
      if (estCost > MAX_SPEND) {
        console.log(`[${pair}] SKIP BUY – cost ₹${estCost.toFixed(0)} > cap ₹${MAX_SPEND}`);
        return;
      }

      await executeBuy(pair, AMOUNT[pair], priceINR, rsi);
    }

    /* 3️⃣ SELL block */
    if (smaS <= smaL && rsi > 75 && lastSide[pair] !== 'sell') {

      const token   = pair.split('-')[0];     // e.g. BTC
      const balance = await getBalance(token);
      if (balance < AMOUNT[pair]) {
        console.log(`[${pair}] SKIP SELL – have ${balance}, need ${AMOUNT[pair]}`);
        return;
      }
      await executeSell(pair, AMOUNT[pair], priceINR, rsi);
    }

  } catch (err) {
    console.error(`[${pair}] ERROR: ${err.message}`);
    if (!err.message.includes('404')) {
      await sendTelegram(`⚠️ ${pair} error: ${err.message.slice(0,120)}`);
    }
  }
}

/*── scheduler ──────────────────────────────────────────────────────*/
const PAIRS = Object.keys(BIN_PAIR);
console.log(`🤖 Hybrid bot running ${PAIRS.join(', ')} every ${(INTERVAL/1000)}s`);
setInterval(() => PAIRS.forEach(trade), INTERVAL);