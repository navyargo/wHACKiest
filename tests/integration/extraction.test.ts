import { beforeAll, describe, expect, it } from "vitest";
import * as D from "@carerelay/domain";
import { runExtraction, DeterministicMockProvider, type LlmProvider } from "@carerelay/agents";
import { prescriptionV2, homeCareSheet } from "@carerelay/demo";
import { db, freshSeed, ctx, todaysTask } from "./helpers";

let s: Awaited<ReturnType<typeof freshSeed>>;
const mock = new DeterministicMockProvider();
beforeAll(async () => {
  s = await freshSeed();
});

describe("extraction → verification → tasks", () => {
  it("post-discharge sheet: items stay proposed until a verify_medical approval, then tasks are generated", async () => {
    const priya = await ctx("priya", s.patientId, s.at("09:00"));
    const today = D.localDateString(s.at("09:00"), "Asia/Kolkata");
    const doc = await D.createDocument(priya, { kind: "INSTRUCTION", title: "Home care sheet", documentDate: s.at("09:00"), rawText: homeCareSheet(today, D.addDaysToDateString(today, 5)) });
    const plansBefore = await db.carePlanItem.count({ where: { patientId: s.patientId } });
    const r = await runExtraction(priya, { type: "DOCUMENT", id: doc.id }, mock);
    expect(r.status).toBe("STORED");
    expect(r.items.length).toBe(4);
    expect(r.items.every((i) => ["PROPOSED", "AWAITING_VERIFICATION"].includes(i.status))).toBe(true);
    expect(r.items.every((i) => i.span.end > i.span.start)).toBe(true);
    expect(await db.carePlanItem.count({ where: { patientId: s.patientId } })).toBe(plansBefore);

    // A family caregiver can't approve; the clinical verifier can.
    const ravi = await ctx("ravi", s.patientId, s.at("09:05"));
    await expect(D.decideApproval({ ...ravi, db }, r.approvalRequestId!, { decision: "APPROVED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const verifier = await ctx("clinic", s.patientId, s.at("09:10"));
    const out = await D.decideApproval({ ...verifier, db }, r.approvalRequestId!, { decision: "APPROVED", reason: "Matches the paper sheet" });
    expect((out.outcome.activated as string[]).length).toBe(2); // sugar check + ice pack
    expect(out.outcome.appointments as string[]).toHaveLength(1);
    const items = await db.extractedItem.findMany({ where: { sourceId: doc.id } });
    expect(items.every((i) => i.status === "APPROVED" && i.verifiedBy === verifier.actor.userId && i.verifiedAt)).toBe(true);
    expect(await db.task.count({ where: { patientId: s.patientId, title: { startsWith: "Ice pack" } } })).toBeGreaterThan(0);
  });

  it("prescription v2: diff + CON-002, schedule unchanged until approval, old version kept", async () => {
    const priya = await ctx("priya", s.patientId, s.at("09:20"));
    const v1 = await db.sourceDocument.findFirstOrThrow({ where: { patientId: s.patientId, kind: "PRESCRIPTION" } });
    const v2 = await D.createDocument(priya, { kind: "PRESCRIPTION", title: v1.title, documentDate: s.at("09:20"), rawText: prescriptionV2("2026-01-10"), versionGroupId: v1.versionGroupId });
    expect(v2.versionNumber).toBe(2);
    const r = await runExtraction(priya, { type: "DOCUMENT", id: v2.id }, mock);
    const diff = await D.computeDocumentDiff(db, s.patientId, v2.id);
    expect(diff.find((d) => d.medication === "Medicine B")).toMatchObject({ change: "CHANGED", fields: [{ field: "times", old: "08:00", new: "13:00" }, { field: "instructions" }] });
    expect(diff.find((d) => d.medication === "Medicine D")?.change).toBe("ADDED");

    await D.runSweep(db, D.fixedClock(s.at("09:21")), s.patientId);
    const conflict = await db.conflict.findFirstOrThrow({ where: { patientId: s.patientId, kind: "INSTRUCTION_VERSION", state: "OPEN" } });
    expect(conflict.clinicallySignificant).toBe(true);
    const tomorrowB = await todaysTask(s.patientId, "Medicine B", "08:00", (h) => s.at(h, 1));
    expect(tomorrowB.state).toBe("UNASSIGNED"); // schedule unchanged

    const verifier = await ctx("clinic", s.patientId, s.at("09:30"));
    await D.decideApproval({ ...verifier, db }, r.approvalRequestId!, { decision: "APPROVED", reason: "Confirmed with Dr. Nair" });
    expect((await db.task.findUniqueOrThrow({ where: { id: tomorrowB.id } })).state).toBe("CANCELLED");
    const active = await db.carePlanItem.findMany({ where: { patientId: s.patientId, active: true, category: "MEDICATION" } });
    expect(active.map((a) => a.title.split(" —")[0]).sort()).toEqual(["Medicine A 500 mg", "Medicine B 5 mg", "Medicine C 40 mg", "Medicine D 10 mg"]);
    expect(active.find((a) => a.title.startsWith("Medicine B"))!.recurrence).toMatchObject({ times: ["13:00"] });
    expect(await db.carePlanItem.count({ where: { patientId: s.patientId, active: false, title: { startsWith: "Medicine B" } } })).toBe(1);
    expect(await db.sourceDocument.findUnique({ where: { id: v1.id } })).not.toBeNull();
    expect((await db.conflict.findUniqueOrThrow({ where: { id: conflict.id } })).state).toBe("RESOLVED");
    expect(await db.task.count({ where: { patientId: s.patientId, title: { startsWith: "Medicine B" }, scheduledAt: s.at("13:00", 1) } })).toBe(1);
  });

  it("AI output: retries once with the error, then marks 'Needs manual review' and stores nothing", async () => {
    const priya = await ctx("priya", s.patientId, s.at("09:40"));
    const doc = await D.createDocument(priya, { kind: "OTHER", title: "Note", documentDate: s.at("09:40"), rawText: "Medicine Z 1 mg tablet at 08:00" });
    const errors: (string | undefined)[] = [];
    let n = 0;
    const flaky: LlmProvider = { ...mock, name: "flaky", mode: "MOCK", summarizeHandover: mock.summarizeHandover, runToolLoop: mock.runToolLoop,
      extract: async (_i, prev) => {
        errors.push(prev);
        return ++n === 1 ? { items: [{ itemType: "NOPE" }] } : { items: [{ itemType: "OBSERVATION", payload: { text: "Medicine Z mentioned" }, quote: "Medicine Z", confidence: 0.9 }] };
      } };
    const ok = await runExtraction(priya, { type: "DOCUMENT", id: doc.id }, flaky);
    expect(ok.status).toBe("STORED");
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toMatch(/itemType/);

    const broken: LlmProvider = { ...flaky, extract: async () => ({ garbage: true }) };
    const before = await db.extractedItem.count();
    const bad = await runExtraction(priya, { type: "DOCUMENT", id: doc.id }, broken);
    expect(bad.status).toBe("NEEDS_MANUAL_REVIEW");
    expect(await db.extractedItem.count()).toBe(before);
  });

  it("unauthorised messages are never processed", async () => {
    const m = await db.sourceMessage.findFirstOrThrow({ where: { patientId: s.patientId, authorisedForProcessing: false } });
    await expect(runExtraction(await ctx("priya", s.patientId, s.at("09:50")), { type: "MESSAGE", id: m.id }, mock)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
