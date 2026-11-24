import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as D from "@carerelay/domain";
import { db, freshSeed, ctx, todaysTask, rest, resetSessions } from "./helpers";
import { dispatch } from "@/lib/server/http";
import { routes } from "@/lib/server/routes";

async function fetchNoKey(path: string) {
  const u = await db.user.findFirstOrThrow({ where: { email: "meena@demo.carerelay.local" } });
  const token = await D.createSession(db, u.id);
  const res = await dispatch(routes, new Request(`http://test.local/api${path}`, { method: "POST", headers: { cookie: `cr_session=${token}`, "content-type": "application/json" }, body: "{}" }), path.split("/").filter(Boolean));
  return res.status;
}

let s: Awaited<ReturnType<typeof freshSeed>>;
beforeAll(async () => {
  s = await freshSeed();
  resetSessions();
});

describe("concurrency, duplicates and idempotency", () => {
  it("two concurrent completions: exactly one succeeds", async () => {
    const t = await todaysTask(s.patientId, "Wound dressing", "10:00", s.at);
    const when = s.at("10:20");
    const [a, b] = await Promise.allSettled([
      D.transitionTask(await ctx("meena", s.patientId, when), t.id, { event: "COMPLETE", version: t.version, idempotencyKey: randomUUID() }),
      D.transitionTask(await ctx("meena", s.patientId, when), t.id, { event: "COMPLETE", version: t.version, idempotencyKey: randomUUID() }),
    ]);
    const ok = [a, b].filter((r) => r.status === "fulfilled");
    const failed = [a, b].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0].reason as D.DomainError).code).toBe("STALE_VERSION");
    expect(await db.taskEvent.count({ where: { taskId: t.id, type: "COMPLETE" } })).toBe(1);
  });

  it("concurrent administration records: only one RECORDED", async () => {
    const t = await todaysTask(s.patientId, "Medicine B", "08:00", s.at);
    const when = s.at("08:10");
    await Promise.allSettled([1, 2].map(async () => D.recordAdministration(await ctx("meena", s.patientId, when), t.id, { note: "" }, randomUUID())));
    expect(await db.administrationRecord.count({ where: { taskId: t.id, status: "RECORDED" } })).toBe(1);
  });

  it("duplicate administration: warning with the existing record, then a conflict; the original is unchanged", async () => {
    const t = await todaysTask(s.patientId, "Medicine A", "08:00", s.at);
    await D.recordAdministration(await ctx("meena", s.patientId, s.at("08:06")), t.id, { note: "after breakfast" }, randomUUID());
    const original = await db.administrationRecord.findFirstOrThrow({ where: { taskId: t.id, status: "RECORDED" } });

    const err = await D.recordAdministration(await ctx("ravi", s.patientId, s.at("08:30")), t.id, { note: "I gave it" }, randomUUID()).catch((e) => e as D.DomainError);
    expect(err).toBeInstanceOf(D.DomainError);
    expect((err as D.DomainError).code).toBe("DUPLICATE_ADMINISTRATION");
    expect(((err as D.DomainError).details as { existing: { recordedBy: string } }).existing.recordedBy).toBe("Meena Joseph");
    expect((err as D.DomainError).message).toMatch(/can't advise/);

    const r = await D.recordAdministration(await ctx("ravi", s.patientId, s.at("08:31")), t.id, { note: "I gave it", confirmDuplicate: true }, randomUUID());
    expect(r.status).toBe("flagged");
    await D.runSweep(db, D.fixedClock(s.at("08:32")), s.patientId);

    const conflict = await db.conflict.findFirstOrThrow({ where: { patientId: s.patientId, kind: "DUPLICATE_ADMINISTRATION" } });
    expect(conflict).toMatchObject({ state: "OPEN", clinicallySignificant: true, detectedBy: "RULE:DUP-001" });
    expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).state).toBe("CONFLICTING");
    expect(await db.administrationRecord.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
    expect(await db.alert.count({ where: { patientId: s.patientId, ruleId: "DUP-001", state: { not: "RESOLVED" } } })).toBe(1);
  });

  it("idempotency-key replay (service): same result, no second event", async () => {
    const t = await todaysTask(s.patientId, "Medicine C", "21:00", s.at);
    const key = randomUUID();
    const c = await ctx("suresh", s.patientId, s.at("08:40"));
    const a = await D.transitionTask(c, t.id, { event: "ACKNOWLEDGE", idempotencyKey: key });
    const b = await D.transitionTask(c, t.id, { event: "ACKNOWLEDGE", idempotencyKey: key });
    expect(b).toEqual(a);
    expect(await db.taskEvent.count({ where: { taskId: t.id, type: "ACKNOWLEDGE" } })).toBe(1);
  });

  it("idempotency-key replay (REST): stored response, replay header, no second event", async () => {
    const t = await todaysTask(s.patientId, "Physiotherapy", "17:00", s.at);
    const key = randomUUID();
    const body = { event: "START", version: t.version };
    const first = await rest("meena", "POST", `/patients/${s.patientId}/tasks/${t.id}/transition`, body, key);
    expect(first.status).toBe(200);
    const second = await rest("meena", "POST", `/patients/${s.patientId}/tasks/${t.id}/transition`, body, key);
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(await db.taskEvent.count({ where: { taskId: t.id, type: "START" } })).toBe(1);
  });

  it("REST: stale version → 409 STALE_VERSION; missing idempotency key → 400; invalid transition → 409", async () => {
    const t = await todaysTask(s.patientId, "Physiotherapy", "11:00", s.at);
    const stale = await rest("meena", "POST", `/patients/${s.patientId}/tasks/${t.id}/transition`, { event: "START", version: t.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_VERSION");
    const evening = await todaysTask(s.patientId, "Medicine A", "20:00", s.at);
    const forbidden = await rest("meena", "POST", `/patients/${s.patientId}/tasks/${evening.id}/transition`, { event: "ASSIGN", version: evening.version, targetMemberId: s.users.ravi.memberId });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    const missing = await fetchNoKey(`/patients/${s.patientId}/tasks/${t.id}/transition`);
    expect(missing).toBe(400);
    const invalid = await rest("priya", "POST", `/patients/${s.patientId}/tasks/${t.id}/transition`, { event: "ASSIGN", version: t.version, targetMemberId: s.users.ravi.memberId });
    expect(invalid.status).toBe(409);
    expect(invalid.body.error.code).toBe("INVALID_TRANSITION");
  });
});
