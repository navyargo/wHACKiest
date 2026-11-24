# Agents

All agents live in `packages/agents`. Each one is a bounded workflow, not free chat: system prompt, allowed tool list, step limit, Zod-validated final output. They reach data **only** through an MCP SDK `Client` connected to `/api/mcp` with a short-lived token for the requesting user and patient, so the server applies that user's permissions.

| Agent | Trigger | Allowed tools | Steps | Output |
|---|---|---|---|---|
| Intake | document upload, "Extract" on a message | `extract_from_document`, `extract_from_message`, `get_source_reference` | 3 | `ExtractionResult[]` (item id, type, span, confidence, status, whyUncertain) |
| Coverage | "Suggest coverage" on an alert | `list_open_alerts`, `get_task`, `find_available_caregivers`, `propose_reassignment`, `request_approval` | 8 | `{proposals:[{taskId, candidateMemberId, approvalRequestId, reasons}]}` |
| Handover | "Draft handover" | `draft_handover` | 2 | `{sentences:[{text, refs:[snapshotItemId]}]}` — any sentence without a valid ref is dropped by the validator |
| Care Assistant | chat panel | READ tools only | 6 | `{answer, citations:[{sourceType,sourceId,label}], toolCalls}` |

Pipeline for every LLM output: provider (Anthropic tool-use / JSON) → Zod parse → on failure retry once with the error → on second failure the item is marked "Needs manual review" → **medical-content guard** (rejects dose/skip/repeat/change/diagnosis/choose-between-instructions advice and substitutes the safety message). Nothing invalid is stored.

Thresholds (deterministic code, not the model): extracted item confidence < 0.7 or missing required fields → `AWAITING_VERIFICATION` with a "why uncertain" note. AI-detected contradictions / unconfirmed hand-offs raise an alert only at confidence ≥ 0.7; below that they appear as "Needs review" (Informational).

Providers: `AnthropicProvider` when `ANTHROPIC_API_KEY` is set; otherwise `DeterministicMockProvider` (regex/keyword rules) — the header badge reads "Offline AI mode — rule-based". The mock still goes through the same MCP tools.
