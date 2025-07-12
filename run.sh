#!/data/data/com.termux/files/usr/bin/bash
# run.sh  ─  start log server + Cloudflare Tunnel + crypto bot
# ⬇️  edit PORT only if you change the mini-web server
PORT=3000

set -e

###############################################################################
# 0) TELEGRAM env (read from .env)
###############################################################################
TOKEN=$(grep -m1 ^TELEGRAM_BOT_TOKEN= .env | cut -d= -f2-)
CHAT=$(grep -m1 ^TELEGRAM_CHAT_ID=   .env | cut -d= -f2-)

###############################################################################
# 1) start tiny read-only web server that serves bot.log on :$PORT
###############################################################################
cat > .serveLogs.js <<'NODE'
const fs = require('fs'), http = require('http');
http.createServer((_,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end(fs.existsSync('bot.log') ? fs.readFileSync('bot.log','utf8')
                                   : 'No log yet');
}).listen(process.env.PORT || 3000);
NODE
nohup node .serveLogs.js >/dev/null 2>&1 &

###############################################################################
# 2) launch Cloudflare quick tunnel
###############################################################################
rm -f .cf.log
nohup cloudflared tunnel --url http://localhost:$PORT --no-autoupdate \
      --logfile .cf.log --loglevel info >/dev/null 2>&1 &

echo "Waiting for Cloudflare URL …"
URL=""
for i in {1..20}; do
  URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' .cf.log | head -n1)
  [ -n "$URL" ] && break
  sleep 1
done

###############################################################################
# 3) send URL to Telegram (if captured)
###############################################################################
if [ -n "$URL" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
       -H "Content-Type: application/json" \
       -d "{\"chat_id\":\"${CHAT}\",\"text\":\"🌐 Log link: ${URL}/\"}"
  echo "Cloudflare URL sent to Telegram – ${URL}"
else
  echo "❌ Could not capture Cloudflare URL (check .cf.log)"
fi

###############################################################################
# 4) start crypto bot in tmux session “crypto”
###############################################################################
tmux kill-session -t crypto 2>/dev/null || true
tmux new-session -d -s crypto "node bot.js 2>&1 | tee -a bot.log"

echo "✅ Bot + Cloudflare Tunnel running.  Attach with:  tmux attach -t crypto"