# Showrunner

Showrunner is a video-production agent harness for planning, generating, reviewing, and assembling AI video work through OpenRouter.

## Language

**Production**:
The top-level creative job that holds the brief, target audience, platform, runtime, style guide, budget, scenes, assets, selected takes, exports, and progress.
_Avoid_: Project, job, campaign

**Budget Guardrail**:
A spending constraint that estimates, gates, and records generation cost without making cost the primary creative objective.
_Avoid_: Cost optimization, spend cap, cheap mode

**Autonomy Policy**:
The production-level rules that allow Showrunner to proceed without pausing at every approval gate, including budget cap, max takes, allowed models, and review thresholds.
_Avoid_: Auto mode, unattended mode, autopilot

**Shot**:
The smallest production unit the harness can plan, generate, review, retry, compare, and track as a video clip attempt.
_Avoid_: Clip, render, scene, prompt

**Scene**:
A coherent narrative or production segment made of ordered **Shots** that share continuity context.
_Avoid_: Sequence, chapter, section

**Reference**:
A reusable input asset that grounds continuity, style, character identity, setting, sound, or motion.
_Avoid_: Asset, source, inspiration

**Reference Set**:
A grouped continuity package that a **Production**, **Scene**, or **Shot** depends on, such as a character sheet, wardrobe sheet, prop scale sheet, environment plate, style frame, first frame, last frame, or return frame.
_Avoid_: Folder, collection, asset batch

**Generated Reference**:
A **Reference** created by the harness from the production brief, such as a style frame, character sheet, first frame, or last frame.
_Avoid_: Generated asset, AI image, concept art

**Reference Craft Recipe**:
The kind-specific generation plan for a **Generated Reference**, including prompt shape, image size, model preference, and why that model fits the reference job.
_Avoid_: Generic image prompt, image preset

**Identity Continuity Lock**:
The structured character contract for a recurring hero or guide, including name, role, presentation, face, hair, build, wardrobe, and the compact prompt that every **Reference** and relevant **Motion Prompt** must preserve.
_Avoid_: Character vibe, loose description, subject notes

**Take**:
A generated candidate video asset for a **Shot**, including its prompt, model, settings, inputs, job metadata, cost, and review notes.
_Avoid_: Version, attempt, render

**Motion Prompt**:
The executable text prompt sent with a **Take** request. It assumes **References** carry subject identity, composition, lighting, and style, so it focuses on positive, direct subject motion, scene motion, camera motion, style descriptors, and timing for one short **Shot**.
_Avoid_: Continuity bible, storyboard, prompt draft

**Take Review**:
A layered evaluation of a **Take** that combines model judgment, deterministic media checks, and optional human approval.
_Avoid_: Score, rating, QA

**Selected Take**:
The single **Take** chosen as the current best result for a **Shot**.
_Avoid_: Final render, winner, approved clip

**Finished Shot**:
A polished media derivative produced from a **Selected Take** by the **Finishing Pipeline**, ready for **Assembly**.
_Avoid_: Upscaled take, final clip, export segment

**Finishing Pipeline**:
The post-generation process that turns raw **Selected Takes** into **Finished Shots** through upscale, cleanup, frame-rate normalization, grain, codec choices, and provenance capture.
_Avoid_: Export, cleanup script, post-processing

**Sound Element**:
A generated or imported audio unit used in an **Assembly**, such as narration, music, ambience, sound effect, or native audio from a **Selected Take**.
_Avoid_: Audio asset, track, sound clip

**Native Take Audio**:
Audio generated with a **Take** by a video model, including synchronized speech, sound effects, ambience, or music.
_Avoid_: Final mix, baked-in audio, video audio

**Music Cue**:
A generated or imported piece of music placed against part or all of an **Assembly**.
_Avoid_: Song, soundtrack, background music

**Music Brief**:
The production-level direction for generated or imported **Music Cues**, including genre, emotional palette, instrumentation, pacing, and constraints.
_Avoid_: Music prompt, soundtrack spec, vibe

**Narration**:
Scripted spoken audio for a **Production**, **Scene**, or **Assembly**, including voice direction, timing, captions, and generated or imported speech files.
_Avoid_: TTS output, voiceover file, spoken track

**Sound Mix**:
The production-quality audio treatment for an **Assembly**, balancing speech, native audio, music, ambience, effects, fades, and loudness.
_Avoid_: Basic audio, soundtrack, audio pass

