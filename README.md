<h1 align="center">🏛️ PGRS Status Bot</h1>

<p align="center">
  <b>Government grievances move slowly, and every portal hides the status behind a captcha.<br>
  This bot checks them for you and sends one short WhatsApp every evening.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Runs%20on-your%20Mac-2FCF5C?style=for-the-badge" alt="Runs on your Mac">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Free-no%20subscriptions-F7C21A?style=flat-square" alt="Free">
  <img src="https://img.shields.io/badge/Local%20AI-reads%20the%20captchas-8E7CC3?style=flat-square" alt="Local AI">
  <img src="https://img.shields.io/badge/WhatsApp-digest-25D366?style=flat-square" alt="WhatsApp digest">
  <img src="https://img.shields.io/badge/Hands--free-daily%20at%2020%3A00-4FB3E8?style=flat-square" alt="Hands-free">
</p>

<p align="center">
  <img src="docs/digest.png" width="360" alt="The WhatsApp digest">
</p>
<p align="center"><sub>The digest in the family group (sample data): ✅ no change · 🔔 something moved, with a link</sub></p>

## 💡 Why

A complaint to a government office can take weeks, and the only way to know is to open each portal, type the
reference number, solve a captcha and read a long history table. Doing that for three applications every day is
nobody's favourite job, so this bot does it and tells the family only what changed.

## ⚙️ How it works

<table>
  <tr>
    <td align="center" width="33%"><h3>🔎</h3><b>Checks the portals</b><br><sub>Karnataka IPGRS, AP PGRS and AP eMunicipal, all at once, every evening at 20:00</sub></td>
    <td align="center" width="33%"><h3>🧠</h3><b>Solves the captchas</b><br><sub>A local AI model reads each captcha; a wrong guess just tries again</sub></td>
    <td align="center" width="33%"><h3>💬</h3><b>One short WhatsApp</b><br><sub>Each application with its number, newest update and a short link; 🔔 marks a change. Below: each update in full</sub></td>
  </tr>
</table>

If the Mac was asleep at send time, it sends 10 minutes after it wakes. A send time is never sent twice.

The message has two parts. The top is a short summary: for each application its number, status, newest update and
a short link (TinyURL, because WhatsApp can't link words) that opens its status page. Below it, **📋 Details**
gives each application's newest update in full, with the date, action, officer and remarks as the site wrote them,
for anyone who wants to read more.

## 🚀 Set it up

<table>
  <tr>
    <td align="center" width="33%"><b>1 · Fill in</b><br><sub>Copy <code>.env.example</code> to <code>.env</code>: your WhatsApp group and the applications to check</sub></td>
    <td align="center" width="33%"><b>2 · Link WhatsApp</b><br><sub><code>npm run login</code> and scan the QR (WhatsApp › Linked devices)</sub></td>
    <td align="center" width="33%"><b>3 · Switch it on</b><br><sub><code>npm run schedule</code>. To send right now: double-click <code>run-now.command</code></sub></td>
  </tr>
</table>

**Your applications** are groups of keys in `.env`: `IPGRS_…` (Karnataka), `PGRS_…` (AP) and `EMUN_…` (property
tax). Each group has the application number plus, optionally, `_TITLE` (name in the message), `_URL` (the link) and
`_ENABLED=false` to pause it. To track a second one of the same kind, add a number to the prefix: `IPGRS2_ID`,
`IPGRS2_MOBILE`, and so on. `.env.example` shows all of these.

Needs a Mac with Node 24+, Google Chrome and [LM Studio](https://lmstudio.ai) with Qwen3.8 27B.

## 🔒 Private by design

Your numbers and group name stay in `.env` on your Mac and are never committed. The AI runs on the Mac; only the
status lookups, the WhatsApp message and the links leave it. Each status-page link is shortened by tinyurl.com
once (the Karnataka link includes the grievance number) and then reused; set `"shortLinks": false` in
`config.json` to send full links instead.

<details>
<summary><b>🛠️ For developers</b></summary>

<br>

<p>
  <img src="https://img.shields.io/badge/Node-24-339933?style=flat-square" alt="Node 24">
  <img src="https://img.shields.io/badge/LM%20Studio-Qwen3.8%2027B-5A0FC8?style=flat-square" alt="LM Studio">
  <img src="https://img.shields.io/badge/whatsapp--web.js-headless%20Chrome-25D366?style=flat-square" alt="whatsapp-web.js">
</p>

- **Records** come from `.env` keys `<IPGRS|PGRS|EMUN>[n]_<FIELD>` (`records()` in rules.js: required fields,
  TITLE/URL/ENABLED, unknown keys are a config error). The key (`ipgrs`, `ipgrs2`, …) names the saved last result;
  `--only=<keys>` checks just those, even if disabled.
- **One run = collect → decide → act.** Collect: IPGRS (JSON API, 5-character captcha), PGRS (headless Chrome, a
  new one per try, an 8 s wait before submitting, case-sensitive 6-character captcha), eMunicipal (public JSON
  API), in parallel; up to `captchaTries` per site. Decide: compare with the last sent result. Act: send, then save.
- **The model** is shared with the other bots through a lease protocol (`kit.js`): loaded once, reused, unloaded by
  the last one out; LM Studio's memory guardrail stays on. If it can't be had, the run exits 75 and is retried.
  Captchas are read as plain text (measured more accurate than a JSON schema on Qwen3.8).
- **WhatsApp** is one linked login shared with school-reminder-bot (`whatsappDir`: `~/.local/state/whatsapp`); the
  bots take turns via a lock. It's released before WhatsApp starts Chrome.
- **Scheduling:** launchd runs `node kit.js tick` every 5 min: once per `runTimes` slot, 10 min after boot/wake,
  retries after 5 min ×3 then every 30 min, skips slots older than 10 h.

```
bot.js            the run: collect → decide → act
sources.js        the three sites (HTTP, headless Chrome); each returns status, history and the newest update in full
rules.js          records from .env, captcha prompt, digest text with details (pure, tested)
kit.js            shared kit: config, log, store, model sharing, WhatsApp, run, scheduler
test.js · kit.test.js       npm test
config.json       public settings (runTimes, timezone, whatsappDir, captchaTries, debugCaptcha, shortLinks, model)
.env.example      personal values template: group + records (.env is gitignored)
pii-check.sh      personal-data gate: bash pii-check.sh && git commit ...
run-now.command   double-click = npm start
data/             (gitignored) bot.db · bot.log · run.out · schedule.json · pgrs-last.html
```

**Commands:** `npm start` · `npm test` · `npm run login` · `npm run schedule` / `unschedule`.
**Code checks:** before committing run `npm run fix && npm run check && npm test` (Biome lint + format; GitHub CI runs the same on every push). A pre-commit hook runs these checks plus pii-check.sh automatically; turn it on once per clone with `git config core.hooksPath .githooks`.
**When something fails:** a macOS notification; details in `data/bot.log` (`FAILED during …`) and `data/run.out`.
**License:** MIT.

</details>
