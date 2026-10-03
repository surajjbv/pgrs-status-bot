#!/bin/bash
# Double-click in Finder: check all three applications now and send the WhatsApp message.
cd "$(dirname "$0")"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "Checking applications… (about 30 s; waits if the school bot is running)"
node watch.js 2>&1 | tee -a data/run.log
echo; read -n 1 -s -r -p "Done. Press any key to close."
