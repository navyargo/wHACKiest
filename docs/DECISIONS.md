# Decisions & assumptions

Format: decision — reason. Update this file whenever the code changes direction.

## Not specified in source
- **The CareRelay problem statement (Appendix A of the build prompt) was not provided.** The team chose to build from the build prompt alone. Everything here comes from the prompt's own sections (10 scenarios, rule table, roles, data model). Scenario names follow the prompt's Scenario launcher list: (1) Assumption gap, (2) Duplicate administration, (3) Prescription conflict, (4) Incomplete handover, (5) Inventory shortage, (6) Caregiver unavailable, (7) Contradictory reports, (8) Silent failure, (9) Post-discharge extraction, (10) Remote family view. Any wording the original statement used for these scenarios is unknown to us; references such as "8.5" / "8.7" in the prompt point at sections we never saw.

## Runtime & tooling
- **Node 18 compatible versions pinned** (Next 15.5, React 19.1, Prisma 6.19, Vitest 3.2, Zod 3.25, Tailwind 3.4). The dev machine runs Node 18.20; these versions also run on Node 20/22.
- **Workspace packages are consumed as TypeScript source** (Next `transpilePackages`, `tsx` for the stdio server and seed). No separate build step for packages.
- **One HTTP port.** The MCP Streamable HTTP endpoint is mounted inside the Next app at `/api/mcp` using the SDK's `WebStandardStreamableHTTPServerTransport` in stateless mode (one server instance per request, authenticated by bearer token before the server is built). stdio runs as a separate process (`pnpm mcp:stdio`).
- **REST API is a single catch-all route** (`app/api/[...path]/route.ts`) dispatching to a route table. Every route passes through one wrapper that does auth, patient membership, permission, Zod validation, idempotency and error mapping. `docs/API.md` mirrors the table.

## Domain
- **Recurrence = simple daily times** (`{"times":["08:00","20:00"]}`) in the patient's timezone, not RRULE. Enough for the medication/wound-care/physio schedules in the seed.
- **Timezones** are handled with `Intl` (`zonedTimeToUtc`), default `Asia/Kolkata`.
- **`ASSIGNED` is a real but short state**: `ASSIGN` moves a task to `ASSIGNED`; once the in-app notification row is written the system fires `NOTIFY` → `AWAITING_ACKNOWLEDGEMENT`. Assignment never counts as acceptance.
- **Claiming**: a caregiver with `record_care` may claim an uncovered task for themselves (`CLAIM` → `ACKNOWLEDGED`), because claiming is an explicit acceptance by that person. Qualification guard still applies.
- **"Can't do it"** (`DECLINE`) returns the task to `UNASSIGNED` with a reason; the gap engine then raises GAP-001 if it is high priority.
- **Late completion** is allowed from `OVERDUE`/`ESCALATED` so the record reflects what happened; the overdue alert stays in the timeline.
- **Duplicate administration** attempts are stored as an `AdministrationRecord` with status `DISPUTED` (the partial unique index allows only one `RECORDED` per task), plus a `DUPLICATE_ADMINISTRATION` Conflict. The original record is never modified.
- **Reassignment by a human coordinator** executes immediately (`REASSIGN` → `AWAITING_ACKNOWLEDGEMENT` for the new member). **Reassignment proposed by an agent or via the MCP `propose_reassignment` tool** always creates an `ApprovalRequest`; after a human with `manage_tasks` approves it the same transition runs, and the candidate still has to acknowledge.
- **Alerts auto-resolve** when the sweep finds the condition no longer holds (resolution text records which rule cleared). Conflicts never auto-resolve; a human resolves them.
- **Shifts** for HND-001 are derived from caregivers' `WORKING_HOURS` availability blocks: a shift boundary is the end of one caregiver's block. A handover is expected from that caregiver to whoever's block starts next.
- **Rule thresholds** (in `packages/domain/src/rules/config.ts`): GAP-001 look-ahead 3 h, GAP-002 60 min, GAP-004 30 min after reassignment, HND-001 30 min, AI confidence to raise an alert ≥ 0.7, stock verification considered fresh for 7 days.

## AI
- **The LLM runs inside domain-level extraction services** that MCP tools call (`extract_from_document`, `extract_from_message`). Agents (Intake, Coverage, Handover, Care Assistant) only touch data through the MCP SDK client.
- **Offline mock provider** (`DeterministicMockProvider`) uses regex/keyword rules tuned to the seeded documents and messages. The UI header shows "Offline AI mode — rule-based" whenever it is active.
- **OCR for images is not implemented.** PDFs with a text layer are parsed with `unpdf`; for photos/scans the user pastes or types the text. (Time budget.)

## Integrations
- WhatsApp/SMS, calendar and pharmacy are **SIMULATED** and badged in the UI.
- ElevenLabs text-to-speech is wired through its REST endpoint when `ELEVENLABS_API_KEY` is set; without the key the buttons are hidden.
- AWS: an S3 `StorageProvider` adapter exists behind `STORAGE_PROVIDER=s3`; local disk is the default. Nothing is deployed to AWS by this repo.

## Build & test environment
- **Local Postgres on the build machine**: Docker and Homebrew Postgres were unavailable (outdated Xcode on an Intel Mac), so development used an npm-packaged Postgres 16 binary (`embedded-postgres`) run outside the repo. The repo's supported path remains `docker compose up -d`; CI uses a Postgres 16 service container.
- **E2E runs its own Next.js dev server** on port 3100 against `TEST_DATABASE_URL` with `NEXT_DIST_DIR=.next-e2e`, so it never touches the dev database or a running `pnpm dev`.
- **`NEXT_IGNORE_INCORRECT_LOCKFILE=1` and `outputFileTracingRoot`** are set so Next.js never adopts or patches a lockfile in a parent directory.
- **Node 18 has no global `crypto`**: server code imports `randomUUID` from `node:crypto`.

## API details decided during the build
- Demo routes have two auth modes: `demo` (Demo Mode only, no session — one-click login, account list) and `demoSession` (Demo Mode + signed in — clock, reset, scenarios).
- **Reset demo data** wipes sessions, so the endpoint signs the presenter back in as Priya.
- Agents are run by the API on behalf of the signed-in user with a 5-minute MCP token that is revoked when the agent finishes.
- Coverage Agent output is built from the MCP calls that actually succeeded (approval ids), never from model text.
- The Care Assistant keeps a citation only if the cited id appears in a tool result from that conversation.
