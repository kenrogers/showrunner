# Showrunner

Showrunner is a local-first video-production agent harness for planning, generating, reviewing, and assembling AI video work through OpenRouter.

It starts from a natural-language brief, creates a structured Production, plans Scenes and Shots, routes text/image/video/speech/music model work, tracks Budget Guardrails, preserves provenance, and renders static HTML Production Pages for review and handoff.

## Quick Start

```sh
npm install
cp .env.example .env
npm run start
```

Before running paid or model-backed flows, set `OPENROUTER_API_KEY` in `.env`.

Showrunner can render real media artifacts only when `ffmpeg` and `ffprobe` are installed. The local smoke test skips media artifact rendering when they are unavailable, but real assembly/export work needs them.

## Common Commands

```sh
npm run start             # start the interactive Showrunner TUI
npm run dev               # run the TUI in watch mode
npm run build             # compile TypeScript to dist/
npm run check             # type-check without emitting files
npm run smoke             # build and run the local smoke checks
npm test                  # type-check and smoke-test
npm run prototype         # run the state-machine prototype TUI
```

Inside the TUI:

```text
/new <brief>              create a Production from a natural-language brief
/status                   show the active Production State summary
/next                     run the next recommended stage action
/page                     render static HTML Production Pages
/models video             inspect OpenRouter video model surfaces
/model [id]               choose or set the controller model
/context                  show persistent thread and compaction status
/compact                  compact the persistent thread now
/load <dir>               load an existing Production directory
/exit                     quit
```

Paid generation paths require an explicit budget in the prompt, for example:

```text
run full production with up to $5
regenerate shot_3 with up to $1
```

## Configuration

Configuration is loaded from `.env`, environment variables, and `.showrunner/config.json`.

The most important settings are:

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Required for OpenRouter-backed planning, generation, review, and compaction. |
| `SHOWRUNNER_MODEL` | Controller model. Defaults to `anthropic/claude-sonnet-4.6`. |
| `SHOWRUNNER_ROUTING_POLICY` | Model-routing mode: `best_quality`, `balanced`, or `budget_aware`. |
| `SHOWRUNNER_DEFAULT_IMAGE_MODEL` | Default image/reference generation model. |
| `SHOWRUNNER_DEFAULT_VIDEO_MODEL` | Default video generation model. |
| `SHOWRUNNER_TTS_MODEL` | Default narration/dialogue speech model. |
| `SHOWRUNNER_MUSIC_MODEL` | Default music model. |
| `SHOWRUNNER_PRODUCTION_ROOT` | Directory for generated Productions. Defaults to `productions`. |
| `SHOWRUNNER_THREAD_PATH` | Persistent thread file. Defaults to `.showrunner/thread.json`. |

See [.env.example](.env.example) for the full set of supported variables.

## Project Layout

```text
src/
  cli.ts                  interactive command center
  agent.ts                OpenRouter Agent SDK controller loop
  domain/                 Production State schema, lifecycle, and legal actions
  tools/                  production tools for references, takes, audio, and export
  openrouter/             OpenRouter API helpers
  html/                   static Production Page rendering
docs/
  v0-architecture.md      system shape and V0 scope
  adr/                    architecture decision records
CONTEXT.md                domain language and naming rules
productions/              generated Production workspaces, ignored by git
.showrunner/              local config, session state, and persistent thread, ignored by git
```

Each Production is saved under `productions/<production-id>/`. The machine-readable source of truth is `production.json`; generated review pages are written to `pages/`.

## Development Notes

- Keep domain language aligned with [CONTEXT.md](CONTEXT.md).
- Use the ADRs in [docs/adr](docs/adr) as the source of truth for design decisions.
- Prefer runtime model discovery and role/modality routing over hardcoded model assumptions.
- Treat paid generation as approval-gated unless the active Production has an explicit Autonomy Policy and budget.
