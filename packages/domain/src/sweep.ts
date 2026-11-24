/**
 * The care sweep: generate occurrences → load snapshot → run rules → persist alerts/conflicts
 * (deduplicated) → auto-resolve cleared alerts → escalate. Idempotent; serialised per patient
 * with a Postgres advisory lock.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import type { Db } from "./db";
import type { Clock } from "./clock";
import { generateOccurrences, systemTransition } from "./tasks";
import { permissionsFor, type RoleName } from "./authz";
import { runRules, RULE_IDS } from "./rules/rules";
import { DEFAULT_RULE_CONFIG, type RuleConfig } from "./rules/config";
import type { Finding, RuleInput, RExtracted } from "./rules/types";
import { computeDocumentDiff } from "./documentDiff";
import { RecurrenceZ, EscalationStepsZ } from "./schemas";
import { localTimeString } from "./time";

const DAY = 86_400_000;

export async function loadRuleInput(db: Db, patientId: string, now: Date, config: RuleConfig = DEFAULT_RULE_CONFIG): Promise<RuleInput> {
  const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
  const members = await db.careCircleMember.findMany({ where: { patientId, status: "ACTIVE" }, include: { user: { select: { name: true } } } });
  const tasks = await db.task.findMany({
    where: { patientId, windowEnd: { gte: new Date(now.getTime() - 2 * DAY) }, windowStart: { lte: new Date(now.getTime() + 2 * DAY) } },
    include: { events: { orderBy: { createdAt: "asc" } }, administrations: true },
  });
  const availability = await db.availability.findMany({
    where: { member: { patientId }, end: { gte: new Date(now.getTime() - DAY) }, start: { lte: new Date(now.getTime() + 2 * DAY) } },
  });
  const handovers = await db.handover.findMany({ where: { patientId, shiftEnd: { gte: new Date(now.getTime() - 2 * DAY) } } });
  const meds = await db.medication.findMany({ where: { patientId, active: true }, include: { carePlanItems: { where: { active: true } }, replenishments: true } });
  const medications = await Promise.all(
    meds.map(async (m) => {
      const since = m.stockVerifiedAt ?? new Date(0);
      const [recorded, disputed] = await Promise.all([
        db.administrationRecord.count({ where: { medicationId: m.id, status: "RECORDED", administeredAt: { gt: since } } }),
        db.administrationRecord.count({ where: { medicationId: m.id, status: "DISPUTED", administeredAt: { gt: since } } }),
      ]);
      const scheduledPerDay = m.carePlanItems.reduce((n, ci) => {
        const r = RecurrenceZ.safeParse(ci.recurrence);
        return n + (r.success ? r.data.times.length : 0);
      }, 0);
      return { id: m.id, name: m.name, form: m.form, unitsPerAdministration: m.unitsPerAdministration, currentStock: m.currentStock, stockVerifiedAt: m.stockVerifiedAt, isEstimate: m.isEstimate, reorderThresholdDays: m.reorderThresholdDays, scheduledPerDay, recordedSinceVerification: recorded, disputedSinceVerification: disputed };
    }),
  );
  const replenishments = meds.flatMap((m) => m.replenishments.map((r) => ({ id: r.id, medicationId: r.medicationId, state: r.state, assigneeMemberId: r.assigneeMemberId })));

  const xs = await db.extractedItem.findMany({
    where: { patientId, itemType: { in: ["COMMITMENT", "COMPLETION_REPORT", "SCHEDULE_CHANGE"] }, status: { not: "REJECTED" }, createdAt: { gte: new Date(now.getTime() - 3 * DAY) } },
  });
  const msgIds = xs.filter((x) => x.sourceType === "MESSAGE").map((x) => x.sourceId);
  const msgs = await db.sourceMessage.findMany({ where: { id: { in: msgIds } } });
  const extracted: RExtracted[] = xs.map((x) => {
    const msg = msgs.find((m) => m.id === x.sourceId);
    const span = (x.sourceSpan as { start: number; end: number }) ?? { start: 0, end: 0 };
    const sender = members.find((mm) => mm.id === msg?.senderMemberId);
    return {
      id: x.id,
      itemType: x.itemType,
      payload: x.payload as Record<string, unknown>,
      confidence: x.confidence,
      status: x.status,
      sourceType: x.sourceType,
      sourceId: x.sourceId,
      span,
      excerpt: msg ? msg.text.slice(span.start, span.end) || msg.text : "",
      createdAt: x.createdAt,
      sourceAt: msg?.sentAt ?? x.createdAt,
      senderMemberId: msg?.senderMemberId ?? null,
      senderName: sender?.user.name ?? msg?.senderName ?? "",
      detectedBy: x.detectedBy,
    };
  });

  const approvals = await db.approvalRequest.findMany({ where: { patientId, state: "PENDING", actionType: "ACTIVATE_INSTRUCTIONS" } });
  const pendingVersions = [];
  for (const a of approvals) {
    const documentId = (a.payload as { documentId?: string }).documentId;
    if (!documentId) continue;
    const doc = await db.sourceDocument.findFirst({ where: { id: documentId, patientId } });
    if (!doc || !doc.supersedesId) continue; // CON-002 applies to new versions only
    const uploader = members.find((m) => m.userId === doc.uploadedBy);
    pendingVersions.push({ approvalId: a.id, documentId, documentTitle: doc.title, versionNumber: doc.versionNumber, uploadedByName: uploader?.user.name ?? "Unknown", createdAt: doc.createdAt, diff: await computeDocumentDiff(db, patientId, documentId) });
  }

  return {
    now,
    tz: patient.timezone,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      category: t.category,
      priority: t.priority,
      state: t.state,
      scheduledAt: t.scheduledAt,
      windowStart: t.windowStart,
      windowEnd: t.windowEnd,
      assigneeMemberId: t.assigneeMemberId,
      requiredQualification: t.requiredQualification,
      nonRepeatable: t.nonRepeatable,
      medicationId: t.medicationId,
      completedAt: t.completedAt,
      completedByMemberId: t.completedByMemberId,
      events: t.events.map((e) => ({ id: e.id, type: e.type, fromState: e.fromState, toState: e.toState, createdAt: e.createdAt, actorName: String((e.payload as Record<string, unknown>)?.actorName ?? e.actorType), payload: (e.payload as Record<string, unknown>) ?? {} })),
      administrations: t.administrations.map((a) => ({ id: a.id, status: a.status, recordedByMemberId: a.recordedByMemberId, administeredAt: a.administeredAt, note: a.note })),
    })),
    members: members.map((m) => {
      const p = permissionsFor({ role: m.role as RoleName, messageAccessGranted: m.messageAccessGranted, status: m.status });
      return { id: m.id, name: m.user.name, role: m.role, qualifications: m.qualifications, canManage: p.has("manage_tasks"), canCare: p.has("record_care"), canVerify: p.has("verify_medical") };
    }),
    availability: availability.map((a) => ({ id: a.id, memberId: a.memberId, type: a.type, start: a.start, end: a.end, note: a.note, source: a.source })),
    handovers: handovers.map((h) => ({ id: h.id, fromMemberId: h.fromMemberId, toMemberId: h.toMemberId, shiftStart: h.shiftStart, shiftEnd: h.shiftEnd, state: h.state, sentAt: h.sentAt })),
    medications,
    replenishments,
    extracted,
    pendingVersions,
    aiProvider: "",
    config,
  };
}

export interface SweepSummary {
  at: string;
  tasksGenerated: number;
  created: { id: string; ruleId: string; title: string; level: string }[];
  updated: number;
  resolved: { id: string; ruleId: string; title: string }[];
  escalated: { id: string; step: number }[];
  taskTransitions: { taskId: string; event: string }[];
}

const LEVEL_RANK = { INFORMATIONAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 } as const;
const ESCALATE_TASK_RULES = new Set(["GAP-001", "GAP-002", "GAP-003", "GAP-004"]);

export async function runSweep(db: PrismaClient, clock: Clock, patientId: string): Promise<SweepSummary> {
  const tasksGenerated = await generateOccurrences(db, clock, patientId);
  const now = await clock.now();
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${patientId}))::text`;
      const summary: SweepSummary = { at: now.toISOString(), tasksGenerated, created: [], updated: 0, resolved: [], escalated: [], taskTransitions: [] };
      const input = await loadRuleInput(tx, patientId, now);
      let findings = runRules(input);

      // A human-resolved conflict stays resolved unless new evidence arrives after the resolution.
      const conflictKeys = findings.filter((f) => f.conflict).map((f) => f.conflict!.dedupeKey);
      const resolvedConflicts = conflictKeys.length ? await tx.conflict.findMany({ where: { patientId, state: "RESOLVED", dedupeKey: { in: conflictKeys } } }) : [];
      findings = findings.filter((f) => {
        if (!f.conflict) return true;
        return !resolvedConflicts.some((c) => c.dedupeKey === f.conflict!.dedupeKey && c.resolvedAt && c.resolvedAt >= f.conflict!.latestEvidenceAt);
      });

      // 1) task state actions (system transitions through the state machine)
      for (const f of findings) {
        if (!f.taskAction) continue;
        const task = await tx.task.findUnique({ where: { id: f.taskAction.taskId } });
        if (!task) continue;
        const r = await systemTransition(tx, now, task, f.taskAction.event, `sweep:${f.ruleId}:${task.id}:v${task.version}`, `${f.ruleId}: ${f.title}`);
        if (r) summary.taskTransitions.push({ taskId: task.id, event: f.taskAction.event });
      }

      // 2) conflicts + alerts (dedupe by key)
      const policy = await tx.escalationPolicy.findFirst({ where: { patientId, isDefault: true } });
      const seen = new Set<string>();
      for (const f of findings) {
        seen.add(f.dedupeKey);
        let conflictId: string | undefined;
        if (f.conflict) conflictId = await upsertConflict(tx, patientId, f, summary);
        const existing = await tx.alert.findFirst({ where: { patientId, dedupeKey: f.dedupeKey, state: { not: "RESOLVED" } } });
        const data = {
          level: f.level,
          title: f.title,
          explanation: f.explanation,
          basis: f.basis as Prisma.InputJsonValue,
          evidence: f.evidence as unknown as Prisma.InputJsonValue,
          resolutionOptions: f.resolutionOptions as unknown as Prisma.InputJsonValue,
          responders: f.responders,
          affectedTaskId: f.affectedTaskId ?? null,
          conflictId: conflictId ?? null,
        };
        if (existing) {
          const changed = existing.level !== f.level || existing.title !== f.title || existing.explanation !== f.explanation || JSON.stringify(existing.evidence) !== JSON.stringify(f.evidence) || existing.conflictId !== (conflictId ?? null);
          if (changed) {
            await tx.alert.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
            summary.updated++;
          }
          continue;
        }
        const alert = await tx.alert.create({
          data: { ...data, patientId, ruleId: f.ruleId, dedupeKey: f.dedupeKey, detectedAt: now, escalationPolicyId: f.escalate && LEVEL_RANK[f.level] >= LEVEL_RANK.MEDIUM ? policy?.id ?? null : null },
        });
        summary.created.push({ id: alert.id, ruleId: f.ruleId, title: f.title, level: f.level });
        await tx.auditLog.create({ data: { actorType: "SYSTEM", actorName: "Care sweep", action: "alert.create", patientId, targetRef: `alert:${alert.id}`, details: { ruleId: f.ruleId, level: f.level, dedupeKey: f.dedupeKey }, at: now } });
        for (const memberId of f.responders) {
          await notify(tx, { patientId, memberId, alertId: alert.id, taskId: f.affectedTaskId, title: f.title, body: f.explanation, channel: "IN_APP", dedupeKey: `alert:${alert.id}:step0:${memberId}`, now });
        }
      }

      // 3) auto-resolve alerts whose condition has cleared
      const open = await tx.alert.findMany({ where: { patientId, state: { not: "RESOLVED" }, ruleId: { in: RULE_IDS } } });
      for (const a of open) {
        if (seen.has(a.dedupeKey)) continue;
        await tx.alert.update({ where: { id: a.id }, data: { state: "RESOLVED", resolvedAt: now, resolution: `Condition cleared — ${a.ruleId} no longer applies (re-checked at ${localTimeString(now, input.tz)}).`, version: { increment: 1 } } });
        await tx.auditLog.create({ data: { actorType: "SYSTEM", actorName: "Care sweep", action: "alert.auto_resolve", patientId, targetRef: `alert:${a.id}`, details: { ruleId: a.ruleId }, at: now } });
        summary.resolved.push({ id: a.id, ruleId: a.ruleId, title: a.title });
      }

      // 4) escalation (acknowledged alerts stop escalating: someone is on it)
      if (policy) {
        const steps = EscalationStepsZ.safeParse(policy.steps);
        if (steps.success) {
          const members = await tx.careCircleMember.findMany({ where: { patientId, status: "ACTIVE" } });
          const live = await tx.alert.findMany({ where: { patientId, escalationPolicyId: policy.id, state: { in: ["OPEN", "ESCALATED"] } } });
          for (const a of live) {
            const elapsed = (now.getTime() - a.detectedAt.getTime()) / 60_000;
            let target = 0;
            steps.data.forEach((s, idx) => {
              if (s.afterMinutes <= elapsed) target = idx;
            });
            let step = a.escalationStep;
            while (step < target) {
              step++;
              const s = steps.data[step];
              const recipients = new Set([...s.memberIds, ...members.filter((m) => s.notifyRoles.includes(m.role)).map((m) => m.id)]);
              const voice = s.channel === "VOICE_ELEVENLABS" && !!process.env.ELEVENLABS_API_KEY;
              for (const memberId of recipients) {
                await notify(tx, { patientId, memberId, alertId: a.id, taskId: a.affectedTaskId ?? undefined, title: `Escalated: ${a.title}`, body: `${a.explanation}${s.channel === "VOICE_ELEVENLABS" && !voice ? " (Voice channel configured but ElevenLabs is not set up — delivered in-app.)" : ""}`, channel: voice ? "VOICE_ELEVENLABS" : s.channel === "SMS_SIMULATED" ? "SMS_SIMULATED" : "IN_APP", dedupeKey: `alert:${a.id}:step${step}:${memberId}`, now });
              }
              await tx.alert.update({ where: { id: a.id }, data: { escalationStep: step, state: "ESCALATED", lastEscalatedAt: now, version: { increment: 1 } } });
              await tx.auditLog.create({ data: { actorType: "SYSTEM", actorName: "Care sweep", action: "alert.escalate", patientId, targetRef: `alert:${a.id}`, details: { step, channel: s.channel, recipients: [...recipients] }, at: now } });
              summary.escalated.push({ id: a.id, step });
              if (step === 1 && a.affectedTaskId && ESCALATE_TASK_RULES.has(a.ruleId)) {
                const task = await tx.task.findUnique({ where: { id: a.affectedTaskId } });
                if (task) {
                  const r = await systemTransition(tx, now, task, "ESCALATE", `escalate:${a.id}:v${task.version}`, `Escalation policy step 1 for ${a.ruleId}`);
                  if (r) summary.taskTransitions.push({ taskId: task.id, event: "ESCALATE" });
                }
              }
            }
          }
        }
      }
      return summary;
    },
    { timeout: 60_000, maxWait: 20_000 },
  );
}

async function upsertConflict(tx: Db, patientId: string, f: Finding, summary: SweepSummary) {
  const c = f.conflict!;
  const existing = await tx.conflict.findFirst({ where: { patientId, dedupeKey: c.dedupeKey, state: "OPEN" } });
  if (existing) {
    if (JSON.stringify(existing.evidence) !== JSON.stringify(c.evidence)) {
      await tx.conflict.update({ where: { id: existing.id }, data: { evidence: c.evidence as unknown as Prisma.InputJsonValue, version: { increment: 1 } } });
    }
    return existing.id;
  }
  const created = await tx.conflict.create({
    data: { patientId, kind: c.kind, title: c.title, dedupeKey: c.dedupeKey, clinicallySignificant: c.clinicallySignificant, subjectRefs: c.subjectRefs as Prisma.InputJsonValue, evidence: c.evidence as unknown as Prisma.InputJsonValue, detectedBy: f.basis.kind === "AI" ? "AI_SEMANTIC" : `RULE:${f.ruleId}` },
  });
  await tx.auditLog.create({ data: { actorType: "SYSTEM", actorName: "Care sweep", action: "conflict.create", patientId, targetRef: `conflict:${created.id}`, details: { kind: c.kind, ruleId: f.ruleId }, at: new Date(summary.at) } });
  return created.id;
}

export async function notify(
  db: Db,
  n: { patientId: string; memberId: string; alertId?: string; taskId?: string; title: string; body: string; channel: "IN_APP" | "VOICE_ELEVENLABS" | "SMS_SIMULATED"; dedupeKey: string; now: Date },
) {
  await db.notification.upsert({
    where: { dedupeKey: n.dedupeKey },
    create: { patientId: n.patientId, memberId: n.memberId, alertId: n.alertId ?? null, taskId: n.taskId ?? null, title: n.title, body: n.body, channel: n.channel, dedupeKey: n.dedupeKey, deliveredAt: n.now },
    update: {},
  });
}

export async function runSweepAll(db: PrismaClient, clock: Clock) {
  const patients = await db.patient.findMany({ select: { id: true } });
  const out: Record<string, SweepSummary> = {};
  for (const p of patients) out[p.id] = await runSweep(db, clock, p.id);
  return out;
}
