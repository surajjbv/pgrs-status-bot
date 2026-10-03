# govtrack-whatsapp

Tracks the status of Indian government applications and posts a short digest to a WhatsApp group,
twice a day, on a Mac. Captchas are read by a **local** vision model (Gemma 4 in LM Studio), so it runs
unattended and nothing leaves your machine except the site lookups and the WhatsApp message.

```
*Application status · Sat 3 Oct*
✅ *KA Grievance* — In process
   ↳ 28 Sep: Assigned to Project Director
🔔 *Property Tax* — Assistant approved → Bill collector approved
   ↳ 30 Sep: Bill Collector Approved by A B NAME (+1 more)
   https://emunicipal.ap.gov.in/services/property-tax/application-status
```

One line per application plus its latest update. A change is marked 🔔 with the old → new status, the
newest update and a link for details. A site that can't be checked shows ⚠️.

| Site | How |
|------|-----|
| [Karnataka IPGRS](https://ipgrs.karnataka.gov.in) grievance | JSON API; 5-char captcha read by the model |
| [AP PGRS](https://pgrs.ap.gov.in) grievance | headless Chrome, new instance per try, waits 8 s before submitting (the site rejects fast or repeat submits); case-sensitive 6-char captcha; status + Action History |
| [AP eMunicipal](https://emunicipal.ap.gov.in) property tax | public JSON API (status + Workflow History), no captcha |

## How it runs
- At `RUN_TIMES` (default 10:00 and 20:00 IST) via a launchd agent that ticks every 5 min. A time missed
  while the Mac was off or asleep runs 10 min after it is back (up to 10 h late).
- Before loading the model it checks macOS memory pressure and free RAM (model size + 4 GB). If short,
  it sends nothing and retries (every 5 min, then every 30 min). An already-loaded model is reused.
- Optionally shares the WhatsApp login of another whatsapp-web.js bot (`WA_SHARE_DIR`); the two take
  turns via a lock dir, so they never open WhatsApp or load the model at the same time.

## Setup (macOS, Node ≥ 22.13, Google Chrome, LM Studio with a vision model)
```
npm install
cp .env.example .env   # fill in your IDs, mobile number and WhatsApp group
npm run login          # skip if WA_SHARE_DIR is set: link WhatsApp (scan the QR)
npm run dry            # check everything and print the message (nothing sent)
npm run schedule       # run at RUN_TIMES from now on (npm run unschedule to stop)
```
`npm start`, or double-clicking `check-now.command` in Finder, sends a digest right now.
Logs: `data/run.log`. Last-seen state: `data/state.json` (delete it to start over).
`DEBUG_CAPTCHA=1 npm run dry` saves each captcha with the model's reading in `data/`.

Your IDs, mobile number and group name live only in `.env`; `.env` and `data/` are gitignored.

## License
MIT
