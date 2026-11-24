/**
 * The extraction pipeline used by the MCP extract_* tools:
 * provider → Zod → retry once with the error → "Needs manual review" on a second failure → store as proposals.
 */
import { ExtractionOutputZ, storeExtraction, ctxAudit, DomainError, requirePermission, localDateString, notFound, type PatientContext } from "@carerelay/domain";
import type { LlmProvider } from "./llm/provider";

export interface ExtractionRunResult {
  status: "STORED" | "NEEDS_MANUAL_REVIEW";
  provider: string;
  items: { id: string; itemType: string; status: string; confidence: number; whyUncertain: string | null; span: { start: number; end: number } }[];
  rejectedBySchema: { itemType: string; reason: string }[];
  approvalRequestId: string | null;
  error?: string;
}

export async function runExtraction(ctx: PatientContext, source: { type: "DOCUMENT" | "MESSAGE"; id: string }, provider: LlmProvider): Promise<ExtractionRunResult> {
  const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: ctx.patientId } });
  const members = await ctx.db.careCircleMember.findMany({ where: { patientId: ctx.patientId, status: "ACTIVE" }, include: { user: { select: { name: true } } } });
  let text: string, at: Date, senderName: string | undefined, senderMemberId: string | null = null, documentKind: string | undefined;
  if (source.type === "DOCUMENT") {
    requirePermission(ctx, "upload_documents");
    const d = await ctx.db.sourceDocument.findFirst({ where: { id: source.id, patientId: ctx.patientId } });
    if (!d) throw notFound("Document not found");
    text = d.rawText;
    at = d.createdAt;
    documentKind = d.kind;
  } else {
    requirePermission(ctx, "view_messages");
    const m = await ctx.db.sourceMessage.findFirst({ where: { id: source.id, patientId: ctx.patientId } });
    if (!m) throw notFound("Message not found");
    // Communications privacy: only explicitly authorised messages are ever processed.
    if (!m.authorisedForProcessing) throw new DomainError("FORBIDDEN", "This message has not been authorised for processing.");
    text = m.text;
    at = m.sentAt;
    senderName = m.senderName;
    senderMemberId = m.senderMemberId;
  }
  const input = { sourceKind: source.type, documentKind, text, senderName, memberNames: members.map((m) => m.user.name), sourceDate: localDateString(at, patient.timezone) };

  let parsed = null as ReturnType<typeof ExtractionOutputZ.safeParse> | null;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.extract(input, attempt ? lastError : undefined);
      parsed = ExtractionOutputZ.safeParse(raw);
      if (parsed.success) break;
      lastError = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) {
      lastError = (e as Error).message;
      parsed = null;
    }
  }
  if (!parsed?.success) {
    await ctxAudit(ctx, { action: "ai.extraction_failed", targetRef: `${source.type.toLowerCase()}:${source.id}`, details: { provider: provider.name, error: lastError } });
    return { status: "NEEDS_MANUAL_REVIEW", provider: provider.name, items: [], rejectedBySchema: [], approvalRequestId: null, error: `Needs manual review: ${lastError}` };
  }
  const stored = await storeExtraction(ctx, { type: source.type, id: source.id, text, at, senderMemberId }, parsed.data.items, provider.name);
  if (source.type === "MESSAGE") await ctx.db.sourceMessage.update({ where: { id: source.id }, data: { processedAt: await ctx.clock.now() } });
  return { status: "STORED", provider: provider.name, items: stored.items, rejectedBySchema: stored.rejected, approvalRequestId: stored.approvalRequestId };
}
