/** Streamable HTTP entry (stateless): bearer token → user → fresh server per request. */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolveMcpToken } from "@carerelay/domain";
import { createCareRelayMcpServer, type McpDeps } from "./server";

export async function handleMcpHttpRequest(req: Request, deps: McpDeps): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const resolved = await resolveMcpToken(deps.db, token);
  if (!resolved) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing, expired or revoked CareRelay MCP token" }, id: null }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
  }
  const server = createCareRelayMcpServer({ user: resolved.user, tokenPatientId: resolved.patientId, label: resolved.label, transport: "http" }, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Stateless: JSON responses are complete once handleRequest resolves.
    await server.close().catch(() => undefined);
  }
}
