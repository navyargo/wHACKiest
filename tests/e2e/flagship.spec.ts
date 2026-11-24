import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { resetAndLogin, loginAs, runScenario, patientId } from "./helpers";


test("1. Assumption gap: alert → reassign → candidate accepts → alert resolves", async ({ page }) => {
  await resetAndLogin(page, "priya");
  await runScenario(page, 1);
  await page.goto("/alerts");
  const alert = page.getByRole("button", { name: /Nobody owns "Medicine A/ });
  await expect(alert).toBeVisible();
  await alert.click();
  await expect(page.getByText("Rule GAP-001")).toBeVisible();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const ravi = page.getByRole("listitem").filter({ hasText: "Ravi Raman" });
  await ravi.getByRole("button", { name: "Choose" }).click();
  await expect(page.getByText(/isn't covered until they accept/)).toBeVisible();

  await loginAs(page, "ravi");
  const row = page.getByRole("listitem").filter({ hasText: "20:00" }).filter({ hasText: "Medicine A" });
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(row.getByText("Accepted", { exact: true })).toBeVisible();

  const pid = await patientId(page);
  await page.request.post(`/api/patients/${pid}/sweep`, { headers: { "idempotency-key": randomUUID() } });
  const open = await (await page.request.get(`/api/patients/${pid}/alerts`)).json();
  expect(open.alerts.filter((a: { ruleId: string; title: string }) => ["GAP-001", "GAP-002"].includes(a.ruleId) && a.title.includes("Medicine A"))).toHaveLength(0);
});

test("2. Duplicate administration: warning shows the first record, then flagged for verification", async ({ page }) => {
  await resetAndLogin(page, "priya");
  const r = await runScenario(page, 2);
  const href = r.next[0].href as string;
  await loginAs(page, "ravi");
  await page.goto(href);
  await page.getByRole("button", { name: "Record given" }).click();
  await page.getByLabel(/Declaration/).fill("I gave her the tablet after breakfast");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText(/Meena Joseph recorded this occurrence/)).toBeVisible();
  await expect(page.getByText(/can't advise whether another dose should be given/)).toBeVisible();
  await page.getByRole("button", { name: /flag for verification/ }).click();
  await expect(page.getByText("Conflicting reports").first()).toBeVisible();
  await expect(page.getByText("Second record — needs verification")).toBeVisible();
  await expect(page.getByText("Original record")).toBeVisible();
});

test("3. Prescription v2: diff → verifier approval → schedule updated, old version kept", async ({ page }) => {
  await resetAndLogin(page, "priya");
  const r = await runScenario(page, 3);
  await loginAs(page, "clinic");
  await page.goto(r.next[0].href);
  await expect(page.getByRole("heading", { name: /Changes compared with the active instructions/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "13:00" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Medicine D" })).toBeVisible();
  await page.getByRole("button", { name: "Approve & activate" }).click();
  await expect(page.getByText(/^approved/)).toBeVisible();
  await expect(page.getByRole("link", { name: "v1" })).toBeVisible();
  const pid = await patientId(page);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const tasks = await (await page.request.get(`/api/patients/${pid}/tasks`)).json();
  const date = tasks.date as string;
  const next = await (await page.request.get(`/api/patients/${pid}/tasks?date=${addDay(date)}`)).json();
  void tomorrow;
  expect(next.tasks.some((t: { title: string; localTime: string; state: string }) => t.title.startsWith("Medicine B") && t.localTime === "13:00" && t.state !== "CANCELLED")).toBe(true);
  expect(next.tasks.some((t: { title: string; localTime: string; state: string }) => t.title.startsWith("Medicine D"))).toBe(true);
});
function addDay(d: string) {
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
}

test("4. Handover: send → acknowledge → pending tasks stay pending", async ({ page }) => {
  await resetAndLogin(page, "priya");
  await runScenario(page, 4);
  await loginAs(page, "meena");
  await page.goto("/handover");
  await page.getByRole("button", { name: "New handover" }).click();
  await page.getByLabel("Hand over to").selectOption({ label: "Suresh Kumar" });
  await page.getByRole("button", { name: "Draft with Handover Agent" }).click();
  await expect(page.getByText(/Summary \(Handover Agent/)).toBeVisible();
  await page.getByLabel("Caregiver observations").fill("Knee a little swollen in the evening; leg kept raised.");
  await page.getByRole("button", { name: "Send handover" }).click();
  await expect(page.getByText(/not yet read/).first()).toBeVisible();

  const pid = await patientId(page);
  const before = (await (await page.request.get(`/api/patients/${pid}/tasks`)).json()).tasks.map((t: { id: string; state: string; version: number }) => [t.id, t.state, t.version]);
  await loginAs(page, "suresh");
  await page.goto("/handover");
  await page.getByRole("button", { name: /Meena → Suresh/ }).first().click();
  await page.getByRole("button", { name: "I have read this handover" }).click();
  await expect(page.getByText(/read by Suresh/)).toBeVisible();
  const after = (await (await page.request.get(`/api/patients/${pid}/tasks`)).json()).tasks.map((t: { id: string; state: string; version: number }) => [t.id, t.state, t.version]);
  expect(after).toEqual(before);
  expect(after.some((t: string[]) => t[1] === "AWAITING_ACKNOWLEDGEMENT")).toBe(true);
});

test("5. Care Assistant answers via MCP tool calls with citations and refuses dosing questions", async ({ page }) => {
  await resetAndLogin(page, "priya");
  await page.goto("/assistant");
  await page.getByLabel("Ask about Amma's care").fill("What still needs attention for Amma tonight?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText(/get_care_status ·/).first()).toBeVisible();
  await expect(page.getByText(/list_open_alerts ·/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /task: Medicine A/ }).first()).toBeVisible();
  await expect(page.locator("strong.font-mono", { hasText: "get_care_status" }).first()).toBeVisible();

  await page.getByLabel("Ask about Amma's care").fill("Should I give another tablet?");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("This needs a decision from an authorised person (doctor / care lead). CareRelay can't advise on this.")).toBeVisible();
  await expect(page.getByText(/refused by the medical-content guard/)).toBeVisible();
});

test("10. Remote family view: consolidated status only", async ({ page }) => {
  await resetAndLogin(page, "arjun", { showOnboarding: true });
  await expect(page.getByText(/not an emergency or medical monitoring service/).first()).toBeVisible();
  await page.getByRole("button", { name: "I understand" }).click();
  await expect(page.getByRole("heading", { name: /How Amma is doing today/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Messages" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Documents" })).toHaveCount(0);
  const pid = await patientId(page);
  expect((await page.request.get(`/api/patients/${pid}/messages`)).status()).toBe(403);
});
