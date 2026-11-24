import { describe, expect, it } from "vitest";
import { ExtractionOutputZ, PAYLOAD_SCHEMAS, HandoverSnapshotZ, validateSummaryAgainstSnapshot, locateQuote, parseWhatsAppExport } from "@carerelay/domain";
import { mockExtractDocument, mockExtractMessage, DeterministicMockProvider } from "@carerelay/agents";
import { prescriptionV2, dischargeSummary } from "@carerelay/demo";

describe("AI output schemas", () => {
  it("accepts a valid extraction", () => {
    expect(ExtractionOutputZ.safeParse({ items: [{ itemType: "MEDICATION", payload: { name: "Medicine A" }, quote: "Medicine A", confidence: 0.9 }] }).success).toBe(true);
  });
  it.each([
    [{ items: [{ itemType: "PRESCRIBE", payload: {}, quote: "x", confidence: 0.9 }] }, "unknown type"],
    [{ items: [{ itemType: "MEDICATION", payload: {}, quote: "", confidence: 0.9 }] }, "empty quote"],
    [{ items: [{ itemType: "MEDICATION", payload: {}, quote: "x", confidence: 1.4 }] }, "confidence > 1"],
    [{ result: [] }, "wrong shape"],
  ])("rejects %j (%s)", (v, _why) => expect(ExtractionOutputZ.safeParse(v).success).toBe(false));
  it("payload schemas reject incomplete medication / bad times", () => {
    expect(PAYLOAD_SCHEMAS.MEDICATION.safeParse({ strength: "5 mg" }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS.MEDICATION.safeParse({ name: "Medicine A", unitsPerAdministration: 1, times: ["8am"] }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS.COMPLETION_REPORT.safeParse({ claim: "MAYBE", text: "x" }).success).toBe(false);
  });
});

describe("source spans", () => {
  it("locates quotes exactly or case-insensitively, else empty", () => {
    const t = "Line one\nGive Medicine A at 08:00";
    expect(locateQuote(t, "Medicine A")).toEqual({ start: 14, end: 24 });
    expect(locateQuote(t, "medicine a")).toEqual({ start: 14, end: 24 });
    expect(locateQuote(t, "not there")).toEqual({ start: 0, end: 0 });
  });
});

describe("deterministic mock provider", () => {
  it("extracts the v2 prescription (time change + new medicine with duration)", () => {
    const items = mockExtractDocument(prescriptionV2("2026-01-10"));
    const meds = items.filter((i) => i.itemType === "MEDICATION").map((i) => i.payload);
    expect(meds.map((m) => m.name)).toEqual(["Medicine A", "Medicine B", "Medicine C", "Medicine D"]);
    expect(meds[1].times).toEqual(["13:00"]);
    expect(meds[3]).toMatchObject({ durationDays: 10, unitsPerAdministration: 1, doseText: "1 tablet" });
  });
  it("extracts discharge instructions incl. qualification and appointment", () => {
    const items = mockExtractDocument(dischargeSummary("2026-01-07", "2026-01-12"));
    expect(items.find((i) => i.itemType === "CARE_ACTIVITY" && i.payload.category === "WOUND_CARE")?.payload.requiredQualification).toBe("WOUND_CARE_TRAINED");
    expect(items.filter((i) => i.itemType === "RESTRICTION")).toHaveLength(2);
    expect(items.find((i) => i.itemType === "APPOINTMENT")?.payload).toMatchObject({ date: "2026-01-12", time: "16:00" });
  });
  it("interprets hand-offs, reports and schedule changes in messages", () => {
    const names = ["Priya Raman", "Ravi Raman", "Suresh Kumar"];
    expect(mockExtractMessage("Ravi will give Amma the evening medicine today.", "Priya Raman", names, "2026-01-10")[0]).toMatchObject({ itemType: "COMMITMENT", payload: { isHandoff: true, committedName: "Ravi", date: "2026-01-10" } });
    expect(mockExtractMessage("Amma says she hasn't had her morning tablets yet.", "Suresh Kumar", names, "2026-01-10")[0]).toMatchObject({ itemType: "COMPLETION_REPORT", payload: { claim: "NOT_DONE", timeOfDay: "morning" } });
    expect(mockExtractMessage("The follow-up on 2026-01-12 is cancelled.", "Clinic", names, "2026-01-10")[0]).toMatchObject({ itemType: "SCHEDULE_CHANGE", payload: { status: "CANCELLED", date: "2026-01-12" } });
  });
  it("assistant loop answers only via tools and says so when it can't", async () => {
    const p = new DeterministicMockProvider();
    const calls: string[] = [];
    const r = await p.runToolLoop({ system: "", user: "What is the weather?", tools: [], maxSteps: 3, context: { patientId: "x" }, callTool: async (n) => (calls.push(n), { ok: true, text: "{}" }) });
    expect(r.finalText).toBe("I don't have that information in CareRelay.");
    expect(calls).toHaveLength(0);
  });
});

describe("handover summary validator", () => {
  const snap = HandoverSnapshotZ.parse({
    generatedAt: "2026-01-10T12:00:00Z", shiftStart: "2026-01-10T02:30:00Z", shiftEnd: "2026-01-10T14:30:00Z",
    completedActivities: [], pendingActivities: [{ id: "pending:t1", text: "Physio", at: null, ref: { sourceType: "TASK", sourceId: "t1" } }],
    upcomingActivities: [], medicationEvents: [], unresolvedConflicts: [], observations: [], inventoryShortages: [], activeAlerts: [], upcomingAppointments: [], recentInstructionChanges: [],
  });
  it("drops sentences without valid refs", () => {
    const r = validateSummaryAgainstSnapshot({ sentences: [{ text: "Physio is pending.", refs: ["pending:t1"] }, { text: "She seems fine.", refs: ["made-up"] }] }, snap);
    expect(r.summary.sentences).toHaveLength(1);
    expect(r.dropped).toEqual(["She seems fine."]);
  });
  it("rejects malformed output entirely", () => {
    expect(validateSummaryAgainstSnapshot({ text: "hello" }, snap).summary.sentences).toHaveLength(0);
  });
});

describe("WhatsApp export parser", () => {
  it("parses Android 24h and iOS 12h formats with continuation lines", () => {
    const txt = "12/03/2025, 09:15 - Priya: Good morning\nsecond line\n12/03/2025, 09:16 - Messages are end-to-end encrypted\n[12/03/25, 9:20:05 PM] Ravi: I will take Amma tomorrow\n12/03/2025, 10:00 - Meena: <Media omitted>";
    const r = parseWhatsAppExport(txt);
    expect(r).toEqual([
      { sentAt: { date: "2025-03-12", time: "09:15" }, sender: "Priya", text: "Good morning\nsecond line" },
      { sentAt: { date: "2025-03-12", time: "21:20" }, sender: "Ravi", text: "I will take Amma tomorrow" },
    ]);
  });
});
