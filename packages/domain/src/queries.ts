/** Read models used by the REST API and MCP READ tools. All patient-scoped via PatientContext. */
import type { Task } from "@prisma/client";
import type { Db } from "./db";
import { type PatientContext, requirePermission, can, ctxAudit, requireMember } from "./context";
import { DomainError, notFound, forbidden } from "./errors";
import { planTransition, type TaskEventName, COVERED_STATES } from "./taskStateMachine";
import { localDateString, localTimeString, zonedTimeToUtc, addDaysToDateString } from "./time";
import { getInventory } from "./inventoryService";
import { permissionsFor, ROLE_LABELS, type RoleName } from "./authz";
import { EscalationStepsZ } from "./schemas";
import { createApproval } from "./approvals";

export async function listPatientsForUser(db: Db, userId: string) {
  const ms = await db.careCircleMember.findMany({ where: { userId, status: "ACTIVE" }, include: { patient: { select: { id: true, displayName: true, age: true, timezone: true } } } });
  return ms.map((m) => ({ id: m.patient.id, displayName: m.patient.displayName, age: m.patient.age, timezone: m.patient.timezone, role: m.role, memberId: m.id, permissions: [...permissionsFor({ role: m.role as RoleName, messageAccessGranted: m.messageAccessGranted, status: m.status })] }));
}

export async function getPatient(ctx: PatientContext) {
  requirePermission(ctx, "view_patient");
  const p = await ctx.db.patient.findUniqueOrThrow({ where: { id: ctx.patientId } });
  const restrictions = await ctx.db.extractedItem.findMany({ where: { patientId: ctx.patientId, status: "APPROVED", itemType: "RESTRICTION" } });
  return { ...p, restrictions: restrictions.map((r) => ({ id: r.id, text: String((r.payload as { text?: string }).text ?? ""), sourceType: r.sourceType, sourceId: r.sourceId, span: r.sourceSpan })) };
}

async function memberNames(db: Db, patientId: string) {
  const ms = await db.careCircleMember.findMany({ where: { patientId }, include: { user: { select: { name: true } } } });
  return (id: string | null | undefined) => (id ? ms.find((m) => m.id === id)?.user.name ?? "Unknown" : null);
}

export interface ActionInfo {
  event: TaskEventName | "RECORD_ADMINISTRATION" | "REPORT_STATUS";
  allowed: boolean;
  reason?: string;
  needsDeclaration?: boolean;
}

/** Which actions the current user may take on a task — UI hides/disables controls from this. */
export function allowedActions(ctx: PatientContext, task: Task): ActionInfo[] {
  const m = ctx.member;
  const actor = { type: ctx.actor.type, memberId: m?.id ?? null, permissions: ctx.permissions };
  const tk = { state: task.state, category: task.category, assigneeMemberId: task.assigneeMemberId, requiredQualification: task.requiredQualification };
  const probe = { id: "__probe__", qualifications: task.requiredQualification ? [task.requiredQualification] : [] };
  const self = m ? { id: m.id, qualifications: m.qualifications } : null;
  const out: ActionInfo[] = [];
  const check = (event: TaskEventName, input: Parameters<typeof planTransition>[3]) => {
    const r = planTransition(tk, event, actor, input);
    return r.ok ? { event, allowed: true } : { event, allowed: false, reason: r.message };
  };
  out.push(check("ACKNOWLEDGE", {}));
  out.push(check("CLAIM", { targetMember: self }));
  out.push(check("START", { declaration: "probe" }));
  const isAssignee = !!m && m.id === task.assigneeMemberId;
  const complete = check("COMPLETE", { declaration: "probe" });
  out.push({ ...complete, needsDeclaration: !isAssignee || !["ACKNOWLEDGED", "IN_PROGRESS", "OVERDUE", "ESCALATED"].includes(task.state) });
  out.push(check("DECLINE", { reason: "probe" }));
  out.push(check("ASSIGN", { targetMember: probe }));
  out.push(check(task.assigneeMemberId ? "REASSIGN" : "ASSIGN", { targetMember: { ...probe, id: "__other__" } }));
  out.push(check("CANCEL", { reason: "probe" }));
  out.push(check("RESOLVE_CONFLICT", { reason: "probe", resolveTo: "COMPLETED" }));
  if (task.nonRepeatable) {
    const ok = can(ctx, "record_care") && task.state !== "CANCELLED";
    out.push({ event: "RECORD_ADMINISTRATION", allowed: ok, reason: ok ? undefined : "Requires record_care on an active medication task", needsDeclaration: !isAssignee });
  }
  out.push({ event: "REPORT_STATUS", allowed: can(ctx, "record_care"), reason: can(ctx, "record_care") ? undefined : "Requires the record_care permission" });
  // de-duplicate (ASSIGN may appear twice)
  return out.filter((a, i) => out.findIndex((b) => b.event === a.event) === i);
}

