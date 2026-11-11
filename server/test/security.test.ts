// The local server must refuse other websites: wrong Host (DNS rebinding), cross-site requests and sockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
let child: ChildProcess;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

before(async () => {
  port = await new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
  child = spawn(process.execPath, ['--import', 'tsx', path.join(here, '..', 'src', 'main.ts')], {
    env: { ...process.env, PORT: String(port), BEO_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'beo-sec-')), BEO_NO_AUTO_INSTALL: '1' },
    cwd: path.join(here, '..'), stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base()}/api/state`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});
after(() => { child?.kill(); });

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const status = await new Promise<number>((resolve) => {
    const req = net.connect(port, '127.0.0.1', () => req.write(`GET /api/state HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`));
    req.on('data', (d) => resolve(Number(String(d).split(' ')[1])));
  });
  assert.equal(status, 403);
});

test('changes need the app header and a local origin', async () => {
  assert.equal((await fetch(`${base()}/api/docker/clean`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${base()}/api/docker/clean`, { method: 'POST', headers: { 'x-beo-client': '1', origin: 'https://evil.example' } })).status, 403);
  const ok = await fetch(`${base()}/api/teams`, { method: 'POST', headers: { 'x-beo-client': '1', 'content-type': 'application/json', origin: `http://localhost:${port}` }, body: JSON.stringify({ name: 'T', agents: [] }) });
  assert.equal(ok.status, 200);
});

test('the socket only accepts this app\'s own page', async () => {
  const open = (origin: string) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
  assert.equal(await open('https://evil.example'), false);
  assert.equal(await open(`http://localhost:${port}`), true);
});
