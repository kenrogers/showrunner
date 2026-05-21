# Use Finishing Pipeline before Assembly

Showrunner will not treat a raw generated Take as the final visual unit for Assembly.

After a Take becomes a Selected Take, the Finishing Pipeline produces a Finished Shot with explicit upscale, cleanup, frame-rate normalization, grain, codec settings, output path, and provenance. Assembly and Export should use Finished Shots when they exist, falling back to raw Take media only when finishing has not run.

This follows professional AI-video workflow: the base generation is a digital negative, while polish happens in a separate finishing pass before the final edit.