export async function listTasks(ctx: PatientContext, f: { date?: string; state?: string; assigneeMemberId?: string; from?: Date; to?: Date } = {}) {
  requirePermission(ctx, "view_patient");
  const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: ctx.patientId } });
  const now = await ctx.clock.now();
  const date = f.date ?? localDateString(now, patient.timezone);
  const from = f.from ?? zonedTimeToUtc(date, "00:00", patient.timezone);
  const to = f.to ?? zonedTimeToUtc(addDaysToDateString(date, 1), "00:00", patient.timezone);
  const tasks = await ctx.db.task.findMany({
    where: { patientId: ctx.patientId, scheduledAt: { gte: from, lt: to }, ...(f.state ? { state: f.state as never } : {}), ...(f.assigneeMemberId ? { assigneeMemberId: f.assigneeMemberId } : {}) },
    orderBy: { scheduledAt: "asc" },
    include: { administrations: { select: { id: true, status: true } } },
  });
  const name = await memberNames(ctx.db, ctx.patientId);
  return {
    date,
    timezone: patient.timezone,
    now: now.toISOString(),
    tasks: tasks.map((t) => ({
      ...t,
      assigneeName: name(t.assigneeMemberId),
      completedByName: name(t.completedByMemberId),
      covered: COVERED_STATES.includes(t.state),
      localTime: localTimeString(t.scheduledAt, patient.timezone),
      actions: allowedActions(ctx, t),
    })),
  };
}

export async function getTaskDetail(ctx: PatientContext, taskId: string) {
  requirePermission(ctx, "view_patient");
  const t = await ctx.db.task.findFirst({ where: { id: taskId, patientId: ctx.patientId }, include: { events: { orderBy: { createdAt: "asc" } }, administrations: { orderBy: { createdAt: "asc" } }, carePlanItem: true } });
  if (!t) throw notFound("Task not found");
  const name = await memberNames(ctx.db, ctx.patientId);
  const [conflicts, alerts, reports] = await Promise.all([
    ctx.db.conflict.findMany({ where: { patientId: ctx.patientId, subjectRefs: { path: ["taskId"], equals: t.id } }, orderBy: { createdAt: "desc" } }),
    ctx.db.alert.findMany({ where: { patientId: ctx.patientId, affectedTaskId: t.id }, orderBy: { detectedAt: "desc" } }),
    ctx.db.extractedItem.findMany({ where: { patientId: ctx.patientId, linkedTaskId: t.id, status: { not: "REJECTED" } } }),
  ]);
  let source: { documentId: string; title: string; span: unknown; extractedItemId: string } | null = null;
  if (t.carePlanItem?.sourceExtractedItemId && can(ctx, "view_documents")) {
    const x = await ctx.db.extractedItem.findUnique({ where: { id: t.carePlanItem.sourceExtractedItemId } });
    const doc = x?.sourceType === "DOCUMENT" ? await ctx.db.sourceDocument.findUnique({ where: { id: x.sourceId }, select: { id: true, title: true, versionNumber: true } }) : null;
    if (x && doc) source = { documentId: doc.id, title: `${doc.title} (v${doc.versionNumber})`, span: x.sourceSpan, extractedItemId: x.id };
  }
  const msgIds = reports.filter((r) => r.sourceType === "MESSAGE").map((r) => r.sourceId);
  const msgs = can(ctx, "view_messages") ? await ctx.db.sourceMessage.findMany({ where: { id: { in: msgIds } } }) : [];
  return {
    task: { ...t, assigneeName: name(t.assigneeMemberId), backupName: name(t.backupMemberId), completedByName: name(t.completedByMemberId) },
    events: t.events.map((e) => ({ ...e, actorName: String((e.payload as Record<string, unknown>)?.actorName ?? e.actorType) })),
    administrations: t.administrations.map((a) => ({ ...a, recordedByName: name(a.recordedByMemberId) })),
    conflicts,
    alerts,
    messageReports: reports.map((r) => {
      const m = msgs.find((mm) => mm.id === r.sourceId);
      return { ...r, message: m ? { id: m.id, text: m.text, sentAt: m.sentAt, senderName: m.senderName } : null };
    }),
    source,
    actions: allowedActions(ctx, t),
  };
}

