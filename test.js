// Digest rules (the sites and the model are not called).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brief, digest, nice, section, who } from './rules.js';

const site = { key: 'emunicipal', title: 'Property Tax', url: 'https://example.gov.in/status' };
const r1 = { short: 'Assistant approved', status: 'Assistant Approved', history: ['28/09/2026 10:00:00: Created by A — “ok”', '29/09/2026 11:00:00: Assistant Approved by B'] };
const r2 = { short: 'Bill collector approved', status: 'Bill Collector Approved', history: [...r1.history, '30/09/2026 12:32:41: Bill Collector Approved by C D NAME — “checked”'] };

test('nice, who, brief', () => {
  assert.equal(nice('InProcess'), 'In process');
  assert.equal(nice('IN PROGRESS'), 'In progress');
  assert.equal(who('1234567::A B NAME'), 'A B NAME');
  assert.equal(brief('30/09/2026 12:32:41: Bill Collector Approved by C D NAME — “checked”'), '30 Sep: Bill Collector Approved by C D NAME');
  assert.equal(brief('28 Sep 2026 10:15 AM: Grievance has been assigned to X'), '28 Sep: Assigned to X');
  assert.equal(brief('no date here'), 'no date here');
});

test('section: first sight, unchanged, changed, failed', () => {
  assert.equal(section(site, undefined, r1), '✅ *Property Tax* — Assistant approved\n   ↳ 29 Sep: Assistant Approved by B');
  assert.equal(section(site, r1, r1), '✅ *Property Tax* — Assistant approved\n   ↳ 29 Sep: Assistant Approved by B');
  assert.equal(section(site, r1, r2), '🔔 *Property Tax* — Assistant approved → Bill collector approved\n   ↳ 30 Sep: Bill Collector Approved by C D NAME\n   https://example.gov.in/status');
  assert.equal(section(site, r1, { error: 'HTTP 500' }), "⚠️ *Property Tax* — couldn't check today");
});

test('digest: header, sections, model footer only when the model read captchas', () => {
  const now = new Date('2026-10-05T05:00:00Z');
  assert.equal(digest([site], {}, { emunicipal: r1 }, 'Qwen 3.8 27B', 'Asia/Kolkata', now),
    '*Application status · Mon 5 Oct*\n✅ *Property Tax* — Assistant approved\n   ↳ 29 Sep: Assistant Approved by B\n_🤖 Qwen 3.8 27B (local)_');
  assert.ok(!digest([site], {}, { emunicipal: r1 }, null, 'Asia/Kolkata', now).includes('🤖'));
});
