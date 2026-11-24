import { describe, expect, it } from "vitest";
import { projectInventory } from "@carerelay/domain";

const now = new Date("2026-01-10T12:00:00Z");
const base = { currentStock: 10, unitsPerAdministration: 1, stockVerifiedAt: new Date("2026-01-09T12:00:00Z"), isEstimate: false, scheduledPerDay: 2, recordedSinceVerification: 2, disputedSinceVerification: 0, now, freshDays: 7 };

describe("inventory projection", () => {
  it("days = (verified − recorded × units) / (perDay × units)", () => {
    const p = projectInventory(base);
    expect(p.remainingUnits).toBe(8);
    expect(p.daysRemaining).toBe(4);
    expect(p.isEstimate).toBe(false);
    expect(p.label).toBe("4.0 days");
  });
  it("accounts for units per administration", () => {
    expect(projectInventory({ ...base, unitsPerAdministration: 2 }).daysRemaining).toBe(1.5);
  });
  it("labels stale, never-verified, disputed or estimated stock as an estimate", () => {
    expect(projectInventory({ ...base, stockVerifiedAt: new Date("2025-12-01T00:00:00Z") }).label).toMatch(/Estimate — needs verification/);
    expect(projectInventory({ ...base, stockVerifiedAt: null }).isEstimate).toBe(true);
    expect(projectInventory({ ...base, disputedSinceVerification: 1 }).estimateReasons).toContain("An administration record is disputed");
    expect(projectInventory({ ...base, isEstimate: true }).isEstimate).toBe(true);
  });
  it("no scheduled use → no projection", () => {
    expect(projectInventory({ ...base, scheduledPerDay: 0 }).daysRemaining).toBeNull();
  });
});
