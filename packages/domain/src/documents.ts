import { randomUUID } from "node:crypto";
import { type PatientContext, ctxAudit, requirePermission } from "./context";
import { DomainError, notFound } from "./errors";
import { computeDocumentDiff } from "./documentDiff";

export interface NewDocumentInput {
  kind: "PRESCRIPTION" | "DISCHARGE_SUMMARY" | "APPOINTMENT" | "INSTRUCTION" | "OTHER";
  title: string;
  documentDate: Date;
  rawText: string;
  storageKey?: string | null;
  mimeType?: string;
  /** Upload as a new version of an existing document group. */
  versionGroupId?: string | null;
}

export async function createDocument(ctx: PatientContext, input: NewDocumentInput) {
  requirePermission(ctx, "upload_documents");
  if (!input.rawText.trim()) throw new DomainError("VALIDATION_ERROR", "The document has no readable text. Paste or type the text (image OCR isn't available in this MVP).");
  let versionGroupId: string = randomUUID();
  let versionNumber = 1;
  let supersedesId: string | null = null;
  if (input.versionGroupId) {
    const latest = await ctx.db.sourceDocument.findFirst({ where: { patientId: ctx.patientId, versionGroupId: input.versionGroupId }, orderBy: { versionNumber: "desc" } });
    if (!latest) throw notFound("Document group not found");
    versionGroupId = latest.versionGroupId;
    versionNumber = latest.versionNumber + 1;
    supersedesId = latest.id;
  }
  const doc = await ctx.db.sourceDocument.create({
    data: { patientId: ctx.patientId, kind: input.kind, title: input.title, documentDate: input.documentDate, versionGroupId, versionNumber, supersedesId, rawText: input.rawText, storageKey: input.storageKey ?? null, mimeType: input.mimeType ?? "text/plain", uploadedBy: ctx.actor.userId! },
  });
  await ctxAudit(ctx, { action: "document.upload", targetRef: `document:${doc.id}`, details: { title: doc.title, versionNumber } });
  return doc;
}

export async function listDocuments(ctx: PatientContext) {
  requirePermission(ctx, "view_documents");
  const docs = await ctx.db.sourceDocument.findMany({ where: { patientId: ctx.patientId }, orderBy: [{ documentDate: "desc" }, { versionNumber: "desc" }], select: { id: true, kind: true, title: true, documentDate: true, versionGroupId: true, versionNumber: true, supersedesId: true, createdAt: true, uploadedBy: true, mimeType: true } });
  const counts = await ctx.db.extractedItem.groupBy({ by: ["sourceId", "status"], where: { patientId: ctx.patientId, sourceType: "DOCUMENT" }, _count: true });
  const latestByGroup = new Map<string, number>();
  for (const d of docs) latestByGroup.set(d.versionGroupId, Math.max(latestByGroup.get(d.versionGroupId) ?? 0, d.versionNumber));
  return docs.map((d) => ({
    ...d,
    isLatestVersion: latestByGroup.get(d.versionGroupId) === d.versionNumber,
    itemCounts: Object.fromEntries(counts.filter((c) => c.sourceId === d.id).map((c) => [c.status, c._count])),
  }));
}

export async function getDocument(ctx: PatientContext, documentId: string) {
  requirePermission(ctx, "view_documents");
  const doc = await ctx.db.sourceDocument.findFirst({ where: { id: documentId, patientId: ctx.patientId } });
  if (!doc) throw notFound("Document not found");
  const [items, versions, approvals, uploader] = await Promise.all([
    ctx.db.extractedItem.findMany({ where: { patientId: ctx.patientId, sourceType: "DOCUMENT", sourceId: doc.id }, orderBy: [{ status: "asc" }, { createdAt: "asc" }] }),
    ctx.db.sourceDocument.findMany({ where: { patientId: ctx.patientId, versionGroupId: doc.versionGroupId }, orderBy: { versionNumber: "asc" }, select: { id: true, versionNumber: true, title: true, documentDate: true, createdAt: true } }),
    ctx.db.approvalRequest.findMany({ where: { patientId: ctx.patientId, actionType: "ACTIVATE_INSTRUCTIONS", payload: { path: ["documentId"], equals: doc.id } }, orderBy: { createdAt: "desc" } }),
    ctx.db.user.findUnique({ where: { id: doc.uploadedBy }, select: { name: true } }),
  ]);
  const diff = doc.supersedesId ? await computeDocumentDiff(ctx.db, ctx.patientId, doc.id) : null;
  const previous = doc.supersedesId ? await ctx.db.sourceDocument.findUnique({ where: { id: doc.supersedesId }, select: { id: true, rawText: true, versionNumber: true, title: true } }) : null;
  return { document: { ...doc, uploadedByName: uploader?.name ?? "Unknown" }, items, versions, approval: approvals[0] ?? null, diff, previous };
}

/** Edit an extracted item's payload before approval (verifier / coordinator). */
export async function editExtractedItem(ctx: PatientContext, itemId: string, payload: Record<string, unknown>) {
  const { PAYLOAD_SCHEMAS, MEDICAL_ITEM_TYPES } = await import("./schemas");
  const x = await ctx.db.extractedItem.findFirst({ where: { id: itemId, patientId: ctx.patientId } });
  if (!x) throw notFound("Item not found");
  requirePermission(ctx, MEDICAL_ITEM_TYPES.includes(x.itemType as never) ? "verify_medical" : "manage_tasks");
  if (!["PROPOSED", "AWAITING_VERIFICATION"].includes(x.status)) throw new DomainError("INVALID_TRANSITION", "Only undecided items can be edited.");
  const parsed = PAYLOAD_SCHEMAS[x.itemType as keyof typeof PAYLOAD_SCHEMAS].safeParse(payload);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Invalid item", parsed.error.issues);
  const updated = await ctx.db.extractedItem.update({ where: { id: x.id }, data: { payload: parsed.data as object, uncertaintyNote: x.uncertaintyNote ? `${x.uncertaintyNote} (edited by ${ctx.actor.name})` : `Edited by ${ctx.actor.name}` } });
  await ctxAudit(ctx, { action: "extracted.edit", targetRef: `extracted:${x.id}`, details: { before: x.payload as object, after: parsed.data as object } });
  return updated;
}