**Assembly**:
The edited timeline that combines **Selected Takes** with trims, ordering, transitions, sound, captions, and finishing choices.
_Avoid_: Edit plan, storyboard, playlist

**Export**:
A rendered deliverable file produced from an **Assembly** for a target platform or format.
_Avoid_: Final take, download, output

**Caption Artifact**:
An optional subtitle or caption file derived from **Narration**, speech-to-text, or the final **Sound Mix** for a specific **Export**.
_Avoid_: Captions as source script, transcript, required subtitle track

**Final Review**:
The aggregate pass/fail review for an **Export**, combining specialized reviewer findings into required fixes, optional improvements, and final signoff.
_Avoid_: QA pass, approval, scorecard

**Production State**:
The structured JSON source of truth for a **Production**, including stages, scenes, shots, takes, reviews, costs, assemblies, sound, exports, and approvals.
_Avoid_: Progress notes, markdown state, report

**Persistent Thread**:
The single long-lived local conversation record that lets the **Showrunner Controller** keep production context across turns while still treating **Production State** as the source of truth.
_Avoid_: Chat log, session transcript, scratch memory

**Thread Summary**:
A compacted production-aware summary of older **Persistent Thread** turns, preserving creative decisions, approvals, model choices, budget guardrails, artifact paths, unresolved questions, and the next action.
_Avoid_: Generic summary, memory dump, notes

**Context Compaction**:
The harness process that replaces older middle turns in the **Persistent Thread** with a **Thread Summary** while preserving the first turns, recent turns, and active **Production State** snapshot.
_Avoid_: Forgetting, reset, pruning

**Showrunner Controller**:
The conversational user-facing orchestrator that advances a **Production** through stage gates and delegates specialist work to role agents.
_Avoid_: Main agent, chat agent, coordinator

**Role Agent**:
A specialist agent responsible for a bounded production job such as producing, directing, cinematography, editing, sound design, or review.
_Avoid_: Subagent, persona, assistant

**Role Model**:
The OpenRouter text model assigned to a **Role Agent** or production job, such as Director planning, Motion Prompt writing, Scriptwriter narration/dialogue, review, or compaction.
_Avoid_: Default model, global model, assistant model

**Quality Routing Recipe**:
The modality-specific OpenRouter model preference order used under the **Budget Guardrail**, such as frontier text models for script and prompt work, Recraft for frame **References**, Kling-class video models for continuity-critical **Takes**, and Grok Voice for **Narration**.
_Avoid_: Cheapest model, auto model, random provider choice

**Story Treatment**:
The upfront creative contract for a **Production**: format, protagonist, goal, obstacle, stakes, ending, grounding rules, and style rules. It exists before paid generation so the user and harness can steer coherence instead of discovering the story from random **Takes**.
_Avoid_: Vibe, prompt idea, loose concept

**Production Process**:
The upfront workflow profile selected from the video kind, such as short film, music video, trailer, marketing video, explainer, documentary, social clip, or other. It defines the production goal, required decisions, required assets, shot design rules, audio plan, and review criteria before **Scenes** and **Shots** are trusted for paid generation.
_Avoid_: Generic workflow, one-size-fits-all pipeline

**Audio Strategy**:
The upfront decision for how a **Production** tells its story through sound: dialogue plus music, narration plus music, music-led, selected native audio, hybrid, or silent. It drives which speech and music assets are required before **Final Review** can pass.
_Avoid_: Background audio, afterthought, optional polish

**Production Page**:
A human-readable HTML surface that presents **Production State** dynamically for review, steering, and handoff.
_Avoid_: Markdown report, progress log, static notes

**Production Activity**:
The structured live event stream that explains what Showrunner is doing during planning, Reference generation, Take generation, Sound Mix, Export, approvals, costs, artifacts, and blockers.
_Avoid_: Raw chain of thought, spinner text, console spam

**Production Console**:
The TUI surface that renders **Production Activity** automatically while a **Production** is being planned, generated, repaired, finished, or exported.
_Avoid_: Debug command, hidden trace, manual status check

## Relationships

