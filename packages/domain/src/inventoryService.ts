import { type PatientContext, ctxAudit, requirePermission, requireMember } from "./context";
import { DomainError, notFound, staleVersion, forbidden } from "./errors";
import { projectInventory } from "./inventory";
import { DEFAULT_RULE_CONFIG } from "./rules/config";
import { RecurrenceZ } from "./schemas";
import { notify } from "./sweep";

export async function getInventory(ctx: PatientContext) {
  requirePermission(ctx, "view_patient");
  const now = await ctx.clock.now();
  const meds = await ctx.db.medication.findMany({ where: { patientId: ctx.patientId, active: true }, include: { carePlanItems: { where: { active: true } }, replenishments: { orderBy: { createdAt: "desc" } } }, orderBy: { name: "asc" } });
  const members = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId }, include: { user: { select: { name: true } } } });
  const name = (id: string | null) => (id ? members.find((m) => m.id === id)?.user.name ?? "Unknown" : null);
  return Promise.all(
    meds.map(async (m) => {
      const since = m.stockVerifiedAt ?? new Date(0);
      const [recorded, disputed] = await Promise.all([
        ctx.db.administrationRecord.count({ where: { medicationId: m.id, status: "RECORDED", administeredAt: { gt: since } } }),
        ctx.db.administrationRecord.count({ where: { medicationId: m.id, status: "DISPUTED", administeredAt: { gt: since } } }),
      ]);
      const scheduledPerDay = m.carePlanItems.reduce((n, c) => n + (RecurrenceZ.safeParse(c.recurrence).data?.times.length ?? 0), 0);
      const projection = projectInventory({ currentStock: m.currentStock, unitsPerAdministration: m.unitsPerAdministration, stockVerifiedAt: m.stockVerifiedAt, isEstimate: m.isEstimate, scheduledPerDay, recordedSinceVerification: recorded, disputedSinceVerification: disputed, now, freshDays: DEFAULT_RULE_CONFIG.stockFreshDays });
      return {
        id: m.id,
        name: m.name,
        form: m.form,
        unitsPerAdministration: m.unitsPerAdministration,
        currentStock: m.currentStock,
        stockVerifiedAt: m.stockVerifiedAt,
        stockVerifiedByName: m.stockVerifiedBy ? (await ctx.db.user.findUnique({ where: { id: m.stockVerifiedBy }, select: { name: true } }))?.name ?? null : null,
        reorderThresholdDays: m.reorderThresholdDays,
        version: m.version,
        scheduledPerDay,
        recordedSinceVerification: recorded,
        disputedSinceVerification: disputed,
        projection,
        low: projection.daysRemaining !== null && projection.daysRemaining < m.reorderThresholdDays,
        replenishments: m.replenishments.map((r) => ({ ...r, assigneeName: name(r.assigneeMemberId) })),
      };
    }),
  );
}

