/** Synthetic demo documents. Fictional medicines ("Medicine A…") — not medical guidance. */
export const prescriptionV1 = (date: string) => `Dr. S. Nair, MD — General Medicine (fictional clinic)
Patient: Kamala R. ("Amma"), 78 F        Date: ${date}
SYNTHETIC DEMO DOCUMENT — NOT MEDICAL GUIDANCE

Rx
1. Medicine A 500 mg tablet — 1 tablet — twice daily at 08:00 and 20:00 — after food
2. Medicine B 5 mg tablet — 1 tablet — once daily at 08:00 — before breakfast
3. Medicine C 40 mg tablet — 1 tablet — once daily at 21:00 — after dinner

Review after 2 weeks.
`;

export const prescriptionV2 = (date: string) => `Dr. S. Nair, MD — General Medicine (fictional clinic)
Patient: Kamala R. ("Amma"), 78 F        Date: ${date}
SYNTHETIC DEMO DOCUMENT — NOT MEDICAL GUIDANCE

Rx (revised)
1. Medicine A 500 mg tablet — 1 tablet — twice daily at 08:00 and 20:00 — after food
2. Medicine B 5 mg tablet — 1 tablet — once daily at 13:00 — after lunch
3. Medicine C 40 mg tablet — 1 tablet — once daily at 21:00 — after dinner
4. Medicine D 10 mg tablet — 1 tablet — once daily at 08:00 — after breakfast — for 10 days

Review after 2 weeks.
`;

export const dischargeSummary = (date: string, followUp: string) => `CITY ORTHO HOSPITAL (fictional) — DISCHARGE SUMMARY
SYNTHETIC DEMO DOCUMENT — NOT MEDICAL GUIDANCE
Patient: Kamala R. ("Amma"), 78 F        Discharged: ${date}
Procedure: Right total knee replacement.

Home care instructions:
- Wound dressing change: daily at 10:00 by a wound-care trained attendant, for 14 days. Keep the wound dry.
- Physiotherapy exercises: twice daily at 11:00 and 17:00 as taught by the physiotherapist, for 6 weeks.
- Restriction: No stairs without assistance for 6 weeks.
- Restriction: Use the walker for all transfers.
- Follow-up appointment: Dr. Nair clinic on ${followUp} at 16:00 (wound review).
`;

export const homeCareSheet = (date: string, review: string) => `CITY ORTHO HOSPITAL (fictional) — HOME CARE SHEET (page 2 of discharge papers)
SYNTHETIC DEMO DOCUMENT — NOT MEDICAL GUIDANCE
Patient: Kamala R. ("Amma"), 78 F        Date: ${date}

- Blood sugar check: daily at 07:30 before breakfast, write the reading in the diary.
- Ice pack to right knee: twice daily at 14:00 and 19:00, 15 minutes each.
- Restriction: Do not sit cross-legged on the floor for 6 weeks.
- Physiotherapy review: City Ortho physio unit on ${review} at 11:30 (bring exercise chart).
`;
