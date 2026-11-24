# Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js React UI<br/>Care Board, Alerts, Documents, Handover, Assistant, MCP Activity]
  end
  subgraph "Next.js server (apps/web)"
    API["REST route table<br/>/api/[...path]<br/>auth · authz · Zod · idempotency"]
    MCPH["/api/mcp<br/>MCP Streamable HTTP"]
    ORCH["Agent orchestrator<br/>(packages/agents)<br/>Intake · Coverage · Handover · Care Assistant"]
    SCHED["Scheduler<br/>care sweep every minute"]
  end
  subgraph "packages/domain"
    SVC[Domain services]
    SM[Task state machine]
    RULES[Gap detection rules<br/>GAP/DUP/CON/HND/INV]
    AUTHZ[authz.ts]
    CLOCK[Clock<br/>real / demo]
    AUDIT[Audit log]
  end
  MCPS["packages/mcp-server<br/>tools · resources · prompt"]
  STDIO["stdio entrypoint<br/>(Claude Desktop / Inspector)"]
  LLM["LLM provider<br/>Anthropic (LIVE) or<br/>DeterministicMock (offline)"]
  GUARD[Medical-content guard]
  DB[(PostgreSQL)]
  SIM["Simulated connectors<br/>WhatsApp inbox · calendar · SMS"]
  TTS[ElevenLabs TTS<br/>optional]
  STORE[StorageProvider<br/>local disk / S3]

  UI --> API
  API --> SVC
  API --> ORCH
  ORCH -- "MCP SDK client (HTTP)" --> MCPH
  MCPH --> MCPS
  STDIO --> MCPS
  MCPS --> SVC
  MCPS --> LLM
  ORCH --> LLM
  LLM --> GUARD
  SVC --> SM
  SVC --> RULES
  SVC --> AUTHZ
  SVC --> AUDIT
  SVC --> CLOCK
  SVC --> DB
  SCHED --> SVC
  SIM --> API
  API --> TTS
  API --> STORE
```

Key point: the agents never import domain services. They only see data through MCP tools, which call the same domain services as the REST API.

## Document upload → extraction → verification → tasks

```mermaid
sequenceDiagram
  actor U as Uploader
  participant API
  participant IA as Intake Agent
  participant MCP as MCP server
  participant X as Extraction service (LLM + guard)
  participant DB
  actor V as Clinical verifier
  U->>API: POST /documents (text or PDF)
  API->>DB: SourceDocument (version n of group)
  API->>IA: run(documentId)
  IA->>MCP: tools/call extract_from_document
  MCP->>X: extract(rawText)
  X-->>MCP: items + spans + confidence (Zod-validated, retry once)
  MCP->>DB: ExtractedItem PROPOSED / AWAITING_VERIFICATION<br/>ApprovalRequest ACTIVATE_INSTRUCTIONS (PENDING)<br/>CON-002 diff vs active plan → Conflict
  IA-->>API: ExtractionResult[]
  V->>API: review, edit/reject items, approve
  API->>DB: ApprovalRequest APPROVED → CarePlanItems active<br/>(old version items deactivated, kept)
  API->>DB: generate Task occurrences (unique carePlanItemId+scheduledAt)
```
