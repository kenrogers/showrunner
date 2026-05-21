# Showrunner State Machine Prototype

PROTOTYPE - throwaway code for testing the design plan before real implementation.

Question: does the V0 Production state model feel right when driven through stage gates, paid-generation approvals, Take selection, Assembly, Sound Mix, Export, Final Review, and targeted repair routing?

Run it with:

```bash
node prototypes/showrunner-state-machine/tui.mjs
```

The prototype keeps all state in memory. It does not call OpenRouter, ffmpeg, or the filesystem beyond loading these prototype files.

When this answers the question, delete this directory or fold the validated reducer ideas into the real Showrunner implementation.
