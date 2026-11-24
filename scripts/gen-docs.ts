// Regenerates the tables in docs/STATE_MACHINE.md and docs/AUTHZ.md from code: `pnpm tsx scripts/gen-docs.ts`
import { writeFileSync } from "node:fs";
import { TRANSITIONS } from "../packages/domain/src/taskStateMachine";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, SENSITIVE_ACTIONS } from "../packages/domain/src/authz";

const actor = (a: (typeof TRANSITIONS)[number]["actor"]) =>
  a.kind === "permission" ? `\`${a.permission}\`` : a.kind === "verifyByCategory" ? "`verify_medical` (medical) / `manage_tasks`" : a.kind;

const sm = `# Task state machine

Generated from \`packages/domain/src/taskStateMachine.ts\` by \`scripts/gen-docs.ts\`. Every state change (REST, MCP, scheduler) calls \`planTransition\`.
Invalid transitions → HTTP 409 \`INVALID_TRANSITION\`; missing permission → 403; failed guard → 409 \`GUARD_FAILED\`; stale \`version\` → 409 \`STALE_VERSION\`.

\`\`\`mermaid
stateDiagram-v2
  [*] --> PROPOSED
  PROPOSED --> AWAITING_VERIFICATION
  AWAITING_VERIFICATION --> UNASSIGNED: verify
  UNASSIGNED --> ASSIGNED: assign
  ASSIGNED --> AWAITING_ACKNOWLEDGEMENT: notify (system)
  AWAITING_ACKNOWLEDGEMENT --> ACKNOWLEDGED: assignee accepts
  UNASSIGNED --> ACKNOWLEDGED: claim (self)
  AWAITING_ACKNOWLEDGEMENT --> UNASSIGNED: decline
  ACKNOWLEDGED --> IN_PROGRESS: start
  IN_PROGRESS --> COMPLETED: complete
  ACKNOWLEDGED --> COMPLETED: complete
  AWAITING_ACKNOWLEDGEMENT --> OVERDUE: window passed (system)
  OVERDUE --> ESCALATED: policy (system)
  ACKNOWLEDGED --> REASSIGNED: reassign
  REASSIGNED --> AWAITING_ACKNOWLEDGEMENT: request acceptance (system)
  COMPLETED --> CONFLICTING: duplicate / contradiction (system)
  CONFLICTING --> COMPLETED: resolve_conflicts + note
  UNASSIGNED --> CANCELLED: manage_tasks + reason
  COMPLETED --> [*]
  CANCELLED --> [*]
\`\`\`
(The diagram shows the main paths; the table below is complete.)

Actor rules: **system** = scheduler/rules only; **assigneeOnly** = the assigned member themselves; **assigneeOrDeclaration** = assignee, or any \`record_care\` member who writes a declaration; **declarationRequired** = \`record_care\` + declaration; **self** = claim for yourself (\`record_care\`).

| From | Event | To | Actor | Guards | Meaning |
|---|---|---|---|---|---|
${TRANSITIONS.map((t) => `| ${t.from} | ${t.event} | ${t.to} | ${actor(t.actor)} | ${t.guards.join(", ") || "—"} | ${t.description} |`).join("\n")}

Concurrency: every mutation is \`UPDATE … WHERE id = ? AND version = ?\` and increments \`version\`. Every mutating request carries \`Idempotency-Key\`; replays return the stored response and write no new event.
`;
writeFileSync("docs/STATE_MACHINE.md", sm);

const authz = `# Authorisation

Generated from \`packages/domain/src/authz.ts\`. Roles are per patient (\`CareCircleMember.role\`). Every REST route and MCP tool resolves the caller's membership for the patient on the server; non-members get **404** (no existence leak), members lacking a permission get **403**.

| Permission | ${ROLES.join(" | ")} |
|---|${ROLES.map(() => "---").join("|")}|
${PERMISSIONS.map((p) => `| \`${p}\` | ${ROLES.map((r) => (ROLE_PERMISSIONS[r].includes(p) ? "✓" : "")).join(" | ")} |`).join("\n")}

A \`REMOTE_VIEWER\` gains \`view_messages\` only through an approved \`GRANT_MESSAGE_ACCESS\` request.

## Sensitive actions (always an ApprovalRequest)

| Action | Approver needs |
|---|---|
${Object.entries(SENSITIVE_ACTIONS).map(([a, p]) => `| \`${a}\` | \`${p}\` |`).join("\n")}

Agents never approve. An approval is decided by a human user holding the permission; the decision, the decider, time and reason are stored and audited.
`;
writeFileSync("docs/AUTHZ.md", authz);
console.log("docs regenerated");
