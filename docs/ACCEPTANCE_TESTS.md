# Acceptance criteria (flagship scenarios)

Automated coverage noted in brackets: [U] unit, [I] integration, [E] Playwright.

**1. Assumption gap** [U GAP-001, E1]
Given a HIGH-priority task with no assignee whose window opens within 3 h, When the sweep runs, Then a GAP-001 alert explains "nobody owns this", lists evidence and responders; When the coordinator reassigns to a candidate, Then the task is `AWAITING_ACKNOWLEDGEMENT` and the alert stays until the candidate acknowledges; When they acknowledge, Then the next sweep resolves the alert.

**2. Duplicate administration** [I, E2]
Given a medication occurrence with a `RECORDED` administration by Meena, When Ravi records the same occurrence, Then he sees Meena's record and time and is not told whether to give a dose; When he confirms he also gave it, Then a `DISPUTED` record and a `DUPLICATE_ADMINISTRATION` conflict are created, the task is `CONFLICTING`, and Meena's record is unchanged.

**3. Prescription conflict** [U CON-002 diff, E3]
Given prescription v1 is active, When v2 is uploaded, Then extracted items are `PROPOSED`, a field-by-field diff (timing changed, medicine added) is shown, a CON-002 conflict is opened, and the schedule is unchanged; When the clinical verifier approves, Then the new items are active, the superseded items are inactive but kept, future tasks follow v2, and v1 remains viewable.

**4. Incomplete handover** [U HND-001, I, E4]
Given Meena's working hours ended and no handover was sent, Then HND-001 fires; When she sends one and Suresh clicks "I have read this handover", Then the handover is `ACKNOWLEDGED` and every task in it keeps its state.

**5. Inventory shortage** [U INV-001/002, projection]
Given verified stock projects below the reorder threshold with no replenishment owner, Then INV-001 fires with the projection (labelled "Estimate — needs verification" when stock verification is stale or a record is disputed); When someone takes ownership of a replenishment, Then the alert resolves.

**6. Caregiver unavailable** [U GAP-005, E]
Given Meena declares herself unavailable during her assigned wound-care window, Then GAP-005 fires; `find_available_caregivers` ranks only `WOUND_CARE_TRAINED` free members first; assigning to an unqualified member is refused.

**7. Contradictory reports** [U CON-001]
Given a completion record "done" and a later report "she hasn't had her medicine yet" for the same occurrence, Then a CON-001 conflict shows both reports side by side and the task becomes `CONFLICTING` until resolved with a note.

**8. Silent failure** [U GAP-003]
Given a task window has passed without a completion record, Then the task becomes `OVERDUE`, GAP-003 fires and escalates per policy.

**9. Post-discharge extraction** [I]
Given the discharge summary is uploaded, Then wound care, physio restriction and follow-up appointment items are proposed with source spans; none become active until a `verify_medical` approval, after which tasks are generated.

**10. Remote family view** [I cross-access, E]
Given Arjun is a `REMOTE_VIEWER`, Then he sees consolidated status only; requests for messages or documents return 403, and requests for another patient return 404.

**Care Assistant** [E5]: "What still needs attention for Amma tonight?" is answered through visible MCP tool calls with cited sources; "Should I give another tablet?" is refused with the safety message.
