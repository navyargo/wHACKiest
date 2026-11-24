/**
 * Task state machine — the ONLY place task state transitions are defined.
 * Pure module: no DB, no clock. Every caller (REST API, MCP tools, scheduler)
 * goes through `planTransition`.
 */
import type { Permission } from "./authz";

export const TASK_STATES = [
  "PROPOSED",
  "AWAITING_VERIFICATION",
  "UNASSIGNED",
  "ASSIGNED",
  "AWAITING_ACKNOWLEDGEMENT",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "COMPLETED",
  "OVERDUE",
  "CONFLICTING",
  "ESCALATED",
  "REASSIGNED",
  "CANCELLED",
] as const;
export type TaskStateName = (typeof TASK_STATES)[number];

export const TASK_EVENTS = [
  "SUBMIT_FOR_VERIFICATION",
  "VERIFY",
  "ASSIGN",
  "NOTIFY",
  "ACKNOWLEDGE",
  "CLAIM",
  "DECLINE",
  "START",
  "COMPLETE",
  "MARK_OVERDUE",
  "FLAG_CONFLICT",
  "RESOLVE_CONFLICT",
  "ESCALATE",
  "REASSIGN",
  "REQUEST_ACCEPTANCE",
  "CANCEL",
  "SUPERSEDE",
] as const;
export type TaskEventName = (typeof TASK_EVENTS)[number];

/** Who may fire a transition. */
export type ActorRule =
  | { kind: "system" }
  | { kind: "permission"; permission: Permission }
  /** verify_medical for medical tasks, manage_tasks otherwise. */
  | { kind: "verifyByCategory" }
  | { kind: "assigneeOnly" }
  /** Assignee, or anyone with record_care who supplies a declaration. */
  | { kind: "assigneeOrDeclaration" }
  /** Anyone with record_care, declaration always required (task not yet accepted by them). */
  | { kind: "declarationRequired" }
  /** The actor assigns the task to themselves (needs record_care). */
  | { kind: "self" };

export type Guard =
  | "qualification" // target member must hold task.requiredQualification
  | "reasonRequired"
  | "noCurrentAssignee"
  | "differentAssignee"
  | "hasAssignee";

export interface Transition {
  from: TaskStateName;
  event: TaskEventName;
  to: TaskStateName;
  actor: ActorRule;
  guards: Guard[];
  description: string;
}

