import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentState } from '../../../shared/types.ts';
import { clip, type Adapter } from './types.ts';

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'];
const EDIT_TOOLS = [...READ_TOOLS, 'Edit', 'Write', 'NotebookEdit'];

function toolState(name: string): AgentState {
  if (/^(Read|Glob|Grep|LS)$/.test(name)) return 'reading';
  if (/^(Edit|Write|NotebookEdit)$/.test(name)) return 'writing';
  if (/^Bash/.test(name)) return 'running';
  if (/^Web/.test(name)) return 'searching';
  return 'thinking';
}

export const mcpName = (name: string) => name.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'mcp';

function toolDetail(input: Record<string, unknown>): string {
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.description ?? '';
  return clip(String(v));
}

/** How full the context is: Claude Code's own /context numbers when it gives them, else the last request's size. */
async function reportContext(q: any, result: any, last: Record<string, number> | undefined, emit: Parameters<Adapter>[0]['emit']) {
  try {
    const usage = await Promise.race([q.getContextUsage?.({ detail: 'summary' }), new Promise((r) => setTimeout(r, 2500))]) as any;
    const data = usage?.response ?? usage;
    if (data?.total_tokens && data?.raw_max_tokens) {
      emit({
        type: 'context', used: data.total_tokens, limit: data.raw_max_tokens,
        categories: (data.categories ?? []).filter((c: any) => c.kind === 'used' && c.tokens > 0).map((c: any) => ({ name: c.name, tokens: c.tokens })),
      });
      return;
    }
  } catch { /* fall back to the numbers of the last request */ }
  const window = Object.values(result.modelUsage ?? {}).map((m: any) => m.contextWindow).find(Boolean) as number | undefined;
  if (last && window) {
    const used = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.output_tokens ?? 0);
    emit({ type: 'context', used, limit: window });
  }
}

