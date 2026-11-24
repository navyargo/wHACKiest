import { describe, expect, it } from "vitest";
import { GAP_001, GAP_002, GAP_003, GAP_004, GAP_005, DUP_001, CON_001, CON_002, CON_003, HND_001, INV_001, INV_002, DEFAULT_RULE_CONFIG, type RuleInput, type RTask, type RExtracted } from "@carerelay/domain";

const NOW = new Date("2026-01-10T12:00:00Z");
const min = (n: number) => new Date(NOW.getTime() + n * 60_000);
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function task(over: Partial<RTask> = {}): RTask {
  return { id: id(), title: "Medicine A", category: "MEDICATION", priority: "HIGH", state: "UNASSIGNED", scheduledAt: min(60), windowStart: min(30), windowEnd: min(120), assigneeMemberId: null, requiredQualification: null, nonRepeatable: true, medicationId: null, completedAt: null, completedByMemberId: null, events: [], administrations: [], ...over };
}
const members = [
  { id: "coord", name: "Priya", role: "PATIENT_OR_REPRESENTATIVE", qualifications: [], canManage: true, canCare: true, canVerify: true },
  { id: "meena", name: "Meena", role: "PROFESSIONAL_CAREGIVER", qualifications: ["WOUND_CARE_TRAINED"], canManage: false, canCare: true, canVerify: false },
  { id: "suresh", name: "Suresh", role: "PROFESSIONAL_CAREGIVER", qualifications: [], canManage: false, canCare: true, canVerify: false },
  { id: "ravi", name: "Ravi", role: "FAMILY_CAREGIVER", qualifications: [], canManage: false, canCare: true, canVerify: false },
];
function input(over: Partial<RuleInput> = {}): RuleInput {
  return { now: NOW, tz: "Asia/Kolkata", tasks: [], members, availability: [], handovers: [], medications: [], replenishments: [], extracted: [], pendingVersions: [], aiProvider: "mock", config: DEFAULT_RULE_CONFIG, ...over };
}
const ev = (type: string, at: Date, payload: Record<string, unknown> = {}) => ({ id: id(), type, fromState: null, toState: null, createdAt: at, actorName: "Priya", payload });
function extracted(over: Partial<RExtracted>): RExtracted {
  return { id: id(), itemType: "COMPLETION_REPORT", payload: {}, confidence: 0.85, status: "PROPOSED", sourceType: "MESSAGE", sourceId: id(), span: { start: 0, end: 10 }, excerpt: "text", createdAt: NOW, sourceAt: NOW, senderMemberId: "suresh", senderName: "Suresh", detectedBy: "mock:rule-based", ...over };
}

describe("GAP-001 unowned high-priority task", () => {
  it("fires when the window opens within 3 h and nobody owns it", () => {
    const f = GAP_001.run(input({ tasks: [task()] }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ ruleId: "GAP-001", level: "HIGH" });
  });
  it("is URGENT once the window has opened", () => {
    expect(GAP_001.run(input({ tasks: [task({ windowStart: min(-5) })] }))[0].level).toBe("URGENT");
  });
  it("does not fire for owned, low priority or far-off tasks", () => {
    expect(GAP_001.run(input({ tasks: [task({ assigneeMemberId: "meena", state: "ACKNOWLEDGED" }), task({ priority: "NORMAL" }), task({ windowStart: min(300), windowEnd: min(400) })] }))).toHaveLength(0);
  });
});

describe("GAP-002 assigned but not acknowledged", () => {
  it("fires within 60 min of the window", () => {
    const f = GAP_002.run(input({ tasks: [task({ state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: "suresh", events: [ev("ASSIGN", min(-120))] })] }));
    expect(f).toHaveLength(1);
    expect(f[0].responders).toContain("suresh");
  });
  it("does not fire when acknowledged or still far away", () => {
    expect(GAP_002.run(input({ tasks: [task({ state: "ACKNOWLEDGED", assigneeMemberId: "suresh" }), task({ state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: "suresh", windowStart: min(200), windowEnd: min(260) })] }))).toHaveLength(0);
  });
});

