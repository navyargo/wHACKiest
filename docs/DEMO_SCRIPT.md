# Demo script (≈ 3 min 45 s)

Covers scenarios **2, 6, 3, 1, 4** and ends with the Care Assistant. They run in this order (not 1→4) because the virtual clock only moves forward: the morning scenarios (2, 6) must happen before we jump to the evening (1, 4).

**Before recording:** `pnpm dev` with `DEMO_MODE=true`, open http://localhost:3000, click **Priya Raman**, dismiss the onboarding notice, click **Reset demo data** in the dark demo bar. Virtual time is 08:05. The offline rule-based AI is fine (header shows "Offline AI mode — rule-based").

| Time | Do | Say |
|---|---|---|
| 0:00 | **Today** board as Priya. Point at the coverage strip and the red-edged 20:00 Medicine A ("No owner") and 21:00 Medicine C ("Awaiting acceptance"). | "CareRelay tracks who owns each task and whether they *accepted* it. Assigned isn't covered." |
| 0:20 | Demo bar → **Scenarios** → **2. Duplicate administration** → *Switch to Ravi and try to record the same dose*. Click **Record given**, type a declaration, **Record**. | "Meena already recorded the 08:00 dose. Ravi thinks he should too." |
| 0:40 | Warning modal: point at "Meena Joseph recorded this occurrence at 08:05" and "CareRelay can't advise whether another dose should be given". Click **I already gave it too — flag for verification**. | "We never say whether to give another dose. Both records are kept; the task becomes *Conflicting* and the clinical verifier is alerted (DUP-001)." |
| 1:00 | **Scenarios** → **6. Caregiver unavailable** → *Open the alert…* (as Priya). Open "Meena Joseph is unavailable for Wound dressing change". Show **Why** (rule GAP-005), **Evidence** (her declared block). Click **Suggest who is free**. | "The Coverage Agent calls `find_available_caregivers` and `propose_reassignment` over MCP. Only wound-care-trained, free people qualify — it proposes Suresh. It can only *propose*." |
| 1:30 | Sidebar **Approvals** → Approve the reassignment. (Optional: switch to Suresh → Accept.) | "A human approves; Suresh still has to accept before it's covered." |
| 1:45 | **Scenarios** → **3. Prescription conflict** → *Review the diff… (as clinic coordinator)*. Show the diff table: Medicine B 08:00 → 13:00, Medicine D added. Click **Approve & activate**. | "Prescription v2 was extracted by the Intake Agent through MCP. Nothing changed until the clinical verifier approved. v1 stays in history (CON-002)." |
| 2:15 | Switch to Priya (user switcher). **Scenarios** → **1. Assumption gap** (clock jumps to 17:30). **Alerts** → "Nobody owns Medicine A". Show evidence + responders. **Assign** → choose Ravi. | "Priya's morning message said 'Ravi will give the evening medicine' — Ravi never confirmed (GAP-004, AI-detected). Now it's assigned, but still not covered." |
| 2:45 | Switch to **Ravi** → Today → **Accept** on 20:00 Medicine A. Demo bar **Run sweep now** → Alerts: GAP-001/002 for that task are resolved. | "Covered only when Ravi accepts. The alert closes itself." |
| 3:00 | Switch to Priya. **Scenarios** → **4. Incomplete handover** (clock → 20:20). Alerts shows HND-001. Switch to **Meena** → **Handover** → **New handover** → Suresh → **Draft with Handover Agent** → **Send**. | "Every summary sentence cites a recorded item; uncited sentences are dropped." |
| 3:20 | Switch to **Suresh** → Handover → **I have read this handover**. Point at the note that reading doesn't accept tasks; Today still shows his 21:00 task awaiting acceptance. | "A read receipt isn't acceptance." |
| 3:30 | **Assistant & MCP** → ask **"What still needs attention for Amma tonight?"**. Point at the tool-call chips (`get_care_status`, `list_open_alerts`), the numbered citations, and the live MCP activity panel. | "The assistant only knows what MCP tools return, cites them, and every call is in the audit log." |
| 3:40 | (Optional) ask "Should I give another tablet?" → refusal. | "Clinical questions go to an authorised person." |

Backup: if anything goes wrong, **Reset demo data** and continue from the scenario launcher.
