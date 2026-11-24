/**
 * DeterministicMockProvider — "Offline AI mode — rule-based".
 * Regex/keyword rules good enough for the seeded demo documents and messages, so the demo runs
 * without network access. It still goes through the same MCP tools and validators as the live model.
 */
import type { ExtractInput, LlmProvider, ToolLoopInput } from "./provider";

type Item = { itemType: string; payload: Record<string, unknown>; quote: string; confidence: number; whyUncertain: string | null };

const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const times = (s: string) => [...s.matchAll(TIME_RE)].map((m) => `${m[1].padStart(2, "0")}:${m[2]}`);
const WORD_NUM: Record<string, number> = { one: 1, two: 2, half: 0.5, three: 3 };

function addDays(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function durationDays(s: string): number | null {
  const m = /for\s+(\d+)\s+(day|days|week|weeks)/i.exec(s);
  if (!m) return null;
  return Number(m[1]) * (m[2].startsWith("week") ? 7 : 1);
}
function category(s: string) {
  if (/dressing|wound|bandage/i.test(s)) return "WOUND_CARE";
  if (/physio|exercise/i.test(s)) return "PHYSIO";
  if (/sugar|glucose|blood pressure|bp check/i.test(s)) return "MONITORING";
  if (/hospital|appointment|doctor|clinic|follow.?up/i.test(s)) return "APPOINTMENT";
  if (/medicine|tablet|pill|dose|medication/i.test(s)) return "MEDICATION";
  return "OTHER";
}
function timeOfDay(s: string) {
  if (/morning|breakfast/i.test(s)) return "morning";
  if (/afternoon|lunch/i.test(s)) return "afternoon";
  if (/evening/i.test(s)) return "evening";
  if (/night|tonight|dinner|bedtime/i.test(s)) return "night";
  return "unknown";
}

export function mockExtractDocument(text: string): Item[] {
  const out: Item[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const med = /^\d+[.)]\s*(.+?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu))\s+(tablet|capsule|syrup|injection)s?\s*[—–-]+\s*(.+?)\s*[—–-]+\s*(.+?)\s*[—–-]+\s*(.+?)\s*$/i.exec(line);
    if (med) {
      const [, name, strength, form, doseText, freqPart, rest] = med;
      const tail = rest.split(/\s*[—–-]+\s*/);
      const instructions = tail.filter((p) => !/^for\s+\d+/i.test(p)).join("; ");
      const u = /^(\d+(?:\.\d+)?|one|two|half|three)\b/i.exec(doseText.trim());
      const t = times(freqPart);
      out.push({
        itemType: "MEDICATION",
        payload: { name: name.trim(), strength: strength.replace(/\s+/g, " "), form: form.toLowerCase(), unitsPerAdministration: u ? (WORD_NUM[u[1].toLowerCase()] ?? Number(u[1])) : null, doseText: doseText.trim(), times: t, frequencyText: freqPart.replace(/\s+at\s+.*$/i, "").trim(), instructions, durationDays: durationDays(rest) },
        quote: line,
        confidence: t.length ? 0.92 : 0.5,
        whyUncertain: t.length ? null : "No explicit administration time in the line",
      });
      continue;
    }
    const body = line.replace(/^[-•*]\s*/, "");
    if (/^restriction\s*:/i.test(body)) {
      const txt = body.replace(/^restriction\s*:\s*/i, "");
      out.push({ itemType: "RESTRICTION", payload: { text: txt, durationDays: durationDays(txt) }, quote: line, confidence: 0.9, whyUncertain: null });
      continue;
    }
    const appt = /(follow-?up|appointment|review)[^:]*:\s*(.+?)\s+on\s+(\d{4}-\d{2}-\d{2})\s+at\s+(\d{1,2}:\d{2})(?:\s*\((.+?)\))?/i.exec(body);
    if (appt) {
      out.push({ itemType: "APPOINTMENT", payload: { title: `${appt[1][0].toUpperCase()}${appt[1].slice(1)}: ${appt[2]}`.replace(/\.$/, ""), date: appt[3], time: times(appt[4])[0] ?? null, location: appt[2], notes: appt[5] ?? "" }, quote: line, confidence: 0.9, whyUncertain: null });
      continue;
    }
    if (/^[-•*]/.test(line) && /\b(daily|twice|every day)\b/i.test(body) && body.includes(":")) {
      const title = body.split(":")[0].trim();
      const t = times(body);
      out.push({
        itemType: "CARE_ACTIVITY",
        payload: { title, category: category(title), times: t, instructions: body.slice(body.indexOf(":") + 1).trim(), requiredQualification: /trained|wound-care/i.test(body) && /dressing|wound/i.test(body) ? "WOUND_CARE_TRAINED" : null, durationDays: durationDays(body) },
        quote: line,
        confidence: t.length ? 0.88 : 0.55,
        whyUncertain: t.length ? null : "No explicit time in the instruction",
      });
    }
  }
  return out;
}

