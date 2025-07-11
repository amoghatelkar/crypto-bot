#!/bin/bash
tmux new-session -d -s crypto "node bot.js"
echo "🚀 Crypto bot running in tmux. Use: tmux attach -t crypto"