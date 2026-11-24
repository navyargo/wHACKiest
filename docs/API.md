# REST API

All routes live in one route table (`apps/web/lib/api/routes.ts`) behind a single wrapper. Conventions:

- **Auth**: httpOnly `cr_session` cookie (DB-backed session). Missing/expired → `401 UNAUTHENTICATED`.
- **Patient scope**: `:pid` is checked against the caller's active membership. Not a member → `404 NOT_FOUND` (nothing leaked). Missing permission → `403 FORBIDDEN`.
- **Validation**: every body/query is parsed with Zod → `400 VALIDATION_ERROR` with issue list.
- **Mutations** require an `Idempotency-Key` header (`400 IDEMPOTENCY_KEY_REQUIRED` otherwise). A replay with the same key returns the stored status and body.
- **Errors**: `{ error: { code, message, details? } }`. Codes: `INVALID_TRANSITION` 409, `GUARD_FAILED` 409, `STALE_VERSION` 409, `DUPLICATE_ADMINISTRATION` 409 (body includes the existing record), `DEMO_ONLY` 404, `NOT_FOUND` 404, `FORBIDDEN` 403.
- Mutations that carry a `version` field use optimistic locking.

| Method | Path | Permission | Body / query (Zod) | Returns |
|---|---|---|---|---|
| POST | /api/auth/login | public | `{email, password}` | `{user}` + cookie |
| POST | /api/auth/logout | session | – | `{ok}` |
| GET | /api/me | session | – | user, memberships with permissions, `demoMode`, `aiMode`, `voiceEnabled`, `storage` |
| GET | /api/demo/accounts | DEMO_MODE | – | demo users |
| POST | /api/demo/login | DEMO_MODE | `{email}` | one-click login / user switcher |
| GET | /api/patients | session | – | patients the caller belongs to |
| GET | /api/patients/:pid | view_patient | – | patient profile |
| GET | /api/patients/:pid/status | view_patient | – | consolidated status (remote-viewer safe) |
| GET | /api/patients/:pid/tasks | view_patient | `?date=YYYY-MM-DD&state=&assignee=` | tasks with owner + ack state |
| POST | /api/patients/:pid/tasks | manage_tasks | `{title, category, priority, scheduledAt, windowMinutesBefore, windowMinutesAfter, requiredQualification?}` | task (UNASSIGNED) |
| GET | /api/patients/:pid/tasks/:tid | view_patient | – | task, events, administrations, reports, sources, allowed actions |
| POST | /api/patients/:pid/tasks/:tid/transition | per state machine | `{event, version, targetMemberId?, reason?, declaration?, note?, resolveTo?}` | task |
| POST | /api/patients/:pid/tasks/:tid/administrations | record_care | `{administeredAt?, note?, confirmDuplicate?}` | record, or 409 `DUPLICATE_ADMINISTRATION` with existing record |
| POST | /api/patients/:pid/tasks/:tid/reports | record_care | `{claim: DONE\|NOT_DONE, note}` | report (feeds CON-001) |
| GET | /api/patients/:pid/candidates | view_patient | `?taskId=` | ranked caregivers with reasons |
| GET | /api/patients/:pid/alerts | view_patient | `?state=` | alerts |
| GET | /api/patients/:pid/alerts/:aid | view_patient | – | alert + explainability + task/conflict |
| POST | /api/patients/:pid/alerts/:aid/acknowledge | view_patient (responder) | `{version}` | alert |
| POST | /api/patients/:pid/alerts/:aid/coverage-agent | manage_tasks | – | Coverage Agent result (proposals) |
| GET | /api/patients/:pid/conflicts | view_patient | – | conflicts |
| POST | /api/patients/:pid/conflicts/:cid/resolve | resolve_conflicts | `{resolution, resolveTo?, version}` | conflict, or ApprovalRequest if clinically significant |
| POST | /api/patients/:pid/sweep | view_patient | – | sweep summary |
| GET | /api/patients/:pid/documents | view_documents | – | documents with version groups |
| POST | /api/patients/:pid/documents | upload_documents | `{kind, title, documentDate, text?, fileBase64?, fileName?, versionGroupId?}` | document + Intake Agent result |
| GET | /api/patients/:pid/documents/:did | view_documents | – | text, extracted items, diff vs active plan, approval |
| GET | /api/patients/:pid/extracted | view_patient | `?status=` | extracted items |
| PATCH | /api/patients/:pid/extracted/:eid | verify_medical (medical) / manage_tasks | `{payload}` | item (edit before approval) |
| POST | /api/patients/:pid/extracted/:eid/reject | verify_medical / manage_tasks | `{reason}` | item |
| POST | /api/patients/:pid/extracted/:eid/confirm | depends on type (see code) | – | effect of a non-medical interpretation |
| GET | /api/patients/:pid/messages | view_messages | – | simulated inbox + interpretations |
| POST | /api/patients/:pid/messages | record_care | `{text, channel, authorise}` | message |
| POST | /api/patients/:pid/messages/import | record_care | `{fileText, authorise}` | imported count (WhatsApp export) |
| POST | /api/patients/:pid/messages/:mid/authorise | record_care | – | message |
| POST | /api/patients/:pid/messages/:mid/extract | view_messages | – | Intake Agent result |
| GET | /api/patients/:pid/handovers | view_patient | – | handovers |
| POST | /api/patients/:pid/handovers | record_care | `{toMemberId, shiftStart?, shiftEnd?}` | DRAFT via Handover Agent |
| PATCH | /api/patients/:pid/handovers/:hid | sender | `{observations, version}` | handover |
| POST | /api/patients/:pid/handovers/:hid/send | sender | `{version}` | handover |
| POST | /api/patients/:pid/handovers/:hid/acknowledge | recipient only | `{version}` | handover (tasks untouched) |
| GET | /api/patients/:pid/handovers/:hid/audio | view_patient, voice enabled | – | audio/mpeg (ElevenLabs) |
| GET | /api/patients/:pid/inventory | view_patient | – | stock + projections |
| POST | /api/patients/:pid/inventory/:mid/verify-stock | record_care | `{count, version}` | medication |
| POST | /api/patients/:pid/inventory/:mid/replenishments | record_care | `{assigneeMemberId?, dueBy}` | request |
| POST | /api/patients/:pid/replenishments/:rid/transition | record_care / assignee | `{event, version, confirmedQuantity?, targetMemberId?}` | request |
| GET | /api/patients/:pid/timeline | view_patient | `?kind=` | unified feed (messages only with view_messages) |
| GET | /api/patients/:pid/members | view_patient | – | members, roles, qualifications, availability |
| POST | /api/patients/:pid/members | manage_members | `{email, name, role, qualifications}` | ApprovalRequest |
| POST | /api/patients/:pid/members/:mid/role | manage_members | `{role}` | ApprovalRequest |
| POST | /api/patients/:pid/members/:mid/grant-messages | manage_members | – | ApprovalRequest |
| POST | /api/patients/:pid/availability | self or manage_tasks | `{memberId, type, start, end, note}` | availability |
| DELETE | /api/patients/:pid/availability/:avid | self or manage_tasks | – | `{ok}` |
| GET | /api/patients/:pid/escalation-policies | view_patient | – | policies |
| PUT | /api/patients/:pid/escalation-policies/:epid | manage_tasks | `{steps, version}` | policy |
| GET | /api/patients/:pid/approvals | view_patient | `?state=` | approvals |
| POST | /api/patients/:pid/approvals/:apid/decide | the request's `requiredPermission` | `{decision, reason?, version}` | approval + executed result |
| POST | /api/patients/:pid/assistant | use_assistant | `{question}` | answer, citations, tool calls |
| GET | /api/patients/:pid/mcp-activity | view_patient | `?since=` | recent MCP tool calls from the audit log |
| GET | /api/patients/:pid/notifications | view_patient | – | my notifications |
| POST | /api/patients/:pid/notifications/:nid/read | owner | – | notification |
| GET | /api/demo/state | DEMO_MODE | – | virtual time, scenarios |
| POST | /api/demo/clock | DEMO_MODE | `{addMinutes}` or `{jumpTo: "HH:MM"}` | virtual time |
| POST | /api/demo/reset | DEMO_MODE | – | reseeded |
| POST | /api/demo/scenarios/:n | DEMO_MODE | – | scenario setup summary + next step |
| POST/GET/DELETE | /api/mcp | Bearer token | MCP JSON-RPC | MCP Streamable HTTP |
