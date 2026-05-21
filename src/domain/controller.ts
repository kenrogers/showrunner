import type { Approval, ProductionState, Stage, Take } from './schema.js';
import { STAGES } from './schema.js';
import { applyProductionPlan, buildFallbackProductionPlan } from '../planning.js';
import { diagnoseMotionPrompt, videoPromptForShot } from '../videoPrompt.js';
import { ensureReferenceSetsForContinuity } from '../references.js';

export type ControllerAction =
  | { type: 'confirm_brief' }
  | { type: 'create_scenes' }
  | { type: 'create_shots' }
  | { type: 'prepare_references' }
  | { type: 'preview_take'; model?: string }
  | { type: 'approve_pending' }
  | { type: 'submit_take_mock' }
  | { type: 'advance_takes' }
  | { type: 'review_take' }
  | { type: 'select_take' }
  | { type: 'assemble' }
  | { type: 'sound_mix' }
  | { type: 'export_mock' }
  | { type: 'final_pass' }
  | { type: 'fail_visual' }
  | { type: 'fail_audio' }
  | { type: 'fail_export' }
  | { type: 'repair' }
  | { type: 'toggle_autonomy' };

export interface ActionResult {
  state: ProductionState;
  message: string;
  blocked: boolean;
}

export interface AdvanceResult {
  state: ProductionState;
  messages: string[];
  blocked: boolean;
}

export function applyAction(state: ProductionState, action: ControllerAction): ActionResult {
  const next = structuredClone(state) as ProductionState;
  const message = apply(next, action);
  if (message.blocked) log(next, `Blocked: ${message.text}`);
  else log(next, message.text);
  next.production.updatedAt = new Date().toISOString();
  return { state: next, message: message.text, blocked: message.blocked };
}

export function advanceDeterministicStages(state: ProductionState, maxSteps = 100): AdvanceResult {
  let next = structuredClone(state) as ProductionState;
  const messages: string[] = [];
  let blocked = false;

  for (let i = 0; i < maxSteps; i++) {
    const action = nextRecommendedAction(next);
    if (!action) break;
    if (action.type === 'approve_pending' || action.type === 'preview_take' || action.type === 'submit_take_mock') {
      blocked = true;
      messages.push(action.type === 'approve_pending'
        ? 'Pending approval requires explicit user confirmation.'
        : 'Paid Take generation requires explicit user approval.');
      break;
    }
    const result = applyAction(next, action);
    next = result.state;
    messages.push(result.message);
    if (result.blocked) {
      blocked = true;
      break;
    }
  }

  return { state: next, messages, blocked };
}

export function legalActions(state: ProductionState): ControllerAction['type'][] {
  const stage = state.production.stage;
  const actions: ControllerAction['type'][] = ['toggle_autonomy'];
  if (stage === 'brief') actions.push('confirm_brief');
  if (stage === 'scene_plan') actions.push('create_scenes');
  if (stage === 'shot_plan') actions.push('create_shots');
  if (stage === 'references') actions.push('prepare_references');
  if (stage === 'takes') {
    const pending = pendingApproval(state);
    if (pending) actions.push('approve_pending');
    else if (state.takes.some((take) => take.status === 'approved')) actions.push('submit_take_mock');
    else if (allShotsHaveCompletedTake(state)) actions.push('advance_takes');
    else actions.push('preview_take');
  }
  if (stage === 'take_reviews') actions.push('review_take');
  if (stage === 'selected_takes') actions.push('select_take');
  if (stage === 'assembly') actions.push('assemble');
  if (stage === 'sound_mix') actions.push('sound_mix');
  if (stage === 'export') actions.push('export_mock');
  if (stage === 'final_review') actions.push('final_pass', 'fail_visual', 'fail_audio', 'fail_export');
  if (state.finalReviews.at(-1)?.verdict === 'fail') actions.push('repair');
  return actions;
}

