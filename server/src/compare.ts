import fs from 'node:fs';
import path from 'node:path';
import type { Run } from '../../shared/types.ts';
import { DATA, db, newId, store } from './store.ts';
import { commitAll, createWorktree, git, hasCommits, initScratch, isRepo, mergeBranch } from './git.ts';
import { withRepoLock } from './locks.ts';
import type { Orchestrator } from './orchestrator.ts';

// Same task, several teams, separate copies: each team works on its own branch (or its own scratch folder),
// so the results can be compared side by side and the best one merged.

export interface CompareInput { teamIds: string[]; task: string; workdir?: string; checkCommand?: string }

export async function startCompare(orch: Orchestrator, input: CompareInput): Promise<{ compareId: string; runs: Run[] }> {
  const teamIds = [...new Set(input.teamIds)].filter((id) => store.team(id));
  if (teamIds.length < 2) throw new Error('Pick at least two teams to compare.');
  if (!input.task?.trim()) throw new Error('The task is empty.');
  const compareId = newId();
  const repo = input.workdir?.trim();
  if (repo && !((await isRepo(repo)) && (await hasCommits(repo)))) {
    throw new Error('Comparing in a folder needs a git repository with at least one commit, so each team gets its own branch. Make it a repository in the Git tab, or leave the folder empty to compare in fresh scratch folders.');
  }
  const runs: Run[] = [];
  for (const teamId of teamIds) {
    const team = store.team(teamId)!;
    let workdir: string;
    let branch: string | undefined;
    if (repo) {
      const wt = await createWorktree(repo, `compare-${compareId}`, newId(), team.name);
      workdir = wt.dir;
      branch = wt.branch;
    } else {
      workdir = path.join(DATA, 'compare', compareId, team.id);
      fs.mkdirSync(workdir, { recursive: true });
      initScratch(workdir);
    }
    runs.push(orch.start({ teamId, task: input.task, workdir, checkCommand: input.checkCommand, compare: { id: compareId, branch, repo } }));
  }
  return { compareId, runs };
}

const compareRuns = (orch: Orchestrator, id: string) => orch.list().filter((r) => r.compare?.id === id);

/** Commits the chosen team's work and merges its branch into the repository's current branch. */
export async function keepCompare(orch: Orchestrator, id: string, runId: string): Promise<string> {
  const run = compareRuns(orch, id).find((r) => r.id === runId);
  if (!run?.compare?.repo || !run.compare.branch) throw new Error('Only comparisons made in a git repository can be merged.');
  const { repo, branch } = run.compare;
  await commitAll(run.workdir, `${run.team.name}: ${run.task.slice(0, 80)}`);
  const dirty = (await git(repo, 'status', '--porcelain')).out.trim();
  if (dirty) throw new Error(`The repository has uncommitted changes, so nothing was merged. Commit or discard them in the Git tab first:\n${dirty.split('\n').slice(0, 8).join('\n')}`);
  const merged = await withRepoLock(repo, () => mergeBranch(repo, branch));
  if (!merged.ok) throw new Error(`Could not merge ${branch}. ${merged.detail}`);
  return `Merged ${branch} into the current branch.`;
}

/** Removes the comparison's branches and folders. Runs and their history stay. */
export async function discardCompare(orch: Orchestrator, id: string) {
  for (const run of compareRuns(orch, id)) {
    if (orch.isBusy(run.id)) throw new Error('A run of this comparison is still working. Stop it first.');
    if (run.compare?.repo && run.compare.branch) {
      await git(run.compare.repo, 'worktree', 'remove', '--force', run.workdir);
      await git(run.compare.repo, 'branch', '-D', run.compare.branch);
    } else {
      fs.rmSync(run.workdir, { recursive: true, force: true });
    }
    run.compare = { ...run.compare!, discarded: true };
    db.saveRun(run);
  }
}
