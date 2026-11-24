import type { Conflict } from "@prisma/client";
import { getDb } from "./db";
import { type PatientContext, ctxAudit, requirePermission } from "./context";
import { DomainError, notFound, staleVersion } from "./errors";
import { applyTaskEvent } from "./tasks";
import type { TaskStateName } from "./taskStateMachine";
import { createApproval } from "./approvals";

export async function listConflicts(ctx: PatientContext, state?: "OPEN" | "RESOLVED") {
  return ctx.db.conflict.findMany({ where: { patientId: ctx.patientId, ...(state ? { state } : {}) }, orderBy: [{ state: "asc" }, { createdAt: "desc" }], take: 100 });
}

export async function getConflictByIdOrKey(ctx: PatientContext, idOrKey: string) {
  const c = await ctx.db.conflict.findFirst({
    where: { patientId: ctx.patientId, OR: [{ dedupeKey: idOrKey }, ...(/^[0-9a-f-]{36}$/i.test(idOrKey) ? [{ id: idOrKey }] : [])] },
    orderBy: { createdAt: "desc" },
  });
  if (!c) throw notFound("Conflict not found");
  return c;
}

/**
 * Human resolution of a conflict. Clinically significant conflicts are never resolved directly:
 * they become a RESOLVE_CLINICAL_CONFLICT ApprovalRequest for someone with verify_medical.
 */
export async function resolveConflict(ctx: PatientContext, idOrKey: string, input: { resolution: string; resolveTo?: TaskStateName; version?: number }) {
  requirePermission(ctx, "resolve_conflicts");
  if (!input.resolution.trim()) throw new DomainError("GUARD_FAILED", "Describe what was verified.");
  const c = await getConflictByIdOrKey(ctx, idOrKey);
  if (c.state !== "OPEN") throw new DomainError("INVALID_TRANSITION", "This conflict is already resolved.");
  if (input.version !== undefined && input.version !== c.version) throw staleVersion();
  if (c.kind === "INSTRUCTION_VERSION") {
    throw new DomainError("INVALID_TRANSITION", "Instruction version conflicts are resolved by approving or rejecting the new version (Approvals).");
  }
  if (c.clinicallySignificant) {
    const existing = await ctx.db.approvalRequest.findFirst({ where: { patientId: ctx.patientId, actionType: "RESOLVE_CLINICAL_CONFLICT", state: "PENDING", payload: { path: ["conflictId"], equals: c.id } } });
    if (existing) return { status: "approval_pending" as const, approval: existing };
    const approval = await createApproval(ctx, {
      actionType: "RESOLVE_CLINICAL_CONFLICT",
      title: `Confirm resolution: ${c.title}`,
      payload: { conflictId: c.id, resolution: input.resolution, resolveTo: input.resolveTo ?? null },
    });
    return { status: "approval_requested" as const, approval };
  }
  const now = await ctx.clock.now();
  const db = ctx.db;
  const run = async (tx: typeof db) => executeConflictResolution({ ...ctx, db: tx }, c, input.resolution, input.resolveTo, now, `resolve:${c.id}`);
  if ("$transaction" in db) await (db as ReturnType<typeof getDb>).$transaction((tx) => run(tx));
  else await run(db);
  return { status: "resolved" as const };
}

export async function executeConflictResolution(ctx: PatientContext, c: Conflict, resolution: string, resolveTo: string | undefined, now: Date, idemKey: string) {
  const upd = await ctx.db.conflict.updateMany({ where: { id: c.id, version: c.version, state: "OPEN" }, data: { state: "RESOLVED", resolution, resolvedBy: ctx.actor.userId, resolvedAt: now, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  const taskId = (c.subjectRefs as { taskId?: string }).taskId;
  if (taskId) {
    const task = await ctx.db.task.findFirst({ where: { id: taskId, patientId: ctx.patientId } });
    if (task?.state === "CONFLICTING") {
      const target = (resolveTo as TaskStateName | undefined) ?? (task.previousState === "COMPLETED" || task.completedAt ? "COMPLETED" : "ACKNOWLEDGED");
      await applyTaskEvent(ctx.db, now, ctx.actor, ctx.member, task, { event: "RESOLVE_CONFLICT", resolveTo: target, reason: resolution, idempotencyKey: idemKey });
    } else if (task && c.kind === "APPOINTMENT_STATUS" && resolveTo === "CANCELLED") {
      await applyTaskEvent(ctx.db, now, ctx.actor, ctx.member, task, { event: "CANCEL", reason: resolution, idempotencyKey: idemKey });
    }
  }
  if (c.kind === "APPOINTMENT_STATUS") {
    const xId = (c.subjectRefs as { extractedItemId?: string }).extractedItemId;
    if (xId) await ctx.db.extractedItem.update({ where: { id: xId }, data: { status: resolveTo === "CANCELLED" ? "APPROVED" : "REJECTED", verifiedBy: ctx.actor.userId, verifiedAt: now, rejectionReason: resolveTo === "CANCELLED" ? null : resolution } });
  }
  await ctxAudit(ctx, { action: "conflict.resolve", targetRef: `conflict:${c.id}`, details: { kind: c.kind, resolution, resolveTo: resolveTo ?? null } });
}
