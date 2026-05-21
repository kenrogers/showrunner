import type { RoutingPolicy } from './config.js';
import type { ProductionState, Shot } from './domain/schema.js';
import type { OpenRouterModel, VideoModel } from './openrouter/api.js';

export type ModalityModelSource = 'explicit' | 'state' | 'env' | 'quality' | 'fallback';

export interface VideoModelSelection {
  model: VideoModel;
  modality: 'video';
  source: ModalityModelSource;
  candidates: string[];
  reason: string;
}

export interface SpeechModelSelection {
  model: string;
  modality: 'speech';
  source: ModalityModelSource;
  candidates: string[];
  reason: string;
  warning?: string;
}

export interface AudioModelSelection {
  model: string;
  modality: 'audio';
  source: ModalityModelSource;
  candidates: string[];
  reason: string;
  warning?: string;
}

const VIDEO_MODEL_PREFERENCES: Record<RoutingPolicy, string[]> = {
  best_quality: [
    'kwaivgi/kling-v3.0-pro',
    'google/veo-3.1',
    'kwaivgi/kling-video-o1',
    'bytedance/seedance-2.0',
    'alibaba/wan-2.7',
    'google/veo-3.1-fast',
    'kwaivgi/kling-v3.0-std',
    'google/veo-3.1-lite',
  ],
  balanced: [
    'kwaivgi/kling-v3.0-pro',
    'kwaivgi/kling-v3.0-std',
    'google/veo-3.1-fast',
    'bytedance/seedance-2.0-fast',
    'google/veo-3.1-lite',
  ],
  budget_aware: [
    'google/veo-3.1-lite',
    'bytedance/seedance-2.0-fast',
    'kwaivgi/kling-v3.0-std',
    'google/veo-3.1-fast',
    'kwaivgi/kling-v3.0-pro',
  ],
};

const SPEECH_MODEL_PREFERENCES = [
  'x-ai/grok-voice-tts-1.0',
  'openai/gpt-4o-mini-tts-2025-12-15',
  'google/gemini-3.1-flash-tts-preview',
  'mistralai/voxtral-mini-tts-2603',
  'zyphra/zonos-tts',
  'sesame/csm-1b',
];

const AUDIO_MODEL_PREFERENCES = [
  'google/lyria-3-pro-preview',
  'google/lyria-3-clip-preview',
  'openai/gpt-audio',
  'openai/gpt-audio-mini',
  'openai/gpt-4o-audio-preview',
];

export function selectVideoModelForShot(input: {
  models: VideoModel[];
  state: ProductionState;
  shot: Shot;
  preferredModel?: string;
  defaultModel?: string;
  resolution?: string;
}): VideoModelSelection {
  const resolution = input.resolution ?? '720p';
  const aspectRatio = input.state.production.target.aspectRatio;
  const requiresFirstFrame = Boolean(input.shot.continuityCritical && input.state.filmPackage?.visualContinuity.frameChaining);

  if (input.preferredModel) {
    const explicit = input.models.find((model) => model.id === input.preferredModel);
    if (!explicit) throw new Error(`Preferred video model is not available on OpenRouter: ${input.preferredModel}`);
    if (!videoModelSupports(explicit, input.shot.durationSeconds, resolution, aspectRatio)) {
      throw new Error(`${explicit.id} does not support ${input.shot.durationSeconds}s ${resolution} ${aspectRatio} video.`);
    }
    return {
      model: explicit,
      modality: 'video',
      source: 'explicit',
      candidates: [input.preferredModel],
      reason: requiresFirstFrame && !supportsFirstFrame(explicit)
        ? 'explicit model override; using references as guidance because first-frame support is not advertised'
        : 'explicit model override',
    };
  }

  const stateCandidates = input.state.production.routing.modalities?.video?.preferredModels ?? [];
  const envDefault = process.env.SHOWRUNNER_DEFAULT_VIDEO_MODEL?.trim();
  const configuredQuality = listFromEnv('SHOWRUNNER_VIDEO_QUALITY_MODELS');
  const candidates = unique([
    ...stateCandidates,
    envDefault,
    ...configuredQuality,
    ...VIDEO_MODEL_PREFERENCES[input.state.production.routing.policy],
    input.defaultModel,
  ]);
  const sourceById = sourceMap([
    ...stateCandidates.map((id) => [id, 'state'] as const),
    ...(envDefault ? [[envDefault, 'env'] as const] : []),
    ...configuredQuality.map((id) => [id, 'env'] as const),
    ...VIDEO_MODEL_PREFERENCES[input.state.production.routing.policy].map((id) => [id, 'quality'] as const),
    ...(input.defaultModel ? [[input.defaultModel, 'quality'] as const] : []),
  ]);

  const preferredCompatible = firstMatchingVideoModel(input.models, candidates, {
    durationSeconds: input.shot.durationSeconds,
    resolution,
    aspectRatio,
    requireFirstFrame: requiresFirstFrame,
  });
  if (preferredCompatible) {
    return {
      model: preferredCompatible,
      modality: 'video',
      source: sourceById.get(preferredCompatible.id) ?? 'quality',
      candidates,
      reason: requiresFirstFrame && supportsFirstFrame(preferredCompatible)
        ? 'quality route with first-frame continuity support'
        : 'quality route',
    };
  }

  const compatibleFallback = input.models.find((model) =>
    videoModelSupports(model, input.shot.durationSeconds, resolution, aspectRatio) &&
    (!requiresFirstFrame || supportsFirstFrame(model)));
  if (compatibleFallback) {
    return {
      model: compatibleFallback,
      modality: 'video',
      source: 'fallback',
      candidates,
      reason: 'fallback compatible video model discovered at runtime',
    };
  }

  const looseFallback = input.models.find((model) =>
    videoModelSupports(model, input.shot.durationSeconds, resolution, aspectRatio));
  if (looseFallback) {
    return {
      model: looseFallback,
      modality: 'video',
      source: 'fallback',
      candidates,
      reason: 'fallback compatible video model; first-frame support is not advertised',
    };
  }

  throw new Error(`No compatible video model found for ${input.shot.durationSeconds}s ${resolution} ${aspectRatio}.`);
}

