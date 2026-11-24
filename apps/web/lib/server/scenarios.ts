import { randomUUID } from "node:crypto";
/**
 * Demo Mode: virtual clock, reset, and the scenario launcher. Scenarios set up state through the
 * real domain services and agents (via MCP), then point at the next human action. No canned screens.
 */
import type { User } from "@prisma/client";
import * as D from "@carerelay/domain";
import { runIntakeAgent } from "@carerelay/agents";
import { seedDemo, demoEmail, prescriptionV2, homeCareSheet, TZ, DEMO_USERS } from "@carerelay/demo";
import { deps } from "./deps";
import { json, SESSION_COOKIE } from "./http";
import { withAgentSession } from "./agentRunner";

export const SCENARIOS = [
  { id: 1, title: "Assumption gap", summary: "Evening dose has no owner; everyone assumes someone else has it." },
  { id: 2, title: "Duplicate administration", summary: "Meena records the morning dose; Ravi tries to record it too." },
  { id: 3, title: "Prescription conflict", summary: "Prescription v2 arrives with a changed time and a new medicine." },
  { id: 4, title: "Incomplete handover", summary: "Day shift ends at 20:00 without a handover." },
  { id: 5, title: "Inventory shortage", summary: "Medicine B drops below the reorder threshold with no refill owner." },
  { id: 6, title: "Caregiver unavailable", summary: "Meena becomes unavailable during the wound-care window." },
  { id: 7, title: "Contradictory reports", summary: "Recorded as given, then a message says she hasn't had it." },
  { id: 8, title: "Silent failure", summary: "Accepted tasks pass their window with no completion record." },
  { id: 9, title: "Post-discharge extraction", summary: "A discharge home-care sheet is extracted into proposals awaiting verification." },
  { id: 10, title: "Remote family view", summary: "Arjun (Pune) sees consolidated status only." },
] as const;

async function amma() {
  const p = await deps().db.patient.findFirst({ where: { displayName: "Amma" } });
  if (!p) throw D.notFound("Demo data missing — press Reset demo data");
  return p;
}
async function demoUser(key: string) {
  return deps().db.user.findUniqueOrThrow({ where: { email: demoEmail(key) } });
}
async function ctxAs(key: string, patientId: string) {
  const { db, clock } = deps();
  const u = await demoUser(key);
  return D.resolvePatientContext(db, clock, { type: "USER", userId: u.id, name: u.name, via: "REST" }, patientId);
}

export async function setClock(user: User, body: { addMinutes: number } | { jumpTo: string }) {
  const { db, clock } = deps();
  const now = await clock.now();
  let target: Date;
  if ("addMinutes" in body) target = new Date(now.getTime() + body.addMinutes * 60_000);
  else {
    target = D.zonedTimeToUtc(D.localDateString(now, TZ), body.jumpTo, TZ);
    if (target <= now) target = D.zonedTimeToUtc(D.addDaysToDateString(D.localDateString(now, TZ), 1), body.jumpTo, TZ);
  }
  const offsetMinutes = Math.round((target.getTime() - Date.now()) / 60_000);
  await db.demoClock.upsert({ where: { id: 1 }, create: { id: 1, offsetMinutes }, update: { offsetMinutes } });
  await D.audit(db, { type: "USER", userId: user.id, name: user.name }, { action: "demo.clock", details: { from: now.toISOString(), to: target.toISOString() } }, target);
  const sweeps = await D.runSweepAll(db, clock);
  return { now: (await clock.now()).toISOString(), alertsCreated: Object.values(sweeps).reduce((n, s) => n + s.created.length, 0) };
}

