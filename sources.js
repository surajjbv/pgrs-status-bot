// The three sites. Each returns { short, status, history[] } (history oldest first). `read(img, len)` reads a captcha.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { clip, nice, who } from './rules.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with a cookie jar (IPGRS ties its captcha to the session); `form` makes it an XHR-style POST. */
function session() {
  const jar = new Map();
  return async (url, form) => {
    const r = await fetch(url, {
      method: form ? 'POST' : 'GET', body: form && new URLSearchParams(form), signal: AbortSignal.timeout(60000),
      headers: { 'user-agent': UA, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(form && { 'x-requested-with': 'XMLHttpRequest' }) },
    });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0], i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
    if (!r.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${r.status}`);
    return r;
  };
}

/** Karnataka IPGRS: captcha + registered mobile, JSON API. */
export async function ipgrs({ env, cfg, read }) {
  const H = 'https://ipgrs.karnataka.gov.in', id = env.IPGRS_ID, s = session();
  await s(`${H}/Grievance/GetGrievanceStatus?grievanceId=${id}`);
  let d, last = 'captcha not read';
  for (let i = 0; i < cfg.captchaTries && !d; i++) { // a wrong read just costs a new captcha
    const cap = await read(Buffer.from(await (await s(`${H}/Home/GetGrievanceStatusCaptchaImage?t=${Date.now()}`)).arrayBuffer()), 5);
    if (!cap) continue;
    const r = await (await s(`${H}/Grievance/VerifyGrievanceStatus`, { GrievanceId: id, MobileOrEmail: env.IPGRS_MOBILE, Captcha: cap })).json();
    if (r.success) d = r.data; else last = r.message;
  }
  if (!d) throw new Error(`not accepted after ${cfg.captchaTries} tries: ${last}`);
  const hist = (await (await s(`${H}/Grievance/GetGrievanceStatusHistory`, { GrievanceId: id })).json()).data ?? [];
  return {
    short: nice(d.Status),
    status: `${d.Status}${d.PendencyDetails ? ` — pending with ${d.PendencyDetails}` : ''}`,
    history: hist.map((h) => `${h.When}: ${h.Description}${h.Remarks ? ` — “${clip(h.Remarks)}”` : ''}`),
  };
}

/** AP PGRS: an ASP.NET postback that only works from a real browser page. */
export async function pgrs({ env, cfg, log, read }) {
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
      const cap = await read(shot, 6);
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

/** AP eMunicipal property tax: public JSON API, no captcha. */
export async function emunicipal({ env }) {
  const A = 'https://emunicipal.ap.gov.in/apiv1', ulb = env.EMUN_ULB_ID, app = env.EMUN_APP;
  const get = async (p) => {
    const r = await fetch(A + p, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return (await r.json()).data;
  };
  const row = (await get(`/common/search-application?${new URLSearchParams({ ulbId: ulb, moduleName: 'Property Tax', applicationNumber: app })}`))?.rows?.[0];
  if (!row) throw new Error(`application ${app} not found`);
  const wf = (await get(`/property-tax/workflow-history-by-application/${ulb}/${encodeURIComponent(app)}`)) ?? []; // newest first
  return {
    short: nice(row.status),
    status: `${row.status}${wf[0]?.nextaction ? ` — next: ${wf[0].nextaction}` : ''}${row.owner_name ? ` (with ${row.owner_name})` : ''}`,
    history: wf.toReversed().map((w) => `${w.date_txt}: ${w.status} by ${who(w.updated_by)}${w.comments ? ` — “${clip(w.comments)}”` : ''}`),
  };
}