export function nextRecommendedAction(state: ProductionState): ControllerAction | undefined {
  const stage = state.production.stage;
  if (stage === 'brief') return { type: 'confirm_brief' };
  if (stage === 'scene_plan') return { type: 'create_scenes' };
  if (stage === 'shot_plan') return { type: 'create_shots' };
  if (stage === 'references') return { type: 'prepare_references' };
  if (stage === 'takes') {
    if (pendingApproval(state)) return { type: 'approve_pending' };
    if (state.takes.some((take) => take.status === 'approved')) return { type: 'submit_take_mock' };
    if (allShotsHaveCompletedTake(state)) return { type: 'advance_takes' };
    return { type: 'preview_take' };
  }
  if (stage === 'take_reviews') return { type: 'review_take' };
  if (stage === 'selected_takes') return { type: 'select_take' };
  if (stage === 'assembly') return { type: 'assemble' };
  if (stage === 'sound_mix') return { type: 'sound_mix' };
  if (stage === 'export') return { type: 'export_mock' };
  if (stage === 'final_review') return { type: 'final_pass' };
  return undefined;
}

export function summarizeState(state: ProductionState): string {
  const selected = state.shots.filter((shot) => shot.selectedTakeId).length;
  const pending = pendingApproval(state);
  return [
    `${state.production.title} (${state.production.stage})`,
    `${state.scenes.length} scenes, ${state.shots.length} shots, ${state.takes.length} takes, ${selected}/${state.shots.length} selected`,
    `budget $${state.production.budgetGuardrail.spentUsd.toFixed(2)} / $${state.production.budgetGuardrail.maxUsd.toFixed(2)}`,
    pending ? `pending approval: ${pending.subjectId} $${pending.costUsd?.toFixed(2) ?? 'n/a'}` : 'pending approval: none',
  ].join('\n');
}

export function stageProgress(state: ProductionState): Array<{ stage: Stage; status: 'done' | 'current' | 'pending' }> {
  const current = STAGES.indexOf(state.production.stage);
  return STAGES.map((stage, index) => ({
    stage,
    status: index < current ? 'done' : index === current ? 'current' : 'pending',
  }));
}

