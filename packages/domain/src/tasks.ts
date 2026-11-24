import { randomUUID } from "node:crypto";
import type { Prisma, Task, TaskState } from "@prisma/client";
import { getDb, type Db } from "./db";
import { type PatientContext, ctxAudit, requirePermission, requireMember, type Actor } from "./context";
import { DomainError, notFound, staleVersion } from "./errors";
import { planTransition, type TaskEventName, type TaskStateName, type TransitionActor } from "./taskStateMachine";
import { permissionsFor, type RoleName } from "./authz";
import { addDaysToDateString, localDateString, zonedTimeToUtc } from "./time";
import { RecurrenceZ } from "./schemas";
import type { Clock } from "./clock";

export interface TransitionRequest {
  event: TaskEventName;
  version?: number;
  targetMemberId?: string | null;
  reason?: string | null;
  declaration?: string | null;
  note?: string | null;
  resolveTo?: TaskStateName;
  idempotencyKey: string;
}

/** Run fn inside a transaction unless already inside one. */
async function inTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if ("$transaction" in db) return (db as ReturnType<typeof getDb>).$transaction((tx) => fn(tx), { timeout: 20_000 });
  return fn(db);
}

async function loadMember(db: Db, patientId: string, memberId: string) {
  const m = await db.careCircleMember.findFirst({ where: { id: memberId, patientId, status: "ACTIVE" }, include: { user: { select: { name: true } } } });
  if (!m) throw new DomainError("VALIDATION_ERROR", "That person is not an active member of this care circle.");
  return m;
}

/**
 * Apply one state-machine event to a task. Shared by REST, MCP and the scheduler.
 * Optimistic locking: UPDATE … WHERE id AND version; zero rows → STALE_VERSION.
 */
export async function applyTaskEvent(
  db: Db,
  now: Date,
  actor: Actor,
  actorMember: { id: string; role: string; messageAccessGranted: boolean; status: string } | null,
  task: Task,
  req: TransitionRequest,
): Promise<Task> {
  if (req.version !== undefined && req.version !== task.version) throw staleVersion();

  let target: { id: string; qualifications: string[]; role: string; user: { name: string } } | null = null;
  if (req.event === "CLAIM") {
    if (!actorMember) throw new DomainError("FORBIDDEN", "Only care-circle members can claim tasks.");
    target = await loadMember(db, task.patientId, actorMember.id);
  } else if (req.targetMemberId) {
    target = await loadMember(db, task.patientId, req.targetMemberId);
    if (!permissionsFor({ role: target.role as RoleName }).has("record_care")) {
      throw new DomainError("GUARD_FAILED", `${target.user.name} can't be given care tasks with their current role.`);
    }
  }

  const tActor: TransitionActor = {
    type: actor.type,
    memberId: actorMember?.id ?? null,
    permissions: actorMember ? permissionsFor({ role: actorMember.role as RoleName, messageAccessGranted: actorMember.messageAccessGranted, status: actorMember.status }) : [],
  };
  const plan = planTransition(
    { state: task.state, category: task.category, assigneeMemberId: task.assigneeMemberId, requiredQualification: task.requiredQualification },
    req.event,
    tActor,
    { targetMember: target ? { id: target.id, qualifications: target.qualifications } : null, reason: req.reason, declaration: req.declaration, resolveTo: req.resolveTo },
  );
  if (!plan.ok) throw new DomainError(plan.code === "FORBIDDEN" ? "FORBIDDEN" : plan.code, plan.message);
  const to = plan.transition.to as TaskState;

  const data: Prisma.TaskUncheckedUpdateManyInput = { state: to, version: { increment: 1 } };
  switch (req.event) {
    case "ASSIGN":
    case "REASSIGN":
      data.assigneeMemberId = target!.id;
      data.acknowledgedAt = null;
      break;
    case "CLAIM":
      data.assigneeMemberId = target!.id;
      data.acknowledgedAt = now;
      break;
    case "ACKNOWLEDGE":
      data.acknowledgedAt = now;
      break;
    case "DECLINE":
      data.assigneeMemberId = null;
      data.acknowledgedAt = null;
      break;
    case "COMPLETE":
      data.completedAt = now;
      data.completedByMemberId = actorMember?.id ?? null;
      data.completionEvidence = { declaration: req.declaration ?? null, note: req.note ?? null, byAssignee: actorMember?.id === task.assigneeMemberId };
      break;
    case "FLAG_CONFLICT":
    case "ESCALATE":
      data.previousState = task.state;
      break;
    case "RESOLVE_CONFLICT":
      data.previousState = null;
      if (to === "COMPLETED" && !task.completedAt) data.completedAt = now;
      if (to === "UNASSIGNED") data.assigneeMemberId = null;
      break;
  }

  const res = await db.task.updateMany({ where: { id: task.id, version: task.version }, data });
  if (res.count === 0) throw staleVersion();

  await db.taskEvent.create({
    data: {
      taskId: task.id,
      type: req.event,
      fromState: task.state,
      toState: to,
      actorUserId: actor.userId,
      actorType: actor.type,
      payload: { reason: req.reason ?? null, declaration: req.declaration ?? null, note: req.note ?? null, targetMemberId: target?.id ?? null, targetName: target?.user.name ?? null, actorName: actor.name },
      idempotencyKey: `${req.idempotencyKey}:${req.event}`,
      createdAt: now,
    },
  });
  await db.auditLog.create({
    data: { actorType: actor.type, actorId: actor.userId, actorName: actor.name, action: `task.${req.event.toLowerCase()}`, patientId: task.patientId, targetRef: `task:${task.id}`, details: { from: task.state, to, via: actor.via ?? null, reason: req.reason ?? null }, at: now },
  });

  let updated = (await db.task.findUnique({ where: { id: task.id } }))!;

  // Assignment is not acceptance: notify, then wait for the assignee.
  if ((req.event === "ASSIGN" || req.event === "REASSIGN") && target) {
    await db.notification.upsert({
      where: { dedupeKey: `task:${task.id}:assign:${updated.version}` },
      create: { patientId: task.patientId, memberId: target.id, taskId: task.id, title: `Please accept: ${task.title}`, body: `${actor.name} asked you to take this task. It is not covered until you accept.`, channel: "IN_APP", dedupeKey: `task:${task.id}:assign:${updated.version}`, deliveredAt: now },
      update: {},
    });
    const sysActor: Actor = { type: "SYSTEM", userId: null, name: "CareRelay system", via: actor.via };
    updated = await applyTaskEvent(db, now, sysActor, null, updated, {
      event: req.event === "ASSIGN" ? "NOTIFY" : "REQUEST_ACCEPTANCE",
      idempotencyKey: `${req.idempotencyKey}:followup`,
    });
  }
  return updated;
}

