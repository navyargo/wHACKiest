/**
 * stdio entry for Claude Desktop / MCP Inspector:  pnpm mcp:stdio
 * Authenticates with CARERELAY_MCP_TOKEN (a seeded demo token in DEMO_MODE), so the caller gets
 * exactly that user's permissions.
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb, appClock, resolveMcpToken } from "@carerelay/domain";
import { getProvider } from "@carerelay/agents";
import { createCareRelayMcpServer } from "./server";

async function main() {
  const db = getDb();
  const resolved = await resolveMcpToken(db, process.env.CARERELAY_MCP_TOKEN);
  if (!resolved) {
    process.stderr.write("CARERELAY_MCP_TOKEN is missing, expired or unknown. Run `pnpm db:seed` with DEMO_MODE=true and use a token from the README.\n");
    process.exit(1);
  }
  const server = createCareRelayMcpServer({ user: resolved.user, tokenPatientId: resolved.patientId, label: `stdio:${resolved.label}`, transport: "stdio" }, { db, clock: appClock(db), provider: getProvider() });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`CareRelay MCP server (stdio) ready as ${resolved.user.name}\n`);
}
main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(1);
});
