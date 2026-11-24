import type { Db } from "./db";
import { diffMedicationInstructions, type DiffEntry, type MedInstruction } from "./prescriptionDiff";
import { MedicationPayloadZ, RecurrenceZ } from "./schemas";

/** Active medication instructions (approved care-plan items) that came from documents in `versionGroupId`. */
export async function activeMedicationInstructions(db: Db, patientId: string, versionGroupId: string): Promise<MedInstruction[]> {
  const docs = await db.sourceDocument.findMany({ where: { patientId, versionGroupId }, select: { id: true } });
  const items = await db.carePlanItem.findMany({ where: { patientId, active: true, category: "MEDICATION", sourceDocumentId: { in: docs.map((d) => d.id) } } });
  const extractedIds = items.map((i) => i.sourceExtractedItemId).filter((x): x is string => !!x);
  const extracted = await db.extractedItem.findMany({ where: { id: { in: extractedIds } } });
  return items.map((item) => {
    const src = extracted.find((e) => e.id === item.sourceExtractedItemId);
    const p = src ? MedicationPayloadZ.safeParse(src.payload) : null;
    const rec = RecurrenceZ.safeParse(item.recurrence);
    return {
      name: p?.success ? p.data.name : item.title,
      strength: p?.success ? p.data.strength : "",
      doseText: p?.success ? p.data.doseText : "",
      times: rec.success ? rec.data.times : [],
      frequencyText: p?.success ? p.data.frequencyText : "",
      instructions: p?.success ? p.data.instructions : item.instructions,
      refId: item.id,
    };
  });
}

/** Field-by-field diff of a document's proposed MEDICATION items against the active plan. */
export async function computeDocumentDiff(db: Db, patientId: string, documentId: string): Promise<DiffEntry[]> {
  const doc = await db.sourceDocument.findFirst({ where: { id: documentId, patientId } });
  if (!doc) return [];
  const proposed = await db.extractedItem.findMany({ where: { patientId, sourceType: "DOCUMENT", sourceId: documentId, itemType: "MEDICATION", status: { not: "REJECTED" } }, orderBy: { createdAt: "asc" } });
  const prop: MedInstruction[] = [];
  for (const x of proposed) {
    const p = MedicationPayloadZ.safeParse(x.payload);
    if (!p.success) continue;
    prop.push({ name: p.data.name, strength: p.data.strength, doseText: p.data.doseText, times: p.data.times, frequencyText: p.data.frequencyText, instructions: p.data.instructions, refId: x.id });
  }
  return diffMedicationInstructions(await activeMedicationInstructions(db, patientId, doc.versionGroupId), prop);
}