export async function getCareStatus(ctx: PatientContext) {
  requirePermission(ctx, "view_patient");
  const { tasks, date, now } = await listTasks(ctx);
  const byState: Record<string, number> = {};
  for (const t of tasks) byState[t.state] = (byState[t.state] ?? 0) + 1;
  const active = tasks.filter((t) => !["COMPLETED", "CANCELLED"].includes(t.state));
  const uncovered = active.filter((t) => !t.covered);
  const alerts = await ctx.db.alert.findMany({ where: { patientId: ctx.patientId, state: { not: "RESOLVED" } }, select: { id: true, level: true, title: true, ruleId: true } });
  const conflicts = await ctx.db.conflict.count({ where: { patientId: ctx.patientId, state: "OPEN" } });
  const inventory = await getInventory(ctx);
  const nowD = new Date(now);
  return {
    date,
    now,
    tasksToday: tasks.length,
    byState,
    uncovered: uncovered.length,
    overdue: tasks.filter((t) => t.state === "OVERDUE" || (t.state === "ESCALATED" && t.windowEnd < nowD)).length,
    completed: byState.COMPLETED ?? 0,
    openConflicts: conflicts,
    openAlerts: alerts.length,
    alertsByLevel: alerts.reduce<Record<string, number>>((acc, a) => ((acc[a.level] = (acc[a.level] ?? 0) + 1), acc), {}),
    topAlerts: alerts.slice(0, 5),
    lowStock: inventory.filter((i) => i.low).map((i) => ({ name: i.name, label: i.projection.label })),
    uncoveredTasks: uncovered.map((t) => ({ id: t.id, title: t.title, time: t.localTime, state: t.state, assigneeName: t.assigneeName })),
    nextTasks: active.filter((t) => new Date(t.windowEnd) >= nowD).slice(0, 6).map((t) => ({ id: t.id, title: t.title, time: t.localTime, state: t.state, assigneeName: t.assigneeName, covered: t.covered })),
  };
}

