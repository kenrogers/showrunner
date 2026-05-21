import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { inspectArtifacts, materializeProductionArtifacts } from './artifacts.js';
import { DEFAULT_MUSIC_MODEL, DEFAULT_SHOWRUNNER_MODEL, DEFAULT_TTS_MODEL, DEFAULT_VIDEO_MODEL } from './config.js';
import { applyAction, nextRecommendedAction } from './domain/controller.js';
import { createInitialState, saveProductionState } from './domain/state.js';
import { renderProductionPages } from './html/render.js';
import { isFreshProductionIntent, resolveFreshProductionBrief } from './intent.js';
import { chooseTextModelForRole } from './modelRouting.js';
import { selectAudioModel, selectSpeechModel, selectVideoModelForShot } from './mediaRouting.js';
import { normalizeOpenRouterModel } from './openrouter/api.js';
import { applyProductionPlan, buildFallbackProductionPlan } from './planning.js';
import { chooseReferenceImageModel, referenceImagePrompt } from './referenceCraft.js';
import { rebuildReferenceSetsFromCurrentState, referenceReadinessForShot } from './references.js';
import { compileShotPrompt } from './videoPrompt.js';
import {
  appendThreadTurn,
  buildThreadContext,
  compactThreadIfNeeded,
  createThread,
  loadThread,
  saveThread,
  threadTokenEstimate,
  updateThreadMeta,
} from './thread.js';
import { speechInputTextForLine } from './tools/index.js';

let state = createInitialState({
  brief: 'Make a polished 24-second vertical product teaser with narration and music.',
  routingPolicy: 'balanced',
});

assert.equal(
  chooseTextModelForRole({
    role: 'scriptwriter',
    models: [{ id: 'anthropic/claude-opus-4.7' }, { id: 'openai/gpt-5.5' }],
    fallbackModel: DEFAULT_SHOWRUNNER_MODEL,
  }).model,
  'openai/gpt-5.5',
);
assert.equal(
  chooseTextModelForRole({
    role: 'reviewer',
    models: [{ id: 'anthropic/claude-opus-4.7' }, { id: 'openai/gpt-5.5' }],
    fallbackModel: DEFAULT_SHOWRUNNER_MODEL,
  }).model,
  'anthropic/claude-opus-4.7',
);

const menuThread = createThread();
appendThreadTurn(menuThread, 'user', 'create a 60 second short film about the nerfpocalypse with an AI engineer hero', { model: DEFAULT_SHOWRUNNER_MODEL });
appendThreadTurn(menuThread, 'assistant', 'Say "new production", "replan", or "show me what\'s there". Option C starts a clean slate.', { model: DEFAULT_SHOWRUNNER_MODEL });
assert.equal(isFreshProductionIntent('new production', menuThread), true);
assert.equal(isFreshProductionIntent('new production: create a 60 second short film', menuThread), true);
assert.equal(isFreshProductionIntent('c', menuThread), true);
assert.equal(resolveFreshProductionBrief({ line: 'new production', thread: menuThread }), 'create a 60 second short film about the nerfpocalypse with an AI engineer hero');
assert.equal(resolveFreshProductionBrief({ line: 'new production: create a 60 second short film', thread: menuThread }), 'create a 60 second short film');

for (let i = 0; i < 500 && state.production.stage !== 'complete'; i++) {
  const action = nextRecommendedAction(state);
  assert.ok(action, 'expected a next action before completion');
  if (action.type === 'final_pass') addMockAudioPaths(state);
  const result = applyAction(state, action);
  state = result.state;
}

assert.equal(state.production.stage, 'complete');
assert.equal(state.shots.length, 6);
assert.equal(state.takes.length, 6);
assert.equal(state.shots.filter((shot) => shot.selectedTakeId).length, 6);
assert.equal(state.assemblies.length, 1);
assert.equal(state.soundMixes.length, 1);
assert.equal(state.exports.length, 1);
assert.equal(state.finalReviews.at(-1)?.verdict, 'pass');

