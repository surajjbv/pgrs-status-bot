// Captchas are read by the local model (the one shared through kit/llm.js), as plain text rather than a JSON
// schema: measured 2026-10-05 on Qwen3.8, a schema cost accuracy (10/19 accepted vs 13/20 as plain text).
import fs from 'node:fs';
import * as llm from '../kit/llm.js';

const PROMPT = fs.readFileSync(new URL('../prompts/captcha.md', import.meta.url), 'utf8').trim();
const NO_THINK = '<think>\n\n</think>\n\n'; // Qwen3.8's thinking off, as in kit/llm.js
export let used = false; // the model read a captcha this run (for the message footer)

/** The captcha text, or null if the model didn't return exactly `len` letters/digits. */
export async function readCaptcha(img, len) {
  const model = await llm.acquire();
  used = true;
  const r = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, temperature: 0, max_tokens: 20, messages: [
      { role: 'user', content: [{ type: 'text', text: PROMPT.replaceAll('%LEN%', len) },
        { type: 'image_url', image_url: { url: `data:${img[0] === 0xff ? 'image/jpeg' : 'image/png'};base64,${img.toString('base64')}` } }] },
      { role: 'assistant', content: NO_THINK }] }),
  });
  if (!r.ok) throw new Error(`LM Studio ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const code = ((await r.json()).choices?.[0]?.message?.content ?? '').replace(/[^A-Za-z0-9]/g, '');
  return code.length === len ? code : null;
}
