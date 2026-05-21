# Prototype Notes

Question tested: does the V0 Production state model feel right when driven by hand?

Verdict:

- The flow feels good after fixing the paid-preview approval trap. The fixed stage gates, approval rhythm, Shot -> Take -> Take Review -> Selected Take loop, Assembly, Sound Mix, Export, and Final Review path are worth carrying into the real implementation.

Things to watch:

- Whether the fixed stage gates feel too rigid.
- Whether approval gates interrupt at the right moments.
- Whether `Shot -> Take -> Take Review -> Selected Take` is easy to reason about.
- Whether failed Final Reviews route back to the right narrow fix stage.
- Whether audio/music/sound mix feels like a first-class part of completion.

Findings:

- A paid Take preview must hold an exclusive pending approval. The first prototype allowed a second preview to overwrite the pending approval, which stranded earlier `previewed` Takes and made the `takes` stage impossible to finish.
