-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PATIENT_OR_REPRESENTATIVE', 'CARE_COORDINATOR', 'CLINICAL_VERIFIER', 'FAMILY_CAREGIVER', 'PROFESSIONAL_CAREGIVER', 'REMOTE_VIEWER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'INVITED', 'REMOVED');

-- CreateEnum
CREATE TYPE "AvailabilityType" AS ENUM ('WORKING_HOURS', 'UNAVAILABLE', 'CALENDAR_BUSY');

-- CreateEnum
CREATE TYPE "AvailabilitySource" AS ENUM ('MANUAL', 'CALENDAR_SIMULATED', 'ICS_IMPORT');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('PRESCRIPTION', 'DISCHARGE_SUMMARY', 'APPOINTMENT', 'INSTRUCTION', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('WHATSAPP_SIMULATED', 'SMS_SIMULATED', 'EMAIL_SIMULATED', 'IN_APP');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('DOCUMENT', 'MESSAGE', 'TASK_EVENT', 'ADMINISTRATION', 'HANDOVER', 'OBSERVATION', 'MANUAL');

-- CreateEnum
CREATE TYPE "ExtractedItemType" AS ENUM ('MEDICATION', 'APPOINTMENT', 'CARE_ACTIVITY', 'RESTRICTION', 'COMMITMENT', 'COMPLETION_REPORT', 'OBSERVATION', 'SCHEDULE_CHANGE', 'REPLENISHMENT_REQUEST', 'CONCERN');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PROPOSED', 'AWAITING_VERIFICATION', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TaskCategory" AS ENUM ('MEDICATION', 'WOUND_CARE', 'PHYSIO', 'APPOINTMENT', 'MEAL', 'HYGIENE', 'MONITORING', 'ERRAND', 'OTHER');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TaskState" AS ENUM ('PROPOSED', 'AWAITING_VERIFICATION', 'UNASSIGNED', 'ASSIGNED', 'AWAITING_ACKNOWLEDGEMENT', 'ACKNOWLEDGED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CONFLICTING', 'ESCALATED', 'REASSIGNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AGENT');

-- CreateEnum
CREATE TYPE "AdministrationStatus" AS ENUM ('RECORDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "ConflictKind" AS ENUM ('DUPLICATE_ADMINISTRATION', 'CONTRADICTORY_REPORT', 'INSTRUCTION_VERSION', 'AVAILABILITY', 'INVENTORY', 'APPOINTMENT_STATUS');

-- CreateEnum
CREATE TYPE "ConflictState" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertLevel" AS ENUM ('INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "HandoverState" AS ENUM ('DRAFT', 'SENT', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "ReplenishmentState" AS ENUM ('UNASSIGNED', 'AWAITING_ACKNOWLEDGEMENT', 'ACKNOWLEDGED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'VOICE_ELEVENLABS', 'SMS_SIMULATED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phone" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "patientId" UUID,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "fullName" TEXT,
    "age" INTEGER NOT NULL,
    "conditions" TEXT[],
    "allergies" TEXT[],
    "mobilityNotes" TEXT NOT NULL DEFAULT '',
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "emergencyContacts" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareCircleMember" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "relationship" TEXT NOT NULL DEFAULT '',
    "qualifications" TEXT[],
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "messageAccessGranted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CareCircleMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "type" "AvailabilityType" NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "source" "AvailabilitySource" NOT NULL DEFAULT 'MANUAL',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "versionGroupId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "storageKey" TEXT,
    "mimeType" TEXT NOT NULL DEFAULT 'text/plain',
    "rawText" TEXT NOT NULL,
    "uploadedBy" UUID NOT NULL,
    "supersedesId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceMessage" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "senderMemberId" UUID,
    "senderName" TEXT NOT NULL DEFAULT '',
    "sentAt" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "authorisedForProcessing" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "importBatch" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedItem" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "sourceSpan" JSONB NOT NULL,
    "itemType" "ExtractedItemType" NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "uncertaintyNote" TEXT,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PROPOSED',
    "detectedBy" TEXT NOT NULL,
    "linkedTaskId" UUID,
    "verifiedBy" UUID,
    "verifiedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarePlanItem" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "category" "TaskCategory" NOT NULL,
    "recurrence" JSONB NOT NULL,
    "windowMinutesBefore" INTEGER NOT NULL DEFAULT 30,
    "windowMinutesAfter" INTEGER NOT NULL DEFAULT 60,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "requiredQualification" TEXT,
    "nonRepeatable" BOOLEAN NOT NULL DEFAULT false,
    "medicationId" UUID,
    "sourceExtractedItemId" UUID,
    "sourceDocumentId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "supersededById" UUID,
    "approvedBy" UUID NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarePlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "carePlanItemId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" "TaskCategory" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "state" "TaskState" NOT NULL,
    "previousState" "TaskState",
    "requiredQualification" TEXT,
    "nonRepeatable" BOOLEAN NOT NULL DEFAULT false,
    "medicationId" UUID,
    "assigneeMemberId" UUID,
    "backupMemberId" UUID,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedByMemberId" UUID,
    "completionEvidence" JSONB,
    "escalationPolicyId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "fromState" "TaskState",
    "toState" "TaskState",
    "actorUserId" UUID,
    "actorType" "ActorType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdministrationRecord" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "medicationId" UUID,
    "recordedByMemberId" UUID NOT NULL,
    "administeredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" "AdministrationStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdministrationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "ConflictKind" NOT NULL,
    "title" TEXT NOT NULL,
    "subjectRefs" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "detectedBy" TEXT NOT NULL,
    "clinicallySignificant" BOOLEAN NOT NULL DEFAULT false,
    "state" "ConflictState" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "resolution" TEXT,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "ruleId" TEXT NOT NULL,
    "level" "AlertLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "basis" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "affectedTaskId" UUID,
    "conflictId" UUID,
    "resolutionOptions" JSONB NOT NULL,
    "responders" TEXT[],
    "state" "AlertState" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "escalationStep" INTEGER NOT NULL DEFAULT 0,
    "escalationPolicyId" UUID,
    "lastEscalatedAt" TIMESTAMP(3),
    "acknowledgedBy" UUID,
    "acknowledgedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationPolicy" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscalationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handover" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "fromMemberId" UUID NOT NULL,
    "toMemberId" UUID NOT NULL,
    "shiftStart" TIMESTAMP(3) NOT NULL,
    "shiftEnd" TIMESTAMP(3) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary" JSONB,
    "observations" TEXT NOT NULL DEFAULT '',
    "state" "HandoverState" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "audioKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "sourceType" "SourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Medication" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "unitsPerAdministration" DOUBLE PRECISION NOT NULL,
    "currentStock" DOUBLE PRECISION NOT NULL,
    "stockVerifiedAt" TIMESTAMP(3),
    "stockVerifiedBy" UUID,
    "reorderThresholdDays" INTEGER NOT NULL DEFAULT 3,
    "isEstimate" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplenishmentRequest" (
    "id" UUID NOT NULL,
    "medicationId" UUID NOT NULL,
    "assigneeMemberId" UUID,
    "state" "ReplenishmentState" NOT NULL DEFAULT 'UNASSIGNED',
    "dueBy" TIMESTAMP(3) NOT NULL,
    "confirmedQuantity" DOUBLE PRECISION,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplenishmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "actionType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedByUserId" UUID,
    "requestedByType" "ActorType" NOT NULL,
    "requiredPermission" TEXT NOT NULL,
    "state" "ApprovalState" NOT NULL DEFAULT 'PENDING',
    "decidedBy" UUID,
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "result" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "alertId" UUID,
    "taskId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "channel" "NotificationChannel" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "patientId" UUID,
    "targetRef" TEXT NOT NULL DEFAULT '',
    "details" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DemoClock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "offsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoClock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "CareCircleMember_patientId_userId_key" ON "CareCircleMember"("patientId", "userId");

-- CreateIndex
CREATE INDEX "Availability_memberId_start_idx" ON "Availability"("memberId", "start");

-- CreateIndex
CREATE INDEX "SourceDocument_patientId_idx" ON "SourceDocument"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_versionGroupId_versionNumber_key" ON "SourceDocument"("versionGroupId", "versionNumber");

-- CreateIndex
CREATE INDEX "SourceMessage_patientId_sentAt_idx" ON "SourceMessage"("patientId", "sentAt");

-- CreateIndex
CREATE INDEX "ExtractedItem_patientId_status_idx" ON "ExtractedItem"("patientId", "status");

-- CreateIndex
CREATE INDEX "ExtractedItem_sourceType_sourceId_idx" ON "ExtractedItem"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "CarePlanItem_patientId_active_idx" ON "CarePlanItem"("patientId", "active");

-- CreateIndex
CREATE INDEX "Task_patientId_scheduledAt_idx" ON "Task"("patientId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Task_patientId_state_idx" ON "Task"("patientId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Task_carePlanItemId_scheduledAt_key" ON "Task"("carePlanItemId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskEvent_idempotencyKey_key" ON "TaskEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskEvent_taskId_createdAt_idx" ON "TaskEvent"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AdministrationRecord_taskId_idx" ON "AdministrationRecord"("taskId");

-- CreateIndex
CREATE INDEX "AdministrationRecord_medicationId_administeredAt_idx" ON "AdministrationRecord"("medicationId", "administeredAt");

-- CreateIndex
CREATE INDEX "Conflict_patientId_state_idx" ON "Conflict"("patientId", "state");

-- CreateIndex
CREATE INDEX "Alert_patientId_state_idx" ON "Alert"("patientId", "state");

-- CreateIndex
CREATE INDEX "Handover_patientId_shiftEnd_idx" ON "Handover"("patientId", "shiftEnd");

-- CreateIndex
CREATE INDEX "Observation_patientId_recordedAt_idx" ON "Observation"("patientId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Medication_patientId_name_key" ON "Medication"("patientId", "name");

-- CreateIndex
CREATE INDEX "ApprovalRequest_patientId_state_idx" ON "ApprovalRequest"("patientId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_memberId_readAt_idx" ON "Notification"("memberId", "readAt");

-- CreateIndex
CREATE INDEX "AuditLog_patientId_at_idx" ON "AuditLog"("patientId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareCircleMember" ADD CONSTRAINT "CareCircleMember_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CareCircleMember" ADD CONSTRAINT "CareCircleMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "CareCircleMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceMessage" ADD CONSTRAINT "SourceMessage_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedItem" ADD CONSTRAINT "ExtractedItem_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarePlanItem" ADD CONSTRAINT "CarePlanItem_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CarePlanItem" ADD CONSTRAINT "CarePlanItem_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_carePlanItemId_fkey" FOREIGN KEY ("carePlanItemId") REFERENCES "CarePlanItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdministrationRecord" ADD CONSTRAINT "AdministrationRecord_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conflict" ADD CONSTRAINT "Conflict_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handover" ADD CONSTRAINT "Handover_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Observation" ADD CONSTRAINT "Observation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplenishmentRequest" ADD CONSTRAINT "ReplenishmentRequest_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

