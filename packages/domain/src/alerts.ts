import { type PatientContext, ctxAudit, requireMember } from "./context";
import { DomainError, notFound, staleVersion, forbidden } from "./errors";
import { notify } from "./sweep";
import { getTaskForPatient } from "./tasks";
import { can } from "./context";

const LEVEL_ORDER = ["URGENT", "HIGH", "MEDIUM", "LOW", "INFORMATIONAL"];

export async function listAlerts(ctx: PatientContext, opts: { state?: "open" | "resolved" | "all" } = {}) {
  const where =
    opts.state === "resolved" ? { state: "RESOLVED" as const } : opts.state === "all" ? {} : { state: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] as ("OPEN" | "ACKNOWLEDGED" | "ESCALATED")[] } };
  const rows = await ctx.db.alert.findMany({ where: { patientId: ctx.patientId, ...where }, orderBy: { detectedAt: "desc" }, take: 200 });
  return rows.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || b.detectedAt.getTime() - a.detectedAt.getTime()).map((a) => redactAlert(ctx, a));
}

/** Remote viewers get the explanation but not message excerpts (communications privacy). */
function redactAlert<T extends { evidence: unknown }>(ctx: PatientContext, a: T): T {
  if (can(ctx, "view_messages") && can(ctx, "view_documents")) return a;
  const ev = (a.evidence as { parentSourceType?: string; sourceType: string; excerpt: string }[]).map((e) => {
    const isMsg = e.parentSourceType === "MESSAGE" || e.sourceType === "MESSAGE";
    const isDoc = e.parentSourceType === "DOCUMENT" || e.sourceType === "DOCUMENT";
    if ((isMsg && !can(ctx, "view_messages")) || (isDoc && !can(ctx, "view_documents"))) return { ...e, excerpt: "[Source hidden — your role can't view this source]", span: undefined };
    return e;
  });
  return { ...a, evidence: ev };
}

export async function getAlert(ctx: PatientContext, alertId: string) {
  const a = await ctx.db.alert.findFirst({ where: { id: alertId, patientId: ctx.patientId } });
  if (!a) throw notFound("Alert not found");
  const [task, conflict, members] = await Promise.all([
    a.affectedTaskId ? ctx.db.task.findUnique({ where: { id: a.affectedTaskId } }) : null,
    a.conflictId ? ctx.db.conflict.findUnique({ where: { id: a.conflictId } }) : null,
    ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId }, include: { user: { select: { name: true } } } }),
  ]);
  const responders = a.responders.map((id) => {
    const m = members.find((mm) => mm.id === id);
    return { memberId: id, name: m?.user.name ?? "Unknown", role: m?.role ?? null };
  });
  return { ...redactAlert(ctx, a), task, conflict, responderDetails: responders };
}

/** A responder acknowledges they are looking at the alert (stops further escalation). */
export async function acknowledgeAlert(ctx: PatientContext, alertId: string, version?: number) {
  const member = requireMember(ctx);
  const a = await ctx.db.alert.findFirst({ where: { id: alertId, patientId: ctx.patientId } });
  if (!a) throw notFound("Alert not found");
  if (!a.responders.includes(member.id) && !can(ctx, "manage_tasks")) throw forbidden("Only the listed responders or a coordinator can acknowledge this alert.");
  if (a.state === "RESOLVED") throw new DomainError("INVALID_TRANSITION", "This alert is already resolved.");
  if (version !== undefined && version !== a.version) throw staleVersion();
  const now = await ctx.clock.now();
  const upd = await ctx.db.alert.updateMany({ where: { id: a.id, version: a.version }, data: { state: "ACKNOWLEDGED", acknowledgedBy: member.id, acknowledgedAt: now, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  await ctxAudit(ctx, { action: "alert.acknowledge", targetRef: `alert:${a.id}`, details: { ruleId: a.ruleId } });
  return ctx.db.alert.findUniqueOrThrow({ where: { id: a.id } });
}

/** "Request acceptance again": re-notify the assignee of an unaccepted task. */
export async function nudgeAssignee(ctx: PatientContext, taskId: string) {
  const member = requireMember(ctx);
  const task = await getTaskForPatient(ctx.db, ctx.patientId, taskId);
  if (!task.assigneeMemberId) throw new DomainError("GUARD_FAILED", "This task has no assignee to remind.");
  if (task.assigneeMemberId !== member.id && !can(ctx, "manage_tasks")) throw forbidden("Only a coordinator can request acceptance.");
  const now = await ctx.clock.now();
  await notify(ctx.db, { patientId: ctx.patientId, memberId: task.assigneeMemberId, taskId: task.id, title: `Still waiting for you to accept: ${task.title}`, body: `${ctx.actor.name} asked you to confirm you'll do this. It isn't covered until you accept.`, channel: "IN_APP", dedupeKey: `nudge:${task.id}:${now.getTime()}`, now });
  await ctxAudit(ctx, { action: "task.nudge", targetRef: `task:${task.id}` });
  return { ok: true };
}
