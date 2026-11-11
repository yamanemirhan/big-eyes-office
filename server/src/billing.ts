import type { Billing, BillingLine, Settings } from '../../shared/types.ts';
import { withCodex } from './codexrpc.ts';
import { claudePlan } from './claudeplan.ts';

// Real figures from the providers. Anthropic and OpenAI need an admin key; Codex reads the ChatGPT plan's limits.

const day = (d: Date) => d.toISOString().slice(0, 10);

function group(lines: { label: string; usd: number }[]): BillingLine[] {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.label, (m.get(l.label) ?? 0) + l.usd);
  return [...m.entries()].map(([label, usd]) => ({ label, usd })).filter((l) => l.usd > 0.0001).sort((a, b) => b.usd - a.usd);
}

async function getJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function anthropic(key: string | undefined, days: number): Promise<Billing['anthropic']> {
  const out: Billing['anthropic'] = { configured: !!key, totalUsd: 0, lines: [], daily: [] };
  if (!key) return out;
  try {
    const start = new Date(Date.now() - days * 86_400_000);
    start.setUTCHours(0, 0, 0, 0);
    const lines: { label: string; usd: number }[] = [];
    let page: string | undefined;
    for (let i = 0; i < 6; i++) {
      const q = new URLSearchParams({ starting_at: start.toISOString(), bucket_width: '1d', limit: '31' });
      q.append('group_by[]', 'description');
      if (page) q.set('page', page);
      const r = await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
      for (const bucket of r.data ?? []) {
        let sum = 0;
        for (const x of bucket.results ?? []) {
          const usd = Number(x.amount ?? 0) / 100; // reported in cents
          sum += usd;
          lines.push({ label: x.model ?? x.description ?? x.cost_type ?? 'Other', usd });
        }
        out.daily.push({ day: String(bucket.starting_at).slice(0, 10), usd: sum });
      }
      if (!r.has_more) break;
      page = r.next_page;
    }
    out.lines = group(lines);
    out.totalUsd = out.lines.reduce((a, l) => a + l.usd, 0);
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

async function openai(key: string | undefined, days: number): Promise<Billing['openai']> {
  const out: Billing['openai'] = { configured: !!key, totalUsd: 0, lines: [], daily: [] };
  if (!key) return out;
  try {
    const start = Math.floor((Date.now() - days * 86_400_000) / 1000);
    const lines: { label: string; usd: number }[] = [];
    let page: string | undefined;
    for (let i = 0; i < 6; i++) {
      const q = new URLSearchParams({ start_time: String(start), bucket_width: '1d', limit: String(Math.min(days + 1, 180)), group_by: 'line_item' });
      if (page) q.set('page', page);
      const r = await getJson(`https://api.openai.com/v1/organization/costs?${q}`, { authorization: `Bearer ${key}` });
      for (const bucket of r.data ?? []) {
        let sum = 0;
        for (const x of bucket.results ?? []) {
          const usd = Number(x.amount?.value ?? 0);
          sum += usd;
          lines.push({ label: x.line_item ?? 'Other', usd });
        }
        out.daily.push({ day: day(new Date(bucket.start_time * 1000)), usd: sum });
      }
      if (!r.has_more) break;
      page = r.next_page;
    }
    out.lines = group(lines);
    out.totalUsd = out.lines.reduce((a, l) => a + l.usd, 0);
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

async function codex(settings: Settings): Promise<Billing['codex']> {
  const out: Billing['codex'] = { loggedIn: false, limits: [], daily: [] };
  try {
    await withCodex({ ...settings, codexAuth: 'chatgpt' }, async (rpc) => {
      const acc = await rpc.call('account/read', {});
      if (acc.account?.type !== 'chatgpt') return;
      out.loggedIn = true;
      out.plan = acc.account.planType;
      const limits = await rpc.call('account/rateLimits/read').catch(() => null);
      const snapshots = Object.values(limits?.rateLimitsByLimitId ?? {}).length ? Object.values(limits.rateLimitsByLimitId) : limits?.rateLimits ? [limits.rateLimits] : [];
      for (const s of snapshots as any[]) {
        for (const [key, w] of [['primary', s.primary], ['secondary', s.secondary]] as const) {
          if (!w) continue;
          out.limits.push({ name: `${s.limitName ?? s.limitId ?? 'Codex'} · ${key}`, usedPercent: w.usedPercent, resetsAt: w.resetsAt, windowMins: w.windowDurationMins });
        }
      }
      const usage = await rpc.call('account/usage/read', {}).catch(() => null);
      out.daily = (usage?.dailyUsageBuckets ?? []).map((b: any) => ({ day: b.startDate, tokens: Number(b.tokens) }));
    });
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

export async function billing(settings: Settings, days: number): Promise<Billing> {
  const [a, o, c, cl] = await Promise.all([anthropic(settings.anthropicAdminKey, days), openai(settings.openaiAdminKey, days), codex(settings), claudePlan(settings)]);
  return { days, anthropic: a, openai: o, codex: c, claude: cl };
}
