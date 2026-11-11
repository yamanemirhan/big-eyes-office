import { CodexRpc } from '../codexrpc.ts';
import { clip, type Adapter } from './types.ts';

// Codex through `codex app-server`, so command and file-change approvals can be routed to the user.

export const codexAdapter: Adapter = async (input) => {
  const { agent, autonomy, ask } = input;
  const askAny = autonomy !== 'read' && (ask.commands || ask.edits);

  const rpc = new CodexRpc(input.settings, async (method, params) => {
    const isCommand = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
    const isEdit = method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    if (isCommand || isEdit) {
      const needsUser = isCommand ? ask.commands : ask.edits;
      const command = Array.isArray(params?.command) ? params.command.join(' ') : params?.command;
      const ok = !needsUser || await input.approve(isCommand ? 'command' : 'edit',
        isCommand ? `${agent.name} wants to run a command` : `${agent.name} wants to change files`,
        String(command ?? params?.reason ?? params?.grantRoot ?? ''));
      if (legacy) return { decision: ok ? 'approved' : { denied: { rejection: 'The user did not approve this.' } } };
      return { decision: ok ? 'accept' : 'decline' };
    }
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    // MCP servers ask before sensitive tool calls; the team's command switch decides whether the user is asked.
    if (method === 'mcpServer/elicitation/request') {
      const ok = !ask.commands || await input.approve('command', `${agent.name}: ${params.serverName} asks`, clip(String(params.message ?? ''), 300));
      return { action: ok ? 'accept' : 'decline', content: null, _meta: null };
    }
    throw new Error(`Big Eyes Office does not handle ${method}.`);
  });

  let turnId: string | undefined;
  let threadId: string | undefined;
  const onAbort = () => {
    if (threadId && turnId) rpc.call('turn/interrupt', { threadId, turnId }).catch(() => {}).finally(() => setTimeout(() => rpc.close(), 1500));
    else rpc.close();
  };
  input.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await rpc.start();
    // MCP servers go in as config overrides, like `codex -c mcp_servers.<name>.command=...`.
    const config: Record<string, unknown> = {};
    for (const m of input.lean ? [] : input.mcp ?? []) {
      const key = `mcp_servers.${m.name.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'mcp'}`;
      if (m.url) config[`${key}.url`] = m.url;
      else {
        config[`${key}.command`] = m.command ?? '';
        config[`${key}.args`] = m.args ?? [];
        if (m.env && Object.keys(m.env).length) config[`${key}.env`] = m.env;
      }
    }
    const threadParams = {
      model: agent.model || null,
      cwd: input.cwd,
      approvalPolicy: askAny && !input.lean ? 'untrusted' : 'never',
      // Inside the isolation container, Codex's own sandbox cannot start (no privileges); the container already confines it.
      sandbox: input.lean || autonomy === 'read' ? 'read-only' : autonomy === 'full' || input.inContainer ? 'danger-full-access' : 'workspace-write',
      // A quick answer replaces Codex's long built-in coding instructions with a few lines and keeps no thread.
      ...(input.lean ? { baseInstructions: input.systemPrompt, ephemeral: true } : { developerInstructions: input.systemPrompt }),
      ...(Object.keys(config).length ? { config } : {}),
    };
    const resumed = typeof input.session === 'string';
    const opened = resumed
      ? await rpc.call('thread/resume', { threadId: input.session, excludeTurns: true, ...threadParams }).catch(() => null)
      : null;
    const thread = opened ?? await rpc.call('thread/start', threadParams);
    threadId = thread.thread.id as string;

    let finalText = '';
    let contextNow: { used: number; limit: number } | undefined;
    let usageStart: { input: number; cached: number; output: number } | null = null;
    let usageEnd: { input: number; cached: number; output: number } | null = null;

    const done = new Promise<void>((resolve, reject) => {
      rpc.on((method, p) => {
        if (p?.threadId && p.threadId !== threadId) return;
        if (method === 'item/started' || method === 'item/completed') {
          const item = p.item;
          const started = method === 'item/started';
          if (item.type === 'commandExecution' && item.source !== 'userShell') {
            if (started) {
              input.emit({ type: 'state', state: 'running', detail: clip(item.command) });
              input.emit({ type: 'tool', tool: 'Command', detail: clip(item.command) });
            } else {
              if (item.aggregatedOutput?.trim()) input.emit({ type: 'output', text: item.aggregatedOutput.slice(-6000) });
              input.emit({ type: 'state', state: 'thinking' });
            }
          } else if (item.type === 'fileChange' && !started) {
            const detail = clip((item.changes ?? []).map((c: any) => `${c.kind?.type ?? c.kind ?? ''} ${c.path}`).join(', '));
            input.emit({ type: 'state', state: 'writing', detail });
            input.emit({ type: 'tool', tool: 'Edit', detail });
          } else if (item.type === 'webSearch' && started) {
            input.emit({ type: 'state', state: 'searching', detail: clip(item.query ?? '') });
            input.emit({ type: 'tool', tool: 'WebSearch', detail: clip(item.query ?? '') });
          } else if (item.type === 'mcpToolCall' && started) {
            input.emit({ type: 'tool', tool: `${item.server}.${item.tool}`, detail: '' });
          } else if (item.type === 'reasoning' && !started) {
            const text = [...(item.summary ?? [])].join('\n').trim();
            if (text) input.emit({ type: 'message', kind: 'thought', text });
            input.emit({ type: 'state', state: 'thinking' });
          } else if (item.type === 'agentMessage' && !started && item.text?.trim()) {
            finalText = item.text;
            input.emit({ type: 'message', kind: 'say', text: item.text });
          }
        } else if (method === 'thread/tokenUsage/updated') {
          const t = p.tokenUsage.total;
          const l = p.tokenUsage.last;
          // The last request's input is what the model currently holds in context.
          if (p.tokenUsage.modelContextWindow && !input.lean) contextNow = { used: l.inputTokens + l.outputTokens, limit: p.tokenUsage.modelContextWindow };
          const now = { input: t.inputTokens, cached: t.cachedInputTokens ?? 0, output: t.outputTokens + (t.reasoningOutputTokens ?? 0) };
          usageStart ??= { input: now.input - l.inputTokens, cached: now.cached - (l.cachedInputTokens ?? 0), output: now.output - l.outputTokens - (l.reasoningOutputTokens ?? 0) };
          usageEnd = now;
        } else if (method === 'error' && !p.willRetry) {
          input.emit({ type: 'message', kind: 'thought', text: `Codex error: ${p.error?.message ?? ''}` });
        } else if (method === 'thread/compacted' && input.op === 'compact') {
          resolve();
        } else if (method === 'turn/completed') {
          const turn = p.turn;
          if (turn.status === 'completed') resolve();
          else if (turn.status === 'interrupted') reject(new Error('aborted'));
          else reject(new Error(turn.error?.message ?? `Codex turn ${turn.status}.`));
        }
      });
      rpc.onClose(() => reject(new Error(input.signal.aborted ? 'aborted' : 'Codex stopped unexpectedly.')));
    });

    input.emit({ type: 'state', state: 'thinking' });
    if (input.op === 'compact') {
      if (!resumed) return { text: '', session: input.session };
      await rpc.call('thread/compact/start', { threadId });
      await Promise.race([done, new Promise((r) => setTimeout(r, 180_000))]);
      return { text: '', session: threadId };
    }
    const started = await rpc.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }, ...(input.images ?? []).map((p) => ({ type: 'localImage', path: p }))],
      ...(agent.effort !== 'default' ? { effort: agent.effort } : {}),
    });
    turnId = started.turn?.id;
    await done;

    if (usageEnd && usageStart) {
      const end = usageEnd as { input: number; cached: number; output: number };
      const start = usageStart as { input: number; cached: number; output: number };
      const cached = Math.max(0, end.cached - start.cached);
      input.emit({ type: 'usage', inputTokens: Math.max(0, end.input - start.input - cached), cachedTokens: cached, outputTokens: Math.max(0, end.output - start.output) });
    }
    if (contextNow) input.emit({ type: 'context', ...contextNow });
    return { text: finalText, session: input.lean ? undefined : threadId };
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    rpc.close();
  }
};
