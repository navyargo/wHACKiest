import { PrismaClient, Prisma } from "@prisma/client";

export type Db = PrismaClient | Prisma.TransactionClient;
export { Prisma };

const g = globalThis as unknown as { __carerelayPrisma?: PrismaClient };

/** Process-wide Prisma client (reused across Next.js hot reloads). */
export function getDb(): PrismaClient {
  if (!g.__carerelayPrisma) g.__carerelayPrisma = new PrismaClient();
  return g.__carerelayPrisma;
}

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
