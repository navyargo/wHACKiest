/**
 * Storing AI extraction results. The LLM runs in packages/agents; this module only
 * validates, scores and stores proposals. Nothing here activates an instruction.
 */
import type { Prisma } from "@prisma/client";
import type { Db } from "./db";
import { type PatientContext, ctxAudit } from "./context";
import { PAYLOAD_SCHEMAS, MEDICAL_ITEM_TYPES, type ExtractionCandidate, type ExtractedItemTypeName } from "./schemas";
import { DEFAULT_RULE_CONFIG } from "./rules/config";
import { localDateString, addDaysToDateString } from "./time";
import { SENSITIVE_ACTIONS } from "./authz";

const ACTIVE_TASK_STATES = ["UNASSIGNED", "ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED", "IN_PROGRESS", "REASSIGNED", "ESCALATED", "OVERDUE", "COMPLETED", "CONFLICTING"] as const;

function hourRange(tod: string): [number, number] | null {
  switch (tod) {
    case "morning":
      return [5, 12];
    case "afternoon":
      return [12, 17];
    case "evening":
      return [17, 21];
    case "night":
      return [21, 29];
    default:
      return null;
  }
}

/** Deterministic matching of a free-text report/commitment to a task occurrence. */
export async function matchTask(db: Db, patientId: string, tz: string, opts: { category: string | null; timeOfDay: string; date: string | null; at: Date }) {
  const date = opts.date ?? localDateString(opts.at, tz);
  const dayStart = new Date(`${addDaysToDateString(date, -1)}T00:00:00Z`);
  const dayEnd = new Date(`${addDaysToDateString(date, 2)}T00:00:00Z`);
  const tasks = await db.task.findMany({
    where: { patientId, scheduledAt: { gte: dayStart, lt: dayEnd }, state: { in: [...ACTIVE_TASK_STATES] }, ...(opts.category ? { category: opts.category as never } : {}) },
    orderBy: { scheduledAt: "asc" },
  });
  const sameDay = tasks.filter((t) => localDateString(t.scheduledAt, tz) === date);
  const range = hourRange(opts.timeOfDay);
  const hourOf = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(d));
  const inRange = range ? sameDay.filter((t) => {
    const h = hourOf(t.scheduledAt);
    return (h >= range[0] && h < range[1]) || (range[1] > 24 && h < range[1] - 24);
  }) : [];
  if (inRange.length) return inRange[0];
  // otherwise: the latest occurrence whose window started before the message
  const before = sameDay.filter((t) => t.windowStart <= opts.at);
  return before.length ? before[before.length - 1] : (sameDay[0] ?? null);
}

const CATEGORY_HINTS: [RegExp, string][] = [
  [/medicine|tablet|pill|dose|medication/i, "MEDICATION"],
  [/hospital|appointment|doctor|clinic|follow.?up|check.?up/i, "APPOINTMENT"],
  [/dressing|wound|bandage/i, "WOUND_CARE"],
  [/physio|exercise|walk/i, "PHYSIO"],
];
export const categoryFromText = (s: string) => CATEGORY_HINTS.find(([re]) => re.test(s))?.[1] ?? null;

/** Find the quoted text in the source (exact, then case/whitespace-insensitive). Unfound → empty span. */
export function locateQuote(text: string, quote: string, hint?: { start: number; end: number }) {
  if (hint && text.slice(hint.start, hint.end) === quote) return { start: hint.start, end: hint.end };
  let i = text.indexOf(quote);
  if (i >= 0) return { start: i, end: i + quote.length };
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  const nt = norm(text);
  const nq = norm(quote).trim();
  i = nt.indexOf(nq);
  if (i >= 0 && nt.length === text.length) return { start: i, end: i + nq.length };
  return { start: 0, end: 0 };
}

export interface StoreResult {
  items: { id: string; itemType: string; status: string; confidence: number; whyUncertain: string | null; span: { start: number; end: number }; payload: unknown }[];
  rejected: { itemType: string; reason: string }[];
  approvalRequestId: string | null;
}

/**
 * Validate candidates (Zod) and store as PROPOSED / AWAITING_VERIFICATION.
 * Medical instruction items from documents are bundled into one ACTIVATE_INSTRUCTIONS ApprovalRequest.
 */
