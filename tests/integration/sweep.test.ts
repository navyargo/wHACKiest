import { beforeAll, describe, expect, it } from "vitest";
import * as D from "@carerelay/domain";
import { db, freshSeed, ctx, todaysTask } from "./helpers";

let s: Awaited<ReturnType<typeof freshSeed>>;
beforeAll(async () => {
  s = await freshSeed();
});

describe("care sweep", () => {
  it("is idempotent: re-running never duplicates alerts", async () => {
    const clock = D.fixedClock(s.at("20:30"));
    const first = await D.runSweep(db, clock, s.patientId);
    expect(first.created.length).toBeGreaterThan(0);
    const count = await db.alert.count({ where: { patientId: s.patientId } });
    const again = await D.runSweep(db, clock, s.patientId);
    await Promise.all([D.runSweep(db, clock, s.patientId), D.runSweep(db, clock, s.patientId)]);
    expect(again.created).toHaveLength(0);
    expect(await db.alert.count({ where: { patientId: s.patientId } })).toBe(count);
    const open = await db.alert.findMany({ where: { patientId: s.patientId, state: { not: "RESOLVED" } } });
    expect(new Set(open.map((a) => a.dedupeKey)).size).toBe(open.length);
  });

  it("assumption gap: GAP-001 appears, then resolves once someone accepts", async () => {
    const t = await todaysTask(s.patientId, "Medicine A", "20:00", s.at);
    // At 20:30 the 20:00 dose is inside its window with no owner → URGENT GAP-001
    const alert = await db.alert.findFirstOrThrow({ where: { patientId: s.patientId, ruleId: "GAP-001", affectedTaskId: t.id, state: { not: "RESOLVED" } } });
    expect(alert.level).toBe("URGENT");
    await D.transitionTask(await ctx("priya", s.patientId, s.at("20:31")), t.id, { event: "ASSIGN", targetMemberId: s.users.ravi.memberId, idempotencyKey: "gap1-assign" });
    await D.runSweep(db, D.fixedClock(s.at("20:32")), s.patientId);
    // Assigned is not covered: GAP-001 clears, GAP-002 (not acknowledged) takes over
    expect((await db.alert.findUniqueOrThrow({ where: { id: alert.id } })).state).toBe("RESOLVED");
    expect(await db.alert.count({ where: { ruleId: "GAP-002", affectedTaskId: t.id, state: { not: "RESOLVED" } } })).toBe(1);
    await D.transitionTask(await ctx("ravi", s.patientId, s.at("20:33")), t.id, { event: "ACKNOWLEDGE", idempotencyKey: "gap1-ack" });
    await D.runSweep(db, D.fixedClock(s.at("20:34")), s.patientId);
    expect(await db.alert.count({ where: { ruleId: "GAP-002", affectedTaskId: t.id, state: { not: "RESOLVED" } } })).toBe(0);
  });

  it("silent failure: window passes → OVERDUE + GAP-003, then escalates per policy", async () => {
    const t = await todaysTask(s.patientId, "Physiotherapy", "11:00", s.at);
    await D.runSweep(db, D.fixedClock(s.at("20:40")), s.patientId);
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).state).toBe("OVERDUE");
    const a = await db.alert.findFirstOrThrow({ where: { ruleId: "GAP-003", affectedTaskId: t.id } });
    await D.runSweep(db, D.fixedClock(new Date(a.detectedAt.getTime() + 16 * 60_000)), s.patientId);
    const after = await db.alert.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ state: "ESCALATED", escalationStep: 1 });
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).state).toBe("ESCALATED");
    expect(await db.notification.count({ where: { alertId: a.id, dedupeKey: { contains: ":step1:" } } })).toBeGreaterThan(0);
  });
});
