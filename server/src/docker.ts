import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { ProviderId, Settings } from '../../shared/types.ts';
import { DATA, ROOT, newId } from './store.ts';
import { forContainer } from './ollama.ts';
import { sh } from './git.ts';
import { record } from './log.ts';
import type { AdapterInput, AdapterResult } from './adapters/types.ts';

// Agent turns in a locked-down container:
// - only the working folder is mounted (plus the provider's login file when no API key is used),
// - no Linux capabilities, no privilege escalation, read-only system, limited memory, CPU and processes,
// - no direct internet: an internal network whose only way out is an allowlist proxy (or no network at all).
// Docker Desktop on Windows and macOS runs containers inside its own VM, which adds a second wall.

export const IMAGE = 'big-eyes-office-agent';
const NET = 'beo-internal';
const PROXY = 'beo-egress';

export const DEFAULT_ALLOW = [
  'anthropic.com', 'claude.ai', 'claude.com', // Claude
  'openai.com', 'chatgpt.com', 'oaiusercontent.com', // OpenAI / Codex
  'github.com', 'githubusercontent.com', // git and GitHub
  'registry.npmjs.org', 'npmjs.org', 'pypi.org', 'pythonhosted.org', // packages
  'host.docker.internal', // local models (Ollama, LM Studio) on this computer
];

const docker = (args: string[], timeout = 60_000) => sh('docker', args, ROOT, timeout);

export async function dockerStatus(): Promise<{ docker: boolean; image: boolean; detail: string }> {
  const version = await docker(['version', '--format', '{{.Server.Version}}'], 15_000);
  if (!version.ok) return { docker: false, image: false, detail: 'Docker is not running. Start Docker Desktop and try again.' };
  const image = await docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 15_000);
  return { docker: true, image: image.ok, detail: image.ok ? `Docker ${version.out.trim()}, image is built.` : `Docker ${version.out.trim()}. The agent image is not built yet.` };
}

export async function dockerBuild(): Promise<{ ok: boolean; log: string }> {
  const r = await docker(['build', '-t', IMAGE, '-f', path.join('docker', 'Dockerfile'), '.'], 20 * 60_000);
  if (r.ok) await docker(['rm', '-f', PROXY]); // The proxy runs from the image; restart it on the new one.
  return { ok: r.ok, log: r.out.slice(-4000) };
}

/** Makes sure the internal network and the allowlist proxy exist and match the current allowlist. */
async function ensureEgress(allow: string[]) {
  const wanted = allow.join(',');
  const net = await docker(['network', 'inspect', NET, '--format', '{{.Internal}}']);
  if (!net.ok) {
    const made = await docker(['network', 'create', '--internal', NET]);
    if (!made.ok && !/already exists/.test(made.out)) throw new Error(`Could not create the internal Docker network: ${made.out}`);
  }
  const current = await docker(['inspect', PROXY, '--format', '{{.State.Running}}|{{range .Config.Env}}{{println .}}{{end}}']);
  const running = current.ok && current.out.startsWith('true');
  const sameList = current.out.includes(`ALLOW=${wanted}\n`) || current.out.endsWith(`ALLOW=${wanted}`);
  if (running && sameList) return;
  await docker(['rm', '-f', PROXY]);
  const started = await docker(['run', '-d', '--name', PROXY, '--restart', 'unless-stopped',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--memory', '256m', '--pids-limit', '128',
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', `ALLOW=${wanted}`, '-v', `${path.join(ROOT, 'server', 'src', 'egress-proxy.mjs')}:/proxy.mjs:ro`,
    IMAGE, 'node', '/proxy.mjs']);
  if (!started.ok) throw new Error(`Could not start the egress proxy: ${started.out}`);
  const joined = await docker(['network', 'connect', NET, PROXY]);
  if (!joined.ok && !/already exists|endpoint with name/.test(joined.out)) throw new Error(`Could not connect the proxy to the internal network: ${joined.out}`);
  record(`docker egress proxy started; allowed: ${wanted}`);
}