/** Ranked candidates for a task: qualification, availability (busy/free only), current load. */
export async function findAvailableCaregivers(ctx: PatientContext, taskId: string) {
  requirePermission(ctx, "view_patient");
  const t = await ctx.db.task.findFirst({ where: { id: taskId, patientId: ctx.patientId } });
  if (!t) throw notFound("Task not found");
  const members = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId, status: "ACTIVE" }, include: { user: { select: { name: true } }, availability: { where: { end: { gte: new Date(t.windowStart.getTime() - 12 * 3_600_000) }, start: { lte: t.windowEnd } } } } });
  const load = await ctx.db.task.groupBy({ by: ["assigneeMemberId"], where: { patientId: ctx.patientId, state: { notIn: ["COMPLETED", "CANCELLED"] }, scheduledAt: { gte: new Date(t.windowStart.getTime() - 3 * 3_600_000), lte: new Date(t.windowEnd.getTime() + 3 * 3_600_000) } }, _count: true });
  const out = members
    .filter((m) => permissionsFor({ role: m.role as RoleName }).has("record_care"))
    .map((m) => {
      const reasons: string[] = [];
      let score = 0;
      let eligible = true;
      if (t.requiredQualification) {
        if (m.qualifications.includes(t.requiredQualification)) {
          reasons.push(`Has ${t.requiredQualification}`);
          score += 3;
        } else {
          reasons.push(`Lacks ${t.requiredQualification}`);
          eligible = false;
        }
      }
      const busy = m.availability.find((a) => (a.type === "UNAVAILABLE" || a.type === "CALENDAR_BUSY") && a.start < t.windowEnd && a.end > t.windowStart);
      if (busy) {
        reasons.push(`Busy during the window (${busy.type === "UNAVAILABLE" ? "declared unavailable" : "calendar"})`);
        eligible = false;
      }
      const onShift = m.availability.some((a) => a.type === "WORKING_HOURS" && a.start <= t.windowStart && a.end >= t.windowEnd);
      if (onShift) {
        reasons.push("On shift for the whole window");
        score += 2;
      } else if (!busy) reasons.push("Free (no shift declared)");
      const n = load.find((l) => l.assigneeMemberId === m.id)?._count ?? 0;
      reasons.push(`${n} other open task(s) within ±3 h`);
      score -= n * 0.5;
      if (m.id === t.assigneeMemberId) {
        reasons.push("Current assignee");
        eligible = false;
      }
      return { memberId: m.id, name: m.user.name, role: ROLE_LABELS[m.role as RoleName], qualifications: m.qualifications, eligible, score: eligible ? score : score - 100, reasons };
    })
    .sort((a, b) => b.score - a.score);
  return { taskId: t.id, taskTitle: t.title, requiredQualification: t.requiredQualification, candidates: out };
}

export async function getMemberAvailability(ctx: PatientContext, from: Date, to: Date) {
  requirePermission(ctx, "view_patient");
  const members = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId, status: "ACTIVE" }, include: { user: { select: { name: true } }, availability: { where: { end: { gte: from }, start: { lte: to } }, orderBy: { start: "asc" } } } });
  // Busy/free only: calendar notes are never exposed here.
  return members.map((m) => ({ memberId: m.id, name: m.user.name, role: m.role, blocks: m.availability.map((a) => ({ type: a.type === "WORKING_HOURS" ? "ON_SHIFT" : "BUSY", start: a.start.toISOString(), end: a.end.toISOString(), source: a.source })) }));
}

export async function listMembers(ctx: PatientContext) {
  requirePermission(ctx, "view_patient");
  const now = await ctx.clock.now();
  const ms = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId, status: { not: "REMOVED" } }, include: { user: { select: { name: true, email: true, phone: true } }, availability: { where: { end: { gte: new Date(now.getTime() - 12 * 3_600_000) } }, orderBy: { start: "asc" }, take: 20 } }, orderBy: { createdAt: "asc" } });
  return ms.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: can(ctx, "manage_members") ? m.user.email : null,
    role: m.role,
    roleLabel: ROLE_LABELS[m.role as RoleName],
    relationship: m.relationship,
    qualifications: m.qualifications,
    status: m.status,
    messageAccessGranted: m.messageAccessGranted,
    version: m.version,
    permissions: [...permissionsFor({ role: m.role as RoleName, messageAccessGranted: m.messageAccessGranted, status: m.status })],
    availability: m.availability.map((a) => ({ id: a.id, type: a.type, start: a.start, end: a.end, source: a.source, note: m.id === ctx.member?.id || can(ctx, "manage_tasks") ? a.note : "" })),
  }));
}

