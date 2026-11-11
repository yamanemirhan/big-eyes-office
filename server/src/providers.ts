import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderModel, ProviderStatus, Settings } from '../../shared/types.ts';
import { usesApiKey, withCodex } from './codexrpc.ts';
import { isOllama, ollamaModels } from './ollama.ts';

let codexCache: { at: number; key: string; models: ProviderModel[]; account: string } | null = null;

/** Models and login as Codex itself reports them. Works with the ChatGPT login and with an API key. */
async function codexInfo(settings: Settings): Promise<{ models: ProviderModel[]; account: string } | null> {
  const key = `${usesApiKey(settings)}`;
  if (codexCache && codexCache.key === key && Date.now() - codexCache.at < 10 * 60_000) return codexCache;
  try {
    const info = await withCodex(settings, async (rpc) => {
      const acc = await rpc.call('account/read', {});
      const list = await rpc.call('model/list', { limit: 100 });
      const account = acc.account?.type === 'chatgpt' ? `ChatGPT login${acc.account.email ? ` (${acc.account.email})` : ''}, plan ${acc.account.planType}` : acc.account?.type === 'apiKey' ? 'OpenAI API key' : '';
      return { account, models: (list.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ id: m.model, label: `${m.displayName}${m.isDefault ? ' (default)' : ''}` })) };
    });
    codexCache = { at: Date.now(), key, ...info };
    return info;
  } catch {
    return null;
  }
}

const CLAUDE_FALLBACK: ProviderModel[] = [
  { id: 'opus', label: 'opus (latest Opus)' },
  { id: 'sonnet', label: 'sonnet (latest Sonnet)' },
  { id: 'haiku', label: 'haiku (latest Haiku)' },
  { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' },
];

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const home = (...p: string[]) => path.join(os.homedir(), ...p);

/** The model Codex uses when an agent leaves the model empty, read from the user's Codex config. */
export function codexDefaultModel(): string {
  try {
    const top = fs.readFileSync(home('.codex', 'config.toml'), 'utf8').split(/^\[/m)[0];
    return /^model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** Model names Codex has cached locally, if any. The file layout is Codex's own, so this reads it loosely. */
function codexKnownModels(): string[] {
  const found = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'slug' || k === 'id' || k === 'model') && typeof x === 'string' && /^(gpt|o\d|codex)[\w.\-]*$/i.test(x)) found.add(x);
        else visit(x);
      }
    }
  };
  try {
    for (const f of fs.readdirSync(home('.codex')).filter((n) => /model/i.test(n) && n.endsWith('.json'))) {
      try { visit(JSON.parse(fs.readFileSync(home('.codex', f), 'utf8'))); } catch { /* not JSON we understand */ }
    }
  } catch { /* no Codex folder */ }
  const fallback = codexDefaultModel();
  if (fallback) found.add(fallback);
  return [...found].sort();
}

export async function providerStatuses(settings: Settings, usedModels: string[] = []): Promise<ProviderStatus[]> {
  const anthropicKey = settings.claudeAuth === 'login' ? undefined : settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const listKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const openaiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;

  const [codex, claudeModels, openaiModels, ...locals] = await Promise.all([
    codexInfo(settings),
    listKey ? getJson('https://api.anthropic.com/v1/models?limit=100', { 'x-api-key': listKey, 'anthropic-version': '2023-06-01' }) : null,
    openaiKey ? getJson('https://api.openai.com/v1/models', { authorization: `Bearer ${openaiKey}` }) : null,
    ...settings.localEndpoints.map(async (e) => {
      if (isOllama(e)) { const models = await ollamaModels(e); return models ? { ollama: models } : null; }
      return getJson(`${e.baseUrl.replace(/\/+$/, '')}/models`, e.apiKey ? { authorization: `Bearer ${e.apiKey}` } : {});
    }),
  ]);

  const claudeLogin = fs.existsSync(home('.claude', '.credentials.json'));
  const codexLogin = fs.existsSync(home('.codex', 'auth.json'));

  const statuses: ProviderStatus[] = [
    {
      id: 'claude', provider: 'claude', name: 'Claude',
      ok: !!anthropicKey || claudeLogin,
      note: anthropicKey ? (claudeModels ? 'Using the API key (billed per use; needs credit).' : 'API key is set but the model list could not be loaded.')
        : claudeLogin ? 'Using the Claude Code login found on this machine.'
        : settings.claudeAuth === 'login' ? 'No Claude Code login on this machine: install Claude Code and sign in, or use an API key.' : 'Add an Anthropic API key in Settings.',
      models: claudeModels?.data?.map((m: any) => ({ id: m.id, label: m.display_name })) ?? CLAUDE_FALLBACK,
    },
    {
      id: 'codex', provider: 'codex', name: 'Codex (OpenAI)',
      ok: !!codex?.account || !!openaiKey || codexLogin,
      note: codex?.account ? `Using ${codex.account}.${openaiKey && !usesApiKey(settings) ? ' Your API key is not used for Codex; switch in Settings → Accounts.' : ''}`
        : openaiKey ? (openaiModels ? 'API key works.' : 'API key is set but the model list could not be loaded.')
        : codexLogin ? `Using the Codex login found on this machine. Default model: ${codexDefaultModel() || 'set by Codex'}. With a ChatGPT login there is no model list to fetch: type the model name, or leave it empty for the default.`
        : 'Run "codex login" in a terminal, or add an OpenAI API key in Settings.',
      models: codex?.models.length ? codex.models
        : openaiModels?.data
        ? (openaiModels.data as any[]).map((m) => ({ id: m.id as string }))
          .filter((m: ProviderModel) => /^(gpt|o\d|codex)/.test(m.id) && !/audio|realtime|image|tts|transcribe|embedding|search/.test(m.id))
          .sort((a: ProviderModel, b: ProviderModel) => b.id.localeCompare(a.id))
        // No API key: OpenAI offers no model list for the ChatGPT login, so suggest what Codex has cached and what your teams already use.
        : [...new Set([...codexKnownModels(), ...usedModels])].map((id) => ({ id })),
    },
    ...settings.localEndpoints.map((e, i): ProviderStatus => {
      const models: ProviderModel[] = locals[i]?.ollama ?? (locals[i]?.data ?? []).map((m: any) => ({ id: m.id }));
      const noTools = locals[i]?.ollama ? models.filter((m) => !m.capabilities?.includes('tools')).length : 0;
      return {
        id: `local:${e.id}`, provider: 'local', endpointId: e.id, name: e.name,
        ok: !!locals[i],
        note: !locals[i] ? `Not reachable at ${e.baseUrl}. Start it, then refresh.`
          : !models.length ? 'Running, but no models yet. Download one below.'
          : `${models.length} model${models.length === 1 ? '' : 's'} available.${noTools ? ` ${noTools} cannot use tools (text answers only).` : ''}`,
        models,
      };
    }),
    { id: 'demo', provider: 'demo', name: 'Demo (simulated)', ok: true, note: 'No account needed.', models: [] },
  ];
  return statuses;
}
