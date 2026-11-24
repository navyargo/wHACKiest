# Schema

Source of truth: `prisma/schema.prisma`. DB-level guarantees added in `prisma/migrations/*_constraints/migration.sql`:

- `AdministrationRecord`: partial unique index — one `RECORDED` row per `taskId`.
- `Alert`: partial unique index on `dedupeKey` where `state <> 'RESOLVED'`.
- `Conflict`: partial unique index on `dedupeKey` where `state = 'OPEN'`.
- `Task`: unique `(carePlanItemId, scheduledAt)`; check `windowStart <= windowEnd`.
- `Medication`: check `unitsPerAdministration > 0`.
- `TaskEvent`, `AuditLog`: triggers reject `UPDATE`/`DELETE` (append-only).
- `Availability`: check `start < end`.

```mermaid
erDiagram
  User ||--o{ CareCircleMember : "member of"
  User ||--o{ Session : has
  User ||--o{ McpToken : has
  Patient ||--o{ CareCircleMember : "care circle"
  CareCircleMember ||--o{ Availability : declares
  Patient ||--o{ SourceDocument : has
  Patient ||--o{ SourceMessage : has
  Patient ||--o{ ExtractedItem : has
  SourceDocument ||--o{ ExtractedItem : "sourceId"
  SourceMessage ||--o{ ExtractedItem : "sourceId"
  ExtractedItem ||--o| CarePlanItem : "approved into"
  Patient ||--o{ CarePlanItem : plan
  Medication ||--o{ CarePlanItem : "scheduled by"
  CarePlanItem ||--o{ Task : "occurrences"
  Patient ||--o{ Task : has
  Task ||--o{ TaskEvent : "append-only history"
  Task ||--o{ AdministrationRecord : "≤1 RECORDED"
  Patient ||--o{ Conflict : has
  Patient ||--o{ Alert : has
  Alert }o--o| Task : affects
  Alert }o--o| Conflict : about
  Patient ||--o{ Handover : has
  Patient ||--o{ Observation : has
  Patient ||--o{ Medication : "inventory"
  Medication ||--o{ ReplenishmentRequest : has
  Patient ||--o{ ApprovalRequest : has
  CareCircleMember ||--o{ Notification : receives
```

Mutable aggregates (`Patient`, `CareCircleMember`, `CarePlanItem`, `Task`, `Conflict`, `Alert`, `Handover`, `Medication`, `ReplenishmentRequest`, `ApprovalRequest`, `EscalationPolicy`) carry a `version` for optimistic locking.
