/**
 * Deterministic synthetic demo data (no real personal data). One Bengaluru household plus a
 * second, unrelated patient used to prove cross-patient isolation. Built through the real domain
 * services with fixed clocks so histories, events and audit entries are genuine.
 */
import type { PrismaClient } from "@prisma/client";
import {
  fixedClock,
  hashPassword,
  resolvePatientContext,
  createDocument,
  decideApproval,
  generateOccurrences,
  transitionTask,
  recordAdministration,
  verifyStock,
  draftHandover,
  sendHandover,
  acknowledgeHandover,
  runSweep,
  createOneOffTask,
  zonedTimeToUtc,
  localDateString,
  addDaysToDateString,
  localTimeString,
  sha256,
  type Actor,
} from "@carerelay/domain";
import { DeterministicMockProvider, runExtraction } from "@carerelay/agents";
import { prescriptionV1, dischargeSummary } from "./documents";

export const DEMO_PASSWORD = "carerelay-demo";
export const DEMO_DOMAIN = "demo.carerelay.local";
export const TZ = "Asia/Kolkata";
/** Virtual time the demo starts at (local), on the day the seed runs. */
export const DEMO_START_TIME = "08:05";

export const DEMO_USERS = [
  { key: "priya", name: "Priya Raman", relationship: "Daughter (representative), Bengaluru", role: "PATIENT_OR_REPRESENTATIVE", quals: [] as string[] },
  { key: "ravi", name: "Ravi Raman", relationship: "Son, family caregiver", role: "FAMILY_CAREGIVER", quals: [] },
  { key: "meena", name: "Meena Joseph", relationship: "Professional day attendant", role: "PROFESSIONAL_CAREGIVER", quals: ["WOUND_CARE_TRAINED"] },
  { key: "suresh", name: "Suresh Kumar", relationship: "Professional night attendant", role: "PROFESSIONAL_CAREGIVER", quals: ["WOUND_CARE_TRAINED"] },
  { key: "arjun", name: "Arjun Raman", relationship: "Grandson, Pune (remote)", role: "REMOTE_VIEWER", quals: [] },
  { key: "clinic", name: "Lakshmi (Dr. Nair's clinic coordinator)", relationship: "Clinic coordinator — clinical verifier", role: "CLINICAL_VERIFIER", quals: ["NURSE"] },
] as const;
export const OTHER_USER = { key: "kavya", name: "Kavya Iyer", role: "PATIENT_OR_REPRESENTATIVE" } as const;

export const demoEmail = (key: string) => `${key}@${DEMO_DOMAIN}`;
export const demoMcpToken = (key: string) => `crt_demo_${key}_${"0".repeat(22)}`;

const TABLES = ["AuditLog", "TaskEvent", "AdministrationRecord", "Notification", "Alert", "Conflict", "ApprovalRequest", "ReplenishmentRequest", "Task", "CarePlanItem", "Medication", "ExtractedItem", "SourceMessage", "SourceDocument", "Handover", "Observation", "Availability", "EscalationPolicy", "CareCircleMember", "McpToken", "Session", "IdempotencyRecord", "Patient", "User", "DemoClock"];

