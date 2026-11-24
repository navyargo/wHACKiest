/**
 * Shift handovers. The snapshot is built only from recorded data; the Handover Agent may add a
 * summary whose every sentence must cite snapshot item ids. Acknowledging a handover never
 * changes any task inside it.
 */
import type { Prisma } from "@prisma/client";
import type { Db } from "./db";
import { type PatientContext, ctxAudit, requirePermission, requireMember } from "./context";
import { DomainError, notFound, staleVersion, forbidden } from "./errors";
import { HandoverSnapshotZ, HandoverSummaryZ, type HandoverSnapshot, type HandoverSummary, type SnapshotItem } from "./schemas";
import { localTimeString, localDateString } from "./time";
import { projectInventory } from "./inventory";
import { DEFAULT_RULE_CONFIG } from "./rules/config";
import { RecurrenceZ } from "./schemas";
import { notify } from "./sweep";

const H = 3_600_000;
const ACTIVE = ["UNASSIGNED", "ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED", "IN_PROGRESS", "REASSIGNED", "ESCALATED", "OVERDUE", "CONFLICTING"] as const;

export async function buildSnapshot(db: Db, patientId: string, shiftStart: Date, shiftEnd: Date, now: Date): Promise<HandoverSnapshot> {
  const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
  const tz = patient.timezone;
  const t = (d: Date) => localTimeString(d, tz);
  const members = await db.careCircleMember.findMany({ where: { patientId }, include: { user: { select: { name: true } } } });
  const who = (id: string | null) => members.find((m) => m.id === id)?.user.name ?? "no owner";

  const [completed, pending, upcoming, admins, conflicts, observations, alerts, appts, meds, approvedChanges] = await Promise.all([
    db.task.findMany({ where: { patientId, state: "COMPLETED", completedAt: { gte: shiftStart, lte: now } }, orderBy: { completedAt: "asc" } }),
    db.task.findMany({ where: { patientId, state: { in: [...ACTIVE] }, windowStart: { lte: now }, windowEnd: { gte: new Date(shiftStart.getTime() - 12 * H) } }, orderBy: { windowStart: "asc" } }),
    db.task.findMany({ where: { patientId, state: { in: [...ACTIVE] }, windowStart: { gt: now, lte: new Date(now.getTime() + 12 * H) } }, orderBy: { windowStart: "asc" } }),
    db.administrationRecord.findMany({ where: { task: { patientId }, administeredAt: { gte: shiftStart, lte: now } }, include: { task: { select: { title: true } } }, orderBy: { administeredAt: "asc" } }),
    db.conflict.findMany({ where: { patientId, state: "OPEN" } }),
    db.observation.findMany({ where: { patientId, recordedAt: { gte: shiftStart, lte: now } }, orderBy: { recordedAt: "asc" } }),
    db.alert.findMany({ where: { patientId, state: { not: "RESOLVED" }, level: { in: ["MEDIUM", "HIGH", "URGENT"] } } }),
    db.task.findMany({ where: { patientId, category: "APPOINTMENT", state: { notIn: ["CANCELLED", "COMPLETED"] }, scheduledAt: { gte: now, lte: new Date(now.getTime() + 72 * H) } }, orderBy: { scheduledAt: "asc" } }),
    db.medication.findMany({ where: { patientId, active: true }, include: { carePlanItems: { where: { active: true } } } }),
    db.extractedItem.findMany({ where: { patientId, status: "APPROVED", verifiedAt: { gte: new Date(now.getTime() - 72 * H) }, itemType: { in: ["MEDICATION", "CARE_ACTIVITY", "RESTRICTION", "APPOINTMENT"] } } }),
  ]);

  const item = (prefix: string, id: string, text: string, at: Date | null, sourceType: SnapshotItem["ref"]["sourceType"]): SnapshotItem => ({ id: `${prefix}:${id}`, text, at: at?.toISOString() ?? null, ref: { sourceType, sourceId: id } });

  const inventoryShortages: SnapshotItem[] = [];
  for (const m of meds) {
    const since = m.stockVerifiedAt ?? new Date(0);
    const [rec, dis] = await Promise.all([
      db.administrationRecord.count({ where: { medicationId: m.id, status: "RECORDED", administeredAt: { gt: since } } }),
      db.administrationRecord.count({ where: { medicationId: m.id, status: "DISPUTED", administeredAt: { gt: since } } }),
    ]);
    const perDay = m.carePlanItems.reduce((n, c) => n + (RecurrenceZ.safeParse(c.recurrence).data?.times.length ?? 0), 0);
    const p = projectInventory({ currentStock: m.currentStock, unitsPerAdministration: m.unitsPerAdministration, stockVerifiedAt: m.stockVerifiedAt, isEstimate: m.isEstimate, scheduledPerDay: perDay, recordedSinceVerification: rec, disputedSinceVerification: dis, now, freshDays: DEFAULT_RULE_CONFIG.stockFreshDays });
    if (p.daysRemaining !== null && p.daysRemaining < m.reorderThresholdDays) inventoryShortages.push(item("inv", m.id, `${m.name}: about ${p.label} left`, m.stockVerifiedAt, "MEDICATION"));
  }

  const snap: HandoverSnapshot = {
    generatedAt: now.toISOString(),
    shiftStart: shiftStart.toISOString(),
    shiftEnd: shiftEnd.toISOString(),
    completedActivities: completed.map((x) => item("done", x.id, `${x.title} — completed at ${t(x.completedAt!)} by ${who(x.completedByMemberId)}`, x.completedAt, "TASK")),
    pendingActivities: pending.map((x) => item("pending", x.id, `${x.title} — due ${t(x.windowStart)}–${t(x.windowEnd)}, ${x.state.replace(/_/g, " ").toLowerCase()}, ${who(x.assigneeMemberId)}`, x.windowStart, "TASK")),
    upcomingActivities: upcoming.map((x) => item("next", x.id, `${x.title} at ${t(x.scheduledAt)} — ${x.assigneeMemberId ? `${who(x.assigneeMemberId)} (${x.acknowledgedAt ? "accepted" : "not yet accepted"})` : "no owner yet"}`, x.scheduledAt, "TASK")),
    medicationEvents: admins.map((a) => item("med", a.id, `${a.task.title}: recorded as given at ${t(a.administeredAt)} by ${who(a.recordedByMemberId)}${a.status === "DISPUTED" ? " (second record — disputed)" : ""}`, a.administeredAt, "ADMINISTRATION")),
    unresolvedConflicts: conflicts.map((c) => item("conflict", c.id, c.title, c.createdAt, "CONFLICT")),
    observations: observations.map((o) => item("obs", o.id, `${who(o.memberId)} noted: ${o.text}`, o.recordedAt, "OBSERVATION")),
    inventoryShortages,
    activeAlerts: alerts.map((a) => item("alert", a.id, `${a.title} (coordination risk: ${a.level.toLowerCase()})`, a.detectedAt, "ALERT")),
    upcomingAppointments: appts.map((x) => item("appt", x.id, `${x.title} on ${localDateString(x.scheduledAt, tz)} at ${t(x.scheduledAt)} — ${x.assigneeMemberId ? who(x.assigneeMemberId) : "no one going yet"}`, x.scheduledAt, "TASK")),
    recentInstructionChanges: approvedChanges.map((x) => {
      const p = x.payload as Record<string, unknown>;
      return item("instr", x.id, `Approved instruction: ${String(p.name ?? p.title ?? p.text ?? x.itemType)}${Array.isArray(p.times) && p.times.length ? ` at ${(p.times as string[]).join(", ")}` : ""}`, x.verifiedAt, "EXTRACTED_ITEM");
    }),
  };
  return HandoverSnapshotZ.parse(snap);
}

