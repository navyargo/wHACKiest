import { beforeAll, describe, expect, it } from "vitest";
import * as D from "@carerelay/domain";
import { db, freshSeed, ctx, todaysTask } from "./helpers";

let s: Awaited<ReturnType<typeof freshSeed>>;
beforeAll(async () => {
  s = await freshSeed();
});

describe("reassignment needs acceptance", () => {
  it("unqualified reassignment is refused", async () => {
    const t = await todaysTask(s.patientId, "Wound dressing", "10:00", s.at);
    await expect(D.transitionTask(await ctx("priya", s.patientId, s.at("08:10")), t.id, { event: "REASSIGN", targetMemberId: s.users.ravi.memberId, reason: "x", idempotencyKey: "r0" })).rejects.toMatchObject({ code: "GUARD_FAILED" });
  });

  it("stays uncovered until accepted, escalates if nobody accepts, resolves on acceptance", async () => {
    const t = await todaysTask(s.patientId, "Physiotherapy", "17:00", s.at);
    const r = await D.transitionTask(await ctx("priya", s.patientId, s.at("08:10")), t.id, { event: "REASSIGN", targetMemberId: s.users.suresh.memberId, reason: "Meena leaves early", idempotencyKey: "r1" });
    expect(r).toMatchObject({ state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: s.users.suresh.memberId, acknowledgedAt: null });
    const events = await db.taskEvent.findMany({ where: { taskId: t.id }, orderBy: { createdAt: "asc" } });
    expect(events.slice(-2).map((e) => e.type)).toEqual(["REASSIGN", "REQUEST_ACCEPTANCE"]);

    await D.runSweep(db, D.fixedClock(s.at("08:20")), s.patientId);
    expect(await db.alert.count({ where: { ruleId: "GAP-004", affectedTaskId: t.id } })).toBe(0); // within 30 min grace
    await D.runSweep(db, D.fixedClock(s.at("08:45")), s.patientId);
    const a = await db.alert.findFirstOrThrow({ where: { ruleId: "GAP-004", affectedTaskId: t.id, state: { not: "RESOLVED" } } });
    await D.runSweep(db, D.fixedClock(s.at("09:01")), s.patientId);
    expect(await db.alert.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ state: "ESCALATED", escalationStep: 1 });
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).state).toBe("ESCALATED");

    await D.transitionTask(await ctx("suresh", s.patientId, s.at("09:05")), t.id, { event: "ACKNOWLEDGE", idempotencyKey: "r2" });
    await D.runSweep(db, D.fixedClock(s.at("09:06")), s.patientId);
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).state).toBe("RESOLVED");
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).state).toBe("ACKNOWLEDGED");
  });

  it("agent proposals become assignments only after human approval, and still need acceptance", async () => {
    const t = await todaysTask(s.patientId, "Medicine A", "20:00", s.at);
    const agentCtx = await D.resolvePatientContext(db, D.fixedClock(s.at("09:10")), { type: "AGENT", userId: s.users.priya.id, name: "Priya (via agent)", via: "MCP" }, s.patientId);
    const ap = await D.proposeReassignment(agentCtx, { taskId: t.id, toMemberId: s.users.ravi.memberId!, reason: "Ravi is free after 18:00" });
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).state).toBe("UNASSIGNED");
    await expect(D.decideApproval({ ...agentCtx, db }, ap.id, { decision: "APPROVED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await D.decideApproval({ ...(await ctx("priya", s.patientId, s.at("09:11"))), db }, ap.id, { decision: "APPROVED" });
    expect(await db.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: s.users.ravi.memberId });
  });
});
