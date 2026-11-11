// Evaluations: fixed tasks with automatic checks, run against a team. Run them after changing a team, a model
// or the instructions, and compare the pass rate, tokens and time with earlier results.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import type { EvalResult, EvalSuite } from '../../shared/types.ts';
import { DATA, newId } from './store.ts';
import type { Orchestrator } from './orchestrator.ts';

const SUITES = path.join(DATA, 'evals.json');
const RESULTS = path.join(DATA, 'eval-results.json');

const STARTER: EvalSuite[] = [{
  id: 'basics', name: 'Basics',
  tasks: [
    { id: 'math', prompt: 'What is 12 times 12? Answer with the number only.', check: { kind: 'contains', value: '144' } },
    { id: 'file', prompt: 'Create hello.js that prints exactly: Hello from the office', check: { kind: 'command', value: 'node hello.js' } },
    { id: 'func', prompt: 'Create sum.js that exports a function sum(a, b) returning a + b (CommonJS, module.exports).', check: { kind: 'command', value: 'node -e "process.exit(require(\'./sum.js\').sum(2, 3) === 5 ? 0 : 1)"' } },
  ],
}];

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export const evalSuites = (): EvalSuite[] => readJson(SUITES, STARTER);
export const evalResults = (): EvalResult[] => readJson<EvalResult[]>(RESULTS, []);

export function saveSuites(suites: EvalSuite[]) {
  const clean = suites.map((s) => ({
    id: s.id || newId(), name: String(s.name || 'Suite'),
    tasks: (s.tasks ?? []).filter((t) => t.prompt?.trim()).map((t) => ({
      id: t.id || newId(), prompt: String(t.prompt), check: { kind: t.check?.kind === 'command' ? 'command' as const : 'contains' as const, value: String(t.check?.value ?? '') },
    })),
  }));
  fs.writeFileSync(SUITES, JSON.stringify(clean, null, 2));
  return clean;
}

function saveResult(r: EvalResult) {
  const all = evalResults().filter((x) => x.id !== r.id);
  fs.writeFileSync(RESULTS, JSON.stringify([r, ...all].slice(0, 200), null, 2));
}

const sh = (cmd: string, cwd: string) => new Promise<boolean>((resolve) => exec(cmd, { cwd, timeout: 60_000, windowsHide: true }, (err) => resolve(!err)));

/** Runs every task of a suite as its own run, one after another, without questions or approvals. */
export function runEval(orchestrator: Orchestrator, suiteId: string, teamId: string): EvalResult {
  const suite = evalSuites().find((s) => s.id === suiteId);
  if (!suite?.tasks.length) throw new Error('That suite has no tasks.');
  const result: EvalResult = { id: newId(), suiteId, teamId, teamName: '', at: Date.now(), status: 'running', items: suite.tasks.map((t) => ({ taskId: t.id })) };
  saveResult(result);
  void (async () => {
    for (const [i, task] of suite.tasks.entries()) {
      const item = result.items[i];
      try {
        const started = orchestrator.start({ teamId, task: task.prompt, mode: 'team', unattended: true });
        result.teamName = started.team.name;
        result.versions = started.versions;
        item.runId = started.id;
        saveResult(result);
        let run = orchestrator.get(started.id)!;
        const deadline = Date.now() + 15 * 60_000;
        while (run.status === 'running' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          run = orchestrator.get(started.id)!;
        }
        if (run.status === 'running') { orchestrator.stop(run.id); item.note = 'timed out'; }
        const final = [...run.events].reverse().find((e) => e.type === 'message' && e.kind === 'final');
        const text = final?.type === 'message' ? final.text : '';
        item.pass = run.status === 'done' && (task.check.kind === 'contains'
          ? text.toLowerCase().includes(task.check.value.toLowerCase())
          : await sh(task.check.value, run.workdir));
        item.tokens = run.events.reduce((n, e) => (e.type === 'usage' ? n + e.inputTokens + e.outputTokens : n), 0);
        item.secs = Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000);
        if (run.status !== 'done') item.note ??= run.status;
      } catch (e) {
        item.pass = false;
        item.note = (e as Error).message.slice(0, 200);
      }
      saveResult(result);
    }
    result.status = 'done';
    saveResult(result);
  })();
  return result;
}
