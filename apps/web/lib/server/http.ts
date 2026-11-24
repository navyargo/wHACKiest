/** Route table runtime: auth, patient scoping, Zod validation, idempotency, error mapping. */
import { ZodError, type ZodTypeAny, type z } from "zod";
import { DomainError, getSessionUser, resolvePatientContext, runSweep, type PatientContext, isDemoMode } from "@carerelay/domain";
import type { Prisma, User } from "@prisma/client";
import { deps } from "./deps";

export const SESSION_COOKIE = "cr_session";

export interface HandlerCtx<B, Q> {
  req: Request;
  params: Record<string, string>;
  body: B;
  query: Q;
  user: User | null;
  ctx: PatientContext | null;
  idempotencyKey: string | null;
}

export interface RouteDef<B extends ZodTypeAny = ZodTypeAny, Q extends ZodTypeAny = ZodTypeAny> {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  auth: "public" | "session" | "demo";
  /** Mutations need an Idempotency-Key and are replay-safe. */
  mutate?: boolean;
  /** Re-run the care sweep after a successful mutation so alerts reflect the change immediately. */
  sweepAfter?: boolean;
  body?: B;
  query?: Q;
  handler: (c: HandlerCtx<z.infer<B>, z.infer<Q>>) => Promise<unknown>;
}

export const route = <B extends ZodTypeAny, Q extends ZodTypeAny>(r: RouteDef<B, Q>) => r as unknown as RouteDef;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
const errorJson = (status: number, code: string, message: string, details?: unknown) => json({ error: { code, message, details } }, status);

function cookie(req: Request, name: string) {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function dispatch(routes: RouteDef[], req: Request, segments: string[]): Promise<Response> {
  const path = "/" + segments.join("/");
  let found: { r: RouteDef; params: Record<string, string> } | null = null;
  let pathMatched = false;
  for (const r of routes) {
    const p = match(r.path, path);
    if (!p) continue;
    pathMatched = true;
    if (r.method === req.method) {
      found = { r, params: p };
      break;
    }
  }
  if (!found) return errorJson(pathMatched ? 405 : 404, "NOT_FOUND", "No such endpoint");
  const { r, params } = found;
  const { db, clock } = deps();
  try {
    if (r.auth === "demo" && !isDemoMode()) return errorJson(404, "DEMO_ONLY", "Demo Mode is off");
    const user = await getSessionUser(db, cookie(req, SESSION_COOKIE));
    if (r.auth !== "public" && !user) return errorJson(401, "UNAUTHENTICATED", "Please sign in");

    let ctx: PatientContext | null = null;
    if (params.pid) ctx = await resolvePatientContext(db, clock, { type: "USER", userId: user!.id, name: user!.name, via: "REST" }, params.pid);

    const url = new URL(req.url);
    const query = r.query ? r.query.parse(Object.fromEntries(url.searchParams)) : {};
    let body: unknown = {};
    if (r.body) {
      const raw = await req.json().catch(() => {
        throw new DomainError("VALIDATION_ERROR", "Body must be JSON");
      });
      body = r.body.parse(raw);
    }

    let idemKey: string | null = null;
    if (r.mutate) {
      idemKey = req.headers.get("idempotency-key");
      if (!idemKey || idemKey.length < 8 || idemKey.length > 200) return errorJson(400, "IDEMPOTENCY_KEY_REQUIRED", "Mutating requests need an Idempotency-Key header");
      const scoped = `${user?.id ?? "anon"}:${idemKey}`;
      const prior = await db.idempotencyRecord.findUnique({ where: { key: scoped } });
      if (prior) return json(prior.response, prior.status, { "idempotent-replay": "true" });
    }

    const result = await r.handler({ req, params, body, query, user, ctx, idempotencyKey: idemKey });
    if (result instanceof Response) return result;
    if (r.mutate && idemKey) {
      await db.idempotencyRecord.create({ data: { key: `${user?.id ?? "anon"}:${idemKey}`, userId: user?.id ?? "00000000-0000-0000-0000-000000000000", route: `${r.method} ${r.path}`, status: 200, response: (result ?? null) as Prisma.InputJsonValue } }).catch(() => undefined);
    }
    if (r.sweepAfter && ctx) await runSweep(db, clock, ctx.patientId).catch((e) => console.error("[sweep-after]", (e as Error).message));
    return json(result ?? { ok: true });
  } catch (e) {
    if (e instanceof DomainError) return errorJson(e.status, e.code, e.message, e.details);
    if (e instanceof ZodError) return errorJson(400, "VALIDATION_ERROR", "Invalid input", e.issues);
    console.error(`[api] ${req.method} ${path}`, e);
    return errorJson(500, "INTERNAL", "Something went wrong. Please retry.");
  }
}
