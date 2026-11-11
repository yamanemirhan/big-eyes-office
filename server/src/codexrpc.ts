import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Settings } from '../../shared/types.ts';
import { DATA } from './store.ts';
import { record } from './log.ts';

// A client for `codex app-server`: JSON-RPC over stdio. Unlike `codex exec`, it can ask the host for approval.

const require = createRequire(import.meta.url);
const codexBin = () => require.resolve('@openai/codex/bin/codex.js');

type Handler = (method: string, params: any) => unknown | Promise<unknown>;

export class CodexRpc {
  private child: ChildProcess;
  private nextId = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: any) => void>();
  private closeListeners = new Set<() => void>();
  private stderr = '';
  closed = false;

  /** Uses a private Codex home for API-key auth so the user's ChatGPT login in ~/.codex is never touched. */
  constructor(private settings: Settings, private onRequest: Handler = () => { throw new Error('not supported'); }) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (usesApiKey(settings)) {
      env.CODEX_HOME = path.join(DATA, 'codex-apikey');
      fs.mkdirSync(env.CODEX_HOME, { recursive: true });
    }
    this.child = spawn(process.execPath, [codexBin(), 'app-server'], { env, windowsHide: true });
    this.child.stderr!.on('data', (d) => { this.stderr = (this.stderr + String(d)).slice(-4000); });
    this.child.on('close', () => {
      this.closed = true;
      for (const l of this.closeListeners) l();
      for (const w of this.waiting.values()) w.reject(new Error(`Codex stopped. ${this.stderr.trim().split('\n').slice(-3).join(' ')}`));
      this.waiting.clear();
    });
    this.child.on('error', (e) => record(`codex app-server failed to start: ${e.message}`));
    readline.createInterface({ input: this.child.stdout! }).on('line', (line) => this.receive(line));
  }

  private receive(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method) {
      // A request from Codex to us (approvals and the like).
      Promise.resolve().then(() => this.onRequest(msg.method, msg.params)).then(
        (result) => this.send({ id: msg.id, result }),
        (e) => this.send({ id: msg.id, error: { code: -32000, message: (e as Error).message } }),
      );
    } else if (msg.id !== undefined) {
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else w?.resolve(msg.result);
    } else if (msg.method) {
      if (/^(configWarning|warning|deprecationNotice|windows\/worldWritableWarning)$/.test(msg.method)) {
        // Notices about the user's Codex setup (for example an unknown key in config.toml) go to the log, not to the team.
        record(`codex ${msg.method}: ${msg.params?.summary ?? msg.params?.message ?? JSON.stringify(msg.params).slice(0, 300)}`);
        return;
      }
      for (const l of this.listeners) l(msg.method, msg.params);
    }
  }

  private send(msg: unknown) {
    if (!this.closed) this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex is not running.'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  onClose(fn: () => void) { this.closeListeners.add(fn); }

  on(fn: (method: string, params: any) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async start() {
    await this.call('initialize', { clientInfo: { name: 'big_eyes_office', title: 'Big Eyes Office', version: '0.4.0' }, capabilities: null });
    this.send({ method: 'initialized' });
    if (usesApiKey(this.settings)) {
      const account = await this.call<{ account: { type: string } | null }>('account/read', {});
      if (account.account?.type !== 'apiKey') await this.call('account/login/start', { type: 'apiKey', apiKey: this.settings.openaiApiKey });
    }
    return this;
  }

  close() {
    if (!this.closed) this.child.kill();
  }
}

/** API key only when the user chose it, or when there is no ChatGPT login to use. */
export function usesApiKey(settings: Settings): boolean {
  if (!settings.openaiApiKey) return false;
  if (settings.codexAuth === 'apiKey') return true;
  if (settings.codexAuth === 'chatgpt') return false;
  return !fs.existsSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json'));
}

/** Short-lived connection for one-off reads (models, limits). */
export async function withCodex<T>(settings: Settings, fn: (rpc: CodexRpc) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const rpc = new CodexRpc(settings);
  const timer = setTimeout(() => rpc.close(), timeoutMs);
  try {
    await rpc.start();
    return await fn(rpc);
  } finally {
    clearTimeout(timer);
    rpc.close();
  }
}
