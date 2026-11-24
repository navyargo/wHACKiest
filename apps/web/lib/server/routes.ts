import { randomUUID } from "node:crypto";
/** REST route table. Mirrors docs/API.md. Every handler calls domain services; no business logic here. */
import { z } from "zod";
import * as D from "@carerelay/domain";
import { runIntakeAgent, runCoverageAgent, runHandoverAgent, runCareAssistant, pdfToText, aiModeLabel } from "@carerelay/agents";
import { DEMO_USERS, DEMO_DOMAIN, demoEmail } from "@carerelay/demo";
import { route, json, SESSION_COOKIE, type RouteDef } from "./http";
import { deps, voiceEnabled, isDemoMode } from "./deps";
import { withAgentSession } from "./agentRunner";
import { storage } from "./storage";
import { cachedSpeech } from "./tts";
import { runScenario, SCENARIOS, setClock, resetDemo } from "./scenarios";

const uuid = z.string().uuid();
const dt = z.string().datetime({ offset: true });
const cookieHeader = (token: string, maxAge: number) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

function isDemoAccount(email: string) {
  return email.toLowerCase().endsWith(`@${DEMO_DOMAIN}`);
}

async function loginResponse(userId: string) {
  const { db } = deps();
  const token = await D.createSession(db, userId);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true } });
  return json({ user }, 200, { "set-cookie": cookieHeader(token, D.SESSION_TTL_MS / 1000) });
}

const ctxOf = (c: { ctx: D.PatientContext | null }) => c.ctx!;

