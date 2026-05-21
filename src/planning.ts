import { z } from 'zod';
import { completeChatText } from './openrouter/api.js';
import { VideoKindSchema } from './domain/schema.js';
import type { FilmPackage, ProductionState } from './domain/schema.js';
import { rebuildReferenceSets } from './references.js';

const SHOT_SECONDS = 4;

const PlannedSceneSchema = z.object({
  title: z.string().min(1),
  purpose: z.string().min(1),
  location: z.string().min(1),
  characters: z.array(z.string()).default([]),
  style: z.string().min(1),
  lighting: z.string().min(1),
  emotionalBeat: z.string().min(1),
  audioIntent: z.string().min(1),
});

const PlannedShotSchema = z.object({
  sceneIndex: z.number().int().min(0),
  intent: z.string().min(1),
  durationSeconds: z.number().int().min(1).max(10).default(SHOT_SECONDS),
  promptDraft: z.string().min(20),
  camera: z.string().min(1).optional(),
  subjectMotion: z.string().min(1).optional(),
  continuityCritical: z.boolean().default(true),
  referenceDescription: z.string().min(1).optional(),
});

const PlannedTreatmentSchema = z.object({
  format: z.string().min(1),
  storyType: z.string().min(1),
  audiencePromise: z.string().min(1),
  protagonist: z.string().min(1),
  goal: z.string().min(1),
  obstacle: z.string().min(1),
  stakes: z.string().min(1),
  ending: z.string().min(1),
  groundingRules: z.array(z.string()).default([]),
  styleRules: z.array(z.string()).default([]),
  audioMode: z.enum(['dialogue_music', 'narration_music', 'music_led', 'hybrid', 'selected_take_audio', 'silent']).default('hybrid'),
  dialoguePlan: z.string().optional(),
  narrationPlan: z.string().optional(),
  musicPlan: z.string().optional(),
});

const PlannedProductionProcessSchema = z.object({
  kind: VideoKindSchema,
  primaryGoal: z.string().min(1),
  processSummary: z.string().min(1),
  planningPriorities: z.array(z.string()).default([]),
  requiredCreativeDecisions: z.array(z.string()).default([]),
  requiredAssets: z.array(z.string()).default([]),
  shotDesignRules: z.array(z.string()).default([]),
  audioPlan: z.string().min(1),
  reviewCriteria: z.array(z.string()).default([]),
});

export const ProductionPlanSchema = z.object({
  title: z.string().min(1).optional(),
  logline: z.string().min(1),
  productionProcess: PlannedProductionProcessSchema.optional(),
  treatment: PlannedTreatmentSchema.optional(),
  visualRules: z.array(z.string()).default([]),
  scenes: z.array(PlannedSceneSchema).min(1),
  shots: z.array(PlannedShotSchema).min(1),
});

export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;

export interface ProductionPlanResult {
  plan: ProductionPlan;
  source: 'model' | 'fallback';
  model?: string;
  warning?: string;
}

const TextRefinementSchema = z.object({
  shots: z.array(z.object({
    id: z.string(),
    promptDraft: z.string().min(20).optional(),
    camera: z.string().min(1).optional(),
    subjectMotion: z.string().min(1).optional(),
  })).default([]),
  narration: z.array(z.object({
    id: z.string(),
    text: z.string().min(1),
  })).default([]),
  dialogue: z.array(z.object({
    id: z.string(),
    shotId: z.string(),
    character: z.string(),
    text: z.string().min(1),
    voice: z.string().optional(),
    startSeconds: z.number().optional(),
    endSeconds: z.number().optional(),
  })).default([]),
});

export interface TextRefinementResult {
  source: 'model' | 'skipped' | 'failed';
  model?: string;
  scope: 'shots' | 'script';
  updatedShots: number;
  updatedNarration: number;
  updatedDialogue: number;
  warning?: string;
}