export async function addAvailability(ctx: PatientContext, input: { memberId: string; type: "UNAVAILABLE" | "WORKING_HOURS"; start: Date; end: Date; note: string }) {
  const me = requireMember(ctx);
  if (input.memberId !== me.id && !can(ctx, "manage_tasks")) throw forbidden("You can only declare your own availability.");
  if (input.end <= input.start) throw new DomainError("VALIDATION_ERROR", "End must be after start.");
  const m = await ctx.db.careCircleMember.findFirst({ where: { id: input.memberId, patientId: ctx.patientId } });
  if (!m) throw notFound("Member not found");
  const a = await ctx.db.availability.create({ data: { memberId: m.id, type: input.type, start: input.start, end: input.end, note: input.note, source: "MANUAL" } });
  await ctxAudit(ctx, { action: "availability.add", targetRef: `availability:${a.id}`, details: { memberId: m.id, type: input.type } });
  return a;
}

export async function deleteAvailability(ctx: PatientContext, availabilityId: string) {
  const me = requireMember(ctx);
  const a = await ctx.db.availability.findFirst({ where: { id: availabilityId, member: { patientId: ctx.patientId } } });
  if (!a) throw notFound("Availability not found");
  if (a.memberId !== me.id && !can(ctx, "manage_tasks")) throw forbidden("You can only change your own availability.");
  await ctx.db.availability.delete({ where: { id: a.id } });
  await ctxAudit(ctx, { action: "availability.delete", targetRef: `availability:${a.id}` });
  return { ok: true };
}

export async function requestMemberChange(ctx: PatientContext, kind: "ADD_MEMBER" | "CHANGE_MEMBER_ROLE" | "REMOVE_MEMBER" | "GRANT_MESSAGE_ACCESS", payload: Record<string, unknown>) {
  requirePermission(ctx, "manage_members");
  let title = "";
  if (kind === "ADD_MEMBER") title = `Add ${String(payload.name)} as ${ROLE_LABELS[payload.role as RoleName] ?? payload.role}`;
  else {
    const m = await ctx.db.careCircleMember.findFirst({ where: { id: String(payload.memberId), patientId: ctx.patientId }, include: { user: { select: { name: true } } } });
    if (!m) throw notFound("Member not found");
    title = kind === "CHANGE_MEMBER_ROLE" ? `Change ${m.user.name}'s role to ${ROLE_LABELS[payload.role as RoleName] ?? payload.role}` : kind === "REMOVE_MEMBER" ? `Remove ${m.user.name} from the care circle` : `Let ${m.user.name} read raw messages`;
  }
  return createApproval(ctx, { actionType: kind, title, payload: payload as object });
}

export async function listEscalationPolicies(ctx: PatientContext) {
  requirePermission(ctx, "view_patient");
  return ctx.db.escalationPolicy.findMany({ where: { patientId: ctx.patientId }, orderBy: { createdAt: "asc" } });
}

export async function updateEscalationPolicy(ctx: PatientContext, id: string, steps: unknown, version?: number) {
  requirePermission(ctx, "manage_tasks");
  const parsed = EscalationStepsZ.safeParse(steps);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Invalid escalation steps", parsed.error.issues);
  const p = await ctx.db.escalationPolicy.findFirst({ where: { id, patientId: ctx.patientId } });
  if (!p) throw notFound("Policy not found");
  const upd = await ctx.db.escalationPolicy.updateMany({ where: { id, version: version ?? p.version }, data: { steps: parsed.data, version: { increment: 1 } } });
  if (upd.count === 0) throw new DomainError("STALE_VERSION", "Someone else just updated this policy. Refresh to see the latest version.");
  await ctxAudit(ctx, { action: "escalation_policy.update", targetRef: `policy:${id}` });
  return ctx.db.escalationPolicy.findUniqueOrThrow({ where: { id } });
}

