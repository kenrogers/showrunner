# Use natural language as the primary control plane

Showrunner will treat natural-language conversation as the primary way to create, steer, approve, and inspect a Production. Slash commands may remain as developer/debug shortcuts, but the product flow should route user messages through OpenRouter and the Agent SDK, then execute deterministic typed tools and stage transitions behind the scenes.
