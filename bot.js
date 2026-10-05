// pgrs-status-bot: checks 3 government application statuses and posts one digest per run time to a WhatsApp group.
// Captchas are read by the local model, so it runs unattended.
//   npm start · npm run login (link WhatsApp once) · npm start -- --only=ipgrs,emunicipal
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, llm, ModelBusy, openWhatsApp, ROOT, runBot } from './kit.js';
import { digest, readCaptcha } from './rules.js';
import { emunicipal, ipgrs, pgrs } from './sources.js';

const SITES = (env) => [
  { key: 'ipgrs', title: env.IPGRS_TITLE || 'KA Grievance', run: ipgrs, captcha: true, url: `https://ipgrs.karnataka.gov.in/Grievance/GetGrievanceStatus?grievanceId=${env.IPGRS_ID}` },
  { key: 'pgrs', title: env.PGRS_TITLE || 'AP Grievance', run: pgrs, captcha: true, url: 'https://pgrs.ap.gov.in/ApplicationStatus.aspx' },
  { key: 'emunicipal', title: env.EMUN_TITLE || 'Property Tax', run: emunicipal, captcha: false, url: 'https://emunicipal.ap.gov.in/services/property-tax/application-status' },
];

runBot({
  name: 'pgrs-status-bot',
  defaults: {
    runTimes: ['10:00', '20:00'],
    whatsappDir: 'data', // folder holding wa-auth/ (the linked WhatsApp login); can be shared with other bots
    captchaTries: 8, // per site; a wrong read just costs a new captcha
    debugCaptcha: false, // save each captcha with the model's reading in data/
  },
  env: ['GROUP_NAME', 'IPGRS_ID', 'IPGRS_MOBILE', 'PGRS_ID', 'EMUN_ULB_ID', 'EMUN_APP'],
  optionalEnv: ['IPGRS_TITLE', 'PGRS_TITLE', 'EMUN_TITLE'],
  importJson: (state, store) => { for (const [key, result] of Object.entries(state)) store.set(`site:${key}`, result); },
  async main({ cfg, env, store, log, args }) {
    const waDir = path.resolve(ROOT, expandHome(cfg.whatsappDir));
    const whatsapp = (login = false) => openWhatsApp({ dir: waDir, chromePath: cfg.chromePath, login });
    if (args.includes('--login')) {
      const wa = await whatsapp(true);
      try { await wa.findGroup(env.GROUP_NAME); log.done(`linked; group "${env.GROUP_NAME}" found`); } finally { await wa.close(); }
      return;
    }
    if (!fs.existsSync(path.join(waDir, 'wa-auth'))) throw new Error('WhatsApp not linked yet: run `npm run login`');
    const slot = process.env.BOT_SLOT; // set by the scheduler
    if (slot && store.get('sentSlot') === slot) return log.info(`already sent for ${slot}`);

    // collect: all sites at once (the model takes 2 requests in parallel); one failing site doesn't stop the others
    const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
    const sites = SITES(env).filter((s) => !only || only.includes(s.key));
    if (sites.some((s) => s.captcha)) await llm.acquire(); // no model now: retry the whole run later (exit 75)
    const read = (img, len) => readCaptcha(img, len, llm.ask);
    const results = Object.fromEntries(await Promise.all(sites.map(async (site) => {
      try {
        const r = await site.run({ env, cfg, log, read });
        log.info(`${site.key}: ${r.status}`);
        return [site.key, r];
      } catch (err) {
        if (err instanceof ModelBusy) throw err;
        log.warn(`${site.key}: FAILED ${err.message}`);
        return [site.key, { error: err.message }];
      }
    })));
    llm.release(); // free the memory before WhatsApp starts its browser

    // decide
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
