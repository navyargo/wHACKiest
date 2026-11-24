/**
 * CareRelay MCP server (official @modelcontextprotocol/sdk). Tools call the same domain services as
 * the REST API. Every call is authenticated (token → user), patient-scoped (membership + token scope),
 * permission-checked, schema-validated and written to the audit log.
 */
import { createHash, randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PrismaClient, User } from "@prisma/client";
import {
  DomainError,
  type Actor,
  type Clock,
  type PatientContext,
  resolvePatientContext,
  requirePermission,
  audit,
  listPatientsForUser,
  getCareStatus,
  listTasks,
  getTaskDetail,
  listAlerts,
  getSourceReference,
  getMemberAvailability,
  findAvailableCaregivers,
  getInventory,
  draftHandover,
  proposeReassignment,
  createApproval,
  transitionTask,
  recordObservation,
  runSweep,
  getTimeline,
  SENSITIVE_ACTIONS,
  type SensitiveAction,
} from "@carerelay/domain";
import { runExtraction, type LlmProvider } from "@carerelay/agents";

export type SideEffectClass = "READ" | "PROPOSE" | "ACT_SELF" | "READ+system";

export interface McpAuth {
  user: Pick<User, "id" | "name">;
  /** Token scoped to one patient (HTTP tokens issued by the app); null = all the user's patients. */
  tokenPatientId: string | null;
  label: string;
  transport: "http" | "stdio" | "memory";
}

export interface McpDeps {
  db: PrismaClient;
  clock: Clock;
  provider: LlmProvider;
}

export const TOOL_CATALOG: { name: string; cls: SideEffectClass; permission: string; description: string }[] = [];

const argsHash = (a: unknown) => createHash("sha256").update(JSON.stringify(a ?? {})).digest("hex").slice(0, 16);
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const summarise = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};
const PatientIdZ = z.string().uuid().describe("CareRelay patient id (from list_patients)");

