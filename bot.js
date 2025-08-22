/**
 * Binance-feed + ZebPay-trade hybrid bot
 * Strategy: SMA crossover + RSI filter (multi-pair)
 * ---------------------------------------------------
 * • Monitors Binance prices (in USDT), converts to INR
 * • Uses SMA and RSI to decide BUY / SELL
 * • Trades on ZebPay (INR market) using your balance
 * • Logs important steps, sends alerts via Telegram
 */
require('dotenv').config();
const axios   = require('axios');
const crypto  = require('crypto');
const ti      = require('technicalindicators');
const { sendTelegram }     = require('./telegram');
const { BIN_PAIR, AMOUNT } = require('./coin');

// Strategy settings
const SHORT      = +process.env.SHORT_PERIOD || 5;
const LONG       = +process.env.LONG_PERIOD  || 10;
const INTERVAL   = (+process.env.INTERVAL    || 30) * 1000; // in ms
const RSI_PERIOD = 14;
const USDT_INR   = +process.env.USDT_INR || 85;
const MAX_SPEND  = +process.env.MAX_SPEND || 5000; // Max INR per trade

// ZebPay API Auth
const Z_API    = 'https://www.zebapi.com/api/v1';
const Z_KEY    = process.env.ZEBPAY_API_KEY;
const Z_SECRET = process.env.ZEBPAY_API_SECRET;

function signPayload(payload) {
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', Z_SECRET).update(payloadStr).digest('hex');
  return { signature, payloadStr };
}

async function placeOrder(orderData) {
  const timestamp = Date.now();
  const fullPayload = { ...orderData, timestamp };
  const { signature, payloadStr } = signPayload(fullPayload);

  return (await axios({
    url: `${Z_API}/orders`,
    method: 'POST',
    headers: {
      'X-AUTH-APIKEY': Z_KEY,
      'X-AUTH-SIGNATURE': signature,
      'Content-Type': 'application/json'
    },
    data: payloadStr
  })).data;
}

async function getBalance(asset) {
  const timestamp = Date.now();
  const queryStr = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', Z_SECRET).update(queryStr).digest('hex');

  const response = await axios({
    url: `${Z_API}/wallet/balance?${queryStr}`,
    method: 'GET',
    headers: {
      'X-AUTH-APIKEY': Z_KEY,
      'X-AUTH-SIGNATURE': signature
    }
  });

  return parseFloat(response.data?.data?.[asset]?.available || 0);
}

const lastSide = {}; // Remember last action to prevent duplicates

async function executeBuy(pair, qty, priceINR, rsi) {
  console.log(`\n🟢 [BUY] Attempting ${pair} @ ₹${priceINR} | RSI ${rsi.toFixed(1)}`);
  await sendTelegram(`🟢 [BUY] ${pair} @ ₹${priceINR} (RSI ${rsi.toFixed(1)})`);
  try {
    await placeOrder({
      trade_pair: pair,
      side: 'bid',
      size: qty,
      price: parseFloat(priceINR),
      tradeType: 1,
      platform: 'API_Trading'
    });
    lastSide[pair] = 'buy';
    console.log(`✅ [SUCCESS] Bought ${pair}`);
    await sendTelegram(`✅ [SUCCESS] Bought ${pair}`);
  } catch (e) {
    console.error(`❌ [BUY ERROR] ${e.message}`);
    await sendTelegram(`❌ [BUY ERROR] ${pair}: ${e.message.slice(0, 120)}`);
  }
}

async function executeSell(pair, qty, priceINR, rsi) {
  console.log(`\n🔴 [SELL] Attempting ${pair} @ ₹${priceINR} | RSI ${rsi.toFixed(1)}`);
  await sendTelegram(`🔴 [SELL] ${pair} @ ₹${priceINR} (RSI ${rsi.toFixed(1)})`);
  try {
    await placeOrder({
      trade_pair: pair,
      side: 'ask',
      size: qty,
      price: parseFloat(priceINR),
      tradeType: 1,
      platform: 'API_Trading'
    });
    lastSide[pair] = 'sell';
    console.log(`✅ [SUCCESS] Sold ${pair}`);
    await sendTelegram(`✅ [SUCCESS] Sold ${pair}`);
  } catch (e) {
    console.error(`❌ [SELL ERROR] ${e.message}`);
    await sendTelegram(`❌ [SELL ERROR] ${pair}: ${e.message.slice(0, 120)}`);
  }
}

async function trade(pair) {
  try {
    const lim = Math.max(LONG, RSI_PERIOD) + 5;
    const url = `https://api.binance.com/api/v3/klines?symbol=${BIN_PAIR[pair]}&interval=1m&limit=${lim}`;
    let rows;
    try {
      rows = (await axios.get(url)).data;
    } catch (e) {
      if (e.response?.status === 404) {
        console.log(`⚠️ [${pair}] Binance 404 – Skipping`);
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

    if (pair === 'BTC-INR') {
      const inrBal = await getBalance('INR');
      console.log(`\n💼 INR Balance: ₹${inrBal.toFixed(0)}`);
    }

    console.log(`[${pair}] SMA(${SHORT}): ${smaS?.toFixed(2)}, SMA(${LONG}): ${smaL?.toFixed(2)}, RSI: ${rsi?.toFixed(1)}`);

    if (!smaS || !smaL || !rsi) return;

    // BUY
    if (smaS >= smaL && rsi < 90 && lastSide[pair] !== 'buy') {
      const inrAvail = await getBalance('INR');
      const estCost = AMOUNT[pair] * lastPriceUSDT * USDT_INR;

      if (inrAvail < estCost) {
        console.log(`⚠️ [${pair}] Not enough INR – Need ₹${estCost.toFixed(0)}, Have ₹${inrAvail.toFixed(0)}`);
        return;
      }
      if (estCost > MAX_SPEND) {
        console.log(`⚠️ [${pair}] Skip BUY – Exceeds max cap ₹${MAX_SPEND}`);
        return;
      }
      await executeBuy(pair, AMOUNT[pair], priceINR, rsi);
    }

    // SELL
    if (smaS <= smaL && rsi > 75 && lastSide[pair] !== 'sell') {
      const token = pair.split('-')[0];
      const balance = await getBalance(token);
      if (balance < AMOUNT[pair]) {
        console.log(`⚠️ [${pair}] Not enough ${token} – Have ${balance}, Need ${AMOUNT[pair]}`);
        return;
      }
      await executeSell(pair, AMOUNT[pair], priceINR, rsi);
    }

  } catch (err) {
    console.error(`🚨 [${pair}] Unexpected Error: ${err.message}`);
    if (!err.message.includes('404')) {
      await sendTelegram(`🚨 [${pair}] Error: ${err.message.slice(0, 120)}`);
    }
  }
}

const PAIRS = Object.keys(BIN_PAIR);
console.log(`\n🤖 Hybrid Trading Bot Started\nWatching: ${PAIRS.join(', ')}\nInterval: ${INTERVAL/1000}s\n`);
setInterval(() => PAIRS.forEach(trade), INTERVAL);