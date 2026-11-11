// Egress proxy for agent containers. Agent containers sit on an internal Docker network with no route out;
// this proxy is the only way out and lets through only the hosts in ALLOW (comma-separated domain suffixes).
// Plain Node, no dependencies. Runs in its own container on both networks.
import http from 'node:http';
import net from 'node:net';

const allow = (process.env.ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const port = Number(process.env.PORT ?? 3128);
const ok = (host) => {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return allow.includes('*') || allow.some((a) => h === a || h.endsWith(`.${a}`));
};
const log = (line) => process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);

const server = http.createServer((req, res) => {
  // Plain HTTP through the proxy (absolute URL in the request line).
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400).end('Bad request'); return; }
  if (!ok(url.hostname)) { log(`DENY http ${url.hostname}`); res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by Big Eyes Office: ${url.hostname} is not on the allowlist.\n`); return; }
  const upstream = http.request({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: url.host } }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (e) => { if (!res.headersSent) res.writeHead(502).end(e.message); });
  req.pipe(upstream);
});

// HTTPS: CONNECT tunnels. The proxy never sees the encrypted content, only the host name.
server.on('connect', (req, client, head) => {
  client.on('error', () => {});
  const [host, p] = String(req.url).split(':');
  if (!ok(host)) {
    log(`DENY connect ${host}`);
    client.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by Big Eyes Office allowlist\r\n');
    return;
  }
  const upstream = net.connect(Number(p) || 443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
});

server.on('clientError', (_e, socket) => socket.destroy());
process.on('uncaughtException', (e) => log(`error: ${e.message}`));

server.listen(port, '0.0.0.0', () => log(`egress proxy on ${port}; allowed: ${allow.join(', ') || '(nothing)'}`));