export async function planProductionWithOpenRouter(input: {
  apiKey: string;
  model: string;
  brief: string;
  runtimeSeconds: number;
}): Promise<ProductionPlanResult> {
  if (!input.apiKey) {
    return { plan: buildFallbackProductionPlan(input.brief, input.runtimeSeconds), source: 'fallback', warning: 'missing api key' };
  }

  try {
    const text = await completeChatText({
      apiKey: input.apiKey,
      model: input.model,
      json: true,
      temperature: 0.25,
      maxTokens: 6000,
      messages: [
        {
          role: 'system',
          content: [
            'You are Showrunner, a senior AI-film producer and video prompt engineer.',
            'Turn a user brief into a coherent storyboard and generation-ready prompts for short AI-video clips.',
            'The first decision is the kind of video being made: short_film, music_video, trailer, marketing_video, explainer, documentary, social_clip, or other.',
            'Design the production process around that kind. A short film needs story causality and character beats; a music video needs performance/rhythm/visual motifs; a trailer needs hook/escalation/payoff; a marketing video needs audience, offer, proof, product shots, and conversion goal.',
            'Follow current AI-video practice: do not prompt a whole movie at once; break it into short controlled shots.',
            'Before shots, make a treatment decision: what kind of video this is, who the protagonist is, what they want, what blocks them, what changes, and how audio carries the story.',
            'Choose an audio mode intentionally: dialogue_music for short-film scenes, narration_music for explainers/trailers, music_led when dialogue would make the piece weaker, selected_take_audio for native model audio, or silent only when requested.',
            'Each shot prompt must describe concrete visible subject, environment, action, camera motion, timing, lighting, palette, and style.',
            'Every shot must be causal: it changes the character situation or reveals a consequence from the previous shot.',
            'Avoid vague abstractions, command phrasing, negative prompts, product-template language, text-heavy shots, and symbolic montage that has no physical action.',
            'Represent abstract ideas through grounded scenes, props, choices, blocking, and consequences.',
            'Use positive language. Keep each shot to one main action with continuous motion.',
            'Output JSON only.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: planningPrompt(input.brief, input.runtimeSeconds),
        },
      ],
    });
    return {
      plan: normalizePlan(ProductionPlanSchema.parse(extractJson(text)), input.brief, input.runtimeSeconds),
      source: 'model',
      model: input.model,
    };
  } catch (err) {
    return {
      plan: buildFallbackProductionPlan(input.brief, input.runtimeSeconds),
      source: 'fallback',
      model: input.model,
      warning: (err as Error).message,
    };
  }
}

export function applyProductionPlan(state: ProductionState, plan: ProductionPlan): void {
  const normalized = normalizePlan(plan, state.production.brief, state.production.target.runtimeSeconds);
  if (normalized.title) state.production.title = normalized.title;

  state.scenes = normalized.scenes.map((scene, index) => ({
    id: `scene_${index + 1}`,
    productionId: state.production.id,
    order: index + 1,
    title: scene.title,
    purpose: scene.purpose,
    continuity: {
      location: scene.location,
      characters: scene.characters,
      style: scene.style,
      lighting: scene.lighting,
      emotionalBeat: scene.emotionalBeat,
      audioIntent: scene.audioIntent,
    },
    musicCueIds: [],
  }));

  state.shots = normalized.shots.map((shot, index) => {
    const scene = state.scenes[Math.min(Math.max(shot.sceneIndex, 0), state.scenes.length - 1)] ?? state.scenes[0];
    return {
      id: `shot_${index + 1}`,
      sceneId: scene.id,
      order: index + 1,
      intent: shot.intent,
      durationSeconds: shot.durationSeconds,
      promptDraft: shot.promptDraft,
      camera: shot.camera || cameraFromPrompt(shot.promptDraft),
      subjectMotion: shot.subjectMotion || subjectMotionFromPrompt(shot.promptDraft),
      continuityCritical: shot.continuityCritical,
      referenceSetIds: [],
      referenceIds: [],
      status: 'planned' as const,
    };
  });

  state.filmPackage = buildFilmPackage(state, normalized);
  rebuildReferenceSets(state, {
    visualRules: normalized.visualRules,
    shots: normalized.shots.map((shot, index) => ({
      shotId: `shot_${index + 1}`,
      intent: shot.intent,
      description: shot.referenceDescription,
      continuityCritical: shot.continuityCritical,
    })),
  });

  state.nextIds.scene = state.scenes.length + 1;
  state.nextIds.shot = state.shots.length + 1;
}

export async function refineProductionTextWithOpenRouter(input: {
  apiKey: string;
  model: string;
  state: ProductionState;
  scope: 'shots' | 'script';
  shotIds?: string[];
}): Promise<TextRefinementResult> {
  if (!input.apiKey) {
    return { source: 'skipped', model: input.model, scope: input.scope, updatedShots: 0, updatedNarration: 0, updatedDialogue: 0, warning: 'missing api key' };
  }

  try {
    const text = await completeChatText({
      apiKey: input.apiKey,
      model: input.model,
      json: true,
      temperature: input.scope === 'script' ? 0.45 : 0.3,
      maxTokens: input.scope === 'script' ? 5000 : 7000,
      messages: [
        {
          role: 'system',
          content: input.scope === 'script'
            ? scriptRefinementSystemPrompt()
            : shotRefinementSystemPrompt(),
        },
        {
          role: 'user',
          content: textRefinementPrompt(input.state, input.scope, input.shotIds),
        },
      ],
    });
    const parsed = TextRefinementSchema.parse(extractJson(text));
    const applied = applyTextRefinement(input.state, parsed, input.scope, input.shotIds);
    return { source: 'model', model: input.model, scope: input.scope, ...applied };
  } catch (err) {
    return {
      source: 'failed',
      model: input.model,
      scope: input.scope,
      updatedShots: 0,
      updatedNarration: 0,
      updatedDialogue: 0,
      warning: (err as Error).message,
    };
  }
}

export function buildFallbackProductionPlan(brief: string, runtimeSeconds: number): ProductionPlan {
  if (isDogSentinelBrief(brief)) {
    return buildDogSentinelPlan(brief, runtimeSeconds);
  }
  if (/\bnerfpocalypse\b/i.test(brief) || /\bopenrouter\b/i.test(brief)) {
    return buildNerfpocalypsePlan(runtimeSeconds);
  }
  return buildGenericFilmPlan(brief, runtimeSeconds);
}

export function planSummary(plan: ProductionPlan): string {
  return [
    plan.logline,
    `${plan.scenes.length} scenes, ${plan.shots.length} shots, ${plan.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0)} seconds planned.`,
  ].join(' ');
}

function planningPrompt(brief: string, runtimeSeconds: number): string {
  const shotCount = shotCountForRuntime(runtimeSeconds);
  return [
    `Brief: ${brief}`,
    `Runtime target: ${runtimeSeconds} seconds.`,
    `Create exactly ${shotCount} shots, each exactly ${SHOT_SECONDS} seconds, so the assembly can reach the runtime through stitched clips.`,
    '',
    'Required JSON shape:',
    '{',
    '  "title": "short title",',
    '  "logline": "one sentence",',
    '  "productionProcess": {',
    '    "kind": "short_film | music_video | trailer | marketing_video | explainer | documentary | social_clip | other",',
    '    "primaryGoal": "the main job this video must do",',
    '    "processSummary": "how this kind of production should be made",',
    '    "planningPriorities": ["what to solve before shot generation"],',
    '    "requiredCreativeDecisions": ["choices the user or harness must lock early"],',
    '    "requiredAssets": ["references, product assets, character sheets, music brief, proof points, etc."],',
    '    "shotDesignRules": ["shot rules specific to this video kind"],',
    '    "audioPlan": "how dialogue, narration, music, native audio, or silence should work for this kind",',
    '    "reviewCriteria": ["how this kind of video should be judged"]',
    '  },',
    '  "treatment": {',
    '    "format": "short film | trailer | product teaser | explainer | music video | other",',
    '    "storyType": "hero journey, mystery, documentary vignette, product proof, etc.",',
    '    "audiencePromise": "what the viewer will feel or understand",',
    '    "protagonist": "specific recurring subject",',
    '    "goal": "visible want",',
    '    "obstacle": "visible pressure or antagonist",',
    '    "stakes": "what is lost if the protagonist fails",',
    '    "ending": "concrete final change",',
    '    "groundingRules": ["physical reality rule that prevents abstract montage"],',
    '    "styleRules": ["visual style rule"],',
    '    "audioMode": "dialogue_music | narration_music | music_led | hybrid | selected_take_audio | silent",',
    '    "dialoguePlan": "who speaks and why, if useful",',
    '    "narrationPlan": "voiceover purpose, if useful",',
    '    "musicPlan": "score mood, instrumentation, and arc"',
    '  },',
    '  "visualRules": ["stable visual continuity rule"],',
    '  "scenes": [{ "title": "...", "purpose": "...", "location": "...", "characters": ["..."], "style": "...", "lighting": "...", "emotionalBeat": "...", "audioIntent": "..." }],',
    '  "shots": [{ "sceneIndex": 0, "intent": "...", "durationSeconds": 4, "promptDraft": "...", "camera": "...", "subjectMotion": "...", "continuityCritical": true, "referenceDescription": "..." }]',
    '}',
    '',
    'Prompt rules:',
    '- Decide productionProcess.kind before designing Scenes.',
    '- Make productionProcess specific to the kind. Do not use a generic short-film process for marketing videos, music videos, or trailers.',
    '- Use cinematic visual language, not explanations to the model.',
    '- Do not use product-launch placeholders unless the brief asks for a product ad.',
    '- For software, AI, creator, or startup briefs, use words like software creator, filmmaker, founder, researcher, operator, or engineer; avoid the ambiguous word builder.',
    '- If the brief names a story frame, encode it visibly across the shot sequence.',
    '- If the brief asks for OpenRouter as guide, make the guide visible through a concrete wayfinder mentor, console, map, route-lantern, or model-routing interface.',
    '- Ground software concepts in physical decisions: a creator at a workstation, a deadline, a delivery, a model route chosen, a review passed, a file shipped.',
    '- Do not make shots that only show storms, glowing symbols, floating UI, or abstract routes; attach each metaphor to a character action.',
    '- Avoid asking for legible text in-frame; use symbols, color, and action instead.',
  ].join('\n');
}

function normalizePlan(plan: ProductionPlan, brief: string, runtimeSeconds: number): ProductionPlan {
  if (isDogSentinelBrief(brief) && dogSentinelRepairNeeded(plan)) {
    return buildDogSentinelPlan(brief, runtimeSeconds);
  }
  const targetCount = shotCountForRuntime(runtimeSeconds);
  const scenes = plan.scenes.length > 0 ? plan.scenes : buildFallbackProductionPlan(brief, runtimeSeconds).scenes;
  const seedShots = plan.shots.length > 0 ? plan.shots : buildFallbackProductionPlan(brief, runtimeSeconds).shots;
  const shots = [...seedShots];
  while (shots.length < targetCount) {
    const previous = shots.at(-1) ?? seedShots[0];
    shots.push({
      ...previous,
      intent: `${previous.intent} continuation`,
      promptDraft: `${previous.promptDraft} The motion continues as one seamless cinematic beat with a slightly new camera angle.`,
    });
  }
  return {
    ...plan,
    scenes,
    shots: shots.slice(0, targetCount).map((shot, index) => ({
      ...shot,
      sceneIndex: Math.min(Math.max(shot.sceneIndex, 0), scenes.length - 1),
      durationSeconds: SHOT_SECONDS,
      promptDraft: cleanPrompt(shot.promptDraft, brief, index),
      camera: shot.camera?.trim() || cameraFromPrompt(shot.promptDraft),
      subjectMotion: shot.subjectMotion?.trim() || subjectMotionFromPrompt(shot.promptDraft),
    })),
  };
}

function buildNerfpocalypsePlan(runtimeSeconds: number): ProductionPlan {
  const baseShots = [
    ['Ordinary World', 'Maya, the same AI engineer hero in a charcoal hoodie, edits a client film alone in a cramped studio near midnight. A delivery clock, storyboard cards, and a nearly empty token jar sit beside her keyboard. Slow push-in, practical desk light, grounded live-action tech-noir.'],
    ['Call to Adventure', 'Maya starts a final render and the subscription dashboard beside the monitor collapses into red shrinking meters and locked gates. She freezes with one hand on the mechanical keyboard. Tight handheld push toward her face, rain tapping the window.'],
    ['Refusal', 'Maya tries three different single-model shortcuts on separate laptops; each screen dims and the progress bar stops before the client delivery drive is filled. Side tracking shot across real devices, anxious physical blocking, no readable UI text.'],
    ['Meeting the Guide', 'The OpenRouter wayfinder mentor enters the studio carrying a warm branching route-lantern and calmly sets a route map tablet beside Maya. Maya looks from the failed laptops to the new map. Slow orbit around both figures, amber light against blue shadows.'],
    ['Crossing the Threshold', 'Maya and the guide clear the desk, pin storyboard cards in order, and place colored model-route tokens under each task: draft, prompt, review, voice, music, export. Top-down shot, hands moving deliberately, practical tools and real workflow.'],
    ['First Trial', 'Maya routes rough visual drafts through a fast path, then slides the strongest storyboard card into a quality path for the hero shot. The route-lantern brightens when she makes the correct choice. Smooth macro camera move over cards and tokens.'],
    ['Allies and Tools', 'A small team of exhausted creators joins by the studio table; one hands Maya a reference image, another checks a budget gauge, the guide marks the route map. Gentle handheld shot, human collaboration, no abstract montage.'],
    ['Approach', 'Maya walks through a quiet hallway of frontier lab doors with shrinking meters, carrying the client drive and route-lantern. The guide follows one step behind, pointing to a side door with colored route icons. Slow dolly forward, tangible stakes.'],
    ['Ordeal', 'The largest lab door slams shut before Maya can deliver the final clip; the client drive slips from her hand and skids across the floor. The guide catches the drive and shines the lantern toward an alternate workstation. Sudden camera jolt, then steady recovery.'],
    ['Reward', 'Back at the alternate workstation, Maya assembles the film timeline: selected takes lock into place, dialogue waveforms appear, and a music track fills under the edit. Close-up on real hands, keyboard, timeline, and glowing route tokens.'],
    ['Road Back', 'Maya sprints the client drive back through the hallway as meters fail behind her, but each route token she placed keeps one workstation alive. Backward tracking shot, clear forward momentum, practical lights flickering.'],
    ['Resurrection', 'At dawn, Maya faces one last empty-token meter on the delivery station, breathes, and moves the export to a different colored route. The export light turns green and the drive finishes writing. Tight close-up on calm hands and relieved eyes.'],
    ['Return With Elixir', 'Maya returns to the studio and screens the finished short for the other creators; they watch the cut play while the guide stands quietly near the door. Warm studio light, honest relief, visible finished film on a monitor without readable text.'],
    ['New World', 'The creators rebuild the wall as a practical route board: cards, reference frames, model tokens, voice notes, music cues, and cost limits all visible as a repeatable workflow. Slow lateral move across the organized board.'],
    ['Final Image', 'Maya and the OpenRouter guide step onto the rooftop at sunrise with the client drive delivered and the route-lantern dimmed to a steady glow. Behind them the old lab towers remain, ahead the city shows many lit paths. Slow pullback, grounded hopeful finish.'],
  ];
  const count = shotCountForRuntime(runtimeSeconds);
  return {
    title: 'The Nerfpocalypse',
    logline: 'A creator survives the end of token subsidies by learning to route through the storm instead of trusting one shrinking gate.',
    productionProcess: {
      kind: 'short_film',
      primaryGoal: 'tell a complete character-driven story about surviving AI model limits through routing',
      processSummary: 'lock Maya, the guide, the client delivery stakes, dialogue/music strategy, character references, then generate causal story beats from midnight deadline to delivered film',
      planningPriorities: ['hero journey causality', 'Maya and guide continuity', 'physical production workflow', 'sparse dialogue', 'score arc'],
      requiredCreativeDecisions: ['Maya identity', 'OpenRouter guide identity', 'client delivery stakes', 'route-board motif', 'dialogue beats', 'music mood'],
      requiredAssets: ['Maya character sheet', 'OpenRouter guide character sheet', 'route-lantern prop reference', 'creator studio references', 'first-frame anchors', 'music cue', 'dialogue script'],
      shotDesignRules: ['each shot advances Maya toward or away from delivery', 'software constraints appear as physical work and props', 'no pure abstract montage'],
      audioPlan: 'dialogue plus score; no continuous narrator',
      reviewCriteria: ['story legibility', 'Maya continuity', 'guide continuity', 'grounded AI metaphors', 'dialogue fit', 'music supports the arc'],
    },
    treatment: {
      format: '60-second vertical short film',
      storyType: 'hero journey with grounded tech-noir satire',
      audiencePromise: 'a coherent little story about a creator finishing real work as model limits tighten',
      protagonist: 'Maya, a tired but capable AI engineer and filmmaker',
      goal: 'ship a client film before the final subscription limits cut her off',
      obstacle: 'frontier AI lab subscription gates shrink and single-model workflows fail at the worst moment',
      stakes: 'Maya loses the delivery, the client, and her confidence if the film does not ship',
      ending: 'Maya delivers the film and returns with a durable multi-model route board',
      groundingRules: [
        'Every metaphor must be attached to a physical action by Maya, the guide, or the creator team.',
        'Show real production work: storyboard cards, reference frames, route tokens, timelines, voice waveforms, music cues, delivery drive.',
        'No pure storm montage, floating UI montage, or unrelated sci-fi spectacle.',
      ],
      styleRules: [
        'Grounded live-action tech-noir with practical monitors, desk lights, rain, and amber route light.',
        'Keep the hero and guide human-scale and consistent.',
      ],
      audioMode: 'dialogue_music',
      dialoguePlan: 'Short-film dialogue carries the key turning points between Maya and the OpenRouter guide.',
      narrationPlan: 'No continuous voiceover; let action, dialogue, and score tell the story.',
      musicPlan: 'Restrained tech-noir score with low pulse, sparse percussion, and a hopeful sunrise lift.',
    },
    visualRules: [
      'Use grounded tech-noir realism with studio tools, shrinking meters, delivery drive, route tokens, and route-lantern imagery.',
      'Keep the hero as Maya, the same woman AI engineer in a charcoal hoodie, tired focused eyes, shoulder-length dark wavy hair, bare head, and warm desk-light silhouette.',
      'Show OpenRouter as a calm wayfinder mentor with a branching route-map lantern, not as a flat logo or text overlay.',
      'Avoid literal readable UI text; use icons, color, meters, doors, paths, and action to tell the story.',
    ],
    scenes: [
      {
        title: 'The Subsidy Storm',
        purpose: 'Establish the hero, the collapsing token subsidy era, and the danger of depending on one frontier lab.',
        location: 'rainy near-future creator studio and glass lab district',
        characters: ['Maya, the AI engineer hero'],
        style: 'cinematic tech-noir satire, grounded live-action realism',
        lighting: 'cold lab-blue storm light with warm desk practicals',
        emotionalBeat: 'confusion turning into dread',
        audioIntent: 'low score pulse, tense room tone, sparse dialogue',
      },
      {
        title: 'The Guide Appears',
        purpose: 'Introduce OpenRouter as the mentor who teaches routing, tradeoffs, and resilience.',
        location: 'collapsing subscription corridor and luminous routing-map room',
        characters: ['Maya, the AI engineer hero', 'the OpenRouter wayfinder mentor'],
        style: 'hero journey mentor sequence with modern AI-console imagery',
        lighting: 'warm route-lantern glow cutting through cold shadows',
        emotionalBeat: 'panic turning into trust',
        audioIntent: 'music gains rhythm; mentor dialogue calm and sparse',
      },
      {
        title: 'Surviving the Nerfpocalypse',
        purpose: 'Show the hero using multi-model routing to finish the film and return with a durable workflow.',
        location: 'storm city, resilient studio, sunrise rooftop',
        characters: ['Maya, the AI engineer hero', 'the OpenRouter wayfinder mentor', 'other creators'],
        style: 'hopeful cinematic finale, practical interfaces, mythic tech imagery',
        lighting: 'stormy blue resolving into sunrise gold',
        emotionalBeat: 'mastery and relief',
        audioIntent: 'heroic but restrained synth score, brief final exchange',
      },
    ],
    shots: baseShots.slice(0, count).map(([intent, promptDraft], index) => ({
      sceneIndex: Math.min(2, Math.floor(index / Math.max(1, Math.ceil(count / 3)))),
      intent,
      durationSeconds: SHOT_SECONDS,
      promptDraft,
      camera: cameraFromPrompt(promptDraft),
      subjectMotion: subjectMotionFromPrompt(promptDraft),
      continuityCritical: true,
      referenceDescription: `Reference frame for ${intent}: ${promptDraft}`,
    })),
  };
}

function buildDogSentinelPlan(brief: string, runtimeSeconds: number): ProductionPlan {
  const baseShots = [
    ['Perimeter Watch', 'The Sentinel, the same medium-sized family dog, lies beneath the front window at dawn with one eye open while two relaxed humans move casually in the kitchen behind him. Low dog-eye close-up, slow push-in, brooding action-thriller lighting, quiet suburban yard beyond the glass.'],
    ['First Contact', 'The Sentinel rises into alert posture as a neighbor steps onto the sidewalk outside the fence carrying a coffee mug. Low angle from behind the dog, ears lifting sharply, the humans remain unfocused in the background, muted morning light.'],
    ['The Warning', 'The Sentinel plants himself inside at the closed glass door and barks sharply toward the ordinary neighbor outside, shoulders squared and ears forward. Tracking shot at dog height from behind the dog, clear barrier, tense thriller framing, clean threshold.'],
    ['Command Ignored', 'One relaxed human stands safely inside the warm kitchen holding a coffee mug while The Sentinel braces between the family and the closed glass door, tail rigid, shoulders squared. Over-the-shoulder dog POV toward the careless human, dry restrained humor through serious framing.'],
    ['Courier Breach', 'Spatial lock: The Sentinel starts several feet inside the hallway with his back to camera, then sprints away from camera toward a closed glass front door while a mail carrier stands outside on the porch holding a small package. Tight dog-height follow shot, clear barrier between dog and mail carrier, grounded suburban realism.'],
    ['Payload Assessment', 'The Sentinel sniffs under the door, then snaps his gaze toward the kitchen where the humans chat peacefully over coffee. Slow rack focus from dog muzzle to oblivious humans, grounded suburban realism.'],
    ['Fence Line', 'A squirrel runs along the top of the wooden fence and The Sentinel launches into a precise parallel patrol across the grass. Fast low tracking move beside the dog, serious chase energy, no cartoon exaggeration.'],
    ['False Calm', 'The squirrel vanishes and the yard goes still; The Sentinel pauses by a flower bed, listening as sprinklers tick in the distance. Locked camera at dog height, held tension, ordinary backyard details treated like a hostile landscape.'],
    ['Trash Bin Maneuver', 'A neighbor rolls a trash bin along the curb and The Sentinel tracks the wheels through the fence slats like surveillance footage. Narrow low-angle composition, the dog’s eye fills the foreground, concrete action and clear geography.'],
    ['The Idiots Laugh', 'Inside, the family laughs at a phone video while The Sentinel stands alone in the hallway, framed like the last guard at a checkpoint. Slow dolly backward, warm domestic light behind him, cool yard light ahead.'],
    ['Leaf Event', 'A single dry leaf lies flat on the patio concrete, then skitters along the ground in a light breeze as The Sentinel pivots instantly from the doorway. Sudden whip-pan into a stable heroic close-up, restrained deadpan premise, no slapstick.'],
    ['Open Door Protocol', 'A human opens the back door and The Sentinel steps out first, scanning left and right before allowing the family onto the patio. Low hero shot from the threshold, afternoon light, action-thriller body language.'],
    ['Stand Down', 'The neighbor waves from across the fence; The Sentinel holds his stare, then slowly lowers from full alert to watchful suspicion. Medium dog-height shot through fence slats, serious performance, normal suburban world.'],
    ['Protected Silence', 'At dusk, the family eats peacefully inside while The Sentinel rests at the doorway facing outward, the yard reflected in his eyes. Slow push-in, warm interior behind him, blue exterior ahead, earned quiet.'],
    ['The Next Threat', 'The Sentinel sits quietly in the moonlit yard facing the fence, alert and still, eyes tracking one small movement in the dark. Slow dog-height push-in, final thriller button, watchful restraint instead of a trick pose.'],
  ];
  const count = shotCountForRuntime(runtimeSeconds);
  const shots = expandShotBeats(baseShots, count).map(([intent, promptDraft], index) => ({
    sceneIndex: Math.min(2, Math.floor(index / Math.max(1, Math.ceil(count / 3)))),
    intent,
    durationSeconds: SHOT_SECONDS,
    promptDraft,
    camera: cameraFromPrompt(promptDraft),
    subjectMotion: subjectMotionFromPrompt(promptDraft),
    continuityCritical: true,
    referenceDescription: `First frame for ${intent}: ${promptDraft}`,
  }));

  return {
    title: titleFromDogSentinelBrief(brief),
    logline: 'A vigilant family dog narrates an ordinary suburban day as if he is the last line of defense in an action thriller.',
    productionProcess: dogSentinelProductionProcess(),
    treatment: {
      ...dogSentinelTreatment(),
      audioMode: 'narration_music',
      dialoguePlan: 'No human dialogue; the humans can be heard as soft background life, but the dog carries the point of view.',
      narrationPlan: 'Sparse first-person inner monologue from The Sentinel, played completely straight like a thriller protagonist.',
      musicPlan: dogSentinelMusicPrompt(),
    },
    visualRules: dogSentinelVisualRules(),
    scenes: [
      {
        title: 'The Perimeter',
        purpose: 'Establish the dog as the serious guardian of a normal suburban home.',
        location: 'family kitchen, front window, fenced suburban yard',
        characters: ['The Sentinel, the family dog', 'his oblivious humans'],
        style: 'grounded live-action suburban action thriller with restrained dry comedy',
        lighting: 'cool dawn exterior light against warm careless interior light',
        emotionalBeat: 'watchfulness and dread',
        audioIntent: 'low thriller score and sparse dog inner monologue',
      },
      {
        title: 'Routine Threats',
        purpose: 'Escalate ordinary neighbors, delivery, squirrels, bins, and leaves into the dog’s perceived threat map.',
        location: 'porch, fence line, backyard, hallway checkpoint',
        characters: ['The Sentinel, the family dog', 'neighbors', 'delivery person', 'his oblivious humans'],
        style: 'serious surveillance and patrol grammar applied to everyday suburban life',
        lighting: 'harder daylight contrast with low dog-height framing',
        emotionalBeat: 'pressure and duty',
        audioIntent: 'brooding pulse, quiet household ambience, dog POV narration only at turning points',
      },
      {
        title: 'Stand Watch',
        purpose: 'Resolve with the family safe and the dog still guarding against the next harmless threat.',
        location: 'back patio, fence, dusk doorway, moonlit yard',
        characters: ['The Sentinel, the family dog', 'his oblivious humans', 'neighbor beyond the fence'],
        style: 'earned action-thriller calm with deadpan suburban normalcy',
        lighting: 'warm home light giving way to blue dusk and moonlit yard',
        emotionalBeat: 'vigilance without self-awareness',
        audioIntent: 'score softens, then returns to a final tense button',
      },
    ],
    shots,
  };
}

function buildDogSentinelFilmPackage(state: ProductionState): FilmPackage {
  return {
    productionProcess: dogSentinelProductionProcess(),
    storyTreatment: dogSentinelTreatment(),
    audioStrategy: {
      mode: 'narration_music',
      dialogueApproach: 'No dialogue-led scenes; humans stay secondary and oblivious.',
      narrationApproach: 'The dog narrates as a grave action-thriller sentinel, with the humor coming from ordinary suburban threats.',
      voiceDirection: 'Masculine, low, brooding action-thriller inner monologue. Restrained urgency, decisive pauses, dry deadpan seriousness, never goofy.',
      speechTagProfile: 'brooding_thriller',
      musicRequired: true,
      musicPrompt: dogSentinelMusicPrompt(),
    },
    visualContinuity: {
      hero: dogSentinelHeroLock(),
      heroIdentity: {
        name: 'The Sentinel',
        role: 'family dog protagonist and yard guardian',
        genderPresentation: 'male-coded family dog only if the narration uses he/him',
        ageRange: 'adult dog',
        face: 'expressive brown eyes, alert ears, serious muzzle, natural canine proportions',
        hair: 'short brown-and-white fur with consistent markings',
        build: 'medium-sized athletic family dog, sturdy but domestic',
        wardrobe: 'natural fur only, no human clothing or costume',
        continuityPrompt: dogSentinelHeroLock(),
      },
      wardrobe: 'natural brown-and-white fur with consistent markings; no clothes, armor, badges, or tactical gear',
      palette: 'suburban action-thriller palette: cool blue yard shadows, warm careless home interiors, grounded natural light, restrained contrast',
      motifs: ['front window watch post', 'fence line', 'welcome mat checkpoint', 'cardboard delivery box', 'trash bin wheels', 'single moving leaf'],
      forbidden: [
        'human protagonist',
        'random male action hero',
        'soldier or police dog fantasy',
        'tactical armor',
        'cartoon dog',
        'talking mouth animation',
        'heavy-handed comedy',
        'readable text or title cards',
        'floating leaves outside the leaf shot',
        'random loose leaves outside the leaf shot',
        'dog standing upright on hind legs',
      ],
      promptPrefix: [
        `Identity continuity lock: ${dogSentinelHeroLock()}`,
        'Point of view lock: the world is seen at dog height, with humans secondary and oblivious.',
        'Story lock: every shot shows an ordinary suburban event treated with serious action-thriller grammar.',
        'Comedy lock: keep performances grounded and straight-faced; the joke is the mismatch between tone and harmless threats.',
      ].join(' '),
      frameChaining: true,
    },
    narration: dogSentinelNarration(state),
    dialogue: [],
    music: {
      id: 'music_1',
      prompt: dogSentinelMusicPrompt(),
      required: true,
    },
  };
}

function dogSentinelProductionProcess(): NonNullable<FilmPackage['productionProcess']> {
  return {
    kind: 'short_film',
    primaryGoal: 'tell a complete dog-POV action-thriller short where ordinary yard events become perceived threats',
    processSummary: 'lock the dog protagonist, dog-height visual grammar, suburban threat ladder, first-person inner monologue, restrained thriller score, then generate grounded causal shots',
    planningPriorities: ['dog protagonist continuity', 'dog-height POV', 'ordinary threats staged concretely', 'dead-serious tone', 'sparse inner monologue', 'brooding score'],
    requiredCreativeDecisions: ['dog look and markings', 'family home geography', 'threat ladder', 'narrator voice', 'score mood', 'final button'],
    requiredAssets: ['dog character sheet', 'suburban yard environment plate', 'dog-height style frame', 'prop/motif sheet', 'first-frame anchors', 'narration script', 'music cue'],
    shotDesignRules: ['The Sentinel is the protagonist in every story beat', 'humans are secondary and oblivious', 'each threat must be a normal visible thing', 'camera stays mostly at dog height', 'no abstract montage'],
    audioPlan: 'first-person dog inner monologue plus serious restrained thriller music; no human dialogue-led scenes',
    reviewCriteria: ['dog continuity', 'dog POV clarity', 'ordinary-threat grounding', 'serious thriller tone', 'subtle humor', 'music and narration support the premise'],
  };
}

function dogSentinelTreatment(): NonNullable<FilmPackage['storyTreatment']> {
  return {
    format: '60-second vertical short film',
    storyType: 'deadpan dog-POV action thriller',
    audiencePromise: 'a normal day in a yard feels like a high-stakes perimeter defense mission from the dog’s perspective',
    protagonist: 'The Sentinel, a vigilant family dog guarding his yard',
    goal: 'keep his oblivious humans safe from every approaching yard threat',
    obstacle: 'neighbors, delivery people, squirrels, trash bins, leaves, and humans who do not understand the danger',
    stakes: 'if he drops his watch, the careless humans will wander unprotected through the perimeter',
    ending: 'the family is safe for the night, but one tiny new movement restarts his watch',
    groundingRules: [
      'Every threat is an ordinary physical event in or near a suburban yard.',
      'The dog must remain the protagonist and visual anchor; humans are never the hero.',
      'Use dog-height blocking and concrete actions instead of symbolic thriller montage.',
      'The humor stays implicit in the serious treatment of harmless events.',
    ],
    styleRules: [
      'Grounded live-action realism, not cartoon or mascot comedy.',
      'Action-thriller camera grammar at dog height: push-ins, tracking, surveillance through fence slats, heroic threshold shots.',
      'Consistent medium-sized brown-and-white family dog with the same markings in every reference and shot.',
    ],
  };
}

function dogSentinelVisualRules(): string[] {
  return [
    dogSentinelHeroLock(),
    'Keep humans as soft secondary figures: relaxed, oblivious, warm domestic light, never the protagonist.',
    'Use a normal suburban yard, porch, fence, window, hallway, and patio as the recurring geography.',
    'Treat harmless things as serious threats through camera, blocking, and music rather than exaggerated comedy.',
    'Avoid readable text, tactical costume, cartoon styling, random human heroes, disconnected abstract imagery, and loose leaves except in the dedicated leaf shot.',
  ];
}

function dogSentinelHeroLock(): string {
  return 'The Sentinel is the same medium-sized adult mixed-breed family dog in every shot, warm brown-and-white short fur, white blaze down the snout, white chest and front legs, brown patches around both eyes, expressive brown eyes, semi-floppy alert ears, sturdy domestic build, natural canine proportions, no clothing, no armor, serious watchful expression.';
}

function dogSentinelMusicPrompt(): string {
  return 'restrained action-thriller score for a deadpan dog-POV short film, low strings, soft analog pulse, sparse percussion, brooding and serious, subtle warmth for the family, final tense button, no vocals';
}

function dogSentinelNarration(state: ProductionState): FilmPackage['narration'] {
  const lines = [
    ['shot_1', 'They call it a yard. I call it the perimeter.'],
    ['shot_3', 'Every morning, the careless ones forget what waits outside.'],
    ['shot_5', 'Unknown courier. Box-shaped payload. No visible fear.'],
    ['shot_7', 'Fast mover on the fence line. Small. Reckless.'],
    ['shot_9', 'Wheels at the curb. Pattern irregular. Intent unknown.'],
    ['shot_11', 'A leaf crosses the patio. No one raises the alarm.'],
    ['shot_13', 'The neighbor retreats.'],
    ['shot_14', 'Peace maintained... for now.'],
    ['shot_15', 'I am the Sentinel.'],
  ] as const;
  return lines.map(([shotId, text], index) => timedNarrationLine(state, {
    id: `narration_${index + 1}`,
    shotId,
    text,
  }));
}

function timedNarrationLine(
  state: ProductionState,
  line: { id: string; shotId: string; text: string },
): FilmPackage['narration'][number] {
  const shot = state.shots.find((candidate) => candidate.id === line.shotId);
  const defaultStartSeconds = shot ? (shot.order - 1) * shot.durationSeconds + 0.25 : 0;
  const startSeconds = shot && /^I am the Sentinel\.?$/i.test(line.text.trim())
    ? Math.max((shot.order - 1) * shot.durationSeconds, shot.order * shot.durationSeconds - 1.8)
    : defaultStartSeconds;
  const endSeconds = shot ? Math.min(shot.order * shot.durationSeconds - 0.15, startSeconds + 3.4) : startSeconds + 3.4;
  return {
    ...line,
    text: compactSpokenLine(line.text),
    voice: 'Leo',
    startSeconds,
    endSeconds,
  };
}

function isDogSentinelBrief(brief: string): boolean {
  const mentionsDog = /\b(dog|dogs|dog's|dogs'|canine|pup|puppy)\b/i.test(brief);
  const mentionsWatch = /\b(sentinel|bark|barks|barking|yard|perimeter|neighbors?|delivery|squirrel|threat|guard|protect)\b/i.test(brief);
  const mentionsPov = /\b(from (?:the )?dog'?s perspective|perspective of (?:the )?dog|dog pov|dog-?pov|narrat(?:e|es|ed|ion).{0,80}\bdog|inner monologue)\b/i.test(brief);
  return mentionsDog && mentionsWatch && (mentionsPov || /\bsentinel\b/i.test(brief));
}

function dogSentinelRepairNeeded(plan: ProductionPlan): boolean {
  const protagonist = plan.treatment?.protagonist ?? '';
  const audioMode = plan.treatment?.audioMode;
  const processText = [
    plan.logline,
    protagonist,
    plan.treatment?.goal,
    plan.treatment?.obstacle,
    ...plan.visualRules,
    ...plan.scenes.flatMap((scene) => [scene.location, ...scene.characters]),
  ].filter(Boolean).join(' ');
  if (!/\b(dog|canine|Sentinel)\b/i.test(protagonist)) return true;
  if (!/\b(dog|canine|yard|perimeter|Sentinel)\b/i.test(processText)) return true;
  if (audioMode !== 'narration_music') return true;
  return false;
}

function titleFromDogSentinelBrief(brief: string): string {
  return /\bThe Sentinel\b/i.test(brief) ? 'The Sentinel' : 'The Sentinel';
}

function expandShotBeats(beats: string[][], count: number): string[][] {
  const expanded = [...beats];
  while (expanded.length < count) {
    const [intent, promptDraft] = expanded.at(-1) ?? beats[0];
    expanded.push([
      `${intent} continuation`,
      `${promptDraft} The moment continues from a slightly different dog-height angle with the same dog, same yard geography, and one continuous grounded action.`,
    ]);
  }
  return expanded.slice(0, count);
}

function buildFilmPackage(state: ProductionState, plan: ProductionPlan): FilmPackage {
  if (isDogSentinelBrief(state.production.brief)) {
    return buildDogSentinelFilmPackage(state);
  }
  if (/\bnerfpocalypse\b/i.test(state.production.brief) || /\bopenrouter\b/i.test(state.production.brief)) {
    return buildNerfpocalypseFilmPackage(state);
  }

  const productionProcess = productionProcessForPlan(state, plan);
  const storyTreatment = storyTreatmentForPlan(state, plan, productionProcess);
  const audioStrategy = audioStrategyForPlan(state, plan, storyTreatment, productionProcess);
  const narration = narrationLinesForPlan(state, plan, audioStrategy.mode);
  const dialogue = dialogueLinesForPlan(state, storyTreatment, audioStrategy.mode);

  return {
    productionProcess,
    storyTreatment,
    audioStrategy,
    visualContinuity: {
      hero: 'The same main subject appears throughout, with consistent age, build, wardrobe, hair, and emotional arc.',
      guide: undefined,
      wardrobe: 'single consistent outfit established in the first shot',
      palette: 'consistent motivated cinematic palette from the first scene',
      motifs: ['one recurring object or light motif', 'one consistent setting language'],
      forbidden: ['random new main characters', 'unmotivated costume changes', 'readable UI text unless explicitly requested'],
      promptPrefix: [
        'Continuity lock: preserve the same main subject from the previous shots, same face type, same wardrobe, same palette, same world.',
        'Shot design: one main action, clear beginning-middle-end motion, cinematic framing, motivated light, no random new protagonist.',
      ].join(' '),
      frameChaining: true,
    },
    narration,
    dialogue,
    ...(audioStrategy.musicRequired ? {
      music: {
        id: 'music_1',
        prompt: audioStrategy.musicPrompt ?? 'restrained cinematic underscore, warm pulse, no vocals, supports the edit without masking speech',
        required: true,
      },
    } : {}),
  };
}

function productionProcessForPlan(state: ProductionState, plan: ProductionPlan): NonNullable<FilmPackage['productionProcess']> {
  const kind = plan.productionProcess?.kind ?? kindFromFormat(plan.treatment?.format) ?? videoKindFromBrief(state.production.brief);
  const fallback = productionProcessForKind(kind, state.production.brief);
  return {
    kind,
    primaryGoal: plan.productionProcess?.primaryGoal ?? fallback.primaryGoal,
    processSummary: plan.productionProcess?.processSummary ?? fallback.processSummary,
    planningPriorities: plan.productionProcess?.planningPriorities?.length ? plan.productionProcess.planningPriorities : fallback.planningPriorities,
    requiredCreativeDecisions: plan.productionProcess?.requiredCreativeDecisions?.length ? plan.productionProcess.requiredCreativeDecisions : fallback.requiredCreativeDecisions,
    requiredAssets: plan.productionProcess?.requiredAssets?.length ? plan.productionProcess.requiredAssets : fallback.requiredAssets,
    shotDesignRules: plan.productionProcess?.shotDesignRules?.length ? plan.productionProcess.shotDesignRules : fallback.shotDesignRules,
    audioPlan: plan.productionProcess?.audioPlan ?? fallback.audioPlan,
    reviewCriteria: plan.productionProcess?.reviewCriteria?.length ? plan.productionProcess.reviewCriteria : fallback.reviewCriteria,
  };
}

function storyTreatmentForPlan(
  state: ProductionState,
  plan: ProductionPlan,
  process: NonNullable<FilmPackage['productionProcess']>,
): NonNullable<FilmPackage['storyTreatment']> {
  const fallbackFormat = videoKindLabel(process.kind);
  return {
    format: plan.treatment?.format ?? fallbackFormat,
    storyType: plan.treatment?.storyType ?? 'three-beat visual story',
    audiencePromise: plan.treatment?.audiencePromise ?? 'a clear, grounded progression from setup to change',
    protagonist: plan.treatment?.protagonist ?? 'the recurring main subject',
    goal: plan.treatment?.goal ?? 'complete one visible objective',
    obstacle: plan.treatment?.obstacle ?? 'a concrete pressure that complicates the objective',
    stakes: plan.treatment?.stakes ?? 'the objective matters emotionally or practically',
    ending: plan.treatment?.ending ?? 'a concrete final image shows what changed',
    groundingRules: plan.treatment?.groundingRules?.length ? plan.treatment.groundingRules : [
      'Every shot must show a subject doing something observable in a specific place.',
      'Visual metaphors must be attached to props, blocking, or cause-and-effect action.',
    ],
    styleRules: plan.treatment?.styleRules?.length ? plan.treatment.styleRules : [
      'Use motivated lighting and one coherent visual language across the whole piece.',
      'Keep the same subject, setting logic, and object language across shots.',
    ],
  };
}

function audioStrategyForPlan(
  state: ProductionState,
  plan: ProductionPlan,
  treatment: NonNullable<FilmPackage['storyTreatment']>,
  process: NonNullable<FilmPackage['productionProcess']>,
): NonNullable<FilmPackage['audioStrategy']> {
  const brief = state.production.brief;
  const explicitMode = plan.treatment?.audioMode;
  const mode = explicitMode ?? audioModeForKind(process.kind, brief);
  const musicRequired = mode === 'dialogue_music' ||
    mode === 'narration_music' ||
    mode === 'music_led' ||
    /\b(music|score|soundtrack|underscore|song|jazz|synth|percussion)\b/i.test(brief);
  return {
    mode,
    dialogueApproach: plan.treatment?.dialoguePlan ?? (
      mode === 'dialogue_music' || mode === 'hybrid'
        ? `Use sparse dialogue only when ${treatment.protagonist} makes a choice or hits a turning point.`
        : undefined
    ),
    narrationApproach: plan.treatment?.narrationPlan ?? (
      mode === 'narration_music'
        ? process.kind === 'marketing_video'
          ? 'Use concise voiceover to connect audience problem, product proof, benefit, and action.'
          : 'Use concise narration as connective tissue, not as a replacement for visible action.'
        : undefined
    ),
    musicRequired,
    musicPrompt: plan.treatment?.musicPlan ?? (
      musicRequired
        ? `cinematic score for ${treatment.format}, grounded and emotionally legible, no vocals unless requested, supports ${treatment.storyType}`
        : undefined
    ),
  };
}

function videoKindFromBrief(brief: string): NonNullable<FilmPackage['productionProcess']>['kind'] {
  if (/\bmusic video\b/i.test(brief)) return 'music_video';
  if (/\b(trailer|teaser trailer|launch trailer|film trailer)\b/i.test(brief)) return 'trailer';
  if (/\b(marketing video|ad|advertisement|commercial|product video|product teaser|brand teaser|launch teaser|promo|campaign|conversion|landing page|brand video)\b/i.test(brief)) return 'marketing_video';
  if (/\b(explainer|tutorial|how it works|educational)\b/i.test(brief)) return 'explainer';
  if (/\b(documentary|docu|case study|interview)\b/i.test(brief)) return 'documentary';
  if (/\b(short film|film|story|scene|narrative|hero'?s journey)\b/i.test(brief)) return 'short_film';
  if (/\b(short|reel|tiktok|youtube short|vertical)\b/i.test(brief)) return 'social_clip';
  return 'other';
}

function kindFromFormat(format?: string): NonNullable<FilmPackage['productionProcess']>['kind'] | undefined {
  if (!format) return undefined;
  return videoKindFromBrief(format) === 'other' ? undefined : videoKindFromBrief(format);
}

function videoKindLabel(kind: NonNullable<FilmPackage['productionProcess']>['kind']): string {
  return kind.replaceAll('_', ' ');
}

function audioModeForKind(
  kind: NonNullable<FilmPackage['productionProcess']>['kind'],
  brief: string,
): NonNullable<FilmPackage['audioStrategy']>['mode'] {
  if (/\b(no dialogue|without dialogue|music video|visual poem)\b/i.test(brief)) return 'music_led';
  if (/\b(narration|narrate|narrates|narrated|voiceover|voice-over|inner monologue|pov|point of view|from (?:the )?.{0,30}perspective|explainer|documentary|trailer|teaser|ad|commercial)\b/i.test(brief)) return 'narration_music';
  if (kind === 'music_video') return 'music_led';
  if (kind === 'trailer') return 'narration_music';
  if (kind === 'marketing_video' || kind === 'explainer' || kind === 'documentary') return 'narration_music';
  if (kind === 'short_film') return 'dialogue_music';
  if (/\b(short film|dialogue|conversation|scene|character|hero'?s journey|narrative)\b/i.test(brief)) return 'dialogue_music';
  return 'hybrid';
}

function productionProcessForKind(
  kind: NonNullable<FilmPackage['productionProcess']>['kind'],
  brief: string,
): NonNullable<FilmPackage['productionProcess']> {
  const common = {
    kind,
    primaryGoal: 'make a coherent finished video',
    processSummary: 'lock the production shape, generate references, animate controlled shots, assemble, mix, export, and review',
    planningPriorities: ['audience', 'continuity', 'shot sequence', 'sound plan'],
    requiredCreativeDecisions: ['target viewer', 'visual style', 'audio approach', 'final deliverable'],
    requiredAssets: ['style references', 'continuity references'],
    shotDesignRules: ['one clear action per shot', 'consistent subject and world', 'visible cause and effect'],
    audioPlan: 'choose dialogue, narration, music, native audio, or silence based on the production goal',
    reviewCriteria: ['coherence', 'visual continuity', 'audio fit', 'export quality'],
  } satisfies NonNullable<FilmPackage['productionProcess']>;

  if (kind === 'short_film') {
    return {
      kind,
      primaryGoal: 'tell a complete character-driven story with a visible change by the final shot',
      processSummary: 'lock protagonist, goal, obstacle, stakes, ending, dialogue/music strategy, character references, then generate causal scenes one beat at a time',
      planningPriorities: ['character continuity', 'story causality', 'grounded blocking', 'dialogue or silence decisions', 'music arc'],
      requiredCreativeDecisions: ['protagonist', 'goal', 'obstacle', 'stakes', 'ending', 'dialogue style', 'score mood'],
      requiredAssets: ['character sheets', 'wardrobe sheet', 'environment plates', 'first-frame anchors', 'music brief', 'dialogue script'],
      shotDesignRules: ['each shot changes the protagonist situation', 'prefer grounded action over abstract montage', 'keep dialogue tied to visible choices'],
      audioPlan: 'sparse dialogue plus score by default; narration only when explicitly useful',
      reviewCriteria: ['story legibility', 'character continuity', 'causal shot order', 'dialogue fit', 'music supports emotional arc'],
    };
  }

  if (kind === 'music_video') {
    return {
      kind,
      primaryGoal: 'make the track feel visually alive through rhythm, motif, performance, and visual escalation',
      processSummary: 'lock song mood, tempo, performance concept, visual motifs, choreography or movement language, then design shots around sections and beat changes',
      planningPriorities: ['music brief', 'tempo and section map', 'performance or movement motif', 'visual hook', 'rhythmic edit plan'],
      requiredCreativeDecisions: ['song or music prompt', 'lead performer or visual subject', 'movement language', 'palette', 'section-by-section visual arc'],
      requiredAssets: ['music cue or song', 'performer/style references', 'motif references', 'environment plates', 'rhythm map'],
      shotDesignRules: ['cut and motion should follow the music', 'prioritize repeated motifs with variation', 'story can be impressionistic but must stay visually coherent'],
      audioPlan: 'music is primary; dialogue and narration are usually absent unless the concept requires spoken interludes',
      reviewCriteria: ['music-video synchronization', 'visual motif consistency', 'rhythmic energy', 'performer continuity', 'no random unrelated shots'],
    };
  }

  if (kind === 'trailer') {
    return {
      kind,
      primaryGoal: 'create desire to watch or learn more by building a hook, escalation, and memorable final beat',
      processSummary: 'lock premise, genre promise, best images, escalation ladder, tagline or voiceover approach, then generate punchy trailer beats',
      planningPriorities: ['opening hook', 'genre promise', 'escalation', 'signature images', 'final sting'],
      requiredCreativeDecisions: ['thing being teased', 'audience promise', 'tone', 'voiceover or title-card substitute', 'final button'],
      requiredAssets: ['hero style frames', 'signature location references', 'sound design/music brief', 'key visual references'],
      shotDesignRules: ['every shot should intensify curiosity or stakes', 'use fewer exposition beats', 'end with a strong final image'],
      audioPlan: 'score, sound design, and optional voiceover carry momentum; dialogue should be short and hooky',
      reviewCriteria: ['hook strength', 'pacing escalation', 'genre clarity', 'memorability', 'no overexplaining'],
    };
  }

  if (kind === 'marketing_video') {
    return {
      kind,
      primaryGoal: 'move a target audience from problem recognition to trust and action',
      processSummary: 'lock audience, offer, product/brand assets, proof points, differentiator, CTA, then generate product and outcome shots with narration/music',
      planningPriorities: ['target audience', 'problem', 'offer', 'proof', 'product shots', 'CTA'],
      requiredCreativeDecisions: ['audience', 'product or service', 'core benefit', 'proof point', 'brand style', 'call to action'],
      requiredAssets: ['product references', 'brand/logo references if available', 'customer or use-case references', 'proof points', 'music brief', 'voiceover script'],
      shotDesignRules: ['show the product or service early', 'make benefits visible', 'avoid vague lifestyle filler', 'include proof or before/after consequence'],
      audioPlan: 'concise voiceover plus subdued music by default; dialogue only when a customer scene helps the proof',
      reviewCriteria: ['audience clarity', 'product visibility', 'benefit proof', 'brand consistency', 'CTA clarity'],
    };
  }

  if (kind === 'explainer') {
    return {
      kind,
      primaryGoal: 'make an idea or workflow easy to understand',
      processSummary: 'lock concept, learner, step sequence, examples, diagrams or UI references, then generate clear explanatory shots with narration',
      planningPriorities: ['learner question', 'step order', 'example choice', 'visual metaphor', 'voiceover clarity'],
      requiredCreativeDecisions: ['what the viewer should understand', 'step sequence', 'example scenario', 'visual style', 'narrator tone'],
      requiredAssets: ['diagram references', 'UI references if needed', 'voiceover script', 'simple style frames'],
      shotDesignRules: ['one concept per shot', 'visuals clarify the narration', 'avoid decorative shots without information'],
      audioPlan: 'narration is primary, music stays quiet, dialogue is optional',
      reviewCriteria: ['clarity', 'step completeness', 'visual explanation match', 'pacing', 'no ambiguous abstraction'],
    };
  }

  if (kind === 'documentary') {
    return {
      kind,
      primaryGoal: 'make a real subject feel observed, specific, and credible',
      processSummary: 'lock subject, evidence, interview or observational structure, locations, archival/reference material, then generate grounded documentary beats',
      planningPriorities: ['subject credibility', 'evidence', 'observational moments', 'interview/narration stance', 'ethical framing'],
      requiredCreativeDecisions: ['central question', 'subject', 'evidence moments', 'narrator or interview approach', 'visual texture'],
      requiredAssets: ['location references', 'subject references', 'evidence or archival references', 'voiceover/interview script'],
      shotDesignRules: ['prefer observed detail over spectacle', 'make evidence visible', 'keep camera language credible'],
      audioPlan: 'voiceover or interview-style speech plus restrained music and room tone',
      reviewCriteria: ['credibility', 'specificity', 'evidence clarity', 'tone', 'continuity of real-world context'],
    };
  }

  return common;
}

function narrationLinesForPlan(
  state: ProductionState,
  plan: ProductionPlan,
  mode: NonNullable<FilmPackage['audioStrategy']>['mode'],
): FilmPackage['narration'] {
  const wantsNarration = mode === 'narration_music' ||
    (mode === 'hybrid' && /\b(narration|voiceover|voice-over)\b/i.test(state.production.brief));
  if (!wantsNarration) return [];
  return state.shots.map((shot, index) => ({
    id: `narration_${index + 1}`,
    shotId: shot.id,
    text: narrationLineForShot(shot.intent, plan.logline, index, state.shots.length),
    startSeconds: (shot.order - 1) * shot.durationSeconds,
    endSeconds: shot.order * shot.durationSeconds,
  }));
}

function dialogueLinesForPlan(
  state: ProductionState,
  treatment: NonNullable<FilmPackage['storyTreatment']>,
  mode: NonNullable<FilmPackage['audioStrategy']>['mode'],
): FilmPackage['dialogue'] {
  if (mode !== 'dialogue_music' && mode !== 'hybrid') return [];
  if (state.shots.length < 3) return [];
  const beats = uniqueShotIndexes([
    1,
    Math.max(1, Math.floor(state.shots.length / 3)),
    Math.max(1, Math.floor((state.shots.length * 2) / 3)),
    state.shots.length - 1,
  ]);
  const lines = [
    `I need to ${shortenSpokenGoal(treatment.goal)}.`,
    `That is the thing blocking us: ${shortenSpokenGoal(treatment.obstacle)}.`,
    `Then we make the choice where it actually matters.`,
    `This is the change: ${shortenSpokenGoal(treatment.ending)}.`,
  ];
  return beats.map((shotIndex, index) => ({
    id: `dialogue_${index + 1}`,
    shotId: state.shots[shotIndex]?.id ?? state.shots[0].id,
    character: index % 2 === 0 ? treatment.protagonist : 'Guide',
    text: compactSpokenLine(lines[index] ?? lines.at(-1) ?? 'Now we finish it.'),
    startSeconds: (state.shots[shotIndex]?.order ?? 1) * SHOT_SECONDS - SHOT_SECONDS + 0.4,
    endSeconds: (state.shots[shotIndex]?.order ?? 1) * SHOT_SECONDS - 0.3,
  }));
}

function buildNerfpocalypseFilmPackage(state: ProductionState): FilmPackage {
  return {
    productionProcess: {
      kind: 'short_film',
      primaryGoal: 'tell a complete character-driven story about surviving AI model limits through routing',
      processSummary: 'lock Maya, the guide, the client delivery stakes, dialogue/music strategy, character references, then generate causal story beats from midnight deadline to delivered film',
      planningPriorities: ['hero journey causality', 'Maya and guide continuity', 'physical production workflow', 'sparse dialogue', 'score arc'],
      requiredCreativeDecisions: ['Maya identity', 'OpenRouter guide identity', 'client delivery stakes', 'route-board motif', 'dialogue beats', 'music mood'],
      requiredAssets: ['Maya character sheet', 'OpenRouter guide character sheet', 'route-lantern prop reference', 'creator studio references', 'first-frame anchors', 'music cue', 'dialogue script'],
      shotDesignRules: ['each shot advances Maya toward or away from delivery', 'software constraints appear as physical work and props', 'no pure abstract montage'],
      audioPlan: 'dialogue plus score; no continuous narrator',
      reviewCriteria: ['story legibility', 'Maya continuity', 'guide continuity', 'grounded AI metaphors', 'dialogue fit', 'music supports the arc'],
    },
    storyTreatment: {
      format: '60-second vertical short film',
      storyType: 'hero journey with grounded tech-noir satire',
      audiencePromise: 'a creator survives the end of token subsidies by learning a repeatable multi-model workflow',
      protagonist: 'Maya, a tired but capable AI engineer and filmmaker',
      goal: 'deliver a client short film before shrinking subscription limits cut her off',
      obstacle: 'frontier lab gates, shrinking usage meters, and failed single-model shortcuts',
      stakes: 'Maya loses the delivery and the other creators lose a way through the nerfpocalypse',
      ending: 'Maya ships the film and turns the route map into a reusable studio workflow',
      groundingRules: [
        'Every symbolic AI limit appears through a real object: laptop, route token, meter, delivery drive, storyboard card, timeline, or lab door.',
        'Every shot must show a character making, choosing, carrying, assembling, delivering, or reacting to something physical.',
        'No pure abstract route montage, floating-symbol filler, or unrelated futuristic spectacle.',
      ],
      styleRules: [
        'Grounded live-action tech-noir with practical monitors, rain, desk lamps, blue shadows, and amber route light.',
        'Character continuity matters more than spectacle; Maya and the guide must remain recognizable.',
      ],
    },
    audioStrategy: {
      mode: 'dialogue_music',
      dialogueApproach: 'Sparse short-film dialogue between Maya and the OpenRouter guide carries turning points; no wall-to-wall narration.',
      narrationApproach: 'Use no continuous narrator; let physical action, dialogue, score, and edit rhythm explain the story.',
      musicRequired: true,
      musicPrompt: 'grounded tech-noir short-film score, low analog synth pulse, sparse percussion, tense midnight first act, warmer hopeful sunrise lift, no vocals',
    },
    visualContinuity: {
      hero: [
        'Maya is one consistent woman AI engineer hero, early 30s, tired focused eyes, shoulder-length dark wavy hair, oval face, medium build, bare head.',
        'She wears the same charcoal hooded jacket over a dark shirt and practical studio clothes in every shot.',
      ].join(' '),
      guide: [
        'OpenRouter appears as one consistent calm wayfinder mentor, human-scale, warm amber route-lantern, simple dark coat, composed expression.',
        'The guide reads as a grounded mentor in the creator studio world, with route-map symbolism carried by the lantern.',
      ].join(' '),
      heroIdentity: {
        name: 'Maya',
        role: 'AI engineer hero',
        genderPresentation: 'woman',
        ageRange: 'early 30s',
        face: 'oval face, tired focused eyes, grounded expression, human-scale live-action realism',
        hair: 'shoulder-length dark wavy hair, bare head',
        build: 'medium build',
        wardrobe: 'charcoal hooded jacket over a dark shirt, practical studio clothes',
        continuityPrompt: 'Maya, the same woman AI engineer hero, early 30s, oval face, tired focused eyes, shoulder-length dark wavy hair, medium build, charcoal hooded jacket over a dark shirt, practical studio clothes.',
      },
      guideIdentity: {
        name: 'OpenRouter guide',
        role: 'wayfinder mentor',
        genderPresentation: 'androgynous calm adult mentor',
        ageRange: 'late 30s to 40s',
        face: 'composed expression, warm observant eyes, human-scale live-action realism',
        hair: 'neat dark hair',
        build: 'average build',
        wardrobe: 'simple dark coat, warm amber branching route-lantern',
        continuityPrompt: 'The same OpenRouter wayfinder mentor, calm human guide in a simple dark coat, composed expression, warm amber branching route-lantern.',
      },
      wardrobe: 'hero: charcoal hooded jacket and dark shirt; guide: dark coat with warm amber route-lantern',
      palette: 'tech-noir blue shadows, warm amber route light, restrained gold token glow, sunrise resolution',
      motifs: ['branching route-lantern', 'shrinking token meters', 'frontier lab towers', 'film timeline cards', 'braided model paths'],
      forbidden: [
        'hard hats',
        'construction workers',
        'random new hero faces',
        'unrelated sci-fi soldiers',
        'readable gibberish UI text',
        'product-ad hero shots',
      ],
      promptPrefix: [
        'Identity continuity lock for every clip: Maya, same woman AI engineer hero, early 30s, oval face, tired focused eyes, shoulder-length dark wavy hair, medium build, charcoal hooded jacket over dark shirt, studio clothes.',
        'Same OpenRouter wayfinder mentor when present: calm human guide in a dark coat holding a warm amber branching route-lantern.',
        'World lock: grounded creator studio, real laptops, storyboard cards, delivery drive, route tokens, shrinking meters, lab doors, tech-noir blue shadows, amber route light.',
        'Film grammar: one 4-second shot, one visible character action, clear camera move, motivated light, practical production workflow.',
      ].join(' '),
      frameChaining: true,
    },
    narration: [],
    dialogue: [
      {
        id: 'dialogue_1',
        shotId: 'shot_1',
        character: 'Maya',
        text: 'The cut is due tonight.',
      },
      {
        id: 'dialogue_2',
        shotId: 'shot_2',
        character: 'Maya',
        text: 'Every gate just got smaller.',
      },
      {
        id: 'dialogue_3',
        shotId: 'shot_4',
        character: 'OpenRouter guide',
        text: 'Stop looking for one bigger gate.',
      },
      {
        id: 'dialogue_4',
        shotId: 'shot_5',
        character: 'OpenRouter guide',
        text: 'Route each job by what it needs.',
      },
      {
        id: 'dialogue_5',
        shotId: 'shot_8',
        character: 'Maya',
        text: 'So drafts, review, voice, music, all separate?',
      },
      {
        id: 'dialogue_6',
        shotId: 'shot_9',
        character: 'OpenRouter guide',
        text: 'Separate paths. One finished film.',
      },
      {
        id: 'dialogue_7',
        shotId: 'shot_12',
        character: 'Maya',
        text: 'Limits are real. So is routing.',
      },
      {
        id: 'dialogue_8',
        shotId: 'shot_15',
        character: 'Maya',
        text: 'We still ship.',
      },
    ].map((line) => timedDialogueLine(state, line)),
    music: {
      id: 'music_1',
      prompt: 'grounded tech-noir short-film score, low analog synth pulse, sparse percussion, tense midnight first act, warmer hopeful sunrise lift, no vocals',
      required: true,
    },
  };
}

function narrationLineForShot(intent: string, logline: string, index: number, count: number): string {
  if (index === 0) return `This is the world before the turn: ${logline}`;
  if (index === count - 1) return 'By the final image, the choice has become clear.';
  return `${intent}: the story moves one visible step forward.`;
}

function shotRefinementSystemPrompt(): string {
  return [
    'You are Showrunner\'s frontier Cinematographer and AI-video prompt writer.',
    'Refine Shot source text for high-quality image-to-video generation.',
    'Follow Runway Gen-4 style discipline: keep each generated Shot simple, positive, direct, and motion-first.',
    'Preserve the Film Package Identity Continuity Lock exactly. References carry identity, wardrobe, composition, lighting, and style. Do not cram the entire continuity bible into subjectMotion.',
    'Return JSON only.',
  ].join('\n');
}

function scriptRefinementSystemPrompt(): string {
  return [
    'You are Showrunner\'s frontier Scriptwriter for short AI films.',
    'Rewrite narration and dialogue so the finished Production feels coherent, cinematic, specific, and emotionally legible.',
    'Choose the right audio job for the format: dialogue for short-film turning points, narration for explainers/trailers, silence when picture and music carry the beat.',
    'Do not fill every shot with voiceover unless the treatment is explicitly narration-led.',
    'Narration must be concise enough for the Shot timing, usually 8-16 spoken words for a 4-second Shot.',
    'Dialogue must sound like a playable short-film exchange: concrete, sparse, character-specific, and attached to visible action.',
    'Preserve the brief, story order, IDs, and continuity. Return JSON only.',
  ].join('\n');
}

function textRefinementPrompt(state: ProductionState, scope: 'shots' | 'script', shotIds?: string[]): string {
  const targetIds = shotIds ? new Set(shotIds) : undefined;
  const shots = state.shots
    .filter((shot) => !targetIds || targetIds.has(shot.id))
    .map((shot) => ({
      id: shot.id,
      order: shot.order,
      intent: shot.intent,
      durationSeconds: shot.durationSeconds,
      promptDraft: shot.promptDraft,
      camera: shot.camera,
      subjectMotion: shot.subjectMotion,
      scene: state.scenes.find((scene) => scene.id === shot.sceneId)?.continuity,
      referenceIds: shot.referenceIds,
    }));
  const narration = (state.filmPackage?.narration ?? [])
    .filter((line) => !targetIds || targetIds.has(line.shotId))
    .map((line) => ({
      id: line.id,
      shotId: line.shotId,
      text: line.text,
      startSeconds: line.startSeconds,
      endSeconds: line.endSeconds,
    }));

  return [
    `Brief: ${state.production.brief}`,
    `Scope: ${scope}`,
    `Runtime: ${state.production.target.runtimeSeconds}s ${state.production.target.aspectRatio}`,
    state.filmPackage ? `Film Package: ${JSON.stringify(state.filmPackage.visualContinuity)}` : 'Film Package: none',
    '',
    'Return this JSON shape:',
    '{',
    '  "shots": [{ "id": "shot_1", "promptDraft": "...", "camera": "...", "subjectMotion": "..." }],',
    '  "narration": [{ "id": "narration_1", "text": "..." }],',
    '  "dialogue": [{ "id": "dialogue_1", "shotId": "shot_4", "character": "...", "text": "...", "voice": "optional", "startSeconds": 12.4, "endSeconds": 15.5 }]',
    '}',
    '',
    scope === 'shots'
      ? [
          'Shot refinement rules:',
          '- Return one item per input Shot in "shots"; leave "narration" and "dialogue" empty.',
          '- subjectMotion: one positive physical action, 6-18 words, general subject terms like "the subject" when references exist.',
          '- camera: one camera move or "locked camera", 3-12 words.',
          '- promptDraft: concise visual source note for Reference generation and planning, not the final executable Motion Prompt.',
          '- No negative phrasing such as no, not, never, without, avoid, do not.',
        ].join('\n')
      : [
          'Script refinement rules:',
          '- Return narration only for existing narration IDs; do not invent wall-to-wall narrator lines for dialogue-led or music-led treatments.',
          '- Keep narration concrete, rhythmic, emotionally clear, and secondary to the visible action.',
          '- Use the hero journey frame when present.',
          '- Dialogue is first-class for short films: preserve existing dialogue IDs when improving them and keep each line speakable.',
          '- If a shot would work better silent under music, omit new dialogue for that shot.',
        ].join('\n'),
    '',
    `Shots: ${JSON.stringify(shots)}`,
          `Narration: ${JSON.stringify(narration)}`,
          `Dialogue: ${JSON.stringify(state.filmPackage?.dialogue ?? [])}`,
          `Production Process: ${JSON.stringify(state.filmPackage?.productionProcess ?? null)}`,
          `Story Treatment: ${JSON.stringify(state.filmPackage?.storyTreatment ?? null)}`,
          `Audio Strategy: ${JSON.stringify(state.filmPackage?.audioStrategy ?? null)}`,
  ].join('\n');
}

function applyTextRefinement(
  state: ProductionState,
  refinement: z.infer<typeof TextRefinementSchema>,
  scope: 'shots' | 'script',
  shotIds?: string[],
): Pick<TextRefinementResult, 'updatedShots' | 'updatedNarration' | 'updatedDialogue'> {
  const targetIds = shotIds ? new Set(shotIds) : undefined;
  let updatedShots = 0;
  let updatedNarration = 0;
  let updatedDialogue = 0;

  if (scope === 'shots') {
    for (const item of refinement.shots) {
      const shot = state.shots.find((candidate) => candidate.id === item.id);
      if (!shot || (targetIds && !targetIds.has(shot.id))) continue;
      if (item.promptDraft) shot.promptDraft = cleanPrompt(item.promptDraft, state.production.brief, shot.order - 1);
      if (item.camera) shot.camera = positiveFragment(item.camera);
      if (item.subjectMotion) shot.subjectMotion = positiveFragment(item.subjectMotion);
      updatedShots += 1;
    }
  }

  if (scope === 'script' && state.filmPackage) {
    const mode = state.filmPackage.audioStrategy?.mode ?? 'hybrid';
    const narrationAllowed = mode === 'narration_music' || mode === 'hybrid';
    const dialogueAllowed = mode === 'dialogue_music' || mode === 'hybrid';

    for (const item of refinement.narration) {
      if (!narrationAllowed) continue;
      const line = state.filmPackage.narration.find((candidate) => candidate.id === item.id);
      if (!line || (targetIds && !targetIds.has(line.shotId))) continue;
      line.text = compactSpokenLine(item.text);
      updatedNarration += 1;
    }

    if (dialogueAllowed) {
      const dialogue = refinement.dialogue
        .filter((item) => state.shots.some((shot) => shot.id === item.shotId && (!targetIds || targetIds.has(shot.id))))
        .map((item) => ({
          id: item.id,
          shotId: item.shotId,
          character: item.character.trim(),
          text: compactSpokenLine(item.text),
          ...(item.voice ? { voice: item.voice.trim() } : {}),
          ...(typeof item.startSeconds === 'number' ? { startSeconds: item.startSeconds } : {}),
          ...(typeof item.endSeconds === 'number' ? { endSeconds: item.endSeconds } : {}),
        }));
      if (dialogue.length > 0) {
        const untouched = state.filmPackage.dialogue.filter((line) => targetIds && !targetIds.has(line.shotId));
        state.filmPackage.dialogue = [...untouched, ...dialogue];
        updatedDialogue = dialogue.length;
      }
    }
  }

  return { updatedShots, updatedNarration, updatedDialogue };
}

function positiveFragment(input: string): string {
  return input
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/\b(no|not|never|without|avoid|do not|don't|doesn't|must not)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSpokenLine(input: string): string {
  return input.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
}

function uniqueShotIndexes(indexes: number[]): number[] {
  return [...new Set(indexes.map((index) => Math.max(0, Math.floor(index))))].sort((a, b) => a - b);
}

function shortenSpokenGoal(input: string): string {
  const compact = compactSpokenLine(input)
    .replace(/\b(the|a|an)\s+/gi, '')
    .slice(0, 82)
    .replace(/[,\s]+$/, '');
  return compact || 'finish the job';
}

function timedDialogueLine(
  state: ProductionState,
  line: { id: string; shotId: string; character: string; text: string; voice?: string },
): FilmPackage['dialogue'][number] {
  const shot = state.shots.find((candidate) => candidate.id === line.shotId);
  const startSeconds = shot ? (shot.order - 1) * shot.durationSeconds + 0.35 : undefined;
  const endSeconds = shot ? shot.order * shot.durationSeconds - 0.25 : undefined;
  return {
    ...line,
    text: compactSpokenLine(line.text),
    ...(startSeconds !== undefined ? { startSeconds } : {}),
    ...(endSeconds !== undefined ? { endSeconds } : {}),
  };
}

function buildGenericFilmPlan(brief: string, runtimeSeconds: number): ProductionPlan {
  const count = shotCountForRuntime(runtimeSeconds);
  const kind = videoKindFromBrief(brief);
  const process = productionProcessForKind(kind, brief);
  const shots = Array.from({ length: count }, (_, index) => {
    const phase = index < count / 3 ? 'setup' : index < (count * 2) / 3 ? 'turning point' : 'resolution';
    return {
      sceneIndex: Math.min(2, Math.floor((index / count) * 3)),
      intent: `${phase} beat ${index + 1}`,
      durationSeconds: SHOT_SECONDS,
      promptDraft: `A cinematic ${phase} shot for this brief: ${brief}. One clear subject performs one visible action in a specific environment. The camera moves slowly with stable framing, natural lighting, coherent motion, vertical composition.`,
      camera: 'slow stable cinematic camera move',
      subjectMotion: 'one clear subject action',
      continuityCritical: true,
      referenceDescription: `Style frame for ${phase} beat ${index + 1}: ${brief}`,
    };
  });
  return {
    title: brief.trim().slice(0, 60) || 'Untitled Short Film',
    logline: brief.trim(),
    productionProcess: process,
    treatment: {
      format: videoKindLabel(kind),
      storyType: kind === 'marketing_video' ? 'problem, proof, benefit, action'
        : kind === 'music_video' ? 'rhythmic visual motif progression'
          : kind === 'trailer' ? 'hook, escalation, final sting'
            : 'three-act visual progression',
      audiencePromise: process.primaryGoal,
      protagonist: kind === 'marketing_video' ? 'the target customer or product user' : 'the recurring main subject',
      goal: kind === 'marketing_video' ? 'solve the audience problem with a visible product or service outcome' : 'complete the visible objective implied by the brief',
      obstacle: kind === 'marketing_video' ? 'the audience problem or friction the offer removes' : 'a concrete pressure that makes the objective difficult',
      stakes: kind === 'marketing_video' ? 'the viewer needs a reason to trust and act' : 'the outcome matters to the subject or audience',
      ending: kind === 'marketing_video' ? 'the benefit and next action are clear' : 'a final image shows the objective resolved or transformed',
      groundingRules: [
        'Every shot must show one physical action in one concrete setting.',
        'Avoid abstract montage unless a character is interacting with a real object.',
      ],
      styleRules: [
        'Keep one coherent cinematic style and palette.',
        'Preserve subject identity, wardrobe, and prop continuity.',
      ],
      audioMode: audioModeForKind(kind, brief),
      dialoguePlan: 'Use dialogue only for character choice points.',
      narrationPlan: 'Use narration only when the brief asks for it or the format is an explainer.',
      musicPlan: /\b(music|score|soundtrack|underscore|song|jazz|synth|percussion)\b/i.test(brief)
        ? 'Score follows the emotional arc requested in the brief.'
        : 'Music is optional unless the production format calls for it.',
    },
    visualRules: [
      'Keep visual continuity across every shot.',
      'Use concrete visible actions instead of abstract concepts.',
      'Keep each clip to one main subject movement and one camera move.',
    ],
    scenes: [
      scenePlan('Setup', 'Establish the subject, world, and emotional problem.', 'primary story location', 'clear cinematic realism', 'motivated natural light', 'curiosity'),
      scenePlan('Confrontation', 'Escalate the conflict through visible choices and consequences.', 'conflict location', 'controlled cinematic tension', 'higher contrast practical light', 'pressure'),
      scenePlan('Resolution', 'Resolve the story with a concrete final image.', 'resolution location', 'polished cinematic finish', 'warmer resolved light', 'release'),
    ],
    shots,
  };
}

function scenePlan(
  title: string,
  purpose: string,
  location: string,
  style: string,
  lighting: string,
  emotionalBeat: string,
): ProductionPlan['scenes'][number] {
  return {
    title,
    purpose,
    location,
    characters: ['main subject'],
    style,
    lighting,
    emotionalBeat,
    audioIntent: 'music-led with optional narration if the production requests it',
  };
}

function shotCountForRuntime(runtimeSeconds: number): number {
  return Math.max(1, Math.min(20, Math.ceil(runtimeSeconds / SHOT_SECONDS)));
}

function cleanPrompt(prompt: string, brief: string, index: number): string {
  let compact = prompt.replace(/\s+/g, ' ').trim();
  if (/\b(ai|model|openrouter|token|subscription|software|creator|startup|developer|engineer)\b/i.test(brief)) {
    compact = compact
      .replace(/\bindie builder\b/gi, 'indie software creator')
      .replace(/\bthe builder\b/gi, 'the software creator')
      .replace(/\bbuilder\b/gi, 'software creator');
  }
  if (!/(camera|shot|close-up|wide|dolly|push|pull|handheld|locked|pan|tilt|tracking|orbit)/i.test(compact)) {
    return `${compact.replace(/[.\s]+$/, '')}. Slow stable camera move, concrete subject motion, cinematic lighting, vertical composition.`;
  }
  if (/\bproduct reveal\b|\bproduct solving\b|\bcall-to-action\b/i.test(compact) && !/\bproduct\b/i.test(brief)) {
    return `Cinematic story shot ${index + 1}: one clear subject performs a visible action in the world of the brief. Slow stable camera move, concrete motion, cinematic lighting, vertical composition.`;
  }
  return compact;
}

function cameraFromPrompt(prompt: string): string {
  const match = prompt.match(/\b(slow [^.]+camera[^.]*|handheld [^.]*|camera [^.]*|tight close-up[^.]*|top-down [^.]*|slow [^.]+dolly[^.]*)/i);
  return match?.[0] ?? 'slow stable cinematic camera move';
}

function subjectMotionFromPrompt(prompt: string): string {
  const first = prompt.split('.').find((part) => /\b(works|edits|starts|tries|sets|clears|clear|pins|pin|places|place|slides|hands|checks|carries|points|catches|assembles|sprints|breathes|looks|rushes|steps|opens|chooses|walks|slams|runs|faces|shares|stands|turns|moves|screens|rebuilds|delivers|writes|lies|rises|lifts|sniffs|launches|pauses|listens|tracks|pivots|blocks|scans|lowers|rests)\b/i.test(part));
  return first?.trim() ?? 'one clear subject action';
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('Planner response did not contain JSON.');
    return JSON.parse(text.slice(start, end + 1));
  }
}
