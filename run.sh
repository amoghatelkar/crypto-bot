#!/data/data/com.termux/files/usr/bin/bash
tmux new-session -A -d -s crypto 'node bot.js'
echo "🚀 Crypto bot running in tmux. Use: tmux attach -t crypto"