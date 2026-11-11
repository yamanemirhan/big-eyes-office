// Unit tests for the pure parts: permission rules, the lead's delegate/question blocks, locks and Ollama helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.BEO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-test-'));
const { matchRule, parseDelegation, parseQuestions } = await import('../src/orchestrator.ts');
const { acquireFolder, withRepoLock } = await import('../src/locks.ts');
const { forContainer, isOllama, ndjson, ollamaRoot } = await import('../src/ollama.ts');

test('permission rules: first match wins, * is a wildcard, plain patterns match the start', () => {
  const rules = [
    { id: '1', kind: 'command' as const, pattern: 'git push*', action: 'deny' as const },
    { id: '2', kind: 'command' as const, pattern: 'npm test', action: 'allow' as const },
    { id: '3', kind: 'edit' as const, pattern: '*.env', action: 'deny' as const },
  ];
  assert.equal(matchRule(rules, 'command', 'git push origin main')?.action, 'deny');
  assert.equal(matchRule(rules, 'command', 'NPM TEST -- --watch')?.action, 'allow');
  assert.equal(matchRule(rules, 'command', 'rm -rf /'), undefined);
  assert.equal(matchRule(rules, 'edit', 'config/prod.env')?.action, 'deny');
  assert.equal(matchRule(rules, 'command', 'config/prod.env'), undefined, 'rules only apply to their kind');
});

test('delegate blocks: valid, invalid JSON, and missing fields', () => {
  const ok = parseDelegation('Plan.\n```delegate\n[{"to":"Bolt","name":"API","task":"Build it"}]\n```');
  assert.equal(ok.body, 'Plan.');
  assert.deepEqual(ok.assignments?.map((a) => a.to), ['Bolt']);
  assert.match(parseDelegation('```delegate\n{oops}\n```').error ?? '', /not valid JSON/);
  assert.match(parseDelegation('```delegate\n[{"who":"x"}]\n```').error ?? '', /no valid/);
  assert.equal(parseDelegation('no block').assignments, null);
});

test('question blocks keep up to five questions with options and a recommendation', () => {
  const q = parseQuestions('Before I start:\n```questions\n[{"question":"Which DB?","options":["SQLite","Postgres"],"recommended":"SQLite"}]\n```');
  assert.equal(q?.items[0].recommended, 'SQLite');
  assert.equal(q?.body, 'Before I start:');
  assert.equal(parseQuestions('```questions\nnot json\n```'), null);
});

test('folder lock: a second run waits until the first releases; branch-sharing runs share', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-lock-'));
  const release = await acquireFolder(dir, 'a', false, () => {}, new AbortController().signal);
  let waited = false;
  let got = false;
  const second = acquireFolder(dir, 'b', false, () => { waited = true; }, new AbortController().signal).then((r) => { got = true; return r; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(waited, true);
  assert.equal(got, false);
  release();
  (await second)();
  assert.equal(got, true);

  const x = await acquireFolder(dir, 'x', true, () => {}, new AbortController().signal);
  const y = await acquireFolder(dir, 'y', true, () => assert.fail('shared runs must not wait'), new AbortController().signal);
  x(); y();
});

test('repo lock runs one change at a time, even after a failure', async () => {
  const order: string[] = [];
  const slow = withRepoLock('/repo', async () => { await new Promise((r) => setTimeout(r, 20)); order.push('first'); throw new Error('boom'); });
  const next = withRepoLock('/repo', async () => { order.push('second'); });
  await assert.rejects(slow);
  await next;
  assert.deepEqual(order, ['first', 'second']);
});

test('ollama helpers', async () => {
  assert.equal(isOllama({ id: 'o', name: 'O', baseUrl: 'http://localhost:11434/v1' }), true);
  assert.equal(isOllama({ id: 'l', name: 'L', baseUrl: 'http://localhost:1234/v1' }), false);
  assert.equal(isOllama({ id: 'l', name: 'L', baseUrl: 'http://box:9000', kind: 'ollama' }), true);
  assert.equal(ollamaRoot({ id: 'o', name: 'O', baseUrl: 'http://localhost:11434/v1/' }), 'http://localhost:11434');
  assert.equal(forContainer('http://127.0.0.1:11434'), 'http://host.docker.internal:11434');
  assert.equal(forContainer('http://localhost/v1'), 'http://host.docker.internal/v1');
  assert.equal(forContainer('http://localhost.example.com'), 'http://localhost.example.com');

  const body = new Blob(['{"a":1}\n{"b":', '2}\n\n{"c":3}']).stream();
  const out = [];
  for await (const x of ndjson(body)) out.push(x);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});
