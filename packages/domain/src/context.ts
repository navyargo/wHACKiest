import type { CareCircleMember, User } from "@prisma/client";
import { type Db, isUuid } from "./db";
import type { Clock } from "./clock";
import { type Permission, permissionsFor, type RoleName } from "./authz";
import { DomainError, forbidden, notFound } from "./errors";
import { audit, type AuditEntry } from "./audit";

export interface Actor {
  type: "USER" | "SYSTEM" | "AGENT";
  userId: string | null;
  name: string;
  /** Which entry point the call came through. */
  via?: "REST" | "MCP" | "SCHEDULER" | "SEED";
}

export const SYSTEM_ACTOR: Actor = { type: "SYSTEM", userId: null, name: "CareRelay system", via: "SCHEDULER" };

export type MemberWithUser = CareCircleMember & { user: Pick<User, "id" | "name" | "email"> };

export interface PatientContext {
  db: Db;
  clock: Clock;
  actor: Actor;
  patientId: string;
  /** null for SYSTEM actors */
  member: MemberWithUser | null;
  permissions: Set<Permission>;
}

/**
 * Server-side patient scoping. The patient id from the client is never trusted:
 * the caller must be an ACTIVE member of that patient's care circle.
 * Non-members get 404 so the patient's existence is not leaked.
 */
export async function resolvePatientContext(
  db: Db,
  clock: Clock,
  actor: Actor,
  patientId: string,
  opts: { tokenPatientId?: string | null } = {},
): Promise<PatientContext> {
  if (!isUuid(patientId)) throw notFound("Patient not found");
  if (opts.tokenPatientId && opts.tokenPatientId !== patientId) throw notFound("Patient not found");
  if (actor.type === "SYSTEM") {
    const p = await db.patient.findUnique({ where: { id: patientId }, select: { id: true } });
    if (!p) throw notFound("Patient not found");
    return { db, clock, actor, patientId, member: null, permissions: new Set() };
  }
  if (!actor.userId) throw new DomainError("UNAUTHENTICATED", "Sign in required");
  const member = await db.careCircleMember.findUnique({
    where: { patientId_userId: { patientId, userId: actor.userId } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  if (!member || member.status !== "ACTIVE") throw notFound("Patient not found");
  return { db, clock, actor, patientId, member, permissions: permissionsFor({ role: member.role as RoleName, messageAccessGranted: member.messageAccessGranted, status: member.status }) };
}

export function requirePermission(ctx: PatientContext, p: Permission) {
  if (ctx.actor.type === "SYSTEM") return;
  if (!ctx.permissions.has(p)) throw forbidden(`This needs the "${p}" permission, which your role doesn't have.`);
}

export function can(ctx: PatientContext, p: Permission) {
  return ctx.actor.type === "SYSTEM" || ctx.permissions.has(p);
}

export function requireMember(ctx: PatientContext): MemberWithUser {
  if (!ctx.member) throw forbidden("Only care-circle members can do this.");
  return ctx.member;
}

export async function ctxAudit(ctx: PatientContext, e: Omit<AuditEntry, "patientId">, db: Db = ctx.db) {
  await audit(db, ctx.actor, { ...e, patientId: ctx.patientId }, await ctx.clock.now());
}

/** Same context bound to a transaction client. */
export function withDb(ctx: PatientContext, db: Db): PatientContext {
  return { ...ctx, db };
}
