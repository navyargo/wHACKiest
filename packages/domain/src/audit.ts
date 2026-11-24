import type { Db } from "./db";
import type { Actor } from "./context";
import type { Prisma } from "@prisma/client";

export interface AuditEntry {
  action: string;
  patientId?: string | null;
  targetRef?: string;
  details?: Prisma.InputJsonValue;
}

/** Append-only audit log (UPDATE/DELETE blocked by a DB trigger). */
export async function audit(db: Db, actor: Actor, e: AuditEntry, at?: Date) {
  await db.auditLog.create({
    data: {
      actorType: actor.type,
      actorId: actor.userId,
      actorName: actor.name,
      action: e.action,
      patientId: e.patientId ?? null,
      targetRef: e.targetRef ?? "",
      details: e.details ?? {},
      ...(at ? { at } : {}),
    },
  });
}
