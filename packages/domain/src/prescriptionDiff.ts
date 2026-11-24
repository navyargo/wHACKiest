/** CON-002 support: structured, field-by-field diff between active and newly proposed medication instructions. Pure. */
export interface MedInstruction {
  name: string;
  strength: string;
  doseText: string;
  times: string[];
  frequencyText: string;
  instructions: string;
  /** CarePlanItem id (active) or ExtractedItem id (proposed). */
  refId: string;
}

export type DiffField = "strength" | "doseText" | "times" | "frequencyText" | "instructions";
export interface DiffEntry {
  change: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED";
  medication: string;
  fields: { field: DiffField; old: string; new: string }[];
  oldRefId: string | null;
  newRefId: string | null;
}

export const medKey = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const FIELDS: DiffField[] = ["strength", "doseText", "times", "frequencyText", "instructions"];
const val = (m: MedInstruction, f: DiffField) => (f === "times" ? [...m.times].sort().join(", ") : m[f]);

export function diffMedicationInstructions(active: MedInstruction[], proposed: MedInstruction[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  const activeByKey = new Map(active.map((m) => [medKey(m.name), m]));
  const seen = new Set<string>();
  for (const p of proposed) {
    const k = medKey(p.name);
    seen.add(k);
    const a = activeByKey.get(k);
    if (!a) {
      out.push({ change: "ADDED", medication: p.name, fields: FIELDS.map((f) => ({ field: f, old: "", new: val(p, f) })).filter((x) => x.new), oldRefId: null, newRefId: p.refId });
      continue;
    }
    const fields = FIELDS.filter((f) => norm(val(a, f)) !== norm(val(p, f))).map((f) => ({ field: f, old: val(a, f), new: val(p, f) }));
    out.push({ change: fields.length ? "CHANGED" : "UNCHANGED", medication: p.name, fields, oldRefId: a.refId, newRefId: p.refId });
  }
  for (const a of active) {
    if (!seen.has(medKey(a.name))) out.push({ change: "REMOVED", medication: a.name, fields: FIELDS.map((f) => ({ field: f, old: val(a, f), new: "" })).filter((x) => x.old), oldRefId: a.refId, newRefId: null });
  }
  return out;
}

export const hasMaterialChanges = (d: DiffEntry[]) => d.some((e) => e.change !== "UNCHANGED");
