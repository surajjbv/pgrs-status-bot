#!/bin/bash
# bash schedule.sh install    run automatically (launchd checks every 5 min)
# bash schedule.sh uninstall  stop it
# bash schedule.sh            (launchd) send once per RUN_TIMES slot (IST, default 10:00,20:00), at least
#                             10 min after boot/wake. A slot missed while the Mac was off/asleep runs once
#                             it is back, for up to 10 h. A failed or low-RAM run retries every 5 min,
#                             then every 30 min after 3 tries.
set -u
cd "$(dirname "$0")"
LABEL=com.govtrack-whatsapp
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
install)
  mkdir -p data "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$PWD/schedule.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PWD/data/launchd.log</string>
  <key>StandardErrorPath</key><string>$PWD/data/launchd.log</string>
</dict></plist>
XML
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Scheduled. Log: data/run.log. Remove with: npm run unschedule"
  exit ;;
uninstall)
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Unscheduled."
  exit ;;
esac

mkdir -p data
secs() { sysctl -n "$1" 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\1/'; }
boot=$(secs kern.boottime); wake=$(secs kern.waketime); wake=${wake:-0}
now=$(date +%s)
(( now - (wake > boot ? wake : boot) < 600 )) && exit 0   # wait 10 min after boot/wake

# The latest slot already passed, e.g. "2026-10-03 10:00" (yesterday's last slot before today's first).
times=$(grep -E '^RUN_TIMES=' .env 2>/dev/null | cut -d= -f2 | tr ',' ' '); times=${times:-10:00 20:00}
hm=$(TZ=Asia/Kolkata date +%H:%M); slot=""
for t in $(echo $times | tr ' ' '\n' | sort); do [[ "$hm" < "$t" ]] || slot="$(TZ=Asia/Kolkata date +%F) $t"; done
[ -n "$slot" ] || slot="$(TZ=Asia/Kolkata date -v-1d +%F) $(echo $times | tr ' ' '\n' | sort | tail -1)"
(( now - $(TZ=Asia/Kolkata date -j -f "%Y-%m-%d %H:%M" "$slot" +%s) > 36000 )) && exit 0   # too stale; wait for the next slot
[ "$(cat data/sent-slot 2>/dev/null)" = "$slot" ] && exit 0

[ "$(cut -d'|' -f1 data/tries 2>/dev/null)" = "$slot" ] || echo "$slot|0" > data/tries
tries=$(cut -d'|' -f2 data/tries)
[ "$tries" -ge 3 ] && [ -n "$(find data/tries -mmin -30)" ] && exit 0
find data -maxdepth 1 -name lock -mmin +60 -exec rmdir {} \; 2>/dev/null   # left by a crash
mkdir data/lock 2>/dev/null || exit 0                                     # a run is still going
trap 'rmdir data/lock' EXIT
echo "$slot|$((tries + 1))" > data/tries
node watch.js >> data/run.log 2>&1 && echo "$slot" > data/sent-slot