export async function storeExtraction(
  ctx: PatientContext,
  source: { type: "DOCUMENT" | "MESSAGE"; id: string; text: string; at: Date; senderMemberId?: string | null },
  candidates: ExtractionCandidate[],
  detectedBy: string,
): Promise<StoreResult> {
  const db = ctx.db;
  const patient = await db.patient.findUniqueOrThrow({ where: { id: ctx.patientId } });
  const result: StoreResult = { items: [], rejected: [], approvalRequestId: null };
  // Re-extraction replaces earlier undecided proposals for the same source.
  await db.extractedItem.updateMany({ where: { patientId: ctx.patientId, sourceType: source.type, sourceId: source.id, status: { in: ["PROPOSED", "AWAITING_VERIFICATION"] } }, data: { status: "REJECTED", rejectionReason: "Superseded by a newer extraction run" } });

  const members = await db.careCircleMember.findMany({ where: { patientId: ctx.patientId, status: "ACTIVE" }, include: { user: { select: { name: true } } } });
  const medicalIds: string[] = [];

  for (const c of candidates) {
    const schema = PAYLOAD_SCHEMAS[c.itemType as ExtractedItemTypeName];
    const parsed = schema.safeParse(c.payload);
    if (!parsed.success) {
      result.rejected.push({ itemType: c.itemType, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    const payload = parsed.data as Record<string, unknown>;
    const span = locateQuote(source.text, c.quote, c.span);
    const reasons: string[] = [];
    if (c.whyUncertain) reasons.push(c.whyUncertain);
    if (c.confidence < DEFAULT_RULE_CONFIG.aiAlertConfidence) reasons.push(`Low confidence (${Math.round(c.confidence * 100)}%)`);
    if (c.itemType === "MEDICATION" && (!payload.times || (payload.times as string[]).length === 0)) reasons.push("No administration times found in the source");
    if (c.itemType === "MEDICATION" && payload.unitsPerAdministration == null) reasons.push("Units per administration not stated in the source");
    if (span.end <= span.start) reasons.push("Source location could not be pinned down");

    // Deterministic linking of messages to tasks / members.
    if (c.itemType === "COMPLETION_REPORT") {
      const t = await matchTask(db, ctx.patientId, patient.timezone, { category: String(payload.category ?? "MEDICATION"), timeOfDay: String(payload.timeOfDay ?? "unknown"), date: null, at: source.at });
      payload.linkedTaskId = t?.id ?? null;
      if (!t) reasons.push("Could not match this report to a scheduled task");
    }
    if (c.itemType === "COMMITMENT") {
      const committedName = String(payload.committedName ?? "").toLowerCase();
      const m = committedName ? members.find((mm) => mm.user.name.toLowerCase().split(" ")[0] === committedName.split(" ")[0]) : null;
      if (m) payload.committedMemberId = m.id;
      if (!payload.committedMemberId && source.senderMemberId && !payload.isHandoff) payload.committedMemberId = source.senderMemberId;
      payload.isHandoff = !!payload.committedMemberId && !!source.senderMemberId && payload.committedMemberId !== source.senderMemberId;
      const t = await matchTask(db, ctx.patientId, patient.timezone, { category: categoryFromText(String(payload.taskHint ?? payload.text ?? "")), timeOfDay: /morning/i.test(String(payload.text)) ? "morning" : /evening|tonight/i.test(String(payload.text)) ? "evening" : "unknown", date: (payload.date as string | null) ?? null, at: source.at });
      payload.linkedTaskId = t?.id ?? null;
    }

    const status = reasons.length ? "AWAITING_VERIFICATION" : "PROPOSED";
    const item = await db.extractedItem.create({
      data: {
        patientId: ctx.patientId,
        sourceType: source.type,
        sourceId: source.id,
        sourceSpan: span,
        itemType: c.itemType,
        payload: payload as Prisma.InputJsonValue,
        confidence: c.confidence,
        uncertaintyNote: reasons.length ? reasons.join(". ") : null,
        status,
        detectedBy,
        linkedTaskId: (payload.linkedTaskId as string | null) ?? null,
      },
    });
    if (source.type === "DOCUMENT" && MEDICAL_ITEM_TYPES.includes(c.itemType as ExtractedItemTypeName)) medicalIds.push(item.id);
    result.items.push({ id: item.id, itemType: item.itemType, status: item.status, confidence: item.confidence, whyUncertain: item.uncertaintyNote, span, payload });
  }

  if (medicalIds.length) {
    await db.approvalRequest.updateMany({ where: { patientId: ctx.patientId, actionType: "ACTIVATE_INSTRUCTIONS", state: "PENDING", payload: { path: ["documentId"], equals: source.id } }, data: { state: "EXPIRED", reason: "Replaced by a newer extraction run" } });
    const doc = await db.sourceDocument.findUniqueOrThrow({ where: { id: source.id } });
    const approval = await db.approvalRequest.create({
      data: {
        patientId: ctx.patientId,
        actionType: "ACTIVATE_INSTRUCTIONS",
        title: `Activate ${medicalIds.length} instruction(s) from "${doc.title}"${doc.versionNumber > 1 ? ` (version ${doc.versionNumber})` : ""}`,
        payload: { documentId: source.id, itemIds: medicalIds },
        requestedByUserId: ctx.actor.userId,
        requestedByType: ctx.actor.type,
        requiredPermission: SENSITIVE_ACTIONS.ACTIVATE_INSTRUCTIONS,
      },
    });
    result.approvalRequestId = approval.id;
  }
  await ctxAudit(ctx, { action: "ai.extraction", targetRef: `${source.type.toLowerCase()}:${source.id}`, details: { detectedBy, stored: result.items.length, rejectedBySchema: result.rejected.length, approvalRequestId: result.approvalRequestId } });
  return result;
}
