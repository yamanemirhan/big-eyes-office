import { useEffect, useState } from 'react';
import type { Approval, Question, Run, RunEvent, Task } from '../../../shared/types.ts';

/** Latest version of every task in a run, in creation order. */
export function tasksOf(run: Run | undefined): Task[] {
  const map = new Map<string, Task>();
  for (const e of run?.events ?? []) if (e.type === 'task') map.set(e.task.id, e.task);
  return [...map.values()];
}

export function approvalsOf(run: Run | undefined): Approval[] {
  const map = new Map<string, Approval>();
  for (const e of run?.events ?? []) if (e.type === 'approval') map.set(e.approval.id, e.approval);
  return [...map.values()];
}

export function questionsOf(run: Run | undefined): Question[] {
  const map = new Map<string, Question>();
  for (const e of run?.events ?? []) if (e.type === 'question') map.set(e.question.id, e.question);
  return [...map.values()];
}

/** The final answer repeats the agent's last message; show it once. */
export function withoutRepeats(events: RunEvent[]): RunEvent[] {
  const hide = new Set<number>();
  for (const e of events) {
    if (e.type !== 'message' || e.kind !== 'final') continue;
    for (let i = events.indexOf(e) - 1; i >= 0 && i > events.indexOf(e) - 8; i--) {
      const p = events[i];
      if (p.type === 'message' && p.kind === 'say' && p.agentId === e.agentId && p.text.trim() === e.text.trim()) { hide.add(p.seq); break; }
    }
  }
  return hide.size ? events.filter((e) => !hide.has(e.seq)) : events;
}

/** Re-renders every second while active, for live durations. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n ?? 0));
