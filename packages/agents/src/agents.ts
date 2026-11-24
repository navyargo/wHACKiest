/**
 * Agent workflows. Each: system prompt, allowed tool list, step limit, Zod-validated output.
 * They use MCP tools only (through McpSession); they never import domain services for data.
 */
import { z } from "zod";
import { HandoverSnapshotZ, validateSummaryAgainstSnapshot, type HandoverSnapshot } from "@carerelay/domain";
import type { LlmProvider } from "./llm/provider";
import type { McpSession } from "./mcpSession";
import { checkQuestion, guardOutput, SAFETY_MESSAGE } from "./guard";

// ------------------------------------------------------------------ Intake
export const ExtractionResultZ = z.object({
  status: z.enum(["STORED", "NEEDS_MANUAL_REVIEW"]),
  provider: z.string(),
  items: z.array(z.object({ id: z.string(), itemType: z.string(), status: z.string(), confidence: z.number(), whyUncertain: z.string().nullable(), span: z.object({ start: z.number(), end: z.number() }) })),
  approvalRequestId: z.string().nullable(),
  error: z.string().optional(),
});
export type IntakeResult = z.infer<typeof ExtractionResultZ> & { toolCalls: McpSession["calls"] };

export async function runIntakeAgent(session: McpSession, input: { patientId: string; documentId?: string; messageId?: string }): Promise<IntakeResult> {
  const tool = input.documentId ? "extract_from_document" : "extract_from_message";
  const args = input.documentId ? { patientId: input.patientId, documentId: input.documentId } : { patientId: input.patientId, messageId: input.messageId! };
  const r = await session.callTool(tool, args);
  if (!r.ok) return { status: "NEEDS_MANUAL_REVIEW", provider: "n/a", items: [], approvalRequestId: null, error: r.text, toolCalls: session.calls };
  const parsed = ExtractionResultZ.safeParse(r.structured);
  if (!parsed.success) return { status: "NEEDS_MANUAL_REVIEW", provider: "n/a", items: [], approvalRequestId: null, error: "Tool output failed validation", toolCalls: session.calls };
  return { ...parsed.data, toolCalls: session.calls };
}

// ------------------------------------------------------------------ Coverage
const COVERAGE_SYSTEM = `You are CareRelay's Coverage Agent. A care task has a coverage gap.
Use find_available_caregivers to see ranked candidates (qualification, busy/free, load). Then call propose_reassignment for the single best eligible candidate with a short reason.
You can only PROPOSE: a human coordinator approves and the candidate must accept. Never give medical advice. Finish with one sentence saying who you proposed and why.`;
export const COVERAGE_TOOLS = ["find_available_caregivers", "get_task", "propose_reassignment"];
export const CoverageResultZ = z.object({
  proposals: z.array(z.object({ taskId: z.string(), candidateMemberId: z.string(), approvalRequestId: z.string() })),
  message: z.string(),
});

export async function runCoverageAgent(session: McpSession, provider: LlmProvider, input: { patientId: string; taskId: string }) {
  const tools = (await session.listTools()).filter((t) => COVERAGE_TOOLS.includes(t.name));
  const out = await provider.runToolLoop({
    system: COVERAGE_SYSTEM,
    user: `Patient id: ${input.patientId}. Task id with a coverage gap: ${input.taskId}. Propose who could cover it.`,
    tools,
    maxSteps: 6,
    context: { patientId: input.patientId, taskId: input.taskId, mode: "coverage" },
    callTool: (n, a) => session.callTool(n, a),
  });
  // Output is built from what actually happened through MCP, not from model text.
  const proposals: z.infer<typeof CoverageResultZ>["proposals"] = [];
  for (const c of session.calls) {
    if (c.tool !== "propose_reassignment" || !c.ok) continue;
    const s = c.structured as { approvalRequestId?: string; taskId?: string; toMemberId?: string } | undefined;
    if (s?.approvalRequestId && s.taskId && s.toMemberId) proposals.push({ taskId: s.taskId, candidateMemberId: s.toMemberId, approvalRequestId: s.approvalRequestId });
  }
  const g = guardOutput(out.finalText || "No proposal made.");
  return { ...CoverageResultZ.parse({ proposals, message: g.text }), toolCalls: session.calls.map(({ structured: _s, ...rest }) => rest) };
}

