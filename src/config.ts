import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type RoutingPolicy = 'best_quality' | 'balanced' | 'budget_aware';
export type WebSearchEngine = 'auto' | 'native' | 'exa' | 'firecrawl' | 'parallel';
export type SearchContextSize = 'low' | 'medium' | 'high';

export const DEFAULT_SHOWRUNNER_MODEL = 'anthropic/claude-sonnet-4.6';
export const DEFAULT_IMAGE_MODEL = 'recraft/recraft-v4.1';
export const DEFAULT_VIDEO_MODEL = 'kwaivgi/kling-v3.0-pro';
export const DEFAULT_TTS_MODEL = 'x-ai/grok-voice-tts-1.0';
export const DEFAULT_TTS_VOICE = 'Ara';
export const DEFAULT_MUSIC_MODEL = 'google/lyria-3-pro-preview';

export interface AgentConfig {
  apiKey: string;
  model: string;
  modelSource: 'env' | 'local' | 'default';
  defaultImageModel: string;
  defaultVideoModel: string;
  frameReferenceModel?: string;
  ttsModel: string;
  ttsVoice: string;
  musicModel: string;
  maxSteps: number;
  maxCost: number;
  compactionModel: string;
  compactionMaxCost: number;
  productionRoot: string;
  routingPolicy: RoutingPolicy;
  threadPath: string;
  contextWindowTokens: number;
  autoCompactRatio: number;
  emergencyCompactRatio: number;
  keepHeadTurns: number;
  keepRecentTurns: number;
  webSearchEnabled: boolean;
  webSearchEngine: WebSearchEngine;
  webSearchMaxResults: number;
  webSearchMaxTotalResults: number;
  webSearchContextSize: SearchContextSize;
}

function loadEnvFile(path = resolve('.env')): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(): AgentConfig {
  loadEnvFile();
  const local = loadLocalConfig();
  const envModel = stringFromEnv('SHOWRUNNER_MODEL') ?? stringFromEnv('AGENT_MODEL');
  const model = envModel ?? local.model ?? DEFAULT_SHOWRUNNER_MODEL;
  const defaultImageModel = stringFromEnv('SHOWRUNNER_DEFAULT_IMAGE_MODEL') ?? local.defaultImageModel ?? DEFAULT_IMAGE_MODEL;
  const defaultVideoModel = stringFromEnv('SHOWRUNNER_DEFAULT_VIDEO_MODEL') ?? local.defaultVideoModel ?? DEFAULT_VIDEO_MODEL;
  const frameReferenceModel = stringFromEnv('SHOWRUNNER_FRAME_REFERENCE_MODEL') ?? local.frameReferenceModel;
  const ttsModel = stringFromEnv('SHOWRUNNER_TTS_MODEL') ?? local.ttsModel ?? DEFAULT_TTS_MODEL;
  const ttsVoice = stringFromEnv('SHOWRUNNER_TTS_VOICE') ?? local.ttsVoice ?? DEFAULT_TTS_VOICE;
  const musicModel = stringFromEnv('SHOWRUNNER_MUSIC_MODEL') ?? local.musicModel ?? DEFAULT_MUSIC_MODEL;
  return {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    model,
    modelSource: envModel ? 'env' : local.model ? 'local' : 'default',
    defaultImageModel,
    defaultVideoModel,
    frameReferenceModel,
    ttsModel,
    ttsVoice,
    musicModel,
    maxSteps: Number(process.env.SHOWRUNNER_MAX_STEPS ?? 10),
    maxCost: Number(process.env.SHOWRUNNER_MAX_COST ?? 0.5),
    compactionModel: stringFromEnv('SHOWRUNNER_COMPACTION_MODEL') ?? model,
    compactionMaxCost: numberFromEnv('SHOWRUNNER_COMPACTION_MAX_COST', 0.08),
    productionRoot: stringFromEnv('SHOWRUNNER_PRODUCTION_ROOT') ?? 'productions',
    routingPolicy: (process.env.SHOWRUNNER_ROUTING_POLICY as RoutingPolicy | undefined) ?? 'best_quality',
    threadPath: stringFromEnv('SHOWRUNNER_THREAD_PATH') ?? '.showrunner/thread.json',
    contextWindowTokens: numberFromEnv('SHOWRUNNER_CONTEXT_WINDOW_TOKENS', 128000),
    autoCompactRatio: ratioFromEnv('SHOWRUNNER_AUTO_COMPACT_RATIO', 0.55),
    emergencyCompactRatio: ratioFromEnv('SHOWRUNNER_EMERGENCY_COMPACT_RATIO', 0.85),
    keepHeadTurns: integerFromEnv('SHOWRUNNER_KEEP_HEAD_TURNS', 2),
    keepRecentTurns: integerFromEnv('SHOWRUNNER_KEEP_RECENT_TURNS', 12),
    webSearchEnabled: booleanFromEnv('SHOWRUNNER_WEB_SEARCH', true),
    webSearchEngine: enumFromEnv('SHOWRUNNER_WEB_SEARCH_ENGINE', ['auto', 'native', 'exa', 'firecrawl', 'parallel'], 'auto'),
    webSearchMaxResults: integerFromEnv('SHOWRUNNER_WEB_SEARCH_MAX_RESULTS', 5),
    webSearchMaxTotalResults: integerFromEnv('SHOWRUNNER_WEB_SEARCH_MAX_TOTAL_RESULTS', 8),
    webSearchContextSize: enumFromEnv('SHOWRUNNER_WEB_SEARCH_CONTEXT_SIZE', ['low', 'medium', 'high'], 'medium'),
  };
}

function loadLocalConfig(): {
  model?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  frameReferenceModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  musicModel?: string;
} {
  const path = resolve('.showrunner/config.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      model?: unknown;
      defaultImageModel?: unknown;
      defaultVideoModel?: unknown;
      frameReferenceModel?: unknown;
      ttsModel?: unknown;
      ttsVoice?: unknown;
      musicModel?: unknown;
    };
    return {
      ...(typeof parsed.model === 'string' && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
      ...(typeof parsed.defaultImageModel === 'string' && parsed.defaultImageModel.trim() ? { defaultImageModel: parsed.defaultImageModel.trim() } : {}),
      ...(typeof parsed.defaultVideoModel === 'string' && parsed.defaultVideoModel.trim() ? { defaultVideoModel: parsed.defaultVideoModel.trim() } : {}),
      ...(typeof parsed.frameReferenceModel === 'string' && parsed.frameReferenceModel.trim() ? { frameReferenceModel: parsed.frameReferenceModel.trim() } : {}),
      ...(typeof parsed.ttsModel === 'string' && parsed.ttsModel.trim() ? { ttsModel: parsed.ttsModel.trim() } : {}),
      ...(typeof parsed.ttsVoice === 'string' && parsed.ttsVoice.trim() ? { ttsVoice: parsed.ttsVoice.trim() } : {}),
      ...(typeof parsed.musicModel === 'string' && parsed.musicModel.trim() ? { musicModel: parsed.musicModel.trim() } : {}),
    };
  } catch {
    return {};
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringFromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function integerFromEnv(name: string, fallback: number): number {
  return Math.floor(numberFromEnv(name, fallback));
}

function ratioFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = stringFromEnv(name)?.toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function enumFromEnv<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = stringFromEnv(name);
  return value && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}
