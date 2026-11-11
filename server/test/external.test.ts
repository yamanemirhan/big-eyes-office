import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-')); process.env.HOME = home; process.env.USERPROFILE = home;
const proj = path.join(home, '.claude', 'projects', '-work-app'); fs.mkdirSync(proj, { recursive: true });
const L = (o: any) => JSON.stringify(o);
fs.writeFileSync(path.join(proj, 's1.jsonl'), [
  L({ type: 'user', sessionId: 's1', cwd: '/work/app', message: { role: 'user', content: 'Add a login page' } }),
  L({ type: 'assistant', sessionId: 's1', cwd: '/work/app', message: { model: 'claude-opus-4-6', stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200, output_tokens: 50 }, content: [{ type: 'text', text: 'I will edit the page.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/work/app/login.tsx' } }] } }),
].join('\n') + '\n');
const cdx = path.join(home, '.codex', 'sessions', '2026', '11', '11'); fs.mkdirSync(cdx, { recursive: true });
fs.writeFileSync(path.join(cdx, 'rollout-x.jsonl'), [
  L({ type: 'session_meta', payload: { id: 'c1', cwd: '/work/api' } }),
  L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the tests' }] } }),
  L({ type: 'event_msg', payload: { type: 'user_message', message: 'Fix the tests' } }),
  L({ type: 'event_msg', payload: { type: 'task_started' } }),
  L({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9000, cached_input_tokens: 6000, output_tokens: 300 }, last_token_usage: { input_tokens: 9000, output_tokens: 300 }, model_context_window: 258000 } } }),
  L({ type: 'event_msg', payload: { type: 'agent_message', message: 'Tests pass now.' } }),
  L({ type: 'event_msg', payload: { type: 'task_complete' } }),
].join('\n') + '\n');
const { externalSessions } = await import('../src/external.ts');
const list = externalSessions(new Set());
test('outside sessions are read from Claude Code and Codex transcripts', () => {
  const claude = list.find((s) => s.tool === 'claude')!;
  assert.equal(claude.title, 'Add a login page');
  assert.equal(claude.state, 'working', 'an unanswered tool call that just happened is running');
  assert.deepEqual(claude.files, ['/work/app/login.tsx']);
  assert.equal(claude.context?.used, 5260);
  const codex = list.find((s) => s.tool === 'codex')!;
  assert.equal(codex.state, 'done');
  assert.equal(codex.title, 'Fix the tests');
  assert.equal(codex.lastMessage, 'Tests pass now.');
  assert.deepEqual(codex.tokens, { input: 3000, output: 300, cached: 6000 });
  assert.equal(externalSessions(new Set(['s1', 'c1'])).length, 0, 'the office\'s own sessions are left out');
});
