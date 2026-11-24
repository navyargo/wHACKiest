"use client";
import { mutate as globalMutate } from "swr";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function parse(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? "ERROR", e.message ?? `Request failed (${res.status})`, e.details);
  }
  return body;
}

export const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
  return parse(res);
};

/** Mutations always carry a fresh Idempotency-Key; on success every SWR key is revalidated. */
export async function api<T = unknown>(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown, opts: { revalidate?: boolean } = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    return (await parse(res)) as T;
  } finally {
    if (opts.revalidate !== false) void globalMutate(() => true);
  }
}

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === "STALE_VERSION") return "Someone else just updated this. The latest version has been loaded — please try again.";
    return e.message;
  }
  return (e as Error)?.message ?? "Something went wrong";
}
