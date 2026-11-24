/**
 * Simulated messaging (WhatsApp/SMS inbox) + WhatsApp chat-export import.
 * Only messages explicitly authorised for processing are ever sent to extraction.
 */
import { randomUUID } from "node:crypto";
import { type PatientContext, ctxAudit, requirePermission, requireMember, can } from "./context";
import { DomainError, notFound, forbidden } from "./errors";
import { zonedTimeToUtc } from "./time";
import { applyTaskEvent } from "./tasks";
import { MEDICAL_ITEM_TYPES } from "./schemas";

export interface ParsedChatLine {
  sentAt: { date: string; time: string };
  sender: string;
  text: string;
}

/**
 * Parse a WhatsApp "Export chat" .txt. Supports the two common formats:
 *   12/03/2025, 09:15 - Priya: text            (Android, 24h)
 *   [12/03/25, 9:15:23 AM] Priya: text         (iOS, 12h)
 * Continuation lines are appended to the previous message. System lines (no "Name:") are skipped.
 */
export function parseWhatsAppExport(txt: string): ParsedChatLine[] {
  const out: ParsedChatLine[] = [];
  const re = /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?\]?\s*(?:-\s*)?([^:]{1,60}):\s([\s\S]*)$/;
  for (const raw of txt.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/[‎‏]/g, "");
    const m = re.exec(line);
    if (m) {
      const [, d, mo, y, h, mi, ap, sender, text] = m;
      let hour = Number(h);
      if (ap) {
        const pm = ap.toLowerCase() === "pm";
        if (pm && hour < 12) hour += 12;
        if (!pm && hour === 12) hour = 0;
      }
      const year = y.length === 2 ? `20${y}` : y;
      out.push({ sentAt: { date: `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`, time: `${String(hour).padStart(2, "0")}:${mi}` }, sender: sender.trim(), text: text.trim() });
    } else if (/^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/.test(line)) {
      continue; // date-stamped system line ("Messages are end-to-end encrypted", "X joined"…)
    } else if (out.length && line.trim()) {
      out[out.length - 1].text += `\n${line.trim()}`;
    }
  }
  return out.filter((l) => l.text && l.text !== "<Media omitted>");
}

export async function listMessages(ctx: PatientContext) {
  requirePermission(ctx, "view_messages");
  const [messages, items, members] = await Promise.all([
    ctx.db.sourceMessage.findMany({ where: { patientId: ctx.patientId }, orderBy: { sentAt: "desc" }, take: 200 }),
    ctx.db.extractedItem.findMany({ where: { patientId: ctx.patientId, sourceType: "MESSAGE" }, orderBy: { createdAt: "asc" } }),
    ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId }, include: { user: { select: { name: true } } } }),
  ]);
  return messages.map((m) => ({
    ...m,
    senderDisplay: members.find((mm) => mm.id === m.senderMemberId)?.user.name ?? m.senderName,
    interpretations: items.filter((x) => x.sourceId === m.id && x.status !== "REJECTED"),
  }));
}

export async function getMessage(ctx: PatientContext, messageId: string) {
  requirePermission(ctx, "view_messages");
  const m = await ctx.db.sourceMessage.findFirst({ where: { id: messageId, patientId: ctx.patientId } });
  if (!m) throw notFound("Message not found");
  return m;
}

export async function postMessage(ctx: PatientContext, input: { text: string; channel: "WHATSAPP_SIMULATED" | "SMS_SIMULATED" | "EMAIL_SIMULATED" | "IN_APP"; authorise: boolean }) {
  requirePermission(ctx, "record_care");
  const member = requireMember(ctx);
  const now = await ctx.clock.now();
  const msg = await ctx.db.sourceMessage.create({ data: { patientId: ctx.patientId, channel: input.channel, senderMemberId: member.id, senderName: member.user.name, sentAt: now, text: input.text, authorisedForProcessing: input.authorise } });
  await ctxAudit(ctx, { action: "message.post", targetRef: `message:${msg.id}`, details: { channel: input.channel, authorised: input.authorise } });
  return msg;
}

export async function importWhatsApp(ctx: PatientContext, input: { fileText: string; authorise: boolean }) {
  requirePermission(ctx, "record_care");
  const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: ctx.patientId } });
  const lines = parseWhatsAppExport(input.fileText);
  if (!lines.length) throw new DomainError("VALIDATION_ERROR", "No messages found. Expected a WhatsApp 'Export chat' .txt file.");
  const members = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId }, include: { user: { select: { name: true } } } });
  const batch = randomUUID();
  const rows = lines.map((l) => {
    const member = members.find((m) => m.user.name.toLowerCase().split(" ")[0] === l.sender.toLowerCase().split(" ")[0]);
    return { patientId: ctx.patientId, channel: "WHATSAPP_SIMULATED" as const, senderMemberId: member?.id ?? null, senderName: l.sender, sentAt: zonedTimeToUtc(l.sentAt.date, l.sentAt.time, patient.timezone), text: l.text, authorisedForProcessing: input.authorise, importBatch: batch };
  });
  await ctx.db.sourceMessage.createMany({ data: rows });
  await ctxAudit(ctx, { action: "message.import", targetRef: `import:${batch}`, details: { count: rows.length, authorised: input.authorise, unmatchedSenders: [...new Set(rows.filter((r) => !r.senderMemberId).map((r) => r.senderName))] } });
  return { imported: rows.length, batch, unmatchedSenders: [...new Set(rows.filter((r) => !r.senderMemberId).map((r) => r.senderName))] };
}