/** Removes the state volumes of agents that no longer exist. Returns how many were removed. */
export async function dockerCleanVolumes(keepAgentIds: string[]): Promise<number> {
  const list = await docker(['volume', 'ls', '--filter', 'label=beo=1', '--format', '{{.Name}}']);
  if (!list.ok) return 0;
  const keep = new Set(keepAgentIds.map((id) => `beo-state-${id.replace(/[^a-zA-Z0-9_.-]/g, '')}`));
  const stale = list.out.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.startsWith('beo-state-') && !keep.has(x));
  let removed = 0;
  for (const v of stale) if ((await docker(['volume', 'rm', v])).ok) removed++;
  return removed;
}

/** Recent requests the proxy refused, for the Settings screen. */
export async function egressDenials(): Promise<string> {
  const r = await docker(['logs', '--tail', '200', PROXY]);
  return r.ok ? r.out.split('\n').filter((l) => l.includes('DENY')).slice(-30).join('\n') : '';
}

const toHost = (url: string) => url.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, '//host.docker.internal');

/** A worktree's .git is a file pointing into the main repository; give git inside the container the same view. */
function gitMounts(cwd: string): string[] {
  const dotgit = path.join(cwd, '.git');
  if (!fs.existsSync(dotgit) || fs.statSync(dotgit).isDirectory()) return [];
  const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
  if (!m) return [];
  const worktreeGitDir = path.resolve(cwd, m[1].trim());
  const commonDir = path.resolve(worktreeGitDir, '..', '..');
  const name = path.basename(worktreeGitDir);
  return ['-v', `${commonDir}:/repo.git`, '-e', `GIT_DIR=/repo.git/worktrees/${name}`, '-e', 'GIT_WORK_TREE=/work'];
}

