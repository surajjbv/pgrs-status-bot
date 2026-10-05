// Karnataka IPGRS: captcha + registered mobile, JSON API. Returns { short, status, history[] } (history oldest first).
import { clip, nice } from '../rules.js';
import { readCaptcha } from './captcha.js';
import { session } from './http.js';

export async function ipgrs({ env, cfg }) {
  const H = 'https://ipgrs.karnataka.gov.in', id = env.IPGRS_ID, s = session();
  await s(`${H}/Grievance/GetGrievanceStatus?grievanceId=${id}`);
  let d, last = 'captcha not read';
  for (let i = 0; i < cfg.captchaTries && !d; i++) { // a wrong read just costs a new captcha
    const cap = await readCaptcha(Buffer.from(await (await s(`${H}/Home/GetGrievanceStatusCaptchaImage?t=${Date.now()}`)).arrayBuffer()), 5);
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
