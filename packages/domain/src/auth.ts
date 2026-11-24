import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db } from "./db";

export const SESSION_TTL_MS = 12 * 3_600_000;
export const MCP_TOKEN_TTL_MS = 15 * 60_000;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function createSession(db: Db, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  return token;
}

export async function getSessionUser(db: Db, token: string | undefined | null) {
  if (!token) return null;
  const s = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!s || s.expiresAt < new Date()) return null;
  return s.user;
}

export async function deleteSession(db: Db, token: string) {
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

/** Issue a short-lived, patient-scoped MCP bearer token. Only its hash is stored. */
export async function issueMcpToken(db: Db, userId: string, patientId: string | null, label: string, ttlMs = MCP_TOKEN_TTL_MS) {
  const token = `crt_${randomBytes(24).toString("base64url")}`;
  await db.mcpToken.create({ data: { userId, patientId, label, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

export async function resolveMcpToken(db: Db, token: string | undefined | null) {
  if (!token) return null;
  const t = await db.mcpToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!t || t.revokedAt || t.expiresAt < new Date()) return null;
  return { user: t.user, patientId: t.patientId, tokenId: t.id, label: t.label };
}
