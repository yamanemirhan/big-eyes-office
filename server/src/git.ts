import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import type { GitInfo } from '../../shared/types.ts';
import { DATA } from './store.ts';

export interface Out { ok: boolean; out: string }

export function sh(file: string, args: string[], cwd: string, timeout = 60_000): Promise<Out> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() });
    });
  });
}
export const git = (cwd: string, ...args: string[]) => sh('git', args, cwd);

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const insideData = (dir: string) => {
  const rel = path.relative(norm(DATA), norm(dir));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

export async function isRepo(dir: string) {
  // --show-cdup is empty at the top of a repository, so no path spellings need comparing.
  const r = await git(dir, 'rev-parse', '--is-inside-work-tree', '--show-cdup');
  const [inside, cdup = ''] = r.out.split('\n').map((l) => l.trim());
  if (!r.ok || inside !== 'true') return false;
  // Folders the office makes for itself never borrow a repository they happen to sit inside.
  return !insideData(dir) || cdup === '';
}

/** Scratch folders get a repository of their own, so nothing an agent runs there reaches a parent repository. */
export function initScratch(dir: string) {
  try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', windowsHide: true, timeout: 15_000 }); } catch { /* git missing: the folder still works */ }
}

/** A repo without commits cannot have worktrees. */
export const hasCommits = async (dir: string) => (await git(dir, 'rev-parse', '--verify', 'HEAD')).ok;

export interface Worktree { dir: string; branch: string; repo: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';

export async function createWorktree(repo: string, runId: string, taskId: string, label: string): Promise<Worktree> {
  const branch = `beo/${runId}/${slug(label)}-${taskId}`;
  const dir = path.join(DATA, 'worktrees', runId, taskId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(repo, 'worktree', 'add', '-b', branch, dir, 'HEAD');
  if (!r.ok) throw new Error(`Could not create a worktree: ${r.out}`);
  return { dir, branch, repo };
}

export async function removeWorktree(wt: Worktree, deleteBranch: boolean) {
  await git(wt.repo, 'worktree', 'remove', '--force', wt.dir);
  if (deleteBranch) await git(wt.repo, 'branch', '-D', wt.branch);
}

/** Commits everything in the directory. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, 'add', '-A');
  if ((await git(dir, 'diff', '--cached', '--quiet')).ok) return false;
  const hasIdentity = (await git(dir, 'config', 'user.email')).ok;
  const identity = hasIdentity ? [] : ['-c', 'user.name=Big Eyes Office', '-c', 'user.email=office@localhost'];
  const r = await git(dir, ...identity, 'commit', '-m', message.slice(0, 200));
  if (!r.ok) throw new Error(`Commit failed: ${r.out}`);
  return true;
}

export const diffStat = async (repo: string, branch: string) => (await git(repo, 'diff', '--stat', `HEAD...${branch}`)).out;

export async function mergeBranch(repo: string, branch: string): Promise<{ ok: boolean; detail: string }> {
  const hasIdentity = (await git(repo, 'config', 'user.email')).ok;
  const identity = hasIdentity ? [] : ['-c', 'user.name=Big Eyes Office', '-c', 'user.email=office@localhost'];
  const r = await git(repo, ...identity, 'merge', '--no-ff', '--no-edit', branch);
  if (r.ok) return { ok: true, detail: '' };
  const conflicts = (await git(repo, 'diff', '--name-only', '--diff-filter=U')).out;
  await git(repo, 'merge', '--abort');
  return { ok: false, detail: conflicts ? `Conflicting files:\n${conflicts}` : r.out };
}

export async function openPr(repo: string, branch: string, title: string, body: string): Promise<string> {
  const push = await git(repo, 'push', '-u', 'origin', branch);
  if (!push.ok) throw new Error(`Push failed: ${push.out}`);
  const pr = await sh('gh', ['pr', 'create', '--head', branch, '--title', title.slice(0, 120), '--body', body.slice(0, 4000)], repo);
  if (!pr.ok) throw new Error(`Could not open a pull request (is the GitHub CLI "gh" installed and logged in?): ${pr.out}`);
  return pr.out.split('\n').find((l) => l.startsWith('http')) ?? pr.out;
}

export async function gitInfo(dir: string): Promise<GitInfo> {
  const empty: GitInfo = { isRepo: false, branch: '', branches: [], changes: [], remote: '', gh: false, prs: [] };
  if (!fs.existsSync(dir) || !(await isRepo(dir))) return empty;
  const [branch, branches, status, remote, ghVersion] = await Promise.all([
    git(dir, 'branch', '--show-current'), git(dir, 'branch', '--format=%(refname:short)'), git(dir, 'status', '--porcelain'),
    git(dir, 'remote', 'get-url', 'origin'), sh('gh', ['--version'], dir, 5000),
  ]);
  let prs: GitInfo['prs'] = [];
  if (ghVersion.ok && remote.ok) {
    const r = await sh('gh', ['pr', 'list', '--json', 'number,title,headRefName,url,isDraft', '--limit', '30'], dir, 20_000);
    try { if (r.ok) prs = JSON.parse(r.out); } catch { /* gh printed something that is not JSON, e.g. a login prompt */ }
  }
  return {
    isRepo: true, branch: branch.out.trim(), branches: branches.out.split('\n').map((b) => b.trim()).filter(Boolean),
    changes: status.out.split('\n').filter(Boolean), remote: remote.ok ? remote.out.trim() : '', gh: ghVersion.ok, prs,
  };
}