export function snapshotItemIds(s: HandoverSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const v of Object.values(s)) if (Array.isArray(v)) for (const it of v as SnapshotItem[]) ids.add(it.id);
  return ids;
}

/** Drop any summary sentence that cites nothing or cites ids not in the snapshot. */
export function validateSummaryAgainstSnapshot(summary: unknown, snap: HandoverSnapshot): { summary: HandoverSummary; dropped: string[] } {
  const parsed = HandoverSummaryZ.safeParse(summary);
  if (!parsed.success) return { summary: { sentences: [] }, dropped: ["Summary did not match the required format"] };
  const ids = snapshotItemIds(snap);
  const keep: HandoverSummary["sentences"] = [];
  const dropped: string[] = [];
  for (const s of parsed.data.sentences) {
    if (s.refs.length && s.refs.every((r) => ids.has(r))) keep.push(s);
    else dropped.push(s.text);
  }
  return { summary: { sentences: keep }, dropped };
}

async function defaultShift(db: Db, memberId: string, now: Date) {
  const blocks = await db.availability.findMany({ where: { memberId, type: "WORKING_HOURS", start: { lte: new Date(now.getTime() + 2 * H) }, end: { gte: new Date(now.getTime() - 12 * H) } }, orderBy: { start: "desc" } });
  const b = blocks[0];
  return b ? { start: b.start, end: b.end } : { start: new Date(now.getTime() - 12 * H), end: now };
}