export function selectSpeechModel(input: {
  models: OpenRouterModel[];
  state?: ProductionState;
  preferredModel?: string;
  defaultModel?: string;
}): SpeechModelSelection {
  const stateCandidates = input.state?.production.routing.modalities?.speech?.preferredModels ?? [];
  const envDefault = process.env.SHOWRUNNER_TTS_MODEL?.trim();
  const envQuality = listFromEnv('SHOWRUNNER_SPEECH_QUALITY_MODELS');
  const candidates = unique([
    input.preferredModel,
    ...stateCandidates,
    envDefault,
    ...envQuality,
    input.defaultModel,
    ...SPEECH_MODEL_PREFERENCES,
  ]);
  const sourceById = sourceMap([
    ...(input.preferredModel ? [[input.preferredModel, 'explicit'] as const] : []),
    ...stateCandidates.map((id) => [id, 'state'] as const),
    ...(envDefault ? [[envDefault, 'env'] as const] : []),
    ...envQuality.map((id) => [id, 'env'] as const),
    ...(input.defaultModel ? [[input.defaultModel, 'quality'] as const] : []),
    ...SPEECH_MODEL_PREFERENCES.map((id) => [id, 'quality'] as const),
  ]);

  if (input.models.length === 0) {
    const fallback = candidates[0] ?? 'x-ai/grok-voice-tts-1.0';
    return {
      model: fallback,
      modality: 'speech',
      source: sourceById.get(fallback) ?? 'fallback',
      candidates,
      reason: 'speech model discovery unavailable; using configured fallback',
      warning: 'OpenRouter speech model discovery returned no models.',
    };
  }

  const available = new Set(input.models.filter(isSpeechModel).map((model) => model.id));
  const selected = candidates.find((candidate) => available.has(candidate));
  if (selected) {
    return {
      model: selected,
      modality: 'speech',
      source: sourceById.get(selected) ?? 'quality',
      candidates,
      reason: selected === 'x-ai/grok-voice-tts-1.0' ? 'quality route with Grok Voice TTS' : 'quality speech route',
    };
  }

  const fallback = input.models.find(isSpeechModel);
  if (!fallback) {
    const configured = candidates[0] ?? 'x-ai/grok-voice-tts-1.0';
    return {
      model: configured,
      modality: 'speech',
      source: sourceById.get(configured) ?? 'fallback',
      candidates,
      reason: 'configured fallback speech route',
      warning: 'No OpenRouter model in the discovery response advertised speech output.',
    };
  }

  return {
    model: fallback.id,
    modality: 'speech',
    source: 'fallback',
    candidates,
    reason: 'fallback speech-output model discovered at runtime',
  };
}