function apply(state: ProductionState, action: ControllerAction): { text: string; blocked: boolean } {
  switch (action.type) {
    case 'confirm_brief':
      if (!at(state, 'brief')) return block('Brief is already confirmed.');
      state.production.stage = 'scene_plan';
      return ok('Brief confirmed. Producer moved to Scene planning.');
    case 'create_scenes':
      if (!at(state, 'scene_plan')) return block('Scene planning is not the current stage.');
      if (state.scenes.length === 0) {
        applyProductionPlan(state, buildFallbackProductionPlan(state.production.brief, state.production.target.runtimeSeconds));
      }
      state.production.stage = 'shot_plan';
      return ok('Director created ordered Scenes.');
    case 'create_shots':
      if (!at(state, 'shot_plan')) return block('Shot planning is not the current stage.');
      if (state.shots.length === 0) {
        applyProductionPlan(state, buildFallbackProductionPlan(state.production.brief, state.production.target.runtimeSeconds));
      }
      state.production.stage = 'references';
      return ok('Director and Cinematographer created Shots.');
    case 'prepare_references':
      if (!at(state, 'references')) return block('References are not the current stage.');
      ensureReferenceSetsForContinuity(state);
      state.production.stage = 'takes';
      return ok('Planned Reference Sets for continuity-critical Shots.');
    case 'preview_take':
      if (!at(state, 'takes')) return block('Takes are not the current stage.');
      return previewTake(state, action.model);
    case 'approve_pending':
      return approvePending(state);
    case 'submit_take_mock':
      if (!at(state, 'takes')) return block('Take generation is not the current stage.');
      return submitTakeMock(state);
    case 'advance_takes':
      if (!allShotsHaveCompletedTake(state)) return block('Not all Shots have completed Takes yet.');
      state.production.stage = 'take_reviews';
      return ok('All Shots have completed Takes. Moved to Take Review.');
    case 'review_take':
      if (!at(state, 'take_reviews')) return block('Take Review is not the current stage.');
      return reviewNextTake(state);
    case 'select_take':
      if (!at(state, 'selected_takes')) return block('Selected Takes are not the current stage.');
      return selectNextTake(state);
    case 'assemble':
      if (!at(state, 'assembly')) return block('Assembly is not the current stage.');
      if (state.shots.some((s) => !s.selectedTakeId)) return block('Every Shot needs a Selected Take before Assembly.');
      state.assemblies = [{
        id: 'assembly_1',
        productionId: state.production.id,
        selectedTakeIds: state.shots.map((s) => s.selectedTakeId).filter((id): id is string => Boolean(id)),
        timeline: buildAssemblyTimeline(state),
      }];
      state.production.stage = 'sound_mix';
      return ok('Editor built an Assembly from Selected Takes.');
    case 'sound_mix':
      if (!at(state, 'sound_mix')) return block('Sound Mix is not the current stage.');
      state.soundMixes = [{
        id: 'mix_1',
        assemblyId: 'assembly_1',
        narrationIds: state.filmPackage?.narration.map((item) => item.id) ?? [],
        dialogueIds: state.filmPackage?.dialogue.map((item) => item.id) ?? [],
        musicCueIds: state.filmPackage?.music ? [state.filmPackage.music.id ?? 'music_1'] : [],
        nativeTakeAudio: state.takes
          .filter((t) => state.assemblies[0].selectedTakeIds.includes(t.id))
          .map((t) => ({
            takeId: t.id,
            treatment: filmPackageHasPlannedAudio(state) ? 'duck' as const : t.nativeAudio?.present ? 'keep' as const : 'mute' as const,
          })),
        loudnessTarget: '-14 LUFS',
        outputPath: 'assets/audio/mix_1.m4a',
      }];
      state.assemblies[0].soundMixId = 'mix_1';
      state.production.stage = 'export';
      return ok('Sound Designer prepared a real Sound Mix target from Selected Take audio.');
    case 'export_mock':
      if (!at(state, 'export')) return block('Export is not the current stage.');
      state.exports = [{
        id: 'export_1',
        assemblyId: 'assembly_1',
        path: 'exports/production.mp4',
        format: 'mp4',
        codec: 'h264',
        audioCodec: 'aac',
        aspectRatio: state.production.target.aspectRatio,
        captionArtifactIds: [],
      }];
      state.production.stage = 'final_review';
      return ok('Editor prepared the social-ready MP4 Export target.');
    case 'final_pass':
      if (!at(state, 'final_review')) return block('Final Review is not the current stage.');
      if (!state.filmPackage) return block('Final Review cannot pass without a Film Package continuity bible and audio script.');
      if (state.filmPackage.narration.some((line) => !line.audioPath)) {
        return block('Final Review cannot pass until every narration line has generated audio.');
      }
      if (state.filmPackage.dialogue.some((line) => !line.audioPath)) {
        return block('Final Review cannot pass until every dialogue line has generated audio.');
      }
      if (state.filmPackage.music?.required && !state.filmPackage.music.audioPath) {
        return block('Final Review cannot pass until the required Music Cue has generated audio.');
      }
      state.finalReviews.push({
        id: `final_review_${state.finalReviews.length + 1}`,
        exportId: state.exports.at(-1)?.id,
        verdict: 'pass',
        requiredFixes: [],
        optionalImprovements: ['Continuity bible, story treatment, dialogue/narration plan, music cue plan, and sound mix were present at export.'],
      });
      state.production.stage = 'complete';
      return ok('Final Review passed. Production is complete.');
    case 'fail_visual':
      return failFinalReview(state, 'takes', 'Visual artifact requires a new Take for the affected Shot.');
    case 'fail_audio':
      return failFinalReview(state, 'sound_mix', 'Music Cue or Narration balance needs a Sound Mix fix.');
    case 'fail_export':
      return failFinalReview(state, 'export', 'Export compliance failed for codec, aspect ratio, or file integrity.');
    case 'repair': {
      const failed = state.finalReviews.at(-1);
      if (failed?.verdict !== 'fail' || !failed.routedStage) return block('There is no failed Final Review to repair.');
      state.production.stage = failed.routedStage;
      return ok(`Repair routed to ${failed.routedStage}.`);
    }
    case 'toggle_autonomy':
      state.production.autonomyPolicy.enabled = !state.production.autonomyPolicy.enabled;
      return ok(`Autonomy Policy ${state.production.autonomyPolicy.enabled ? 'enabled' : 'disabled'}.`);
  }
}