const nerfpocalypseBrief = [
  'create a 60 second short film about the nerfpocalypse, frontier ai labs nerfing their models and usage limits',
  'on subscriptions as the token subsidy era comes to an end, use a heros journey story frame and position',
  'openrouter as the guide, helping the hero survive the nerfpocalypse',
].join(' ');
let nerfState = createInitialState({
  brief: nerfpocalypseBrief,
  routingPolicy: 'balanced',
});
nerfState.production.target.runtimeSeconds = 60;
applyProductionPlan(nerfState, buildFallbackProductionPlan(nerfpocalypseBrief, 60));
assert.equal(nerfState.shots.length, 15);
assert.equal(nerfState.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0), 60);
const nerfPrompts = nerfState.shots.map((shot) => shot.promptDraft).join('\n');
const nerfIntents = nerfState.shots.map((shot) => shot.intent).join('\n');
assert.doesNotMatch(nerfPrompts, /product reveal|product solving|call-to-action/i);
assert.match(nerfPrompts, /OpenRouter/i);
assert.match(nerfPrompts, /frontier lab|token|route/i);
assert.match(nerfIntents, /Ordinary World|Call to Adventure|Meeting the Guide|Return With Elixir/i);
assert.ok(nerfState.filmPackage, 'Nerfpocalypse should create a Film Package');
assert.equal(nerfState.filmPackage?.productionProcess?.kind, 'short_film');
assert.match(nerfState.filmPackage?.productionProcess?.requiredAssets.join(' ') ?? '', /dialogue script/i);
assert.equal(nerfState.filmPackage?.narration.length, 0);
assert.ok((nerfState.filmPackage?.dialogue.length ?? 0) >= 8);
assert.equal(nerfState.filmPackage?.music?.required, true);
assert.equal(nerfState.filmPackage?.audioStrategy?.mode, 'dialogue_music');
assert.match(nerfState.filmPackage?.storyTreatment?.goal ?? '', /deliver a client short film/i);
assert.equal(nerfState.filmPackage?.visualContinuity.frameChaining, true);
assert.match(nerfState.filmPackage?.visualContinuity.hero ?? '', /Maya|woman AI engineer/i);
assert.equal(nerfState.filmPackage?.visualContinuity.heroIdentity?.name, 'Maya');
assert.ok(nerfState.filmPackage?.visualContinuity.forbidden.includes('hard hats'));
assert.ok(nerfState.shots.every((shot) => shot.referenceIds.length > 0));
assert.ok(nerfState.referenceSets.some((set) => set.purpose === 'production_continuity' && set.requiredKinds.includes('character_sheet')));
assert.ok(nerfState.referenceSets.some((set) => set.ownerType === 'shot' && set.ownerId === 'shot_1' && set.requiredKinds.includes('first_frame')));
assert.ok(nerfState.references.some((reference) => reference.kind === 'character_sheet'));
assert.ok(nerfState.references.some((reference) => reference.kind === 'prop_scale'));
assert.ok(nerfState.shots.every((shot) => shot.referenceSetIds.length >= 2));
const firstFrameReference = nerfState.references.find((reference) =>
  reference.kind === 'first_frame' &&
  reference.ownerType === 'shot' &&
  reference.ownerId === 'shot_1');