export async function verifyStock(ctx: PatientContext, medicationId: string, count: number, version?: number) {
  requirePermission(ctx, "record_care");
  const m = await ctx.db.medication.findFirst({ where: { id: medicationId, patientId: ctx.patientId } });
  if (!m) throw notFound("Medication not found");
  if (version !== undefined && version !== m.version) throw staleVersion();
  if (count < 0) throw new DomainError("VALIDATION_ERROR", "Count can't be negative.");
  const now = await ctx.clock.now();
  const upd = await ctx.db.medication.updateMany({ where: { id: m.id, version: m.version }, data: { currentStock: count, stockVerifiedAt: now, stockVerifiedBy: ctx.actor.userId, isEstimate: false, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  await ctxAudit(ctx, { action: "inventory.verify_stock", targetRef: `medication:${m.id}`, details: { previous: m.currentStock, counted: count } });
  return ctx.db.medication.findUniqueOrThrow({ where: { id: m.id } });
}

/** Create a replenishment request. Assigning to yourself counts as accepting; to someone else they must accept. */
export async function createReplenishment(ctx: PatientContext, medicationId: string, input: { assigneeMemberId?: string | null; dueBy: Date; note?: string }) {
  requirePermission(ctx, "record_care");
  const member = requireMember(ctx);
  const m = await ctx.db.medication.findFirst({ where: { id: medicationId, patientId: ctx.patientId } });
  if (!m) throw notFound("Medication not found");
  const now = await ctx.clock.now();
  const assignee = input.assigneeMemberId ?? member.id;
  if (assignee !== member.id) {
    requirePermission(ctx, "manage_tasks");
    const a = await ctx.db.careCircleMember.findFirst({ where: { id: assignee, patientId: ctx.patientId, status: "ACTIVE" } });
    if (!a) throw new DomainError("VALIDATION_ERROR", "Assignee is not an active member.");
  }
  const self = assignee === member.id;
  const r = await ctx.db.replenishmentRequest.create({ data: { medicationId: m.id, assigneeMemberId: assignee, state: self ? "ACKNOWLEDGED" : "AWAITING_ACKNOWLEDGEMENT", dueBy: input.dueBy, note: input.note ?? "", createdBy: ctx.actor.userId! } });
  if (!self) await notify(ctx.db, { patientId: ctx.patientId, memberId: assignee, title: `Please accept: refill ${m.name}`, body: `${ctx.actor.name} asked you to arrange a refill.`, channel: "IN_APP", dedupeKey: `repl:${r.id}:assign`, now });
  await ctxAudit(ctx, { action: "replenishment.create", targetRef: `replenishment:${r.id}`, details: { medication: m.name, assignee, self } });
  return r;
}

export async function transitionReplenishment(ctx: PatientContext, id: string, input: { event: "ACKNOWLEDGE" | "COMPLETE" | "CANCEL"; version?: number; confirmedQuantity?: number }) {
  const member = requireMember(ctx);
  const r = await ctx.db.replenishmentRequest.findFirst({ where: { id, medication: { patientId: ctx.patientId } }, include: { medication: true } });
  if (!r) throw notFound("Replenishment not found");
  if (input.version !== undefined && input.version !== r.version) throw staleVersion();
  const now = await ctx.clock.now();
  const allowed: Record<string, string[]> = { ACKNOWLEDGE: ["AWAITING_ACKNOWLEDGEMENT"], COMPLETE: ["ACKNOWLEDGED"], CANCEL: ["UNASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED"] };
  if (!allowed[input.event].includes(r.state)) throw new DomainError("INVALID_TRANSITION", `Can't ${input.event.toLowerCase()} a request that is ${r.state.toLowerCase().replace(/_/g, " ")}.`);
  if ((input.event === "ACKNOWLEDGE" || input.event === "COMPLETE") && r.assigneeMemberId !== member.id) throw forbidden("Only the person who owns this refill can do this.");
  if (input.event === "CANCEL" && r.assigneeMemberId !== member.id) requirePermission(ctx, "manage_tasks");
  const to = input.event === "ACKNOWLEDGE" ? "ACKNOWLEDGED" : input.event === "COMPLETE" ? "COMPLETED" : "CANCELLED";
  if (input.event === "COMPLETE" && (input.confirmedQuantity === undefined || input.confirmedQuantity <= 0)) throw new DomainError("GUARD_FAILED", "Enter the quantity actually received.");
  const upd = await ctx.db.replenishmentRequest.updateMany({ where: { id: r.id, version: r.version }, data: { state: to, confirmedQuantity: input.confirmedQuantity ?? null, version: { increment: 1 } } });
  if (upd.count === 0) throw staleVersion();
  if (input.event === "COMPLETE") {
    // Stock becomes (last count − recorded use) + received. Marked as an estimate until someone counts.
    const since = r.medication.stockVerifiedAt ?? new Date(0);
    const used = await ctx.db.administrationRecord.count({ where: { medicationId: r.medicationId, status: "RECORDED", administeredAt: { gt: since } } });
    const remaining = Math.max(0, r.medication.currentStock - used * r.medication.unitsPerAdministration);
    await ctx.db.medication.update({ where: { id: r.medicationId }, data: { currentStock: remaining + input.confirmedQuantity!, stockVerifiedAt: now, stockVerifiedBy: ctx.actor.userId, isEstimate: true, version: { increment: 1 } } });
  }
  await ctxAudit(ctx, { action: `replenishment.${input.event.toLowerCase()}`, targetRef: `replenishment:${r.id}`, details: { confirmedQuantity: input.confirmedQuantity ?? null } });
  return ctx.db.replenishmentRequest.findUniqueOrThrow({ where: { id: r.id } });
}
