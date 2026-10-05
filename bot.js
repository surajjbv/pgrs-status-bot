// Checks 3 government application statuses and posts one digest per run time to a WhatsApp group.
// Captchas are read by the local model (kit/llm.js), so it runs unattended.
//   npm start            check all, send to WhatsApp, remember what was sent
//   npm run dry          check all, print the message only (nothing sent or saved)
//   npm run login        link WhatsApp once (scan the QR from the phone)
//   add -- --only=ipgrs,emunicipal to check just those sites
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './kit/config.js';
import * as llm from './kit/llm.js';
import { runBot } from './kit/run.js';
import { openWhatsApp } from './kit/whatsapp.js';
import { digest } from './rules.js';
import * as captcha from './sources/captcha.js';
import { emunicipal } from './sources/emunicipal.js';
import { ipgrs } from './sources/ipgrs.js';
import { pgrs } from './sources/pgrs.js';

const SITES = (env) => [
  { key: 'ipgrs', title: env.IPGRS_TITLE || 'KA Grievance', run: ipgrs, captcha: true, url: `https://ipgrs.karnataka.gov.in/Grievance/GetGrievanceStatus?grievanceId=${env.IPGRS_ID}` },
  { key: 'pgrs', title: env.PGRS_TITLE || 'AP Grievance', run: pgrs, captcha: true, url: 'https://pgrs.ap.gov.in/ApplicationStatus.aspx' },
  { key: 'emunicipal', title: env.EMUN_TITLE || 'Property Tax', run: emunicipal, captcha: false, url: 'https://emunicipal.ap.gov.in/services/property-tax/application-status' },
];

runBot({
  name: 'pgrs-status-bot',
  root: import.meta.dirname,
  defaults: {
    runTimes: ['10:00', '20:00'],
    whatsappDir: 'data', // folder holding wa-auth/: another bot's data folder to share its WhatsApp login
    captchaTries: 8, // per site; a wrong read just costs a new captcha
    debugCaptcha: false, // save each captcha with the model's reading in data/
  },
  env: ['GROUP_NAME', 'IPGRS_ID', 'IPGRS_MOBILE', 'PGRS_ID', 'EMUN_ULB_ID', 'EMUN_APP'],
  optionalEnv: ['IPGRS_TITLE', 'PGRS_TITLE', 'EMUN_TITLE'],
  importJson: (state, store) => { for (const [key, result] of Object.entries(state)) store.set(`site:${key}`, result); },
  async main({ cfg, env, store, log, dry, args }) {
    const waDir = path.resolve(cfg.root, expandHome(cfg.whatsappDir));
    const whatsapp = (login = false) => openWhatsApp({ dir: waDir, chromePath: cfg.chromePath, log, login });
    if (args.includes('--login')) {
      const wa = await whatsapp(true);
      try { await wa.findGroup(env.GROUP_NAME); log.done(`linked; group "${env.GROUP_NAME}" found`); } finally { await wa.close(); }
      return;
    }
    if (!dry && !fs.existsSync(path.join(waDir, 'wa-auth'))) throw new Error('WhatsApp not linked yet: run `npm run login`');
    const oldSlotFile = path.join(cfg.data, 'sent-slot'); // the slot the old scheduler last sent
    if (fs.existsSync(oldSlotFile)) { store.set('sentSlot', fs.readFileSync(oldSlotFile, 'utf8').trim()); if (!dry) fs.rmSync(oldSlotFile); }
    const slot = process.env.BOT_SLOT; // set by kit/schedule.sh
    if (slot && store.get('sentSlot') === slot) return log.info(`already sent for ${slot}`);

    // collect
    const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
    const sites = SITES(env).filter((s) => !only || only.includes(s.key));
    if (sites.some((s) => s.captcha)) await llm.acquire(); // no model now: retry the whole run later (exit 75)
    const results = {};
    for (const site of sites) {
      try {
        results[site.key] = await site.run({ env, cfg, log });
        log.info(`${site.key}: ${results[site.key].status}`);
      } catch (err) {
        if (err instanceof llm.ModelBusy) throw err;
        results[site.key] = { error: err.message };
        log.warn(`${site.key}: FAILED ${err.message}`);
      }
    }
    llm.release(); // free the memory before WhatsApp starts its browser

    // decide
    const prev = Object.fromEntries(sites.map((s) => [s.key, store.get(`site:${s.key}`)]));
    const text = digest(sites, prev, results, captcha.used ? llm.label(cfg.model) : null, cfg.timezone);
    log.box(dry ? 'would send' : `sending to "${env.GROUP_NAME}"`, text);
    if (dry) return;

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