// ------------------------------------------------------------------ Handover
export async function runHandoverAgent(session: McpSession, provider: LlmProvider, input: { patientId: string; toMemberId: string; shiftStart?: string; shiftEnd?: string }) {
  const r = await session.callTool("draft_handover", { patientId: input.patientId, toMemberId: input.toMemberId, ...(input.shiftStart ? { shiftStart: input.shiftStart, shiftEnd: input.shiftEnd } : {}) });
  if (!r.ok) throw new Error(r.text);
  const out = z.object({ handoverId: z.string(), snapshot: HandoverSnapshotZ }).parse(r.structured);
  const summary = await summarise(provider, out.snapshot);
  return { handoverId: out.handoverId, snapshot: out.snapshot, ...summary, toolCalls: session.calls };
}

async function summarise(provider: LlmProvider, snap: HandoverSnapshot) {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.summarizeHandover(snap, attempt ? lastError : undefined);
      const { summary, dropped } = validateSummaryAgainstSnapshot(raw, snap);
      // Medical-content guard on every sentence.
      const safe = summary.sentences.filter((s) => !guardOutput(s.text).rewritten);
      const guardDropped = summary.sentences.filter((s) => guardOutput(s.text).rewritten).map((s) => s.text);
      if (safe.length || attempt === 1) return { summary: { sentences: safe }, dropped: [...dropped, ...guardDropped], needsManualReview: safe.length === 0 };
      lastError = `No valid sentences. Every sentence needs refs to snapshot ids. Dropped: ${dropped.join(" | ")}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  return { summary: { sentences: [] }, dropped: [], needsManualReview: true };
}

// ------------------------------------------------------------------ Care Assistant
export const READ_TOOLS = ["list_patients", "get_care_status", "list_tasks", "get_task", "list_open_alerts", "get_source_reference", "get_member_availability", "find_available_caregivers", "get_inventory_status"];
const ASSISTANT_SYSTEM = `You are the CareRelay Care Assistant for a family care circle. Answer ONLY from data returned by the CareRelay tools you call; call tools before answering.
Cite every fact with a marker in the form [[TASK:<id>]], [[ALERT:<id>]], [[MEDICATION:<id>]], [[CONFLICT:<id>]] or [[DOCUMENT:<id>]] using ids from tool results.
If the tools don't contain the answer, reply exactly: "I don't have that information in CareRelay."
Never diagnose, never recommend, change, skip or repeat a dose, and never say which of two instructions is right; for such questions reply: "${SAFETY_MESSAGE}"
Describe alert levels as coordination risk, not medical severity. Be brief and concrete (times, names, states).`;

export const AssistantAnswerZ = z.object({
  answer: z.string(),
  citations: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() })),
  refused: z.boolean(),
  toolCalls: z.array(z.object({ tool: z.string(), args: z.record(z.unknown()), ok: z.boolean(), durationMs: z.number(), summary: z.string() }).strip()),
  provider: z.string(),
});
export type AssistantAnswer = z.infer<typeof AssistantAnswerZ>;

function findLabel(results: unknown[], id: string): string | null {
  const stack = [...results];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.id === id) return String(o.title ?? o.name ?? id);
      stack.push(...Object.values(o));
    }
  }
  return null;
}

export async function runCareAssistant(session: McpSession, provider: LlmProvider, input: { patientId: string; question: string }): Promise<AssistantAnswer> {
  const q = checkQuestion(input.question);
  if (q.blocked) return { answer: SAFETY_MESSAGE, citations: [], refused: true, toolCalls: [], provider: provider.name };
  const tools = (await session.listTools()).filter((t) => READ_TOOLS.includes(t.name));
  const results: unknown[] = [];
  const out = await provider.runToolLoop({
    system: ASSISTANT_SYSTEM,
    user: `Patient id: ${input.patientId}\nQuestion: ${input.question}`,
    tools,
    maxSteps: 6,
    context: { patientId: input.patientId, mode: "assistant" },
    callTool: async (n, a) => {
      const r = await session.callTool(n, a);
      if (r.ok && r.structured) results.push(r.structured);
      return r;
    },
  });
  // Citations: keep only ids that really appeared in tool results.
  const citations: AssistantAnswer["citations"] = [];
  let answer = out.finalText.replace(/\[\[(TASK|ALERT|MEDICATION|CONFLICT|DOCUMENT):([0-9a-f-]{36})\]\]/gi, (_m, type: string, id: string) => {
    const label = findLabel(results, id);
    if (!label) return "";
    let n = citations.findIndex((c) => c.id === id);
    if (n < 0) {
      citations.push({ type: type.toUpperCase(), id, label });
      n = citations.length - 1;
    }
    return `[${n + 1}]`;
  });
  answer = answer.replace(/\[\[[^\]]*\]\]/g, "").trim() || "I don't have that information in CareRelay.";
  const g = guardOutput(answer);
  return AssistantAnswerZ.parse({ answer: g.text, citations: g.rewritten ? [] : citations, refused: g.rewritten, toolCalls: session.calls, provider: provider.name });
}
