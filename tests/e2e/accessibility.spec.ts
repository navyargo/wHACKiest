import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Universal mock router for CareRelay APIs.
 * Ensures the full caregiver UI, landmarks, and domain components render completely
 * across environments for thorough WCAG 2.1 AA accessibility auditing.
 */
async function setupAccessibilityEnvironment(page: Page, userKey: "priya" | "ravi" | "meena" | "suresh" | "arjun" | "clinic") {
  const users = {
    priya: {
      user: { id: "user_priya", name: "Priya Raman", email: "priya@demo.carerelay.local" },
      role: "CARE_COORDINATOR",
      permissions: ["view_patient", "view_messages", "view_documents", "upload_documents", "manage_tasks", "record_care", "resolve_conflicts", "use_assistant"],
    },
    ravi: {
      user: { id: "user_ravi", name: "Ravi Raman", email: "ravi@demo.carerelay.local" },
      role: "PROFESSIONAL_CAREGIVER",
      permissions: ["view_patient", "view_messages", "view_documents", "upload_documents", "record_care", "use_assistant"],
    },
    meena: {
      user: { id: "user_meena", name: "Meena Joseph", email: "meena@demo.carerelay.local" },
      role: "PROFESSIONAL_CAREGIVER",
      permissions: ["view_patient", "view_messages", "view_documents", "upload_documents", "record_care", "use_assistant"],
    },
    suresh: {
      user: { id: "user_suresh", name: "Suresh Kumar", email: "suresh@demo.carerelay.local" },
      role: "PROFESSIONAL_CAREGIVER",
      permissions: ["view_patient", "view_messages", "view_documents", "upload_documents", "record_care", "use_assistant"],
    },
    arjun: {
      user: { id: "user_arjun", name: "Arjun Raman", email: "arjun@demo.carerelay.local" },
      role: "REMOTE_VIEWER",
      permissions: ["view_patient", "use_assistant"],
    },
    clinic: {
      user: { id: "user_clinic", name: "Dr. Clinic", email: "clinic@demo.carerelay.local" },
      role: "CLINICAL_VERIFIER",
      permissions: ["view_patient", "view_messages", "view_documents", "upload_documents", "verify_medical", "resolve_conflicts", "use_assistant"],
    },
  };

  const current = users[userKey];

  const mockStatus = {
    date: "2026-11-24",
    now: "2026-11-24T08:00:00Z",
    tasksToday: 3,
    uncovered: 1,
    overdue: 1,
    completed: 1,
    openConflicts: 0,
    openAlerts: 1,
    topAlerts: [
      { id: "alert_1", title: 'Nobody owns "Medicine A (Aspirin 75mg)"', level: "URGENT" },
    ],
    lowStock: [
      { name: "Aspirin 75mg", label: "2 doses left" },
    ],
    uncoveredTasks: [
      { id: "task_2", title: "Medicine A (Aspirin 75mg) — Morning Dose", time: "08:00", assigneeName: null },
    ],
    nextTasks: [
      { id: "task_1", title: "Morning Blood Pressure & Heart Rate Check", time: "08:00", state: "AWAITING_ACKNOWLEDGEMENT", assigneeName: "Ravi Raman", covered: true },
      { id: "task_2", title: "Medicine A (Aspirin 75mg) — Morning Dose", time: "08:00", state: "OVERDUE", assigneeName: null, covered: false },
      { id: "task_3", title: "Evening Physiotherapy & Mobility", time: "18:00", state: "ASSIGNED", assigneeName: "Meena Joseph", covered: true },
    ],
  };

  const mockTasks = {
    date: "2026-11-24",
    now: "2026-11-24T08:00:00Z",
    tasks: [
      {
        id: "task_1",
        title: "Morning Blood Pressure & Heart Rate Check",
        state: "AWAITING_ACKNOWLEDGEMENT",
        version: 1,
        scheduledAt: "2026-11-24T08:00:00Z",
        localTime: "08:00",
        windowStart: "2026-11-24T07:30:00Z",
        windowEnd: "2026-11-24T08:30:00Z",
        category: "VITALS",
        priority: "ROUTINE",
        covered: true,
        acknowledgedAt: null,
        completedByName: null,
        completedAt: null,
        assigneeMemberId: `member_user_${userKey}`,
        assigneeName: current.user.name,
        nonRepeatable: false,
        requiredQualification: null,
        actions: [
          { event: "ACKNOWLEDGE", allowed: true },
          { event: "START", allowed: true },
          { event: "COMPLETE", allowed: true },
          { event: "DECLINE", allowed: true },
          { event: "REASSIGN", allowed: true },
        ],
      },
      {
        id: "task_2",
        title: "Medicine A (Aspirin 75mg) — Morning Dose",
        state: "OVERDUE",
        version: 1,
        scheduledAt: "2026-11-24T08:00:00Z",
        localTime: "08:00",
        windowStart: "2026-11-24T07:30:00Z",
        windowEnd: "2026-11-24T08:30:00Z",
        category: "MEDICATION",
        priority: "URGENT",
        covered: false,
        acknowledgedAt: null,
        completedByName: null,
        completedAt: null,
        assigneeMemberId: null,
        assigneeName: null,
        nonRepeatable: true,
        requiredQualification: null,
        actions: [
          { event: "CLAIM", allowed: true },
          { event: "RECORD_ADMINISTRATION", allowed: true },
          { event: "ASSIGN", allowed: true },
        ],
      },
      {
        id: "task_3",
        title: "Evening Physiotherapy & Mobility",
        state: "COMPLETED",
        version: 2,
        scheduledAt: "2026-11-24T18:00:00Z",
        localTime: "18:00",
        windowStart: "2026-11-24T17:30:00Z",
        windowEnd: "2026-11-24T18:30:00Z",
        category: "CARE",
        priority: "ROUTINE",
        covered: true,
        acknowledgedAt: "2026-11-24T17:00:00Z",
        completedByName: "Meena Joseph",
        completedAt: "2026-11-24T18:15:00Z",
        assigneeMemberId: `member_user_meena`,
        assigneeName: "Meena Joseph",
        nonRepeatable: false,
        requiredQualification: null,
        actions: [],
      },
    ],
    restrictions: [],
  };

  const mockDetail = {
    document: {
      id: "doc_v2",
      title: "Discharge Prescription v2",
      kind: "PRESCRIPTION",
      versionNumber: 2,
      rawText: "Discharge Prescription v2 Instructions\n1. Atorvastatin 40mg with lunch\n2. Metoprolol 25mg at bedtime",
      createdAt: "2026-11-24T10:00:00Z",
      uploadedByName: "Dr. Clinic",
      versionGroupId: "group_rx",
    },
    items: [
      {
        id: "item_1",
        itemType: "MEDICATION",
        payload: { name: "Atorvastatin", strength: "40mg", times: ["13:00"], instructions: "Take with lunch" },
        confidence: 0.98,
        status: "PENDING",
        uncertaintyNote: null,
        sourceSpan: { start: 39, end: 77 },
        detectedBy: "Intake Agent",
        rejectionReason: null,
      },
      {
        id: "item_2",
        itemType: "MEDICATION",
        payload: { name: "Metoprolol", strength: "25mg", times: ["20:00"], instructions: "Take at bedtime" },
        confidence: 0.95,
        status: "PENDING",
        uncertaintyNote: null,
        sourceSpan: { start: 81, end: 111 },
        detectedBy: "Intake Agent",
        rejectionReason: null,
      },
    ],
    versions: [
      { id: "doc_v1", versionNumber: 1, createdAt: "2026-11-23T10:00:00Z" },
      { id: "doc_v2", versionNumber: 2, createdAt: "2026-11-24T10:00:00Z" },
    ],
    approval: {
      id: "app_1",
      state: "PENDING",
      version: 1,
      title: "Prescription update v2",
      reason: null,
      decidedAt: null,
    },
    diff: [
      {
        change: "MODIFIED",
        medication: "Atorvastatin",
        fields: [{ field: "strength", old: "20mg", new: "40mg" }],
      },
      {
        change: "ADDED",
        medication: "Metoprolol 25mg",
        fields: [{ field: "dose", old: "—", new: "25mg at 20:00" }],
      },
    ],
    previous: { id: "doc_v1", versionNumber: 1 },
  };

  await page.route(/\/api\/.*/, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/me")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: current.user,
          patients: [
            {
              id: "patient_amma",
              displayName: "Amma (Kalyani)",
              age: 78,
              timezone: "Asia/Kolkata",
              role: current.role,
              memberId: `member_user_${userKey}`,
              permissions: current.permissions,
            },
          ],
          demoMode: true,
          now: "2026-11-24T08:00:00Z",
          ai: { mode: "MOCK", label: "Offline AI mode — rule-based", provider: "Offline" },
          voiceEnabled: false,
          storage: "local",
        }),
      });
    }

    if (path.includes("/demo/accounts")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accounts: Object.values(users).map((u) => ({
            email: u.user.email,
            name: u.user.name,
            role: u.role,
          })),
        }),
      });
    }

    if (path.includes("/demo/state")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          now: "2026-11-24T08:00:00Z",
          offsetMinutes: 0,
          scenarios: [
            { id: 1, title: "Assumption gap: alert → reassign → accept", summary: "Unassigned medication task" },
            { id: 2, title: "Duplicate administration: flagged for verification", summary: "Two caregivers recording dose" },
            { id: 3, title: "Prescription v2: diff → verifier approval", summary: "Clinician approves v2 prescription" },
            { id: 4, title: "Handover: send → acknowledge", summary: "Meena hands over to Suresh" },
          ],
        }),
      });
    }

    if (path.includes("/status")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockStatus) });
    }

    if (path.includes("/tasks")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTasks) });
    }

    if (path.includes("/circle")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          members: [
            { id: "member_user_priya", name: "Priya Raman", role: "CARE_COORDINATOR", phone: "+91 98765 43210" },
            { id: "member_user_ravi", name: "Ravi Raman", role: "PROFESSIONAL_CAREGIVER", phone: "+91 98765 43211" },
            { id: "member_user_meena", name: "Meena Joseph", role: "PROFESSIONAL_CAREGIVER", phone: "+91 98765 43212" },
          ],
          unavailabilities: [],
        }),
      });
    }

    if (path.includes("/alerts")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          alerts: [
            {
              id: "alert_1",
              ruleId: "GAP-001",
              title: 'Nobody owns "Medicine A (Aspirin 75mg)"',
              severity: "URGENT",
              createdAt: "2026-11-24T07:00:00Z",
              summary: "Task is unassigned with 60 minutes remaining in the administration window.",
              why: "Rule GAP-001 requires high-risk morning medications to be acknowledged.",
              evidence: "Scheduled for 08:00.",
              affectedRole: "Morning Nurse / Caregiver",
              assigneeName: null,
              taskId: "task_2",
              actions: ["ASSIGN", "CALL"],
            },
          ],
        }),
      });
    }

    if (path.includes("/handovers")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          handovers: [
            {
              id: "h_1",
              fromName: "Meena Joseph",
              toName: "Suresh Kumar",
              createdAt: "2026-11-24T14:00:00Z",
              acknowledgedAt: null,
              audioUrl: null,
              aiSummary: "Morning shift completed smoothly. Vitals stable at 124/82. Left knee slight swelling noted; kept elevated.",
              snapshot: {
                completed: ["Morning vitals recorded (124/82)", "Aspirin 75mg administered", "Breakfast assistance"],
                upcoming: ["Physiotherapy at 18:00", "Evening medication at 20:00"],
                concerns: ["Left knee mild swelling noted at 13:30; kept elevated."],
              },
            },
          ],
        }),
      });
    }

    if (path.includes("/documents")) {
      if (path.includes("/documents/doc_v2")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockDetail) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ documents: [mockDetail.document] }) });
    }

    if (path.includes("/notifications")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [] }) });
    }

    if (path.includes("/approvals")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ approvals: [] }) });
    }

    if (path.endsWith("/patient_amma")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "patient_amma",
          displayName: "Amma (Kalyani)",
          age: 78,
          timezone: "Asia/Kolkata",
          restrictions: [],
          allergies: [],
          mobilityNotes: "",
        }),
      });
    }

    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript((id: string) => {
    localStorage.setItem(`cr_onboarded_${id}`, "1");
  }, current.user.id);
}

