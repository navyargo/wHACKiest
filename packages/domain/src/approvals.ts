/**
 * ApprovalRequests for sensitive actions. Created by users, agents or MCP PROPOSE tools;
 * decided only by a human USER holding the request's requiredPermission. Approval executes the action.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./db";
import { type PatientContext, ctxAudit, requirePermission, withDb } from "./context";
import { DomainError, notFound, staleVersion, forbidden } from "./errors";
import { SENSITIVE_ACTIONS, type SensitiveAction, ROLES, type Permission } from "./authz";
import { applyTaskEvent, generateOccurrences, systemTransition } from "./tasks";
import { MedicationPayloadZ, CareActivityPayloadZ, AppointmentPayloadZ } from "./schemas";
import { computeDocumentDiff } from "./documentDiff";
import { zonedTimeToUtc, addDaysToDateString, localDateString } from "./time";
import { executeConflictResolution } from "./conflicts";
import { hashPassword } from "./auth";
import { randomBytes } from "node:crypto";

export async function createApproval(
  ctx: PatientContext,
  input: { actionType: SensitiveAction; title: string; payload: Prisma.InputJsonValue },
  db: Db = ctx.db,
) {
  const requiredPermission = SENSITIVE_ACTIONS[input.actionType];
  if (!requiredPermission) throw new DomainError("VALIDATION_ERROR", `Unknown sensitive action ${input.actionType}`);
  const a = await db.approvalRequest.create({
    data: { patientId: ctx.patientId, actionType: input.actionType, title: input.title, payload: input.payload, requestedByUserId: ctx.actor.userId, requestedByType: ctx.actor.type, requiredPermission },
  });
  await ctxAudit(ctx, { action: "approval.request", targetRef: `approval:${a.id}`, details: { actionType: input.actionType, requestedByType: ctx.actor.type } }, db);
  return a;
}

export async function listApprovals(ctx: PatientContext, state?: string) {
  const rows = await ctx.db.approvalRequest.findMany({ where: { patientId: ctx.patientId, ...(state ? { state: state as never } : {}) }, orderBy: { createdAt: "desc" }, take: 100 });
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedByUserId, r.decidedBy]).filter((x): x is string => !!x))];
  const users = await ctx.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
  return rows.map((r) => ({ ...r, requestedByName: r.requestedByType === "AGENT" ? `${nameOf(r.requestedByUserId) ?? "Unknown"} via AI agent` : nameOf(r.requestedByUserId), decidedByName: nameOf(r.decidedBy), canDecide: ctx.permissions.has(r.requiredPermission as Permission) && ctx.actor.type === "USER" }));
}

export async function decideApproval(
  ctx: PatientContext & { db: PrismaClient },
  approvalId: string,
  input: { decision: "APPROVED" | "REJECTED"; reason?: string | null; version?: number },
) {
  if (ctx.actor.type !== "USER") throw forbidden("Approvals can only be decided by a person, never by an agent.");
  const now = await ctx.clock.now();
  const result = await ctx.db.$transaction(
    async (tx) => {
      const a = await tx.approvalRequest.findFirst({ where: { id: approvalId, patientId: ctx.patientId } });
      if (!a) throw notFound("Approval request not found");
      requirePermission(ctx, a.requiredPermission as Permission);
      if (a.state !== "PENDING") throw new DomainError("INVALID_TRANSITION", `This request was already ${a.state.toLowerCase()}.`);
      if (input.version !== undefined && input.version !== a.version) throw staleVersion();
      if (input.decision === "REJECTED" && !input.reason?.trim()) throw new DomainError("GUARD_FAILED", "Give a reason for rejecting.");
      const upd = await tx.approvalRequest.updateMany({ where: { id: a.id, version: a.version }, data: { state: input.decision, decidedBy: ctx.actor.userId, decidedAt: now, reason: input.reason ?? null, version: { increment: 1 } } });
      if (upd.count === 0) throw staleVersion();
      const txCtx = withDb(ctx, tx);
      let outcome: Record<string, unknown> = {};
      if (input.decision === "APPROVED") outcome = await execute(txCtx, a, now);
      else outcome = await onReject(txCtx, a, input.reason ?? "", now);
      await tx.approvalRequest.update({ where: { id: a.id }, data: { result: outcome as Prisma.InputJsonValue } });
      await ctxAudit(txCtx, { action: `approval.${input.decision.toLowerCase()}`, targetRef: `approval:${a.id}`, details: { actionType: a.actionType, reason: input.reason ?? null, outcome: outcome as Prisma.InputJsonValue } });
      return { approval: { ...a, state: input.decision }, outcome };
    },
    { timeout: 30_000 },
  );
  if (input.decision === "APPROVED" && (result.approval.actionType === "ACTIVATE_INSTRUCTIONS" || result.approval.actionType === "CHANGE_CARE_PLAN_ITEM")) {
    result.outcome.tasksGenerated = await generateOccurrences(ctx.db, ctx.clock, ctx.patientId);
  }
  return result;
}

type ApprovalRow = Awaited<ReturnType<Db["approvalRequest"]["findFirstOrThrow"]>>;

async function onReject(ctx: PatientContext, a: ApprovalRow, reason: string, now: Date) {
  const p = a.payload as Record<string, unknown>;
  if (a.actionType === "ACTIVATE_INSTRUCTIONS") {
    const ids = (p.itemIds as string[]) ?? [];
    await ctx.db.extractedItem.updateMany({ where: { id: { in: ids }, status: { in: ["PROPOSED", "AWAITING_VERIFICATION"] } }, data: { status: "REJECTED", rejectionReason: reason, verifiedBy: ctx.actor.userId, verifiedAt: now } });
    await ctx.db.conflict.updateMany({ where: { patientId: ctx.patientId, dedupeKey: `CON-002:${p.documentId}`, state: "OPEN" }, data: { state: "RESOLVED", resolution: `New version rejected by ${ctx.actor.name}: ${reason}. Previously approved instructions remain active.`, resolvedBy: ctx.actor.userId, resolvedAt: now } });
    return { rejectedItems: ids.length };
  }
  return {};
}

async function execute(ctx: PatientContext, a: ApprovalRow, now: Date): Promise<Record<string, unknown>> {
  const p = a.payload as Record<string, unknown>;
  const db = ctx.db;
  switch (a.actionType as SensitiveAction) {
    case "ACTIVATE_INSTRUCTIONS":
      return activateInstructions(ctx, String(p.documentId), (p.itemIds as string[]) ?? [], now);
    case "RESOLVE_CLINICAL_CONFLICT": {
      const c = await db.conflict.findFirst({ where: { id: String(p.conflictId), patientId: ctx.patientId } });
      if (!c) throw notFound("Conflict not found");
      await executeConflictResolution(ctx, c, String(p.resolution), (p.resolveTo as string | undefined) ?? undefined, now, `approval:${a.id}`);
      return { conflictId: c.id, resolved: true };
    }
    case "REASSIGN_TASK": {
      const task = await db.task.findFirst({ where: { id: String(p.taskId), patientId: ctx.patientId } });
      if (!task) throw notFound("Task not found");
      const event = !task.assigneeMemberId ? "ASSIGN" : "REASSIGN";
      const updated = await applyTaskEvent(db, now, ctx.actor, ctx.member, task, { event, targetMemberId: String(p.toMemberId), reason: String(p.reason ?? "Approved reassignment"), idempotencyKey: `approval:${a.id}` });
      return { taskId: task.id, state: updated.state, assigneeMemberId: updated.assigneeMemberId };
    }
    case "ADD_MEMBER": {
      const email = String(p.email).toLowerCase();
      let user = await db.user.findUnique({ where: { email } });
      if (!user) user = await db.user.create({ data: { email, name: String(p.name), passwordHash: await hashPassword(randomBytes(16).toString("hex")) } });
      const role = String(p.role);
      if (!(ROLES as readonly string[]).includes(role)) throw new DomainError("VALIDATION_ERROR", "Unknown role");
      const m = await db.careCircleMember.upsert({
        where: { patientId_userId: { patientId: ctx.patientId, userId: user.id } },
        create: { patientId: ctx.patientId, userId: user.id, role: role as never, qualifications: (p.qualifications as string[]) ?? [], relationship: String(p.relationship ?? "") },
        update: { status: "ACTIVE", role: role as never },
      });
      return { memberId: m.id, note: "Account created without a usable password; the person signs in once an administrator sets one (not built in this MVP)." };
    }
    case "CHANGE_MEMBER_ROLE": {
      const m = await db.careCircleMember.update({ where: { id: String(p.memberId) }, data: { role: p.role as never, version: { increment: 1 } } });
      return { memberId: m.id, role: m.role };
    }
    case "REMOVE_MEMBER": {
      const m = await db.careCircleMember.update({ where: { id: String(p.memberId) }, data: { status: "REMOVED", version: { increment: 1 } } });
      return { memberId: m.id, status: m.status };
    }
    case "GRANT_MESSAGE_ACCESS": {
      const m = await db.careCircleMember.update({ where: { id: String(p.memberId) }, data: { messageAccessGranted: true, version: { increment: 1 } } });
      return { memberId: m.id, messageAccessGranted: true };
    }
    case "CHANGE_CARE_PLAN_ITEM": {
      const item = await db.carePlanItem.findFirst({ where: { id: String(p.carePlanItemId), patientId: ctx.patientId } });
      if (!item) throw notFound("Care plan item not found");
      if (p.deactivate) {
        await db.carePlanItem.update({ where: { id: item.id }, data: { active: false, version: { increment: 1 } } });
        await supersedeFutureTasks(db, item.id, now, `Instruction stopped (approved by ${ctx.actor.name})`);
        return { carePlanItemId: item.id, active: false };
      }
      throw new DomainError("VALIDATION_ERROR", "Unsupported care plan change");
    }
  }
  throw new DomainError("VALIDATION_ERROR", `No executor for ${a.actionType}`);
}

async function supersedeFutureTasks(db: Db, carePlanItemId: string, now: Date, reason: string) {
  const future = await db.task.findMany({ where: { carePlanItemId, windowStart: { gt: now } } });
  let n = 0;
  for (const t of future) if (await systemTransition(db, now, t, "SUPERSEDE", `supersede:${t.id}`, reason)) n++;
  return n;
}

/**
 * Turn approved extracted items into active care-plan items / tasks.
 * For a new document version: unchanged medicines keep their existing plan item;
 * changed or removed ones are deactivated (kept for history) and their future tasks superseded.
 */
