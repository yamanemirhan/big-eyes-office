import type { AgentConfig, AgentState, Autonomy, McpServer, Settings } from '../../../shared/types.ts';

export type AdapterEvent =
  | { type: 'state'; state: AgentState; detail?: string }
  | { type: 'message'; kind: 'thought' | 'say'; text: string }
  | { type: 'tool'; tool: string; detail: string }
  | { type: 'output'; text: string }
  | { type: 'plan'; info: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number }
  | { type: 'context'; used: number; limit: number; categories?: { name: string; tokens: number }[] };

export interface AdapterInput {
  agent: AgentConfig;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  autonomy: Autonomy;
  settings: Settings;
  signal: AbortSignal;
  /** Opaque value returned by a previous turn of the same agent in the same run. */
  session?: unknown;
  /** Images attached by the user (absolute paths), given to the model natively where it can see images. */
  images?: string[];
  /** Local path of the Superpowers plugin when the team uses that workflow. */
  pluginPath?: string;
  teammates: string[];
  /** A quick answer: no tools, no provider extras, one reply. The cheapest way to ask a model something. */
  lean?: boolean;
  /** "compact": summarise the session to free context instead of answering a prompt. */
  op?: 'compact';
  /** MCP servers the team enabled. */
  mcp?: McpServer[];
  /** True inside the Docker isolation container: the container is the sandbox. */
  inContainer?: boolean;
  /** Which action kinds need the user's approval, and how to ask. Resolves to false when denied. */
  ask: { edits: boolean; commands: boolean };
  approve(kind: 'edit' | 'command', title: string, detail: string): Promise<boolean>;
  emit(event: AdapterEvent): void;
}

export interface AdapterResult {
  text: string;
  session?: unknown;
}

export type Adapter = (input: AdapterInput) => Promise<AdapterResult>;

/**
 * Shrinks long tool output before it goes back to a model: colour codes and repeated lines go, and only the
 * start and the end of very long output are kept (that is where commands print what matters).
 */
export function compressOutput(text: string, maxLines = 200): string {
  const lines = text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r(?!\n)/g, '\n').split(/\r?\n/);
  const out: string[] = [];
  let repeat = 0;
  for (const line of lines) {
    if (out.length && line === out[out.length - 1]) { repeat++; continue; }
    if (repeat) { out.push(`  (previous line repeated ${repeat} more times)`); repeat = 0; }
    out.push(line);
  }
  if (repeat) out.push(`  (previous line repeated ${repeat} more times)`);
  if (out.length <= maxLines) return out.join('\n');
  const head = Math.round(maxLines * 0.4);
  const tail = maxLines - head;
  return [...out.slice(0, head), `… ${out.length - maxLines} lines left out …`, ...out.slice(-tail)].join('\n');
}

export const clip = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
