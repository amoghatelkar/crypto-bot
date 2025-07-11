/**  Binance-feed + ZebPay-trade hybrid bot – SMA + RSI, multi-pair **/
require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const ti     = require('technicalindicators');
const { sendTelegram } = require('./telegram');

/*── strategy params (from .env or defaults) ──*/
const SHORT = +process.env.SHORT_PERIOD || 5;
const LONG  = +process.env.LONG_PERIOD  || 10;
const INTERVAL = (+process.env.INTERVAL || 30) * 1000;
const RSI_PERIOD = 14;

/*── where we fetch candles (Binance) and trade (ZebPay) ──*/
const BIN_PAIR = { 'BTC-INR':'BTCUSDT', 'ETH-INR':'ETHUSDT', 'DOGE-INR':'DOGEUSDT' };
const AMOUNT   = { 'BTC-INR':0.0001, 'ETH-INR':0.001, 'DOGE-INR':10 };

const Z_API   = 'https://www.zebapi.com/pro/v2';
const Z_KEY   = process.env.ZEBPAY_API_KEY;
const Z_SECRET= process.env.ZEBPAY_API_SECRET;

/*── ZebPay signing helper ──*/
function zbSign(path, body='') {
  const nonce = Date.now().toString();
  const sig   = crypto.createHmac('sha256', Z_SECRET).update(nonce+path+body).digest('hex');
  return { nonce, sig };
}
async function zbPriv(method,path,obj={}) {
  const body = JSON.stringify(obj);
  const { nonce,sig } = zbSign(path,body);
  return (await axios({
    url:Z_API+path, method,
    headers:{
      'Content-Type':'application/json',
      'X-ZB-APIKEY':Z_KEY,
      'X-ZB-NONCE':nonce,
      'X-ZB-SIGNATURE':sig
    }, data:body
  })).data;
}

/*── state ──*/
const lastSide = {};

/*── per-pair worker ──*/
async function trade(pair){
  try {
    /* 1) fetch Binance candles */
    const lim = Math.max(LONG,RSI_PERIOD)+5;
    const url = `https://api.binance.com/api/v3/klines?symbol=${BIN_PAIR[pair]}&interval=1m&limit=${lim}`;
    const rows = (await axios.get(url)).data;
    const closes = rows.map(r=>+r[4]);

    const smaS = ti.SMA.calculate({period:SHORT,values:closes}).pop();
    const smaL = ti.SMA.calculate({period:LONG ,values:closes}).pop();
    const rsi  = ti.RSI.calculate({period:RSI_PERIOD,values:closes}).pop();
    const px   = closes.at(-1).toFixed(2);

    console.log(`[${pair}] SMA${SHORT}:${smaS?.toFixed(2)} SMA${LONG}:${smaL?.toFixed(2)} RSI:${rsi?.toFixed(1)}`);

    if(!smaS||!smaL||!rsi) return;

    /* 2) buy */
    if(smaS>smaL && rsi<30 && lastSide[pair]!=='buy'){
      await zbPriv('POST','/user/orders',{
        currencyPair:pair,type:'market',side:'buy',quantity:AMOUNT[pair]
      });
      await sendTelegram(`✅ BUY ${pair} @ BinancePx ${px} RSI ${rsi.toFixed(1)}`);
      lastSide[pair]='buy';
    }
    /* 3) sell */
    if(smaS<smaL && rsi>70 && lastSide[pair]!=='sell'){
      await zbPriv('POST','/user/orders',{
        currencyPair:pair,type:'market',side:'sell',quantity:AMOUNT[pair]
      });
      await sendTelegram(`❌ SELL ${pair} @ BinancePx ${px} RSI ${rsi.toFixed(1)}`);
      lastSide[pair]='sell';
    }

  } catch(e){
    console.error(`[${pair}] ${e.message}`);
    await sendTelegram(`⚠️ ${pair} error: ${e.message.slice(0,120)}`);
  }
}

/*── scheduler ──*/
const PAIRS = Object.keys(BIN_PAIR);
console.log(`🤖 Hybrid bot running ${PAIRS.join(', ')} every ${INTERVAL/1000}s`);
setInterval(()=>PAIRS.forEach(trade), INTERVAL);