/** MCP Streamable HTTP endpoint (stateless). Auth: Bearer CareRelay MCP token. */
import { handleMcpHttpRequest } from "@carerelay/mcp-server";
import { deps } from "@/lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = (req: Request) => handleMcpHttpRequest(req, deps());
export { handle as GET, handle as POST, handle as DELETE };
