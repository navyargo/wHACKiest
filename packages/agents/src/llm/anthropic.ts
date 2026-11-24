/**
 * Anthropic provider (LIVE when ANTHROPIC_API_KEY is set). Uses the beta Messages endpoint so
 * server-side refusal fallbacks can be enabled. Structured outputs come back through a tool call
 * and are validated with Zod by the caller (retry once, then "Needs manual review").
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ExtractInput, LlmProvider, ToolLoopInput } from "./provider";

const EXTRACTION_SYSTEM = `You extract care-coordination facts from a family's care documents and messages for CareRelay.
CareRelay records, compares and routes information to authorised people. You never give medical advice, never suggest doses, and never decide which of two instructions is correct.

Rules:
- Only extract what the text literally says. Do not infer doses, times or medicines that are not written.
- "quote" must be copied exactly from the source text (the shortest passage that supports the item).
- Copy dosage wording exactly as written into doseText. Set unitsPerAdministration only if the number of units per administration is explicitly written; otherwise null.
- Times are 24h "HH:MM". If a time is not explicit, leave times empty and explain in whyUncertain.
- confidence is your confidence (0-1) that the item is correctly read from the text.
- For messages: a person saying they will do something is a COMMITMENT (committedName = that person). Saying someone else will do it is a COMMITMENT with isHandoff=true and committedName = the other person. Statements that something was done / not done are COMPLETION_REPORT (claim DONE or NOT_DONE, timeOfDay morning/afternoon/evening/night/unknown, category MEDICATION/WOUND_CARE/PHYSIO/APPOINTMENT/...). Notes about the patient's state are OBSERVATION. Appointment cancelled/moved/confirmed is SCHEDULE_CHANGE (status, date YYYY-MM-DD if known). Running out of supplies is REPLENISHMENT_REQUEST. Worries are CONCERN.
- For documents: medicines are MEDICATION {name, strength, form, unitsPerAdministration, doseText, times[], frequencyText, instructions, durationDays}; recurring care tasks are CARE_ACTIVITY {title, category, times[], instructions, requiredQualification (e.g. "WOUND_CARE_TRAINED" when a trained person is required), durationDays}; restrictions are RESTRICTION {text, durationDays}; appointments are APPOINTMENT {title, date, time, location, notes}.
- Resolve relative dates ("tomorrow") using the source date given.
Call the submit_extraction tool exactly once with all items.`;

const SUMMARY_SYSTEM = `You write a short, plain-language shift handover summary for a home caregiver, strictly from the JSON snapshot provided.
Every sentence must cite one or more snapshot item ids (the "id" fields) in refs. Never add facts that are not in the snapshot. Never give medical advice or suggest doses.
Prioritise: open alerts and conflicts, pending tasks, what is coming up next, medication records, observations. 3-8 sentences.
Call the submit_summary tool exactly once.`;

export class AnthropicProvider implements LlmProvider {
  readonly mode = "LIVE" as const;
  readonly name: string;
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.name = `anthropic:${model}`;
  }

  private async create(params: Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, "model" | "max_tokens" | "betas" | "fallbacks">) {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      ...params,
    });
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    return res;
  }

  private async callForTool(system: string, user: string, tool: Anthropic.Beta.BetaTool): Promise<unknown> {
    const res = await this.create({ system, tools: [tool], tool_choice: { type: "auto" }, messages: [{ role: "user", content: user }] });
    const use = res.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === tool.name);
    if (use) return use.input;
    const text = res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return structured output");
  }

  async extract(input: ExtractInput, previousError?: string) {
    const user = [
      `Source type: ${input.sourceKind}${input.documentKind ? ` (${input.documentKind})` : ""}`,
      `Source date: ${input.sourceDate}`,
      input.senderName ? `Sender: ${input.senderName}` : "",
      `Care-circle member names: ${input.memberNames.join(", ")}`,
      "<source>",
      input.text,
      "</source>",
      previousError ? `Your previous output failed validation: ${previousError}. Fix it and call the tool again.` : "",
    ].filter(Boolean).join("\n");
    return this.callForTool(EXTRACTION_SYSTEM, user, {
      name: "submit_extraction",
      description: "Submit the extracted items.",
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                itemType: { type: "string", enum: ["MEDICATION", "APPOINTMENT", "CARE_ACTIVITY", "RESTRICTION", "COMMITMENT", "COMPLETION_REPORT", "OBSERVATION", "SCHEDULE_CHANGE", "REPLENISHMENT_REQUEST", "CONCERN"] },
                payload: { type: "object" },
                quote: { type: "string" },
                confidence: { type: "number" },
                whyUncertain: { type: ["string", "null"] },
              },
              required: ["itemType", "payload", "quote", "confidence"],
            },
          },
        },
        required: ["items"],
      },
    });
  }

  async summarizeHandover(snapshot: unknown, previousError?: string) {
    const user = `<snapshot>\n${JSON.stringify(snapshot)}\n</snapshot>${previousError ? `\nYour previous output failed validation: ${previousError}` : ""}`;
    return this.callForTool(SUMMARY_SYSTEM, user, {
      name: "submit_summary",
      description: "Submit the handover summary.",
      input_schema: {
        type: "object",
        properties: { sentences: { type: "array", items: { type: "object", properties: { text: { type: "string" }, refs: { type: "array", items: { type: "string" } } }, required: ["text", "refs"] } } },
        required: ["sentences"],
      },
    });
  }

  /** Manual agentic loop: the model may call only the MCP tools it was given. */
  async runToolLoop(input: ToolLoopInput) {
    const tools: Anthropic.Beta.BetaTool[] = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: input.user }];
    let steps = 0;
    while (steps < input.maxSteps) {
      steps++;
      const res = await this.create({ system: input.system, tools, tool_choice: { type: "auto" }, messages });
      // Append the full content (including thinking blocks) unchanged.
      messages.push({ role: "assistant", content: res.content });
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || uses.length === 0) {
        return { finalText: res.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim(), steps };
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const allowed = input.tools.some((t) => t.name === u.name);
        const out = allowed ? await input.callTool(u.name, (u.input ?? {}) as Record<string, unknown>) : { ok: false, text: `Tool ${u.name} is not allowed for this agent.` };
        results.push({ type: "tool_result", tool_use_id: u.id, content: out.text.slice(0, 30_000), is_error: !out.ok });
      }
      messages.push({ role: "user", content: results });
    }
    return { finalText: "I couldn't finish within the step limit. I don't have that information in CareRelay.", steps };
  }
}
