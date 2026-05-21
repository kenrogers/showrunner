import type { OpenRouterModel } from './openrouter/api.js';
import type { ProductionState, Reference, ReferenceKind } from './domain/schema.js';

export interface ReferenceImageCraftPlan {
  model: OpenRouterModel;
  prompt: string;
  imageSize: '0.5K' | '1K' | '2K' | '4K';
  selectionReason: string;
}

export function planReferenceImageGeneration(input: {
  state: ProductionState;
  reference: Reference;
  models: OpenRouterModel[];
  preferredModel?: string;
  defaultModel?: string;
  frameReferenceModel?: string;
}): ReferenceImageCraftPlan {
  const model = chooseReferenceImageModel(input.models, input.reference.kind, {
    preferredModel: input.preferredModel,
    defaultModel: input.defaultModel,
    frameReferenceModel: input.frameReferenceModel,
  });
  return {
    model,
    prompt: referenceImagePrompt(input.state, input.reference),
    imageSize: imageSizeForReferenceKind(input.reference.kind),
    selectionReason: selectionReason(model.id, input.reference.kind, Boolean(input.preferredModel)),
  };
}

export function chooseReferenceImageModel(
  models: OpenRouterModel[],
  kind: ReferenceKind,
  options: {
    preferredModel?: string;
    defaultModel?: string;
    frameReferenceModel?: string;
  } = {},
): OpenRouterModel {
  if (options.preferredModel) {
    const selected = models.find((model) => model.id === options.preferredModel);
    if (!selected) throw new Error(`Preferred image model is not available on OpenRouter: ${options.preferredModel}`);
    if (!isImageModel(selected)) throw new Error(`Preferred model does not advertise image output on OpenRouter: ${options.preferredModel}`);
    return selected;
  }

  const ids = modelPreferenceOrder(kind, options);
  for (const id of ids) {
    const selected = models.find((model) => model.id === id && isImageModel(model));
    if (selected) return selected;
  }

  const recraft = preferredRecraftModel(models);
  if (recraft) return recraft;

  const fallback = models.find(isImageModel);
  if (!fallback) throw new Error('No OpenRouter image-output model is currently available.');
  return fallback;
}

export function referenceImagePrompt(state: ProductionState, ref: Reference): string {
  const pack = state.filmPackage;
  const shot = state.shots.find((candidate) => candidate.id === ref.ownerId);
  const aspect = state.production.target.aspectRatio;
  const motifGuidance = isFrameReferenceKind(ref.kind)
    ? 'Do not import recurring motifs unless the shot purpose names that motif as a visible object.'
    : `Recurring motif vocabulary, only when explicitly required by this reference: ${pack?.visualContinuity.motifs.join(', ')}.`;

  const continuity = [
    pack ? `Hero identity lock: ${pack.visualContinuity.heroIdentity?.continuityPrompt ?? pack.visualContinuity.hero}` : '',
    pack?.visualContinuity.guide ? `Guide identity lock: ${pack.visualContinuity.guideIdentity?.continuityPrompt ?? pack.visualContinuity.guide}` : '',
    pack ? `Wardrobe: ${pack.visualContinuity.wardrobe ?? 'consistent wardrobe from the first shot'}.` : '',
    pack ? `Palette: ${pack.visualContinuity.palette}. ${motifGuidance}` : '',
  ].filter(Boolean).join(' ');

  const craft = craftInstructionForReferenceKind(ref.kind, {
    aspectRatio: aspect,
    purpose: ref.description,
    shotIntent: shot?.intent,
    camera: shot?.camera,
    subjectMotion: shot?.subjectMotion,
  });

  const forbidden = forbiddenForReference(state, ref, shot);

  return [
    'Create a production reference image for an AI-video short film.',
    craft,
    continuity,
    `Reference kind: ${ref.kind}.`,
    forbidden,
  ].filter(Boolean).join(' ');
}

export function isFrameReferenceKind(kind: ReferenceKind): boolean {
  return kind === 'first_frame' || kind === 'last_frame' || kind === 'return_frame' || kind === 'style_frame';
}

function modelPreferenceOrder(
  kind: ReferenceKind,
  options: {
    defaultModel?: string;
    frameReferenceModel?: string;
  },
): string[] {
  if (isFrameReferenceKind(kind)) {
    return [
      options.frameReferenceModel,
      options.defaultModel,
      'recraft/recraft-v4.1-pro',
      'recraft/recraft-v4.1',
      'recraft/recraft-v4.1-utility-pro',
      'recraft/recraft-v4.1-utility',
      'recraft/recraft-v4-pro',
      'recraft/recraft-v4',
      'recraft/recraft-v3',
      'x-ai/grok-imagine-image-quality',
      'google/gemini-3.1-flash-image-preview',
    ].filter((id): id is string => Boolean(id));
  }

  return [
    options.defaultModel,
    'recraft/recraft-v4.1',
    'recraft/recraft-v4.1-utility',
    'recraft/recraft-v4',
    'recraft/recraft-v3',
    'recraft/recraft-v4',
    'x-ai/grok-imagine-image-quality',
    'google/gemini-3.1-flash-image-preview',
  ].filter((id): id is string => Boolean(id));
}