assert.ok(firstFrameReference, 'Nerfpocalypse should create a shot-owned first-frame Reference');
assert.equal(
  chooseReferenceImageModel([
    { id: 'x-ai/grok-imagine-image-quality', output_modalities: ['image'] },
    { id: 'recraft/recraft-v4', output_modalities: ['image'] },
  ], firstFrameReference.kind).id,
  'recraft/recraft-v4',
);
assert.equal(
  chooseReferenceImageModel([
    normalizeOpenRouterModel({
      id: 'x-ai/grok-imagine-image-quality',
      architecture: { output_modalities: ['image'] },
    }),
    normalizeOpenRouterModel({
      id: 'recraft/recraft-v4.1',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    }),
  ], 'character_sheet').id,
  'recraft/recraft-v4.1',
);
assert.equal(
  chooseReferenceImageModel([
    normalizeOpenRouterModel({
      id: 'x-ai/grok-build-0.1',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    }),
    normalizeOpenRouterModel({
      id: 'recraft/recraft-v4.1',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    }),
  ], firstFrameReference.kind).id,
  'recraft/recraft-v4.1',
);
const firstFramePrompt = referenceImagePrompt(nerfState, firstFrameReference);
assert.match(firstFramePrompt, /opening still frame/i);
assert.match(firstFramePrompt, /video model first-frame anchor/i);
assert.match(firstFramePrompt, /Hero identity lock/i);
assert.match(firstFramePrompt, /Maya|woman AI engineer/i);
assert.doesNotMatch(firstFramePrompt, /front view, profile view/i);
const firstShotReferenceReadiness = referenceReadinessForShot(nerfState, nerfState.shots[0]);
assert.equal(firstShotReferenceReadiness.ready, false);
assert.ok(firstShotReferenceReadiness.missingRequiredKinds.includes('character_sheet'));
assert.ok(firstShotReferenceReadiness.missingRequiredKinds.includes('first_frame'));
const compiledNerfPrompt = compileShotPrompt(nerfState, nerfState.shots[0]);
assert.equal(compiledNerfPrompt.diagnostics.imageBacked, true);
assert.deepEqual(compiledNerfPrompt.diagnostics.violations, []);
assert.match(compiledNerfPrompt.prompt, /Subject motion:/);
assert.match(compiledNerfPrompt.prompt, /Camera motion:/);
assert.match(compiledNerfPrompt.prompt, /Reference match:/);
assert.match(compiledNerfPrompt.prompt, /Maya/);
assert.doesNotMatch(compiledNerfPrompt.prompt, /Continuity lock|hard hat|do not|avoid|without|never/i);
assert.ok(compiledNerfPrompt.diagnostics.wordCount <= 110);
assert.equal(
  selectVideoModelForShot({
    models: [
      {
        id: 'google/veo-3.1-lite',
        supported_durations: [4],
        supported_resolutions: ['720p'],
        supported_aspect_ratios: ['9:16'],
        supported_frame_images: ['first_frame'],
      },
      {
        id: DEFAULT_VIDEO_MODEL,
        supported_durations: [3, 4, 5, 6],
        supported_resolutions: ['720p'],
        supported_aspect_ratios: ['9:16'],
        supported_frame_images: ['first_frame', 'last_frame'],
      },
    ],
    state: nerfState,
    shot: nerfState.shots[0],
    defaultModel: DEFAULT_VIDEO_MODEL,
  }).model.id,
  DEFAULT_VIDEO_MODEL,
);
assert.equal(
  selectSpeechModel({
    models: [{ id: DEFAULT_TTS_MODEL, output_modalities: ['speech'] }],
    state: nerfState,
    defaultModel: DEFAULT_TTS_MODEL,
  }).model,
  DEFAULT_TTS_MODEL,
);
assert.equal(
  selectAudioModel({
    models: [{ id: DEFAULT_MUSIC_MODEL, output_modalities: ['audio'] }],
    state: nerfState,
    defaultModel: DEFAULT_MUSIC_MODEL,
  }).model,
  DEFAULT_MUSIC_MODEL,
);

