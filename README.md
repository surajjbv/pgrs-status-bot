# pgrs-status-bot

Checks three Indian government applications and posts one short WhatsApp digest at 10:00 and 20:00 (IST).
Captchas are read by a local model (Qwen3.8 27B in LM Studio), so it runs unattended; only the site lookups and
the WhatsApp message leave the Mac.

```
*Application status · Sat 3 Oct*
✅ *KA Grievance* — In process
   ↳ 28 Sep: Assigned to Project Director
🔔 *Property Tax* — Assistant approved → Bill collector approved
   ↳ 30 Sep: Bill Collector Approved by A B NAME (+1 more)
   https://emunicipal.ap.gov.in/services/property-tax/application-status
_🤖 Qwen 3.8 27B (local)_
```

## How it works

1. **Collect**: the three sites at once. [Karnataka IPGRS](https://ipgrs.karnataka.gov.in) (JSON API, 5-character
   captcha), [AP PGRS](https://pgrs.ap.gov.in) (headless Chrome, a new one per try, 8 s wait before submitting,
   case-sensitive 6-character captcha), [AP eMunicipal](https://emunicipal.ap.gov.in) (public JSON API).
   A wrong captcha read just costs another try (up to `captchaTries`).
2. **Decide**: compare with what was last sent: ✅ unchanged, 🔔 changed (with the newest update and a link),
   ⚠️ couldn't check.
3. **Act**: send to the WhatsApp group and remember what was sent. A slot already sent is never sent twice.

The model is shared with the other bots and released before WhatsApp starts Chrome. If it can't be had (busy, or
too little memory for LM Studio's guardrail), nothing is sent and the run is retried. WhatsApp uses one
linked login shared with school-reminder-bot, kept outside both projects (`whatsappDir`: `~/.local/state/whatsapp`);
the two bots take turns.

## Setup (macOS, Node 24+, Google Chrome, LM Studio with Qwen3.8 27B)

```
npm install
cp .env.example .env    # your IDs, mobile number and WhatsApp group
npm run login           # link WhatsApp once (scan the QR); skip if whatsappDir already holds a login
npm start               # check and send now
npm run schedule        # send at runTimes from now on (npm run unschedule to stop)
```
Settings: `config.json` (`runTimes`, `timezone`, `whatsappDir`, `captchaTries`, `debugCaptcha`, `model`).
Personal values: `.env` only (gitignored). Run now: double-click `run-now.command`.

## Files

```
bot.js            the run: collect → decide → act
sources.js        the three sites (HTTP, headless Chrome)
rules.js          captcha prompt, digest text (pure, tested)
test.js           tests for rules.js           kit.test.js   tests for kit.js
kit.js            shared kit: config, log, store, model sharing, WhatsApp, run, scheduler
config.json       public settings              .env.example  personal values template
pii-check.sh      personal-data gate before a commit: bash pii-check.sh && git commit ...
run-now.command   double-click = npm start     package.json  npm start · test · login · schedule · unschedule
data/             (gitignored) bot.db state · bot.log log · run.out scheduler · pgrs-last.html last result page
```

## When something goes wrong

A failure shows a macOS notification. Details: `data/bot.log` (each step, `FAILED during …` with the error) and
`data/run.out` (each scheduled try and its exit code). `npm test` checks the rules and the kit.

## License

MIT
