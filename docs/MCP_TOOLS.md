# MCP tools

Server: `packages/mcp-server` (official `@modelcontextprotocol/sdk`). Transports:
- **Streamable HTTP** at `POST /api/mcp` (stateless). `Authorization: Bearer <token>`; tokens are issued per user + patient by the app (`McpToken`, hash stored, default 15-minute life).
- **stdio** via `pnpm mcp:stdio`; token from `CARERELAY_MCP_TOKEN` (seeded demo tokens, see README).

Every call: token → user → membership of the requested patient (404 if not a member, or if the token is scoped to a different patient) → permission check → Zod input validation (SDK) → domain service → Zod output validation → `AuditLog` row `mcp.tool_call` (tool, caller, patient, SHA-256 of arguments, outcome, duration). Denied calls are logged too.

Side-effect classes: **READ** runs immediately and changes nothing. **PROPOSE** writes only drafts, `PROPOSED` items or `ApprovalRequest`s; it never changes an active plan, a task state or an assignment. **ACT_SELF** acts only on the caller's own responsibilities.

| Tool | Class | Permission | Input | Output |
|---|---|---|---|---|
| `list_patients` | READ | membership | `{}` | `{patients:[{id,displayName,role}]}` |
| `get_care_status` | READ | `view_patient` | `{patientId}` | counts of today's tasks by state, uncovered/overdue tasks, open alerts, open conflicts, low stock (no raw messages) |
| `list_tasks` | READ | `view_patient` | `{patientId, state?, date?, assigneeMemberId?}` | `{tasks:[…]}` |
| `get_task` | READ | `view_patient` | `{patientId, taskId}` | task + events + administrations + source refs |
| `list_open_alerts` | READ | `view_patient` | `{patientId}` | alerts with explanation, basis, evidence |
| `get_source_reference` | READ | `view_documents` / `view_messages` | `{patientId, sourceType, sourceId, start?, end?}` | excerpt + who/when |
| `get_member_availability` | READ | `view_patient` | `{patientId, from, to}` | busy/free blocks per member (no calendar details) |
| `find_available_caregivers` | READ | `view_patient` | `{patientId, taskId}` | ranked candidates with reasons |
| `get_inventory_status` | READ | `view_patient` | `{patientId}` | stock, projection, estimate flag |
| `draft_handover` | PROPOSE | `record_care` | `{patientId, toMemberId, shiftStart?, shiftEnd?}` | stored DRAFT handover + snapshot |
| `extract_from_document` | PROPOSE | `upload_documents` | `{patientId, documentId}` | `PROPOSED`/`AWAITING_VERIFICATION` items + approval request id |
| `extract_from_message` | PROPOSE | `view_messages` | `{patientId, messageId}` | proposed items (message must be authorised) |
| `propose_reassignment` | PROPOSE | `view_patient` | `{patientId, taskId, toMemberId, reason}` | `ApprovalRequest` (`REASSIGN_TASK`) |
| `request_approval` | PROPOSE | `view_patient` | `{patientId, actionType, title, payload}` | `ApprovalRequest` |
| `acknowledge_task` | ACT_SELF | assignee | `{patientId, taskId}` | updated task |
| `record_observation` | ACT_SELF | `record_care` | `{patientId, text, category?}` | observation |
| `run_care_sweep` | READ + system | `view_patient` | `{patientId}` | new / updated / resolved alerts (idempotent) |

Resources: `patient://{id}/timeline` (view_patient), `document://{id}` (view_documents).
Prompt: `shift_handover` (args `patientId`, `toMemberId`) — instructs the model to call `draft_handover` and summarise strictly from the snapshot.