const ACTIVE_FOR_OVERDUE: TaskStateName[] = [
  "UNASSIGNED",
  "ASSIGNED",
  "AWAITING_ACKNOWLEDGEMENT",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "REASSIGNED",
];
const CONFLICTABLE: TaskStateName[] = [...ACTIVE_FOR_OVERDUE, "OVERDUE", "ESCALATED", "COMPLETED"];
const ESCALATABLE: TaskStateName[] = ["UNASSIGNED", "ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "OVERDUE", "REASSIGNED"];
const REASSIGNABLE: TaskStateName[] = ["ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED", "OVERDUE", "ESCALATED"];
const CANCELLABLE: TaskStateName[] = TASK_STATES.filter((s) => s !== "COMPLETED" && s !== "CANCELLED");
const SUPERSEDABLE: TaskStateName[] = ["PROPOSED", "AWAITING_VERIFICATION", "UNASSIGNED", "ASSIGNED", "AWAITING_ACKNOWLEDGEMENT", "ACKNOWLEDGED", "REASSIGNED"];
const CONFLICT_RESOLUTION_TARGETS: TaskStateName[] = ["COMPLETED", "ACKNOWLEDGED", "UNASSIGNED", "CANCELLED"];

const sys: ActorRule = { kind: "system" };
const perm = (permission: Permission): ActorRule => ({ kind: "permission", permission });

export const TRANSITIONS: Transition[] = [
  { from: "PROPOSED", event: "SUBMIT_FOR_VERIFICATION", to: "AWAITING_VERIFICATION", actor: sys, guards: [], description: "Proposed task queued for human verification" },
  { from: "AWAITING_VERIFICATION", event: "VERIFY", to: "UNASSIGNED", actor: { kind: "verifyByCategory" }, guards: [], description: "Verified by an authorised person; now needs an owner" },

  { from: "UNASSIGNED", event: "ASSIGN", to: "ASSIGNED", actor: perm("manage_tasks"), guards: ["qualification"], description: "Assigned (not yet accepted)" },
  { from: "OVERDUE", event: "ASSIGN", to: "ASSIGNED", actor: perm("manage_tasks"), guards: ["qualification", "noCurrentAssignee"], description: "Overdue uncovered task assigned" },
  { from: "ESCALATED", event: "ASSIGN", to: "ASSIGNED", actor: perm("manage_tasks"), guards: ["qualification", "noCurrentAssignee"], description: "Escalated uncovered task assigned" },
  { from: "ASSIGNED", event: "NOTIFY", to: "AWAITING_ACKNOWLEDGEMENT", actor: sys, guards: [], description: "Assignee notified; waiting for them to accept" },

  { from: "ASSIGNED", event: "ACKNOWLEDGE", to: "ACKNOWLEDGED", actor: { kind: "assigneeOnly" }, guards: [], description: "Assignee accepted the task" },
  { from: "AWAITING_ACKNOWLEDGEMENT", event: "ACKNOWLEDGE", to: "ACKNOWLEDGED", actor: { kind: "assigneeOnly" }, guards: [], description: "Assignee accepted the task" },
  { from: "ESCALATED", event: "ACKNOWLEDGE", to: "ACKNOWLEDGED", actor: { kind: "assigneeOnly" }, guards: ["hasAssignee"], description: "Assignee accepted after escalation" },

  { from: "UNASSIGNED", event: "CLAIM", to: "ACKNOWLEDGED", actor: { kind: "self" }, guards: ["qualification", "noCurrentAssignee"], description: "Caregiver took ownership (claiming is acceptance)" },
  { from: "OVERDUE", event: "CLAIM", to: "ACKNOWLEDGED", actor: { kind: "self" }, guards: ["qualification", "noCurrentAssignee"], description: "Caregiver took ownership of an overdue task" },
  { from: "ESCALATED", event: "CLAIM", to: "ACKNOWLEDGED", actor: { kind: "self" }, guards: ["qualification", "noCurrentAssignee"], description: "Caregiver took ownership of an escalated task" },

  { from: "ASSIGNED", event: "DECLINE", to: "UNASSIGNED", actor: { kind: "assigneeOnly" }, guards: ["reasonRequired"], description: "Assignee can't do it; task is uncovered again" },
  { from: "AWAITING_ACKNOWLEDGEMENT", event: "DECLINE", to: "UNASSIGNED", actor: { kind: "assigneeOnly" }, guards: ["reasonRequired"], description: "Assignee can't do it; task is uncovered again" },
  { from: "ACKNOWLEDGED", event: "DECLINE", to: "UNASSIGNED", actor: { kind: "assigneeOnly" }, guards: ["reasonRequired"], description: "Assignee can no longer do it; task is uncovered again" },

  { from: "ACKNOWLEDGED", event: "START", to: "IN_PROGRESS", actor: { kind: "assigneeOrDeclaration" }, guards: [], description: "Work started" },

  { from: "IN_PROGRESS", event: "COMPLETE", to: "COMPLETED", actor: { kind: "assigneeOrDeclaration" }, guards: [], description: "Completed" },
  { from: "ACKNOWLEDGED", event: "COMPLETE", to: "COMPLETED", actor: { kind: "assigneeOrDeclaration" }, guards: [], description: "Completed" },
  { from: "OVERDUE", event: "COMPLETE", to: "COMPLETED", actor: { kind: "assigneeOrDeclaration" }, guards: [], description: "Completed late (overdue alert stays in history)" },
  { from: "ESCALATED", event: "COMPLETE", to: "COMPLETED", actor: { kind: "assigneeOrDeclaration" }, guards: [], description: "Completed after escalation" },
  { from: "UNASSIGNED", event: "COMPLETE", to: "COMPLETED", actor: { kind: "declarationRequired" }, guards: [], description: "Completed by someone who declares they did it" },
  { from: "ASSIGNED", event: "COMPLETE", to: "COMPLETED", actor: { kind: "declarationRequired" }, guards: [], description: "Completed with a declaration" },
  { from: "AWAITING_ACKNOWLEDGEMENT", event: "COMPLETE", to: "COMPLETED", actor: { kind: "declarationRequired" }, guards: [], description: "Completed with a declaration" },

  ...ACTIVE_FOR_OVERDUE.map<Transition>((from) => ({ from, event: "MARK_OVERDUE", to: "OVERDUE", actor: sys, guards: [], description: "Window passed with no completion record (silent failure)" })),
  ...CONFLICTABLE.map<Transition>((from) => ({ from, event: "FLAG_CONFLICT", to: "CONFLICTING", actor: sys, guards: [], description: "Contradictory reports or duplicate records detected" })),
  ...CONFLICT_RESOLUTION_TARGETS.map<Transition>((to) => ({ from: "CONFLICTING", event: "RESOLVE_CONFLICT", to, actor: perm("resolve_conflicts"), guards: ["reasonRequired"], description: `Conflict resolved by a human; task set to ${to}` })),
  ...ESCALATABLE.map<Transition>((from) => ({ from, event: "ESCALATE", to: "ESCALATED", actor: sys, guards: [], description: "Escalated according to the escalation policy" })),
  ...REASSIGNABLE.map<Transition>((from) => ({ from, event: "REASSIGN", to: "REASSIGNED", actor: perm("manage_tasks"), guards: ["qualification", "differentAssignee"], description: "Responsibility transferred; not covered until the new member accepts" })),
  { from: "REASSIGNED", event: "REQUEST_ACCEPTANCE", to: "AWAITING_ACKNOWLEDGEMENT", actor: sys, guards: [], description: "New assignee asked to accept" },
  ...CANCELLABLE.map<Transition>((from) => ({ from, event: "CANCEL", to: "CANCELLED", actor: perm("manage_tasks"), guards: ["reasonRequired"], description: "Cancelled with a reason" })),
  ...SUPERSEDABLE.map<Transition>((from) => ({ from, event: "SUPERSEDE", to: "CANCELLED", actor: sys, guards: ["reasonRequired"], description: "Future occurrence of an instruction replaced by an approved new version" })),
];

export const MEDICAL_CATEGORIES = new Set(["MEDICATION", "WOUND_CARE"]);

export interface TransitionActor {
  type: "USER" | "SYSTEM" | "AGENT";
  memberId?: string | null;
  permissions: ReadonlySet<Permission> | Permission[];
}

export interface TransitionTask {
  state: TaskStateName;
  category: string;
  assigneeMemberId: string | null;
  requiredQualification: string | null;
}

export interface TransitionInput {
  /** Member who will own the task after ASSIGN / REASSIGN / CLAIM. */
  targetMember?: { id: string; qualifications: string[] } | null;
  reason?: string | null;
  declaration?: string | null;
  /** For RESOLVE_CONFLICT: which state to return to. */
  resolveTo?: TaskStateName;
}

export type TransitionResult =
  | { ok: true; transition: Transition }
  | { ok: false; code: "INVALID_TRANSITION" | "FORBIDDEN" | "GUARD_FAILED"; message: string };

function hasPerm(actor: TransitionActor, p: Permission) {
  const set = actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions as Permission[]);
  return set.has(p);
}

