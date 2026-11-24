/** Thin wrapper over the official MCP SDK client. Agents only see data through this. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolCallOutcome, ToolSpec } from "./llm/provider";

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  summary: string;
  structured?: unknown;
}

export interface McpSession {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
  readonly calls: ToolCallRecord[];
  close(): Promise<void>;
}

export async function connectWithTransport(transport: Transport, clientName = "carerelay-agent"): Promise<McpSession> {
  const client = new Client({ name: clientName, version: "0.1.0" });
  await client.connect(transport);
  const calls: ToolCallRecord[] = [];
  return {
    calls,
    async listTools() {
      const r = await client.listTools();
      return r.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema as Record<string, unknown> }));
    },
    async callTool(name, args) {
      const t0 = Date.now();
      try {
        const r = await client.callTool({ name, arguments: args });
        const content = (r.content as { type: string; text?: string }[] | undefined) ?? [];
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        const ok = !r.isError;
        calls.push({ tool: name, args, ok, durationMs: Date.now() - t0, summary: text.slice(0, 160), structured: r.structuredContent });
        return { ok, text, structured: r.structuredContent };
      } catch (e) {
        const msg = (e as Error).message;
        calls.push({ tool: name, args, ok: false, durationMs: Date.now() - t0, summary: msg.slice(0, 160) });
        return { ok: false, text: msg };
      }
    },
    close: () => client.close(),
  };
}

export async function connectMcpHttp(url: string, token: string): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  return connectWithTransport(transport);
}
