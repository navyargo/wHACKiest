/**
 * Deterministic care-gap rules. Each rule is pure: RuleInput → Finding[].
 * The sweep (sweep.ts) loads the snapshot, runs these, and persists alerts/conflicts.
 */
import type { EvidenceRef, ResolutionOption } from "../schemas";
import { localTimeString, localDateString } from "../time";
import { projectInventory } from "../inventory";
import type { Finding, Level, RTask, Rule, RuleInput, RExtracted } from "./types";

const ACTIVE = new Set(["UNASSIGNED", "ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED", "IN_PROGRESS", "REASSIGNED", "ESCALATED", "OVERDUE"]);
const MIN = 60_000;

const name = (i: RuleInput, memberId: string | null | undefined) => i.members.find((m) => m.id === memberId)?.name ?? "Unknown";
const coordinators = (i: RuleInput) => i.members.filter((m) => m.canManage).map((m) => m.id);
const verifiers = (i: RuleInput) => i.members.filter((m) => m.canVerify).map((m) => m.id);
const uniq = (a: (string | null | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];
const t = (i: RuleInput, d: Date) => localTimeString(d, i.tz);
const rel = (i: RuleInput, d: Date) => {
  const m = Math.round((d.getTime() - i.now.getTime()) / MIN);
  if (Math.abs(m) < 1) return "now";
  const abs = Math.abs(m);
  const s = abs >= 120 ? `${Math.round(abs / 60)} h` : `${abs} min`;
  return m > 0 ? `in ${s}` : `${s} ago`;
};

function taskRef(i: RuleInput, task: RTask): EvidenceRef {
  return {
    sourceType: "TASK",
    sourceId: task.id,
    excerpt: `${task.title} — window ${t(i, task.windowStart)}–${t(i, task.windowEnd)} (${localDateString(task.windowStart, i.tz)}), state ${task.state.replace(/_/g, " ").toLowerCase()}${task.assigneeMemberId ? `, owner ${name(i, task.assigneeMemberId)}` : ", no owner"}`,
    recordedBy: null,
    timestamp: task.scheduledAt.toISOString(),
  };
}
function eventRef(task: RTask, ev: RTask["events"][number], excerpt: string): EvidenceRef {
  return { sourceType: "TASK_EVENT", sourceId: ev.id, excerpt, recordedBy: ev.actorName, timestamp: ev.createdAt.toISOString() };
}
function extractedRef(x: RExtracted): EvidenceRef {
  return {
    sourceType: "EXTRACTED_ITEM",
    sourceId: x.id,
    excerpt: x.excerpt,
    recordedBy: x.senderName || null,
    timestamp: x.sourceAt.toISOString(),
    span: x.span,
    parentSourceType: x.sourceType === "DOCUMENT" ? "DOCUMENT" : "MESSAGE",
    parentSourceId: x.sourceId,
  };
}
const ruleBasis = (ruleId: string, description: string) => ({ kind: "RULE" as const, ruleId, description });

// ------------------------------------------------------------------ GAP-001
export const GAP_001: Rule = {
  id: "GAP-001",
  description: "A high or critical priority task has no owner and its window opens within the look-ahead period.",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      if (!["HIGH", "CRITICAL"].includes(task.priority)) continue;
      if (task.assigneeMemberId || !["UNASSIGNED", "ESCALATED"].includes(task.state)) continue;
      if (task.windowEnd <= i.now) continue;
      const until = task.windowStart.getTime() - i.now.getTime();
      if (until > i.config.unassignedLookaheadMinutes * MIN) continue;
      const level: Level = until <= 0 ? "URGENT" : until <= 60 * MIN ? "HIGH" : "MEDIUM";
      const declined = [...task.events].reverse().find((e) => e.type === "DECLINE");
      const evidence = [taskRef(i, task)];
      if (declined) evidence.push(eventRef(task, declined, `${declined.actorName} said they can't do it: "${String(declined.payload.reason ?? "")}"`));
      out.push({
        ruleId: "GAP-001",
        dedupeKey: `GAP-001:${task.id}`,
        level,
        title: `Nobody owns "${task.title}"`,
        explanation: `This ${task.priority.toLowerCase()}-priority task's window opens ${rel(i, task.windowStart)} (${t(i, task.windowStart)}) and no one has been assigned or has claimed it. Everyone may be assuming someone else will do it.`,
        basis: ruleBasis("GAP-001", GAP_001.description),
        evidence,
        affectedTaskId: task.id,
        responders: uniq([...coordinators(i), ...i.members.filter((m) => m.canCare && (!task.requiredQualification || m.qualifications.includes(task.requiredQualification))).map((m) => m.id)]),
        resolutionOptions: [
          { action: "ASSIGN", label: "Assign someone", targetId: task.id },
          { action: "CLAIM", label: "I'll do it", targetId: task.id },
          { action: "COVERAGE_AGENT", label: "Suggest who is free", targetId: task.id },
        ],
        escalate: true,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ GAP-002
function lastAssignmentEvent(task: RTask) {
  return [...task.events].reverse().find((e) => e.type === "ASSIGN" || e.type === "REASSIGN" || e.type === "CLAIM");
}
/** Assigned to someone who has not accepted (also true while ESCALATED for that reason). */
function awaitingAck(task: RTask) {
  if (!task.assigneeMemberId) return false;
  if (task.state === "ASSIGNED" || task.state === "AWAITING_ACKNOWLEDGEMENT") return true;
  if (task.state !== "ESCALATED") return false;
  const last = lastAssignmentEvent(task);
  if (!last || last.type === "CLAIM") return false;
  return !task.events.some((e) => e.type === "ACKNOWLEDGE" && e.createdAt >= last.createdAt);
}
export const GAP_002: Rule = {
  id: "GAP-002",
  description: "A task is assigned but the assignee has not accepted it, and its window opens soon.",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      if (!awaitingAck(task)) continue;
      if (lastAssignmentEvent(task)?.type === "REASSIGN") continue; // GAP-004 covers transfers
      if (task.windowEnd <= i.now) continue;
      const until = task.windowStart.getTime() - i.now.getTime();
      if (until > i.config.unacknowledgedLookaheadMinutes * MIN) continue;
      const assign = lastAssignmentEvent(task);
      const evidence = [taskRef(i, task)];
      if (assign) evidence.push(eventRef(task, assign, `${assign.actorName} assigned this to ${name(i, task.assigneeMemberId)} — not yet accepted`));
      out.push({
        ruleId: "GAP-002",
        dedupeKey: `GAP-002:${task.id}:${task.assigneeMemberId}`,
        level: until <= 0 ? "HIGH" : "MEDIUM",
        title: `${name(i, task.assigneeMemberId)} hasn't accepted "${task.title}"`,
        explanation: `The task was assigned to ${name(i, task.assigneeMemberId)}, but being assigned is not the same as accepting. The window opens ${rel(i, task.windowStart)} and there is no acknowledgement yet.`,
        basis: ruleBasis("GAP-002", GAP_002.description),
        evidence,
        affectedTaskId: task.id,
        responders: uniq([task.assigneeMemberId, ...coordinators(i)]),
        resolutionOptions: [
          { action: "ACKNOWLEDGE_TASK", label: "Accept (assignee)", targetId: task.id },
          { action: "NUDGE_ASSIGNEE", label: "Request acceptance again", targetId: task.id },
          { action: "REASSIGN", label: "Reassign", targetId: task.id },
        ],
        escalate: true,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ GAP-003
export const GAP_003: Rule = {
  id: "GAP-003",
  description: "A task's window has passed with no completion record (silent failure).",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      if (!ACTIVE.has(task.state) || task.windowEnd > i.now) continue;
      out.push({
        ruleId: "GAP-003",
        dedupeKey: `GAP-003:${task.id}`,
        level: task.priority === "CRITICAL" || task.nonRepeatable ? "URGENT" : task.priority === "HIGH" ? "HIGH" : "MEDIUM",
        title: `No record that "${task.title}" happened`,
        explanation: `The window closed at ${t(i, task.windowEnd)} (${rel(i, task.windowEnd)}) and nobody has recorded it as done. ${task.assigneeMemberId ? `It was owned by ${name(i, task.assigneeMemberId)}.` : "It had no owner."} CareRelay doesn't know whether it happened — someone needs to find out and record what actually took place.`,
        basis: ruleBasis("GAP-003", GAP_003.description),
        evidence: [taskRef(i, task)],
        affectedTaskId: task.id,
        responders: uniq([task.assigneeMemberId, ...coordinators(i)]),
        resolutionOptions: [
          { action: "OPEN_TASK", label: "Record what happened", targetId: task.id },
          ...(task.assigneeMemberId ? [] : [{ action: "ASSIGN" as const, label: "Assign someone to follow up", targetId: task.id }]),
        ],
        taskAction: task.state !== "OVERDUE" && task.state !== "ESCALATED" ? { taskId: task.id, event: "MARK_OVERDUE" } : undefined,
        escalate: true,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ GAP-004
export const GAP_004: Rule = {
  id: "GAP-004",
  description: "A responsibility was transferred or handed off, but nobody has accepted it.",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      if (!awaitingAck(task) || task.windowEnd <= i.now) continue;
      const last = lastAssignmentEvent(task);
      if (last?.type !== "REASSIGN") continue;
      const since = i.now.getTime() - last.createdAt.getTime();
      const until = task.windowStart.getTime() - i.now.getTime();
      if (since < i.config.reassignAcceptMinutes * MIN && until > i.config.unacknowledgedLookaheadMinutes * MIN) continue;
      out.push({
        ruleId: "GAP-004",
        dedupeKey: `GAP-004:${task.id}:${task.assigneeMemberId}`,
        level: until <= 0 ? "URGENT" : until <= 60 * MIN ? "HIGH" : "MEDIUM",
        title: `Transfer of "${task.title}" not accepted`,
        explanation: `${last.actorName} transferred this task to ${name(i, task.assigneeMemberId)} ${rel(i, last.createdAt)}. Until ${name(i, task.assigneeMemberId)} accepts, nobody is covering it.`,
        basis: ruleBasis("GAP-004", GAP_004.description),
        evidence: [taskRef(i, task), eventRef(task, last, `Reassigned to ${name(i, task.assigneeMemberId)}${last.payload.reason ? `: "${String(last.payload.reason)}"` : ""}`)],
        affectedTaskId: task.id,
        responders: uniq([task.assigneeMemberId, ...coordinators(i)]),
        resolutionOptions: [
          { action: "ACKNOWLEDGE_TASK", label: "Accept (new assignee)", targetId: task.id },
          { action: "NUDGE_ASSIGNEE", label: "Request acceptance again", targetId: task.id },
          { action: "REASSIGN", label: "Reassign to someone else", targetId: task.id },
        ],
        escalate: true,
      });
    }
    // AI semantic layer: "X will handle it" with no confirmation from X.
    for (const x of i.extracted) {
      if (x.itemType !== "COMMITMENT" || (x.status !== "PROPOSED" && x.status !== "AWAITING_VERIFICATION")) continue;
      const p = x.payload as { isHandoff?: boolean; committedMemberId?: string | null; committedName?: string; text?: string; linkedTaskId?: string | null };
      if (!p.isHandoff) continue;
      const linked = p.linkedTaskId ? i.tasks.find((tk) => tk.id === p.linkedTaskId) : undefined;
      if (linked && (!ACTIVE.has(linked.state) || (linked.assigneeMemberId === p.committedMemberId && linked.state !== "AWAITING_ACKNOWLEDGEMENT"))) continue;
      const confident = x.confidence >= i.config.aiAlertConfidence;
      out.push({
        ruleId: "GAP-004",
        dedupeKey: `GAP-004:handoff:${x.id}`,
        level: confident ? "MEDIUM" : "INFORMATIONAL",
        title: confident ? `Unconfirmed hand-off to ${p.committedName || "someone"}` : `Possible hand-off — needs review`,
        explanation: `${x.senderName || "Someone"} wrote that ${p.committedName || "another person"} will handle this, but ${p.committedName || "they"} hasn't confirmed in CareRelay. A hand-off only counts once the person accepts it.`,
        basis: { kind: "AI", ruleId: "GAP-004", description: "AI semantic analysis of a message detected a hand-off with no acknowledgement from the person named.", confidence: x.confidence, provider: x.detectedBy },
        evidence: [extractedRef(x), ...(linked ? [taskRef(i, linked)] : [])],
        affectedTaskId: linked?.id,
        responders: uniq([p.committedMemberId, x.senderMemberId, ...coordinators(i)]),
        resolutionOptions: [
          { action: "CONFIRM_ITEM", label: `Confirm (${p.committedName || "named person"})`, targetId: x.id },
          { action: "REJECT_ITEM", label: "Not a hand-off / dismiss", targetId: x.id },
          ...(linked ? [{ action: "OPEN_TASK" as const, label: "Open task", targetId: linked.id }] : []),
        ],
        escalate: false,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ GAP-005
export const GAP_005: Rule = {
  id: "GAP-005",
  description: "The assignee has declared unavailability or a calendar busy block that overlaps the task window.",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      if (!task.assigneeMemberId || !ACTIVE.has(task.state) || task.state === "OVERDUE" || task.windowEnd <= i.now) continue;
      const clash = i.availability.find(
        (a) => a.memberId === task.assigneeMemberId && (a.type === "UNAVAILABLE" || a.type === "CALENDAR_BUSY") && a.start < task.windowEnd && a.end > task.windowStart,
      );
      if (!clash) continue;
      const until = task.windowStart.getTime() - i.now.getTime();
      out.push({
        ruleId: "GAP-005",
        dedupeKey: `GAP-005:${task.id}:${clash.id}`,
        level: until <= 180 * MIN ? "HIGH" : "MEDIUM",
        title: `${name(i, task.assigneeMemberId)} is unavailable for "${task.title}"`,
        explanation: `${name(i, task.assigneeMemberId)} is ${clash.type === "UNAVAILABLE" ? "marked unavailable" : "busy (calendar)"} ${t(i, clash.start)}–${t(i, clash.end)}, which overlaps this task's window ${t(i, task.windowStart)}–${t(i, task.windowEnd)}.${task.requiredQualification ? ` A replacement needs the ${task.requiredQualification} qualification.` : ""}`,
        basis: ruleBasis("GAP-005", GAP_005.description),
        evidence: [
          taskRef(i, task),
          { sourceType: "AVAILABILITY", sourceId: clash.id, excerpt: `${clash.type === "UNAVAILABLE" ? "Unavailable" : "Busy"} ${t(i, clash.start)}–${t(i, clash.end)}${clash.note ? `: "${clash.note}"` : ""} (${clash.source === "CALENDAR_SIMULATED" ? "simulated calendar" : "declared in CareRelay"})`, recordedBy: name(i, clash.memberId), timestamp: clash.start.toISOString() },
        ],
        affectedTaskId: task.id,
        responders: uniq([...coordinators(i), task.assigneeMemberId]),
        resolutionOptions: [
          { action: "COVERAGE_AGENT", label: "Suggest who is free", targetId: task.id },
          { action: "REASSIGN", label: "Reassign", targetId: task.id },
        ],
        escalate: true,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ DUP-001
export const DUP_001: Rule = {
  id: "DUP-001",
  description: "A second administration was recorded for the same medication occurrence.",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      const recorded = task.administrations.find((a) => a.status === "RECORDED");
      const disputed = task.administrations.filter((a) => a.status === "DISPUTED");
      if (!recorded || disputed.length === 0) continue;
      const evidence: EvidenceRef[] = [recorded, ...disputed].map((a) => ({
        sourceType: "ADMINISTRATION",
        sourceId: a.id,
        excerpt: `${name(i, a.recordedByMemberId)} recorded giving "${task.title}" at ${t(i, a.administeredAt)}${a.note ? ` — "${a.note}"` : ""}${a.status === "DISPUTED" ? " (second record)" : " (first record)"}`,
        recordedBy: name(i, a.recordedByMemberId),
        timestamp: a.administeredAt.toISOString(),
      }));
      const latest = new Date(Math.max(...disputed.map((d) => d.administeredAt.getTime()), recorded.administeredAt.getTime()));
      const conflictKey = `DUP-001:${task.id}`;
      out.push({
        ruleId: "DUP-001",
        dedupeKey: conflictKey,
        level: "URGENT",
        title: `Two records of giving "${task.title}"`,
        explanation: `${uniq([recorded, ...disputed].map((a) => name(i, a.recordedByMemberId))).join(" and ")} each recorded this occurrence. CareRelay can't tell what actually happened and does not advise on dosing. An authorised person (doctor / care lead) needs to verify.`,
        basis: ruleBasis("DUP-001", DUP_001.description),
        evidence,
        affectedTaskId: task.id,
        responders: uniq([...verifiers(i), ...coordinators(i), ...[recorded, ...disputed].map((a) => a.recordedByMemberId)]),
        resolutionOptions: [
          { action: "RESOLVE_CONFLICT", label: "Record verified outcome", targetId: conflictKey },
          { action: "OPEN_TASK", label: "Open task", targetId: task.id },
        ],
        taskAction: task.state !== "CONFLICTING" ? { taskId: task.id, event: "FLAG_CONFLICT" } : undefined,
        conflict: { kind: "DUPLICATE_ADMINISTRATION", title: `Duplicate administration: ${task.title}`, dedupeKey: conflictKey, clinicallySignificant: true, subjectRefs: { taskId: task.id, medicationId: task.medicationId }, evidence, latestEvidenceAt: latest },
        escalate: true,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ CON-001
interface Claim { claim: "DONE" | "NOT_DONE"; at: Date; ref: EvidenceRef; ai?: { confidence: number; provider: string } }
export const CON_001: Rule = {
  id: "CON-001",
  description: "Contradictory reports for the same task: one says it was done, a later one says it is still pending.",
  run(i) {
    const out: Finding[] = [];
    for (const task of i.tasks) {
      const claims: Claim[] = [];
      for (const a of task.administrations.filter((x) => x.status === "RECORDED")) {
        claims.push({ claim: "DONE", at: a.administeredAt, ref: { sourceType: "ADMINISTRATION", sourceId: a.id, excerpt: `${name(i, a.recordedByMemberId)} recorded it as given at ${t(i, a.administeredAt)}`, recordedBy: name(i, a.recordedByMemberId), timestamp: a.administeredAt.toISOString() } });
      }
      if (task.completedAt && !task.nonRepeatable) {
        const ev = [...task.events].reverse().find((e) => e.type === "COMPLETE");
        if (ev) claims.push({ claim: "DONE", at: ev.createdAt, ref: eventRef(task, ev, `${ev.actorName} marked it completed`) });
      }
      for (const ev of task.events.filter((e) => e.type === "STATUS_REPORT")) {
        const c = ev.payload.claim === "NOT_DONE" ? "NOT_DONE" : "DONE";
        claims.push({ claim: c, at: ev.createdAt, ref: eventRef(task, ev, `${ev.actorName} reported: ${c === "DONE" ? "done" : "not done"}${ev.payload.note ? ` — "${String(ev.payload.note)}"` : ""}`) });
      }
      for (const x of i.extracted) {
        if (x.itemType !== "COMPLETION_REPORT" || x.status === "REJECTED") continue;
        const p = x.payload as { claim?: string; linkedTaskId?: string | null };
        if (p.linkedTaskId !== task.id) continue;
        claims.push({ claim: p.claim === "NOT_DONE" ? "NOT_DONE" : "DONE", at: x.sourceAt, ref: extractedRef(x), ai: { confidence: x.confidence, provider: x.detectedBy } });
      }
      const dones = claims.filter((c) => c.claim === "DONE");
      const notDones = claims.filter((c) => c.claim === "NOT_DONE");
      const pairs = notDones.filter((n) => dones.some((d) => d.at <= n.at));
      if (pairs.length === 0) continue;
      const firstDone = dones.filter((d) => d.at <= pairs[0].at).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
      const involved = [firstDone, ...pairs];
      const aiOnly = involved.every((c) => c.ai);
      const minConf = Math.min(...involved.filter((c) => c.ai).map((c) => c.ai!.confidence), 1);
      if (aiOnly && minConf < i.config.aiAlertConfidence) {
        out.push({
          ruleId: "CON-001",
          dedupeKey: `CON-001:review:${task.id}`,
          level: "INFORMATIONAL",
          title: `Possible contradiction on "${task.title}" — needs review`,
          explanation: "AI analysis found messages that may disagree about whether this was done, but with low confidence. Please review the messages.",
          basis: { kind: "AI", ruleId: "CON-001", description: CON_001.description, confidence: minConf, provider: involved.find((c) => c.ai)!.ai!.provider },
          evidence: involved.map((c) => c.ref),
          affectedTaskId: task.id,
          responders: coordinators(i),
          resolutionOptions: [{ action: "OPEN_TASK", label: "Review task", targetId: task.id }],
          escalate: false,
        });
        continue;
      }
      const usesAi = involved.some((c) => c.ai);
      const key = `CON-001:${task.id}`;
      const evidence = involved.map((c) => c.ref);
      out.push({
        ruleId: "CON-001",
        dedupeKey: key,
        level: task.nonRepeatable ? "URGENT" : "HIGH",
        title: `Conflicting reports on "${task.title}"`,
        explanation: `One report says this was done; a later report says it hasn't happened. CareRelay can't tell which is right. Someone needs to check and record what actually happened.`,
        basis: usesAi
          ? { kind: "AI", ruleId: "CON-001", description: `${CON_001.description} (message interpreted by AI semantic analysis)`, confidence: minConf, provider: involved.find((c) => c.ai)!.ai!.provider }
          : ruleBasis("CON-001", CON_001.description),
        evidence,
        affectedTaskId: task.id,
        responders: uniq([...coordinators(i), ...(task.nonRepeatable ? verifiers(i) : []), task.assigneeMemberId]),
        resolutionOptions: [
          { action: "RESOLVE_CONFLICT", label: "Record verified outcome", targetId: key },
          { action: "OPEN_TASK", label: "See both reports", targetId: task.id },
        ],
        taskAction: task.state !== "CONFLICTING" ? { taskId: task.id, event: "FLAG_CONFLICT" } : undefined,
        conflict: { kind: "CONTRADICTORY_REPORT", title: `Contradictory reports: ${task.title}`, dedupeKey: key, clinicallySignificant: task.nonRepeatable, subjectRefs: { taskId: task.id }, evidence, latestEvidenceAt: new Date(Math.max(...involved.map((c) => c.at.getTime()))) },
        escalate: true,
      });
    }
    return out;
  },
};

// ------------------------------------------------------------------ CON-002
export const CON_002: Rule = {
  id: "CON-002",
  description: "A new version of a prescription/instruction document differs from the active instructions (field-by-field diff).",
  run(i) {
    return i.pendingVersions
      .filter((v) => v.diff.some((d) => d.change !== "UNCHANGED"))
      .map((v) => {
        const changes = v.diff.filter((d) => d.change !== "UNCHANGED");
        const key = `CON-002:${v.documentId}`;
        const evidence: EvidenceRef[] = [
          { sourceType: "DOCUMENT", sourceId: v.documentId, excerpt: `${v.documentTitle} (version ${v.versionNumber}) uploaded by ${v.uploadedByName}`, recordedBy: v.uploadedByName, timestamp: v.createdAt.toISOString() },
          ...changes.map<EvidenceRef>((c) => ({
            sourceType: "EXTRACTED_ITEM",
            sourceId: c.newRefId ?? c.oldRefId ?? v.documentId,
            excerpt: `${c.change === "ADDED" ? "Added" : c.change === "REMOVED" ? "No longer listed" : "Changed"}: ${c.medication}${c.fields.length && c.change === "CHANGED" ? ` — ${c.fields.map((f) => `${f.field}: "${f.old}" → "${f.new}"`).join("; ")}` : ""}`,
            recordedBy: v.uploadedByName,
            timestamp: v.createdAt.toISOString(),
            parentSourceType: "DOCUMENT",
            parentSourceId: v.documentId,
          })),
        ];
        return {
          ruleId: "CON-002",
          dedupeKey: key,
          level: "HIGH" as Level,
          title: `New version of "${v.documentTitle}" differs from active instructions`,
          explanation: `${changes.length} instruction change(s) found. CareRelay keeps following the currently approved instructions and does not decide which version is correct. An authorised clinical verifier must review and approve or reject the new version.`,
          basis: ruleBasis("CON-002", CON_002.description),
          evidence,
          responders: verifiers(i),
          resolutionOptions: [
            { action: "OPEN_DOCUMENT", label: "Review the diff", targetId: v.documentId },
            { action: "OPEN_APPROVAL", label: "Open approval", targetId: v.approvalId },
          ],
          conflict: { kind: "INSTRUCTION_VERSION" as const, title: `Instruction version change: ${v.documentTitle} v${v.versionNumber}`, dedupeKey: key, clinicallySignificant: true, subjectRefs: { documentId: v.documentId, approvalId: v.approvalId, diff: v.diff as unknown as Record<string, unknown>[] }, evidence, latestEvidenceAt: v.createdAt },
          escalate: false,
        };
      });
  },
};

// ------------------------------------------------------------------ CON-003
export const CON_003: Rule = {
  id: "CON-003",
  description: "An appointment is scheduled in CareRelay but another source says it was cancelled or moved.",
  run(i) {
    const out: Finding[] = [];
    for (const x of i.extracted) {
      if (x.itemType !== "SCHEDULE_CHANGE" || x.status === "REJECTED") continue;
      const p = x.payload as { status?: string; date?: string | null; newDate?: string | null; text?: string };
      if (p.status !== "CANCELLED" && p.status !== "RESCHEDULED") continue;
      const appts = i.tasks.filter((tk) => tk.category === "APPOINTMENT" && ACTIVE.has(tk.state) && (!p.date || localDateString(tk.scheduledAt, i.tz) === p.date));
      for (const appt of appts) {
        if (x.confidence < i.config.aiAlertConfidence) continue;
        const key = `CON-003:${appt.id}`;
        const evidence = [taskRef(i, appt), extractedRef(x)];
        out.push({
          ruleId: "CON-003",
          dedupeKey: key,
          level: appt.windowStart.getTime() - i.now.getTime() < 24 * 60 * MIN ? "HIGH" : "MEDIUM",
          title: `Is "${appt.title}" still on?`,
          explanation: `CareRelay has this appointment scheduled for ${localDateString(appt.scheduledAt, i.tz)} ${t(i, appt.scheduledAt)}, but a message says it was ${p.status === "CANCELLED" ? "cancelled" : "moved"}. Someone needs to confirm with the clinic.`,
          basis: { kind: "AI", ruleId: "CON-003", description: `${CON_003.description} (message interpreted by AI semantic analysis; the comparison itself is a deterministic rule)`, confidence: x.confidence, provider: x.detectedBy },
          evidence,
          affectedTaskId: appt.id,
          responders: coordinators(i),
          resolutionOptions: [
            { action: "RESOLVE_CONFLICT", label: "Record confirmed status", targetId: key },
            { action: "OPEN_TASK", label: "Open appointment", targetId: appt.id },
          ],
          conflict: { kind: "APPOINTMENT_STATUS", title: `Appointment status unclear: ${appt.title}`, dedupeKey: key, clinicallySignificant: false, subjectRefs: { taskId: appt.id, extractedItemId: x.id }, evidence, latestEvidenceAt: x.sourceAt },
          escalate: false,
        });
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------ HND-001
export const HND_001: Rule = {
  id: "HND-001",
  description: "A shift ended without a handover, or a sent handover was not acknowledged in time.",
  run(i) {
    const out: Finding[] = [];
    const shifts = i.availability.filter((a) => a.type === "WORKING_HOURS");
    for (const s of shifts) {
      if (s.end > i.now || i.now.getTime() - s.end.getTime() > i.config.handoverLookbackHours * 60 * MIN) continue;
      const incoming = shifts.find((n) => n.memberId !== s.memberId && Math.abs(n.start.getTime() - s.end.getTime()) <= 60 * MIN);
      if (!incoming) continue;
      const h = i.handovers.find((hv) => hv.fromMemberId === s.memberId && Math.abs(hv.shiftEnd.getTime() - s.end.getTime()) <= 90 * MIN && hv.state !== "DRAFT");
      const shiftRef: EvidenceRef = { sourceType: "AVAILABILITY", sourceId: s.id, excerpt: `${name(i, s.memberId)}'s shift ended at ${t(i, s.end)}; ${name(i, incoming.memberId)}'s shift started at ${t(i, incoming.start)}`, recordedBy: name(i, s.memberId), timestamp: s.end.toISOString() };
      if (!h) {
        if (i.now.getTime() - s.end.getTime() < i.config.handoverGraceMinutes * MIN) continue;
        out.push({
          ruleId: "HND-001",
          dedupeKey: `HND-001:missing:${s.memberId}:${s.end.toISOString()}`,
          level: i.now.getTime() - s.end.getTime() > 60 * MIN ? "HIGH" : "MEDIUM",
          title: `No handover from ${name(i, s.memberId)} to ${name(i, incoming.memberId)}`,
          explanation: `${name(i, s.memberId)}'s shift ended ${rel(i, s.end)} and no handover was sent. ${name(i, incoming.memberId)} may not know what is pending, what was given, or what was observed.`,
          basis: ruleBasis("HND-001", HND_001.description),
          evidence: [shiftRef],
          responders: uniq([s.memberId, incoming.memberId, ...coordinators(i)]),
          resolutionOptions: [{ action: "CREATE_HANDOVER", label: "Write the handover", targetId: incoming.memberId }],
          escalate: true,
        });
      } else if (h.state === "SENT" && h.sentAt && i.now.getTime() - h.sentAt.getTime() >= i.config.handoverAckMinutes * MIN) {
        out.push({
          ruleId: "HND-001",
          dedupeKey: `HND-001:unack:${h.id}`,
          level: "MEDIUM",
          title: `${name(i, h.toMemberId)} hasn't read the handover`,
          explanation: `${name(i, h.fromMemberId)} sent a handover ${rel(i, h.sentAt)}, but ${name(i, h.toMemberId)} hasn't confirmed reading it.`,
          basis: ruleBasis("HND-001", HND_001.description),
          evidence: [shiftRef, { sourceType: "HANDOVER", sourceId: h.id, excerpt: `Handover sent at ${t(i, h.sentAt)} — not acknowledged`, recordedBy: name(i, h.fromMemberId), timestamp: h.sentAt.toISOString() }],
          responders: uniq([h.toMemberId, ...coordinators(i)]),
          resolutionOptions: [{ action: "OPEN_HANDOVER", label: "Open handover", targetId: h.id }],
          escalate: true,
        });
      }
    }
    return out;
  },
};

// ------------------------------------------------------------------ INV-001 / INV-002
function projections(i: RuleInput) {
  return i.medications.map((m) => ({ m, p: projectInventory({ ...m, now: i.now, freshDays: i.config.stockFreshDays }) }));
}
const medRef = (i: RuleInput, m: RuleInput["medications"][number], label: string): EvidenceRef => ({
  sourceType: "MEDICATION",
  sourceId: m.id,
  excerpt: `${m.name}: ${m.currentStock} ${m.form}(s) at last count${m.stockVerifiedAt ? ` (${localDateString(m.stockVerifiedAt, i.tz)})` : " (never counted)"}, ${m.recordedSinceVerification} administration(s) recorded since; ${m.scheduledPerDay}×/day scheduled. Projection: ${label}`,
  recordedBy: null,
  timestamp: (m.stockVerifiedAt ?? i.now).toISOString(),
});

export const INV_001: Rule = {
  id: "INV-001",
  description: "Projected days of supply are below the reorder threshold and no one has accepted ownership of replenishment.",
  run(i) {
    const out: Finding[] = [];
    for (const { m, p } of projections(i)) {
      if (p.daysRemaining === null || p.daysRemaining >= m.reorderThresholdDays || p.remainingUnits <= 0) continue;
      const reqs = i.replenishments.filter((r) => r.medicationId === m.id && !["COMPLETED", "CANCELLED"].includes(r.state));
      if (reqs.some((r) => r.state === "ACKNOWLEDGED")) continue;
      const pending = reqs.find((r) => r.assigneeMemberId);
      const opts: ResolutionOption[] = pending ? [] : [{ action: "CREATE_REPLENISHMENT", label: "Take ownership of refill", targetId: m.id }];
      out.push({
        ruleId: "INV-001",
        dedupeKey: `INV-001:${m.id}`,
        level: p.daysRemaining < 1 ? "HIGH" : "MEDIUM",
        title: `${m.name} running low — no one owns the refill`,
        explanation: `About ${p.label} of supply left (threshold ${m.reorderThresholdDays} days). ${pending ? `A refill was assigned to ${name(i, pending.assigneeMemberId)} but not yet accepted.` : "Nobody has taken ownership of getting more."}${p.isEstimate ? ` This is an estimate: ${p.estimateReasons.join("; ")}.` : ""}`,
        basis: ruleBasis("INV-001", INV_001.description),
        evidence: [medRef(i, m, p.label)],
        responders: uniq([...coordinators(i), pending?.assigneeMemberId]),
        resolutionOptions: [...opts, { action: "VERIFY_STOCK", label: "Count and verify stock", targetId: m.id }],
        escalate: false,
      });
    }
    return out;
  },
};

export const INV_002: Rule = {
  id: "INV-002",
  description: "Recorded stock is at or below zero while administrations are still scheduled.",
  run(i) {
    return projections(i)
      .filter(({ m, p }) => p.remainingUnits <= 0 && m.scheduledPerDay > 0)
      .map(({ m, p }) => ({
        ruleId: "INV-002",
        dedupeKey: `INV-002:${m.id}`,
        level: "URGENT" as Level,
        title: `${m.name}: records show no stock left`,
        explanation: `Based on the last count and administrations recorded since, no ${m.form}s remain, but ${m.scheduledPerDay} administration(s) per day are still scheduled.${p.isEstimate ? ` Estimate — needs verification: ${p.estimateReasons.join("; ")}.` : ""} Someone needs to count the stock and arrange supply.`,
        basis: ruleBasis("INV-002", INV_002.description),
        evidence: [medRef(i, m, p.label)],
        responders: coordinators(i),
        resolutionOptions: [
          { action: "VERIFY_STOCK", label: "Count and verify stock", targetId: m.id },
          { action: "CREATE_REPLENISHMENT", label: "Take ownership of refill", targetId: m.id },
        ],
        escalate: true,
      }));
  },
};

export const RULES: Rule[] = [GAP_001, GAP_002, GAP_003, GAP_004, GAP_005, DUP_001, CON_001, CON_002, CON_003, HND_001, INV_001, INV_002];
export const RULE_IDS = RULES.map((r) => r.id);

export function runRules(input: RuleInput): Finding[] {
  return RULES.flatMap((r) => r.run(input));
}