export function mockExtractMessage(text: string, senderName: string | undefined, memberNames: string[], sourceDate: string): Item[] {
  const out: Item[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const firstNames = memberNames.map((n) => n.split(" ")[0]);
  const senderFirst = (senderName ?? "").split(" ")[0].toLowerCase();
  for (const s of sentences) {
    const date = /\btomorrow\b/i.test(s) ? addDays(sourceDate, 1) : /\b(today|tonight)\b/i.test(s) ? sourceDate : (/\b(\d{4}-\d{2}-\d{2})\b/.exec(s)?.[1] ?? null);
    // hand-off: "<Name> will give/take/do ..."
    const handoff = new RegExp(`\\b(${firstNames.join("|")})\\s+(will|is going to|'ll|shall)\\s+(give|take|do|handle|bring|pick|change|go)`, "i").exec(s);
    if (handoff && handoff[1].toLowerCase() !== senderFirst) {
      out.push({ itemType: "COMMITMENT", payload: { text: s, committedMemberId: null, committedName: handoff[1], isHandoff: true, taskHint: s, date, linkedTaskId: null }, quote: s, confidence: 0.82, whyUncertain: null });
      continue;
    }
    if (/\b(i will|i'll|i am going to|i'm going to|i shall)\b/i.test(s) && /\b(take|give|do|bring|pick|handle|change|go|come)\b/i.test(s)) {
      out.push({ itemType: "COMMITMENT", payload: { text: s, committedMemberId: null, committedName: senderName ?? "", isHandoff: false, taskHint: s, date, linkedTaskId: null }, quote: s, confidence: 0.85, whyUncertain: null });
      continue;
    }
    if (/(appointment|visit|follow-?up|consultation)/i.test(s) && /(cancel+ed|postponed|rescheduled|moved|confirmed)/i.test(s)) {
      const status = /cancel/i.test(s) ? "CANCELLED" : /confirm/i.test(s) ? "CONFIRMED" : "RESCHEDULED";
      out.push({ itemType: "SCHEDULE_CHANGE", payload: { subject: "appointment", status, date, newDate: null, text: s }, quote: s, confidence: date ? 0.86 : 0.6, whyUncertain: date ? null : "No date mentioned" });
      continue;
    }
    if (/(hasn'?t|has not|didn'?t|did not|haven'?t|have not|not yet)\b/i.test(s) && /(had|taken|given|got|done|eaten)/i.test(s) && /(medicine|tablet|pill|dose|medication|dressing|physio|exercise)/i.test(s)) {
      out.push({ itemType: "COMPLETION_REPORT", payload: { claim: "NOT_DONE", text: s, category: category(s) === "OTHER" ? "MEDICATION" : category(s), timeOfDay: timeOfDay(s), linkedTaskId: null }, quote: s, confidence: 0.84, whyUncertain: null });
      continue;
    }
    if (/\b(gave|given|done|completed|finished|changed)\b/i.test(s) && /(medicine|tablet|pill|dose|medication|dressing|physio|exercise)/i.test(s)) {
      out.push({ itemType: "COMPLETION_REPORT", payload: { claim: "DONE", text: s, category: category(s) === "OTHER" ? "MEDICATION" : category(s), timeOfDay: timeOfDay(s), linkedTaskId: null }, quote: s, confidence: 0.83, whyUncertain: null });
      continue;
    }
    if (/(running out|almost (finished|over|empty)|only \d+ (tablets? )?left|ran out|refill)/i.test(s)) {
      out.push({ itemType: "REPLENISHMENT_REQUEST", payload: { medicationName: /Medicine [A-Z]/i.exec(s)?.[0] ?? "", text: s }, quote: s, confidence: 0.8, whyUncertain: null });
      continue;
    }
    if (/(worried|concerned|not sure if)/i.test(s)) {
      out.push({ itemType: "CONCERN", payload: { text: s }, quote: s, confidence: 0.75, whyUncertain: null });
      continue;
    }
    if (/(swelling|swollen|pain|slept|sleep|appetite|ate |fever|dizzy|tired|wound looks|mood|walked|walking|discharge)/i.test(s)) {
      out.push({ itemType: "OBSERVATION", payload: { text: s, category: /wound|swell|discharge/i.test(s) ? "wound" : /sleep|slept/i.test(s) ? "sleep" : /appetite|ate /i.test(s) ? "nutrition" : "general" }, quote: s, confidence: 0.78, whyUncertain: null });
    }
  }
  return out;
}

const SUMMARY_ORDER: [string, string][] = [
  ["activeAlerts", "Open alerts"],
  ["unresolvedConflicts", "Unresolved conflicts"],
  ["pendingActivities", "Still pending"],
  ["upcomingActivities", "Coming up"],
  ["medicationEvents", "Medication records this shift"],
  ["observations", "Observations"],
  ["inventoryShortages", "Running low"],
  ["upcomingAppointments", "Appointments"],
  ["recentInstructionChanges", "Recently approved instruction changes"],
  ["completedActivities", "Completed this shift"],
];

export class DeterministicMockProvider implements LlmProvider {
  readonly mode = "MOCK" as const;
  readonly name = "mock:rule-based";

  async extract(input: ExtractInput) {
    const items = input.sourceKind === "DOCUMENT" ? mockExtractDocument(input.text) : mockExtractMessage(input.text, input.senderName, input.memberNames, input.sourceDate);
    return { items };
  }

  async summarizeHandover(snapshot: unknown) {
    const snap = snapshot as Record<string, { id: string; text: string }[]>;
    const sentences: { text: string; refs: string[] }[] = [];
    for (const [key, label] of SUMMARY_ORDER) {
      const items = snap[key];
      if (!Array.isArray(items) || items.length === 0) continue;
      const shown = items.slice(0, 3);
      sentences.push({ text: `${label}: ${shown.map((i) => i.text).join("; ")}${items.length > 3 ? ` (+${items.length - 3} more)` : ""}.`, refs: shown.map((i) => i.id) });
    }
    return { sentences };
  }

  /** Keyword intent → a fixed plan of READ tool calls → answer composed only from tool results. */
  async runToolLoop(input: ToolLoopInput) {
    const q = input.user.toLowerCase();
    const pid = input.context.patientId;
    let steps = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      steps++;
      if (!input.tools.some((t) => t.name === name)) return null;
      const r = await input.callTool(name, args);
      return r.ok ? (r.structured as Record<string, unknown>) : null;
    };
    type T = { id: string; title: string; localTime: string; state: string; assigneeName: string | null; covered: boolean; windowEnd: string };
    type A = { id: string; title: string; level: string; ruleId: string; explanation: string; basis: { kind: string; ruleId: string; description: string; confidence?: number; provider?: string } };
    const st = (s: string) => s.replace(/_/g, " ").toLowerCase();

    // Coverage workflow (used by the Coverage Agent through the same loop interface)
    if (input.context.mode === "coverage") {
      const taskId = input.context.taskId;
      const cands = (await call("find_available_caregivers", { patientId: pid, taskId })) as { candidates?: { memberId: string; name: string; eligible: boolean; reasons: string[] }[] } | null;
      const best = cands?.candidates?.find((c) => c.eligible);
      if (!best) return { finalText: "No eligible caregiver is free for this task. A coordinator needs to decide.", steps };
      await call("propose_reassignment", { patientId: pid, taskId, toMemberId: best.memberId, reason: `Suggested by Coverage Agent: ${best.reasons.join("; ")}` });
      return { finalText: `Proposed ${best.name} (${best.reasons.join("; ")}). A coordinator must approve, then ${best.name} must accept.`, steps };
    }

    if (/\bwhy\b/.test(q) && /(alert|red|urgent|flag|warning)/.test(q)) {
      const r = (await call("list_open_alerts", { patientId: pid })) as { alerts?: A[] } | null;
      const alerts = r?.alerts ?? [];
      if (!alerts.length) return { finalText: "There are no open alerts in CareRelay right now.", steps };
      const a = alerts[0];
      const basis = a.basis.kind === "AI" ? `AI semantic analysis (${Math.round((a.basis.confidence ?? 0) * 100)}% confidence, ${a.basis.provider})` : `rule ${a.basis.ruleId} — ${a.basis.description}`;
      return { finalText: `The most pressing alert is "${a.title}" (coordination risk: ${st(a.level)}) [[ALERT:${a.id}]]. It was raised by ${basis}. ${a.explanation}`, steps };
    }

    if (/(who|whom).*(cover|doing|going|responsible|handling|taking|giving)/.test(q)) {
      const r = (await call("list_tasks", { patientId: pid })) as { tasks?: T[] } | null;
      const tasks = r?.tasks ?? [];
      const hm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(q);
      let match: T | undefined;
      if (hm) {
        let h = Number(hm[1]);
        if (hm[3] === "pm" && h < 12) h += 12;
        if (!hm[3] && h < 7) h += 12;
        match = tasks.find((t) => Number(t.localTime.slice(0, 2)) === h);
      }
      if (!match) match = tasks.find((t) => q.split(/\W+/).some((w) => w.length > 4 && t.title.toLowerCase().includes(w)));
      if (!match) return { finalText: "I don't have that information in CareRelay.", steps };
      const who = match.assigneeName ? `${match.assigneeName}${match.covered ? " (accepted)" : " — assigned but not yet accepted, so it is not covered"}` : "nobody — it has no owner yet";
      return { finalText: `"${match.title}" at ${match.localTime} is covered by ${who}. Current state: ${st(match.state)} [[TASK:${match.id}]].`, steps };
    }

    if (/(stock|inventory|refill|running (low|out)|supply|supplies)/.test(q)) {
      const r = (await call("get_inventory_status", { patientId: pid })) as { items?: { id: string; name: string; projection: { label: string }; low: boolean }[] } | null;
      const items = r?.items ?? [];
      if (!items.length) return { finalText: "I don't have that information in CareRelay.", steps };
      return { finalText: items.map((i) => `${i.name}: about ${i.projection.label}${i.low ? " — below the reorder threshold" : ""} [[MEDICATION:${i.id}]]`).join("\n"), steps };
    }

    if (/(pending|attention|left|still|today|tonight|status|overview|summary|what.*(need|due)|uncovered|overdue)/.test(q)) {
      const status = (await call("get_care_status", { patientId: pid })) as { tasksToday: number; completed: number; uncovered: number; overdue: number; openConflicts: number; nextTasks: { id: string; title: string; time: string; state: string; assigneeName: string | null; covered: boolean }[]; uncoveredTasks: { id: string; title: string; time: string; assigneeName: string | null }[]; lowStock: { name: string; label: string }[] } | null;
      const alerts = ((await call("list_open_alerts", { patientId: pid })) as { alerts?: A[] } | null)?.alerts ?? [];
      if (!status) return { finalText: "I don't have that information in CareRelay.", steps };
      const tonight = /tonight|evening|night/.test(q);
      const lines: string[] = [];
      lines.push(`Today: ${status.tasksToday} tasks, ${status.completed} completed, ${status.uncovered} not covered, ${status.overdue} overdue, ${status.openConflicts} open conflict(s).`);
      const upcoming = status.nextTasks.filter((t) => !tonight || Number(t.time.slice(0, 2)) >= 17);
      if (upcoming.length) lines.push(`Coming up${tonight ? " tonight" : ""}: ${upcoming.map((t) => `${t.time} ${t.title} — ${t.assigneeName ? `${t.assigneeName}${t.covered ? "" : " (not yet accepted)"}` : "no owner"} [[TASK:${t.id}]]`).join("; ")}.`);
      const uncovered = status.uncoveredTasks.filter((t) => !upcoming.some((u) => u.id === t.id));
      if (uncovered.length) lines.push(`Also not covered: ${uncovered.map((t) => `${t.time} ${t.title} [[TASK:${t.id}]]`).join("; ")}.`);
      if (alerts.length) lines.push(`Open alerts: ${alerts.slice(0, 4).map((a) => `${a.title} (${st(a.level)}) [[ALERT:${a.id}]]`).join("; ")}.`);
      if (status.lowStock.length) lines.push(`Running low: ${status.lowStock.map((l) => `${l.name} (${l.label})`).join("; ")}.`);
      return { finalText: lines.join("\n"), steps };
    }

    return { finalText: "I don't have that information in CareRelay.", steps };
  }
}
