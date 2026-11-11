// The local-model agent loop against fake Ollama and OpenAI-compatible servers: tool calls, edits, images, usage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Settings } from '../../shared/types.ts';
import type { AdapterEvent, AdapterInput } from '../src/adapters/types.ts';

process.env.BEO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-test-'));
const { localAdapter } = await import('../src/adapters/local.ts');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function serve(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => handler(req, raw ? JSON.parse(raw) : {}, res));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() });
  }));
}

function input(settings: Partial<Settings>, cwd: string, extra: Partial<AdapterInput> = {}) {
  const events: AdapterEvent[] = [];
  const value: AdapterInput = {
    agent: { id: 'a1', name: 'Pip', role: 'manager', provider: 'local', model: 'test-model', effort: 'high', endpointId: 'e1', look: {} } as any,
    systemPrompt: 'You are Pip.', prompt: 'Fix the greeting.', cwd, autonomy: 'full',
    settings: { localEndpoints: [], ...settings } as Settings,
    signal: new AbortController().signal, teammates: [],
    ask: { edits: false, commands: false }, approve: async () => true,
    emit: (e) => events.push(e), ...extra,
  };
  return { value, events };
}

test('ollama: native API with tools, edit_file, thinking, context length and images', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-ws-'));
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'Hello wrld\n');
  const img = path.join(cwd, 'shot.png');
  fs.writeFileSync(img, PNG);
  const seen: any[] = [];
  let step = 0;
  const ollama = await serve((req, body, res) => {
    if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'vision', 'thinking'] })); return; }
    assert.equal(req.url, '/api/chat');
    seen.push(body);
    res.setHeader('content-type', 'application/x-ndjson');
    step++;
    if (step === 1) {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'need to fix typo' } })}\n`);
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: { path: 'hello.txt', old_text: 'wrld', new_text: 'world' } } }] }, done: true, prompt_eval_count: 100, eval_count: 10 })}\n`);
    } else {
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Fixed ' } })}\n`);
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'the typo.' }, done: true, prompt_eval_count: 150, eval_count: 5 })}\n`);
    }
  });
  try {
    const { value, events } = input({ localEndpoints: [{ id: 'e1', name: 'Ollama', baseUrl: `${ollama.url}/v1`, kind: 'ollama', contextLength: 16384 }] }, cwd, { images: [img] });
    const result = await localAdapter(value);
    assert.equal(result.text, 'Fixed the typo.');
    assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'Hello world\n');
    assert.equal(seen[0].options.num_ctx, 16384);
    assert.equal(seen[0].think, true);
    assert.equal(seen[0].messages.at(-1).images[0], PNG.toString('base64'));
    assert.equal(seen[1].messages.at(-1).role, 'tool');
    assert.equal(seen[1].messages.at(-1).tool_name, 'edit_file');
    assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', inputTokens: 250, outputTokens: 15 });
    // The saved conversation does not carry the image again.
    assert.ok(!(result.session as any[]).some((m) => m.images));
  } finally { ollama.close(); }
});

test('ollama: a model without tools answers in text and says so', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-ws-'));
  let sent: any;
  const ollama = await serve((req, body, res) => {
    if (req.url === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion'] })); return; }
    sent = body;
    res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'Just text.' }, done: true })}\n`);
  });
  try {
    const { value, events } = input({ localEndpoints: [{ id: 'e1', name: 'Ollama', baseUrl: ollama.url, kind: 'ollama' }] }, cwd);
    const result = await localAdapter(value);
    assert.equal(result.text, 'Just text.');
    assert.equal(sent.tools, undefined);
    assert.ok(events.some((e) => e.type === 'message' && /cannot use tools/.test(e.text)));
  } finally { ollama.close(); }
});

test('openai-compatible: streamed tool call arguments are joined, writes stay inside the workspace', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-ws-'));
  let step = 0;
  const server = await serve((req, body, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(body.stream, true);
    res.setHeader('content-type', 'text/event-stream');
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    step++;
    if (step === 1) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"../escape.txt",' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"x"}' } }] } }] });
    } else if (step === 2) {
      assert.match(body.messages.at(-1).content, /outside the workspace/);
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'write_file', arguments: '{"path":"ok.txt","content":"fine"}' } }] } }] });
    } else {
      send({ choices: [{ delta: { content: 'Done.' } }] });
      send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } });
    }
    res.end('data: [DONE]\n\n');
  });
  try {
    const { value } = input({ localEndpoints: [{ id: 'e1', name: 'LM', baseUrl: `${server.url}/v1` }] }, cwd);
    const result = await localAdapter(value);
    assert.equal(result.text, 'Done.');
    assert.equal(fs.readFileSync(path.join(cwd, 'ok.txt'), 'utf8'), 'fine');
    assert.ok(!fs.existsSync(path.join(cwd, '..', 'escape.txt')));
  } finally { server.close(); }
});

test('a clear message when the local server is not running', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beo-ws-'));
  const { value } = input({ localEndpoints: [{ id: 'e1', name: 'Ollama', baseUrl: 'http://127.0.0.1:9/v1', kind: 'ollama' }] }, cwd, { agent: { id: 'a1', name: 'Pip', provider: 'local', model: '', effort: 'default', endpointId: 'e1' } as any });
  await assert.rejects(localAdapter(value), /not running/);
});
