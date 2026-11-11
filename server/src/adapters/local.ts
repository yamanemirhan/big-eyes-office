import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import type { AgentState, LocalEndpoint } from '../../../shared/types.ts';
import { DEFAULT_CONTEXT, forContainer, isOllama, modelCapabilities, ndjson, ollamaRoot } from '../ollama.ts';
import { clip, compressOutput, type Adapter, type AdapterInput } from './types.ts';
import { openMcp, type McpSession } from '../mcp.ts';

// Agent loop for local models: Ollama through its native API, anything else (LM Studio, vLLM, hosted APIs)
// through the OpenAI-compatible API. Responses are streamed, so long answers never hit a request timeout.

const MAX_STEPS = 40;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const isImage = (file: string) => path.extname(file).toLowerCase() in IMAGE_TYPES;

interface ToolCall { id?: string; name: string; args: Record<string, string> }
interface Step { content: string; thinking: string; calls: ToolCall[]; inTok: number; outTok: number }

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

function toolsFor(autonomy: AdapterInput['autonomy']) {
  const str = (description: string) => ({ type: 'string', description });
  const tools = [
    fn('list_dir', 'List files and folders in a directory of the workspace.', { path: str('Relative path, "." for the workspace root') }, ['path']),
    fn('read_file', 'Read a text file from the workspace.', { path: str('Relative file path') }, ['path']),
    fn('search', 'Search the workspace for a regular expression. Returns file:line: text for each match.', { pattern: str('JavaScript regular expression'), path: str('Folder to search, "." for all') }, ['pattern']),
  ];
  if (autonomy !== 'read') {
    tools.push(fn('write_file', 'Create or overwrite a text file in the workspace.', { path: str('Relative file path'), content: str('Full file content') }, ['path', 'content']));
    tools.push(fn('edit_file', 'Replace one exact piece of text in a file. old_text must appear exactly once.', { path: str('Relative file path'), old_text: str('Exact text to replace'), new_text: str('Replacement text') }, ['path', 'old_text', 'new_text']));
  }
  if (autonomy === 'full') {
    tools.push(fn('run_command', 'Run a shell command in the workspace and return its output.', { command: str('The command line') }, ['command']));
  }
  return tools;
}

function inside(cwd: string, p: string) {
  const full = path.resolve(cwd, p || '.');
  const rel = path.relative(cwd, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the workspace.');
  return full;
}

function run(command: string, cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim().slice(-20_000);
      resolve(err ? `Exit code ${(err as any).code ?? 1}\n${out}` : out || '(no output)');
    });
  });
}

async function search(root: string, pattern: string): Promise<string> {
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { return 'Error: that is not a valid regular expression.'; }
  const hits: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (hits.length >= 100) return;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const stat = await fs.stat(full);
      if (stat.size > 1_000_000) continue;
      const text = await fs.readFile(full, 'utf8');
      if (text.includes('\u0000')) continue; // binary
      text.split(/\r?\n/).forEach((line, i) => {
        if (hits.length < 100 && re.test(line)) hits.push(`${path.relative(root, full).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 200)}`);
      });
    }
  };
  await walk(root);
  return hits.length ? hits.join('\n') : 'No matches.';
}