describe("GAP-003 silent failure", () => {
  it("fires and marks overdue when the window passed without completion", () => {
    const f = GAP_003.run(input({ tasks: [task({ state: "ACKNOWLEDGED", assigneeMemberId: "meena", windowStart: min(-120), windowEnd: min(-10) })] }));
    expect(f[0]).toMatchObject({ ruleId: "GAP-003", taskAction: { event: "MARK_OVERDUE" } });
  });
  it("does not fire for completed tasks or open windows", () => {
    expect(GAP_003.run(input({ tasks: [task({ state: "COMPLETED", windowEnd: min(-10) }), task({ state: "ACKNOWLEDGED" })] }))).toHaveLength(0);
  });
});

describe("GAP-004 transfer not accepted", () => {
  it("fires 30 min after an unaccepted reassignment", () => {
    const t = task({ state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: "ravi", windowStart: min(240), windowEnd: min(300), events: [ev("REASSIGN", min(-40))] });
    expect(GAP_004.run(input({ tasks: [t] }))).toHaveLength(1);
  });
  it("does not fire right after the reassignment or once accepted", () => {
    const fresh = task({ state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: "ravi", windowStart: min(240), windowEnd: min(300), events: [ev("REASSIGN", min(-5))] });
    const accepted = task({ state: "ACKNOWLEDGED", assigneeMemberId: "ravi", events: [ev("REASSIGN", min(-40)), ev("ACKNOWLEDGE", min(-30))] });
    expect(GAP_004.run(input({ tasks: [fresh, accepted] }))).toHaveLength(0);
  });
  it("AI hand-off: confident → alert; low confidence → needs review (informational)", () => {
    const x = extracted({ itemType: "COMMITMENT", payload: { isHandoff: true, committedMemberId: "ravi", committedName: "Ravi" }, confidence: 0.82 });
    const low = extracted({ itemType: "COMMITMENT", payload: { isHandoff: true, committedMemberId: "ravi", committedName: "Ravi" }, confidence: 0.4 });
    const f = GAP_004.run(input({ extracted: [x, low] }));
    expect(f.map((a) => a.level).sort()).toEqual(["INFORMATIONAL", "MEDIUM"]);
    expect(f.find((a) => a.level === "MEDIUM")!.basis.kind).toBe("AI");
  });
  it("AI hand-off: no alert once confirmed or not a hand-off", () => {
    expect(GAP_004.run(input({ extracted: [extracted({ itemType: "COMMITMENT", status: "APPROVED", payload: { isHandoff: true } }), extracted({ itemType: "COMMITMENT", payload: { isHandoff: false } })] }))).toHaveLength(0);
  });
});

describe("GAP-005 assignee unavailable", () => {
  const t = task({ state: "ACKNOWLEDGED", assigneeMemberId: "meena" });
  it("fires on overlap", () => {
    expect(GAP_005.run(input({ tasks: [t], availability: [{ id: id(), memberId: "meena", type: "UNAVAILABLE", start: min(0), end: min(90), note: "", source: "MANUAL" }] }))).toHaveLength(1);
  });
  it("ignores non-overlapping blocks, other members and working hours", () => {
    expect(GAP_005.run(input({ tasks: [t], availability: [{ id: id(), memberId: "meena", type: "UNAVAILABLE", start: min(200), end: min(300), note: "", source: "MANUAL" }, { id: id(), memberId: "ravi", type: "UNAVAILABLE", start: min(0), end: min(200), note: "", source: "MANUAL" }, { id: id(), memberId: "meena", type: "WORKING_HOURS", start: min(0), end: min(200), note: "", source: "MANUAL" }] }))).toHaveLength(0);
  });
});

