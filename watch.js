// Checks 3 government application statuses and posts one digest a day to a WhatsApp group.
// Captchas are read by a local vision model (Gemma in LM Studio), so it runs unattended.
//   node watch.js           check all, send to WhatsApp, remember what was seen
//   node watch.js --dry     check all, print the message only (nothing sent or saved)
//   node watch.js --login   link WhatsApp once (scan the QR from the phone)
//   add --only=ipgrs,emunicipal to check just those sites
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import qrcode from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';

// ── config (.env) ─────────────────────────────────────────────────────────
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'state.json');
fs.mkdirSync(DATA, { recursive: true });
process.loadEnvFile(path.join(ROOT, '.env'));
const E = process.env;
const CHROME = E.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TRIES = 8; // captcha attempts per site (a wrong read just costs a new captcha)
const args = process.argv.slice(2);
const log = (...m) => console.log(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 280) => (s = String(s ?? '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;
const nice = (s) => { s = String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim(); return s[0]?.toUpperCase() + s.slice(1); }; // 'InProcess' -> 'In process'
const who = (s) => String(s ?? '').replace(/^[^:]*::/, ''); // '1234567::A B NAME' -> 'A B NAME'

// ── local vision model (LM Studio) ─────────────────────────────────────────
// Reuses the model if it is already loaded; otherwise loads it and unloads it on exit.
const LMS = path.join(os.homedir(), '.lmstudio/bin/lms');
const MODEL_KEY = E.MODEL || 'gemma-4-26b-a4b-it-qat-mlx';
let modelId = null, ownModel = false;
const lms = (...a) => execFileSync(LMS, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
class LowMemory extends Error {}
// Loads only if macOS reports normal memory pressure and enough free RAM for the model plus 4 GB headroom.
function checkMemory() {
  lms('server', 'start');
  if (JSON.parse(lms('ps', '--json')).some((m) => m.modelKey === MODEL_KEY || m.path === MODEL_KEY)) return; // already in RAM
  const needGB = (JSON.parse(lms('ls', '--json')).find((m) => m.modelKey === MODEL_KEY || m.path === MODEL_KEY)?.sizeBytes ?? 16 * 2 ** 30) / 2 ** 30 + 4;
  const pressure = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' })); // 1 = normal
  const freePct = Number(execFileSync('memory_pressure', ['-Q'], { encoding: 'utf8' }).match(/free percentage: (\d+)/)?.[1] ?? 0);
  const freeGB = (os.totalmem() / 2 ** 30) * (freePct / 100);
  log(`RAM: ${freeGB.toFixed(1)} GB free (${freePct}%), pressure ${pressure === 1 ? 'normal' : 'HIGH'}; model needs ${needGB.toFixed(1)} GB`);
  if (pressure !== 1 || freeGB < needGB) throw new LowMemory(`not enough free RAM for ${MODEL_KEY} (${freeGB.toFixed(1)} of ${needGB.toFixed(1)} GB): will retry later`);
}
function ensureModel() {
  if (modelId) return modelId;
  lms('server', 'start');
  const loaded = JSON.parse(lms('ps', '--json')).find((m) => m.modelKey === MODEL_KEY || m.path === MODEL_KEY);
  if (loaded) return (modelId = loaded.identifier);
  log(`loading ${MODEL_KEY}…`);
  lms('load', MODEL_KEY, '--identifier', 'pgrs-status-bot', '--context-length', '4096', '-y');
  ownModel = true;
  return (modelId = 'pgrs-status-bot');
}
function releaseModel() {
  if (ownModel) try { lms('unload', modelId); } catch { /* already gone */ }
  ownModel = false; modelId = null;
}
process.on('exit', releaseModel);

/** The captcha text, or null if the model didn't return exactly `len` letters/digits. */
async function readCaptcha(img, len) {
  const mime = img[0] === 0xff ? 'image/jpeg' : 'image/png';
  const r = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: ensureModel(), temperature: 0, max_tokens: 20, messages: [{ role: 'user', content: [
      { type: 'text', text: `Read the ${len} characters in this captcha image, left to right. It is case-sensitive: keep each letter's upper or lower case exactly as drawn. Letters may overlap, be distorted, or be partly cut off at the edges; work out each one from the visible strokes. Ignore the dots and noise. Reply with only those ${len} characters, no spaces.` },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${img.toString('base64')}` } }] }] }),
  });
  const code = ((await r.json()).choices?.[0]?.message?.content ?? '').replace(/[^A-Za-z0-9]/g, '');
  return code.length === len ? code : null;
}

/** fetch with a cookie jar (site sessions tie the captcha to the cookie). */
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

// ── sites: each returns { status, history[] } (history oldest first) ─────
async function ipgrs() { // Karnataka IPGRS: captcha + registered mobile, JSON API
  const H = 'https://ipgrs.karnataka.gov.in', id = E.IPGRS_ID, s = session();
  await s(`${H}/Grievance/GetGrievanceStatus?grievanceId=${id}`);
  let d, last = 'captcha not read';
  for (let i = 0; i < TRIES && !d; i++) {
    const cap = await readCaptcha(Buffer.from(await (await s(`${H}/Home/GetGrievanceStatusCaptchaImage?t=${Date.now()}`)).arrayBuffer()), 5);
    if (!cap) continue;
    const r = await (await s(`${H}/Grievance/VerifyGrievanceStatus`, { GrievanceId: id, MobileOrEmail: E.IPGRS_MOBILE, Captcha: cap })).json();
    if (r.success) d = r.data; else last = r.message;
  }
  if (!d) throw new Error(`not accepted after ${TRIES} tries: ${last}`);
  const hist = (await (await s(`${H}/Grievance/GetGrievanceStatusHistory`, { GrievanceId: id })).json()).data ?? [];
  return {
    short: nice(d.Status),
    status: `${d.Status}${d.PendencyDetails ? ` — pending with ${d.PendencyDetails}` : ''}`,
    history: hist.map((h) => `${h.When}: ${h.Description}${h.Remarks ? ` — “${clip(h.Remarks)}”` : ''}`),
  };
}

async function pgrs() { // AP PGRS: ASP.NET postback that only works from a real browser page
  let browser, page;
  try {
    // After one wrong captcha the site answers HTTP 500 to everything else from that browser
    // (even new private windows), so every try starts a new Chrome.
    const openForm = async () => { // the way a person gets there: home page, then "Check grievance status"
      await browser?.close().catch(() => {});
      browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-first-run'] });
      page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 }); // sharper captcha screenshot for the model
      await page.goto('https://pgrs.ap.gov.in/', { waitUntil: 'load', timeout: 60000 });
      await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('a[href$="ApplicationStatus.aspx"]')]);
    };
    let ok = false, last = 'captcha not read';
    for (let i = 0; i < TRIES && !ok; i++) {
      await openForm();
      const img = await page.waitForSelector('img[alt="Captcha"]', { timeout: 30000 });
      await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, { timeout: 30000 }, img);
      const shown = Date.now();
      const shot = await img.screenshot();
      const cap = await readCaptcha(shot, 6);
      if (E.DEBUG_CAPTCHA) fs.writeFileSync(path.join(DATA, `cap-${i}-${cap}.png`), shot);
      if (!cap) continue;
      await sleep(shown + 8000 - Date.now()); // the site answers HTTP 500 to forms sent within a few seconds of loading
      await page.$eval('#txtYsrNum', (el, v) => { el.value = v; }, E.PGRS_ID);
      await page.$eval('#txtCaptcha', (el, v) => { el.value = v; }, cap);
      const [res] = await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }), page.click('#btnGetAppDetails')]);
      const msg = await page.$eval('#lblCaptchaMessage', (el) => el.innerText.trim()).catch(() => '');
      if (E.DEBUG_CAPTCHA) log(`pgrs try ${i + 1}: read "${cap}" -> HTTP ${res?.status()} ${msg}`);
      if (res?.status() >= 400) last = `HTTP ${res.status()}`;
      else if (msg) last = msg;
      else ok = true;
    }
    if (!ok) throw new Error(`not accepted after ${TRIES} tries: ${last}`);
    fs.writeFileSync(path.join(DATA, 'pgrs-last.html'), await page.content()); // for checking the layout if parsing ever breaks
    // Detail values sit in an inline script ($("#id").text('…')) that the site fails to run; read them from there.
    const html = await page.content();
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

async function emunicipal() { // AP eMunicipal property tax: public JSON API, no captcha
  const A = 'https://emunicipal.ap.gov.in/apiv1', ulb = E.EMUN_ULB_ID, app = E.EMUN_APP;
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

const SITES = [
  { key: 'ipgrs', title: E.IPGRS_TITLE || 'KA Grievance', run: ipgrs, url: `https://ipgrs.karnataka.gov.in/Grievance/GetGrievanceStatus?grievanceId=${E.IPGRS_ID}` },
  { key: 'pgrs', title: E.PGRS_TITLE || 'AP Grievance', run: pgrs, url: 'https://pgrs.ap.gov.in/ApplicationStatus.aspx' },
  { key: 'emunicipal', title: E.EMUN_TITLE || 'Property Tax', run: emunicipal, url: 'https://emunicipal.ap.gov.in/services/property-tax/application-status' },
];

// ── WhatsApp ──────────────────────────────────────────────────────────────
// Shares the WhatsApp login of another local bot (WA_SHARE_DIR: that bot's data dir, holding wa-auth/) when set.
// Only one Chrome may use that login at a time, and both bots load the same big model, so a run holds
// the other bot's lock dir from start to end; whichever comes second waits.
const WA = E.WA_SHARE_DIR || DATA;
const LOCK = path.join(WA, 'state', 'lock');
let haveLock = false;
const chromeBusy = () => { // Chrome's own profile lock: 'host-pid' symlink while that Chrome runs
  try { const pid = Number(fs.readlinkSync(path.join(WA, 'wa-auth/session/SingletonLock')).split('-').pop()); process.kill(pid, 0); return true; } catch { return false; }
};
async function lockWhatsApp() {
  if (haveLock) return;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (const end = Date.now() + 45 * 60000; ; await sleep(20000)) {
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30 * 60000) fs.rmdirSync(LOCK); } catch { /* no lock */ } // left by a crash
    if (!chromeBusy()) try { fs.mkdirSync(LOCK); haveLock = true; return; } catch { /* other bot is using WhatsApp */ }
    if (Date.now() > end) throw new Error('WhatsApp stayed busy (other bot) for 45 min');
    log('the other bot is running, waiting…');
  }
}
process.on('exit', () => { if (haveLock) try { fs.rmdirSync(LOCK); } catch { /* gone */ } });

async function openWhatsApp(login = false) {
  await lockWhatsApp();
  const client = new wweb.Client({
    authStrategy: new wweb.LocalAuth({ dataPath: path.join(WA, 'wa-auth') }),
    webVersionCache: { type: 'local', path: path.join(WA, 'wa-cache') },
    puppeteer: { headless: true, executablePath: CHROME, args: ['--no-first-run'] },
  });
  try {
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('WhatsApp not ready in 10 min (phone offline?)')), 600000);
      const stop = (err) => { clearTimeout(timer); fail(err); };
      client.on('qr', (qr) => (login ? qrcode.generate(qr, { small: true }) : stop(new Error('WhatsApp is unlinked: run `npm run login`'))));
      client.on('auth_failure', (m) => stop(new Error(`WhatsApp auth failed: ${m}`)));
      client.on('ready', () => { clearTimeout(timer); ok(); });
      client.initialize().catch(stop);
    });
  } catch (err) {
    await client.destroy().catch(() => {});
    throw err;
  }
  return client;
}