- A **Production** contains one or more ordered **Scenes**.
- A **Production** owns the creative, budget, and delivery constraints for its **Scenes**.
- A **Production** has one **Production State** as its machine-readable source of truth.
- A **Production** emits **Production Activity** while it is being planned, generated, repaired, finished, or exported.
- A **Persistent Thread** can refer to one active **Production**.
- A **Thread Summary** compacts older **Persistent Thread** turns.
- **Context Compaction** must preserve the active **Production State** reference.
- The **Showrunner Controller** advances a **Production** through stage gates.
- A **Production** can define an **Autonomy Policy**.
- The **Showrunner Controller** delegates to **Role Agents**.
- A **Role Agent** can have one **Role Model** selected through OpenRouter model discovery.
- A **Production Page** renders from **Production State**.
- A **Production Console** renders live **Production Activity** in the TUI.
- A **Production** owns one **Production Process** before the **Story Treatment** is trusted.
- A **Production** owns one **Story Treatment** before paid **References** or **Takes**.
- A **Production** owns one **Audio Strategy** that determines whether **Dialogue**, **Narration**, **Music Cues**, or **Native Take Audio** are required.
- A **Production** owns one **Music Brief** when music is needed.
- A **Production**, **Scene**, or **Assembly** can have **Narration** and **Dialogue**.
- A **Budget Guardrail** applies to paid generation across a **Production**, **Scene**, or **Shot**.
- A **Reference Set** can belong to a **Production**, **Scene**, or **Shot**.
- A **Reference Set** contains one or more **References**.
- A **Reference** can belong to a **Production**, **Scene**, or **Shot**.
- A **Generated Reference** is a specialized **Reference**.
- A **Reference Craft Recipe** shapes a **Generated Reference**.
- An **Identity Continuity Lock** is expressed through character-sheet **References**, first-frame **References**, and concise **Motion Prompt** reference matching.
- A **Quality Routing Recipe** selects models for **Role Agents**, **References**, **Takes**, **Dialogue**, **Narration**, and **Music Cues** while still obeying the **Budget Guardrail**.
- A **Scene** can have one or more **Music Cues**.
- A **Shot** is the atomic unit of generation and review.
- A **Scene** contains one or more ordered **Shots**.
- A **Scene** owns shared continuity context for its **Shots**.
- A **Shot** can have many **Takes**.
- A **Take** request has one **Motion Prompt**.
- A **Take** can have many **Take Reviews**.
- A **Take** can include **Native Take Audio**.
- A **Shot** has at most one **Selected Take**.
- A **Selected Take** can produce one **Finished Shot**.
- A **Finishing Pipeline** produces **Finished Shots** for **Assembly**.
- An **Assembly** contains one or more **Sound Elements**.
- **Native Take Audio** is a specialized **Sound Element** when used in an **Assembly**.
- A **Music Cue** is a specialized **Sound Element**.
- An **Assembly** has one **Sound Mix**.
- A **Production** has one or more **Assemblies**.
- An **Assembly** produces one or more **Exports**.
- An **Export** can have one or more optional **Caption Artifacts**.
- An **Export** has one **Final Review** before completion.

## Example dialogue

> **Dev:** "Should the harness retry the whole scene if the camera move fails?"
> **Domain expert:** "No, retry the **Shot**. The scene is just the larger creative context."
> **Dev:** "Do we delete the bad generations?"
> **Domain expert:** "No, keep them as **Takes**. Only promote the best one to **Selected Take**."
> **Dev:** "Where do platform and budget constraints live?"
> **Domain expert:** "On the **Production**. Those constraints should shape every scene and shot beneath it."
> **Dev:** "Does V0 stop after selecting the best generated clips?"
> **Domain expert:** "No. Showrunner should build an **Assembly** and render an **Export** so the Production is complete."
> **Dev:** "Can audio be basic placeholder polish in V0?"
> **Domain expert:** "No. The **Sound Mix** needs to meet the same production-quality bar as the visual edit."
> **Dev:** "Do all videos need captions?"
> **Domain expert:** "No. A **Caption Artifact** is optional and depends on the target video."
> **Dev:** "Where should reviewers read the current state?"
> **Domain expert:** "Use the **Production Page**. The JSON **Production State** is for the harness."

## Flagged ambiguities

- "prompt" by itself remains ambiguous; prompt drafts belong to **Shots**, and the executable text sent with a **Take** request is a **Motion Prompt**.
- "captions" are not required source material; a **Caption Artifact** is an optional derived deliverable for an **Export**.