export async function draftHandover(ctx: PatientContext, input: { toMemberId: string; shiftStart?: Date; shiftEnd?: Date }) {
  requirePermission(ctx, "record_care");
  const member = requireMember(ctx);
  const to = await ctx.db.careCircleMember.findFirst({ where: { id: input.toMemberId, patientId: ctx.patientId, status: "ACTIVE" } });
  if (!to) throw new DomainError("VALIDATION_ERROR", "Recipient is not an active member of this care circle.");
  if (to.id === member.id) throw new DomainError("VALIDATION_ERROR", "Choose someone else to hand over to.");
  const now = await ctx.clock.now();
  const shift = input.shiftStart && input.shiftEnd ? { start: input.shiftStart, end: input.shiftEnd } : await defaultShift(ctx.db, member.id, now);
  const snapshot = await buildSnapshot(ctx.db, ctx.patientId, shift.start, shift.end, now);
  const h = await ctx.db.handover.create({ data: { patientId: ctx.patientId, fromMemberId: member.id, toMemberId: to.id, shiftStart: shift.start, shiftEnd: shift.end, snapshot: snapshot as unknown as Prisma.InputJsonValue, state: "DRAFT" } });
  await ctxAudit(ctx, { action: "handover.draft", targetRef: `handover:${h.id}`, details: { toMemberId: to.id } });
  return h;
}

async function loadOwn(ctx: PatientContext, id: string) {
  const h = await ctx.db.handover.findFirst({ where: { id, patientId: ctx.patientId } });
  if (!h) throw notFound("Handover not found");
  return h;
}