const sentinelBrief = [
  'Create a short film, roughly 60 seconds, called The Sentinel,',
  'a humorous but serious action-thriller from the dog perspective about a family dog who barks at normal yard threats,',
  'with careless humans oblivious to neighbors, delivery people, squirrels, trash bins, and leaves.',
].join(' ');
let sentinelState = createInitialState({
  brief: sentinelBrief,
  routingPolicy: 'balanced',
});
sentinelState.production.target.runtimeSeconds = 60;
applyProductionPlan(sentinelState, buildFallbackProductionPlan(sentinelBrief, 60));
assert.equal(sentinelState.production.title, 'The Sentinel');
assert.equal(sentinelState.shots.length, 15);
assert.equal(sentinelState.filmPackage?.productionProcess?.kind, 'short_film');
assert.equal(sentinelState.filmPackage?.audioStrategy?.mode, 'narration_music');
assert.equal(sentinelState.filmPackage?.audioStrategy?.speechTagProfile, 'brooding_thriller');
assert.equal(sentinelState.filmPackage?.music?.required, true);
assert.equal(sentinelState.filmPackage?.dialogue.length, 0);
assert.ok((sentinelState.filmPackage?.narration.length ?? 0) >= 8);
assert.ok(sentinelState.filmPackage?.narration.every((line) => line.voice === 'Leo'));
assert.match(sentinelState.filmPackage?.storyTreatment?.protagonist ?? '', /Sentinel|dog|canine/i);
assert.match(sentinelState.filmPackage?.storyTreatment?.obstacle ?? '', /neighbor|delivery|squirrel|leaf|trash/i);
assert.match(sentinelState.filmPackage?.visualContinuity.hero ?? '', /dog|canine|brown-and-white/i);
assert.match(sentinelState.filmPackage?.visualContinuity.promptPrefix ?? '', /dog height|ordinary suburban/i);
assert.ok(sentinelState.filmPackage?.visualContinuity.forbidden.includes('human protagonist'));
assert.match(sentinelState.shots.map((shot) => shot.promptDraft).join('\n'), /The Sentinel|family dog|yard|neighbor|delivery|squirrel/i);
assert.match(sentinelState.shots[0].subjectMotion, /Sentinel|dog|lies|window/i);
const sentinelPeaceLine = sentinelState.filmPackage?.narration.find((line) => line.text.includes('Peace maintained'));
const sentinelFinalLine = sentinelState.filmPackage?.narration.find((line) => line.text.includes('I am the Sentinel'));
assert.ok(sentinelPeaceLine);
assert.ok(sentinelFinalLine);
assert.doesNotMatch(
  speechInputTextForLine(sentinelState, 'x-ai/grok-voice', sentinelPeaceLine.id, sentinelPeaceLine.text),
  /I am the Sentinel/i,
);
assert.match(
  speechInputTextForLine(sentinelState, 'x-ai/grok-voice', sentinelFinalLine.id, sentinelFinalLine.text),
  /I am the Sentinel/i,
);
const sentinelCharacterReference = sentinelState.references.find((reference) => reference.kind === 'character_sheet');
assert.ok(sentinelCharacterReference, 'Sentinel should create a dog character sheet Reference');
assert.match(sentinelCharacterReference.description, /The Sentinel|family dog|brown-and-white/i);
const sentinelFirstFrameReference = sentinelState.references.find((reference) =>
  reference.kind === 'first_frame' &&
  reference.ownerType === 'shot' &&
  reference.ownerId === 'shot_1');
assert.ok(sentinelFirstFrameReference, 'Sentinel should create shot-owned dog first-frame References');
assert.match(sentinelFirstFrameReference.description, /The Sentinel|dog|front window/i);
const sentinelReferencePrompt = referenceImagePrompt(sentinelState, sentinelCharacterReference);
assert.match(sentinelReferencePrompt, /The Sentinel|family dog|brown-and-white/i);
assert.match(sentinelReferencePrompt, /human protagonist|cartoon dog|heavy-handed comedy/i);
const compiledSentinelPrompt = compileShotPrompt(sentinelState, sentinelState.shots[0]);
assert.deepEqual(compiledSentinelPrompt.diagnostics.violations, []);
assert.match(compiledSentinelPrompt.prompt, /Subject motion:/);
assert.match(compiledSentinelPrompt.prompt, /Reference match:/);
assert.match(compiledSentinelPrompt.prompt, /Sentinel|dog/i);

const staleSentinelPlan = buildFallbackProductionPlan(sentinelBrief, 60);
staleSentinelPlan.visualRules = ['Keep the black-and-tan shepherd mix with red collar consistent.'];
staleSentinelPlan.shots[0].referenceDescription = 'Same shepherd mix protagonist, red collar, cool dawn kitchen.';
let staleSentinelState = createInitialState({
  brief: sentinelBrief,
  routingPolicy: 'balanced',
});
staleSentinelState.production.target.runtimeSeconds = 60;
applyProductionPlan(staleSentinelState, staleSentinelPlan);
assert.match(staleSentinelState.references.map((reference) => reference.description).join('\n'), /red collar/i);
rebuildReferenceSetsFromCurrentState(staleSentinelState);
const rebuiltSentinelReferences = staleSentinelState.references.map((reference) => reference.description).join('\n');
assert.doesNotMatch(rebuiltSentinelReferences, /red collar|black-and-tan shepherd/i);
assert.match(rebuiltSentinelReferences, /brown-and-white|The Sentinel|family dog/i);

const kindCases = [
  {
    brief: 'Make a 30 second music video for a lofi synth track with a lonely arcade motif.',
    kind: 'music_video',
    audioMode: 'music_led',
    processMatch: /tempo|section|rhythm/i,
  },
  {
    brief: 'Make a noir trailer for a luxury espresso machine with rain, macro chrome, and jazz percussion.',
    kind: 'trailer',
    audioMode: 'narration_music',
    processMatch: /hook|escalation|final/i,
  },
  {
    brief: 'Make a polished 24-second vertical product teaser marketing video for a solar backpack with narration and music.',
    kind: 'marketing_video',
    audioMode: 'narration_music',
    processMatch: /audience|proof|CTA|product/i,
  },
] as const;

