// MCP for local models. Claude and Codex connect to MCP servers themselves; for Ollama and other local models
// Big Eyes Office is the MCP client: it starts the servers, describes their tools to the model and runs the calls.
import type { McpServer } from '../../shared/types.ts';
import { compressOutput } from './adapters/types.ts';

export interface McpTool { server: string; name: string; fullName: string; description: string; schema: Record<string, unknown> }
export interface McpSession { tools: McpTool[]; call(fullName: string, args: Record<string, unknown>): Promise<string>; close(): Promise<void> }

const safe = (s: string) => s.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'mcp';

/** Connects to every enabled server. A server that fails is reported and skipped; the others still work. */
export async function openMcp(servers: McpServer[], cwd: string, onError: (msg: string) => void): Promise<McpSession> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const clients: { server: string; client: InstanceType<typeof Client> }[] = [];
  const tools: McpTool[] = [];
  for (const s of servers) {
    const client = new Client({ name: 'big-eyes-office', version: '0.6.0' });
    try {
      if (s.url) {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        await client.connect(new StreamableHTTPClientTransport(new URL(s.url)));
      } else {
        const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        await client.connect(new StdioClientTransport({
          command: s.command ?? '', args: s.args ?? [], cwd, stderr: 'ignore',
          env: { ...getDefaultEnvironment(), ...(s.env ?? {}) },
        }));
      }
      const list = await client.listTools();
      for (const t of list.tools) {
        tools.push({
          server: s.name, name: t.name, fullName: `mcp__${safe(s.name)}__${safe(t.name)}`.slice(0, 64),
          description: (t.description ?? '').slice(0, 600), schema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        });
      }
      clients.push({ server: s.name, client });
    } catch (e) {
      onError(`MCP server "${s.name}" could not start: ${(e as Error).message}`);
      await client.close().catch(() => {});
    }
  }
  return {
    tools,
    async call(fullName, args) {
      const tool = tools.find((t) => t.fullName === fullName);
      const entry = tool && clients.find((c) => c.server === tool.server);
      if (!tool || !entry) return `Unknown tool ${fullName}.`;
      const res: any = await entry.client.callTool({ name: tool.name, arguments: args });
      const text = (res.content ?? []).map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : `[${c.type}]`)).join('\n');
      return `${res.isError ? 'Error: ' : ''}${compressOutput(text || '(no output)', 300)}`;
    },
    async close() { await Promise.all(clients.map((c) => c.client.close().catch(() => {}))); },
  };
}