export async function authoriseMessage(ctx: PatientContext, messageId: string) {
  requirePermission(ctx, "record_care");
  const m = await getMessage(ctx, messageId);
  const updated = await ctx.db.sourceMessage.update({ where: { id: m.id }, data: { authorisedForProcessing: true } });
  await ctxAudit(ctx, { action: "message.authorise", targetRef: `message:${m.id}` });
  return updated;
}

/**
 * Confirm a non-medical interpretation of a message.
 * - COMMITMENT: only the person named can confirm; confirming claims/accepts the linked task.
 * - OBSERVATION: becomes an Observation.
 * - REPLENISHMENT_REQUEST / SCHEDULE_CHANGE / COMPLETION_REPORT / CONCERN: marked confirmed (evidence for rules).
 * Medical instructions (MEDICATION, CARE_ACTIVITY, RESTRICTION, APPOINTMENT) can't be confirmed here — they need verify_medical approval.
 */
export async function confirmExtractedItem(ctx: PatientContext, itemId: string, idempotencyKey: string) {
  const member = requireMember(ctx);
  const x = await ctx.db.extractedItem.findFirst({ where: { id: itemId, patientId: ctx.patientId } });
  if (!x) throw notFound("Item not found");
  if (!["PROPOSED", "AWAITING_VERIFICATION"].includes(x.status)) throw new DomainError("INVALID_TRANSITION", "This item was already decided.");
  if (MEDICAL_ITEM_TYPES.includes(x.itemType as never)) throw new DomainError("FORBIDDEN", "Medical instructions are activated only through a verifier's approval.");
  const now = await ctx.clock.now();
  const p = x.payload as Record<string, unknown>;
  let effect: Record<string, unknown> = {};
  if (x.itemType === "COMMITMENT") {
    if (p.committedMemberId !== member.id) throw forbidden("Only the person who is said to be doing this can confirm it.");
    if (p.linkedTaskId) {
      const task = await ctx.db.task.findFirst({ where: { id: String(p.linkedTaskId), patientId: ctx.patientId } });
      if (task && !task.assigneeMemberId && ["UNASSIGNED", "OVERDUE", "ESCALATED"].includes(task.state)) {
        const t = await applyTaskEvent(ctx.db, now, ctx.actor, member, task, { event: "CLAIM", idempotencyKey, note: `Confirmed from message` });
        effect = { taskId: t.id, state: t.state };
      } else if (task && task.assigneeMemberId === member.id && ["ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ESCALATED"].includes(task.state)) {
        const t = await applyTaskEvent(ctx.db, now, ctx.actor, member, task, { event: "ACKNOWLEDGE", idempotencyKey });
        effect = { taskId: t.id, state: t.state };
      } else if (task && task.assigneeMemberId && task.assigneeMemberId !== member.id && !["COMPLETED", "CANCELLED"].includes(task.state)) {
        throw new DomainError("GUARD_FAILED", "That task is owned by someone else. Ask a coordinator to reassign it to you.");
      }
    }
  } else if (x.itemType === "OBSERVATION") {
    requirePermission(ctx, "record_care");
    const o = await ctx.db.observation.create({ data: { patientId: ctx.patientId, memberId: member.id, text: String(p.text), category: String(p.category ?? "general"), recordedAt: now, sourceType: "MESSAGE", sourceId: x.sourceId } });
    effect = { observationId: o.id };
  } else {
    requirePermission(ctx, "record_care");
  }
  await ctx.db.extractedItem.update({ where: { id: x.id }, data: { status: "APPROVED", verifiedBy: ctx.actor.userId, verifiedAt: now } });
  await ctxAudit(ctx, { action: "extracted.confirm", targetRef: `extracted:${x.id}`, details: { itemType: x.itemType, effect: effect as object } });
  return { item: x.id, effect };
}

export async function rejectExtractedItem(ctx: PatientContext, itemId: string, reason: string) {
  const x = await ctx.db.extractedItem.findFirst({ where: { id: itemId, patientId: ctx.patientId } });
  if (!x) throw notFound("Item not found");
  if (MEDICAL_ITEM_TYPES.includes(x.itemType as never)) requirePermission(ctx, "verify_medical");
  else {
    const member = requireMember(ctx);
    const p = x.payload as Record<string, unknown>;
    const isNamed = p.committedMemberId === member.id;
    if (!isNamed && !can(ctx, "manage_tasks") && !can(ctx, "record_care")) throw forbidden();
  }
  if (!["PROPOSED", "AWAITING_VERIFICATION"].includes(x.status)) throw new DomainError("INVALID_TRANSITION", "This item was already decided.");
  if (!reason.trim()) throw new DomainError("GUARD_FAILED", "Give a reason.");
  const now = await ctx.clock.now();
  await ctx.db.extractedItem.update({ where: { id: x.id }, data: { status: "REJECTED", rejectionReason: reason, verifiedBy: ctx.actor.userId, verifiedAt: now } });
  await ctxAudit(ctx, { action: "extracted.reject", targetRef: `extracted:${x.id}`, details: { reason } });
  return { ok: true };
}
