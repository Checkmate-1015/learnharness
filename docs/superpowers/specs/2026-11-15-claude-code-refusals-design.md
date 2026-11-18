# Stop Claude Code refusals in teaching sessions

Date: 2026-11-15. Status: awaiting approval.

## Why

With the Claude Code provider, a turn that starts a fresh CLI process re-sends the
whole conversation as labelled text inside one user message (`[assistant]`,
`[tool call …]`, `[tool result …]`). Anthropic's `reasoning_extraction` classifier
blocks that as "duplicating model outputs" (upstream issue 474). In the local
"Rough VIX" session this refused 6 of 6 Claude Code teaching turns on 14 Nov.
The refusal category is also thrown away, so a refusal cannot be diagnosed.

## Goals

- Normal learner turns on Claude Code no longer replay history as text.
- Every refusal records its category and explanation, on both the Claude Code
  and the Anthropic API paths.

## Non-goals

- The live agent watcher panel.
- The single Anthropic API refusal (15:35). Its cause is unproven; the category
  capture is what will identify it next time.
- Persisting the chat-to-CLI-session map across app restarts (follow-up).

## Anti-goals

- Hiding refusals by silently retrying or switching model.
- Weakening the bridge's tool admission checks.

## Approaches

1. **Resume each chat's CLI session (upstream PR 440). Chosen.**
   First launch passes `--session-id`, later launches `--resume`, and stdin carries
   only the new learner message, so the CLI supplies native history. Trial merge
   onto current main (0.6.1): code and tests merge cleanly; only
   `docs/claude-code.md` conflicts. Tested upstream on CLI 2.1.314; this Mac has
   2.1.325. Trade-off: restarts, retries, edited history and an expired held
   question still fall back to a replay.
2. **Write a synthetic CLI session file with native history, then resume it.**
   Removes every replay path, but depends on the CLI's private session file
   format and fabricates assistant turns without signatures. Rejected: fragile.
3. **Fall back to another model on refusal.** Rejected: hides the fault and
   changes who is teaching mid-lesson.

## Design

- Branch `fix/claude-code-refusals` off main. Merge `pr-440`
  (`cli-sessions.ts`, `stream.ts`, `transcript.ts`, three test files). Resolve the
  docs conflict by keeping main's rewritten page and adding the session-resume
  behaviour to its "Questions, reuse, and cancellation" section.
- Refusal details, Claude Code path: `cli-events.ts` reads `delta.stop_details`
  (`category`, `explanation`) beside `stop_reason`; `stream.ts` uses the
  explanation as the error message and appends the category, falling back to the
  current fixed message.
- Refusal details, API path: pi-ai already surfaces the explanation but not the
  category. Record the category from the raw provider event in LearnHarness's own
  code; no patch to the pi-ai package.
- Tests: extend `tests/claude-code-stream.test.ts` with a refusal carrying
  `stop_details`; run the three `claude-code-*` suites PR 440 touches.

## Verification

- `npm ci`, then the claude-code test suites and `npm test`.
- One live check in `npm run desktop:dev` against a copy of the real data folder:
  continue the "Rough VIX" session on Claude Code for two turns and confirm the
  second turn resumes (no replay, cache read on turn two). This uses the Claude
  subscription and needs a go-ahead first.

## Left to the builder

- Exact wording of the refusal message.
- Where the API-path category is stored on the saved message.
