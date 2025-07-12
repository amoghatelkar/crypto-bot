#!/data/data/com.termux/files/usr/bin/bash
# run.sh — log server + Cloudflare Tunnel + bot

set -e

# ── env vars ──────────────────────────
TOKEN=$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)
CHAT=$(grep TELEGRAM_CHAT_ID   .env | cut -d= -f2)

# ── 1) tiny log web-server on :3000 ──
cat <<'NODE' > .serveLogs.js
const http = require('http'), fs=require('fs');
http.createServer((_,res)=>{
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end(fs.existsSync('bot.log')?fs.readFileSync('bot.log','utf8'):'No log yet');
}).listen(3000);
NODE
nohup node .serveLogs.js >/dev/null 2>&1 &

# ── 2) start Cloudflare Tunnel ───────
nohup cloudflared tunnel --url http://localhost:3000 --no-autoupdate \
      --logfile .cf.log --loglevel info > /dev/null 2>&1 &

echo "Waiting for Cloudflare URL…"
sleep 4   # give tunnel a moment

# ── 3) grab the public URL from logs ─
URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' .cf.log | head -n1)

# ── 4) ping Telegram ─────────────────
if [ -n "$URL" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
       -H "Content-Type: application/json" \
       -d "{\"chat_id\":\"${CHAT}\",\"text\":\"🚀 New bot log link: ${URL}/\"}"
else
  echo "❌ Could not capture Cloudflare URL."
fi

# ── 5) run crypto bot in tmux ────────
tmux kill-session -t crypto 2>/dev/null || true
tmux new-session -d -s crypto "node bot.js 2>&1 | tee -a bot.log"

echo "✅ Bot + Cloudflare Tunnel running. Attach with: tmux attach -t crypto"