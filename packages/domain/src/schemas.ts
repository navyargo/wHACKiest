import { z } from "zod";

export const TaskCategoryZ = z.enum(["MEDICATION", "WOUND_CARE", "PHYSIO", "APPOINTMENT", "MEAL", "HYGIENE", "MONITORING", "ERRAND", "OTHER"]);
export const PriorityZ = z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]);
export const AlertLevelZ = z.enum(["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "URGENT"]);
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");

export const SpanZ = z.object({ start: z.number().int().min(0), end: z.number().int().min(0), line: z.number().int().optional() });
export type Span = z.infer<typeof SpanZ>;

/** A pointer to the original source behind an alert, conflict or handover item. */
export const EvidenceRefZ = z.object({
  sourceType: z.enum(["TASK", "TASK_EVENT", "DOCUMENT", "MESSAGE", "ADMINISTRATION", "AVAILABILITY", "HANDOVER", "MEDICATION", "EXTRACTED_ITEM", "OBSERVATION", "CARE_PLAN_ITEM", "CONFLICT", "ALERT"]),
  sourceId: z.string(),
  excerpt: z.string(),
  recordedBy: z.string().nullable(),
  timestamp: z.string(),
  span: SpanZ.optional(),
  /** For extracted items: the document/message they came from. */
  parentSourceType: z.enum(["DOCUMENT", "MESSAGE"]).optional(),
  parentSourceId: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefZ>;

export const ResolutionActionZ = z.enum([
  "ASSIGN",
  "REASSIGN",
  "CLAIM",
  "ACKNOWLEDGE_TASK",
  "NUDGE_ASSIGNEE",
  "COMPLETE_TASK",
  "OPEN_TASK",
  "RESOLVE_CONFLICT",
  "OPEN_APPROVAL",
  "OPEN_DOCUMENT",
  "COVERAGE_AGENT",
  "CREATE_HANDOVER",
  "OPEN_HANDOVER",
  "CREATE_REPLENISHMENT",
  "VERIFY_STOCK",
  "CONFIRM_ITEM",
  "REJECT_ITEM",
  "ACK_ALERT",
]);
export const ResolutionOptionZ = z.object({ action: ResolutionActionZ, label: z.string(), targetId: z.string().optional() });
export type ResolutionOption = z.infer<typeof ResolutionOptionZ>;

export const AlertBasisZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RULE"), ruleId: z.string(), description: z.string() }),
  z.object({ kind: z.literal("AI"), ruleId: z.string(), description: z.string(), confidence: z.number(), provider: z.string() }),
]);
export type AlertBasis = z.infer<typeof AlertBasisZ>;

// ---------- Extracted item payloads (validated before storage) ----------
export const MedicationPayloadZ = z.object({
  name: z.string().min(1),
  strength: z.string().default(""),
  form: z.string().default("tablet"),
  /** Units per administration exactly as written in the source, e.g. 1 (tablet). */
  unitsPerAdministration: z.number().positive().nullable(),
  /** Dosage text exactly as written in the source document. */
  doseText: z.string().default(""),
  times: z.array(HHMM).default([]),
  frequencyText: z.string().default(""),
  instructions: z.string().default(""),
  durationDays: z.number().int().positive().nullable().default(null),
});
export const AppointmentPayloadZ = z.object({
  title: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: HHMM.nullable(),
  location: z.string().default(""),
  notes: z.string().default(""),
});
export const CareActivityPayloadZ = z.object({
  title: z.string().min(1),
  category: TaskCategoryZ.default("OTHER"),
  times: z.array(HHMM).default([]),
  instructions: z.string().default(""),
  requiredQualification: z.string().nullable().default(null),
  durationDays: z.number().int().positive().nullable().default(null),
});
export const RestrictionPayloadZ = z.object({ text: z.string().min(1), durationDays: z.number().int().positive().nullable().default(null) });
export const CommitmentPayloadZ = z.object({
  text: z.string().min(1),
  /** Who is said to be doing it (may be someone other than the sender = hand-off). */
  committedMemberId: z.string().nullable(),
  committedName: z.string().default(""),
  isHandoff: z.boolean().default(false),
  taskHint: z.string().default(""),
  date: z.string().nullable().default(null),
  linkedTaskId: z.string().nullable().default(null),
});
export const CompletionReportPayloadZ = z.object({
  claim: z.enum(["DONE", "NOT_DONE"]),
  text: z.string(),
  category: TaskCategoryZ.default("MEDICATION"),
  timeOfDay: z.enum(["morning", "afternoon", "evening", "night", "unknown"]).default("unknown"),
  linkedTaskId: z.string().nullable().default(null),
});
export const ObservationPayloadZ = z.object({ text: z.string().min(1), category: z.string().default("general") });
export const ScheduleChangePayloadZ = z.object({
  subject: z.string().default("appointment"),
  status: z.enum(["CANCELLED", "RESCHEDULED", "CONFIRMED"]),
  date: z.string().nullable().default(null),
  newDate: z.string().nullable().default(null),
  text: z.string(),
});
export const ReplenishmentPayloadZ = z.object({ medicationName: z.string(), text: z.string() });
export const ConcernPayloadZ = z.object({ text: z.string() });

export const PAYLOAD_SCHEMAS = {
  MEDICATION: MedicationPayloadZ,
  APPOINTMENT: AppointmentPayloadZ,
  CARE_ACTIVITY: CareActivityPayloadZ,
  RESTRICTION: RestrictionPayloadZ,
  COMMITMENT: CommitmentPayloadZ,
  COMPLETION_REPORT: CompletionReportPayloadZ,
  OBSERVATION: ObservationPayloadZ,
  SCHEDULE_CHANGE: ScheduleChangePayloadZ,
  REPLENISHMENT_REQUEST: ReplenishmentPayloadZ,
  CONCERN: ConcernPayloadZ,
} as const;
export type ExtractedItemTypeName = keyof typeof PAYLOAD_SCHEMAS;
/** Medical instruction types: never auto-activate, need verify_medical. */
export const MEDICAL_ITEM_TYPES: ExtractedItemTypeName[] = ["MEDICATION", "CARE_ACTIVITY", "RESTRICTION", "APPOINTMENT"];

export const ExtractionCandidateZ = z.object({
  itemType: z.enum(["MEDICATION", "APPOINTMENT", "CARE_ACTIVITY", "RESTRICTION", "COMMITMENT", "COMPLETION_REPORT", "OBSERVATION", "SCHEDULE_CHANGE", "REPLENISHMENT_REQUEST", "CONCERN"]),
  payload: z.record(z.unknown()),
  /** Exact text copied from the source; the span is computed from it deterministically. */
  quote: z.string().min(1),
  span: SpanZ.optional(),
  confidence: z.number().min(0).max(1),
  whyUncertain: z.string().nullable().default(null),
});
export type ExtractionCandidate = z.infer<typeof ExtractionCandidateZ>;
export const ExtractionOutputZ = z.object({ items: z.array(ExtractionCandidateZ) });

// ---------- Handover snapshot ----------
export const SnapshotItemZ = z.object({
  id: z.string(),
  text: z.string(),
  at: z.string().nullable(),
  ref: EvidenceRefZ.pick({ sourceType: true, sourceId: true }),
});
export const HandoverSnapshotZ = z.object({
  generatedAt: z.string(),
  shiftStart: z.string(),
  shiftEnd: z.string(),
  completedActivities: z.array(SnapshotItemZ),
  pendingActivities: z.array(SnapshotItemZ),
  upcomingActivities: z.array(SnapshotItemZ),
  medicationEvents: z.array(SnapshotItemZ),
  unresolvedConflicts: z.array(SnapshotItemZ),
  observations: z.array(SnapshotItemZ),
  inventoryShortages: z.array(SnapshotItemZ),
  activeAlerts: z.array(SnapshotItemZ),
  upcomingAppointments: z.array(SnapshotItemZ),
  recentInstructionChanges: z.array(SnapshotItemZ),
});
export type HandoverSnapshot = z.infer<typeof HandoverSnapshotZ>;
export type SnapshotItem = z.infer<typeof SnapshotItemZ>;
export const SNAPSHOT_SECTIONS = [
  ["completedActivities", "Completed"],
  ["pendingActivities", "Still pending"],
  ["upcomingActivities", "Coming up (next 12 h)"],
  ["medicationEvents", "Medication records"],
  ["unresolvedConflicts", "Unresolved conflicts"],
  ["observations", "Observations"],
  ["inventoryShortages", "Supplies running low"],
  ["activeAlerts", "Open alerts"],
  ["upcomingAppointments", "Appointments"],
  ["recentInstructionChanges", "Recent instruction changes"],
] as const;

export const HandoverSummaryZ = z.object({
  sentences: z.array(z.object({ text: z.string().min(1), refs: z.array(z.string()).min(1) })),
});
export type HandoverSummary = z.infer<typeof HandoverSummaryZ>;

export const RecurrenceZ = z.object({
  times: z.array(HHMM).min(1),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const EscalationStepZ = z.object({
  afterMinutes: z.number().int().min(0),
  notifyRoles: z.array(z.string()).default([]),
  memberIds: z.array(z.string()).default([]),
  channel: z.enum(["IN_APP", "VOICE_ELEVENLABS", "SMS_SIMULATED"]),
});
export const EscalationStepsZ = z.array(EscalationStepZ).min(1);