export async function listNotifications(ctx: PatientContext) {
  const me = requireMember(ctx);
  return ctx.db.notification.findMany({ where: { patientId: ctx.patientId, memberId: me.id }, orderBy: { createdAt: "desc" }, take: 50 });
}

export async function markNotificationRead(ctx: PatientContext, id: string) {
  const me = requireMember(ctx);
  const n = await ctx.db.notification.findFirst({ where: { id, memberId: me.id, patientId: ctx.patientId } });
  if (!n) throw notFound("Notification not found");
  const now = await ctx.clock.now();
  return ctx.db.notification.update({ where: { id: n.id }, data: { readAt: n.readAt ?? now } });
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: "task" | "alert" | "conflict" | "document" | "message" | "approval" | "handover" | "observation" | "inventory" | "ai" | "mcp" | "member";
  title: string;
  detail: string;
  actorName: string;
  origin: "USER" | "SYSTEM" | "AGENT";
  via: string | null;
  link: string | null;
}

export async function getTimeline(ctx: PatientContext, opts: { kind?: string; limit?: number } = {}) {
  requirePermission(ctx, "view_patient");
  const limit = opts.limit ?? 150;
  const [events, audits, observations, messages] = await Promise.all([
    ctx.db.taskEvent.findMany({ where: { task: { patientId: ctx.patientId } }, include: { task: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: limit }),
    ctx.db.auditLog.findMany({ where: { patientId: ctx.patientId, NOT: { action: { startsWith: "task." } } }, orderBy: { at: "desc" }, take: limit }),
    ctx.db.observation.findMany({ where: { patientId: ctx.patientId }, orderBy: { recordedAt: "desc" }, take: 50 }),
    can(ctx, "view_messages") ? ctx.db.sourceMessage.findMany({ where: { patientId: ctx.patientId }, orderBy: { sentAt: "desc" }, take: 50 }) : Promise.resolve([]),
  ]);
  const name = await memberNames(ctx.db, ctx.patientId);
  const kindOf = (action: string): TimelineEntry["kind"] => {
    const head = action.split(".")[0];
    const map: Record<string, TimelineEntry["kind"]> = { alert: "alert", conflict: "conflict", document: "document", message: "message", approval: "approval", instructions: "approval", handover: "handover", inventory: "inventory", replenishment: "inventory", administration: "task", ai: "ai", extracted: "ai", mcp: "mcp", availability: "member", escalation_policy: "member" };
    return map[head] ?? "task";
  };
  const entries: TimelineEntry[] = [
    ...events.map<TimelineEntry>((e) => ({
      id: `ev:${e.id}`,
      at: e.createdAt.toISOString(),
      kind: "task",
      title: `${e.task.title}: ${e.type.replace(/_/g, " ").toLowerCase()}${e.toState && e.fromState !== e.toState ? ` → ${e.toState.replace(/_/g, " ").toLowerCase()}` : ""}`,
      detail: [(e.payload as Record<string, unknown>)?.reason, (e.payload as Record<string, unknown>)?.declaration, (e.payload as Record<string, unknown>)?.note].filter(Boolean).map(String).join(" · "),
      actorName: String((e.payload as Record<string, unknown>)?.actorName ?? e.actorType),
      origin: e.actorType,
      via: null,
      link: `/tasks/${e.taskId}`,
    })),
    ...audits.map<TimelineEntry>((a) => ({
      id: `audit:${a.id}`,
      at: a.at.toISOString(),
      kind: kindOf(a.action),
      title: a.action.replace(/[._]/g, " "),
      detail: a.action === "mcp.tool_call" ? `${String((a.details as Record<string, unknown>).tool)} → ${String((a.details as Record<string, unknown>).outcome)}` : (a.details as Record<string, unknown>)?.title ? String((a.details as Record<string, unknown>).title) : a.targetRef,
      actorName: a.actorName,
      origin: a.actorType,
      via: ((a.details as Record<string, unknown>)?.via as string) ?? null,
      link: a.targetRef.startsWith("alert:") ? `/alerts?id=${a.targetRef.slice(6)}` : a.targetRef.startsWith("document:") ? `/documents/${a.targetRef.slice(9)}` : a.targetRef.startsWith("approval:") ? `/approvals` : a.targetRef.startsWith("handover:") ? `/handover?id=${a.targetRef.slice(9)}` : null,
    })),
    ...observations.map<TimelineEntry>((o) => ({ id: `obs:${o.id}`, at: o.recordedAt.toISOString(), kind: "observation", title: `Observation (${o.category})`, detail: o.text, actorName: name(o.memberId) ?? "Unknown", origin: "USER", via: null, link: null })),
    ...messages.map<TimelineEntry>((m) => ({ id: `msg:${m.id}`, at: m.sentAt.toISOString(), kind: "message", title: `Message (${m.channel.replace(/_/g, " ").toLowerCase()})`, detail: m.text, actorName: m.senderName, origin: "USER", via: "SIMULATED", link: `/messages?id=${m.id}` })),
  ];
  return entries
    .filter((e) => !opts.kind || e.kind === opts.kind)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export async function getMcpActivity(ctx: PatientContext, since?: Date) {
  requirePermission(ctx, "view_patient");
  const rows = await ctx.db.auditLog.findMany({ where: { action: "mcp.tool_call", OR: [{ patientId: ctx.patientId }, { patientId: null, actorId: ctx.actor.userId }], ...(since ? { at: { gt: since } } : {}) }, orderBy: { at: "desc" }, take: 100 });
  return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), actorName: r.actorName, actorType: r.actorType, ...(r.details as Record<string, unknown>) }));
}