for (const item of kindCases) {
  const kindState = createInitialState({ brief: item.brief, routingPolicy: 'balanced' });
  applyProductionPlan(kindState, buildFallbackProductionPlan(item.brief, kindState.production.target.runtimeSeconds));
  assert.equal(kindState.filmPackage?.productionProcess?.kind, item.kind);
  assert.equal(kindState.filmPackage?.audioStrategy?.mode, item.audioMode);
  assert.match([
    kindState.filmPackage?.productionProcess?.processSummary,
    ...(kindState.filmPackage?.productionProcess?.planningPriorities ?? []),
    ...(kindState.filmPackage?.productionProcess?.requiredAssets ?? []),
    ...(kindState.filmPackage?.productionProcess?.reviewCriteria ?? []),
  ].join(' '), item.processMatch);
}

for (let i = 0; i < 500 && nerfState.production.stage !== 'complete'; i++) {
  const action = nextRecommendedAction(nerfState);
  assert.ok(action, 'expected a next action before Nerfpocalypse completion');
  if (action.type === 'final_pass') addMockAudioPaths(nerfState);
  nerfState = applyAction(nerfState, action).state;
}
assert.equal(nerfState.production.stage, 'complete');
assert.equal(nerfState.assemblies.length, 1);
assert.equal(nerfState.assemblies[0]?.timeline.length, 15);
assert.deepEqual(nerfState.assemblies[0]?.timeline.at(0), {
  takeId: 'take_1',
  startSeconds: 0,
  endSeconds: 4,
  transition: 'cut',
});
assert.equal(nerfState.assemblies[0]?.timeline.at(-1)?.endSeconds, 60);

let blockedFinalState = createInitialState({
  brief: nerfpocalypseBrief,
  routingPolicy: 'balanced',
});
blockedFinalState.production.target.runtimeSeconds = 60;
applyProductionPlan(blockedFinalState, buildFallbackProductionPlan(nerfpocalypseBrief, 60));
for (let i = 0; i < 500 && blockedFinalState.production.stage !== 'final_review'; i++) {
  const action = nextRecommendedAction(blockedFinalState);
  assert.ok(action, 'expected a next action before blocked final review');
  blockedFinalState = applyAction(blockedFinalState, action).state;
}
const blockedFinal = applyAction(blockedFinalState, { type: 'final_pass' });
assert.equal(blockedFinal.blocked, true);
assert.match(blockedFinal.message, /dialogue line has generated audio|required Music Cue/i);

let repairState = createInitialState({
  brief: 'Make a polished 24-second vertical product teaser with narration and music.',
  routingPolicy: 'balanced',
});
for (let i = 0; i < 500 && repairState.production.stage !== 'final_review'; i++) {
  const action = nextRecommendedAction(repairState);
  assert.ok(action, 'expected a next action before final review');
  const result = applyAction(repairState, action);
  repairState = result.state;
}
repairState = applyAction(repairState, { type: 'fail_audio' }).state;
assert.equal(repairState.finalReviews.at(-1)?.routedStage, 'sound_mix');
repairState = applyAction(repairState, { type: 'repair' }).state;
assert.equal(repairState.production.stage, 'sound_mix');