export const claudeAdapter: Adapter = async (input) => {
  const { agent, autonomy, settings } = input;
  // Loaded on first use so a broken SDK install cannot stop the server from starting.
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  input.signal.addEventListener('abort', () => abortController.abort(), { once: true });

  const options: Options = {
    cwd: input.cwd,
    abortController,
    // No CLAUDE.md, user settings or their extras: the team's own instructions are the whole context.
    settingSources: [],
    systemPrompt: input.lean ? input.systemPrompt : { type: 'preset', preset: 'claude_code', append: input.systemPrompt },
    // Only the tools this team may use are described to the model; every unused tool definition costs tokens on every turn.
    tools: input.lean ? [] : autonomy === 'read' ? READ_TOOLS : autonomy === 'edit' ? EDIT_TOOLS : { type: 'preset', preset: 'claude_code' },
  };
  if (agent.model) options.model = agent.model;
  if (agent.effort !== 'default') options.effort = agent.effort;
  if (typeof input.session === 'string') options.resume = input.session;
  if (input.pluginPath && !input.lean) options.plugins = [{ type: 'local', path: input.pluginPath }];
  if (input.lean) { options.maxTurns = 1; options.persistSession = false; }
  const mcp = input.lean ? [] : (input.mcp ?? []);
  if (mcp.length) {
    options.mcpServers = Object.fromEntries(mcp.map((m) => [mcpName(m.name), m.url
      ? { type: 'http' as const, url: m.url }
      : { type: 'stdio' as const, command: m.command ?? '', args: m.args ?? [], env: m.env ?? {} }]));
  }
  const mcpTools = mcp.map((m) => `mcp__${mcpName(m.name)}`);
  const useKey = settings.claudeAuth !== 'login' && !!settings.anthropicApiKey;
  const env = { ...(process.env as Record<string, string>) };
  if (useKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey!;
  else delete env.ANTHROPIC_API_KEY; // Use the Claude Code login (subscription).
  options.env = env;
  const { ask } = input;
  const isEdit = (tool: string) => /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool);
  if (input.lean) {
    options.permissionMode = 'dontAsk';
    options.allowedTools = [];
  } else if (autonomy === 'read') {
    options.permissionMode = 'dontAsk';
    options.allowedTools = [...READ_TOOLS, ...mcpTools];
  } else if (autonomy === 'full' && !ask.edits && !ask.commands) {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
  } else if (autonomy === 'edit' && !ask.edits) {
    options.permissionMode = 'acceptEdits';
    options.allowedTools = [...EDIT_TOOLS, ...mcpTools];
  } else {
    // Anything not pre-approved comes to canUseTool, which asks the user where the team requires it.
    options.permissionMode = 'default';
    options.allowedTools = [...(ask.edits ? READ_TOOLS : EDIT_TOOLS), ...(ask.commands ? [] : mcpTools)];
    options.canUseTool = async (tool, toolInput) => {
      const allow = { behavior: 'allow' as const, updatedInput: toolInput };
      const detail = toolDetail(toolInput);
      if (isEdit(tool)) {
        if (!ask.edits || (await input.approve('edit', `${agent.name} wants to edit a file`, detail))) return allow;
        return { behavior: 'deny' as const, message: 'The user did not approve this edit.' };
      }
      // MCP tools are the ones the user added to the team, so they are allowed at every level; approval follows the command switch.
      if (tool.startsWith('mcp__')) {
        if (!ask.commands || (await input.approve('command', `${agent.name} wants to use ${tool.replace(/^mcp__/, '').replace('__', ' → ')}`, clip(JSON.stringify(toolInput), 300)))) return allow;
        return { behavior: 'deny' as const, message: 'The user did not approve this tool call.' };
      }
      if (autonomy !== 'full') return { behavior: 'deny' as const, message: 'This team may edit files but not run commands or other tools.' };
      if (/^Bash/.test(tool) && ask.commands && !(await input.approve('command', `${agent.name} wants to run a command`, String(toolInput.command ?? detail)))) {
        return { behavior: 'deny' as const, message: 'The user did not approve this command.' };
      }
      return allow;
    };
  }

  let session = typeof input.session === 'string' ? input.session : undefined;
  let finalText = '';
  let lastSay = '';
  let lastUsage: Record<string, number> | undefined;
  // "/compact" is Claude Code's own command: it summarises the session in place.
  const prompt = input.op === 'compact' ? '/compact' : input.prompt;
  if (input.op === 'compact' && !session) return { text: '', session };

  input.emit({ type: 'state', state: 'thinking' });
  const q = query({ prompt, options });
  try {
  for await (const msg of q) {
    const anyMsg = msg as { session_id?: string };
    if (anyMsg.session_id) session = anyMsg.session_id;

    if (msg.type === 'assistant') {
      if ((msg.message as any).usage) lastUsage = (msg.message as any).usage;
      for (const block of msg.message.content as Array<Record<string, any>>) {
        if (block.type === 'text' && block.text?.trim()) {
          lastSay = block.text;
          input.emit({ type: 'message', kind: 'say', text: block.text });
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          input.emit({ type: 'message', kind: 'thought', text: block.thinking });
        } else if (block.type === 'tool_use') {
          const detail = toolDetail(block.input ?? {});
          input.emit({ type: 'state', state: toolState(block.name), detail });
          input.emit({ type: 'tool', tool: block.name, detail });
        }
      }
    } else if ((msg as any).type === 'rate_limit_event') {
      input.emit({ type: 'plan', info: (msg as any).rate_limit_info });
    } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      // Tool results: show command output in the agent's terminal.
      for (const block of msg.message.content as Array<Record<string, any>>) {
        if (block.type !== 'tool_result') continue;
        const text = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') : '';
        if (text.trim()) input.emit({ type: 'output', text: text.slice(0, 6000) });
      }
      input.emit({ type: 'state', state: 'thinking' });
    } else if (msg.type === 'result') {
      const usage = (msg as any).usage ?? {};
      input.emit({
        type: 'usage',
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        cachedTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: (msg as any).total_cost_usd,
      });
      if (!input.lean) await reportContext(q, msg, lastUsage, input.emit);
      if (msg.subtype === 'success') finalText = msg.result;
      else throw new Error(`Claude stopped: ${msg.subtype}${(msg as any).errors?.length ? ` — ${(msg as any).errors.join('; ')}` : ''}`);
    }
    if (msg.type === 'result' && (msg as any).is_error && /credit balance/i.test(String((msg as any).result ?? ''))) {
      throw new Error(useKey
        ? 'The Anthropic API key has no credit left. Add credit in the Claude Console, or switch Claude agents to your Claude Code login in Settings → Accounts.'
        : 'Your Claude account has no usage left.');
    }
  }
  } catch (e) {
    if (/credit balance/i.test((e as Error).message)) {
      throw new Error(useKey
        ? 'The Anthropic API key has no credit left. Add credit in the Claude Console, or switch Claude agents to your Claude Code login in Settings → Accounts.'
        : 'Your Claude account has no usage left.');
    }
    throw e;
  }
  return { text: finalText || lastSay, session };
};
