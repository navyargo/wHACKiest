export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallOutcome {
  ok: boolean;
  /** JSON text of the result (or error message). */
  text: string;
  structured?: unknown;
}

export interface ToolLoopInput {
  system: string;
  user: string;
  tools: ToolSpec[];
  maxSteps: number;
  /** Context the deterministic provider needs (e.g. patientId, memberId). */
  context: Record<string, string>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

export interface ExtractInput {
  sourceKind: "DOCUMENT" | "MESSAGE";
  documentKind?: string;
  text: string;
  senderName?: string;
  memberNames: string[];
  /** Local date of the source (YYYY-MM-DD) so relative dates can be resolved. */
  sourceDate: string;
}

export interface LlmProvider {
  /** e.g. "anthropic:claude-opus-5-5" or "mock:rule-based" */
  name: string;
  mode: "LIVE" | "MOCK";
  /** Returns raw JSON shaped like ExtractionOutputZ; caller validates (and retries once). */
  extract(input: ExtractInput, previousError?: string): Promise<unknown>;
  /** Returns raw JSON shaped like HandoverSummaryZ. */
  summarizeHandover(snapshot: unknown, previousError?: string): Promise<unknown>;
  /** Bounded tool-use loop over MCP tools. Returns the model's final text. */
  runToolLoop(input: ToolLoopInput): Promise<{ finalText: string; steps: number }>;
}
