// Runs one agent turn inside the Docker container. Talks to the host over stdin/stdout, one JSON object per line.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ProviderId } from '../../shared/types.ts';
import type { Adapter, AdapterInput } from './adapters/types.ts';

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const waiting = new Map<string, (ok: boolean) => void>();
const abort = new AbortController();
let started = false;

// Login files mounted from the host, and where the provider expects them inside this container.
const LOGINS = [
  { from: '/login/codex/auth.json', dir: process.env.CODEX_HOME, name: 'auth.json' },
];
const copied = new Map<string, string>();

function bringLoginsIn() {
  for (const l of LOGINS) {
    if (!l.dir || !fs.existsSync(l.from)) continue;
    fs.mkdirSync(l.dir, { recursive: true });
    const text = fs.readFileSync(l.from, 'utf8');
    fs.writeFileSync(path.join(l.dir, l.name), text, { mode: 0o600 });
    copied.set(l.from, text);
  }
}

/** If the provider refreshed its token during the turn, hand the new one back so the host login stays valid. */
function sendLoginsBack() {
  for (const l of LOGINS) {
    const before = copied.get(l.from);
    if (before === undefined || !l.dir) continue;
    try {
      const now = fs.readFileSync(path.join(l.dir, l.name), 'utf8');
      if (now !== before && now.trim()) fs.writeFileSync(l.from, now); // in place: the mount is a single file
    } catch { /* keep the host file as it is */ }
  }
}

async function start(provider: ProviderId, input: Omit<AdapterInput, 'emit' | 'approve' | 'signal'>) {
  const load: Record<ProviderId, () => Promise<Adapter>> = {
    claude: async () => (await import('./adapters/claude.ts')).claudeAdapter,
    codex: async () => (await import('./adapters/codex.ts')).codexAdapter,
    local: async () => (await import('./adapters/local.ts')).localAdapter,
    demo: async () => (await import('./adapters/demo.ts')).demoAdapter,
  };
  try {
    bringLoginsIn();
    const adapter = await load[provider]();
    let n = 0;
    const result = await adapter({
      ...input,
      signal: abort.signal,
      emit: (e) => send({ t: 'event', e }),
      approve: (kind, title, detail) => new Promise<boolean>((resolve) => {
        const id = String(++n);
        waiting.set(id, resolve);
        send({ t: 'approve', id, kind, title, detail });
      }),
    });
    send({ t: 'result', text: result.text, session: result.session });
  } catch (e) {
    send({ t: 'error', message: (e as Error).message });
  }
  sendLoginsBack();
  process.exit(0);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (!started) { started = true; void start(msg.provider, msg.input); }
  else if (msg.t === 'approved') { waiting.get(msg.id)?.(!!msg.ok); waiting.delete(msg.id); }
  else if (msg.t === 'abort') abort.abort();
});
