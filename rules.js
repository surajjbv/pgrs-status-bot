// Decisions and text, no I/O: the records to check (from .env), the captcha prompt, and the digest (one line per
// record with its number, latest update and link; a change adds what changed; then each latest update in full).
export const clip = (s, n = 280) => {
  s = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
export const nice = (s) => {
  s = String(s ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return s[0]?.toUpperCase() + s.slice(1);
}; // 'InProcess' -> 'In process'
export const who = (s) => String(s ?? '').replace(/^[^:]*::/, ''); // '1234567::A B NAME' -> 'A B NAME'

/**
 * The kinds of record. A record is a group of .env keys `<PREFIX>[n]_<FIELD>`, e.g. IPGRS_ID or IPGRS2_ID for a
 * second grievance. `need`: required fields; `number`: the one shown in the message (the application/grievance
 * number). Every kind also takes TITLE, URL (the link in the message) and ENABLED.
 */
export const KINDS = {
  ipgrs: {
    prefix: 'IPGRS',
    title: 'KA Grievance',
    need: ['ID', 'MOBILE'],
    number: 'ID',
    captcha: true,
    url: (f) => `https://ipgrs.karnataka.gov.in/Grievance/GetGrievanceStatus?grievanceId=${f.ID}`,
  },
  pgrs: {
    prefix: 'PGRS',
    title: 'AP Grievance',
    need: ['ID'],
    number: 'ID',
    captcha: true,
    url: () => 'https://pgrs.ap.gov.in/ApplicationStatus.aspx',
  },
  emunicipal: {
    prefix: 'EMUN',
    title: 'Property Tax',
    need: ['ULB_ID', 'APP'],
    number: 'APP',
    captcha: false,
    url: () => 'https://emunicipal.ap.gov.in/services/property-tax/application-status',
  },
};
const COMMON = ['TITLE', 'URL', 'ENABLED'];
export const RECORD_KEY = /^(IPGRS|PGRS|EMUN)(\d*)_([A-Z_]+)$/;

/**
 * The records in `env` (.env keys), in .env order: { key, kind, title, number, url, enabled, captcha, fields }, and the
 * problems (unknown setting, missing required field). `key` ('ipgrs', 'ipgrs2', …) names the saved last result.
 */
export function records(env) {
  const byPrefix = new Map(),
    problems = [];
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(RECORD_KEY);
    if (!m) continue;
    const [, prefix, n, field] = m;
    const kind = Object.keys(KINDS).find((x) => KINDS[x].prefix === prefix);
    if (![...KINDS[kind].need, ...COMMON].includes(field)) {
      problems.push(`${k}: unknown setting (${prefix} takes ${[...KINDS[kind].need, ...COMMON].join(', ')})`);
      continue;
    }
    if (!byPrefix.has(prefix + n)) byPrefix.set(prefix + n, { key: kind + n, kind, fields: {} });
    byPrefix.get(prefix + n).fields[field] = String(v ?? '').trim();
  }
  const list = [...byPrefix.entries()].map(([p, { key, kind, fields: f }]) => {
    const enabled = !/^(false|no|off|0)$/i.test(f.ENABLED ?? '');
    const missing = KINDS[kind].need.filter((x) => !f[x]);
    if (enabled && missing.length) problems.push(`${p}: missing ${missing.map((x) => `${p}_${x}`).join(', ')}`);
    return {
      key,
      kind,
      title: f.TITLE || KINDS[kind].title + (key === kind ? '' : ` ${key.slice(kind.length)}`),
      number: f[KINDS[kind].number] ?? '',
      url: f.URL || KINDS[kind].url(f),
      enabled,
      captcha: KINDS[kind].captcha,
      fields: f,
    };
  });
  return { list, problems };
}

/**
 * The captcha's `len` letters/digits as the model reads them, or null. Plain text, not a JSON schema: measured on
 * Qwen3.8 (2026-10-05) a schema cost accuracy (10/19 accepted vs 13/20). `ask`: kit llm.ask.
 */
export async function readCaptcha(img, len, ask) {
  const prompt = `Read the ${len} characters in this captcha image, left to right. It is case-sensitive: keep each letter's upper or lower case exactly as drawn. Letters may overlap, be distorted, or be partly cut off at the edges; work out each one from the visible strokes. Ignore the dots and noise. Reply with only those ${len} characters, no spaces.`;
  const code = (await ask({ user: prompt, images: [img], maxTokens: 20 })).replace(/[^A-Za-z0-9]/g, '');
  return code.length === len ? code : null;
}

// A history line in brief: short date, no comments. '30/09/2026 12:32:41: X by Y — “…”' -> '30 Sep: X by Y'
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function brief(h) {
  const m = h.match(/^(.*?\d{1,2}:\d{2}(?::\d{2})?(?: [AP]M)?): (.*)$/);
  if (!m) return clip(h, 90);
  const d = m[1].match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{4}/),
    w = m[1].match(/^(\d{1,2} \w{3})/);
  const day = d ? `${+d[1]} ${MON[d[2] - 1]}` : w ? w[1] : m[1];
  const what = m[2].replace(/ — “.*$/, '').replace(/^Grievance has been /i, '');
  return clip(`${day}: ${what[0].toUpperCase()}${what.slice(1)}`, 90);
}

/** A record's name in the message: title and application/grievance number. */
const name = (site) => `*${site.title}*${site.number ? ` · ${site.number}` : ''}`;

/**
 * One record's lines: ✅ unchanged, 🔔 changed, ⚠️ couldn't check; each ends with its link (`site.link`, the short
 * one, else `site.url`). `prev`: last sent result.
 */
export function section(site, prev, r) {
  const link = `   🔗 ${site.link || site.url}`;
  if (r.error) return `⚠️ ${name(site)} — couldn't check today\n${link}`;
  const short = r.short ?? r.status;
  const fresh = prev ? r.history.filter((h) => !prev.history.includes(h)) : [];
  if (!prev || (!fresh.length && prev.status === r.status))
    return [`✅ ${name(site)} — ${short}`, ...(r.history.length ? [`   ↳ ${brief(r.history.at(-1))}`] : []), link].join(
      '\n',
    );
  const was = prev.short ?? prev.status;
  const out = [`🔔 ${name(site)} — ${was !== short ? `${was} → ${short}` : short}`];
  if (fresh.length) out.push(`   ↳ ${brief(fresh.at(-1))}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`);
  out.push(link);
  return out.join('\n');
}

/** One record's full latest update, as the site shows it (quoted), for the details at the bottom; null if none. */
export function detail(site, r) {
  if (r.error || !(r.status || r.latest?.length)) return null;
  return [name(site), `Status: ${r.status}`, ...(r.latest ?? []).map((l) => `> ${clip(l, 2000)}`)].join('\n');
}

/** The WhatsApp message: the summary, then the latest update of each in full. `model`: who read the captchas, if any. */
export function digest(sites, prev, results, model, timeZone, now = new Date()) {
  const day = now.toLocaleDateString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  const details = sites.map((s) => detail(s, results[s.key])).filter(Boolean);
  return [
    `*Application status · ${day}*`,
    '',
    sites.map((s) => section(s, prev[s.key], results[s.key])).join('\n\n'),
    ...(details.length
      ? ['', '📋 *Details* · latest update on each site, as written there', '', details.join('\n\n')]
      : []),
    ...(model ? ['', `_🤖 ${model} (local)_`] : []),
  ].join('\n');
}
