import { beforeAll, describe, expect, it } from "vitest";
import * as D from "@carerelay/domain";
import { db, freshSeed, mcpAs, todaysTask } from "./helpers";

let s: Awaited<ReturnType<typeof freshSeed>>;
beforeAll(async () => {
  s = await freshSeed();
});

describe("MCP server via the SDK client", () => {
  it("exposes the full tool set with schemas and classes", async () => {
    const m = await mcpAs("ravi");
    const tools = await m.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["acknowledge_task", "draft_handover", "extract_from_document", "extract_from_message", "find_available_caregivers", "get_care_status", "get_inventory_status", "get_member_availability", "get_source_reference", "get_task", "list_open_alerts", "list_patients", "list_tasks", "propose_reassignment", "record_observation", "request_approval", "run_care_sweep"].sort(),
    );
    expect(tools.find((t) => t.name === "propose_reassignment")!.description).toMatch(/^\[PROPOSE\]/);
    await m.close();
  });

  it("returns real seeded data", async () => {
    const m = await mcpAs("ravi");
    const pts = (await m.callTool("list_patients", {})).structured as { patients: { displayName: string }[] };
    expect(pts.patients.map((p) => p.displayName)).toEqual(["Amma"]);
    const tasks = (await m.callTool("list_tasks", { patientId: s.patientId })).structured as { tasks: { title: string; state: string; localTime: string }[] };
    expect(tasks.tasks.find((t) => t.localTime === "20:00")).toMatchObject({ state: "UNASSIGNED" });
    const alerts = (await m.callTool("list_open_alerts", { patientId: s.patientId })).structured as { alerts: { ruleId: string }[] };
    expect(alerts.alerts.map((a) => a.ruleId)).toContain("GAP-004");
    await m.close();
  });

  it("rejects invalid input by schema", async () => {
    const m = await mcpAs("ravi");
    const r = await m.callTool("list_tasks", { patientId: "not-a-uuid" });
    expect(r.ok).toBe(false);
    expect(r.text.toLowerCase()).toMatch(/invalid|uuid|validation/);
    const r2 = await m.callTool("propose_reassignment", { patientId: s.patientId });
    expect(r2.ok).toBe(false);
    await m.close();
  });

  it("PROPOSE tools never mutate active state", async () => {
    const t = await todaysTask(s.patientId, "Wound dressing", "10:00", s.at);
    const before = await db.task.findUniqueOrThrow({ where: { id: t.id } });
    const planBefore = await db.carePlanItem.findMany({ where: { patientId: s.patientId }, orderBy: { id: "asc" } });
    const m = await mcpAs("ravi");
    const r = await m.callTool("propose_reassignment", { patientId: s.patientId, taskId: t.id, toMemberId: s.users.suresh.memberId, reason: "Meena is unavailable" });
    expect(r.ok).toBe(true);
    const approval = await db.approvalRequest.findUniqueOrThrow({ where: { id: (r.structured as { approvalRequestId: string }).approvalRequestId } });
    expect(approval).toMatchObject({ state: "PENDING", actionType: "REASSIGN_TASK", requestedByType: "AGENT", requiredPermission: "manage_tasks" });
    const unqualified = await m.callTool("propose_reassignment", { patientId: s.patientId, taskId: t.id, toMemberId: s.users.ravi.memberId, reason: "x x x" });
    expect(unqualified.ok).toBe(false);
    const doc = await db.sourceDocument.findFirstOrThrow({ where: { patientId: s.patientId, kind: "DISCHARGE_SUMMARY" } });
    const ex = await mcpAs("priya");
    const ext = await ex.callTool("extract_from_document", { patientId: s.patientId, documentId: doc.id });
    expect(ext.ok).toBe(true);
    expect(await db.task.findUniqueOrThrow({ where: { id: t.id } })).toEqual(before);
    expect(await db.carePlanItem.findMany({ where: { patientId: s.patientId }, orderBy: { id: "asc" } })).toEqual(planBefore);
    await m.close();
    await ex.close();
  });

  it("ACT_SELF only acts on the caller's own task", async () => {
    const t = await todaysTask(s.patientId, "Medicine C", "21:00", s.at); // assigned to Suresh
    const ravi = await mcpAs("ravi");
    const r = await ravi.callTool("acknowledge_task", { patientId: s.patientId, taskId: t.id });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/FORBIDDEN/);
    const suresh = await mcpAs("suresh");
    expect((await suresh.callTool("acknowledge_task", { patientId: s.patientId, taskId: t.id })).structured).toMatchObject({ state: "ACKNOWLEDGED" });
    await ravi.close();
    await suresh.close();
  });

  it("logs every call to the audit log, and run_care_sweep is idempotent", async () => {
    const before = await db.auditLog.count({ where: { action: "mcp.tool_call" } });
    const m = await mcpAs("priya", { clock: D.fixedClock(s.at("09:00")) });
    const a = (await m.callTool("run_care_sweep", { patientId: s.patientId })).structured as { created: unknown[] };
    const b = (await m.callTool("run_care_sweep", { patientId: s.patientId })).structured as { created: unknown[] };
    expect(b.created).toHaveLength(0);
    void a;
    expect(await db.auditLog.count({ where: { action: "mcp.tool_call" } })).toBe(before + 2);
    await m.close();
  });

  it("serves the timeline resource and the shift_handover prompt", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createCareRelayMcpServer } = await import("@carerelay/mcp-server");
    const { DeterministicMockProvider } = await import("@carerelay/agents");
    const u = await db.user.findFirstOrThrow({ where: { email: "priya@demo.carerelay.local" } });
    const server = createCareRelayMcpServer({ user: u, tokenPatientId: null, label: "t", transport: "memory" }, { db, clock: D.appClock(db), provider: new DeterministicMockProvider() });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    await server.connect(sv);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(c);
    const res = await client.readResource({ uri: `patient://${s.patientId}/timeline` });
    expect(JSON.parse(String((res.contents[0] as { text: string }).text)).length).toBeGreaterThan(5);
    const p = await client.getPrompt({ name: "shift_handover", arguments: { patientId: s.patientId, toMemberId: s.users.suresh.memberId! } });
    expect(JSON.stringify(p.messages)).toContain("draft_handover");
    await client.close();
  });
});
