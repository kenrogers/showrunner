import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_VIDEO_MODEL, loadConfig } from '../config.js';
import type { ProductionState, Take } from '../domain/schema.js';
import { createInitialState, productionDir, saveProductionState } from '../domain/state.js';
import { renderProductionPages } from '../html/render.js';
import { downloadVideo, listVideoModels, pollVideoJob, previewVideoRequest, submitVideoJob, type VideoJob, type VideoModel } from '../openrouter/api.js';

const BUDGET_USD = Number(process.env.SHOWRUNNER_PAID_SMOKE_BUDGET_USD ?? 5);
const MODEL_ID = process.env.SHOWRUNNER_PAID_SMOKE_MODEL ?? DEFAULT_VIDEO_MODEL;
const DURATION_SECONDS = Number(process.env.SHOWRUNNER_PAID_SMOKE_DURATION ?? 4);
const RESOLUTION = process.env.SHOWRUNNER_PAID_SMOKE_RESOLUTION ?? '720p';
const ASPECT_RATIO = process.env.SHOWRUNNER_PAID_SMOKE_ASPECT ?? '9:16';
const GENERATE_AUDIO = process.env.SHOWRUNNER_PAID_SMOKE_AUDIO !== 'false';
const POLL_INTERVAL_MS = Number(process.env.SHOWRUNNER_PAID_SMOKE_POLL_MS ?? 15000);
const MAX_WAIT_MS = Number(process.env.SHOWRUNNER_PAID_SMOKE_MAX_WAIT_MS ?? 900000);

const prompt = [
  'A polished vertical product-launch teaser for a fictional premium desk lamp called Aurora One.',
  'Four seconds, 9:16 portrait, cinematic macro product photography.',
  'The lamp sits on a clean dark desk, turns on with a warm glow, and the camera slowly dollies in.',
  'Premium but practical, crisp reflections, shallow depth of field, subtle electronic launch-trailer energy.',
  'No readable text, no logos, no people, no distorted hands.',
].join(' ');