function previewTake(state: ProductionState, model?: string): { text: string; blocked: boolean } {
  const pending = pendingApproval(state);
  if (pending) return block(`Approve, cancel, or supersede ${pending.subjectId} before previewing another paid Take.`);

  const stranded = state.takes.find((take) => take.status === 'previewed' && !state.approvals.some((a) => a.subjectId === take.id && a.status === 'pending'));
  if (stranded) {
    state.approvals.push(approvalForTake(state, stranded));
    return ok(`Restored approval for ${stranded.id}. Approve it before previewing another Take.`);
  }

  const target = nextShotNeedingTake(state);
  if (!target) {
    if (allShotsHaveCompletedTake(state)) {
      state.production.stage = 'take_reviews';
      return ok('All Shots have completed Takes. Moved to Take Review.');
    }
    return block('No Shot needs a Take.');
  }

  const take: Take = {
    id: `take_${state.nextIds.take++}`,
    shotId: target.id,
    model: model ?? 'runtime-selected-video-model',
    request: {
      model: model ?? 'runtime-selected-video-model',
      prompt: videoPromptForShot(state, target),
      duration: target.durationSeconds,
      aspect_ratio: state.production.target.aspectRatio,
      referenceIds: target.referenceIds,
    },
    status: 'previewed',
    costUsd: 0.82,
    createdAt: now(),
  };
  state.takes.push(take);
  target.status = 'previewed';

  if (autoApproveIfCovered(state, take)) return ok(`Previewed and auto-approved ${take.id} under Autonomy Policy.`);

  state.approvals.push(approvalForTake(state, take));
  return ok(`Previewed ${take.id}. Approval required before paid generation.`);
}

function approvePending(state: ProductionState): { text: string; blocked: boolean } {
  const pending = pendingApproval(state);
  if (!pending) return block('There is no pending approval.');
  pending.status = 'approved';
  pending.resolvedAt = now();
  if (pending.kind === 'paid_generation') {
    const take = state.takes.find((item) => item.id === pending.subjectId);
    if (take) take.status = 'approved';
  }
  return ok(`Approved ${pending.kind} for ${pending.subjectId}.`);
}

function submitTakeMock(state: ProductionState): { text: string; blocked: boolean } {
  if (pendingApproval(state)) return block('Resolve the pending approval before submitting a Take.');
  const take = state.takes.find((item) => item.status === 'approved');
  if (!take) return block('No approved Take request is ready. Preview and approve one first.');
  const target = state.shots.find((item) => item.id === take.shotId);
  if (!target) return block(`Take ${take.id} is not linked to a Shot.`);

  take.status = 'completed';
  take.jobId = `mock_job_${take.id}`;
  take.generationId = `mock_generation_${take.id}`;
  take.mediaPath = `assets/takes/${take.id}.mp4`;
  take.nativeAudio = { present: true, intendedUse: 'undecided' };
  target.status = 'needs_review';
  recordCost(state, take.id, 'video_take', take.costUsd ?? 0);
  if (allShotsHaveCompletedTake(state)) state.production.stage = 'take_reviews';
  return ok(`Mock submitted and completed ${take.id}. Native Take Audio preserved for Sound Mix.`);
}

