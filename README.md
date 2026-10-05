# pgrs-status-bot

Tracks the status of Indian government applications and posts a short digest to a WhatsApp group,
twice a day, on a Mac. Captchas are read by a **local** vision model (Qwen3.8 27B in LM Studio), so it runs
unattended and nothing leaves your machine except the site lookups and the WhatsApp message.

```
*Application status · Sat 3 Oct*
✅ *KA Grievance* — In process
   ↳ 28 Sep: Assigned to Project Director
🔔 *Property Tax* — Assistant approved → Bill collector approved
   ↳ 30 Sep: Bill Collector Approved by A B NAME (+1 more)
   https://emunicipal.ap.gov.in/services/property-tax/application-status
_🤖 Qwen 3.8 27B (local)_
```

One line per application plus its latest update. A change is marked 🔔 with the old → new status, the
newest update and a link for details. A site that can't be checked shows ⚠️. The last line names the local model that read the captchas.

| Site | How |
|------|-----|
| [Karnataka IPGRS](https://ipgrs.karnataka.gov.in) grievance | JSON API; 5-char captcha read by the model |
| [AP PGRS](https://pgrs.ap.gov.in) grievance | headless Chrome, new instance per try, waits 8 s before submitting (the site rejects fast or repeat submits); case-sensitive 6-char captcha; status + Action History |
| [AP eMunicipal](https://emunicipal.ap.gov.in) property tax | public JSON API (status + Workflow History), no captcha |

## How it runs
- At `runTimes` in `config.json` (10:00 and 20:00 IST) via the shared launchd scheduler (`kit/schedule.sh`,
  every 5 min). A time missed while the Mac was off or asleep runs 10 min after it is back (up to 10 h late);
  a failed run retries every 5 min three times, then every 30 min.
- The model is shared with the other bots through the lease protocol in `kit/llm.js` (see botkit's
  PROTOCOL.md): an already-loaded copy is reused; otherwise it is loaded if LM Studio's memory guardrail allows,
  and unloaded when the last bot is done. If it can't be had, nothing is sent and the run is retried (exit 75).
  It is released before WhatsApp starts Chrome.
- Optionally shares the WhatsApp login of another whatsapp-web.js bot (`whatsappDir` in `config.json`); the
  bots take turns via a lock dir next to that login.

## Setup (macOS, Node ≥ 24, Google Chrome, LM Studio with Qwen3.8 27B)
```
npm install
cp .env.example .env   # fill in your IDs, mobile number and WhatsApp group; settings: config.json
npm run login          # skip if whatsappDir shares another bot's login: link WhatsApp (scan the QR)
npm test               # digest rules
npm run schedule       # run at runTimes from now on (npm run unschedule to stop)
```
`npm start`, or double-clicking `run-now.command` in Finder, sends a digest right now.
Log: `data/bot.log`. Last-sent state: `data/bot.db` (delete it to start over).
`"debugCaptcha": true` in config.json saves each captcha with the model's reading in `data/`.

Your IDs, mobile number and group name live only in `.env`; `.env` and `data/` are gitignored.

## License
MIT
