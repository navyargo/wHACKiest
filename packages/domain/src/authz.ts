/**
 * Roles × permissions matrix. Single source of truth (mirrored in docs/AUTHZ.md).
 * Enforced server-side in REST routes and MCP tools via `requireMembership` + `assertPermission`.
 */
export const PERMISSIONS = [
  "view_patient",
  "view_messages",
  "view_documents",
  "upload_documents",
  "manage_members",
  "manage_tasks",
  "verify_medical",
  "record_care",
  "resolve_conflicts",
  "approve_sensitive",
  "use_assistant",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "PATIENT_OR_REPRESENTATIVE",
  "CARE_COORDINATOR",
  "CLINICAL_VERIFIER",
  "FAMILY_CAREGIVER",
  "PROFESSIONAL_CAREGIVER",
  "REMOTE_VIEWER",
] as const;
export type RoleName = (typeof ROLES)[number];

const CAREGIVER: Permission[] = ["view_patient", "view_messages", "view_documents", "upload_documents", "record_care", "use_assistant"];

export const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  PATIENT_OR_REPRESENTATIVE: PERMISSIONS,
  CARE_COORDINATOR: ["view_patient", "view_messages", "view_documents", "upload_documents", "manage_tasks", "record_care", "resolve_conflicts", "use_assistant"],
  CLINICAL_VERIFIER: ["view_patient", "view_messages", "view_documents", "upload_documents", "verify_medical", "resolve_conflicts", "use_assistant"],
  FAMILY_CAREGIVER: CAREGIVER,
  PROFESSIONAL_CAREGIVER: CAREGIVER,
  REMOTE_VIEWER: ["view_patient", "use_assistant"],
};

export const ROLE_LABELS: Record<RoleName, string> = {
  PATIENT_OR_REPRESENTATIVE: "Patient / representative",
  CARE_COORDINATOR: "Care coordinator",
  CLINICAL_VERIFIER: "Clinical verifier",
  FAMILY_CAREGIVER: "Family caregiver",
  PROFESSIONAL_CAREGIVER: "Professional caregiver",
  REMOTE_VIEWER: "Remote viewer",
};

export interface MembershipLike {
  role: RoleName;
  messageAccessGranted?: boolean;
  status?: string;
}

export function permissionsFor(m: MembershipLike): Set<Permission> {
  if (m.status && m.status !== "ACTIVE") return new Set();
  const set = new Set<Permission>(ROLE_PERMISSIONS[m.role]);
  // Remote viewers may be granted raw message access through an approved request.
  if (m.role === "REMOTE_VIEWER" && m.messageAccessGranted) set.add("view_messages");
  return set;
}

export function hasPermission(m: MembershipLike, p: Permission): boolean {
  return permissionsFor(m).has(p);
}

/** Sensitive actions that always go through an ApprovalRequest, with the permission needed to approve. */
export const SENSITIVE_ACTIONS = {
  ACTIVATE_INSTRUCTIONS: "verify_medical",
  CHANGE_CARE_PLAN_ITEM: "verify_medical",
  RESOLVE_CLINICAL_CONFLICT: "verify_medical",
  ADD_MEMBER: "manage_members",
  REMOVE_MEMBER: "manage_members",
  CHANGE_MEMBER_ROLE: "manage_members",
  GRANT_MESSAGE_ACCESS: "manage_members",
  REASSIGN_TASK: "manage_tasks",
} as const satisfies Record<string, Permission>;
export type SensitiveAction = keyof typeof SENSITIVE_ACTIONS;
