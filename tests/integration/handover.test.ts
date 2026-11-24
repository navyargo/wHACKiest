import { beforeAll, describe, expect, it } from "vitest";
import * as D from "@carerelay/domain";
import { db, freshSeed, ctx } from "./helpers";

let s: Awaited<ReturnType<typeof freshSeed>>;
beforeAll(async () => {
  s = await freshSeed();
});

describe("handover", () => {
  it("HND-001 fires after the shift ends without a handover; acknowledging does not change any task", async () => {
    await D.runSweep(db, D.fixedClock(s.at("20:20")), s.patientId);
    const a = await db.alert.findFirstOrThrow({ where: { ruleId: "HND-001", state: { not: "RESOLVED" } } });
    expect(a.title).toMatch(/No handover from Meena/);

    const h = await D.draftHandover(await ctx("meena", s.patientId, s.at("20:22")), { toMemberId: s.users.suresh.memberId! });
    const snap = D.HandoverSnapshotZ.parse(h.snapshot);
    expect(snap.pendingActivities.length + snap.upcomingActivities.length).toBeGreaterThan(0);
    await expect(D.acknowledgeHandover(await ctx("suresh", s.patientId, s.at("20:23")), h.id)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await D.sendHandover(await ctx("meena", s.patientId, s.at("20:24")), h.id);
    await expect(D.acknowledgeHandover(await ctx("ravi", s.patientId, s.at("20:25")), h.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const before = await db.task.findMany({ where: { patientId: s.patientId }, orderBy: { id: "asc" }, select: { id: true, state: true, version: true, assigneeMemberId: true, acknowledgedAt: true } });
    await D.acknowledgeHandover(await ctx("suresh", s.patientId, s.at("20:26")), h.id);
    const after = await db.task.findMany({ where: { patientId: s.patientId }, orderBy: { id: "asc" }, select: { id: true, state: true, version: true, assigneeMemberId: true, acknowledgedAt: true } });
    expect(after).toEqual(before);
    expect((await db.handover.findUniqueOrThrow({ where: { id: h.id } })).state).toBe("ACKNOWLEDGED");

    await D.runSweep(db, D.fixedClock(s.at("20:27")), s.patientId);
    expect((await db.alert.findUniqueOrThrow({ where: { id: a.id } })).state).toBe("RESOLVED");
  });
});
