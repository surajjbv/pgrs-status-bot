// AP PGRS: an ASP.NET postback that only works from a real browser page.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { clip, nice } from '../rules.js';
import { readCaptcha } from './captcha.js';
import { sleep, UA } from './http.js';

export async function pgrs({ env, cfg, log }) {
  let browser, page;
  try {
    // After one wrong captcha the site answers HTTP 500 to everything else from that browser
    // (even new private windows), so every try starts a new Chrome.
    const openForm = async () => { // the way a person gets there: home page, then "Check grievance status"
      await browser?.close().catch(() => {});
      browser = await puppeteer.launch({ headless: true, executablePath: cfg.chromePath, args: ['--no-first-run'] });
      page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 }); // sharper captcha screenshot for the model
      await page.goto('https://pgrs.ap.gov.in/', { waitUntil: 'load', timeout: 60000 });
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('a[href$="ApplicationStatus.aspx"]')]);
    };
    let ok = false, last = 'captcha not read';
    for (let i = 0; i < cfg.captchaTries && !ok; i++) {
      await openForm();
      const img = await page.waitForSelector('img[alt="Captcha"]', { timeout: 30000 });
      await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, { timeout: 30000 }, img);
      const shown = Date.now();
      const shot = await img.screenshot();
      const cap = await readCaptcha(shot, 6);
      if (cfg.debugCaptcha) fs.writeFileSync(path.join(cfg.data, `cap-${i}-${cap}.png`), shot);
      if (!cap) continue;
      await sleep(shown + 8000 - Date.now()); // the site answers HTTP 500 to forms sent within a few seconds of loading
      await page.$eval('#txtYsrNum', (el, v) => { el.value = v; }, env.PGRS_ID);
      await page.$eval('#txtCaptcha', (el, v) => { el.value = v; }, cap);
      const [res] = await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#btnGetAppDetails')]);
      const msg = await page.$eval('#lblCaptchaMessage', (el) => el.innerText.trim()).catch(() => '');
      if (cfg.debugCaptcha) log.info(`pgrs try ${i + 1}: read "${cap}" -> HTTP ${res?.status()} ${msg}`);
      if (res?.status() >= 400) last = `HTTP ${res.status()}`;
      else if (msg) last = msg;
      else ok = true;
    }
    if (!ok) throw new Error(`not accepted after ${cfg.captchaTries} tries: ${last}`);
    const html = await page.content();
    fs.writeFileSync(path.join(cfg.data, 'pgrs-last.html'), html); // for checking the layout if parsing ever breaks
    // Detail values sit in an inline script ($("#id").text('…')) that the site fails to run; read them from there.
    const f = Object.fromEntries([...html.matchAll(/\$\("#(\w+)"\)\.(?:text|html|append)\((['"])(.*?)\2\)/g)].map((m) => [m[1], m[3].trim()]));
    if (!f.grievanceStatus) throw new Error('no status on the result page (layout changed? see data/pgrs-last.html)');
    const history = await page.$$eval('.timeline-content', (els) => els.map((el) => {
      const t = (s) => s.replace(/\s+/g, ' ').trim();
      const part = (k) => t([...el.querySelectorAll('p')].find((p) => p.innerText.trim().startsWith(k))?.innerText.replace(/^[^:]*:/, '') ?? '');
      const note = [...el.querySelectorAll('.timeline_content p')].map((p) => t(p.innerText)).find((x) => !/^(From|To|Action)\s*:/.test(x)) ?? '';
      return { date: t(el.querySelector('.timeline_bottom')?.innerText.replace(/Download Document/, '').replace(/^Date\s*:/, '') ?? ''), from: part('From'), to: part('To'), action: part('Action'), note };
    }));
    const when = (d) => { const m = d.match(/(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+) ([AP]M)/); return m ? Date.UTC(m[3], m[2] - 1, m[1], (m[4] % 12) + (m[7] === 'PM' ? 12 : 0), m[5], m[6]) : 0; };
    history.sort((x, y) => when(x.date) - when(y.date));
    const latest = history.at(-1);
    return {
      short: nice(f.grievanceStatus),
      status: `${f.grievanceStatus}${latest?.to ? ` — with ${latest.to}` : ''}`,
      history: history.map((h) => `${h.date}: ${h.action}${h.to ? ` → ${h.to}` : ''}${h.note ? ` — “${clip(h.note)}”` : ''}`),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
