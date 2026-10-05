// What the sites see: a desktop Chrome, and (for IPGRS) a cookie jar, since its captcha is tied to the session.
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with a cookie jar; `form` makes it an XHR-style POST. */
export function session() {
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