export async function setHandoverSummary(ctx: PatientContext, id: string, summary: unknown) {
  const member = requireMember(ctx);
  const h = await loadOwn(ctx, id);
  if (h.fromMemberId !== member.id) throw forbidden("Only the outgoing caregiver can edit this handover.");
  if (h.state !== "DRAFT") throw new DomainError("INVALID_TRANSITION", "Only drafts can be edited.");
  const { summary: clean, dropped } = validateSummaryAgainstSnapshot(summary, HandoverSnapshotZ.parse(h.snapshot));
  const updated = await ctx.db.handover.update({ where: { id: h.id }, data: { summary: clean as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
  return { handover: updated, dropped };
}

export async function updateHandoverObservations(ctx: PatientContext, id: string, observations: string, version?: number) {
  const member = requireMember(ctx);
  const h = await loadOwn(ctx, id);
  if (h.fromMemberId !== member.id) throw forbidden("Only the outgoing caregiver can edit this handover.");
  if (h.state !== "DRAFT") throw new DomainError("INVALID_TRANSITION", "Only drafts can be edited.");
  if (version !== undefined && version !== h.version) throw staleVersion();
  const upd = await ctx.db.handover.updateMany({ where: { id: h.id, version: h.version }, data: { observations, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  return ctx.db.handover.findUniqueOrThrow({ where: { id: h.id } });
}

export async function sendHandover(ctx: PatientContext, id: string, version?: number) {
  const member = requireMember(ctx);
  const h = await loadOwn(ctx, id);
  if (h.fromMemberId !== member.id) throw forbidden("Only the outgoing caregiver can send this handover.");
  if (h.state !== "DRAFT") throw new DomainError("INVALID_TRANSITION", "This handover was already sent.");
  if (version !== undefined && version !== h.version) throw staleVersion();
  const now = await ctx.clock.now();
  // Refresh the snapshot at send time so the recipient sees the latest recorded state.
  const snapshot = await buildSnapshot(ctx.db, ctx.patientId, h.shiftStart, h.shiftEnd, now);
  const keepSummary = h.summary ? validateSummaryAgainstSnapshot(h.summary, snapshot).summary : null;
  const upd = await ctx.db.handover.updateMany({ where: { id: h.id, version: h.version }, data: { state: "SENT", sentAt: now, snapshot: snapshot as unknown as Prisma.InputJsonValue, summary: (keepSummary ?? undefined) as Prisma.InputJsonValue | undefined, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  await notify(ctx.db, { patientId: ctx.patientId, memberId: h.toMemberId, title: `Handover from ${member.user.name}`, body: "Please read it and confirm with “I have read this handover”.", channel: "IN_APP", dedupeKey: `handover:${h.id}:sent`, now });
  await ctxAudit(ctx, { action: "handover.send", targetRef: `handover:${h.id}` });
  return ctx.db.handover.findUniqueOrThrow({ where: { id: h.id } });
}

/** "I have read this handover." Recipient only. Does NOT accept or complete any task in it. */
export async function acknowledgeHandover(ctx: PatientContext, id: string, version?: number) {
  const member = requireMember(ctx);
  const h = await loadOwn(ctx, id);
  if (h.toMemberId !== member.id) throw forbidden("Only the incoming caregiver can acknowledge this handover.");
  if (h.state !== "SENT") throw new DomainError("INVALID_TRANSITION", h.state === "DRAFT" ? "This handover hasn't been sent yet." : "Already acknowledged.");
  if (version !== undefined && version !== h.version) throw staleVersion();
  const now = await ctx.clock.now();
  const upd = await ctx.db.handover.updateMany({ where: { id: h.id, version: h.version }, data: { state: "ACKNOWLEDGED", acknowledgedAt: now, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  await ctxAudit(ctx, { action: "handover.acknowledge", targetRef: `handover:${h.id}`, details: { note: "Read receipt only; task states unchanged" } });
  return ctx.db.handover.findUniqueOrThrow({ where: { id: h.id } });
}

export async function listHandovers(ctx: PatientContext) {
  const [rows, members] = await Promise.all([
    ctx.db.handover.findMany({ where: { patientId: ctx.patientId }, orderBy: { createdAt: "desc" }, take: 50 }),
    ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId }, include: { user: { select: { name: true } } } }),
  ]);
  const name = (id: string) => members.find((m) => m.id === id)?.user.name ?? "Unknown";
  return rows
    .filter((h) => h.state !== "DRAFT" || h.fromMemberId === ctx.member?.id)
    .map((h) => ({ ...h, fromName: name(h.fromMemberId), toName: name(h.toMemberId) }));
}

export async function getHandover(ctx: PatientContext, id: string) {
  const h = await loadOwn(ctx, id);
  if (h.state === "DRAFT" && h.fromMemberId !== ctx.member?.id) throw notFound("Handover not found");
  const members = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId }, include: { user: { select: { name: true } } } });
  const name = (mid: string) => members.find((m) => m.id === mid)?.user.name ?? "Unknown";
  return { ...h, fromName: name(h.fromMemberId), toName: name(h.toMemberId) };
}
