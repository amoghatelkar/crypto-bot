#!/data/data/com.termux/files/usr/bin/bash
# run.sh — starts log web-server, ngrok tunnel, sends URL to Telegram, then bot in tmux

set -e

# 0) Vars
TOKEN=$(grep TELEGRAM_BOT_TOKEN .env | cut -d= -f2)
CHAT=$(grep TELEGRAM_CHAT_ID   .env | cut -d= -f2)

# 1) Launch a super-simple log server (serves tail -100 bot.log)
#    We keep it in bg; node must be installed.
cat <<'EOF' > .serveLogs.js
const http = require('http'), fs=require('fs');
http.createServer((_,res)=> {
  res.writeHead(200,{'Content-Type':'text/plain'});
  res.end(fs.existsSync('bot.log') ? fs.readFileSync('bot.log','utf8') : 'No log yet');
}).listen(3000);
EOF
nohup node .serveLogs.js >/dev/null 2>&1 &

# 2) Start ngrok (http 3000) in background and capture URL
nohup ngrok http 3000 > /dev/null 2>&1 &
echo "Waiting for ngrok..."
sleep 3

# Poll the ngrok API up to 10 times (wait for tunnel to be ready)
for i in {1..10}; do
  URL=$(curl -s http://127.0.0.1:4040/api/tunnels | grep -oE 'https://[a-zA-Z0-9.-]+\.ngrok.io' | head -n1)
  [ -n "$URL" ] && break
  sleep 1
done

# 3) Send Telegram message with the fresh URL
if [ -n "$URL" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
       -H "Content-Type: application/json" \
       -d "{\"chat_id\":\"${CHAT}\",\"text\":\"🚀 New bot log URL: ${URL}/ (auto-generated)\"}"
else
  echo "❌ Could not grab ngrok URL!"
fi

# 4) Start crypto bot in tmux named 'crypto'
tmux kill-session -t crypto 2>/dev/null || true
tmux new-session -d -s crypto "node bot.js 2>&1 | tee -a bot.log"
echo "✅ Bot + ngrok running. Attach with: tmux attach -t crypto"