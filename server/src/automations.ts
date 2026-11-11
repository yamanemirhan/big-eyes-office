import { randomBytes } from 'node:crypto';
import type { Automation } from '../../shared/types.ts';
import { db, newId, store } from './store.ts';
import { sh } from './git.ts';
import { record } from './log.ts';
import type { Orchestrator } from './orchestrator.ts';

// Scheduled and webhook-triggered runs: the "trigger" half of a loop.

function fieldMatches(field: string, value: number, min: number): boolean {
  return field.split(',').some((part) => {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo = min;
    let hi = Infinity;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      if (!Number.isInteger(a)) return false;
      lo = a;
      hi = b === undefined ? (stepText ? Infinity : a) : b;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Five fields: minute hour day-of-month month day-of-week (0 = Sunday), local time. */
export function cronMatches(expr: string, date: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return fieldMatches(f[0], date.getMinutes(), 0) && fieldMatches(f[1], date.getHours(), 0) && fieldMatches(f[2], date.getDate(), 1)
    && fieldMatches(f[3], date.getMonth() + 1, 1) && fieldMatches(f[4], date.getDay(), 0);
}

export const validCron = (expr: string) => expr.trim().split(/\s+/).length === 5 && /^[\d*/,\- ]+$/.test(expr.trim());

export class Automations {
  private lastMinute = '';

  constructor(private orchestrator: Orchestrator) {
    setInterval(() => this.tick(), 20_000).unref();
  }

  list = () => db.automations();

  save(input: Partial<Automation>): Automation {
    if (!input.name?.trim()) throw new Error('Give the automation a name.');
    if (!input.task?.trim()) throw new Error('The task is empty.');
    if (!input.teamId || !store.team(input.teamId)) throw new Error('Pick a team.');
    const kind = input.kind === 'webhook' || input.kind === 'github' ? input.kind : 'schedule';
    if (kind === 'github' && !input.workdir?.trim()) throw new Error('A GitHub trigger needs the working folder of a repository connected to GitHub.');
    if (kind === 'schedule' && !validCron(input.cron ?? '')) throw new Error('The schedule must be a five-field cron expression, e.g. "0 9 * * 1-5".');
    const existing = input.id ? this.list().find((a) => a.id === input.id) : undefined;
    const automation: Automation = {
      id: existing?.id ?? newId(), name: input.name.trim(), teamId: input.teamId, task: input.task.trim(), workdir: input.workdir?.trim() ?? '',
      checkCommand: input.checkCommand?.trim() ?? '', kind, cron: input.cron?.trim() ?? '', token: existing?.token ?? randomBytes(16).toString('hex'),
      watch: input.watch ?? 'issues', intervalMin: Math.max(2, Number(input.intervalMin) || 10), seen: existing?.seen ?? [], template: input.template,
      enabled: input.enabled ?? true, lastRunAt: existing?.lastRunAt, lastRunId: existing?.lastRunId, createdAt: existing?.createdAt ?? Date.now(),
    };
    db.saveAutomation(automation);
    return automation;
  }

  delete = (id: string) => db.deleteAutomation(id);

  /** Starts a run unless the previous run of the same automation is still going. */
  fire(automation: Automation, payload?: string): { started: boolean; runId?: string; reason?: string } {
    if (automation.lastRunId && this.orchestrator.isBusy(automation.lastRunId)) return { started: false, reason: 'The previous run is still working.' };
    const task = payload ? `${automation.task}\n\nTrigger payload:\n${payload.slice(0, 20_000)}` : automation.task;
    const run = this.orchestrator.start({ teamId: automation.teamId, task, workdir: automation.workdir || undefined, checkCommand: automation.checkCommand || undefined });
    db.saveAutomation({ ...automation, lastRunAt: Date.now(), lastRunId: run.id });
    return { started: true, runId: run.id };
  }

  fireWebhook(token: string, payload: string) {
    const automation = this.list().find((a) => a.kind === 'webhook' && a.token === token);
    if (!automation) throw new Error('Unknown webhook.');
    if (!automation.enabled) return { started: false, reason: 'This automation is turned off.' };
    return this.fire(automation, payload);
  }

  private polling = new Set<string>();
  private lastPoll = new Map<string, number>();

  /** Asks GitHub (through gh) for new issues, pull requests or failed CI runs, and starts a run for each new one. */
  private async poll(a: Automation) {
    if (this.polling.has(a.id)) return;
    this.polling.add(a.id);
    try {
      const args = a.watch === 'prs' ? ['pr', 'list', '--state', 'open', '--json', 'number,title,url,author,headRefName', '--limit', '30']
        : a.watch === 'ci' ? ['run', 'list', '--status', 'failure', '--json', 'databaseId,displayTitle,url,headBranch,workflowName,createdAt', '--limit', '20']
        : ['issue', 'list', '--state', 'open', '--json', 'number,title,url,author,body', '--limit', '30'];
      const r = await sh('gh', args, a.workdir, 30_000);
      if (!r.ok) { record(`GitHub trigger "${a.name}": ${r.out.slice(0, 300)}`); return; }
      const items = JSON.parse(r.out) as any[];
      const id = (x: any) => String(x.number ?? x.databaseId);
      const fresh = a.seen?.length || a.lastRunAt ? items.filter((x) => !a.seen!.includes(id(x))) : [];
      let seen = a.seen?.length ? a.seen : items.map(id); // The first poll only learns what already exists.
      for (const item of fresh.reverse()) {
        const result = this.fire({ ...a, seen }, JSON.stringify(item, null, 2));
        if (!result.started) break; // Busy: try again on the next poll.
        seen = [...seen, id(item)];
        a = { ...this.list().find((x) => x.id === a.id)!, seen };
      }
      db.saveAutomation({ ...this.list().find((x) => x.id === a.id)!, seen: seen.slice(-500) });
    } catch (e) {
      record(`GitHub trigger "${a.name}" failed: ${(e as Error).message}`);
    } finally {
      this.polling.delete(a.id);
    }
  }

  private tick() {
    for (const a of this.list()) {
      if (a.kind !== 'github' || !a.enabled) continue;
      if (Date.now() - (this.lastPoll.get(a.id) ?? 0) < (a.intervalMin ?? 10) * 60_000) continue;
      this.lastPoll.set(a.id, Date.now());
      void this.poll(a);
    }
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    for (const a of this.list()) {
      if (a.kind !== 'schedule' || !a.enabled || !cronMatches(a.cron, now)) continue;
      try { this.fire(a); } catch (e) { console.error(`Automation "${a.name}" could not start: ${(e as Error).message}`); }
    }
  }
}
