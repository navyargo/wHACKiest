/** Runs an agent as the requesting user: short-lived patient-scoped MCP token → SDK client over HTTP → revoke. */
import { issueMcpToken, sha256 } from "@carerelay/domain";
import { connectMcpHttp, type McpSession } from "@carerelay/agents";
import { appUrl, deps } from "./deps";

export async function withAgentSession<T>(userId: string, patientId: string, agentName: string, fn: (s: McpSession) => Promise<T>): Promise<T> {
  const { db } = deps();
  const token = await issueMcpToken(db, userId, patientId, `agent:${agentName}`, 5 * 60_000);
  const session = await connectMcpHttp(`${appUrl()}/api/mcp`, token);
  try {
    return await fn(session);
  } finally {
    await session.close().catch(() => undefined);
    await db.mcpToken.updateMany({ where: { tokenHash: sha256(token) }, data: { revokedAt: new Date() } });
  }
}
