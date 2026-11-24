import { beforeAll, describe, expect, it } from "vitest";
import { db, freshSeed, rest, resetSessions, mcpAs } from "./helpers";

let s: Awaited<ReturnType<typeof freshSeed>>;
beforeAll(async () => {
  s = await freshSeed();
  resetSessions();
});

describe("patient isolation & roles — REST", () => {
  it("unauthenticated → 401", async () => {
    expect((await rest(null, "GET", `/patients/${s.patientId}/tasks`)).status).toBe(401);
  });
  it("a member of another patient gets 404 and nothing leaks", async () => {
    for (const p of ["", "/tasks", "/alerts", "/messages", "/documents", "/timeline", "/members"]) {
      const r = await rest("kavya", "GET", `/patients/${s.patientId}${p}`);
      expect(r.status, p).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("Amma");
    }
    const anyTask = await db.task.findFirstOrThrow({ where: { patientId: s.patientId } });
    expect((await rest("kavya", "GET", `/patients/${s.otherPatientId}/tasks/${anyTask.id}`)).status).toBe(404);
    expect((await rest("ravi", "GET", `/patients/${s.otherPatientId}/tasks`)).status).toBe(404);
  });
  it("remote viewer sees consolidated status but not raw messages or documents", async () => {
    expect((await rest("arjun", "GET", `/patients/${s.patientId}/status`)).status).toBe(200);
    expect((await rest("arjun", "GET", `/patients/${s.patientId}/messages`)).status).toBe(403);
    expect((await rest("arjun", "GET", `/patients/${s.patientId}/documents`)).status).toBe(403);
    const msg = await db.sourceMessage.findFirstOrThrow({ where: { patientId: s.patientId } });
    expect((await rest("arjun", "GET", `/patients/${s.patientId}/sources/message/${msg.id}`)).status).toBe(403);
    const tl = await rest("arjun", "GET", `/patients/${s.patientId}/timeline`);
    expect(tl.body.entries.some((e: { kind: string }) => e.kind === "message")).toBe(false);
    const alerts = await rest("arjun", "GET", `/patients/${s.patientId}/alerts`);
    const ev = alerts.body.alerts.flatMap((a: { evidence: { parentSourceType?: string; excerpt: string }[] }) => a.evidence).filter((e: { parentSourceType?: string }) => e.parentSourceType === "MESSAGE");
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e: { excerpt: string }) => e.excerpt.startsWith("[Source hidden"))).toBe(true);
  });
  it("only a verifier can approve medical activations; nobody can approve via an agent", async () => {
    const a = await db.approvalRequest.create({ data: { patientId: s.patientId, actionType: "CHANGE_CARE_PLAN_ITEM", title: "t", payload: {}, requestedByType: "AGENT", requiredPermission: "verify_medical" } });
    expect((await rest("ravi", "POST", `/patients/${s.patientId}/approvals/${a.id}/decide`, { decision: "APPROVED" })).status).toBe(403);
  });
});

describe("patient isolation & roles — MCP", () => {
  it("cross-patient tool calls are denied and audited without the target patient", async () => {
    const m = await mcpAs("kavya");
    const r = await m.callTool("get_care_status", { patientId: s.patientId });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/NOT_FOUND/);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "mcp.tool_call", actorName: { startsWith: "Kavya" } }, orderBy: { at: "desc" } });
    expect(log.patientId).toBeNull();
    expect((log.details as { outcome: string }).outcome).toBe("denied");
    await m.close();
  });
  it("a token scoped to one patient can't reach another", async () => {
    const m = await mcpAs("priya", { tokenPatientId: s.otherPatientId });
    expect((await m.callTool("list_tasks", { patientId: s.patientId })).ok).toBe(false);
    expect((await m.callTool("list_patients", {})).structured).toEqual({ patients: [] });
    await m.close();
  });
  it("role permissions apply inside MCP tools", async () => {
    const m = await mcpAs("arjun");
    const msg = await db.sourceMessage.findFirstOrThrow({ where: { patientId: s.patientId } });
    const r = await m.callTool("get_source_reference", { patientId: s.patientId, sourceType: "MESSAGE", sourceId: msg.id });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/FORBIDDEN/);
    expect((await m.callTool("get_care_status", { patientId: s.patientId })).ok).toBe(true);
    await m.close();
  });
});