async function callTool(call: ToolCall, input: AdapterInput, mcp?: McpSession): Promise<string> {
  const { name, args } = call;
  if (name.startsWith('mcp__') && mcp) {
    const label = name.replace(/^mcp__/, '').replace('__', ' → ');
    input.emit({ type: 'state', state: 'running', detail: label });
    input.emit({ type: 'tool', tool: label, detail: clip(JSON.stringify(args)) });
    if (input.ask.commands && !(await input.approve('command', `${input.agent.name} wants to use ${label}`, clip(JSON.stringify(args), 300)))) return 'The user did not approve this tool call.';
    try { return await mcp.call(name, args); } catch (e) { return `Error: ${(e as Error).message}`; }
  }
  const states: Record<string, AgentState> = { list_dir: 'reading', read_file: 'reading', search: 'searching', write_file: 'writing', edit_file: 'writing', run_command: 'running' };
  const detail = clip(args.path ?? args.command ?? args.pattern ?? '');
  input.emit({ type: 'state', state: states[name] ?? 'thinking', detail });
  input.emit({ type: 'tool', tool: name, detail });
  try {
    if (name === 'list_dir') {
      const entries = await fs.readdir(inside(input.cwd, args.path), { withFileTypes: true });
      return entries.filter((e) => e.name !== 'node_modules' && e.name !== '.git')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
    }
    if (name === 'read_file') {
      const text = await fs.readFile(inside(input.cwd, args.path), 'utf8');
      return text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (file continues; ${text.length - 40_000} more characters. Use search to find a specific part.)` : text;
    }
    if (name === 'search') return await search(inside(input.cwd, args.path || '.'), String(args.pattern ?? ''));
    if ((name === 'write_file' || name === 'edit_file') && input.autonomy !== 'read') {
      const full = inside(input.cwd, args.path);
      let next = args.content ?? '';
      if (name === 'edit_file') {
        const text = await fs.readFile(full, 'utf8');
        const count = text.split(args.old_text ?? '').length - 1;
        if (!args.old_text || count !== 1) return `Error: old_text was found ${count} times; it must appear exactly once. Read the file and copy the text exactly.`;
        next = text.replace(args.old_text, () => args.new_text ?? '');
      }
      if (input.ask.edits && !(await input.approve('edit', `${input.agent.name} wants to ${name === 'edit_file' ? 'edit' : 'write'} a file`, args.path))) return 'The user did not approve this edit.';
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, next);
      return `${name === 'edit_file' ? 'Edited' : 'Wrote'} ${args.path}`;
    }
    if (name === 'run_command' && input.autonomy === 'full') {
      if (input.ask.commands && !(await input.approve('command', `${input.agent.name} wants to run a command`, args.command))) return 'The user did not approve this command.';
      const out = compressOutput(await run(args.command, input.cwd, input.signal));
      input.emit({ type: 'output', text: out.slice(0, 6000) });
      return out;
    }
    return `Tool ${name} is not available to you.`;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

const parseArgs = (raw: unknown): Record<string, string> => {
  if (raw && typeof raw === 'object') return raw as Record<string, string>;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; } // Malformed JSON: the tool reports what is missing.
};

function friendly(endpoint: LocalEndpoint, status: number, text: string, model: string) {
  if (status === 404 && /not found/i.test(text)) return `${endpoint.name} has no model "${model}". Download it in Settings → Local models, or run "ollama pull ${model}".`;
  return `${endpoint.name} returned ${status}: ${clip(text, 300)}`;
}

// ── Ollama native API ────────────────────────────────────────────────────────────────────────────

async function ollamaStep(base: string, body: Record<string, unknown>, signal: AbortSignal, endpoint: LocalEndpoint): Promise<Step> {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw Object.assign(new Error(friendly(endpoint, res.status, text, String(body.model))), { status: res.status, body: text });
  }
  const step: Step = { content: '', thinking: '', calls: [], inTok: 0, outTok: 0 };
  for await (const chunk of ndjson(res.body)) {
    if (chunk.error) throw new Error(`${endpoint.name}: ${chunk.error}`);
    step.content += chunk.message?.content ?? '';
    step.thinking += chunk.message?.thinking ?? '';
    for (const c of chunk.message?.tool_calls ?? []) step.calls.push({ name: c.function?.name, args: parseArgs(c.function?.arguments) });
    if (chunk.done) { step.inTok = chunk.prompt_eval_count ?? 0; step.outTok = chunk.eval_count ?? 0; }
  }
  return step;
}

// ── OpenAI-compatible API ────────────────────────────────────────────────────────────────────────

async function openaiStep(base: string, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal, endpoint: LocalEndpoint): Promise<Step> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers, signal, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw Object.assign(new Error(friendly(endpoint, res.status, text, String(body.model))), { status: res.status, body: text });
  }
  const step: Step = { content: '', thinking: '', calls: [], inTok: 0, outTok: 0 };
  const partial: { id?: string; name: string; args: string }[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk.usage) { step.inTok = chunk.usage.prompt_tokens ?? 0; step.outTok = chunk.usage.completion_tokens ?? 0; }
    const delta = chunk.choices?.[0]?.delta ?? {};
    step.content += delta.content ?? '';
    step.thinking += delta.reasoning_content ?? delta.reasoning ?? '';
    for (const c of delta.tool_calls ?? []) {
      const i = c.index ?? partial.length;
      partial[i] ??= { name: '', args: '' };
      if (c.id) partial[i].id = c.id;
      if (c.function?.name) partial[i].name += c.function.name;
      if (c.function?.arguments) partial[i].args += c.function.arguments;
    }
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, nl).trim()); buffer = buffer.slice(nl + 1); }
  }
  handle(buffer.trim());
  step.calls = partial.filter(Boolean).map((p) => ({ id: p.id, name: p.name, args: parseArgs(p.args) }));
  return step;
}

// ── The loop ─────────────────────────────────────────────────────────────────────────────────────

const thinkFor = (model: string, effort: string): boolean | string | undefined => {
  if (effort === 'default') return undefined;
  if (/gpt-oss/i.test(model)) return effort === 'xhigh' || effort === 'max' ? 'high' : effort; // levels
  return effort !== 'low';
};

export const localAdapter: Adapter = async (input) => {
  const endpoint = input.settings.localEndpoints.find((e) => e.id === input.agent.endpointId) ?? input.settings.localEndpoints[0];
  if (!endpoint) throw new Error('No local endpoint is configured. Add one in Settings → Local models.');
  const native = isOllama(endpoint);
  let base = (native ? ollamaRoot(endpoint) : endpoint.baseUrl.replace(/\/+$/, ''));
  if (input.inContainer) base = forContainer(base);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;

  let model = input.agent.model;
  if (!model) {
    const res = await fetch(native ? `${base}/api/tags` : `${base}/models`, { headers, signal: input.signal }).catch(() => null);
    const json = res?.ok ? ((await res.json()) as any) : {};
    const list: string[] = native ? (json.models ?? []).map((m: any) => m.name) : (json.data ?? []).map((m: any) => m.id);
    if (!list.length) throw new Error(res ? `${endpoint.name} has no models yet. Download one in Settings → Local models.` : `${endpoint.name} is not running at ${base}. Start it and try again.`);
    model = list[0];
  }
  const caps = native ? await modelCapabilities(endpoint, model, base) : [];
  let useTools = !input.lean && (!native || !caps.length || caps.includes('tools'));
  const seesImages = native ? caps.includes('vision') : true;
  if (native && !input.lean && !caps.includes('tools') && caps.length) input.emit({ type: 'message', kind: 'thought', text: `${model} cannot use tools, so it can only answer in text. Pick a model marked "tools" to let it work on files.` });
  const limit = native ? endpoint.contextLength || DEFAULT_CONTEXT : endpoint.contextLength || 0;

  // One request without tools: used for answers, summaries and compaction.
  const ask = async (msgs: any[], tools: unknown[] | undefined, thinkValue: boolean | string | undefined): Promise<Step> => native
    ? ollamaStep(base, {
      model, messages: msgs, stream: true, keep_alive: '30m',
      options: { num_ctx: limit },
      ...(tools ? { tools } : {}),
      ...(thinkValue !== undefined ? { think: thinkValue } : {}),
    }, input.signal, endpoint)
    : openaiStep(base, headers, {
      model, messages: msgs, ...(tools ? { tools } : {}),
      ...(input.agent.effort !== 'default' ? { reasoning_effort: input.agent.effort === 'xhigh' || input.agent.effort === 'max' ? 'high' : input.agent.effort } : {}),
    }, input.signal, endpoint);

  /** Replaces older turns with a short summary written by the model itself, keeping the system prompt and recent turns. */
  const compactMessages = async (msgs: any[]): Promise<any[]> => {
    let keepFrom = Math.max(1, msgs.length - 6);
    while (keepFrom < msgs.length && msgs[keepFrom].role === 'tool') keepFrom++; // never start with an orphaned tool result
    const old = msgs.slice(1, keepFrom);
    if (!old.length) return msgs;
    const transcript = old.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`.slice(0, 4000)).join('\n\n');
    const summary = await ask([
      { role: 'system', content: 'Summarise this agent conversation for the agent itself, in at most 250 words: the goal, decisions, files changed, current state and open items. Facts only.' },
      { role: 'user', content: transcript.slice(-60_000) },
    ], undefined, false);
    return [msgs[0], { role: 'user', content: `Summary of the earlier conversation:\n${summary.content.trim()}` }, { role: 'assistant', content: 'Understood.' }, ...msgs.slice(keepFrom)];
  };

  const shell = input.inContainer || process.platform !== 'win32' ? 'bash (Linux)' : 'cmd.exe (Windows)';
  const system = input.lean ? input.systemPrompt
    : `${input.systemPrompt}\n\nYour workspace is the current directory. Use the tools to inspect and change files, always with relative paths. Prefer edit_file for small changes. Commands run in ${shell}.`;
  let messages: any[] = Array.isArray(input.session) ? (input.session as any[]) : [{ role: 'system', content: system }];

  if (input.op === 'compact') {
    if (messages.length > 3) messages = await compactMessages(messages);
    return { text: '', session: messages };
  }

  // The user's message, with any attached images where the model can see them.
  const images = (input.images ?? []).filter(isImage);
  let prompt = input.prompt;
  if (images.length && !seesImages) prompt += `\n\n(${images.length} image(s) are attached, but ${model} cannot see images. Say so if they matter.)`;
  const loaded = seesImages ? await Promise.all(images.map(async (f) => ({ f, b64: (await fs.readFile(f)).toString('base64') }))) : [];
  if (native) messages.push({ role: 'user', content: prompt, ...(loaded.length ? { images: loaded.map((x) => x.b64) } : {}) });
  else if (loaded.length) {
    messages.push({ role: 'user', content: [{ type: 'text', text: prompt }, ...loaded.map((x) => ({ type: 'image_url', image_url: { url: `data:${IMAGE_TYPES[path.extname(x.f).toLowerCase()]};base64,${x.b64}` } }))] });
  } else messages.push({ role: 'user', content: prompt });

  const mcp = useTools && input.mcp?.length ? await openMcp(input.mcp, input.cwd, (msg) => input.emit({ type: 'message', kind: 'thought', text: msg })) : undefined;
  const tools = () => [
    ...toolsFor(input.autonomy),
    ...(mcp?.tools ?? []).map((t) => ({ type: 'function', function: { name: t.fullName, description: `[${t.server}] ${t.description}`, parameters: t.schema } })),
  ];
  let think = native ? thinkFor(model, input.lean ? 'low' : input.agent.effort) : undefined;
  let inTok = 0;
  let outTok = 0;
  let lastPrompt = 0;
  input.emit({ type: 'state', state: 'thinking', detail: model });

  const finish = (text: string) => {
    input.emit({ type: 'usage', inputTokens: inTok, outputTokens: outTok });
    if (limit && lastPrompt && !input.lean) input.emit({ type: 'context', used: lastPrompt, limit });
    // Images are kept out of the saved conversation; they were seen once.
    for (const m of messages) if (m.images) delete m.images;
    return { text, session: input.lean ? undefined : messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') } : m)) };
  };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // Close to the limit, older turns are summarised so the model never silently loses the start of the conversation.
      if (limit && lastPrompt > limit * 0.8 && messages.length > 8) {
        input.emit({ type: 'state', state: 'thinking', detail: 'compacting context' });
        messages = await compactMessages(messages);
        input.emit({ type: 'message', kind: 'thought', text: `Context was ${Math.round((100 * lastPrompt) / limit)}% full, so older turns were summarised.` });
        lastPrompt = 0;
      }
      let result: Step;
      try {
        result = await ask(messages, useTools ? tools() : undefined, think);
      } catch (e) {
        const err = e as Error & { status?: number; body?: string };
        if (err.status === 400 && /think/i.test(err.body ?? '') && think !== undefined) { think = undefined; continue; }
        if (err.status === 400 && /tool/i.test(err.body ?? '') && useTools) {
          useTools = false;
          input.emit({ type: 'message', kind: 'thought', text: `${model} does not support tool calls, so it can only answer in text.` });
          continue;
        }
        if (/fetch failed|ECONNREFUSED/i.test(err.message)) throw new Error(`${endpoint.name} is not running at ${base}. Start it and try again.`);
        throw err;
      }
      inTok += result.inTok;
      outTok += result.outTok;
      lastPrompt = result.inTok + result.outTok;
      const text = result.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      if (result.calls.length) {
        if (native) messages.push({ role: 'assistant', content: result.content, tool_calls: result.calls.map((c) => ({ function: { name: c.name, arguments: c.args } })) });
        else messages.push({ role: 'assistant', content: result.content, tool_calls: result.calls.map((c, i) => ({ id: c.id ?? `call_${step}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) });
        if (text) input.emit({ type: 'message', kind: 'thought', text });
        for (const [i, call] of result.calls.entries()) {
          const out = await callTool(call, input, mcp);
          if (native) messages.push({ role: 'tool', tool_name: call.name, content: out });
          else messages.push({ role: 'tool', tool_call_id: call.id ?? `call_${step}_${i}`, content: out });
        }
        input.emit({ type: 'state', state: 'thinking', detail: model });
        continue;
      }

      messages.push({ role: 'assistant', content: result.content });
      input.emit({ type: 'message', kind: 'say', text });
      return finish(text);
    }
    input.emit({ type: 'usage', inputTokens: inTok, outputTokens: outTok });
    throw new Error(`Stopped after ${MAX_STEPS} steps without a final answer.`);
  } finally {
    await mcp?.close();
  }
};
