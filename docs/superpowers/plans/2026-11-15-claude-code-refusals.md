# Claude Code Refusals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normal Claude Code turns stop replaying history as pasted text, and every refusal keeps its category and explanation.

**Architecture:** Merge upstream PR 440 (per-chat CLI session resume) onto main. Parse `stop_details` from the CLI's `message_delta` and surface it in the error message. For the Anthropic API path, wrap the provider stream in LearnHarness code to append the category pi-ai drops.

**Tech Stack:** TypeScript, Node test runner (`npm test`), pi-ai / pi-agent-core, Claude Code CLI >= 2.1.259 (local: 2.1.325).

**Spec:** `docs/superpowers/specs/2026-11-15-claude-code-refusals-design.md`

## Global Constraints

- Branch `fix/claude-code-refusals` off main; nothing on main.
- No patch to the pi-ai package.
- No silent retry and no model switch on refusal.
- Bridge tool admission checks unchanged.
- Refusal message format: `<explanation or "The model refused to complete the request"> (refusal category: <category>)`; the suffix is omitted when no category arrives.

## Review Focus

- Refusal with `stop_details: null` → fixed message, no suffix, no crash.
- Refusal with a category but no explanation → fixed message plus suffix.
- Non-refusal stop reasons carrying no `stop_details` → behaviour unchanged.
- API stream that errors for a non-refusal reason (network, 503) → message untouched.
- A resumed CLI session that fails to resume → falls back to a fresh session (covered by PR 440's tests; confirm they still pass after the merge).

---

### Task 1: Merge PR 440

**Files:** `src/agent/claude-code/{cli-sessions,stream,transcript}.ts`, `tests/claude-code-{harness,stream,transcript}.test.ts`, `docs/claude-code.md`

- [ ] `git switch -c fix/claude-code-refusals && git merge --no-ff pr-440`
- [ ] Resolve `docs/claude-code.md`: keep main's page; in "Questions, reuse, and cancellation" state that each chat keeps a CLI session (`--session-id` first, `--resume` after), that stdin then carries only the new learner message, and that error, abort, held question, edited history or a failed resume start a fresh session with a segmented replay.
- [ ] `npm ci && npm run plugins:setup`, then run the three `claude-code-*` suites. Expected: pass.
- [ ] Commit the merge.

### Task 2: Refusal details on the Claude Code path

**Files:** Modify `src/agent/claude-code/cli-events.ts`, `src/agent/claude-code/stream.ts`; create `src/agent/refusal-details.ts`; test `tests/claude-code-stream.test.ts`.

**Interfaces:**
- Produces: `refusalMessage(details?: { category?: string | null; explanation?: string | null } | null): string` in `src/agent/refusal-details.ts`; `CliEvent` `messageDelta` gains `stopDetails: { category: string | null; explanation: string | null } | null`.

- [ ] Tests (beside "refusal stop reason → error"): a `message_delta` with `stop_reason: "refusal"` and `stop_details: { type: "refusal", category: "reasoning_extraction", explanation: "Blocked." }` yields `Blocked. (refusal category: reasoning_extraction)`; with `stop_details: null` yields the fixed message; with category only yields the fixed message plus suffix. Run: fail.
- [ ] Implement: `RawDelta.stop_details`, pass through `parseStreamEvent`, set `output.errorMessage = refusalMessage(details)` when the stop reason is `refusal`.
- [ ] Run the suite: pass. Commit.

### Task 3: Refusal category on the Anthropic API path

**Files:** Modify `src/agent/refusal-details.ts`, `src/agent/models.ts`; test `tests/refusal-details.test.ts`.

**Interfaces:**
- Consumes: `refusalMessage` from Task 2.
- Produces: `withRefusalCategory(streamFn: StreamFunction): StreamFunction`. It observes raw `message_delta` events through `onProviderStreamEvent` (still forwarding to the caller's observer), and when the final assistant message has `rawStopReason === "refusal"` and a category was seen, rewrites its `errorMessage` with `refusalMessage`.

- [ ] Tests with a fake stream function: refusal + category → suffixed message; refusal without category → untouched; non-refusal error → untouched; caller's observer still receives every raw event. Run: fail.
- [ ] Implement, and apply the wrapper in `models.ts` where the engine's stream function is chosen (the `streamSimple` branch).
- [ ] Run `npm test`. Expected: pass. Commit.

### Task 4: Live check (needs the user's go-ahead)

- [ ] `npm run desktop:dev` against a copy of the real data folder; two Claude Code turns on the "Rough VIX" session; turn two shows a cache read and no replay.
