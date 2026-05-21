# Use Recraft-first frame Reference craft

Showrunner will use kind-specific Reference Craft Recipes instead of sending every Generated Reference through one generic image prompt.

Frame-oriented References such as first frames, last frames, return frames, and style frames should prefer Recraft image models when they are available through OpenRouter, unless the user explicitly overrides the model. Other Reference kinds can use the production default image model first and fall back to Recraft when appropriate.

This keeps frame References optimized for composition, style locking, and video-model anchoring while preserving runtime OpenRouter discovery and model overrideability.
