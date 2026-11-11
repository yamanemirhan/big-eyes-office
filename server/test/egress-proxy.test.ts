// The allowlist proxy that is the only way out of agent containers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
let proxy: ChildProcess;
let target: http.Server;
let proxyPort = 0;
let targetPort = 0;

before(async () => {
  target = http.createServer((_req, res) => res.end('hello from target')).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  targetPort = (target.address() as net.AddressInfo).port;
  proxyPort = await freePort();
  proxy = spawn(process.execPath, [path.join(here, '..', 'src', 'egress-proxy.mjs')], { env: { ...process.env, PORT: String(proxyPort), ALLOW: '127.0.0.1,example.org' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await new Promise((r) => net.connect(proxyPort, '127.0.0.1').on('connect', function (this: net.Socket) { this.destroy(); r(true); }).on('error', () => r(false)))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(() => { proxy?.kill(); target?.close(); });

const viaProxy = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  }).on('error', reject);
});

const connect = (host: string) => new Promise<string>((resolve) => {
  const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
  s.once('data', (d) => { resolve(String(d).split('\r\n')[0]); s.destroy(); });
});

test('allowed hosts pass, others are refused', async () => {
  const ok = await viaProxy(`http://127.0.0.1:${targetPort}/`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'hello from target');
  assert.equal((await viaProxy('http://blocked.test/')).status, 403);
  assert.match(await connect('evil.example.com'), /403/);
  assert.match(await connect('notexample.org'), /403/, 'a suffix must match a whole label');
});

test('the proxy survives clients that hang up', async () => {
  const s = net.connect(proxyPort, '127.0.0.1', () => { s.write('CONNECT evil.example.com:443 HTTP/1.1\r\n'); s.destroy(); });
  await new Promise((r) => setTimeout(r, 100));
  assert.match(await connect('evil.example.com'), /403/);
});