export async function getTaskForPatient(db: Db, patientId: string, taskId: string) {
  const t = await db.task.findFirst({ where: { id: taskId, patientId } });
  if (!t) throw notFound("Task not found");
  return t;
}

/** User/agent-initiated transition (REST + MCP). */
export async function transitionTask(ctx: PatientContext, taskId: string, req: TransitionRequest) {
  const now = await ctx.clock.now();
  return inTx(ctx.db, async (tx) => {
    const prior = await tx.taskEvent.findUnique({ where: { idempotencyKey: `${req.idempotencyKey}:${req.event}` } });
    if (prior) return (await tx.task.findUnique({ where: { id: prior.taskId } }))!;
    const task = await getTaskForPatient(tx, ctx.patientId, taskId);
    return applyTaskEvent(tx, now, ctx.actor, ctx.member, task, req);
  });
}

/** System transition used by the sweep. Returns null if not allowed from the current state. */
export async function systemTransition(db: Db, now: Date, task: Task, event: TaskEventName, idempotencyKey: string, reason?: string) {
  const exists = await db.taskEvent.findUnique({ where: { idempotencyKey: `${idempotencyKey}:${event}` } });
  if (exists) return null;
  const sys: Actor = { type: "SYSTEM", userId: null, name: "CareRelay system", via: "SCHEDULER" };
  try {
    return await applyTaskEvent(db, now, sys, null, task, { event, idempotencyKey, reason });
  } catch (e) {
    if (e instanceof DomainError && (e.code === "INVALID_TRANSITION" || e.code === "STALE_VERSION")) return null;
    throw e;
  }
}

// ---------------------------------------------------------------- creation