export async function wipe(db: PrismaClient) {
  await db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export interface SeedResult {
  patientId: string;
  otherPatientId: string;
  demoNow: Date;
  users: Record<string, { id: string; memberId: string | null }>;
}

export async function seedDemo(db: PrismaClient, opts: { realNow?: Date; withMcpTokens?: boolean } = {}): Promise<SeedResult> {
  const realNow = opts.realNow ?? new Date();
  await wipe(db);
  const D = localDateString(realNow, TZ);
  const day = (n: number) => addDaysToDateString(D, n);
  const at = (n: number, hhmm: string) => zonedTimeToUtc(day(n), hhmm, TZ);
  const demoNow = at(0, DEMO_START_TIME);
  const provider = new DeterministicMockProvider();

  // ---------------- users & patients
  const hash = await hashPassword(DEMO_PASSWORD);
  const users: SeedResult["users"] = {};
  for (const u of [...DEMO_USERS, OTHER_USER]) {
    const row = await db.user.create({ data: { name: u.name, email: demoEmail(u.key), passwordHash: hash, preferredLanguage: "en" } });
    users[u.key] = { id: row.id, memberId: null };
  }
  const amma = await db.patient.create({
    data: {
      displayName: "Amma",
      fullName: "Kamala R.",
      age: 78,
      conditions: ["Type 2 diabetes (entered by family)", "Hypertension (entered by family)", "Recent right knee replacement"],
      allergies: ["Penicillin"],
      mobilityNotes: "Uses a walker for all transfers. No stairs without assistance.",
      preferredLanguage: "en",
      timezone: TZ,
      emergencyContacts: [{ name: "Priya Raman", relation: "Daughter", phone: "+91-00000-00001 (fictional)" }],
    },
  });
  const appa = await db.patient.create({ data: { displayName: "Appa", fullName: "Venkat I.", age: 81, conditions: ["(entered by family) Hypertension"], allergies: [], timezone: TZ } });

  for (const u of DEMO_USERS) {
    const m = await db.careCircleMember.create({ data: { patientId: amma.id, userId: users[u.key].id, role: u.role, relationship: u.relationship, qualifications: [...u.quals] } });
    users[u.key].memberId = m.id;
  }
  const kavyaMember = await db.careCircleMember.create({ data: { patientId: appa.id, userId: users.kavya.id, role: "PATIENT_OR_REPRESENTATIVE", relationship: "Daughter" } });
  users.kavya.memberId = kavyaMember.id;
  const M = (k: string) => users[k].memberId!;

  const steps = [
    { afterMinutes: 0, notifyRoles: [], memberIds: [], channel: "IN_APP" },
    { afterMinutes: 15, notifyRoles: ["CARE_COORDINATOR", "PATIENT_OR_REPRESENTATIVE"], memberIds: [], channel: "IN_APP" },
    { afterMinutes: 30, notifyRoles: ["PATIENT_OR_REPRESENTATIVE"], memberIds: [], channel: "VOICE_ELEVENLABS" },
  ];
  await db.escalationPolicy.create({ data: { patientId: amma.id, name: "Default: responders → coordinators (15 min) → representative by voice (30 min)", steps, isDefault: true } });
  await db.escalationPolicy.create({ data: { patientId: appa.id, name: "Default", steps, isDefault: true } });

  // ---------------- availability (shifts + simulated calendar)
  for (let n = -3; n <= 2; n++) {
    await db.availability.create({ data: { memberId: M("meena"), type: "WORKING_HOURS", start: at(n, "08:00"), end: at(n, "20:00"), source: "MANUAL", note: "Day shift" } });
    await db.availability.create({ data: { memberId: M("suresh"), type: "WORKING_HOURS", start: at(n, "20:00"), end: at(n + 1, "08:00"), source: "MANUAL", note: "Night shift" } });
  }
  await db.availability.create({ data: { memberId: M("ravi"), type: "CALENDAR_BUSY", start: at(0, "09:00"), end: at(0, "18:00"), source: "CALENDAR_SIMULATED", note: "Office (simulated calendar)" } });
  await db.availability.create({ data: { memberId: M("priya"), type: "CALENDAR_BUSY", start: at(0, "14:00"), end: at(0, "15:30"), source: "CALENDAR_SIMULATED", note: "Meeting (simulated calendar)" } });

  // ---------------- contexts with fixed clocks
  const actorFor = (k: string): Actor => ({ type: "USER", userId: users[k].id, name: [...DEMO_USERS, OTHER_USER].find((u) => u.key === k)!.name, via: "SEED" });
  const ctxAt = (k: string, when: Date, patientId = amma.id) => resolvePatientContext(db, fixedClock(when), actorFor(k), patientId);
  let keyN = 0;
  const key = () => `seed-${++keyN}`;

  // ---------------- documents → extraction → verifier approval
  const rx1 = await createDocument(await ctxAt("priya", at(-2, "05:00")), { kind: "PRESCRIPTION", title: "Prescription — Dr. Nair", documentDate: at(-10, "10:00"), rawText: prescriptionV1(day(-10)) });
  await db.sourceDocument.update({ where: { id: rx1.id }, data: { createdAt: at(-2, "05:00") } });
  const ds = await createDocument(await ctxAt("priya", at(-2, "05:05")), { kind: "DISCHARGE_SUMMARY", title: "Discharge summary — City Ortho", documentDate: at(-3, "12:00"), rawText: dischargeSummary(day(-3), day(2)) });
  await db.sourceDocument.update({ where: { id: ds.id }, data: { createdAt: at(-2, "05:05") } });
  for (const doc of [rx1, ds]) {
    const r = await runExtraction(await ctxAt("priya", at(-2, "05:10")), { type: "DOCUMENT", id: doc.id }, provider);
    if (!r.approvalRequestId) throw new Error(`Seed extraction produced no approval for ${doc.title}`);
    const verifier = await ctxAt("clinic", at(-2, "05:30"));
    await decideApproval({ ...verifier, db }, r.approvalRequestId, { decision: "APPROVED", reason: "Checked against the original paper copy" });
  }

  // ---------------- occurrences D-2 … D+1
  await generateOccurrences(db, fixedClock(at(-2, "06:00")), amma.id, 4);

  // ---------------- stock counts
  const meds = await db.medication.findMany({ where: { patientId: amma.id } });
  const med = (prefix: string) => meds.find((m) => m.name.startsWith(prefix))!;
  await verifyStock(await ctxAt("priya", at(-2, "07:00")), med("Medicine A").id, 30);
  await verifyStock(await ctxAt("priya", at(-2, "07:00")), med("Medicine C").id, 20);

  // ---------------- history for D-2 and D-1: assigned, accepted, done
  const history = await db.task.findMany({ where: { patientId: amma.id, scheduledAt: { lt: at(0, "00:00") } }, orderBy: { scheduledAt: "asc" } });
  for (const t of history) {
    const hour = Number(localTimeString(t.scheduledAt, TZ).slice(0, 2));
    const who = hour >= 8 && hour < 20 ? "meena" : "suresh";
    await transitionTask(await ctxAt("priya", new Date(t.windowStart.getTime() - 3 * 3_600_000)), t.id, { event: "ASSIGN", targetMemberId: M(who), idempotencyKey: key() });
    await transitionTask(await ctxAt(who, new Date(t.windowStart.getTime() - 2 * 3_600_000)), t.id, { event: "ACKNOWLEDGE", idempotencyKey: key() });
    const done = new Date(t.scheduledAt.getTime() + 5 * 60_000);
    if (t.nonRepeatable) await recordAdministration(await ctxAt(who, done), t.id, { administeredAt: done, note: "" }, key());
    else await transitionTask(await ctxAt(who, new Date(t.scheduledAt.getTime() + 25 * 60_000)), t.id, { event: "COMPLETE", note: "Done as instructed", idempotencyKey: key() });
  }
  // Medicine B counted after yesterday's morning dose: 3 left (1/day scheduled).
  await verifyStock(await ctxAt("priya", at(-1, "09:00")), med("Medicine B").id, 3);

  // ---------------- handover history
  for (const n of [-2, -1]) {
    const h1 = await draftHandover(await ctxAt("meena", at(n, "19:50")), { toMemberId: M("suresh"), shiftStart: at(n, "08:00"), shiftEnd: at(n, "20:00") });
    await sendHandover(await ctxAt("meena", at(n, "19:55")), h1.id);
    await acknowledgeHandover(await ctxAt("suresh", at(n, "20:05")), h1.id);
    const h2 = await draftHandover(await ctxAt("suresh", at(n + 1, "07:40")), { toMemberId: M("meena"), shiftStart: at(n, "20:00"), shiftEnd: at(n + 1, "08:00") });
    await sendHandover(await ctxAt("suresh", at(n + 1, "07:45")), h2.id);
    await acknowledgeHandover(await ctxAt("meena", at(n + 1, "07:58")), h2.id);
  }

  // ---------------- today's assignments (state at 08:05)
  const today = await db.task.findMany({ where: { patientId: amma.id, scheduledAt: { gte: at(0, "00:00"), lt: at(1, "00:00") } }, orderBy: { scheduledAt: "asc" } });
  for (const t of today) {
    const time = localTimeString(t.scheduledAt, TZ);
    if (time === "20:00") continue; // assumption gap: nobody owns the evening dose
    const who = time === "21:00" ? "suresh" : "meena";
    await transitionTask(await ctxAt("priya", at(0, "07:00")), t.id, { event: "ASSIGN", targetMemberId: M(who), idempotencyKey: key() });
    if (who === "meena") await transitionTask(await ctxAt("meena", at(0, "07:59")), t.id, { event: "ACKNOWLEDGE", idempotencyKey: key() });
  }

  // ---------------- simulated messages (WhatsApp/SMS)
  const msgs: { d: number; t: string; who: string | null; name?: string; text: string; ch?: "WHATSAPP_SIMULATED" | "SMS_SIMULATED"; auth?: boolean; extract?: boolean }[] = [
    { d: -2, t: "07:10", who: "priya", text: "Good morning all. Amma is home from City Ortho. Discharge papers are uploaded in CareRelay." },
    { d: -2, t: "09:20", who: "priya", text: "Meena, the nurse showed you the dressing. Please do it at 10 every day." },
    { d: -2, t: "10:40", who: "meena", text: "Dressing changed at 10:30. Wound looks clean, no discharge." },
    { d: -2, t: "11:45", who: "meena", text: "Physio exercises done. She walked to the window with the walker." },
    { d: -2, t: "15:00", who: "ravi", text: "Picked up the ice packs from the pharmacy." },
    { d: -2, t: "19:30", who: "meena", text: "She ate well at dinner. A little tired." },
    { d: -2, t: "21:15", who: "suresh", text: "Gave the night tablet at 9. She is sleeping." },
    { d: -1, t: "06:50", who: "suresh", text: "Slept well. Woke once at 3 am for the washroom, used the walker." },
    { d: -1, t: "08:20", who: "meena", text: "Gave her the morning tablets after breakfast." },
    { d: -1, t: "10:35", who: "meena", text: "Dressing done. Slight redness near the stitches, I've noted it." },
    { d: -1, t: "12:10", who: "arjun", text: "How is Amma doing today? Can someone send a photo later?" },
    { d: -1, t: "13:00", who: "priya", text: "She is doing well Arjun. Physio is tiring her but she is trying." },
    { d: -1, t: "15:30", who: null, name: "City Pharmacy", ch: "SMS_SIMULATED", text: "City Pharmacy: your Medicine B refill can be picked up after 5 pm." },
    { d: -1, t: "17:40", who: "meena", text: "Evening physio done, 10 repetitions each." },
    { d: -1, t: "18:30", who: "ravi", text: "I am worried she is not drinking enough water." },
    { d: -1, t: "19:45", who: "meena", text: "Knee a bit swollen in the evening, kept the leg raised." },
    { d: -1, t: "21:10", who: "suresh", text: "Night tablet given at 9." },
    { d: -1, t: "22:00", who: "priya", text: "Thank you Suresh. Please message if she needs anything." },
    { d: 0, t: "06:55", who: "suresh", text: "Amma slept well, woke up once at 3 am. Knee slightly swollen this morning.", extract: true },
    { d: 0, t: "07:10", who: null, name: "Dr. Nair's clinic", ch: "SMS_SIMULATED", auth: false, text: `Dr. Nair's clinic: the follow-up appointment on ${day(2)} at 16:00 is cancelled due to the doctor's leave. Please call to reschedule.` },
    { d: 0, t: "07:20", who: "priya", text: "Ravi will give Amma the evening medicine today, Suresh has a family function till 9.", extract: true },
    { d: 0, t: "07:30", who: "ravi", text: `I will take Amma to the hospital for the follow-up on ${day(2)}.`, extract: true },
    { d: 0, t: "07:40", who: "suresh", text: "Leaving at 8 after Meena comes. Handover sent in the app." },
    { d: 0, t: "07:55", who: "meena", text: "Reached. Read Suresh's handover." },
    { d: 0, t: "08:01", who: "priya", text: "Thanks Meena. Ravi is in office till 6 today." },
  ];
  for (const m of msgs) {
    const row = await db.sourceMessage.create({
      data: { patientId: amma.id, channel: m.ch ?? "WHATSAPP_SIMULATED", senderMemberId: m.who ? M(m.who) : null, senderName: m.who ? DEMO_USERS.find((u) => u.key === m.who)!.name : (m.name ?? "Unknown"), sentAt: at(m.d, m.t), text: m.text, authorisedForProcessing: m.auth ?? true, createdAt: at(m.d, m.t) },
    });
    if (m.extract) await runExtraction(await ctxAt(m.who ?? "priya", new Date(at(m.d, m.t).getTime() + 60_000)), { type: "MESSAGE", id: row.id }, provider);
  }

  // ---------------- second patient (isolation)
  await createOneOffTask(await ctxAt("kavya", at(0, "07:00"), appa.id), { title: "Evening walk with Appa", category: "OTHER", priority: "NORMAL", scheduledAt: at(0, "18:00"), windowMinutesBefore: 30, windowMinutesAfter: 60 }, key());
  await createDocument(await ctxAt("kavya", at(0, "07:05"), appa.id), { kind: "OTHER", title: "Appa — clinic note (synthetic)", documentDate: at(-5, "10:00"), rawText: "SYNTHETIC DEMO DOCUMENT — NOT MEDICAL GUIDANCE\nPrivate note for Appa's family only." });
  await db.sourceMessage.create({ data: { patientId: appa.id, channel: "WHATSAPP_SIMULATED", senderMemberId: kavyaMember.id, senderName: OTHER_USER.name, sentAt: at(0, "07:10"), text: "Private family message about Appa.", authorisedForProcessing: true } });

  // ---------------- initial sweep at demo start; demo clock
  await runSweep(db, fixedClock(demoNow), amma.id);
  await runSweep(db, fixedClock(demoNow), appa.id);
  await db.demoClock.create({ data: { id: 1, offsetMinutes: Math.round((demoNow.getTime() - realNow.getTime()) / 60_000) } });

  if (opts.withMcpTokens) {
    for (const k of ["priya", "ravi", "meena", "suresh", "arjun", "clinic", "kavya"]) {
      await db.mcpToken.create({ data: { userId: users[k].id, patientId: null, label: `demo-${k}`, tokenHash: sha256(demoMcpToken(k)), expiresAt: new Date(realNow.getTime() + 365 * 86_400_000) } });
    }
  }
  return { patientId: amma.id, otherPatientId: appa.id, demoNow, users };
}