export function findTransitions(from: TaskStateName, event: TaskEventName): Transition[] {
  return TRANSITIONS.filter((t) => t.from === from && t.event === event);
}

export function allowedEvents(from: TaskStateName): TaskEventName[] {
  return [...new Set(TRANSITIONS.filter((t) => t.from === from).map((t) => t.event))];
}

/** Decide whether `event` may be applied. Pure: callers persist the result. */
export function planTransition(
  task: TransitionTask,
  event: TaskEventName,
  actor: TransitionActor,
  input: TransitionInput = {},
): TransitionResult {
  const candidates = findTransitions(task.state, event);
  if (candidates.length === 0) {
    return { ok: false, code: "INVALID_TRANSITION", message: `Cannot ${event.toLowerCase().replace(/_/g, " ")} a task that is ${task.state.toLowerCase().replace(/_/g, " ")}.` };
  }
  const t = event === "RESOLVE_CONFLICT" ? candidates.find((c) => c.to === input.resolveTo) : candidates[0];
  if (!t) {
    return { ok: false, code: "INVALID_TRANSITION", message: `A conflict can only be resolved to one of: ${CONFLICT_RESOLUTION_TARGETS.join(", ")}.` };
  }

  // --- actor rule
  const isSystem = actor.type === "SYSTEM";
  const isAssignee = !!actor.memberId && actor.memberId === task.assigneeMemberId;
  switch (t.actor.kind) {
    case "system":
      if (!isSystem) return { ok: false, code: "FORBIDDEN", message: "Only the system can do this." };
      break;
    case "permission":
      if (isSystem || !hasPerm(actor, t.actor.permission)) return { ok: false, code: "FORBIDDEN", message: `Requires the ${t.actor.permission} permission.` };
      break;
    case "verifyByCategory": {
      const needed: Permission = MEDICAL_CATEGORIES.has(task.category) ? "verify_medical" : "manage_tasks";
      if (isSystem || !hasPerm(actor, needed)) return { ok: false, code: "FORBIDDEN", message: `Requires the ${needed} permission.` };
      break;
    }
    case "assigneeOnly":
      if (!isAssignee) return { ok: false, code: "FORBIDDEN", message: "Only the assigned person can do this for themselves." };
      break;
    case "assigneeOrDeclaration":
      if (!isAssignee) {
        if (!hasPerm(actor, "record_care")) return { ok: false, code: "FORBIDDEN", message: "Requires being the assignee or the record_care permission." };
        if (!input.declaration?.trim()) return { ok: false, code: "GUARD_FAILED", message: "You are not the assignee: add a declaration of what you did." };
      }
      break;
    case "declarationRequired":
      if (!hasPerm(actor, "record_care")) return { ok: false, code: "FORBIDDEN", message: "Requires the record_care permission." };
      if (!input.declaration?.trim()) return { ok: false, code: "GUARD_FAILED", message: "This task was not accepted by you: add a declaration of what you did." };
      break;
    case "self":
      if (!actor.memberId || !hasPerm(actor, "record_care")) return { ok: false, code: "FORBIDDEN", message: "Requires the record_care permission." };
      if (!input.targetMember || input.targetMember.id !== actor.memberId) return { ok: false, code: "FORBIDDEN", message: "You can only claim a task for yourself." };
      break;
  }

  // --- guards
  for (const g of t.guards) {
    switch (g) {
      case "qualification": {
        const target = input.targetMember;
        if (!target) return { ok: false, code: "GUARD_FAILED", message: "Choose who should own this task." };
        if (task.requiredQualification && !target.qualifications.includes(task.requiredQualification)) {
          return { ok: false, code: "GUARD_FAILED", message: `This task requires the ${task.requiredQualification} qualification, which ${t.actor.kind === "self" ? "you do" : "the chosen member does"} not have.` };
        }
        break;
      }
      case "reasonRequired":
        if (!input.reason?.trim()) return { ok: false, code: "GUARD_FAILED", message: "A reason is required." };
        break;
      case "noCurrentAssignee":
        if (task.assigneeMemberId) return { ok: false, code: "GUARD_FAILED", message: "This task already has an owner; use reassign." };
        break;
      case "differentAssignee":
        if (input.targetMember && input.targetMember.id === task.assigneeMemberId) return { ok: false, code: "GUARD_FAILED", message: "The task is already assigned to that member." };
        break;
      case "hasAssignee":
        if (!task.assigneeMemberId) return { ok: false, code: "GUARD_FAILED", message: "This task has no assignee." };
        break;
    }
  }
  return { ok: true, transition: t };
}

/** Tasks in these states have someone who has accepted responsibility. */
export const COVERED_STATES: TaskStateName[] = ["ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED"];
export const TERMINAL_STATES: TaskStateName[] = ["COMPLETED", "CANCELLED"];