export async function createOneOffTask(
  ctx: PatientContext,
  input: { title: string; description?: string; category: Task["category"]; priority: Task["priority"]; scheduledAt: Date; windowMinutesBefore: number; windowMinutesAfter: number; requiredQualification?: string | null },
  idempotencyKey: string,
) {
  requirePermission(ctx, "manage_tasks");
  const now = await ctx.clock.now();
  return inTx(ctx.db, async (tx) => {
    const task = await tx.task.create({
      data: {
        patientId: ctx.patientId,
        title: input.title,
        description: input.description ?? "",
        category: input.category,
        priority: input.priority,
        scheduledAt: input.scheduledAt,
        windowStart: new Date(input.scheduledAt.getTime() - input.windowMinutesBefore * 60_000),
        windowEnd: new Date(input.scheduledAt.getTime() + input.windowMinutesAfter * 60_000),
        state: "UNASSIGNED",
        requiredQualification: input.requiredQualification ?? null,
        nonRepeatable: input.category === "MEDICATION",
      },
    });
    await tx.taskEvent.create({ data: { taskId: task.id, type: "CREATED", toState: "UNASSIGNED", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, payload: { actorName: ctx.actor.name }, idempotencyKey: `${idempotencyKey}:CREATED`, createdAt: now } });
    await ctxAudit(ctx, { action: "task.create", targetRef: `task:${task.id}`, details: { title: task.title } }, tx);
    return task;
  });
}

/**
 * Generate task occurrences for active care-plan items, for `days` local days starting today.
 * Idempotent: unique (carePlanItemId, scheduledAt) + skipDuplicates.
 */
export async function generateOccurrences(db: Db, clock: Clock, patientId: string, days = 2) {
  const now = await clock.now();
  const patient = await db.patient.findUnique({ where: { id: patientId }, select: { timezone: true } });
  if (!patient) return 0;
  const tz = patient.timezone;
  const items = await db.carePlanItem.findMany({ where: { patientId, active: true } });
  const today = localDateString(now, tz);
  const rows: Prisma.TaskCreateManyInput[] = [];
  for (const item of items) {
    const rec = RecurrenceZ.safeParse(item.recurrence);
    if (!rec.success) continue;
    for (let d = 0; d < days; d++) {
      const date = addDaysToDateString(today, d);
      if (rec.data.startDate && date < rec.data.startDate) continue;
      if (rec.data.endDate && date > rec.data.endDate) continue;
      for (const time of rec.data.times) {
        const scheduledAt = zonedTimeToUtc(date, time, tz);
        const windowEnd = new Date(scheduledAt.getTime() + item.windowMinutesAfter * 60_000);
        if (windowEnd <= item.approvedAt) continue; // never create occurrences that ended before approval
        rows.push({
          patientId,
          carePlanItemId: item.id,
          title: item.title,
          description: item.instructions,
          category: item.category,
          scheduledAt,
          windowStart: new Date(scheduledAt.getTime() - item.windowMinutesBefore * 60_000),
          windowEnd,
          priority: item.priority,
          state: "UNASSIGNED",
          requiredQualification: item.requiredQualification,
          nonRepeatable: item.nonRepeatable,
          medicationId: item.medicationId,
        });
      }
    }
  }
  if (rows.length === 0) return 0;
  const before = await db.task.count({ where: { patientId } });
  await db.task.createMany({ data: rows, skipDuplicates: true });
  // Every task gets a CREATED event; tasks without events are the ones just inserted.
  const created = await db.task.findMany({ where: { patientId, events: { none: {} } }, select: { id: true } });
  for (const t of created) {
    await db.taskEvent.create({ data: { taskId: t.id, type: "CREATED", toState: "UNASSIGNED", actorType: "SYSTEM", payload: { actorName: "CareRelay system", reason: "Generated from approved care plan" }, idempotencyKey: `gen:${t.id}`, createdAt: now } }).catch(() => undefined);
  }
  return (await db.task.count({ where: { patientId } })) - before;
}

// ---------------------------------------------------------------- administrations (DUP-001)

