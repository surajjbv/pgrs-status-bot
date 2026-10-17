// Digest rules (the sites and the model are not called).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brief, detail, digest, nice, readCaptcha, records, section, who } from './rules.js';

const site = {
  key: 'emunicipal',
  title: 'Property Tax',
  number: 'A-1',
  url: 'https://example.gov.in/status',
  link: 'https://tinyurl.com/abc',
};
const r1 = {
  short: 'Assistant approved',
  status: 'Assistant Approved',
  history: ['28/09/2026 10:00:00: Created by A — “ok”', '29/09/2026 11:00:00: Assistant Approved by B'],
  latest: ['29/09/2026 11:00:00', 'Assistant Approved', 'By: B'],
};
const r2 = {
  short: 'Bill collector approved',
  status: 'Bill Collector Approved',
  history: [...r1.history, '30/09/2026 12:32:41: Bill Collector Approved by C D NAME — “checked”'],
};

test('nice, who, brief', () => {
  assert.equal(nice('InProcess'), 'In process');
  assert.equal(nice('IN PROGRESS'), 'In progress');
  assert.equal(who('1234567::A B NAME'), 'A B NAME');
  assert.equal(
    brief('30/09/2026 12:32:41: Bill Collector Approved by C D NAME — “checked”'),
    '30 Sep: Bill Collector Approved by C D NAME',
  );
  assert.equal(brief('28 Sep 2026 10:15 AM: Grievance has been assigned to X'), '28 Sep: Assigned to X');
  assert.equal(brief('no date here'), 'no date here');
});

test('section: number and link always; first sight, unchanged, changed, failed', () => {
  const same =
    '✅ *Property Tax* · A-1 — Assistant approved\n   ↳ 29 Sep: Assistant Approved by B\n   🔗 https://tinyurl.com/abc';
  assert.equal(section(site, undefined, r1), same);
  assert.equal(section(site, r1, r1), same);
  assert.equal(
    section(site, r1, r2),
    '🔔 *Property Tax* · A-1 — Assistant approved → Bill collector approved\n   ↳ 30 Sep: Bill Collector Approved by C D NAME\n   🔗 https://tinyurl.com/abc',
  );
  assert.equal(
    section(site, r1, { error: 'HTTP 500' }),
    "⚠️ *Property Tax* · A-1 — couldn't check today\n   🔗 https://tinyurl.com/abc",
  );
  assert.equal(
    section({ ...site, number: '', link: null }, r1, { error: 'x' }),
    "⚠️ *Property Tax* — couldn't check today\n   🔗 https://example.gov.in/status",
  );
});

test('detail: status and the latest update in full, quoted; nothing for a failed check', () => {
  const long = 'x '.repeat(400).trim();
  assert.equal(
    detail(site, { ...r1, latest: [...r1.latest, `Comments: ${long}`] }),
    `*Property Tax* · A-1\nStatus: Assistant Approved\n> 29/09/2026 11:00:00\n> Assistant Approved\n> By: B\n> Comments: ${long}`,
  );
  assert.equal(detail(site, { status: 'Open', history: [] }), '*Property Tax* · A-1\nStatus: Open');
  assert.equal(detail(site, { error: 'HTTP 500' }), null);
});

test('digest: header, sections, details, model footer only when the model read captchas', () => {
  const now = new Date('2026-10-05T05:00:00Z');
  assert.equal(
    digest([site], {}, { emunicipal: r1 }, 'Qwen 3.8 27B', 'Asia/Kolkata', now),
    [
      '*Application status · Mon 5 Oct*',
      '',
      '✅ *Property Tax* · A-1 — Assistant approved',
      '   ↳ 29 Sep: Assistant Approved by B',
      '   🔗 https://tinyurl.com/abc',
      '',
      '📋 *Details* · latest update on each site, as written there',
      '',
      '*Property Tax* · A-1',
      'Status: Assistant Approved',
      '> 29/09/2026 11:00:00',
      '> Assistant Approved',
      '> By: B',
      '',
      '_🤖 Qwen 3.8 27B (local)_',
    ].join('\n'),
  );
  assert.ok(!digest([site], {}, { emunicipal: r1 }, null, 'Asia/Kolkata', now).includes('🤖'));
  assert.ok(!digest([site], {}, { emunicipal: { error: 'x' } }, null, 'Asia/Kolkata', now).includes('Details'));
});

test('records: groups of .env keys, defaults, numbered extras, ENABLED toggle, problems', () => {
  const { list, problems } = records({
    GROUP_NAME: 'g',
    PGRS_ID: 'P1',
    IPGRS_ID: '1',
    IPGRS_MOBILE: '9',
    IPGRS2_ID: '2',
    IPGRS2_MOBILE: '8',
    IPGRS2_TITLE: 'Old one',
    IPGRS2_ENABLED: 'false',
    EMUN_ULB_ID: '1000',
    EMUN_APP: 'A-1',
    EMUN_URL: 'https://example.gov.in/x',
    EMUN_ENABLED: 'yes',
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    list.map((r) => [r.key, r.title, r.number, r.enabled, r.url]),
    [
      ['pgrs', 'AP Grievance', 'P1', true, 'https://pgrs.ap.gov.in/ApplicationStatus.aspx'],
      ['ipgrs', 'KA Grievance', '1', true, 'https://ipgrs.karnataka.gov.in/Grievance/GetGrievanceStatus?grievanceId=1'],
      ['ipgrs2', 'Old one', '2', false, 'https://ipgrs.karnataka.gov.in/Grievance/GetGrievanceStatus?grievanceId=2'],
      ['emunicipal', 'Property Tax', 'A-1', true, 'https://example.gov.in/x'],
    ],
  );
  assert.deepEqual(list[1].fields, { ID: '1', MOBILE: '9' });
  assert.equal(records({ PGRS3_ID: 'x' }).list[0].title, 'AP Grievance 3');
  assert.deepEqual(records({ IPGRS_ID: '1', IPGRS_MOBIEL: '9', PGRS2_ENABLED: 'off' }).problems, [
    'IPGRS_MOBIEL: unknown setting (IPGRS takes ID, MOBILE, TITLE, URL, ENABLED)',
    'IPGRS: missing IPGRS_MOBILE',
  ]);
});

test('captcha: exactly len letters/digits from the model reply, else null', async () => {
  const ask = (reply) => async () => reply;
  assert.equal(await readCaptcha(Buffer.from([0x89]), 5, ask(' QGMPs\n')), 'QGMPs');
  assert.equal(await readCaptcha(Buffer.from([0x89]), 5, ask('Q G-M P s')), 'QGMPs');
  assert.equal(await readCaptcha(Buffer.from([0x89]), 6, ask('QGMPs')), null);
});
