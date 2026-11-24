// Runs docs/DEMO_SCRIPT.md end to end against a running `pnpm dev` (resets demo data!). Usage: pnpm demo:rehearse <screenshot-dir>
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";
const OUT = process.argv[2];
const B = "http://localhost:3000";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const req = page.request;
const H = () => ({ "idempotency-key": randomUUID() });
async function as(k: string) {
  await req.post(`${B}/api/demo/login`, { data: { email: `${k}@demo.carerelay.local` } });
  const me = await (await req.get(`${B}/api/me`)).json();
  await page.addInitScript((id: string) => localStorage.setItem(`cr_onboarded_${id}`, "1"), me.user.id);
  return me.patients[0].id as string;
}
const step = async (name: string, fn: () => Promise<void>) => { const t = Date.now(); try { await fn(); console.log(`OK   ${name} (${Date.now() - t} ms)`); } catch (e) { console.log(`FAIL ${name}: ${(e as Error).message.split("\n")[0]}`); await page.screenshot({ path: `${OUT}/FAIL-${name.replace(/\W+/g, "_")}.png` }); } };
const snap = (n: string) => page.screenshot({ path: `${OUT}/${n}.png` });

await as("priya");
await req.post(`${B}/api/demo/reset`, { headers: H() });
await as("priya");
await step("today board", async () => { await page.goto(B); await page.getByText("No owner").first().waitFor(); await snap("01-today"); });
await step("scenario 2 duplicate", async () => {
  const r = await (await req.post(`${B}/api/demo/scenarios/2`, { headers: H() })).json();
  await as("ravi"); await page.goto(B + r.next[0].href);
  await page.getByRole("button", { name: "Record given" }).click();
  await page.getByLabel(/Declaration/).fill("Gave it after breakfast");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.getByText(/recorded this occurrence/).waitFor(); await snap("02-duplicate-warning");
  await page.getByRole("button", { name: /flag for verification/ }).click();
  await page.getByText("Second record — needs verification").waitFor(); await snap("03-conflicting");
});
await step("scenario 6 coverage agent", async () => {
  await as("priya"); await req.post(`${B}/api/demo/scenarios/6`, { headers: H() });
  await page.goto(B + "/alerts"); await page.getByRole("button", { name: /unavailable for "Wound dressing/ }).click();
  await page.getByRole("button", { name: "Suggest who is free" }).click();
  await page.getByText(/Coverage Agent: Proposed Suresh/).waitFor(); await snap("04-coverage-agent");
  await page.keyboard.press("Escape");
  await page.goto(B + "/approvals"); await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByText("Approved and carried out").waitFor(); await snap("05-approved");
});
await step("scenario 3 prescription", async () => {
  const r = await (await req.post(`${B}/api/demo/scenarios/3`, { headers: H() })).json();
  await as("clinic"); await page.goto(B + r.next[0].href);
  await page.getByRole("cell", { name: "13:00" }).waitFor(); await snap("06-diff");
  await page.getByRole("button", { name: "Approve & activate" }).click();
  await page.getByText(/Approved — instructions are active/).waitFor();
});
await step("scenario 1 assumption gap", async () => {
  await as("priya"); await req.post(`${B}/api/demo/scenarios/1`, { headers: H() });
  await page.goto(B + "/alerts"); await page.getByRole("button", { name: /Nobody owns "Medicine A/ }).click();
  await page.getByText("Rule GAP-001").waitFor(); await snap("07-gap001-drawer");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await page.getByRole("listitem").filter({ hasText: "Ravi Raman" }).getByRole("button", { name: "Choose" }).click();
  await page.getByText(/isn't covered until they accept/).waitFor();
  await as("ravi"); await page.goto(B);
  const row = page.getByRole("listitem").filter({ hasText: "20:00" }).filter({ hasText: "Medicine A" });
  await row.getByRole("button", { name: "Accept" }).click(); await row.getByText("Accepted", { exact: true }).waitFor();
});
await step("scenario 4 handover", async () => {
  await as("priya"); await req.post(`${B}/api/demo/scenarios/4`, { headers: H() });
  await as("meena"); await page.goto(B + "/handover");
  await page.getByRole("button", { name: "New handover" }).click();
  await page.getByLabel("Hand over to").selectOption({ label: "Suresh Kumar" });
  await page.getByRole("button", { name: "Draft with Handover Agent" }).click();
  await page.getByText(/Summary \(Handover Agent/).waitFor(); await snap("08-handover-draft");
  await page.getByRole("button", { name: "Send handover" }).click(); await page.getByText(/not yet read/).first().waitFor();
  await as("suresh"); await page.goto(B + "/handover");
  await page.getByRole("button", { name: /Meena → Suresh/ }).first().click();
  await page.getByRole("button", { name: "I have read this handover" }).click(); await page.getByText(/read by Suresh/).waitFor();
});
await step("assistant", async () => {
  await as("priya"); await page.goto(B + "/assistant");
  await page.getByLabel("Ask about Amma's care").fill("What still needs attention for Amma tonight?");
  await page.getByRole("button", { name: "Ask" }).click();
  await page.getByText(/get_care_status ·/).first().waitFor(); await snap("09-assistant");
});
await step("mobile today", async () => { await page.setViewportSize({ width: 390, height: 844 }); await page.goto(B); await page.waitForTimeout(1500); await snap("10-mobile"); });
await browser.close();