export async function recordAdministration(
  ctx: PatientContext,
  taskId: string,
  input: { administeredAt?: Date; note?: string; confirmDuplicate?: boolean; version?: number },
  idempotencyKey: string,
) {
  requirePermission(ctx, "record_care");
  const member = requireMember(ctx);
  const now = await ctx.clock.now();
  return inTx(ctx.db, async (tx) => {
    const task = await getTaskForPatient(tx, ctx.patientId, taskId);
    if (!task.nonRepeatable) throw new DomainError("VALIDATION_ERROR", "Administration records are only for medication tasks.");
    const replay = await tx.taskEvent.findUnique({ where: { idempotencyKey: `${idempotencyKey}:ADMIN` } });
    if (replay) return { status: "replayed" as const, task };

    const existing = await tx.administrationRecord.findFirst({ where: { taskId, status: "RECORDED" } });
    const at = input.administeredAt ?? now;
    if (existing) {
      const by = await tx.careCircleMember.findUnique({ where: { id: existing.recordedByMemberId }, include: { user: { select: { name: true } } } });
      const existingView = { id: existing.id, recordedBy: by?.user.name ?? "Unknown", recordedByMemberId: existing.recordedByMemberId, administeredAt: existing.administeredAt.toISOString(), note: existing.note };
      if (!input.confirmDuplicate) {
        throw new DomainError(
          "DUPLICATE_ADMINISTRATION",
          `${existingView.recordedBy} already recorded this occurrence. CareRelay can't advise whether another dose should be given — check with an authorised person before acting.`,
          { existing: existingView },
        );
      }
      // Second attempt: keep the original untouched, store this one as DISPUTED; DUP-001 raises the conflict.
      const disputed = await tx.administrationRecord.create({
        data: { taskId, medicationId: task.medicationId, recordedByMemberId: member.id, administeredAt: at, note: input.note ?? "", status: "DISPUTED" },
      });
      await tx.taskEvent.create({ data: { taskId, type: "ADMINISTRATION_DISPUTED", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, payload: { recordId: disputed.id, existingRecordId: existing.id, actorName: ctx.actor.name, note: input.note ?? "" }, idempotencyKey: `${idempotencyKey}:ADMIN`, createdAt: now } });
      await ctxAudit(ctx, { action: "administration.duplicate_attempt", targetRef: `task:${taskId}`, details: { disputedRecordId: disputed.id, existingRecordId: existing.id } }, tx);
      return { status: "flagged" as const, task, record: disputed, existing: existingView };
    }

    const isAssignee = task.assigneeMemberId === member.id;
    const declaration = isAssignee ? null : input.note?.trim() || null;
    const updated = await applyTaskEvent(tx, now, ctx.actor, member, task, { event: "COMPLETE", version: input.version, declaration, note: input.note ?? null, idempotencyKey });
    try {
      const record = await tx.administrationRecord.create({
        data: { taskId, medicationId: task.medicationId, recordedByMemberId: member.id, administeredAt: at, note: input.note ?? "", status: "RECORDED" },
      });
      await tx.taskEvent.create({ data: { taskId, type: "ADMINISTRATION_RECORDED", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, payload: { recordId: record.id, actorName: ctx.actor.name, administeredAt: at.toISOString() }, idempotencyKey: `${idempotencyKey}:ADMIN`, createdAt: now } });
      await ctxAudit(ctx, { action: "administration.record", targetRef: `task:${taskId}`, details: { recordId: record.id } }, tx);
      return { status: "recorded" as const, task: updated, record };
    } catch (e) {
      // Partial unique index (one RECORDED per task) is the last line of defence against races.
      if ((e as { code?: string }).code === "P2002") throw new DomainError("STALE_VERSION", "Someone else just recorded this. Refresh to see their record.");
      throw e;
    }
  });
}

/** A caregiver's statement that an occurrence is done / not done (feeds CON-001). No state change. */
export async function reportTaskStatus(ctx: PatientContext, taskId: string, input: { claim: "DONE" | "NOT_DONE"; note: string }, idempotencyKey: string) {
  requirePermission(ctx, "record_care");
  requireMember(ctx);
  const now = await ctx.clock.now();
  const task = await getTaskForPatient(ctx.db, ctx.patientId, taskId);
  const existing = await ctx.db.taskEvent.findUnique({ where: { idempotencyKey: `${idempotencyKey}:REPORT` } });
  if (existing) return existing;
  const ev = await ctx.db.taskEvent.create({
    data: { taskId: task.id, type: "STATUS_REPORT", actorType: ctx.actor.type, actorUserId: ctx.actor.userId, payload: { claim: input.claim, note: input.note, actorName: ctx.actor.name, memberId: ctx.member?.id ?? null }, idempotencyKey: `${idempotencyKey}:REPORT`, createdAt: now },
  });
  await ctxAudit(ctx, { action: "task.status_report", targetRef: `task:${taskId}`, details: { claim: input.claim } });
  return ev;
}

export const newKey = () => randomUUID();
