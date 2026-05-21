# Route frontier text models by role

Showrunner will not use one global text model for every production job.

Role Models are selected through OpenRouter model discovery. Director planning, Motion Prompt writing, Scriptwriter narration/dialogue, and review should prefer frontier text models such as `openai/gpt-5.5` and `anthropic/claude-opus-4.7` when available, then fall back to configured or controller models.

The selected Role Models are recorded in Production State so model choice is provenance, not hidden runtime behavior.