function imageSizeForReferenceKind(kind: ReferenceKind): '0.5K' | '1K' | '2K' | '4K' {
  return isFrameReferenceKind(kind) ? '2K' : '1K';
}

function selectionReason(modelId: string, kind: ReferenceKind, explicit: boolean): string {
  if (explicit) return `explicit model override for ${kind}`;
  if (isFrameReferenceKind(kind) && modelId.startsWith('recraft/')) {
    return `Recraft-first frame reference path for ${kind}`;
  }
  return `default image reference path for ${kind}`;
}

function isImageModel(model: OpenRouterModel): boolean {
  return model.output_modalities?.includes('image') ?? false;
}

function preferredRecraftModel(models: OpenRouterModel[]): OpenRouterModel | undefined {
  const raster = models
    .filter((model) => model.id.startsWith('recraft/') && isImageModel(model))
    .filter((model) => !/\bvector\b/i.test(model.id) && !/\bvector\b/i.test(model.name ?? ''));
  return raster.find((model) => /v4\.1.*pro/i.test(model.id)) ??
    raster.find((model) => /v4\.1/i.test(model.id)) ??
    raster.find((model) => /v4.*pro/i.test(model.id)) ??
    raster.find((model) => /v4/i.test(model.id)) ??
    raster[0];
}

function craftInstructionForReferenceKind(
  kind: ReferenceKind,
  input: {
    aspectRatio: string;
    purpose: string;
    shotIntent?: string;
    camera?: string;
    subjectMotion?: string;
  },
): string {
  const format = `Format: ${input.aspectRatio} cinematic frame, grounded live-action realism, motivated lighting.`;
  if (kind === 'first_frame') {
    return [
      'Generate exactly one opening still frame to use as the video model first-frame anchor.',
      format,
      `Shot intent: ${input.shotIntent ?? input.purpose}.`,
      input.camera ? `Camera setup: ${input.camera}.` : '',
      input.subjectMotion ? `Motion affordance: compose the subject at the start of this action: ${input.subjectMotion}.` : '',
      'Use the exact hero and guide identities from the production character sheets when they are visible.',
      'Include only the physical people, animals, props, and environmental elements required by the shot purpose.',
      'This is not a poster, storyboard panel, collage, title card, or character sheet.',
    ].filter(Boolean).join(' ');
  }
  if (kind === 'last_frame' || kind === 'return_frame') {
    return [
      `Generate exactly one ${kind.replace('_', ' ')} still frame for frame chaining.`,
      format,
      `Purpose: ${input.purpose}.`,
      input.camera ? `Match camera language: ${input.camera}.` : '',
    ].filter(Boolean).join(' ');
  }
  if (kind === 'character_sheet') {
    return [
      'Generate a live-action photographic canine identity reference for production continuity, not an illustration or cartoon.',
      `Purpose: ${input.purpose}.`,
      'Show the same real dog identity with a clear full-body view and a clear close-up view in one coherent photographic frame.',
      'Keep markings, proportions, face, ears, eyes, and coat color consistent; use natural light and no labels.',
    ].join(' ');
  }
  if (kind === 'wardrobe_sheet') {
    return [
      'Generate a wardrobe continuity sheet showing the same costume from front, side, and back plus close-up material details.',
      `Purpose: ${input.purpose}.`,
    ].join(' ');
  }
  if (kind === 'prop_scale') {
    return [
      'Generate a prop and motif scale sheet with each object isolated clearly and shown at consistent relative scale.',
      `Purpose: ${input.purpose}.`,
    ].join(' ');
  }
  if (kind === 'environment_plate') {
    return [
      'Generate a wide environment plate that establishes the production location, lighting, palette, and usable space for multiple shots.',
      format,
      `Purpose: ${input.purpose}.`,
    ].join(' ');
  }
  return [
    'Generate a style frame that locks the production look, lighting, color palette, texture, and cinematic finish.',
    format,
    `Purpose: ${input.purpose}.`,
  ].join(' ');
}

function forbiddenForReference(state: ProductionState, ref: Reference, shot?: ProductionState['shots'][number]): string {
  const pack = state.filmPackage;
  const items = pack?.visualContinuity.forbidden.length
    ? [...pack.visualContinuity.forbidden]
    : ['readable text', 'logos', 'extra protagonists', 'distorted faces', 'extra fingers'];
  const context = [ref.description, shot?.intent, shot?.promptDraft].filter(Boolean).join(' ');
  if (isFrameReferenceKind(ref.kind) && !/\bleaf|leaves\b/i.test(context)) {
    items.push('floating leaves', 'loose leaves', 'random leaves', 'airborne debris');
  }
  if (ref.kind === 'character_sheet') {
    items.push('cartoon illustration', 'drawn model sheet', 'animated style', 'labels', 'text captions');
  }
  return `Keep out of frame: ${[...new Set(items)].join(', ')}.`;
}
