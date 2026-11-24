import { describe, expect, it } from "vitest";
import { diffMedicationInstructions, hasMaterialChanges, type MedInstruction } from "@carerelay/domain";

const m = (name: string, times: string[], over: Partial<MedInstruction> = {}): MedInstruction => ({ name, strength: "5 mg", doseText: "1 tablet", times, frequencyText: "once daily", instructions: "after food", refId: name, ...over });

describe("prescription diff (CON-002)", () => {
  it("detects changed timing, added and removed medicines field by field", () => {
    const d = diffMedicationInstructions([m("Medicine A", ["08:00", "20:00"]), m("Medicine B", ["08:00"]), m("Medicine X", ["09:00"])], [m("Medicine A", ["20:00", "08:00"]), m("Medicine B", ["13:00"], { instructions: "after lunch" }), m("Medicine D", ["08:00"])]);
    const by = Object.fromEntries(d.map((e) => [e.medication, e]));
    expect(by["Medicine A"].change).toBe("UNCHANGED");
    expect(by["Medicine B"].change).toBe("CHANGED");
    expect(by["Medicine B"].fields).toEqual([{ field: "times", old: "08:00", new: "13:00" }, { field: "instructions", old: "after food", new: "after lunch" }]);
    expect(by["Medicine D"].change).toBe("ADDED");
    expect(by["Medicine X"].change).toBe("REMOVED");
    expect(hasMaterialChanges(d)).toBe(true);
  });
  it("is case/whitespace insensitive on names and values", () => {
    const d = diffMedicationInstructions([m("Medicine A", ["08:00"])], [m("medicine  a", ["08:00"], { instructions: "After  food" })]);
    expect(d[0].change).toBe("UNCHANGED");
    expect(hasMaterialChanges(d)).toBe(false);
  });
});