async function findGroup(client) {
  const want = E.GROUP_NAME.trim().toLowerCase();
  const groups = (await client.getChats()).filter((c) => c.isGroup && c.name?.trim().toLowerCase() === want);
  if (groups.length !== 1) throw new Error(`WhatsApp: expected 1 group named "${E.GROUP_NAME}", found ${groups.length}`);
  return groups[0].id._serialized;
}

async function sendWhatsApp(text) {
  const client = await openWhatsApp();
  try {
    const msg = await client.sendMessage(await findGroup(client), text, { linkPreview: false });
    // sendMessage only queues it; wait until WhatsApp's server has it before closing the browser.
    let ack = msg.ack;
    for (const end = Date.now() + 60000; ack < 1 && Date.now() < end; await sleep(500)) ack = (await client.getMessageById(msg.id._serialized))?.ack ?? ack;
    if (ack < 1) throw new Error('WhatsApp did not confirm the message within 60 s');
    log(`sent to "${E.GROUP_NAME}"`);
  } finally {
    await client.destroy().catch(() => {});
  }
}

// ── digest ────────────────────────────────────────────────────────────────
// A history line in brief: short date, no comments. '30/09/2026 12:32:41: X by Y — “…”' -> '30 Sep: X by Y'
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function brief(h) {
  const m = h.match(/^(.*?\d{1,2}:\d{2}(?::\d{2})?(?: [AP]M)?): (.*)$/);
  if (!m) return clip(h, 90);
  const d = m[1].match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{4}/), w = m[1].match(/^(\d{1,2} \w{3})/);
  const day = d ? `${+d[1]} ${MON[d[2] - 1]}` : w ? w[1] : m[1];
  const what = m[2].replace(/ — “.*$/, '').replace(/^Grievance has been /i, '');
  return clip(`${day}: ${what[0].toUpperCase()}${what.slice(1)}`, 90);
}

