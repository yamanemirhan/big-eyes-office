import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudePlan, Settings } from '../../shared/types.ts';
import { DATA } from './store.ts';

// Claude subscription limits. Two sources: a live read through Claude Code's /usage data (experimental SDK API),
// and the rate-limit events Claude Code sends during every agent turn, kept in data/claude-plan.json.

const file = path.join(DATA, 'claude-plan.json');
const LABELS: Record<string, string> = {
  five_hour: '5-hour window', seven_day: 'Weekly (all models)', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_oauth_apps: 'Weekly (apps)', seven_day_overage_included: 'Weekly (included)',
};

export const claudeUsesLogin = (s: Settings) => s.claudeAuth === 'login' || (s.claudeAuth !== 'apiKey' && !s.anthropicApiKey);

function readStored(): ClaudePlan | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Called for every rate_limit_event from a Claude agent turn. */
export function recordRateLimit(info: any) {
  const prev = readStored() ?? { mode: 'login', limits: [] };
  const name = LABELS[info.rateLimitType] ?? info.rateLimitType ?? 'Plan';
  const limits = prev.limits.filter((l) => l.name !== name);
  if (typeof info.utilization === 'number') limits.push({ name, usedPercent: info.utilization <= 1 ? info.utilization * 100 : info.utilization, resetsAt: info.resetsAt ? info.resetsAt * 1000 : null });
  const next: ClaudePlan = {
    ...prev, mode: 'login', limits, source: 'last-run', at: Date.now(),
    extraUsage: info.overageEnabled === undefined ? prev.extraUsage : { enabled: !!info.overageEnabled, usedUsd: prev.extraUsage?.usedUsd ?? null, limitUsd: prev.extraUsage?.limitUsd ?? null },
  };
  try { fs.writeFileSync(file, JSON.stringify(next, null, 2)); } catch { /* not important enough to fail a turn */ }
}

/** Asks Claude Code for the plan's limits without sending a prompt. Uses an experimental SDK call; falls back to the last turn's data. */
export async function claudePlan(settings: Settings): Promise<ClaudePlan> {
  if (!claudeUsesLogin(settings)) return { mode: 'apiKey', limits: [] };
  const stored = readStored();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25_000);
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const env = { ...(process.env as Record<string, string>) };
    delete env.ANTHROPIC_API_KEY;
    // A prompt stream that never sends anything: the session starts, answers the usage request, and is closed.
    const idle = (async function* () { await new Promise<void>((r) => abort.signal.addEventListener('abort', () => r(), { once: true })); })();
    const q: any = query({ prompt: idle as any, options: { cwd: os.tmpdir(), env, abortController: abort, persistSession: false } as any });
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!u.subscription_type && !u.rate_limits_available) return { mode: 'none', limits: [], error: 'Not signed in to Claude Code with a Claude plan.' };
    const r = u.rate_limits ?? {};
    const limits: ClaudePlan['limits'] = [];
    for (const [key, w] of Object.entries(r)) {
      if (key === 'model_scoped' || key === 'extra_usage' || !w || typeof (w as any).utilization !== 'number') continue;
      limits.push({ name: LABELS[key] ?? key, usedPercent: (w as any).utilization, resetsAt: (w as any).resets_at ? Date.parse((w as any).resets_at) : null });
    }
    for (const m of r.model_scoped ?? []) if (typeof m.utilization === 'number') limits.push({ name: `Weekly (${m.display_name})`, usedPercent: m.utilization, resetsAt: m.resets_at ? Date.parse(m.resets_at) : null });
    const x = r.extra_usage;
    const plan: ClaudePlan = {
      mode: 'login', plan: u.subscription_type, limits, source: 'live', at: Date.now(),
      extraUsage: x ? { enabled: !!x.is_enabled, usedUsd: x.used_credits == null ? null : x.used_credits / 100, limitUsd: x.monthly_limit == null ? null : x.monthly_limit / 100 } : null,
    };
    fs.writeFileSync(file, JSON.stringify(plan, null, 2));
    return plan;
  } catch (e) {
    if (stored) return { ...stored, mode: 'login', error: `Live read failed (${(e as Error).message}); showing the last known values.` };
    return { mode: 'login', limits: [], error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