export async function runInDocker(provider: ProviderId, input: AdapterInput): Promise<AdapterResult> {
  const status = await dockerStatus();
  if (!status.docker) throw new Error(status.detail);
  if (!status.image) throw new Error('The agent image is not built yet. Build it in Settings → Docker isolation.');

  const settings: Settings = input.settings;
  const mode = settings.dockerNetwork ?? 'allowlist';
  const allow = [...DEFAULT_ALLOW, ...(settings.dockerAllow ?? [])];
  if (mode === 'allowlist') await ensureEgress(allow);

  const name = `beo-${newId()}`;
  const mount = (host: string, target: string, ro = false) => ['-v', `${host}:${target}${ro ? ':ro' : ''}`];
  const args = [
    'run', '--rm', '-i', '--name', name,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,exec,size=1g', '--tmpfs', '/home/node:rw,exec,size=1g,uid=1000,gid=1000',
    '--memory', settings.dockerMemory ?? '4g', '--cpus', String(settings.dockerCpus ?? 2), '--pids-limit', '512',
    ...mount(input.cwd, '/work'), ...gitMounts(input.cwd),
    ...mount(path.join(ROOT, 'server', 'src'), '/app/server/src', true), ...mount(path.join(ROOT, 'shared'), '/app/shared', true),
    '-e', 'BEO_DATA=/tmp/beo', '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=*',
  ];
  if (mode === 'none') args.push('--network', 'none');
  else if (mode === 'allowlist') {
    const proxy = `http://${PROXY}:3128`;
    args.push('--network', NET, '-e', `HTTPS_PROXY=${proxy}`, '-e', `HTTP_PROXY=${proxy}`, '-e', `https_proxy=${proxy}`, '-e', `http_proxy=${proxy}`, '-e', 'NO_PROXY=localhost,127.0.0.1', '-e', 'NODE_USE_ENV_PROXY=1', '-e', 'NODE_OPTIONS=--disable-warning=UNDICI-EHPA');
  } else args.push('--add-host', 'host.docker.internal:host-gateway');
  if (input.pluginPath) args.push(...mount(input.pluginPath, '/plugin', true));

  // Each agent keeps its provider state (sessions, caches, sqlite) in its own Docker volume, on a real Linux file system:
  // nothing is shared with the host's own Claude/Codex or with other agents. Only the login file is passed in;
  // the runner copies it into the volume and writes it back if the provider refreshed it.
  const volume = `beo-state-${input.agent.id.replace(/[^a-zA-Z0-9_.-]/g, '')}`;
  await docker(['volume', 'create', '--label', 'beo=1', volume]);
  args.push('-v', `${volume}:/state`);
  // The Claude Code login never goes into a container: Claude agents in Docker use an API key.
  const useClaudeKey = !!settings.anthropicApiKey;
  if (provider === 'claude') {
    if (!useClaudeKey) throw new Error('Claude agents in Docker need an Anthropic API key (Settings → Accounts). Your Claude Code login stays on this computer and is never copied into containers. Turn Docker off for this team to use the login.');
    args.push('-e', 'CLAUDE_CONFIG_DIR=/state/claude', '-e', `ANTHROPIC_API_KEY=${settings.anthropicApiKey}`);
  }
  if (provider === 'codex') {
    args.push('-e', 'CODEX_HOME=/state/codex');
    const file = path.join(os.homedir(), '.codex', 'auth.json');
    if (fs.existsSync(file)) args.push(...mount(file, '/login/codex/auth.json'));
  }
  // Attachments the user sent are mounted one by one, read-only; their host paths are rewritten for the container.
  const uploads = path.resolve(DATA, 'uploads');
  const mentioned = [...input.prompt.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim()).filter((p) => path.resolve(p).startsWith(uploads + path.sep));
  const attachments = new Map<string, string>();
  for (const file of new Set([...mentioned, ...(input.images ?? [])])) {
    if (!fs.existsSync(file)) continue;
    const inside = `/attachments/${attachments.size + 1}-${path.basename(file).replace(/[^\w.\- ()]/g, '_')}`;
    attachments.set(file, inside);
    args.push(...mount(file, inside, true));
  }
  let prompt = input.prompt;
  for (const [host, inside] of attachments) prompt = prompt.split(host).join(inside);
  const images = (input.images ?? []).map((f) => attachments.get(f)).filter((f): f is string => !!f);
  args.push(IMAGE, 'node', '/app/node_modules/tsx/dist/cli.mjs', '/app/server/src/runner.ts');

  const child = spawn('docker', args, { windowsHide: true });
  const write = (m: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(m)}\n`); };
  const onAbort = () => { void docker(['kill', name], 15_000); };
  input.signal.addEventListener('abort', onAbort, { once: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-3000); });

  const { emit, approve, signal: _signal, ...plain } = input;
  write({
    provider,
    input: {
      ...plain, prompt, images, cwd: '/work', inContainer: true,
      mcp: (plain.mcp ?? []).map((m) => (m.url ? { ...m, url: forContainer(m.url) } : m)), pluginPath: input.pluginPath ? '/plugin' : undefined,
      settings: { ...settings, claudeAuth: useClaudeKey ? 'apiKey' : 'login', localEndpoints: settings.localEndpoints.map((e) => ({ ...e, baseUrl: toHost(e.baseUrl) })) },
    },
  });

  return new Promise<AdapterResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; input.signal.removeEventListener('abort', onAbort); fn(); } };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; } // Not ours: a tool printed to stdout.
      if (msg.t === 'event') emit(msg.e);
      else if (msg.t === 'approve') void approve(msg.kind, msg.title, msg.detail).then((ok) => write({ t: 'approved', id: msg.id, ok }));
      else if (msg.t === 'result') finish(() => resolve({ text: msg.text, session: msg.session }));
      else if (msg.t === 'error') finish(() => reject(new Error(msg.message)));
    });
    child.on('error', (e) => finish(() => reject(new Error(`Could not start Docker: ${e.message}`))));
    child.on('close', (code) => finish(() => reject(new Error(input.signal.aborted ? 'aborted' : `The container stopped (exit ${code}). ${stderr.trim()}`))));
  });
}