test.describe("Frontend Accessibility Suite (WCAG 2.1 AA Compliance)", () => {
  test("1. Dashboard: primary caregiver view passes WCAG 2.1 AA without critical/serious issues", async ({ page }) => {
    await setupAccessibilityEnvironment(page, "priya");
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#main")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("2. Task Acceptance: caregiver task acceptance controls pass WCAG 2.1 AA", async ({ page }) => {
    await setupAccessibilityEnvironment(page, "ravi");
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#main")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" }).first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("3. Handover Snapshot: shift handover and summary pass WCAG 2.1 AA", async ({ page }) => {
    await setupAccessibilityEnvironment(page, "meena");
    await page.goto("/handover");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#main")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("4. Conflict / Approval Diff: prescription diff approval view passes WCAG 2.1 AA", async ({ page }) => {
    await setupAccessibilityEnvironment(page, "clinic");
    await page.goto("/documents/doc_v2");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#main")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("5. Remote Viewer: family member remote view passes WCAG 2.1 AA", async ({ page }) => {
    await setupAccessibilityEnvironment(page, "arjun");
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#main")).toBeVisible();
    await expect(page.getByRole("heading", { name: /How Amma .* is doing today/, level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("6. Login and Auth View passes WCAG 2.1 AA", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#main")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
