import { randomUUID } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as D from "@carerelay/domain";
import { seedDemo, demoEmail, type SeedResult } from "@carerelay/demo";
import { DeterministicMockProvider, connectWithTransport } from "@carerelay/agents";
import { createCareRelayMcpServer } from "@carerelay/mcp-server";
import { dispatch } from "@/lib/server/http";
import { routes } from "@/lib/server/routes";

export const db = D.getDb();
export const TZ = "Asia/Kolkata";

export async function freshSeed(): Promise<SeedResult & { at: (hhmm: string, dayOffset?: number) => Date }> {
  const r = await seedDemo(db, { withMcpTokens: true });
  const day = D.localDateString(r.demoNow, TZ);
  return { ...r, at: (hhmm, dayOffset = 0) => D.zonedTimeToUtc(D.addDaysToDateString(day, dayOffset), hhmm, TZ) };
}

export async function ctx(key: string, patientId: string, when: Date) {
  const u = await db.user.findUniqueOrThrow({ where: { email: demoEmail(key) } });
  return D.resolvePatientContext(db, D.fixedClock(when), { type: "USER", userId: u.id, name: u.name, via: "REST" }, patientId);
}

export async function todaysTask(patientId: string, titlePrefix: string, hhmm: string, at: (h: string) => Date) {
  return db.task.findFirstOrThrow({ where: { patientId, title: { startsWith: titlePrefix }, scheduledAt: at(hhmm) } });
}

const sessions = new Map<string, string>();
export async function rest(user: string | null, method: string, path: string, body?: unknown, idem?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) {
    if (!sessions.has(user)) {
      const u = await db.user.findUniqueOrThrow({ where: { email: demoEmail(user) } });
      sessions.set(user, await D.createSession(db, u.id));
    }
    headers.cookie = `cr_session=${sessions.get(user)}`;
  }
  if (method !== "GET") headers["idempotency-key"] = idem ?? randomUUID();
  const req = new Request(`http://test.local/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await dispatch(routes, req, path.split("?")[0].split("/").filter(Boolean));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
export const resetSessions = () => sessions.clear();

export async function mcpAs(key: string, opts: { tokenPatientId?: string | null; clock?: D.Clock } = {}) {
  const u = await db.user.findUniqueOrThrow({ where: { email: demoEmail(key) } });
  const server = createCareRelayMcpServer({ user: u, tokenPatientId: opts.tokenPatientId ?? null, label: `test-${key}`, transport: "memory" }, { db, clock: opts.clock ?? D.appClock(db), provider: new DeterministicMockProvider() });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  return connectWithTransport(clientT, "carerelay-test");
}
