#!/bin/bash
# Double-click in Finder: check all three applications now and send the WhatsApp message.
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "Checking applications… (about 30 s; waits if another bot is using WhatsApp)"
npm start --silent
echo; read -n 1 -s -r -p "Done. Press any key to close."
