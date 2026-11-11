import fs from 'node:fs';
import path from 'node:path';

// Coordination between runs that share a folder or a repository.

const key = (dir: string) => {
  try { return fs.realpathSync.native(dir).toLowerCase(); } catch { return path.resolve(dir).toLowerCase(); }
};

const repoLocks = new Map<string, Promise<unknown>>();

/** One merge (or other change to the main working tree) at a time per repository, across all runs. */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const k = key(repo);
  const prev = repoLocks.get(k) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  repoLocks.set(k, next.catch(() => {}));
  return next;
}

interface Holder { runId: string; shared: boolean }
const folders = new Map<string, { holders: Holder[]; waiters: (() => void)[] }>();

/**
 * Waits until the folder is free for this run. Runs whose teammates each work on their own branch can share a folder;
 * any other run gets it alone, so two teams never edit the same files at the same time.
 */
export async function acquireFolder(dir: string, runId: string, shared: boolean, onWait: (blockers: string[]) => void, signal: AbortSignal): Promise<() => void> {
  const k = key(dir);
  const slot = folders.get(k) ?? { holders: [], waiters: [] };
  folders.set(k, slot);
  const free = () => slot.holders.every((h) => h.runId === runId) || (shared && slot.holders.every((h) => h.shared));
  let warned = false;
  while (!free()) {
    if (signal.aborted) throw new Error('aborted');
    if (!warned) { onWait(slot.holders.map((h) => h.runId)); warned = true; }
    await new Promise<void>((resolve) => {
      slot.waiters.push(resolve);
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
  const holder = { runId, shared };
  slot.holders.push(holder);
  return () => {
    slot.holders = slot.holders.filter((h) => h !== holder);
    const waiting = slot.waiters.splice(0);
    waiting.forEach((w) => w());
  };
}
