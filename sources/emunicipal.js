// AP eMunicipal property tax: public JSON API, no captcha.
import { clip, nice, who } from '../rules.js';
import { UA } from './http.js';

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
