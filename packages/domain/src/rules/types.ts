import type { AlertBasis, EvidenceRef, ResolutionOption } from "../schemas";
import type { TaskStateName } from "../taskStateMachine";
import type { DiffEntry } from "../prescriptionDiff";
import type { RuleConfig } from "./config";

export type Level = "INFORMATIONAL" | "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export interface RTaskEvent {
  id: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  createdAt: Date;
  actorName: string;
  payload: Record<string, unknown>;
}
export interface RTask {
  id: string;
  title: string;
  category: string;
  priority: string;
  state: TaskStateName;
  scheduledAt: Date;
  windowStart: Date;
  windowEnd: Date;
  assigneeMemberId: string | null;
  requiredQualification: string | null;
  nonRepeatable: boolean;
  medicationId: string | null;
  completedAt: Date | null;
  completedByMemberId: string | null;
  events: RTaskEvent[];
  administrations: { id: string; status: "RECORDED" | "DISPUTED"; recordedByMemberId: string; administeredAt: Date; note: string }[];
}
export interface RMember {
  id: string;
  name: string;
  role: string;
  qualifications: string[];
  canManage: boolean;
  canCare: boolean;
  canVerify: boolean;
}
export interface RAvailability {
  id: string;
  memberId: string;
  type: "WORKING_HOURS" | "UNAVAILABLE" | "CALENDAR_BUSY";
  start: Date;
  end: Date;
  note: string;
  source: string;
}
export interface RHandover {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  shiftStart: Date;
  shiftEnd: Date;
  state: "DRAFT" | "SENT" | "ACKNOWLEDGED";
  sentAt: Date | null;
}
export interface RMedication {
  id: string;
  name: string;
  form: string;
  unitsPerAdministration: number;
  currentStock: number;
  stockVerifiedAt: Date | null;
  isEstimate: boolean;
  reorderThresholdDays: number;
  scheduledPerDay: number;
  recordedSinceVerification: number;
  disputedSinceVerification: number;
}
export interface RReplenishment {
  id: string;
  medicationId: string;
  state: string;
  assigneeMemberId: string | null;
}
export interface RExtracted {
  id: string;
  itemType: string;
  payload: Record<string, unknown>;
  confidence: number;
  status: string;
  sourceType: "DOCUMENT" | "MESSAGE" | string;
  sourceId: string;
  span: { start: number; end: number };
  excerpt: string;
  createdAt: Date;
  /** When the source message was sent (or the document uploaded). */
  sourceAt: Date;
  senderMemberId: string | null;
  senderName: string;
  detectedBy: string;
}
export interface RPendingVersion {
  approvalId: string;
  documentId: string;
  documentTitle: string;
  versionNumber: number;
  uploadedByName: string;
  createdAt: Date;
  diff: DiffEntry[];
}

export interface RuleInput {
  now: Date;
  tz: string;
  tasks: RTask[];
  members: RMember[];
  availability: RAvailability[];
  handovers: RHandover[];
  medications: RMedication[];
  replenishments: RReplenishment[];
  extracted: RExtracted[];
  pendingVersions: RPendingVersion[];
  aiProvider: string;
  config: RuleConfig;
}

export interface ConflictSpec {
  kind: "DUPLICATE_ADMINISTRATION" | "CONTRADICTORY_REPORT" | "INSTRUCTION_VERSION" | "AVAILABILITY" | "INVENTORY" | "APPOINTMENT_STATUS";
  title: string;
  dedupeKey: string;
  clinicallySignificant: boolean;
  subjectRefs: Record<string, unknown>;
  evidence: EvidenceRef[];
  latestEvidenceAt: Date;
}

export interface Finding {
  ruleId: string;
  dedupeKey: string;
  level: Level;
  title: string;
  explanation: string;
  basis: AlertBasis;
  evidence: EvidenceRef[];
  affectedTaskId?: string;
  responders: string[];
  resolutionOptions: ResolutionOption[];
  taskAction?: { taskId: string; event: "MARK_OVERDUE" | "FLAG_CONFLICT" };
  conflict?: ConflictSpec;
  /** Escalation through the policy applies (task-related, MEDIUM+). */
  escalate: boolean;
}

export interface Rule {
  id: string;
  description: string;
  run(input: RuleInput): Finding[];
}