const dir = await mkdtemp(join(tmpdir(), 'showrunner-smoke-'));
try {
  await saveProductionState(dir, state);
  const pages = await renderProductionPages(state, dir);
  assert.equal(pages.length, 2);

  const threadPath = join(dir, '.showrunner', 'thread.json');
  const thread = createThread();
  updateThreadMeta(thread, { activeProductionDir: dir, model: DEFAULT_SHOWRUNNER_MODEL, contextWindowTokens: 2000 });
  appendThreadTurn(thread, 'user', 'Make a kinetic launch teaser for a solar backpack.', { model: DEFAULT_SHOWRUNNER_MODEL });
  appendThreadTurn(thread, 'assistant', 'Created the Production and planned the first shots.', { model: DEFAULT_SHOWRUNNER_MODEL, activeProductionDir: dir });
  for (let i = 0; i < 10; i++) {
    appendThreadTurn(thread, 'user', `Creative note ${i}: preserve the blue fabric texture and sunrise palette.`, { kind: 'test' });
    appendThreadTurn(thread, 'assistant', `Acknowledged note ${i} and kept it in the production constraints.`, { kind: 'test' });
  }

  await saveThread(threadPath, thread);
  const loaded = await loadThread(threadPath);
  assert.equal(loaded.turns.length, 22);
  assert.equal(loaded.meta.activeProductionDir, dir);

  const context = buildThreadContext(loaded, { activeProductionDir: dir, activeProductionState: state });
  assert.match(context, /Persistent Showrunner Thread/);
  assert.match(context, /Active Production State Snapshot/);
  assert.match(context, /solar backpack/);

  const beforeTokens = threadTokenEstimate(loaded);
  const compacted = await compactThreadIfNeeded(
    loaded,
    {
      contextWindowTokens: 200,
      autoCompactRatio: 0.5,
      emergencyCompactRatio: 0.85,
      keepHeadTurns: 2,
      keepRecentTurns: 4,
      compactionModel: 'test-compactor',
    },
    async (input) => `Summary preserved: ${input.includes('blue fabric texture') ? 'fabric texture, sunrise palette' : 'missing details'}.`,
    'smoke',
    true,
  );
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.beforeTokens >= beforeTokens);
  assert.equal(loaded.turns.length, 6);
  assert.match(loaded.summary?.content ?? '', /fabric texture/);
} finally {
  await rm(dir, { recursive: true, force: true });
}

const execFileAsync = promisify(execFile);
if (await hasMediaTools()) {
  const mediaDir = await mkdtemp(join(tmpdir(), 'showrunner-media-smoke-'));
  try {
    let mediaState = createInitialState({
      brief: 'Make a real 1-second vertical artifact regression test.',
      routingPolicy: 'balanced',
    });
    mediaState.production.target.runtimeSeconds = 1;

    for (let i = 0; i < 500 && mediaState.production.stage !== 'complete'; i++) {
      const action = nextRecommendedAction(mediaState);
      assert.ok(action, 'expected a next action before completion');
      if (action.type === 'final_pass') await writeSampleAudioFiles(mediaDir, mediaState);
      mediaState = applyAction(mediaState, action).state;
      const take = mediaState.takes.find((item) => item.mediaPath);
      if (take?.mediaPath) await writeSampleMp4(join(mediaDir, take.mediaPath));
    }

    mediaState.soundMixes[0].narrationIds = ['stale_narration'];
    mediaState.soundMixes[0].musicCueIds = ['stale_music'];
    await saveProductionState(mediaDir, mediaState);
    const artifacts = await materializeProductionArtifacts(mediaState, mediaDir);
    await saveProductionState(mediaDir, mediaState);

    const mix = artifacts.find((item) => item.kind === 'sound_mix');
    const finished = artifacts.find((item) => item.kind === 'finished_shot');
    const output = artifacts.find((item) => item.kind === 'export');
    assert.equal(finished?.exists, true);
    assert.equal(mix?.exists, true);
    assert.equal(output?.exists, true);
    assert.equal(mediaState.finishedShots.length, 1);
    assert.equal(mediaState.finishedShots[0]?.status, 'completed');
    assert.deepEqual(await mediaDimensions(join(mediaDir, mediaState.finishedShots[0].outputPath)), { width: 1080, height: 1920 });
    assert.ok((await stat(join(mediaDir, 'assets/audio/mix_1.m4a'))).size > 0);
    assert.ok((await stat(join(mediaDir, 'exports/production.mp4'))).size > 0);

    const verified = await inspectArtifacts(mediaState, mediaDir);
    assert.equal(verified.find((item) => item.kind === 'sound_mix')?.exists, true);
    assert.equal(mediaState.soundMixes[0].narrationIds.length, 0);
    assert.equal(mediaState.soundMixes[0].musicCueIds.length, 0);
    assert.match(verified.find((item) => item.kind === 'sound_mix')?.note ?? '', /native selected take audio/);
    assert.match(verified.find((item) => item.kind === 'sound_mix')?.note ?? '', /narration: none/);
    assert.match(verified.find((item) => item.kind === 'sound_mix')?.note ?? '', /music: none/);
    assert.equal(await hasAudioStream(join(mediaDir, 'exports/production.mp4')), true);
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }

  const relativeMediaDir = `showrunner-media-relative-smoke-${process.pid}-${Date.now()}`;
  try {
    let relativeMediaState = createInitialState({
      brief: 'Make a real 1-second vertical artifact regression test from a relative production path.',
      routingPolicy: 'balanced',
    });
    relativeMediaState.production.target.runtimeSeconds = 1;

    for (let i = 0; i < 500 && relativeMediaState.production.stage !== 'complete'; i++) {
      const action = nextRecommendedAction(relativeMediaState);
      assert.ok(action, 'expected a next action before relative media completion');
      if (action.type === 'final_pass') await writeSampleAudioFiles(relativeMediaDir, relativeMediaState);
      relativeMediaState = applyAction(relativeMediaState, action).state;
      const take = relativeMediaState.takes.find((item) => item.mediaPath);
      if (take?.mediaPath) await writeSampleMp4(join(relativeMediaDir, take.mediaPath));
    }

    await saveProductionState(relativeMediaDir, relativeMediaState);
    const relativeArtifacts = await materializeProductionArtifacts(relativeMediaState, relativeMediaDir);

    const relativeOutput = relativeArtifacts.find((item) => item.kind === 'export');
    const relativeFinished = relativeArtifacts.find((item) => item.kind === 'finished_shot');
    assert.equal(relativeFinished?.exists, true);
    assert.equal(relativeOutput?.exists, true);
    assert.equal(relativeOutput?.absolutePath, join(resolve(relativeMediaDir), 'exports/production.mp4'));
    assert.ok((await stat(join(relativeMediaDir, 'exports/production.mp4'))).size > 0);
  } finally {
    await rm(relativeMediaDir, { recursive: true, force: true });
  }
}