// One line per site; a changed site adds what changed and its link, so it reads in seconds.
function section(site, prev, r) {
  if (r.error) return `⚠️ *${site.title}* — couldn't check today`;
  const short = r.short ?? r.status;
  const fresh = prev ? r.history.filter((h) => !prev.history.includes(h)) : [];
  const latest = r.history.length ? `\n   ↳ ${brief(r.history.at(-1))}` : '';
  if (!prev || (!fresh.length && prev.status === r.status)) return `✅ *${site.title}* — ${short}${latest}`;
  const was = prev.short ?? prev.status;
  const out = [`🔔 *${site.title}* — ${was !== short ? `${was} → ${short}` : short}`];
  if (fresh.length) out.push(`   ↳ ${brief(fresh.at(-1))}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`);
  out.push(`   ${site.url}`);
  return out.join('\n');
}

async function main() {
  for (const k of ['GROUP_NAME', 'IPGRS_ID', 'IPGRS_MOBILE', 'PGRS_ID', 'EMUN_ULB_ID', 'EMUN_APP']) if (!E[k]) throw new Error(`Missing ${k} in .env`);
  if (args.includes('--login')) {
    log('WhatsApp > Settings > Linked devices > Link a device, then scan:');
    const client = await openWhatsApp(true);
    try { await findGroup(client); log(`linked; group "${E.GROUP_NAME}" found`); } finally { await client.destroy().catch(() => {}); }
    return;
  }
  if (!args.includes('--dry') && !fs.existsSync(path.join(WA, 'wa-auth'))) throw new Error('WhatsApp not linked yet: run `npm run login`');
  await lockWhatsApp();
  const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const sites = only ? SITES.filter((s) => only.includes(s.key)) : SITES;
  if (sites.some((s) => s.key !== 'emunicipal')) checkMemory(); // captcha sites need the model
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const results = {};
  for (const site of sites) {
    try {
      results[site.key] = await site.run();
      log(`${site.key}: ${results[site.key].status}`);
    } catch (err) {
      results[site.key] = { error: err.message };
      log(`${site.key}: FAILED ${err.message}`);
    }
  }
  releaseModel(); // free memory before WhatsApp starts its browser
  const day = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
  const text = [`*Application status · ${day}*`, ...sites.map((s) => section(s, state[s.key], results[s.key]))].join('\n');
  console.log(`\n${text}\n`);
  if (args.includes('--dry')) return;
  await sendWhatsApp(text);
  for (const s of sites) if (!results[s.key].error) state[s.key] = results[s.key];
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}

main().then(() => process.exit(0), (err) => {
  log(`FAILED: ${err.message}`);
  if (err instanceof LowMemory) process.exit(1); // routine: the scheduler retries, no popup
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(clip(err.message, 150))} with title "pgrs-status-bot failed"`]); } catch { /* no GUI */ }
  process.exit(1);
});