export async function activateInstructions(ctx: PatientContext, documentId: string, itemIds: string[], now: Date) {
  const db = ctx.db;
  const doc = await db.sourceDocument.findFirst({ where: { id: documentId, patientId: ctx.patientId } });
  if (!doc) throw notFound("Document not found");
  const patient = await db.patient.findUniqueOrThrow({ where: { id: ctx.patientId } });
  const items = await db.extractedItem.findMany({ where: { id: { in: itemIds }, patientId: ctx.patientId, status: { in: ["PROPOSED", "AWAITING_VERIFICATION"] } } });
  const diff = await computeDocumentDiff(db, ctx.patientId, documentId);
  const out = { activated: [] as string[], kept: [] as string[], deactivated: [] as string[], tasksSuperseded: 0, appointments: [] as string[], restrictions: [] as string[] };

  // Validate first so nothing half-activates.
  const problems: string[] = [];
  for (const x of items) {
    if (x.itemType === "MEDICATION") {
      const m = MedicationPayloadZ.safeParse(x.payload);
      if (!m.success) problems.push(`Medication item is invalid`);
      else {
        if (!m.data.times.length) problems.push(`${m.data.name}: add administration times before approving`);
        if (m.data.unitsPerAdministration == null) problems.push(`${m.data.name}: add units per administration (as written in the source) before approving`);
      }
    }
    if (x.itemType === "CARE_ACTIVITY") {
      const c = CareActivityPayloadZ.safeParse(x.payload);
      if (!c.success) problems.push("Care activity item is invalid");
    }
  }
  if (problems.length) throw new DomainError("GUARD_FAILED", `Can't activate yet: ${problems.join("; ")}.`, { problems });

  const endDate = (days: number | null) => (days ? addDaysToDateString(localDateString(now, patient.timezone), days - 1) : undefined);

  // Changed/removed medicines from earlier versions → deactivate + supersede future tasks.
  for (const d of diff) {
    if ((d.change === "CHANGED" || d.change === "REMOVED") && d.oldRefId) {
      await db.carePlanItem.update({ where: { id: d.oldRefId }, data: { active: false, version: { increment: 1 } } });
      out.tasksSuperseded += await supersedeFutureTasks(db, d.oldRefId, now, `Replaced by "${doc.title}" v${doc.versionNumber} (approved by ${ctx.actor.name})`);
      out.deactivated.push(d.oldRefId);
    }
  }

  for (const x of items) {
    if (x.itemType === "MEDICATION") {
      const m = MedicationPayloadZ.parse(x.payload);
      const entry = diff.find((d) => d.newRefId === x.id);
      if (entry?.change === "UNCHANGED" && entry.oldRefId) {
        out.kept.push(entry.oldRefId);
      } else {
        const label = `${m.name}${m.strength ? ` ${m.strength}` : ""}`;
        const med = await db.medication.upsert({
          where: { patientId_name: { patientId: ctx.patientId, name: label } },
          create: { patientId: ctx.patientId, name: label, form: m.form, unitsPerAdministration: m.unitsPerAdministration!, currentStock: 0, isEstimate: true },
          update: { unitsPerAdministration: m.unitsPerAdministration!, active: true },
        });
        const item = await db.carePlanItem.create({
          data: {
            patientId: ctx.patientId,
            title: `${label}${m.doseText ? ` — ${m.doseText}` : ""}`,
            instructions: [m.frequencyText, m.instructions].filter(Boolean).join(". "),
            category: "MEDICATION",
            recurrence: { times: m.times, ...(endDate(m.durationDays) ? { endDate: endDate(m.durationDays) } : {}) },
            priority: "HIGH",
            nonRepeatable: true,
            medicationId: med.id,
            sourceExtractedItemId: x.id,
            sourceDocumentId: doc.id,
            approvedBy: ctx.actor.userId!,
            approvedAt: now,
          },
        });
        out.activated.push(item.id);
      }
    } else if (x.itemType === "CARE_ACTIVITY") {
      const c = CareActivityPayloadZ.parse(x.payload);
      if (c.times.length) {
        const item = await db.carePlanItem.create({
          data: {
            patientId: ctx.patientId,
            title: c.title,
            instructions: c.instructions,
            category: c.category,
            recurrence: { times: c.times, ...(endDate(c.durationDays) ? { endDate: endDate(c.durationDays) } : {}) },
            priority: c.category === "WOUND_CARE" ? "HIGH" : "NORMAL",
            requiredQualification: c.requiredQualification,
            sourceExtractedItemId: x.id,
            sourceDocumentId: doc.id,
            approvedBy: ctx.actor.userId!,
            approvedAt: now,
          },
        });
        out.activated.push(item.id);
      } else out.restrictions.push(x.id);
    } else if (x.itemType === "APPOINTMENT") {
      const ap = AppointmentPayloadZ.parse(x.payload);
      if (ap.date && ap.time) {
        const at = zonedTimeToUtc(ap.date, ap.time, patient.timezone);
        const task = await db.task.create({
          data: { patientId: ctx.patientId, title: ap.title, description: [ap.location, ap.notes].filter(Boolean).join(" — "), category: "APPOINTMENT", scheduledAt: at, windowStart: new Date(at.getTime() - 90 * 60_000), windowEnd: new Date(at.getTime() + 60 * 60_000), priority: "HIGH", state: "UNASSIGNED" },
        });
        await db.taskEvent.create({ data: { taskId: task.id, type: "CREATED", toState: "UNASSIGNED", actorType: "USER", actorUserId: ctx.actor.userId, payload: { actorName: ctx.actor.name, reason: `Approved from "${doc.title}"`, extractedItemId: x.id }, idempotencyKey: `activate:${x.id}`, createdAt: now } });
        out.appointments.push(task.id);
      } else out.restrictions.push(x.id);
    } else {
      out.restrictions.push(x.id);
    }
    await db.extractedItem.update({ where: { id: x.id }, data: { status: "APPROVED", verifiedBy: ctx.actor.userId, verifiedAt: now } });
  }

  await db.conflict.updateMany({
    where: { patientId: ctx.patientId, dedupeKey: `CON-002:${documentId}`, state: "OPEN" },
    data: { state: "RESOLVED", resolution: `Version ${doc.versionNumber} approved by ${ctx.actor.name}. Earlier instructions kept in history.`, resolvedBy: ctx.actor.userId, resolvedAt: now },
  });
  await ctxAudit(ctx, { action: "instructions.activate", targetRef: `document:${documentId}`, details: out });
  return out;
}

