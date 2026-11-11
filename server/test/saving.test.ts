// Token saving and memory helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BEO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-test-'));
const { classify } = await import('../src/router.ts');
const { compressOutput } = await import('../src/adapters/types.ts');
const { addMemory, readMemory, takeMemory } = await import('../src/memory.ts');

test('router: questions go quick, work and code go to the team', () => {
  for (const q of ['who are u zed', 'What is the difference between TCP and UDP?', 'neden docker kullanıyoruz?', 'Explain closures in JS', 'hi']) assert.equal(classify(q).mode, 'quick', q);
  for (const w of ['fix the typo in README.md', 'Create a todo app with React', 'bu projeye login sayfası ekle', 'add tests', 'look at src/index.ts']) assert.equal(classify(w).mode, 'team', w);
  assert.equal(classify('what is in this?', ['C:/data/uploads/x/report.pdf']).mode, 'team', 'non-image attachments need the team');
  assert.equal(classify('what is in this picture?', ['C:/data/uploads/x/shot.png']).mode, 'quick', 'images can be answered quickly');
});

test('long output keeps its start and end, repeated lines collapse, colours go', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
  const out = compressOutput(lines.join('\n'), 100);
  assert.ok(out.includes('line 0') && out.includes('line 999'));
  assert.match(out, /900 lines left out/);
  assert.equal(compressOutput('\u001b[32mok\u001b[0m\nsame\nsame\nsame'), 'ok\nsame\n  (previous line repeated 2 more times)');
});

test('memory blocks are taken out of the answer, deduplicated and never keep secrets', () => {
  const { text, lines } = takeMemory('Done.\n```memory\n- Use pnpm, not npm\n- api_key: sk-abcdefghijklmnop\n```');
  assert.equal(text, 'Done.');
  assert.deepEqual(lines, ['Use pnpm, not npm']);
  assert.deepEqual(addMemory('t1', lines), ['Use pnpm, not npm']);
  assert.deepEqual(addMemory('t1', ['use PNPM, not npm']), [], 'case-insensitive duplicates are skipped');
  assert.match(readMemory('t1'), /^## \d{4}-\d\d-\d\d\n- Use pnpm, not npm/m);
});

test('errors: usage limits can fall back, glitches are retried, the rest is reported', async () => {
  const { errorKind } = await import('../src/orchestrator.ts');
  assert.equal(errorKind("Claude Code returned an error result: You've hit your 5-hour limit · resets 9:40pm"), 'limit');
  assert.equal(errorKind('You’ve hit your usage limit. Upgrade to Pro'), 'limit');
  assert.equal(errorKind('529 Overloaded'), 'transient');
  assert.equal(errorKind('fetch failed'), 'transient');
  assert.equal(errorKind('The check "npm test" still fails'), 'other');
});

test('traces are exported as OTLP JSON with gen_ai attributes', async () => {
  const { toOtlp, parseHeaders } = await import('../src/telemetry.ts');
  const otlp = toOtlp([{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'invoke_agent Zed', kind: 'client', start: 1000, end: 2500, status: 'ok',
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.usage.input_tokens': 120, 'gen_ai.usage.cache_read.input_tokens': undefined } }]);
  const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.kind, 3);
  assert.equal(span.startTimeUnixNano, '1000000000');
  assert.deepEqual(span.attributes, [{ key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } }]);
  assert.deepEqual(parseHeaders('Authorization=Basic abc, x-tenant=me'), { Authorization: 'Basic abc', 'x-tenant': 'me' });
});