async function main() {
  const config = loadConfig();
  if (!config.apiKey) throw new Error('OPENROUTER_API_KEY is required.');

  console.log(`Budget cap: $${BUDGET_USD.toFixed(2)}`);
  const models = await listVideoModels(config.apiKey);
  const model = models.find((item) => item.id === MODEL_ID);
  if (!model) throw new Error(`Model not found: ${MODEL_ID}`);
  validateModel(model);

  const estimatedCost = estimateVideoCost(model, {
    durationSeconds: DURATION_SECONDS,
    resolution: RESOLUTION,
    generateAudio: GENERATE_AUDIO,
  });
  console.log(`Selected model: ${model.id}`);
  console.log(`Estimated cost: $${estimatedCost.toFixed(4)}`);
  if (estimatedCost > BUDGET_USD) throw new Error(`Estimated cost $${estimatedCost.toFixed(4)} exceeds budget $${BUDGET_USD.toFixed(2)}.`);

  let state = createSmokeProductionState(config.routingPolicy);
  const dir = productionDir(config.productionRoot, state);
  await mkdir(join(dir, 'assets', 'takes'), { recursive: true });

  const request = previewVideoRequest({
    model: MODEL_ID,
    prompt,
    durationSeconds: DURATION_SECONDS,
    resolution: RESOLUTION,
    aspectRatio: ASPECT_RATIO,
    generateAudio: GENERATE_AUDIO,
  });

  const take: Take = {
    id: 'take_1',
    shotId: 'shot_1',
    model: MODEL_ID,
    request,
    status: 'approved',
    costUsd: estimatedCost,
    createdAt: new Date().toISOString(),
  };
  state.takes.push(take);
  state.approvals.push({
    id: 'approval_1',
    kind: 'paid_generation',
    status: 'approved',
    subjectId: take.id,
    costUsd: estimatedCost,
    reason: `Paid smoke test approved by user with $${BUDGET_USD.toFixed(2)} budget cap.`,
    createdAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
  });
  state.eventLog.push(`Paid smoke request prepared for ${MODEL_ID}.`);
  await saveAndRender(dir, state);
  await writeFile(join(dir, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, 'utf-8');

  console.log('Submitting approved video job...');
  const submit = await submitVideoJob(config.apiKey, request, true);
  state = updateTake(state, take.id, {
    status: submit.status === 'failed' ? 'failed' : 'pending',
    jobId: submit.id,
  });
  state.eventLog.push(`Submitted video job ${submit.id}.`);
  await saveAndRender(dir, state);
  console.log(`Job id: ${submit.id}`);

  const completed = await waitForVideo(config.apiKey, submit);
  if (completed.status !== 'completed') {
    state = updateTake(state, take.id, { status: 'failed', generationId: completed.generation_id });
    state.eventLog.push(`Video job ${completed.id} failed: ${JSON.stringify(completed.error ?? completed.status)}`);
    await saveAndRender(dir, state);
    throw new Error(`Video job failed: ${JSON.stringify(completed.error ?? completed.status)}`);
  }

  const actualCost = completed.usage?.cost ?? estimatedCost;
  if (actualCost > BUDGET_USD) throw new Error(`Actual cost $${actualCost.toFixed(4)} exceeds budget $${BUDGET_USD.toFixed(2)}.`);
  const url = completed.unsigned_urls?.[0];
  if (!url) throw new Error('Completed video job did not include a download URL.');

  const relativeVideoPath = join('assets', 'takes', `${take.id}.mp4`);
  const videoPath = join(dir, relativeVideoPath);
  console.log('Downloading video...');
  await downloadVideo(config.apiKey, url, videoPath);
  const videoStat = await stat(videoPath);

  state = completeOneShotProduction(state, {
    takeId: take.id,
    job: completed,
    relativeVideoPath,
    actualCost,
    fileSize: videoStat.size,
  });
  await saveAndRender(dir, state);

  console.log(`Done: ${dir}`);
  console.log(`Video: ${videoPath}`);
  console.log(`Pages: ${join(dir, 'pages', 'production.html')}`);
  console.log(`Actual cost: $${actualCost.toFixed(4)}`);
  console.log(`File size: ${videoStat.size} bytes`);
}

function createSmokeProductionState(routingPolicy: ProductionState['production']['routing']['policy']): ProductionState {
  const state = createInitialState({
    title: 'Paid Smoke: Aurora One',
    brief: 'Generate one real short vertical AI video take for a fictional premium desk lamp launch teaser, with native audio if supported.',
    routingPolicy,
  });
  state.production.target = {
    platform: 'social',
    aspectRatio: '9:16',
    runtimeSeconds: DURATION_SECONDS,
    format: 'mp4',
  };
  state.production.budgetGuardrail.maxUsd = BUDGET_USD;
  state.production.budgetGuardrail.approvalThresholdUsd = BUDGET_USD;
  state.production.stage = 'takes';
  state.scenes.push({
    id: 'scene_1',
    productionId: state.production.id,
    order: 1,
    title: 'Product Reveal',
    purpose: 'Show a premium fictional desk lamp switching on in a cinematic vertical product shot.',
    continuity: {
      location: 'dark modern desk',
      style: 'premium cinematic macro product photography',
      lighting: 'warm lamp glow with crisp rim light',
      emotionalBeat: 'quiet premium reveal',
      audioIntent: GENERATE_AUDIO ? 'native launch-trailer audio if the model provides it' : 'silent visual smoke',
    },
    musicCueIds: [],
  });
  state.shots.push({
    id: 'shot_1',
    sceneId: 'scene_1',
    order: 1,
    intent: 'Aurora One lamp turns on as the camera slowly dollies in.',
    durationSeconds: DURATION_SECONDS,
    promptDraft: prompt,
    camera: 'slow macro dolly-in, stable portrait composition',
    subjectMotion: 'lamp switches on with warm glow',
    continuityCritical: false,
    referenceSetIds: [],
    referenceIds: [],
    status: 'approved',
  });
  state.eventLog.push('Paid smoke Production initialized with one real Shot.');
  return state;
}

function validateModel(model: VideoModel): void {
  if (!model.supported_durations?.includes(DURATION_SECONDS)) {
    throw new Error(`${model.id} does not support duration ${DURATION_SECONDS}.`);
  }
  if (!model.supported_resolutions?.includes(RESOLUTION)) {
    throw new Error(`${model.id} does not support resolution ${RESOLUTION}.`);
  }
  if (!model.supported_aspect_ratios?.includes(ASPECT_RATIO)) {
    throw new Error(`${model.id} does not support aspect ratio ${ASPECT_RATIO}.`);
  }
}

function estimateVideoCost(model: VideoModel, input: {
  durationSeconds: number;
  resolution: string;
  generateAudio: boolean;
}): number {
  const skus = model.pricing_skus ?? {};
  const candidates = input.generateAudio
    ? [
        `duration_seconds_with_audio_${input.resolution}`,
        'duration_seconds_with_audio',
        `text_to_video_duration_seconds_${input.resolution}`,
        'duration_seconds',
      ]
    : [
        `duration_seconds_without_audio_${input.resolution}`,
        'duration_seconds_without_audio',
        `text_to_video_duration_seconds_${input.resolution}`,
        'duration_seconds',
      ];
  for (const key of candidates) {
    const raw = skus[key];
    if (raw !== undefined) return Number(raw) * input.durationSeconds;
  }
  throw new Error(`Cannot estimate cost for ${model.id}; pricing_skus=${JSON.stringify(skus)}`);
}

async function waitForVideo(apiKey: string, submit: VideoJob): Promise<VideoJob> {
  let latest = submit;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (['completed', 'failed', 'cancelled', 'expired'].includes(latest.status)) return latest;
    await sleep(POLL_INTERVAL_MS);
    latest = await pollVideoJob(apiKey, latest.polling_url ?? latest.id);
    console.log(`Status: ${latest.status}`);
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS}ms waiting for video job ${submit.id}.`);
}

function completeOneShotProduction(state: ProductionState, input: {
  takeId: string;
  job: VideoJob;
  relativeVideoPath: string;
  actualCost: number;
  fileSize: number;
}): ProductionState {
  const take = state.takes.find((item) => item.id === input.takeId);
  const shot = state.shots.find((item) => item.id === take?.shotId);
  if (!take || !shot) throw new Error('Smoke state lost its take or shot.');

  take.status = 'reviewed';
  take.jobId = input.job.id;
  take.generationId = input.job.generation_id;
  take.mediaPath = input.relativeVideoPath;
  take.nativeAudio = { present: GENERATE_AUDIO, intendedUse: GENERATE_AUDIO ? 'keep' : 'mute' };
  take.costUsd = input.actualCost;
  shot.selectedTakeId = take.id;
  shot.status = 'selected';
  state.production.budgetGuardrail.spentUsd = input.actualCost;
  state.costs.push({
    id: 'cost_1',
    subjectId: take.id,
    kind: 'video_take',
    costUsd: input.actualCost,
    createdAt: new Date().toISOString(),
  });
  state.takeReviews.push({
    id: 'review_1',
    takeId: take.id,
    reviewer: 'layered',
    verdict: 'pass',
    findings: [
      `Video job completed with status ${input.job.status}.`,
      `Downloaded MP4 artifact (${input.fileSize} bytes).`,
      `Actual usage cost $${input.actualCost.toFixed(4)} stayed under $${BUDGET_USD.toFixed(2)} budget.`,
    ],
    requiredFixes: [],
    optionalImprovements: ['Human visual review still required before treating this as creative-quality approved.'],
  });
  state.assemblies.push({
    id: 'assembly_1',
    productionId: state.production.id,
    selectedTakeIds: [take.id],
    timeline: [{
      takeId: take.id,
      startSeconds: 0,
      endSeconds: DURATION_SECONDS,
      transition: 'cut',
    }],
    soundMixId: 'mix_1',
  });
  state.soundMixes.push({
    id: 'mix_1',
    assemblyId: 'assembly_1',
    narrationIds: [],
    dialogueIds: [],
    musicCueIds: [],
    nativeTakeAudio: [{ takeId: take.id, treatment: GENERATE_AUDIO ? 'keep' : 'mute' }],
    loudnessTarget: '-14 LUFS',
  });
  state.exports.push({
    id: 'export_1',
    assemblyId: 'assembly_1',
    path: input.relativeVideoPath,
    format: 'mp4',
    codec: 'h264',
    audioCodec: 'aac',
    aspectRatio: ASPECT_RATIO as '9:16',
    captionArtifactIds: [],
    finalReviewId: 'final_review_1',
  });
  state.finalReviews.push({
    id: 'final_review_1',
    exportId: 'export_1',
    verdict: 'pass',
    requiredFixes: [],
    optionalImprovements: ['Review the downloaded video manually for composition, artifacts, and audio quality.'],
  });
  state.production.stage = 'complete';
  state.eventLog.push(`Downloaded real video artifact for ${take.id}.`);
  state.eventLog.push(`Paid smoke completed for $${input.actualCost.toFixed(4)}.`);
  return state;
}

function updateTake(state: ProductionState, takeId: string, patch: Partial<Take>): ProductionState {
  const take = state.takes.find((item) => item.id === takeId);
  if (!take) throw new Error(`Take not found: ${takeId}`);
  Object.assign(take, patch);
  return state;
}

async function saveAndRender(dir: string, state: ProductionState): Promise<void> {
  state.production.updatedAt = new Date().toISOString();
  await saveProductionState(dir, state);
  await renderProductionPages(state, dir);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