export async function resetDemo() {
  const { db } = deps();
  const r = await seedDemo(db, { withMcpTokens: true });
  // Sessions were wiped: log the presenter back in as Priya so the demo continues.
  const priya = await demoUser("priya");
  const token = await D.createSession(db, priya.id);
  return json({ ok: true, demoNow: r.demoNow.toISOString(), loggedInAs: priya.email }, 200, { "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${D.SESSION_TTL_MS / 1000}` });
}

async function jumpForward(user: User, hhmm: string) {
  const now = await deps().clock.now();
  const target = D.zonedTimeToUtc(D.localDateString(now, TZ), hhmm, TZ);
  if (now < target) await setClock(user, { jumpTo: hhmm });
}

async function todaysTask(patientId: string, title: string, hhmm: string) {
  const { db, clock } = deps();
  const now = await clock.now();
  const at = D.zonedTimeToUtc(D.localDateString(now, TZ), hhmm, TZ);
  return db.task.findFirst({ where: { patientId, title: { startsWith: title }, scheduledAt: at } });
}

async function ensureMorningDoseRecorded(patientId: string, medicine: string) {
  const t = await todaysTask(patientId, medicine, "08:00");
  if (!t) throw D.notFound(`No 08:00 ${medicine} task today`);
  const existing = await deps().db.administrationRecord.findFirst({ where: { taskId: t.id, status: "RECORDED" } });
  if (!existing) {
    const meena = await ctxAs("meena", patientId);
    if (t.assigneeMemberId !== meena.member!.id) throw new D.DomainError("GUARD_FAILED", "The morning dose isn't assigned to Meena any more — press Reset demo data first.");
    await D.recordAdministration(meena, t.id, { note: "Given after breakfast" }, `scenario-${randomUUID()}`);
  }
  return t;
}

export async function runScenario(n: number, user: User) {
  const p = await amma();
  const { db, clock } = deps();
  const done: string[] = [];
  const next: { label: string; href: string; asUser?: string }[] = [];
  const sweep = async () => D.runSweep(db, clock, p.id);

  switch (n) {
    case 1: {
      await jumpForward(user, "17:30");
      done.push("Virtual clock moved to 17:30 (if it was earlier).", "Care sweep ran: the 20:00 Medicine A dose has no owner.");
      const t = await todaysTask(p.id, "Medicine A", "20:00");
      next.push({ label: "See the GAP-001 alert and its evidence", href: "/alerts", asUser: "priya" });
      if (t) next.push({ label: "Reassign it, then switch to the candidate to accept", href: `/tasks/${t.id}`, asUser: "priya" });
      break;
    }
    case 2: {
      const t = await ensureMorningDoseRecorded(p.id, "Medicine A");
      done.push("Meena recorded the 08:00 Medicine A dose (through the real administration service).");
      next.push({ label: "Switch to Ravi and try to record the same dose", href: `/tasks/${t.id}`, asUser: "ravi" });
      break;
    }
    case 3: {
      const priya = await ctxAs("priya", p.id);
      const v1 = await db.sourceDocument.findFirst({ where: { patientId: p.id, kind: "PRESCRIPTION" }, orderBy: { versionNumber: "desc" } });
      if (!v1) throw D.notFound("No prescription to version");
      if (v1.versionNumber >= 2) {
        done.push("Prescription v2 was already uploaded.");
        next.push({ label: "Open the v2 diff as the clinical verifier", href: `/documents/${v1.id}`, asUser: "clinic" });
        break;
      }
      const now = await clock.now();
      const doc = await D.createDocument(priya, { kind: "PRESCRIPTION", title: v1.title, documentDate: now, rawText: prescriptionV2(D.localDateString(now, TZ)), versionGroupId: v1.versionGroupId });
      const intake = await withAgentSession(priya.actor.userId!, p.id, "intake", (s) => runIntakeAgent(s, { patientId: p.id, documentId: doc.id }));
      await sweep();
      done.push(`Priya uploaded prescription v2. Intake Agent called ${intake.toolCalls.map((c) => c.tool).join(", ")} via MCP → ${intake.items.length} proposed items.`, "CON-002 compared v2 with the active instructions. Nothing changed in the schedule yet.");
      next.push({ label: "Review the field-by-field diff and approve as the clinical verifier", href: `/documents/${doc.id}`, asUser: "clinic" });
      break;
    }
    case 4: {
      await jumpForward(user, "20:20");
      done.push("Virtual clock moved to 20:20. Meena's shift ended at 20:00 with no handover → HND-001.");
      next.push({ label: "Switch to Meena and write/send the handover", href: "/handover", asUser: "meena" });
      next.push({ label: "Then switch to Suresh and confirm “I have read this handover”", href: "/handover", asUser: "suresh" });
      break;
    }
    case 5: {
      await ensureMorningDoseRecorded(p.id, "Medicine B");
      await sweep();
      done.push("Today's 08:00 Medicine B dose is recorded. Projection drops to ~2 days (threshold 3).");
      next.push({ label: "Open Inventory and take ownership of the refill", href: "/inventory", asUser: "ravi" });
      break;
    }
    case 6: {
      const meena = await ctxAs("meena", p.id);
      const now = await clock.now();
      const day = D.localDateString(now, TZ);
      const start = D.zonedTimeToUtc(day, "09:30", TZ);
      const end = D.zonedTimeToUtc(day, "12:30", TZ);
      const exists = await db.availability.findFirst({ where: { memberId: meena.member!.id, type: "UNAVAILABLE", start, end } });
      if (!exists) await D.addAvailability(meena, { memberId: meena.member!.id, type: "UNAVAILABLE", start, end, note: "Family emergency" });
      await sweep();
      done.push("Meena declared herself unavailable 09:30–12:30 → GAP-005 on the wound dressing and physio.");
      next.push({ label: "Open the alert → “Suggest who is free” (Coverage Agent via MCP)", href: "/alerts", asUser: "priya" });
      break;
    }
    case 7: {
      const t = await ensureMorningDoseRecorded(p.id, "Medicine A");
      const suresh = await ctxAs("suresh", p.id);
      const msg = await D.postMessage(suresh, { text: "Amma says she hasn't had her morning tablets yet.", channel: "WHATSAPP_SIMULATED", authorise: true });
      const intake = await withAgentSession(suresh.actor.userId!, p.id, "intake", (s) => runIntakeAgent(s, { patientId: p.id, messageId: msg.id }));
      await sweep();
      done.push("Meena's record says the 08:00 Medicine A dose was given.", `Suresh's message was interpreted by the Intake Agent (${intake.provider}) as “not done” → CON-001.`);
      next.push({ label: "See both reports side by side", href: `/tasks/${t.id}`, asUser: "priya" });
      break;
    }
    case 8: {
      await jumpForward(user, "13:00");
      done.push("Virtual clock moved to 13:00. Accepted tasks whose windows closed with no record became OVERDUE → GAP-003.");
      next.push({ label: "See the silent-failure alerts (advance +15 min to watch escalation)", href: "/alerts", asUser: "priya" });
      break;
    }
    case 9: {
      const priya = await ctxAs("priya", p.id);
      const now = await clock.now();
      const today = D.localDateString(now, TZ);
      const doc = await D.createDocument(priya, { kind: "INSTRUCTION", title: "Home care sheet — City Ortho", documentDate: now, rawText: homeCareSheet(today, D.addDaysToDateString(today, 5)) });
      const intake = await withAgentSession(priya.actor.userId!, p.id, "intake", (s) => runIntakeAgent(s, { patientId: p.id, documentId: doc.id }));
      done.push(`Intake Agent extracted ${intake.items.length} items with source spans; all are PROPOSED / awaiting verification. Nothing is active yet.`);
      next.push({ label: "Review highlighted spans and approve as the clinical verifier", href: `/documents/${doc.id}`, asUser: "clinic" });
      break;
    }
    case 10: {
      done.push("No setup needed: Arjun is a REMOTE_VIEWER.");
      next.push({ label: "Switch to Arjun: consolidated status only (no raw messages or documents)", href: "/", asUser: "arjun" });
      break;
    }
    default:
      throw D.notFound("Unknown scenario");
  }
  const s = SCENARIOS.find((x) => x.id === n)!;
  await D.audit(db, { type: "USER", userId: user.id, name: user.name }, { action: "demo.scenario", patientId: p.id, details: { scenario: n, title: s.title } }, await clock.now());
  return { scenario: s, done, next: next.map((x) => ({ ...x, asUserEmail: x.asUser ? demoEmail(x.asUser) : undefined, asUserName: x.asUser ? DEMO_USERS.find((u) => u.key === x.asUser)?.name : undefined })) };
}