function reviewNextTake(state: ProductionState): { text: string; blocked: boolean } {
  const take = state.takes.find((item) => item.status === 'completed' && !state.takeReviews.some((r) => r.takeId === item.id));
  if (!take) {
    if (allCompletedTakesReviewed(state)) {
      state.production.stage = 'selected_takes';
      return ok('All completed Takes reviewed. Moved to Selected Takes.');
    }
    return block('No completed Take is ready for review.');
  }
  const requiredFixes = continuityReviewFixes(state, take);
  state.takeReviews.push({
    id: `review_${state.nextIds.review++}`,
    takeId: take.id,
    reviewer: 'layered',
    verdict: requiredFixes.length > 0 ? 'needs_fix' : 'pass',
    findings: continuityReviewFindings(state, take),
    requiredFixes,
    optionalImprovements: [],
  });
  take.status = 'reviewed';
  const target = state.shots.find((s) => s.id === take.shotId);
  if (target) target.status = 'reviewed';
  if (allCompletedTakesReviewed(state)) state.production.stage = 'selected_takes';
  return ok(`Layered Take Review passed for ${take.id}.`);
}

function selectNextTake(state: ProductionState): { text: string; blocked: boolean } {
  const target = state.shots.find((item) => !item.selectedTakeId);
  if (!target) {
    state.production.stage = 'assembly';
    return ok('All Shots have Selected Takes. Moved to Assembly.');
  }
  const reviewed = state.takes.find((take) => take.shotId === target.id && take.status === 'reviewed');
  if (!reviewed) return block(`${target.id} has no reviewed Take to select.`);
  target.selectedTakeId = reviewed.id;
  target.status = 'selected';
  if (state.shots.every((item) => item.selectedTakeId)) state.production.stage = 'assembly';
  return ok(`Promoted ${reviewed.id} to Selected Take for ${target.id}.`);
}

function continuityReviewFindings(state: ProductionState, take: Take): string[] {
  const fixes = continuityReviewFixes(state, take);
  if (fixes.length > 0) return ['Take request failed pre-generation continuity checks.', ...fixes];
  return ['Media facts passed.', 'Story fit acceptable.', 'Motion Prompt and audio handoff were present.', 'Audio should be handled in Sound Mix.'];
}

function continuityReviewFixes(state: ProductionState, take: Take): string[] {
  const fixes: string[] = [];
  const prompt = requestPrompt(take.request);
  if (!state.filmPackage) fixes.push('Missing Film Package continuity bible.');
  const diagnostics = diagnoseMotionPrompt(prompt, {
    imageBacked: requestReferenceIds(take.request).length > 0,
    hasFilmPackage: Boolean(state.filmPackage),
  });
  fixes.push(...diagnostics.violations.map((violation) => `Take request ${violation}`));
  if (state.filmPackage && !/\bSubject motion:/.test(prompt)) {
    fixes.push('Take request did not include a structured Motion Prompt.');
  }
  if (state.filmPackage?.narration.length && !state.filmPackage.narration.some((line) => line.shotId === take.shotId)) {
    fixes.push('Take has no matching narration beat.');
  }
  const shot = state.shots.find((candidate) => candidate.id === take.shotId);
  if (shot && abstractPromptRisk(shot.promptDraft)) {
    fixes.push('Shot prompt is too abstract; ground the beat in a physical character action and prop.');
  }
  return fixes;
}

function filmPackageHasPlannedAudio(state: ProductionState): boolean {
  return Boolean(
    state.filmPackage?.narration.length ||
    state.filmPackage?.dialogue.length ||
    state.filmPackage?.music?.required,
  );
}

function abstractPromptRisk(prompt: string): boolean {
  const abstractHits = prompt.match(/\b(journey|concept|symbol|symbols|abstract|destiny|route|routes|workflow|model paths|token era|subsidy era|storm)\b/gi)?.length ?? 0;
  const physicalHits = prompt.match(/\b(hand|hands|walks|runs|opens|carries|places|sets|slides|pins|keyboard|laptop|drive|desk|door|card|timeline|studio|hallway|monitor|workstation)\b/gi)?.length ?? 0;
  return abstractHits >= 4 && physicalHits < 2;
}

