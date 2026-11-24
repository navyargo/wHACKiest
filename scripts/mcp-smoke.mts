// Spawns the stdio MCP server exactly as Claude Desktop would and calls a few tools.
// Usage: pnpm mcp:smoke   (uses CARERELAY_MCP_TOKEN from .env)
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "packages/mcp-server/src/stdio.ts"], env: { ...process.env } as Record<string, string>, stderr: "inherit" });
const client = new Client({ name: "carerelay-smoke", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
const pts = (await client.callTool({ name: "list_patients", arguments: {} })).structuredContent as { patients: { id: string; displayName: string; role: string }[] };
console.log("patients:", pts.patients.map((p) => `${p.displayName} (${p.role})`).join(", "));
if (pts.patients[0]) {
  const s = (await client.callTool({ name: "get_care_status", arguments: { patientId: pts.patients[0].id } })).structuredContent as { tasksToday: number; uncovered: number; openAlerts: number };
  console.log("care status:", s);
  const denied = await client.callTool({ name: "get_care_status", arguments: { patientId: "00000000-0000-4000-8000-000000000000" } });
  console.log("unknown patient →", (denied.content as { text: string }[])[0].text);
}
await client.close();
