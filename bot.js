// pgrs-status-bot: checks government application statuses (the records in .env) and posts one digest per run time
// to a WhatsApp group. Captchas are read by the local model, so it runs unattended.
//   npm start · npm run login (link WhatsApp once) · npm start -- --only=ipgrs,emunicipal (record keys)
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, expandHome, llm, ModelBusy, openWhatsApp, ROOT, runBot } from './kit.js';
import { digest, RECORD_KEY, readCaptcha, records } from './rules.js';
import { emunicipal, ipgrs, pgrs, shortLink } from './sources.js';

const RUN = { ipgrs, pgrs, emunicipal };
// The record keys in .env (IPGRS_ID, PGRS2_ENABLED, …), so the kit passes them on; rules.js checks their names.
const envFile = path.join(ROOT, '.env');
const recordEnv = fs.existsSync(envFile)
  ? [...fs.readFileSync(envFile, 'utf8').matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)]
      .map((m) => m[1])
      .filter((k) => RECORD_KEY.test(k))
  : [];

runBot({
  name: 'pgrs-status-bot',
  defaults: {
    runTimes: ['20:00'], // once a day, with school-reminder-bot's message
    whatsappDir: 'data', // folder holding wa-auth/ (the linked WhatsApp login); can be shared with other bots
    captchaTries: 8, // per site; a wrong read just costs a new captcha
    debugCaptcha: false, // save each captcha with the model's reading in data/
    shortLinks: true, // TinyURL links in the message (each URL is sent to tinyurl.com once); false: full links
  },
  env: ['GROUP_NAME'],
  optionalEnv: recordEnv,
  importJson: (state, store) => {
    for (const [key, result] of Object.entries(state)) store.set(`site:${key}`, result);
  },
  async main({ cfg, env, store, log, args }) {
    const waDir = path.resolve(ROOT, expandHome(cfg.whatsappDir));
    const whatsapp = (login = false) => openWhatsApp({ dir: waDir, chromePath: cfg.chromePath, login });
    if (args.includes('--login')) {
      const wa = await whatsapp(true);
      try {
        await wa.findGroup(env.GROUP_NAME);
        log.done(`linked; group "${env.GROUP_NAME}" found`);
      } finally {
        await wa.close();
      }
      return;
    }
    if (!fs.existsSync(path.join(waDir, 'wa-auth'))) throw new Error('WhatsApp not linked yet: run `npm run login`');
    const slot = process.env.BOT_SLOT; // set by the scheduler
    if (slot && store.get('sentSlot') === slot) return log.info(`already sent for ${slot}`);

    // collect: all enabled records at once (the model takes 2 requests in parallel); one failing doesn't stop the others
    const { list, problems } = records(env);
    if (problems.length) throw new ConfigError(`.env: ${problems.join('; ')} (see .env.example)`);
    const only = args
      .find((a) => a.startsWith('--only='))
      ?.slice(7)
      .split(',');
    const sites = list.filter((s) => (only ? only.includes(s.key) : s.enabled));
    const off = list.filter((s) => !s.enabled).map((s) => s.key);
    if (off.length && !only) log.info(`disabled in .env: ${off.join(', ')}`);
    if (!sites.length) throw new ConfigError('.env: no records to check (all disabled, or none set; see .env.example)');
    if (sites.some((s) => s.captcha)) await llm.acquire(); // no model now: retry the whole run later (exit 75)
    const read = (img, len) => readCaptcha(img, len, llm.ask);
    const results = Object.fromEntries(
      await Promise.all(
        sites.map(async (site) => {
          try {
            const r = await RUN[site.kind]({ rec: site.fields, cfg, log, read });
            log.info(`${site.key}: ${r.status}`);
            return [site.key, r];
          } catch (err) {
            if (err instanceof ModelBusy) throw err;
            log.warn(`${site.key}: FAILED ${err.message}`);
            return [site.key, { error: err.message }];
          }
        }),
      ),
    );
    llm.release(); // free the memory before WhatsApp starts its browser

    // decide: each record's link, shortened once and kept (a failed shortening is retried next run)
    if (cfg.shortLinks)
      for (const s of sites) {
        s.link = store.get(`link:${s.url}`) ?? (await shortLink(s.url));
        if (s.link) store.set(`link:${s.url}`, s.link);
        else log.warn(`${s.key}: no short link (TinyURL unreachable); sending the full one`);
      }
    const prev = Object.fromEntries(sites.map((s) => [s.key, store.get(`site:${s.key}`)]));
    const text = digest(sites, prev, results, llm.usage().calls ? llm.label(cfg.model) : null, cfg.timezone);
    log.box(`sending to "${env.GROUP_NAME}"`, text);

    // act
    const wa = await whatsapp();
    try {
      await wa.send(await wa.findGroup(env.GROUP_NAME), text);
      log.done(`sent to "${env.GROUP_NAME}"`);
    } finally {
      await wa.close();
    }
    for (const s of sites) if (!results[s.key].error) store.set(`site:${s.key}`, results[s.key]);
    if (slot) store.set('sentSlot', slot);
  },
});
