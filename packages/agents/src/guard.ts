/**
 * Medical-content guard. CareRelay records, compares, flags and routes — it never advises on
 * doses, skips, repeats, medication changes, diagnoses, or which of two instructions is right.
 * Applied to every user question sent to the assistant and every AI-generated answer/summary.
 */
export const SAFETY_MESSAGE =
  "This needs a decision from an authorised person (doctor / care lead). CareRelay can't advise on this.";

const DOSE_WORDS = "(?:dose|doses|tablet|tablets|pill|pills|medicine|medicines|medication|insulin|capsule|capsules|injection)";

/** Questions asking CareRelay to make a clinical decision. */
const QUESTION_PATTERNS: RegExp[] = [
  new RegExp(`\\b(should|can|could|shall|do|must|may)\\s+(i|we|you|she|he|they|amma|meena|ravi|suresh|priya)\\b[^?.]*\\b(give|take|administer|repeat|skip|miss|stop|double|halve|increase|decrease|reduce|change|restart)\\b`, "i"),
  new RegExp(`\\b(another|extra|second|one more|additional|double|half|missed)\\s+${DOSE_WORDS}`, "i"),
  new RegExp(`\\b(skip|repeat|double|halve|increase|decrease|reduce|adjust|change|stop)\\s+(the|her|his|their|this|that|a|my)?\\s*${DOSE_WORDS}`, "i"),
  /\bwhich\s+(prescription|instruction|version|dose|medicine|one)\b[^?]*\b(right|correct|follow|valid|better|true)\b/i,
  /\b(is it|is that|would it be)\s+(safe|ok|okay|fine|dangerous)\s+to\b/i,
  /\bhow\s+(much|many)\s+[^?]*(give|take)\b/i,
  /\bwhat\s+(dose|dosage|medicine|medication)\s+(should|to)\b/i,
  /\b(diagnos\w*|what (is wrong|disease|condition)|is (she|he|amma) (sick|ill|having)|does (she|he|amma) have)\b/i,
];

/** AI output that gives clinical advice. */
const OUTPUT_PATTERNS: RegExp[] = [
  new RegExp(`\\b(give|administer|take|offer)\\s+(her|him|them|amma|the patient)?\\s*(another|an extra|a second|one more|an additional|a double|half)\\b`, "i"),
  new RegExp(`\\byou\\s+(should|can|could|may|must|need to)\\s+(give|administer|skip|repeat|stop|double|increase|decrease|reduce|hold|withhold|restart)\\b`, "i"),
  new RegExp(`\\b(skip|omit|hold|withhold|repeat|double|halve|increase|decrease|reduce)\\s+(the|her|his|their|this|tonight's|today's|next|a)?\\s*${DOSE_WORDS}`, "i"),
  /\b(it is|it's|that is|that's)\s+(safe|fine|ok|okay)\s+to\s+(give|take|skip|repeat|double)\b/i,
  /\b(the\s+)?(correct|right|valid)\s+(prescription|instruction|version|dose)\s+is\b/i,
  /\b(version\s*\d|v\d|the (old|new|first|second) (prescription|version))\s+is\s+(correct|right|the one to follow)\b/i,
  /\b(follow|use)\s+the\s+(old|new|first|second|earlier|later)\s+(prescription|instruction|version)\b/i,
  /\b(she|he|amma|the patient)\s+(probably|likely|may|might)?\s*(has|have|is suffering from|is showing signs of)\s+(an?\s+)?(infection|sepsis|stroke|hypoglyc\w*|hyperglyc\w*|clot|thrombosis|dvt|pneumonia|uti)\b/i,
  /\bdiagnos(is|ed|e)\b/i,
];

export interface GuardResult {
  blocked: boolean;
  matched?: string;
}

export function checkQuestion(text: string): GuardResult {
  for (const re of QUESTION_PATTERNS) {
    const m = re.exec(text);
    if (m) return { blocked: true, matched: m[0] };
  }
  return { blocked: false };
}

export function checkOutput(text: string): GuardResult {
  for (const re of OUTPUT_PATTERNS) {
    const m = re.exec(text);
    if (m) return { blocked: true, matched: m[0] };
  }
  return { blocked: false };
}

/** Returns the text unchanged, or the safety message if it contains clinical advice. */
export function guardOutput(text: string): { text: string; rewritten: boolean; matched?: string } {
  const r = checkOutput(text);
  return r.blocked ? { text: SAFETY_MESSAGE, rewritten: true, matched: r.matched } : { text, rewritten: false };
}