function requestPrompt(request: unknown): string {
  if (request && typeof request === 'object' && 'prompt' in request && typeof request.prompt === 'string') return request.prompt;
  return '';
}

function requestReferenceIds(request: unknown): string[] {
  if (
    request &&
    typeof request === 'object' &&
    'referenceIds' in request &&
    Array.isArray(request.referenceIds)
  ) {
    return request.referenceIds.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function failFinalReview(state: ProductionState, routedStage: Stage, fix: string): { text: string; blocked: boolean } {
  if (!at(state, 'final_review')) return block('Final Review is not the current stage.');
  state.finalReviews.push({
    id: `final_review_${state.finalReviews.length + 1}`,
    exportId: state.exports.at(-1)?.id,
    verdict: 'fail',
    requiredFixes: [fix],
    optionalImprovements: [],
    routedStage,
  });
  return ok(`Final Review failed. Required fix routes to ${routedStage}.`);
}

function allShotsHaveCompletedTake(state: ProductionState): boolean {
  return state.shots.length > 0 && state.shots.every((shot) =>
    state.takes.some((take) => take.shotId === shot.id && ['completed', 'reviewed'].includes(take.status)),
  );
}

function allCompletedTakesReviewed(state: ProductionState): boolean {
  const completed = state.takes.filter((take) => ['completed', 'reviewed'].includes(take.status));
  return completed.length > 0 && completed.every((take) => state.takeReviews.some((r) => r.takeId === take.id));
}

function nextShotNeedingTake(state: ProductionState) {
  return state.shots.find((shot) => {
    if (shot.selectedTakeId) return false;
    const hasOpenTake = state.takes.some((take) =>
      take.shotId === shot.id && ['previewed', 'approved', 'completed', 'reviewed'].includes(take.status),
    );
    return !hasOpenTake || shot.status === 'needs_fix';
  });
}

function pendingApproval(state: ProductionState): Approval | undefined {
  return state.approvals.find((approval) => approval.status === 'pending');
}

function approvalForTake(state: ProductionState, take: Take): Approval {
  return {
    id: `approval_${state.nextIds.approval++}`,
    kind: 'paid_generation',
    status: 'pending',
    subjectId: take.id,
    costUsd: take.costUsd,
    reason: `Submit ${take.id} for ${take.shotId}`,
    createdAt: now(),
  };
}

function autoApproveIfCovered(state: ProductionState, take: Take): boolean {
  const policy = state.production.autonomyPolicy;
  if (!policy.enabled) return false;
  const projected = state.production.budgetGuardrail.spentUsd + (take.costUsd ?? 0);
  if (projected > policy.maxUsd) return false;
  const countForShot = state.takes.filter((item) => item.shotId === take.shotId).length;
  if (countForShot > policy.maxTakesPerShot) return false;
  take.status = 'approved';
  return true;
}

function buildAssemblyTimeline(state: ProductionState) {
  let cursor = 0;
  return state.shots.map((shot) => {
    const startSeconds = cursor;
    const endSeconds = startSeconds + shot.durationSeconds;
    cursor = endSeconds;
    return {
      takeId: shot.selectedTakeId ?? 'missing',
      startSeconds,
      endSeconds,
      transition: 'cut' as const,
    };
  });
}

function recordCost(state: ProductionState, subjectId: string, kind: string, costUsd: number): void {
  state.production.budgetGuardrail.spentUsd += costUsd;
  state.costs.push({
    id: `cost_${state.costs.length + 1}`,
    subjectId,
    kind,
    costUsd,
    createdAt: now(),
  });
}

function at(state: ProductionState, stage: Stage): boolean {
  return state.production.stage === stage;
}

function log(state: ProductionState, message: string): void {
  state.eventLog.push(message);
  if (state.eventLog.length > 40) state.eventLog.shift();
}

function ok(text: string) {
  return { text, blocked: false };
}

function block(text: string) {
  return { text, blocked: true };
}

function now(): string {
  return new Date().toISOString();
}
