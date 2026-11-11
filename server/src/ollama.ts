// Ollama specifics: its native API gives the context length, thinking, images and model capabilities
// that the OpenAI-compatible endpoint hides. Other local servers (LM Studio, vLLM) use the compatible API.
import type { LocalEndpoint, ProviderModel } from '../../shared/types.ts';

export const DEFAULT_CONTEXT = 32_768;

export const isOllama = (e: LocalEndpoint) => e.kind === 'ollama' || (e.kind !== 'openai' && /:11434(\/|$)/.test(e.baseUrl));

/** http://localhost:11434/v1 → http://localhost:11434 */
export const ollamaRoot = (e: LocalEndpoint) => e.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

/** Inside a container, "localhost" is the container itself; the host is host.docker.internal. */
export const forContainer = (url: string) => url.replace(/\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/, '//host.docker.internal');

interface ShowInfo { capabilities: string[]; parameterSize?: string; contextLength?: number }
const showCache = new Map<string, ShowInfo>();

async function show(root: string, model: string, digest: string): Promise<ShowInfo> {
  const key = `${root}|${model}|${digest}`;
  const hit = showCache.get(key);
  if (hit) return hit;
  const res = await fetch(`${root}/api/show`, { method: 'POST', body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000) });
  const data = res.ok ? ((await res.json()) as any) : {};
  const info = data.model_info ?? {};
  const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'));
  const result: ShowInfo = {
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    parameterSize: data.details?.parameter_size,
    contextLength: ctxKey ? Number(info[ctxKey]) : undefined,
  };
  if (res.ok) showCache.set(key, result);
  return result;
}

/** Installed models with what each can do (tools, vision, thinking), or null when Ollama is not running. */
export async function ollamaModels(e: LocalEndpoint): Promise<ProviderModel[] | null> {
  const root = ollamaRoot(e);
  const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(4000) }).catch(() => null);
  if (!res?.ok) return null;
  const tags = ((await res.json()) as any).models ?? [];
  const models = await Promise.all(tags.map(async (m: any): Promise<ProviderModel | null> => {
    const info = await show(root, m.name, m.digest ?? '').catch((): ShowInfo => ({ capabilities: [] }));
    if (info.capabilities.length && !info.capabilities.includes('completion')) return null; // embedding models
    const caps = info.capabilities.filter((c) => c === 'tools' || c === 'vision' || c === 'thinking');
    const size = info.parameterSize ?? m.details?.parameter_size;
    return {
      id: m.name,
      label: [m.name, size, caps.join(', ')].filter(Boolean).join(' · '),
      capabilities: info.capabilities,
    };
  }));
  return models.filter((m): m is ProviderModel => !!m);
}

export async function modelCapabilities(e: LocalEndpoint, model: string, base = ollamaRoot(e)): Promise<string[]> {
  return (await show(base, model, '').catch((): ShowInfo => ({ capabilities: [] }))).capabilities;
}

// Model downloads started from Settings. Progress is kept here and read by the UI.
export interface PullState { model: string; status: string; percent?: number; done: boolean; error?: string }
const pulls = new Map<string, PullState>();

export const pullStates = () => [...pulls.values()];

export function startPull(e: LocalEndpoint, model: string): PullState {
  const name = model.trim();
  if (!/^[\w.\-/:]+$/.test(name)) throw new Error('That does not look like a model name, for example "qwen3:8b".');
  const existing = pulls.get(name);
  if (existing && !existing.done) return existing;
  const state: PullState = { model: name, status: 'starting', done: false };
  pulls.set(name, state);
  void (async () => {
    try {
      const res = await fetch(`${ollamaRoot(e)}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }) });
      if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      for await (const line of ndjson(res.body)) {
        if (line.error) throw new Error(line.error);
        state.status = line.status ?? state.status;
        state.percent = line.total ? Math.round((100 * (line.completed ?? 0)) / line.total) : state.percent;
      }
      state.status = 'ready';
      state.percent = 100;
    } catch (err) {
      const msg = (err as Error).message;
      state.error = /manifest|file does not exist|not found/i.test(msg)
        ? `No model called "${name}" in the Ollama library. Check the exact name (with its tag) on ollama.com/library.`
        : /fetch failed|ECONNREFUSED/i.test(msg) ? 'Ollama is not running. Start it and try again.' : msg;
      state.status = 'failed';
    }
    state.done = true;
  })();
  return state;
}

export async function deleteModel(e: LocalEndpoint, model: string) {
  const res = await fetch(`${ollamaRoot(e)}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model }) });
  if (!res.ok) throw new Error(`Ollama could not remove ${model}: ${(await res.text()).slice(0, 200)}`);
  pulls.delete(model);
}

/** Reads a newline-delimited JSON stream. */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}