export async function getSourceReference(ctx: PatientContext, input: { sourceType: "DOCUMENT" | "MESSAGE"; sourceId: string; start?: number; end?: number }) {
  if (input.sourceType === "DOCUMENT") {
    requirePermission(ctx, "view_documents");
    const d = await ctx.db.sourceDocument.findFirst({ where: { id: input.sourceId, patientId: ctx.patientId } });
    if (!d) throw notFound("Document not found");
    const uploader = await ctx.db.user.findUnique({ where: { id: d.uploadedBy }, select: { name: true } });
    const s = input.start ?? 0;
    const e = input.end ?? Math.min(d.rawText.length, 400);
    return { sourceType: "DOCUMENT" as const, sourceId: d.id, title: `${d.title} (v${d.versionNumber})`, excerpt: d.rawText.slice(s, e), span: { start: s, end: e }, recordedBy: uploader?.name ?? null, at: d.createdAt.toISOString() };
  }
  requirePermission(ctx, "view_messages");
  const m = await ctx.db.sourceMessage.findFirst({ where: { id: input.sourceId, patientId: ctx.patientId } });
  if (!m) throw notFound("Message not found");
  const s = input.start ?? 0;
  const e = input.end ?? m.text.length;
  return { sourceType: "MESSAGE" as const, sourceId: m.id, title: `Message from ${m.senderName} (${m.channel.replace(/_/g, " ").toLowerCase()})`, excerpt: m.text.slice(s, e) || m.text, span: { start: s, end: e }, recordedBy: m.senderName, at: m.sentAt.toISOString() };
}

export async function recordObservation(ctx: PatientContext, input: { text: string; category?: string }) {
  requirePermission(ctx, "record_care");
  const me = requireMember(ctx);
  const now = await ctx.clock.now();
  const o = await ctx.db.observation.create({ data: { patientId: ctx.patientId, memberId: me.id, text: input.text, category: input.category ?? "general", recordedAt: now } });
  await ctxAudit(ctx, { action: "observation.record", targetRef: `observation:${o.id}` });
  return o;
}