export function selectAudioModel(input: {
  models: OpenRouterModel[];
  state?: ProductionState;
  preferredModel?: string;
  defaultModel?: string;
}): AudioModelSelection {
  const stateCandidates = input.state?.production.routing.modalities?.audio?.preferredModels ??
    input.state?.production.routing.modalities?.music?.preferredModels ??
    [];
  const envDefault = process.env.SHOWRUNNER_MUSIC_MODEL?.trim();
  const envQuality = listFromEnv('SHOWRUNNER_MUSIC_QUALITY_MODELS');
  const candidates = unique([
    input.preferredModel,
    ...stateCandidates,
    envDefault,
    ...envQuality,
    input.defaultModel,
    ...AUDIO_MODEL_PREFERENCES,
  ]);
  const sourceById = sourceMap([
    ...(input.preferredModel ? [[input.preferredModel, 'explicit'] as const] : []),
    ...stateCandidates.map((id) => [id, 'state'] as const),
    ...(envDefault ? [[envDefault, 'env'] as const] : []),
    ...envQuality.map((id) => [id, 'env'] as const),
    ...(input.defaultModel ? [[input.defaultModel, 'quality'] as const] : []),
    ...AUDIO_MODEL_PREFERENCES.map((id) => [id, 'quality'] as const),
  ]);

  if (input.models.length === 0) {
    const fallback = candidates[0] ?? 'google/lyria-3-pro-preview';
    return {
      model: fallback,
      modality: 'audio',
      source: sourceById.get(fallback) ?? 'fallback',
      candidates,
      reason: 'audio model discovery unavailable; using configured fallback',
      warning: 'OpenRouter audio model discovery returned no models.',
    };
  }

  const available = new Set(input.models.filter(isAudioModel).map((model) => model.id));
  const selected = candidates.find((candidate) => available.has(candidate));
  if (selected) {
    return {
      model: selected,
      modality: 'audio',
      source: sourceById.get(selected) ?? 'quality',
      candidates,
      reason: selected.startsWith('google/lyria-3') ? 'quality route with Lyria music generation' : 'quality audio route',
    };
  }

  const fallback = input.models.find(isAudioModel);
  if (!fallback) {
    const configured = candidates[0] ?? 'google/lyria-3-pro-preview';
    return {
      model: configured,
      modality: 'audio',
      source: sourceById.get(configured) ?? 'fallback',
      candidates,
      reason: 'configured fallback audio route',
      warning: 'No OpenRouter model in the discovery response advertised audio output.',
    };
  }

  return {
    model: fallback.id,
    modality: 'audio',
    source: 'fallback',
    candidates,
    reason: 'fallback audio-output model discovered at runtime',
  };
}

export function recordModalityModel(
  state: ProductionState,
  modality: 'video' | 'speech' | 'audio',
  selection: Pick<VideoModelSelection, 'model' | 'source' | 'reason'> | SpeechModelSelection | AudioModelSelection,
): void {
  const modelId = typeof selection.model === 'string' ? selection.model : selection.model.id;
  const warning = 'warning' in selection ? selection.warning : undefined;
  if (warning) state.eventLog.push(`${modality} model routing warning: ${warning}`);
  state.eventLog.push(`Routed ${modality} generation to ${modelId} (${selection.source}): ${selection.reason}.`);
}

function firstMatchingVideoModel(
  models: VideoModel[],
  candidates: string[],
  requirement: {
    durationSeconds: number;
    resolution: string;
    aspectRatio: string;
    requireFirstFrame: boolean;
  },
): VideoModel | undefined {
  for (const id of candidates) {
    const model = models.find((candidate) => candidate.id === id);
    if (!model) continue;
    if (!videoModelSupports(model, requirement.durationSeconds, requirement.resolution, requirement.aspectRatio)) continue;
    if (requirement.requireFirstFrame && !supportsFirstFrame(model)) continue;
    return model;
  }
  return undefined;
}

function videoModelSupports(model: VideoModel, durationSeconds: number, resolution: string, aspectRatio: string): boolean {
  return Boolean(
    model.supported_durations?.includes(durationSeconds) &&
    model.supported_resolutions?.includes(resolution) &&
    model.supported_aspect_ratios?.includes(aspectRatio),
  );
}

function supportsFirstFrame(model: VideoModel): boolean {
  return model.supported_frame_images?.includes('first_frame') ?? false;
}

function isSpeechModel(model: OpenRouterModel): boolean {
  return model.output_modalities?.includes('speech') ?? false;
}

function isAudioModel(model: OpenRouterModel): boolean {
  return model.output_modalities?.includes('audio') ?? false;
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function sourceMap(entries: ReadonlyArray<readonly [string, ModalityModelSource]>): Map<string, ModalityModelSource> {
  const map = new Map<string, ModalityModelSource>();
  for (const [id, source] of entries) {
    if (!map.has(id)) map.set(id, source);
  }
  return map;
}
