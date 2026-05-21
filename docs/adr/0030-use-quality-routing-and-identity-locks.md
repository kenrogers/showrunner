# Use quality routing and Identity Continuity Locks

Showrunner will optimize production quality first under the Budget Guardrail, rather than defaulting to the cheapest available media model.

Video generation uses a Quality Routing Recipe with runtime OpenRouter discovery. For continuity-critical Shots, the preferred path is a video model with first-frame support, currently Kling v3 Pro when available, with Veo, Seedance, Wan, and budget-aware alternatives as fallbacks. Speech generation uses the same modality routing seam and prefers Grok Voice TTS when available.

Recurring characters must be represented by an Identity Continuity Lock in the Film Package. Reference Craft Recipes use that lock for character sheets and first-frame anchors, while Motion Prompts stay motion-first and include only a compact reference-matching instruction.

This keeps quality choices local to one routing module, preserves user/config overrides, and makes character continuity a structured production constraint instead of loose prose scattered through prompts.
