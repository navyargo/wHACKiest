import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/** Reset demo data (as anyone) and sign in as the given demo user. */
export async function resetAndLogin(page: Page, key = "priya", opts: { showOnboarding?: boolean } = {}) {
  await page.goto("/login");
  await page.request.post("/api/demo/login", { data: { email: "priya@demo.carerelay.local" } }).catch(() => undefined);
  const r = await page.request.post("/api/demo/reset", { headers: { "idempotency-key": randomUUID() } });
  if (!r.ok()) {
    // First run on an empty DB: seed through the CLI instead.
    throw new Error(`reset failed: ${r.status()} ${await r.text()}`);
  }
  await loginAs(page, key, opts);
}

/** Sign in; by default the one-time safety onboarding is pre-marked as seen (asserted separately). */
export async function loginAs(page: Page, key: string, opts: { showOnboarding?: boolean } = {}) {
  const r = await page.request.post("/api/demo/login", { data: { email: `${key}@demo.carerelay.local` } });
  expect(r.ok()).toBeTruthy();
  const me = await (await page.request.get("/api/me")).json();
  if (!opts.showOnboarding) await page.addInitScript((id: string) => localStorage.setItem(`cr_onboarded_${id}`, "1"), me.user.id);
  await page.goto("/");
}

export async function dismissOnboarding(page: Page) {
  const btn = page.getByRole("button", { name: "I understand" });
  if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) await btn.click();
}

export async function runScenario(page: Page, n: number) {
  const r = await page.request.post(`/api/demo/scenarios/${n}`, { headers: { "idempotency-key": randomUUID() } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

export async function patientId(page: Page) {
  const me = await (await page.request.get("/api/me")).json();
  return me.patients[0].id as string;
}
