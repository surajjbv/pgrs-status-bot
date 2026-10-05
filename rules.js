// The digest: one line per site plus its latest update; a change adds what changed and the site's link.
export const clip = (s, n = 280) => (s = String(s ?? '').replace(/\s+/g, ' ').trim()).length > n ? s.slice(0, n - 1) + '…' : s;
export const nice = (s) => { s = String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim(); return s[0]?.toUpperCase() + s.slice(1); }; // 'InProcess' -> 'In process'
export const who = (s) => String(s ?? '').replace(/^[^:]*::/, ''); // '1234567::A B NAME' -> 'A B NAME'

// A history line in brief: short date, no comments. '30/09/2026 12:32:41: X by Y — “…”' -> '30 Sep: X by Y'
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function brief(h) {
  const m = h.match(/^(.*?\d{1,2}:\d{2}(?::\d{2})?(?: [AP]M)?): (.*)$/);
  if (!m) return clip(h, 90);
  const d = m[1].match(/^(\d{1,2})[-/](\d{1,2})[-/]\d{4}/), w = m[1].match(/^(\d{1,2} \w{3})/);
  const day = d ? `${+d[1]} ${MON[d[2] - 1]}` : w ? w[1] : m[1];
  const what = m[2].replace(/ — “.*$/, '').replace(/^Grievance has been /i, '');
  return clip(`${day}: ${what[0].toUpperCase()}${what.slice(1)}`, 90);
}

/** One site's lines: ✅ unchanged, 🔔 changed (with link), ⚠️ couldn't check. `prev`: last sent result. */
export function section(site, prev, r) {
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

/** The WhatsApp message. `model`: label of the model that read captchas this run, if any. */
export function digest(sites, prev, results, model, timeZone, now = new Date()) {
  const day = now.toLocaleDateString('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  return [`*Application status · ${day}*`, ...sites.map((s) => section(s, prev[s.key], results[s.key])), ...(model ? [`_🤖 ${model} (local)_`] : [])].join('\n');
}
