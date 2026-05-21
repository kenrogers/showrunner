# Use a single persistent thread with production-aware auto compaction

## Status

Accepted.

## Context

Showrunner should feel like one ongoing production conversation, not a set of isolated commands. The user wants to return to the same creative thread, ask for status naturally, keep model and budget choices visible, and let the harness manage context without requiring slash commands.

Hermes points toward a two-layer context strategy: a normal compactor that fires before context gets dangerous, plus a later hygiene layer that prevents oversized sessions from escaping the agent loop. Codex points toward compaction as a first-class thread operation: once a model-aware context limit is crossed, replace the old input with a smaller representation that preserves enough state to continue.

Video production has a different memory shape than coding. The important facts are not every line of chat; they are creative constraints, continuity decisions, stage gates, model choices, budget guardrails, approvals, rejected takes, artifact paths, and the next production action.

## Decision

Showrunner V0 keeps one local persistent thread at `.showrunner/thread.json` by default.

Each conversational turn appends user and assistant turns to that thread. Before a normal model turn, Showrunner estimates retained context size, resolves the active model context window when possible through OpenRouter model discovery, and compacts the middle of the thread when the configured threshold is crossed.

Compaction preserves:

- The first turns that define the production intent.
- A structured summary of compacted middle turns.
- The most recent turns.
- Active Production State from the JSON source of truth.
- The active Production directory and current Showrunner model.

Manual compaction and inspection are available through natural language, such as "context status" and "compact context". Slash commands remain debug shortcuts only.

## Consequences

- The user can treat Showrunner as a single long-lived creative collaborator.
- Production State remains the hard source of truth; the thread summary is guidance, not authority.
- Context summaries are production-aware and should not invent completed media, costs, files, approvals, or reviews.
- Model context length lookup is best-effort. If OpenRouter model discovery is unavailable, Showrunner uses the configured fallback window.
- Future role agents can share the same context policy while keeping their own bounded task inputs.

## Configuration

- `SHOWRUNNER_THREAD_PATH`: persistent thread JSON path.
- `SHOWRUNNER_CONTEXT_WINDOW_TOKENS`: fallback context window when model discovery is unavailable.
- `SHOWRUNNER_AUTO_COMPACT_RATIO`: normal compaction threshold.
- `SHOWRUNNER_EMERGENCY_COMPACT_RATIO`: late hygiene threshold shown in status and reserved for stricter safety checks.
- `SHOWRUNNER_KEEP_HEAD_TURNS`: number of initial turns to keep verbatim.
- `SHOWRUNNER_KEEP_RECENT_TURNS`: number of recent turns to keep verbatim.
- `SHOWRUNNER_COMPACTION_MODEL`: optional model override for summaries.
