import { spawn, type ChildProcess } from 'node:child_process';
import type { ShellChunk, ShellsState } from '../../shared/types.ts';
import { newId } from './store.ts';
import { record } from './log.ts';

// Shells for the user in a working folder. With @lydell/node-pty (prebuilt, optional) they are real terminals:
// colours, prompts, full-screen programs. Without it they fall back to a piped shell that takes one line at a time.

interface PtyLike { onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; write(d: string): void; resize(c: number, r: number): void; kill(): void; pid: number }
interface Session { root: string; startedAt: number; pty?: PtyLike; child?: ChildProcess }

let ptyModule: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike } | null | undefined;
async function loadPty() {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = (await import('@lydell/node-pty' as string)) as any;
  } catch (e) {
    record(`node-pty is not available, shells use line mode: ${(e as Error).message}`);
    ptyModule = null;
  }
  return ptyModule;
}

export class Shells {
  private sessions = new Map<string, Session>();
  constructor(private broadcast: (c: ShellChunk) => void) { void loadPty(); }

  async state(): Promise<ShellsState> {
    return { pty: !!(await loadPty()), sessions: [...this.sessions.entries()].map(([id, s]) => ({ id, root: s.root, startedAt: s.startedAt })) };
  }

  async open(root: string, cols = 100, rows = 30): Promise<string> {
    const id = newId();
    const send = (m: Omit<ShellChunk, 'shellId'>) => this.broadcast({ shellId: id, ...m });
    const pty = await loadPty();
    const win = process.platform === 'win32';
    if (pty) {
      const p = pty.spawn(win ? 'powershell.exe' : process.env.SHELL || 'bash', win ? ['-NoLogo'] : ['-l'], {
        name: 'xterm-256color', cols, rows, cwd: root, env: { ...process.env, TERM: 'xterm-256color' },
      });
      p.onData((d) => send({ chunk: d }));
      p.onExit((e) => { this.sessions.delete(id); send({ done: true, code: e.exitCode }); });
      this.sessions.set(id, { root, startedAt: Date.now(), pty: p });
    } else {
      const child = win
        ? spawn('cmd.exe', ['/Q', '/K', 'prompt $P$G$_'], { cwd: root, windowsHide: true })
        : spawn('bash', ['--noprofile', '--norc'], { cwd: root });
      child.stdout?.on('data', (d) => send({ chunk: String(d) }));
      child.stderr?.on('data', (d) => send({ chunk: String(d) }));
      child.on('error', (e) => send({ chunk: `${e.message}\n` }));
      child.on('close', (code) => { this.sessions.delete(id); send({ done: true, code }); });
      this.sessions.set(id, { root, startedAt: Date.now(), child });
    }
    return id;
  }

  /** Raw keystrokes (terminal mode) or a line of text (line mode). */
  write(id: string, data: string, line = false) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('This shell has ended. Open a new one.');
    if (s.pty) s.pty.write(line ? `${data}\r` : data);
    else s.child?.stdin?.write(line || !data.endsWith('\n') ? `${data}\n` : data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (s?.pty && cols > 0 && rows > 0) s.pty.resize(Math.min(cols, 500), Math.min(rows, 200));
  }

  kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.pty) s.pty.kill();
    else if (process.platform === 'win32' && s.child?.pid) spawn('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { windowsHide: true });
    else s.child?.kill();
  }
}