describe("DUP-001 duplicate administration", () => {
  it("raises a clinically significant conflict and flags the task", () => {
    const t = task({ state: "COMPLETED", administrations: [{ id: id(), status: "RECORDED", recordedByMemberId: "meena", administeredAt: min(-60), note: "" }, { id: id(), status: "DISPUTED", recordedByMemberId: "ravi", administeredAt: min(-30), note: "" }] });
    const f = DUP_001.run(input({ tasks: [t] }));
    expect(f[0]).toMatchObject({ level: "URGENT", taskAction: { event: "FLAG_CONFLICT" }, conflict: { kind: "DUPLICATE_ADMINISTRATION", clinicallySignificant: true } });
    expect(f[0].explanation).toMatch(/does not advise on dosing/);
  });
  it("is silent with a single record", () => {
    expect(DUP_001.run(input({ tasks: [task({ administrations: [{ id: id(), status: "RECORDED", recordedByMemberId: "meena", administeredAt: min(-60), note: "" }] })] }))).toHaveLength(0);
  });
});

describe("CON-001 contradictory reports", () => {
  it("done then later 'not done' → conflict", () => {
    const t = task({ state: "COMPLETED", administrations: [{ id: id(), status: "RECORDED", recordedByMemberId: "meena", administeredAt: min(-60), note: "" }] });
    const notDone = extracted({ payload: { claim: "NOT_DONE", linkedTaskId: t.id }, sourceAt: min(-20) });
    const f = CON_001.run(input({ tasks: [t], extracted: [notDone] }));
    expect(f[0]).toMatchObject({ ruleId: "CON-001", conflict: { kind: "CONTRADICTORY_REPORT" } });
    expect(f[0].evidence).toHaveLength(2);
  });
  it("'not done' before it was done is not a contradiction", () => {
    const t = task({ state: "COMPLETED", administrations: [{ id: id(), status: "RECORDED", recordedByMemberId: "meena", administeredAt: min(-10), note: "" }] });
    expect(CON_001.run(input({ tasks: [t], extracted: [extracted({ payload: { claim: "NOT_DONE", linkedTaskId: t.id }, sourceAt: min(-30) })] }))).toHaveLength(0);
  });
  it("AI-only low confidence → informational needs-review", () => {
    const t = task();
    const f = CON_001.run(input({ tasks: [t], extracted: [extracted({ payload: { claim: "DONE", linkedTaskId: t.id }, sourceAt: min(-40), confidence: 0.5 }), extracted({ payload: { claim: "NOT_DONE", linkedTaskId: t.id }, sourceAt: min(-20), confidence: 0.5 })] }));
    expect(f[0]).toMatchObject({ level: "INFORMATIONAL" });
    expect(f[0].conflict).toBeUndefined();
  });
});

describe("CON-002 instruction version diff", () => {
  const pv = (diff: RuleInput["pendingVersions"][number]["diff"]) => ({ approvalId: id(), documentId: id(), documentTitle: "Prescription", versionNumber: 2, uploadedByName: "Priya", createdAt: NOW, diff });
  it("fires when the new version changes something", () => {
    const f = CON_002.run(input({ pendingVersions: [pv([{ change: "CHANGED", medication: "Medicine B", fields: [{ field: "times", old: "08:00", new: "13:00" }], oldRefId: id(), newRefId: id() }])] }));
    expect(f[0]).toMatchObject({ conflict: { kind: "INSTRUCTION_VERSION", clinicallySignificant: true } });
    expect(f[0].evidence.some((e) => e.excerpt.includes('"08:00" → "13:00"'))).toBe(true);
  });
  it("is silent when nothing changed", () => {
    expect(CON_002.run(input({ pendingVersions: [pv([{ change: "UNCHANGED", medication: "Medicine A", fields: [], oldRefId: id(), newRefId: id() }])] }))).toHaveLength(0);
  });
});

