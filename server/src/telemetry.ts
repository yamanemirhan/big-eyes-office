// Traces in the OpenTelemetry GenAI format: a span per run, per agent turn (invoke_agent) and per tool call
// (execute_tool), with the standard gen_ai.* attributes. Kept on disk for the Trace tab, and sent to any
// OTLP/HTTP collector (Jaeger, Grafana Tempo, Langfuse, Phoenix…) when an endpoint is set in Settings.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentConfig, Run, Settings, TraceSpan } from '../../shared/types.ts';
import { DATA } from './store.ts';
import { record } from './log.ts';

const DIR = path.join(DATA, 'traces');
const id = (bytes: number) => randomBytes(bytes).toString('hex');

export const providerName = (a: Pick<AgentConfig, 'provider'>) =>
  ({ claude: 'anthropic', codex: 'openai', local: 'ollama', demo: 'demo' } as const)[a.provider];

export interface OpenSpan { span: TraceSpan; finish: (attrs?: Record<string, string | number | boolean | undefined>, error?: string) => void }

export class Tracer {
  private roots = new Map<string, { traceId: string; spanId: string }>();
  private pending: TraceSpan[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private settings: () => Settings) {}

  /** Each piece of work on a run (the task, a later message) gets its own root span in the run's trace. */
  beginRun(run: Run) {
    const traceId = run.traceId ?? id(16);
    run.traceId = traceId;
    this.roots.set(run.id, { traceId, spanId: id(8) });
  }

  /** The run's root span; every agent turn of the run hangs below it. */
  root(run: Run) {
    let r = this.roots.get(run.id);
    if (!r) {
      r = { traceId: run.traceId ?? id(16), spanId: id(8) };
      run.traceId = r.traceId;
      this.roots.set(run.id, r);
    }
    return r;
  }

  start(run: Run, name: string, attrs: TraceSpan['attributes'], parentSpanId?: string, kind: TraceSpan['kind'] = 'internal'): OpenSpan {
    const root = this.root(run);
    const span: TraceSpan = {
      traceId: root.traceId, spanId: id(8), parentSpanId: parentSpanId ?? root.spanId,
      name, kind, start: Date.now(), end: 0, attributes: { 'gen_ai.conversation.id': run.id, ...attrs }, status: 'ok',
    };
    return {
      span,
      finish: (more = {}, error) => {
        span.end = Date.now();
        for (const [k, v] of Object.entries(more)) if (v !== undefined) span.attributes[k] = v;
        if (error) { span.status = 'error'; span.attributes['error.type'] = error.slice(0, 200); }
        this.save(run.id, span);
      },
    };
  }

  /** Closes a run: its root span covers the whole run. */
  finishRun(run: Run, started: number) {
    const root = this.root(run);
    const span: TraceSpan = {
      traceId: root.traceId, spanId: root.spanId, name: `invoke_workflow ${run.team.name}`, kind: 'internal',
      start: started, end: Date.now(), status: run.status === 'failed' ? 'error' : 'ok',
      attributes: {
        'gen_ai.operation.name': 'invoke_workflow', 'gen_ai.conversation.id': run.id, 'gen_ai.agent.name': run.team.name,
        'beo.run.status': run.status, 'beo.prompt.version': run.versions?.prompt, 'beo.team.version': run.versions?.team,
      },
    };
    this.save(run.id, span);
  }

  read(runId: string): TraceSpan[] {
    try {
      return fs.readFileSync(path.join(DIR, `${runId.replace(/[^\w-]/g, '')}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  private save(runId: string, span: TraceSpan) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(path.join(DIR, `${runId.replace(/[^\w-]/g, '')}.jsonl`), `${JSON.stringify(span)}\n`);
    } catch { /* tracing never breaks a run */ }
    if (this.settings().otlpEndpoint) {
      this.pending.push(span);
      this.timer ??= setTimeout(() => void this.flush(), 2000);
    }
  }

  /** OTLP/HTTP with JSON encoding, batched every two seconds. */
  async flush() {
    this.timer = undefined;
    const { otlpEndpoint, otlpHeaders } = this.settings();
    const spans = this.pending.splice(0);
    if (!otlpEndpoint || !spans.length) return;
    try {
      const res = await fetch(`${otlpEndpoint.replace(/\/+$/, '').replace(/\/v1\/traces$/, '')}/v1/traces`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...parseHeaders(otlpHeaders) }, body: JSON.stringify(toOtlp(spans)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) record(`otlp export failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) { record(`otlp export failed: ${(e as Error).message}`); }
  }
}

/** "Authorization=Basic abc, x-tenant=me" → headers. */
export function parseHeaders(text = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[,\n]/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const value = (v: string | number | boolean) => (typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v });
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

export function toOtlp(spans: TraceSpan[]) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'big-eyes-office' } }] },
      scopeSpans: [{
        scope: { name: 'big-eyes-office', version: '0.6.0' },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}), name: s.name,
          kind: s.kind === 'client' ? 3 : 1, startTimeUnixNano: nanos(s.start), endTimeUnixNano: nanos(s.end || s.start),
          attributes: Object.entries(s.attributes).filter(([, v]) => v !== undefined && v !== '').map(([key, v]) => ({ key, value: value(v as string | number | boolean) })),
          status: { code: s.status === 'error' ? 2 : 1 },
        })),
      }],
    }],
  };
}
