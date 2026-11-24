# Authorisation

Generated from `packages/domain/src/authz.ts`. Roles are per patient (`CareCircleMember.role`). Every REST route and MCP tool resolves the caller's membership for the patient on the server; non-members get **404** (no existence leak), members lacking a permission get **403**.

| Permission | PATIENT_OR_REPRESENTATIVE | CARE_COORDINATOR | CLINICAL_VERIFIER | FAMILY_CAREGIVER | PROFESSIONAL_CAREGIVER | REMOTE_VIEWER |
|---|---|---|---|---|---|---|
| `view_patient` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `view_messages` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `view_documents` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `upload_documents` | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `manage_members` | ✓ |  |  |  |  |  |
| `manage_tasks` | ✓ | ✓ |  |  |  |  |
| `verify_medical` | ✓ |  | ✓ |  |  |  |
| `record_care` | ✓ | ✓ |  | ✓ | ✓ |  |
| `resolve_conflicts` | ✓ | ✓ | ✓ |  |  |  |
| `approve_sensitive` | ✓ |  |  |  |  |  |
| `use_assistant` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

A `REMOTE_VIEWER` gains `view_messages` only through an approved `GRANT_MESSAGE_ACCESS` request.

## Sensitive actions (always an ApprovalRequest)

| Action | Approver needs |
|---|---|
| `ACTIVATE_INSTRUCTIONS` | `verify_medical` |
| `CHANGE_CARE_PLAN_ITEM` | `verify_medical` |
| `RESOLVE_CLINICAL_CONFLICT` | `verify_medical` |
| `ADD_MEMBER` | `manage_members` |
| `REMOVE_MEMBER` | `manage_members` |
| `CHANGE_MEMBER_ROLE` | `manage_members` |
| `GRANT_MESSAGE_ACCESS` | `manage_members` |
| `REASSIGN_TASK` | `manage_tasks` |

Agents never approve. An approval is decided by a human user holding the permission; the decision, the decider, time and reason are stored and audited.