describe("CON-003 appointment status", () => {
  const appt = task({ category: "APPOINTMENT", title: "Follow-up", state: "UNASSIGNED", scheduledAt: new Date("2026-01-12T10:30:00Z"), windowStart: new Date("2026-01-12T09:00:00Z"), windowEnd: new Date("2026-01-12T11:30:00Z") });
  it("fires when a message says it's cancelled on that date", () => {
    expect(CON_003.run(input({ tasks: [appt], extracted: [extracted({ itemType: "SCHEDULE_CHANGE", payload: { status: "CANCELLED", date: "2026-01-12" } })] }))).toHaveLength(1);
  });
  it("ignores other dates, confirmations and rejected items", () => {
    expect(CON_003.run(input({ tasks: [appt], extracted: [extracted({ itemType: "SCHEDULE_CHANGE", payload: { status: "CANCELLED", date: "2026-01-20" } }), extracted({ itemType: "SCHEDULE_CHANGE", payload: { status: "CONFIRMED", date: "2026-01-12" } }), extracted({ itemType: "SCHEDULE_CHANGE", status: "REJECTED", payload: { status: "CANCELLED", date: "2026-01-12" } })] }))).toHaveLength(0);
  });
});

describe("HND-001 handover", () => {
  const shifts = [
    { id: id(), memberId: "meena", type: "WORKING_HOURS" as const, start: min(-12 * 60 - 20), end: min(-20), note: "", source: "MANUAL" },
    { id: id(), memberId: "suresh", type: "WORKING_HOURS" as const, start: min(-20), end: min(12 * 60), note: "", source: "MANUAL" },
  ];
  it("fires when a shift ended with no handover", () => {
    expect(HND_001.run(input({ availability: shifts }))[0].title).toMatch(/No handover from Meena to Suresh/);
  });
  it("fires when a sent handover is unacknowledged for 30 min", () => {
    const f = HND_001.run(input({ availability: shifts, handovers: [{ id: id(), fromMemberId: "meena", toMemberId: "suresh", shiftStart: shifts[0].start, shiftEnd: shifts[0].end, state: "SENT", sentAt: min(-35) }] }));
    expect(f[0].title).toMatch(/hasn't read/);
  });
  it("is silent once acknowledged, or during the grace period", () => {
    expect(HND_001.run(input({ availability: shifts, handovers: [{ id: id(), fromMemberId: "meena", toMemberId: "suresh", shiftStart: shifts[0].start, shiftEnd: shifts[0].end, state: "ACKNOWLEDGED", sentAt: min(-35) }] }))).toHaveLength(0);
    expect(HND_001.run(input({ now: min(-15), availability: shifts }))).toHaveLength(0);
  });
});

describe("INV-001 / INV-002 inventory", () => {
  const med = (over = {}) => ({ id: id(), name: "Medicine B", form: "tablet", unitsPerAdministration: 1, currentStock: 3, stockVerifiedAt: min(-60), isEstimate: false, reorderThresholdDays: 3, scheduledPerDay: 1, recordedSinceVerification: 1, disputedSinceVerification: 0, ...over });
  it("INV-001 fires below threshold with no accepted owner", () => {
    const m = med();
    expect(INV_001.run(input({ medications: [m] }))).toHaveLength(1);
    expect(INV_001.run(input({ medications: [m], replenishments: [{ id: id(), medicationId: m.id, state: "ACKNOWLEDGED", assigneeMemberId: "ravi" }] }))).toHaveLength(0);
  });
  it("INV-001 still fires when the refill is assigned but not accepted", () => {
    const m = med();
    expect(INV_001.run(input({ medications: [m], replenishments: [{ id: id(), medicationId: m.id, state: "AWAITING_ACKNOWLEDGEMENT", assigneeMemberId: "ravi" }] }))[0].explanation).toMatch(/not yet accepted/);
  });
  it("INV-001 silent above threshold", () => {
    expect(INV_001.run(input({ medications: [med({ currentStock: 30 })] }))).toHaveLength(0);
  });
  it("INV-002 fires at zero stock with scheduled administrations", () => {
    expect(INV_002.run(input({ medications: [med({ currentStock: 1, recordedSinceVerification: 1 })] }))[0].level).toBe("URGENT");
    expect(INV_002.run(input({ medications: [med({ currentStock: 1, recordedSinceVerification: 1, scheduledPerDay: 0 })] }))).toHaveLength(0);
  });
});
