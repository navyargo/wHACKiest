-- Constraints Prisma can't express in schema.prisma.

-- Only one RECORDED administration per task occurrence. A second attempt is stored as DISPUTED.
CREATE UNIQUE INDEX "AdministrationRecord_one_recorded_per_task" ON "AdministrationRecord" ("taskId") WHERE "status" = 'RECORDED';

-- Alerts are unique by dedupeKey while not resolved; conflicts while open.
CREATE UNIQUE INDEX "Alert_dedupeKey_unresolved" ON "Alert" ("patientId", "dedupeKey") WHERE "state" <> 'RESOLVED';
CREATE UNIQUE INDEX "Conflict_dedupeKey_open" ON "Conflict" ("patientId", "dedupeKey") WHERE "state" = 'OPEN';

-- Sanity checks.
ALTER TABLE "Task" ADD CONSTRAINT "Task_window_order" CHECK ("windowStart" <= "windowEnd");
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_order" CHECK ("start" < "end");
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_units_positive" CHECK ("unitsPerAdministration" > 0);
ALTER TABLE "ExtractedItem" ADD CONSTRAINT "ExtractedItem_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "Task" ADD CONSTRAINT "Task_version_positive" CHECK ("version" >= 1);

-- Append-only tables: reject UPDATE and DELETE (TRUNCATE is still allowed for test/demo resets).
CREATE OR REPLACE FUNCTION carerelay_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TaskEvent_append_only" BEFORE UPDATE OR DELETE ON "TaskEvent" FOR EACH ROW EXECUTE FUNCTION carerelay_append_only();
CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION carerelay_append_only();