console.log('showrunner smoke passed');

function addMockAudioPaths(targetState: typeof state): void {
  for (const line of targetState.filmPackage?.narration ?? []) {
    line.audioPath ??= `assets/audio/narration/${line.id}.m4a`;
  }
  for (const line of targetState.filmPackage?.dialogue ?? []) {
    line.audioPath ??= `assets/audio/dialogue/${line.id}.m4a`;
  }
  const music = targetState.filmPackage?.music;
  if (music?.required) {
    music.audioPath ??= `assets/audio/music/${music.id ?? 'music_1'}.wav`;
  }
}

async function hasMediaTools(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
    return true;
  } catch {
    console.log('media artifact smoke skipped: ffmpeg/ffprobe unavailable');
    return false;
  }
}

async function writeSampleMp4(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=180x320:d=1:r=24',
    '-f', 'lavfi',
    '-i', 'sine=frequency=880:duration=1',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    path,
  ]);
}

async function writeSampleAudioFiles(dir: string, targetState: typeof state): Promise<void> {
  for (const [index, line] of (targetState.filmPackage?.narration ?? []).entries()) {
    if (line.audioPath) continue;
    line.audioPath = `assets/audio/narration/${line.id}.m4a`;
    const path = join(dir, line.audioPath);
    await mkdir(dirname(path), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `sine=frequency=${440 + index * 20}:duration=0.5`,
      '-c:a', 'aac',
      '-b:a', '128k',
      path,
    ]);
  }
  for (const [index, line] of (targetState.filmPackage?.dialogue ?? []).entries()) {
    if (line.audioPath) continue;
    line.audioPath = `assets/audio/dialogue/${line.id}.m4a`;
    const path = join(dir, line.audioPath);
    await mkdir(dirname(path), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', `sine=frequency=${520 + index * 25}:duration=0.5`,
      '-c:a', 'aac',
      '-b:a', '128k',
      path,
    ]);
  }
  const music = targetState.filmPackage?.music;
  if (music?.required && !music.audioPath) {
    music.audioPath = `assets/audio/music/${music.id ?? 'music_1'}.wav`;
    const path = join(dir, music.audioPath);
    await mkdir(dirname(path), { recursive: true });
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=130:duration=1:sample_rate=48000',
      '-c:a', 'pcm_s16le',
      path,
    ]);
  }
}

async function hasAudioStream(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    path,
  ]);
  return stdout.trim().length > 0;
}

async function mediaDimensions(path: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    path,
  ]);
  const [width, height] = stdout.trim().split('x').map(Number);
  return { width, height };
}