export function createCareRelayMcpServer(auth: McpAuth, deps: McpDeps) {
  const server = new McpServer({ name: "carerelay", version: "0.1.0" }, { instructions: "CareRelay care-coordination tools. Records, compares, flags and routes to authorised humans; never gives medical advice. PROPOSE tools create proposals/approval requests only." });
  const actor: Actor = { type: "AGENT", userId: auth.user.id, name: `${auth.user.name} (via ${auth.label})`, via: "MCP" };

  async function ctxFor(patientId: string): Promise<PatientContext> {
    return resolvePatientContext(deps.db, deps.clock, actor, patientId, { tokenPatientId: auth.tokenPatientId });
  }

  async function logCall(tool: string, cls: SideEffectClass, args: unknown, patientId: string | null, outcome: "allowed" | "denied" | "error", durationMs: number, resultSummary: string) {
    await audit(deps.db, actor, {
      action: "mcp.tool_call",
      // Never attribute a denied cross-patient call to that patient's log.
      patientId: outcome === "denied" ? null : patientId,
      targetRef: `tool:${tool}`,
      details: { tool, class: cls, argsHash: argsHash(args), argsSummary: summarise(args).slice(0, 160), outcome, durationMs, resultSummary, transport: auth.transport, tokenLabel: auth.label, requestedPatientId: patientId },
    }, await deps.clock.now());
  }

  function register<I extends z.ZodRawShape, O extends z.ZodRawShape>(
    name: string,
    cfg: { title: string; description: string; cls: SideEffectClass; permission: string; input: I; output: O },
    handler: (args: z.objectOutputType<I, z.ZodTypeAny>) => Promise<z.objectOutputType<O, z.ZodTypeAny>>,
  ) {
    TOOL_CATALOG.find((t) => t.name === name) || TOOL_CATALOG.push({ name, cls: cfg.cls, permission: cfg.permission, description: cfg.description });
    server.registerTool(
      name,
      {
        title: cfg.title,
        description: `[${cfg.cls}] ${cfg.description}`,
        inputSchema: cfg.input,
        outputSchema: cfg.output,
        annotations: { readOnlyHint: cfg.cls === "READ", destructiveHint: false, idempotentHint: cfg.cls === "READ" || cfg.cls === "READ+system" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        const t0 = Date.now();
        const pid = typeof args?.patientId === "string" ? args.patientId : null;
        try {
          const result = plain(await handler(args));
          await logCall(name, cfg.cls, args, pid, "allowed", Date.now() - t0, summarise(result).slice(0, 200));
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
        } catch (e) {
          const denied = e instanceof DomainError && (e.code === "FORBIDDEN" || e.code === "NOT_FOUND" || e.code === "UNAUTHENTICATED");
          const msg = e instanceof DomainError ? `${e.code}: ${e.message}` : `ERROR: ${(e as Error).message}`;
          await logCall(name, cfg.cls, args, pid, denied ? "denied" : "error", Date.now() - t0, msg.slice(0, 200));
          return { isError: true, content: [{ type: "text" as const, text: msg }] };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }

  const anyArr = z.array(z.any());

  register("list_patients", { title: "List patients", description: "Patients whose care circle you belong to, with your role and permissions.", cls: "READ", permission: "membership", input: {}, output: { patients: anyArr } }, async () => {
    const ps = await listPatientsForUser(deps.db, auth.user.id);
    return { patients: ps.filter((p) => !auth.tokenPatientId || p.id === auth.tokenPatientId) };
  });

  register("get_care_status", { title: "Care status", description: "Consolidated status for today: tasks by state, uncovered and overdue tasks, open alerts and conflicts, low stock. Safe for remote viewers (no raw messages).", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ }, output: { date: z.string(), now: z.string(), tasksToday: z.number(), byState: z.record(z.number()), uncovered: z.number(), overdue: z.number(), completed: z.number(), openConflicts: z.number(), openAlerts: z.number(), alertsByLevel: z.record(z.number()), topAlerts: anyArr, lowStock: anyArr, uncoveredTasks: anyArr, nextTasks: anyArr } }, async ({ patientId }) => getCareStatus(await ctxFor(patientId)));

  register("list_tasks", { title: "List tasks", description: "Tasks for a local date (default today) with owner and acknowledgement state. Optional filters.", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), state: z.string().optional(), assigneeMemberId: z.string().uuid().optional() }, output: { date: z.string(), tasks: anyArr } }, async ({ patientId, date, state, assigneeMemberId }) => {
    const r = await listTasks(await ctxFor(patientId), { date, state, assigneeMemberId });
    return { date: r.date, tasks: r.tasks.map((t) => ({ id: t.id, title: t.title, category: t.category, priority: t.priority, state: t.state, localTime: t.localTime, windowStart: t.windowStart, windowEnd: t.windowEnd, assigneeMemberId: t.assigneeMemberId, assigneeName: t.assigneeName, covered: t.covered, acknowledgedAt: t.acknowledgedAt, completedAt: t.completedAt, requiredQualification: t.requiredQualification })) };
  });

  register("get_task", { title: "Get task", description: "One task with its full event history, administration records, linked reports and source references.", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ, taskId: z.string().uuid() }, output: { task: z.any(), events: anyArr, administrations: anyArr, conflicts: anyArr, alerts: anyArr, messageReports: anyArr, source: z.any() } }, async ({ patientId, taskId }) => {
    const d = await getTaskDetail(await ctxFor(patientId), taskId);
    return { task: d.task, events: d.events, administrations: d.administrations, conflicts: d.conflicts, alerts: d.alerts, messageReports: d.messageReports, source: d.source };
  });

  register("list_open_alerts", { title: "Open alerts", description: "Open coordination alerts with plain-language explanation, rule/AI basis and evidence references.", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ }, output: { alerts: anyArr } }, async ({ patientId }) => {
    const a = await listAlerts(await ctxFor(patientId));
    return { alerts: a.map((x) => ({ id: x.id, ruleId: x.ruleId, level: x.level, title: x.title, explanation: x.explanation, basis: x.basis, evidence: x.evidence, affectedTaskId: x.affectedTaskId, state: x.state, detectedAt: x.detectedAt })) };
  });

  register("get_source_reference", { title: "Source reference", description: "The document or message excerpt behind a reference (permission-checked).", cls: "READ", permission: "view_documents / view_messages", input: { patientId: PatientIdZ, sourceType: z.enum(["DOCUMENT", "MESSAGE"]), sourceId: z.string().uuid(), start: z.number().int().min(0).optional(), end: z.number().int().min(0).optional() }, output: { sourceType: z.string(), sourceId: z.string(), title: z.string(), excerpt: z.string(), span: z.object({ start: z.number(), end: z.number() }), recordedBy: z.string().nullable(), at: z.string() } }, async ({ patientId, ...rest }) => getSourceReference(await ctxFor(patientId), rest));

  register("get_member_availability", { title: "Member availability", description: "Busy/free and on-shift blocks per member for a time range. No private calendar details.", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ, from: z.string().datetime(), to: z.string().datetime() }, output: { members: anyArr } }, async ({ patientId, from, to }) => ({ members: await getMemberAvailability(await ctxFor(patientId), new Date(from), new Date(to)) }));

  register("find_available_caregivers", { title: "Find available caregivers", description: "Ranked candidates for a task with reasons: qualification, availability, current load.", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ, taskId: z.string().uuid() }, output: { taskId: z.string(), taskTitle: z.string(), requiredQualification: z.string().nullable(), candidates: anyArr } }, async ({ patientId, taskId }) => findAvailableCaregivers(await ctxFor(patientId), taskId));

  register("get_inventory_status", { title: "Inventory status", description: "Medication stock, projected days remaining and estimate flags. Never suggests changing consumption.", cls: "READ", permission: "view_patient", input: { patientId: PatientIdZ }, output: { items: anyArr } }, async ({ patientId }) => ({ items: await getInventory(await ctxFor(patientId)) }));

  register("draft_handover", { title: "Draft handover", description: "Builds the structured handover snapshot from recorded data and stores it as a DRAFT for the caller to review and send.", cls: "PROPOSE", permission: "record_care", input: { patientId: PatientIdZ, toMemberId: z.string().uuid(), shiftStart: z.string().datetime().optional(), shiftEnd: z.string().datetime().optional() }, output: { handoverId: z.string(), state: z.string(), snapshot: z.any() } }, async ({ patientId, toMemberId, shiftStart, shiftEnd }) => {
    const h = await draftHandover(await ctxFor(patientId), { toMemberId, shiftStart: shiftStart ? new Date(shiftStart) : undefined, shiftEnd: shiftEnd ? new Date(shiftEnd) : undefined });
    return { handoverId: h.id, state: h.state, snapshot: h.snapshot };
  });

  const extractionOut = { status: z.enum(["STORED", "NEEDS_MANUAL_REVIEW"]), provider: z.string(), items: anyArr, rejectedBySchema: anyArr, approvalRequestId: z.string().nullable(), error: z.string().optional() };
  register("extract_from_document", { title: "Extract from document", description: "Runs AI extraction on an uploaded document and stores PROPOSED / AWAITING_VERIFICATION items with source spans. Medical instructions need a verifier's approval before they become active.", cls: "PROPOSE", permission: "upload_documents", input: { patientId: PatientIdZ, documentId: z.string().uuid() }, output: extractionOut }, async ({ patientId, documentId }) => runExtraction(await ctxFor(patientId), { type: "DOCUMENT", id: documentId }, deps.provider));

  register("extract_from_message", { title: "Extract from message", description: "Interprets an authorised message (commitments, hand-offs, completion reports, observations…) as proposals.", cls: "PROPOSE", permission: "view_messages", input: { patientId: PatientIdZ, messageId: z.string().uuid() }, output: extractionOut }, async ({ patientId, messageId }) => runExtraction(await ctxFor(patientId), { type: "MESSAGE", id: messageId }, deps.provider));

  register("propose_reassignment", { title: "Propose reassignment", description: "Creates an approval request to (re)assign a task. A coordinator must approve, then the candidate must accept.", cls: "PROPOSE", permission: "view_patient", input: { patientId: PatientIdZ, taskId: z.string().uuid(), toMemberId: z.string().uuid(), reason: z.string().min(3).max(500) }, output: { approvalRequestId: z.string(), taskId: z.string(), toMemberId: z.string(), title: z.string(), state: z.string() } }, async ({ patientId, taskId, toMemberId, reason }) => {
    const ctx = await ctxFor(patientId);
    requirePermission(ctx, "view_patient");
    const a = await proposeReassignment(ctx, { taskId, toMemberId, reason });
    return { approvalRequestId: a.id, taskId, toMemberId, title: a.title, state: a.state };
  });

  register("request_approval", { title: "Request approval", description: "Creates an ApprovalRequest for a sensitive action. Never executes it.", cls: "PROPOSE", permission: "view_patient", input: { patientId: PatientIdZ, actionType: z.enum(Object.keys(SENSITIVE_ACTIONS) as [SensitiveAction, ...SensitiveAction[]]), title: z.string().min(3).max(200), payload: z.record(z.unknown()) }, output: { approvalRequestId: z.string(), state: z.string(), requiredPermission: z.string() } }, async ({ patientId, actionType, title, payload }) => {
    const a = await createApproval(await ctxFor(patientId), { actionType, title, payload: payload as object });
    return { approvalRequestId: a.id, state: a.state, requiredPermission: a.requiredPermission };
  });

  register("acknowledge_task", { title: "Acknowledge my task", description: "Accept a task assigned to you (only your own).", cls: "ACT_SELF", permission: "assignee", input: { patientId: PatientIdZ, taskId: z.string().uuid() }, output: { taskId: z.string(), state: z.string(), acknowledgedAt: z.string().nullable() } }, async ({ patientId, taskId }) => {
    const t = await transitionTask(await ctxFor(patientId), taskId, { event: "ACKNOWLEDGE", idempotencyKey: `mcp:${randomUUID()}` });
    return { taskId: t.id, state: t.state, acknowledgedAt: t.acknowledgedAt?.toISOString() ?? null };
  });

  register("record_observation", { title: "Record observation", description: "Add an observation about the patient, recorded as from you.", cls: "ACT_SELF", permission: "record_care", input: { patientId: PatientIdZ, text: z.string().min(2).max(2000), category: z.string().max(40).optional() }, output: { observationId: z.string(), recordedAt: z.string() } }, async ({ patientId, text, category }) => {
    const o = await recordObservation(await ctxFor(patientId), { text, category });
    return { observationId: o.id, recordedAt: o.recordedAt.toISOString() };
  });

  register("run_care_sweep", { title: "Run care sweep", description: "Runs deterministic gap detection for the patient (idempotent) and returns created / updated / resolved alerts.", cls: "READ+system", permission: "view_patient", input: { patientId: PatientIdZ }, output: { at: z.string(), tasksGenerated: z.number(), created: anyArr, updated: z.number(), resolved: anyArr, escalated: anyArr, taskTransitions: anyArr } }, async ({ patientId }) => {
    const ctx = await ctxFor(patientId);
    requirePermission(ctx, "view_patient");
    return runSweep(deps.db, deps.clock, patientId);
  });

  // ---------------- resources
  server.registerResource(
    "patient-timeline",
    new ResourceTemplate("patient://{patientId}/timeline", { list: undefined }),
    { title: "Patient timeline", description: "Unified chronological feed (permission-filtered).", mimeType: "application/json" },
    async (uri, vars) => {
      const t0 = Date.now();
      const pid = String(vars.patientId);
      try {
        const entries = await getTimeline(await ctxFor(pid), { limit: 100 });
        await logCall("resource:patient_timeline", "READ", { patientId: pid }, pid, "allowed", Date.now() - t0, `${entries.length} entries`);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(entries) }] };
      } catch (e) {
        await logCall("resource:patient_timeline", "READ", { patientId: pid }, pid, "denied", Date.now() - t0, (e as Error).message);
        throw e;
      }
    },
  );
  server.registerResource(
    "document",
    new ResourceTemplate("document://{documentId}", { list: undefined }),
    { title: "Source document", description: "Text of an uploaded document (requires view_documents).", mimeType: "text/plain" },
    async (uri, vars) => {
      const t0 = Date.now();
      const id = String(vars.documentId);
      const doc = /^[0-9a-f-]{36}$/i.test(id) ? await deps.db.sourceDocument.findUnique({ where: { id }, select: { patientId: true } }) : null;
      try {
        if (!doc) throw new DomainError("NOT_FOUND", "Document not found");
        const ctx = await ctxFor(doc.patientId);
        requirePermission(ctx, "view_documents");
        const d = await deps.db.sourceDocument.findUniqueOrThrow({ where: { id } });
        await logCall("resource:document", "READ", { documentId: id }, doc.patientId, "allowed", Date.now() - t0, d.title);
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `${d.title} (version ${d.versionNumber})\n\n${d.rawText}` }] };
      } catch (e) {
        await logCall("resource:document", "READ", { documentId: id }, null, "denied", Date.now() - t0, (e as Error).message);
        throw e;
      }
    },
  );

  // ---------------- prompt
  server.registerPrompt(
    "shift_handover",
    { title: "Shift handover", description: "Draft a handover for the next caregiver, strictly from CareRelay data.", argsSchema: { patientId: z.string(), toMemberId: z.string() } },
    ({ patientId, toMemberId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call the draft_handover tool with patientId "${patientId}" and toMemberId "${toMemberId}". Then write a short plain-language handover summary using ONLY items in the returned snapshot, citing each item's id in brackets after the sentence it supports. Lead with open alerts, unresolved conflicts and pending tasks. Do not give medical advice or suggest doses. Remind the reader that reading the handover does not accept any task — pending tasks must be accepted individually.`,
          },
        },
      ],
    }),
  );

  return server;
}