export const routes: RouteDef[] = [
  // ------------------------------------------------------------ auth
  route({
    method: "POST", path: "/auth/login", auth: "public",
    body: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }),
    handler: async ({ body }) => {
      const { db } = deps();
      const email = body.email.toLowerCase();
      if (isDemoAccount(email) && !isDemoMode()) throw new D.DomainError("UNAUTHENTICATED", "Demo accounts only work when DEMO_MODE=true.");
      const u = await db.user.findUnique({ where: { email } });
      if (!u || !(await D.verifyPassword(body.password, u.passwordHash))) throw new D.DomainError("UNAUTHENTICATED", "Email or password is incorrect.");
      await D.audit(db, { type: "USER", userId: u.id, name: u.name }, { action: "auth.login" });
      return loginResponse(u.id);
    },
  }),
  route({
    method: "POST", path: "/auth/logout", auth: "public",
    handler: async ({ req }) => {
      const m = /cr_session=([^;]+)/.exec(req.headers.get("cookie") ?? "");
      if (m) await D.deleteSession(deps().db, decodeURIComponent(m[1]));
      return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
    },
  }),
  route({
    method: "GET", path: "/me", auth: "session",
    handler: async ({ user }) => {
      const { db, clock, provider } = deps();
      const patients = await D.listPatientsForUser(db, user!.id);
      return {
        user: { id: user!.id, name: user!.name, email: user!.email },
        patients,
        demoMode: isDemoMode(),
        now: (await clock.now()).toISOString(),
        ai: { mode: provider.mode, label: aiModeLabel(provider), provider: provider.name },
        voiceEnabled: voiceEnabled(),
        storage: storage().name,
      };
    },
  }),
  route({
    method: "GET", path: "/demo/accounts", auth: "demo",
    handler: async () => {
      const { db } = deps();
      const users = await db.user.findMany({ where: { email: { in: DEMO_USERS.map((u) => demoEmail(u.key)) } }, select: { email: true, name: true } });
      return { accounts: DEMO_USERS.map((u) => ({ email: demoEmail(u.key), name: users.find((x) => x.email === demoEmail(u.key))?.name ?? u.name, role: u.role, relationship: u.relationship })) };
    },
  }),
  route({
    method: "POST", path: "/demo/login", auth: "demo",
    body: z.object({ email: z.string().email() }),
    handler: async ({ body }) => {
      if (!isDemoAccount(body.email)) throw new D.DomainError("FORBIDDEN", "One-click login is only for demo accounts.");
      const u = await deps().db.user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (!u) throw D.notFound("Demo account not found — run pnpm db:seed");
      return loginResponse(u.id);
    },
  }),

  // ------------------------------------------------------------ demo controls
  route({
    method: "GET", path: "/demo/state", auth: "demoSession",
    handler: async () => {
      const { db, clock } = deps();
      const row = await db.demoClock.findUnique({ where: { id: 1 } });
      return { now: (await clock.now()).toISOString(), offsetMinutes: row?.offsetMinutes ?? 0, scenarios: SCENARIOS.map(({ id, title, summary }) => ({ id, title, summary })) };
    },
  }),
  route({
    method: "POST", path: "/demo/clock", auth: "demoSession", mutate: true,
    body: z.union([z.object({ addMinutes: z.number().int().min(1).max(24 * 60) }), z.object({ jumpTo: D.HHMM })]),
    handler: async ({ body, user }) => setClock(user!, body),
  }),
  route({ method: "POST", path: "/demo/reset", auth: "demoSession", mutate: true, handler: async () => resetDemo() }),
  route({
    method: "POST", path: "/demo/scenarios/:n", auth: "demoSession", mutate: true,
    handler: async ({ params, user }) => runScenario(Number(params.n), user!),
  }),

  // ------------------------------------------------------------ patients
  route({ method: "GET", path: "/patients", auth: "session", handler: async ({ user }) => ({ patients: await D.listPatientsForUser(deps().db, user!.id) }) }),
  route({ method: "GET", path: "/patients/:pid", auth: "session", handler: async (c) => D.getPatient(ctxOf(c)) }),
  route({ method: "GET", path: "/patients/:pid/status", auth: "session", handler: async (c) => D.getCareStatus(ctxOf(c)) }),
  route({
    method: "POST", path: "/patients/:pid/sweep", auth: "session", mutate: true,
    handler: async (c) => {
      D.requirePermission(ctxOf(c), "view_patient");
      const { db, clock } = deps();
      return D.runSweep(db, clock, ctxOf(c).patientId);
    },
  }),

  // ------------------------------------------------------------ tasks
  route({
    method: "GET", path: "/patients/:pid/tasks", auth: "session",
    query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), state: z.string().optional(), assignee: uuid.optional() }),
    handler: async (c) => D.listTasks(ctxOf(c), { date: c.query.date, state: c.query.state, assigneeMemberId: c.query.assignee }),
  }),
  route({
    method: "POST", path: "/patients/:pid/tasks", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ title: z.string().min(2).max(200), description: z.string().max(2000).optional(), category: D.TaskCategoryZ, priority: D.PriorityZ, scheduledAt: dt, windowMinutesBefore: z.number().int().min(0).max(720), windowMinutesAfter: z.number().int().min(5).max(720), requiredQualification: z.string().max(60).nullable().optional() }),
    handler: async (c) => D.createOneOffTask(ctxOf(c), { ...c.body, scheduledAt: new Date(c.body.scheduledAt) }, c.idempotencyKey!),
  }),
  route({ method: "GET", path: "/patients/:pid/tasks/:tid", auth: "session", handler: async (c) => D.getTaskDetail(ctxOf(c), c.params.tid) }),
  route({
    method: "POST", path: "/patients/:pid/tasks/:tid/transition", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({
      event: z.enum(["ASSIGN", "ACKNOWLEDGE", "CLAIM", "DECLINE", "START", "COMPLETE", "REASSIGN", "CANCEL", "VERIFY", "RESOLVE_CONFLICT"]),
      version: z.number().int().min(1),
      targetMemberId: uuid.nullable().optional(),
      reason: z.string().max(1000).nullable().optional(),
      declaration: z.string().max(1000).nullable().optional(),
      note: z.string().max(1000).nullable().optional(),
      resolveTo: z.enum(["COMPLETED", "ACKNOWLEDGED", "UNASSIGNED", "CANCELLED"]).optional(),
    }),
    handler: async (c) => D.transitionTask(ctxOf(c), c.params.tid, { ...c.body, idempotencyKey: c.idempotencyKey! }),
  }),
  route({
    method: "POST", path: "/patients/:pid/tasks/:tid/administrations", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ administeredAt: dt.optional(), note: z.string().max(1000).optional(), confirmDuplicate: z.boolean().optional(), version: z.number().int().optional() }),
    handler: async (c) => D.recordAdministration(ctxOf(c), c.params.tid, { ...c.body, administeredAt: c.body.administeredAt ? new Date(c.body.administeredAt) : undefined }, c.idempotencyKey!),
  }),
  route({
    method: "POST", path: "/patients/:pid/tasks/:tid/reports", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ claim: z.enum(["DONE", "NOT_DONE"]), note: z.string().min(2).max(1000) }),
    handler: async (c) => D.reportTaskStatus(ctxOf(c), c.params.tid, c.body, c.idempotencyKey!),
  }),
  route({ method: "POST", path: "/patients/:pid/tasks/:tid/nudge", auth: "session", mutate: true, handler: async (c) => D.nudgeAssignee(ctxOf(c), c.params.tid) }),
  route({ method: "GET", path: "/patients/:pid/candidates", auth: "session", query: z.object({ taskId: uuid }), handler: async (c) => D.findAvailableCaregivers(ctxOf(c), c.query.taskId) }),

  // ------------------------------------------------------------ alerts & conflicts
  route({ method: "GET", path: "/patients/:pid/alerts", auth: "session", query: z.object({ state: z.enum(["open", "resolved", "all"]).optional() }), handler: async (c) => ({ alerts: await D.listAlerts(ctxOf(c), { state: c.query.state }) }) }),
  route({ method: "GET", path: "/patients/:pid/alerts/:aid", auth: "session", handler: async (c) => D.getAlert(ctxOf(c), c.params.aid) }),
  route({ method: "POST", path: "/patients/:pid/alerts/:aid/acknowledge", auth: "session", mutate: true, body: z.object({ version: z.number().int().optional() }), handler: async (c) => D.acknowledgeAlert(ctxOf(c), c.params.aid, c.body.version) }),
  route({
    method: "POST", path: "/patients/:pid/alerts/:aid/coverage-agent", auth: "session", mutate: true,
    handler: async (c) => {
      const ctx = ctxOf(c);
      D.requirePermission(ctx, "manage_tasks");
      const a = await D.getAlert(ctx, c.params.aid);
      if (!a.affectedTaskId) throw new D.DomainError("GUARD_FAILED", "This alert isn't about a specific task.");
      return withAgentSession(c.user!.id, ctx.patientId, "coverage", (s) => runCoverageAgent(s, deps().provider, { patientId: ctx.patientId, taskId: a.affectedTaskId! }));
    },
  }),
  route({ method: "GET", path: "/patients/:pid/conflicts", auth: "session", query: z.object({ state: z.enum(["OPEN", "RESOLVED"]).optional() }), handler: async (c) => ({ conflicts: await D.listConflicts(ctxOf(c), c.query.state) }) }),
  route({ method: "GET", path: "/patients/:pid/conflicts/:cid", auth: "session", handler: async (c) => D.getConflictByIdOrKey(ctxOf(c), c.params.cid) }),
  route({
    method: "POST", path: "/patients/:pid/conflicts/:cid/resolve", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ resolution: z.string().min(3).max(2000), resolveTo: z.enum(["COMPLETED", "ACKNOWLEDGED", "UNASSIGNED", "CANCELLED"]).optional(), version: z.number().int().optional() }),
    handler: async (c) => D.resolveConflict(ctxOf(c), c.params.cid, c.body),
  }),

  // ------------------------------------------------------------ documents & extraction
  route({ method: "GET", path: "/patients/:pid/documents", auth: "session", handler: async (c) => ({ documents: await D.listDocuments(ctxOf(c)) }) }),
  route({
    method: "POST", path: "/patients/:pid/documents", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({
      kind: z.enum(["PRESCRIPTION", "DISCHARGE_SUMMARY", "APPOINTMENT", "INSTRUCTION", "OTHER"]),
      title: z.string().min(2).max(200),
      documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      text: z.string().max(200_000).optional(),
      fileBase64: z.string().max(14_000_000).optional(),
      fileName: z.string().max(200).optional(),
      mimeType: z.string().max(100).optional(),
      versionGroupId: uuid.nullable().optional(),
    }),
    handler: async (c) => {
      const ctx = ctxOf(c);
      D.requirePermission(ctx, "upload_documents");
      let text = c.body.text ?? "";
      let storageKey: string | null = null;
      let mime = "text/plain";
      if (c.body.fileBase64) {
        const bytes = new Uint8Array(Buffer.from(c.body.fileBase64, "base64"));
        mime = c.body.mimeType ?? "application/octet-stream";
        storageKey = `documents/${ctx.patientId}/${randomUUID()}-${(c.body.fileName ?? "upload").replace(/[^\w.-]/g, "_")}`;
        await storage().put(storageKey, bytes, mime);
        if (mime === "application/pdf") {
          const pdf = await pdfToText(bytes);
          if (!text.trim()) text = pdf.text;
        } else if (mime.startsWith("text/")) {
          if (!text.trim()) text = new TextDecoder().decode(bytes);
        } else if (!text.trim()) {
          throw new D.DomainError("VALIDATION_ERROR", "Image OCR isn't available in this MVP. Paste or type the document text alongside the image.");
        }
      }
      const doc = await D.createDocument(ctx, { kind: c.body.kind, title: c.body.title, documentDate: D.zonedTimeToUtc(c.body.documentDate, "12:00", "Asia/Kolkata"), rawText: text, storageKey, mimeType: mime, versionGroupId: c.body.versionGroupId ?? null });
      const intake = await withAgentSession(c.user!.id, ctx.patientId, "intake", (s) => runIntakeAgent(s, { patientId: ctx.patientId, documentId: doc.id }));
      return { document: { id: doc.id, title: doc.title, versionNumber: doc.versionNumber }, intake };
    },
  }),
  route({ method: "GET", path: "/patients/:pid/documents/:did", auth: "session", handler: async (c) => D.getDocument(ctxOf(c), c.params.did) }),
  route({
    method: "POST", path: "/patients/:pid/documents/:did/extract", auth: "session", mutate: true, sweepAfter: true,
    handler: async (c) => {
      const ctx = ctxOf(c);
      return withAgentSession(c.user!.id, ctx.patientId, "intake", (s) => runIntakeAgent(s, { patientId: ctx.patientId, documentId: c.params.did }));
    },
  }),
  route({ method: "PATCH", path: "/patients/:pid/extracted/:eid", auth: "session", mutate: true, sweepAfter: true, body: z.object({ payload: z.record(z.unknown()) }), handler: async (c) => D.editExtractedItem(ctxOf(c), c.params.eid, c.body.payload) }),
  route({ method: "POST", path: "/patients/:pid/extracted/:eid/reject", auth: "session", mutate: true, sweepAfter: true, body: z.object({ reason: z.string().min(2).max(1000) }), handler: async (c) => D.rejectExtractedItem(ctxOf(c), c.params.eid, c.body.reason) }),
  route({ method: "POST", path: "/patients/:pid/extracted/:eid/confirm", auth: "session", mutate: true, sweepAfter: true, handler: async (c) => D.confirmExtractedItem(ctxOf(c), c.params.eid, c.idempotencyKey!) }),
  route({
    method: "GET", path: "/patients/:pid/sources/:type/:sid", auth: "session",
    query: z.object({ start: z.coerce.number().int().min(0).optional(), end: z.coerce.number().int().min(0).optional() }),
    handler: async (c) => {
      const type = c.params.type.toUpperCase();
      if (type !== "DOCUMENT" && type !== "MESSAGE") throw D.notFound("Unknown source type");
      const ctx = ctxOf(c);
      if (type === "DOCUMENT") {
        D.requirePermission(ctx, "view_documents");
        const d = await ctx.db.sourceDocument.findFirst({ where: { id: c.params.sid, patientId: ctx.patientId } });
        if (!d) throw D.notFound("Document not found");
        return { sourceType: type, id: d.id, title: `${d.title} (v${d.versionNumber})`, text: d.rawText, at: d.createdAt, span: c.query.start !== undefined ? { start: c.query.start, end: c.query.end ?? c.query.start } : null };
      }
      const m = await D.getMessage(ctx, c.params.sid);
      return { sourceType: type, id: m.id, title: `Message from ${m.senderName} (${m.channel.replace(/_/g, " ").toLowerCase()})`, text: m.text, at: m.sentAt, span: c.query.start !== undefined ? { start: c.query.start, end: c.query.end ?? c.query.start } : null };
    },
  }),

  // ------------------------------------------------------------ messages (simulated)
  route({ method: "GET", path: "/patients/:pid/messages", auth: "session", handler: async (c) => ({ messages: await D.listMessages(ctxOf(c)) }) }),
  route({
    method: "POST", path: "/patients/:pid/messages", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ text: z.string().min(1).max(4000), channel: z.enum(["WHATSAPP_SIMULATED", "SMS_SIMULATED", "EMAIL_SIMULATED", "IN_APP"]).default("WHATSAPP_SIMULATED"), authorise: z.boolean().default(true), extract: z.boolean().default(true) }),
    handler: async (c) => {
      const ctx = ctxOf(c);
      const msg = await D.postMessage(ctx, c.body);
      const intake = c.body.authorise && c.body.extract ? await withAgentSession(c.user!.id, ctx.patientId, "intake", (s) => runIntakeAgent(s, { patientId: ctx.patientId, messageId: msg.id })) : null;
      return { message: msg, intake };
    },
  }),
  route({ method: "POST", path: "/patients/:pid/messages/import", auth: "session", mutate: true, body: z.object({ fileText: z.string().min(1).max(2_000_000), authorise: z.boolean() }), handler: async (c) => D.importWhatsApp(ctxOf(c), c.body) }),
  route({ method: "POST", path: "/patients/:pid/messages/:mid/authorise", auth: "session", mutate: true, handler: async (c) => D.authoriseMessage(ctxOf(c), c.params.mid) }),
  route({
    method: "POST", path: "/patients/:pid/messages/:mid/extract", auth: "session", mutate: true, sweepAfter: true,
    handler: async (c) => {
      const ctx = ctxOf(c);
      return withAgentSession(c.user!.id, ctx.patientId, "intake", (s) => runIntakeAgent(s, { patientId: ctx.patientId, messageId: c.params.mid }));
    },
  }),

  // ------------------------------------------------------------ handovers
  route({ method: "GET", path: "/patients/:pid/handovers", auth: "session", handler: async (c) => ({ handovers: await D.listHandovers(ctxOf(c)) }) }),
  route({ method: "GET", path: "/patients/:pid/handovers/:hid", auth: "session", handler: async (c) => D.getHandover(ctxOf(c), c.params.hid) }),
  route({
    method: "POST", path: "/patients/:pid/handovers", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ toMemberId: uuid, shiftStart: dt.optional(), shiftEnd: dt.optional() }),
    handler: async (c) => {
      const ctx = ctxOf(c);
      D.requirePermission(ctx, "record_care");
      const r = await withAgentSession(c.user!.id, ctx.patientId, "handover", (s) => runHandoverAgent(s, deps().provider, { patientId: ctx.patientId, ...c.body }));
      // The outgoing caregiver saves the agent's draft summary (validated again server-side).
      const saved = await D.setHandoverSummary(ctx, r.handoverId, r.summary);
      return { handoverId: r.handoverId, summary: saved.handover.summary, dropped: [...r.dropped, ...saved.dropped], needsManualReview: r.needsManualReview, toolCalls: r.toolCalls.map(({ tool, ok, durationMs }) => ({ tool, ok, durationMs })) };
    },
  }),
  route({ method: "PATCH", path: "/patients/:pid/handovers/:hid", auth: "session", mutate: true, body: z.object({ observations: z.string().max(4000), version: z.number().int().optional() }), handler: async (c) => D.updateHandoverObservations(ctxOf(c), c.params.hid, c.body.observations, c.body.version) }),
  route({ method: "POST", path: "/patients/:pid/handovers/:hid/send", auth: "session", mutate: true, sweepAfter: true, body: z.object({ version: z.number().int().optional() }), handler: async (c) => D.sendHandover(ctxOf(c), c.params.hid, c.body.version) }),
  route({ method: "POST", path: "/patients/:pid/handovers/:hid/acknowledge", auth: "session", mutate: true, sweepAfter: true, body: z.object({ version: z.number().int().optional() }), handler: async (c) => D.acknowledgeHandover(ctxOf(c), c.params.hid, c.body.version) }),
  route({
    method: "GET", path: "/patients/:pid/handovers/:hid/audio", auth: "session",
    handler: async (c) => {
      if (!voiceEnabled()) throw D.notFound("Voice is not configured");
      const h = await D.getHandover(ctxOf(c), c.params.hid);
      const summary = (h.summary as { sentences?: { text: string }[] } | null)?.sentences ?? [];
      const snap = D.HandoverSnapshotZ.parse(h.snapshot);
      const text = [`Handover from ${h.fromName} to ${h.toName}.`, ...(summary.length ? summary.map((s) => s.text) : D.SNAPSHOT_SECTIONS.flatMap(([k, label]) => (snap[k].length ? [`${label}: ${snap[k].slice(0, 3).map((i) => i.text).join("; ")}.`] : []))), h.observations ? `Observations: ${h.observations}` : "", "Reading this handover does not accept any task."].filter(Boolean).join(" ");
      const audio = await cachedSpeech(`handover-${h.id}-v${h.version}`, text);
      return new Response(Buffer.from(audio), { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" } });
    },
  }),
  route({
    method: "GET", path: "/patients/:pid/alerts/:aid/audio", auth: "session",
    handler: async (c) => {
      if (!voiceEnabled()) throw D.notFound("Voice is not configured");
      const a = await D.getAlert(ctxOf(c), c.params.aid);
      const audio = await cachedSpeech(`alert-${a.id}-v${a.version}`, `CareRelay coordination alert. ${a.title}. ${a.explanation} Please open CareRelay to respond.`);
      return new Response(Buffer.from(audio), { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" } });
    },
  }),

  // ------------------------------------------------------------ inventory
  route({ method: "GET", path: "/patients/:pid/inventory", auth: "session", handler: async (c) => ({ items: await D.getInventory(ctxOf(c)) }) }),
  route({ method: "POST", path: "/patients/:pid/inventory/:mid/verify-stock", auth: "session", mutate: true, sweepAfter: true, body: z.object({ count: z.number().min(0).max(100_000), version: z.number().int().optional() }), handler: async (c) => D.verifyStock(ctxOf(c), c.params.mid, c.body.count, c.body.version) }),
  route({ method: "POST", path: "/patients/:pid/inventory/:mid/replenishments", auth: "session", mutate: true, sweepAfter: true, body: z.object({ assigneeMemberId: uuid.nullable().optional(), dueBy: dt, note: z.string().max(500).optional() }), handler: async (c) => D.createReplenishment(ctxOf(c), c.params.mid, { ...c.body, dueBy: new Date(c.body.dueBy) }) }),
  route({ method: "POST", path: "/patients/:pid/replenishments/:rid/transition", auth: "session", mutate: true, sweepAfter: true, body: z.object({ event: z.enum(["ACKNOWLEDGE", "COMPLETE", "CANCEL"]), version: z.number().int().optional(), confirmedQuantity: z.number().positive().optional() }), handler: async (c) => D.transitionReplenishment(ctxOf(c), c.params.rid, c.body) }),

  // ------------------------------------------------------------ timeline, circle, approvals
  route({ method: "GET", path: "/patients/:pid/timeline", auth: "session", query: z.object({ kind: z.string().optional() }), handler: async (c) => ({ entries: await D.getTimeline(ctxOf(c), { kind: c.query.kind }) }) }),
  route({ method: "GET", path: "/patients/:pid/members", auth: "session", handler: async (c) => ({ members: await D.listMembers(ctxOf(c)), me: ctxOf(c).member?.id ?? null }) }),
  route({ method: "POST", path: "/patients/:pid/members", auth: "session", mutate: true, body: z.object({ email: z.string().email(), name: z.string().min(2).max(100), role: z.enum(D.ROLES), qualifications: z.array(z.string().max(40)).max(10).default([]), relationship: z.string().max(100).optional() }), handler: async (c) => D.requestMemberChange(ctxOf(c), "ADD_MEMBER", c.body) }),
  route({ method: "POST", path: "/patients/:pid/members/:mid/role", auth: "session", mutate: true, body: z.object({ role: z.enum(D.ROLES) }), handler: async (c) => D.requestMemberChange(ctxOf(c), "CHANGE_MEMBER_ROLE", { memberId: c.params.mid, role: c.body.role }) }),
  route({ method: "POST", path: "/patients/:pid/members/:mid/remove", auth: "session", mutate: true, handler: async (c) => D.requestMemberChange(ctxOf(c), "REMOVE_MEMBER", { memberId: c.params.mid }) }),
  route({ method: "POST", path: "/patients/:pid/members/:mid/grant-messages", auth: "session", mutate: true, handler: async (c) => D.requestMemberChange(ctxOf(c), "GRANT_MESSAGE_ACCESS", { memberId: c.params.mid }) }),
  route({ method: "POST", path: "/patients/:pid/availability", auth: "session", mutate: true, sweepAfter: true, body: z.object({ memberId: uuid, type: z.enum(["UNAVAILABLE", "WORKING_HOURS"]), start: dt, end: dt, note: z.string().max(300).default("") }), handler: async (c) => D.addAvailability(ctxOf(c), { ...c.body, start: new Date(c.body.start), end: new Date(c.body.end) }) }),
  route({ method: "DELETE", path: "/patients/:pid/availability/:avid", auth: "session", mutate: true, sweepAfter: true, handler: async (c) => D.deleteAvailability(ctxOf(c), c.params.avid) }),
  route({ method: "GET", path: "/patients/:pid/escalation-policies", auth: "session", handler: async (c) => ({ policies: await D.listEscalationPolicies(ctxOf(c)) }) }),
  route({ method: "PUT", path: "/patients/:pid/escalation-policies/:epid", auth: "session", mutate: true, body: z.object({ steps: D.EscalationStepsZ, version: z.number().int().optional() }), handler: async (c) => D.updateEscalationPolicy(ctxOf(c), c.params.epid, c.body.steps, c.body.version) }),
  route({ method: "GET", path: "/patients/:pid/approvals", auth: "session", query: z.object({ state: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]).optional() }), handler: async (c) => ({ approvals: await D.listApprovals(ctxOf(c), c.query.state) }) }),
  route({
    method: "POST", path: "/patients/:pid/approvals/:apid/decide", auth: "session", mutate: true, sweepAfter: true,
    body: z.object({ decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().max(1000).nullable().optional(), version: z.number().int().optional() }),
    handler: async (c) => D.decideApproval({ ...ctxOf(c), db: deps().db }, c.params.apid, c.body),
  }),

  // ------------------------------------------------------------ assistant, MCP activity, notifications
  route({
    method: "POST", path: "/patients/:pid/assistant", auth: "session",
    body: z.object({ question: z.string().min(2).max(1000) }),
    handler: async (c) => {
      const ctx = ctxOf(c);
      D.requirePermission(ctx, "use_assistant");
      const answer = await withAgentSession(c.user!.id, ctx.patientId, "care-assistant", (s) => runCareAssistant(s, deps().provider, { patientId: ctx.patientId, question: c.body.question }));
      await D.ctxAudit(ctx, { action: "ai.assistant", details: { refused: answer.refused, tools: answer.toolCalls.map((t) => t.tool), provider: answer.provider } });
      return answer;
    },
  }),
  route({ method: "GET", path: "/patients/:pid/mcp-activity", auth: "session", query: z.object({ since: dt.optional() }), handler: async (c) => ({ calls: await D.getMcpActivity(ctxOf(c), c.query.since ? new Date(c.query.since) : undefined) }) }),
  route({ method: "GET", path: "/patients/:pid/notifications", auth: "session", handler: async (c) => ({ notifications: await D.listNotifications(ctxOf(c)) }) }),
  route({ method: "POST", path: "/patients/:pid/notifications/:nid/read", auth: "session", mutate: true, handler: async (c) => D.markNotificationRead(ctxOf(c), c.params.nid) }),
  route({ method: "POST", path: "/patients/:pid/observations", auth: "session", mutate: true, body: z.object({ text: z.string().min(2).max(2000), category: z.string().max(40).optional() }), handler: async (c) => D.recordObservation(ctxOf(c), c.body) }),
];