/** Agent/MCP proposal: reassign a task (always an ApprovalRequest; the candidate must still accept). */
export async function proposeReassignment(ctx: PatientContext, input: { taskId: string; toMemberId: string; reason: string }) {
  const task = await ctx.db.task.findFirst({ where: { id: input.taskId, patientId: ctx.patientId } });
  if (!task) throw notFound("Task not found");
  const m = await ctx.db.careCircleMember.findFirst({ where: { id: input.toMemberId, patientId: ctx.patientId, status: "ACTIVE" }, include: { user: { select: { name: true } } } });
  if (!m) throw new DomainError("VALIDATION_ERROR", "Candidate is not an active member of this care circle.");
  if (task.requiredQualification && !m.qualifications.includes(task.requiredQualification)) {
    throw new DomainError("GUARD_FAILED", `${m.user.name} doesn't have the ${task.requiredQualification} qualification this task needs.`);
  }
  const dup = await ctx.db.approvalRequest.findFirst({ where: { patientId: ctx.patientId, actionType: "REASSIGN_TASK", state: "PENDING", AND: [{ payload: { path: ["taskId"], equals: task.id } }, { payload: { path: ["toMemberId"], equals: m.id } }] } });
  if (dup) return dup;
  return createApproval(ctx, { actionType: "REASSIGN_TASK", title: `${task.assigneeMemberId ? "Reassign" : "Assign"} "${task.title}" to ${m.user.name}`, payload: { taskId: task.id, toMemberId: m.id, toName: m.user.name, reason: input.reason } });
}
