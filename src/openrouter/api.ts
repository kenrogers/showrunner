import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const BASE_URL = 'https://openrouter.ai/api/v1';
const execFileAsync = promisify(execFile);

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  context_length?: number;
  top_provider?: { context_length?: number };
  pricing?: Record<string, unknown>;
}

export interface VideoModel {
  id: string;
  name?: string;
  description?: string;
  supported_durations?: number[];
  supported_resolutions?: string[];
  supported_aspect_ratios?: string[];
  supported_frame_images?: string[] | null;
  allowed_passthrough_parameters?: string[];
  pricing?: Record<string, unknown>;
  pricing_skus?: Record<string, string>;
}

export interface VideoJob {
  id: string;
  polling_url?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
  generation_id?: string;
  unsigned_urls?: string[];
  usage?: { cost?: number; is_byok?: boolean };
  error?: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;
}

export interface ImageGenerationResult {
  imageUrl: string;
  outputPath: string;
  costUsd?: number;
}

export interface AudioGenerationResult {
  outputPath: string;
  format: string;
  transcript?: string;
  costUsd?: number;
}

export async function listModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const json = await openRouterJson<{ data: OpenRouterModel[] }>('/models', apiKey);
  return (json.data ?? []).map(normalizeOpenRouterModel);
}

export async function listModelsByOutputModality(modality: string, apiKey?: string): Promise<OpenRouterModel[]> {
  const json = await openRouterJson<{ data: OpenRouterModel[] }>(`/models?output_modalities=${encodeURIComponent(modality)}`, apiKey);
  return (json.data ?? []).map(normalizeOpenRouterModel);
}

export function normalizeOpenRouterModel(model: OpenRouterModel): OpenRouterModel {
  return {
    ...model,
    input_modalities: model.input_modalities ?? model.architecture?.input_modalities,
    output_modalities: model.output_modalities ?? model.architecture?.output_modalities,
  };
}

export async function getModelContextLength(modelId: string, apiKey?: string): Promise<number | undefined> {
  if (!modelId || modelId === 'openrouter/auto') return undefined;
  const models = await listModels(apiKey);
  const found = models.find((model) => model.id === modelId);
  return found ? contextLengthOf(found) : undefined;
}

export async function listVideoModels(apiKey?: string): Promise<VideoModel[]> {
  const json = await openRouterJson<{ data: VideoModel[] }>('/videos/models', apiKey);
  return json.data ?? [];
}

export async function completeChatText(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}): Promise<string> {
  const json = await openRouterJson<{
    choices?: Array<{ message?: { content?: unknown } }>;
  }>('/chat/completions', input.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 4000,
      ...(input.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  throw new Error('OpenRouter chat completion did not return text content.');
}

export async function generateImage(input: {
  apiKey: string;
  model: string;
  prompt: string;
  outputPath: string;
  aspectRatio?: string;
  imageSize?: '0.5K' | '1K' | '2K' | '4K';
  modalities?: Array<'image' | 'text'>;
}): Promise<ImageGenerationResult> {
  const imageConfig = {
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
    ...(input.imageSize && !input.model.startsWith('recraft/') ? { image_size: input.imageSize } : {}),
  };
  const json = await openRouterJson<{
    choices?: Array<{
      message?: {
        images?: Array<
          | { image_url?: { url?: string } }
          | { imageUrl?: { url?: string } }
        >;
      };
    }>;
    usage?: { cost?: number };
  }>('/chat/completions', input.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
      modalities: input.modalities ?? ['image', 'text'],
      stream: false,
      ...(Object.keys(imageConfig).length ? { image_config: imageConfig } : {}),
    }),
  });

  const firstImage = json.choices?.[0]?.message?.images?.[0];
  const imageUrl = firstImage && 'image_url' in firstImage
    ? firstImage.image_url?.url
    : firstImage && 'imageUrl' in firstImage
      ? firstImage.imageUrl?.url
      : undefined;
  if (!imageUrl) throw new Error('OpenRouter image generation did not return an image URL.');

  await writeDataUrlImage(imageUrl, input.outputPath);
  return { imageUrl, outputPath: input.outputPath, costUsd: json.usage?.cost };
}

export function previewVideoRequest(input: {
  model: string;
  prompt: string;
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
  inputReferences?: Array<{ type: 'image_url'; image_url: { url: string } }>;
  frameImages?: Array<{ type: 'image_url'; image_url: { url: string }; frame_type: 'first_frame' | 'last_frame' }>;
  providerOptions?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    model: input.model,
    prompt: input.prompt,
    ...(input.durationSeconds && { duration: input.durationSeconds }),
    ...(input.resolution && { resolution: input.resolution }),
    ...(input.aspectRatio && { aspect_ratio: input.aspectRatio }),
    ...(input.generateAudio !== undefined && { generate_audio: input.generateAudio }),
    ...(input.inputReferences?.length && { input_references: input.inputReferences }),
    ...(input.frameImages?.length && { frame_images: input.frameImages }),
    ...(input.providerOptions && { provider: { options: input.providerOptions } }),
  };
}

export async function submitVideoJob(apiKey: string, payload: Record<string, unknown>, approved: boolean): Promise<VideoJob> {
  if (!approved) throw new Error('submitVideoJob requires explicit approval.');
  return openRouterJson<VideoJob>('/videos', apiKey, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function pollVideoJob(apiKey: string, jobIdOrUrl: string): Promise<VideoJob> {
  const path = jobIdOrUrl.startsWith('http') ? jobIdOrUrl : `/videos/${jobIdOrUrl}`;
  return openRouterJson<VideoJob>(path, apiKey);
}

export async function downloadVideo(apiKey: string, url: string, outputPath: string): Promise<void> {
  const res = await fetch(url, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`OpenRouter video download failed: ${res.status} ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

export async function synthesizeSpeech(input: {
  apiKey: string;
  model: string;
  text: string;
  voice?: string;
  outputPath: string;
  responseFormat?: 'mp3' | 'pcm';
}): Promise<void> {
  const res = await fetch(`${BASE_URL}/audio/speech`, {
    method: 'POST',
    headers: {
      ...authHeaders(input.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      input: input.text,
      voice: input.voice ?? 'Ara',
      response_format: input.responseFormat ?? 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter speech synthesis failed: ${res.status} ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, bytes);
}

export async function generateAudio(input: {
  apiKey: string;
  model: string;
  prompt: string;
  outputPath: string;
  format?: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';
  voice?: string;
}): Promise<AudioGenerationResult> {
  const format = input.format ?? 'wav';
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(input.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: 'user', content: input.prompt }],
      modalities: ['text', 'audio'],
      audio: {
        ...(input.voice ? { voice: input.voice } : {}),
        format,
      },
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter audio generation failed: ${res.status} ${await res.text()}`);
  if (!res.body) throw new Error('OpenRouter audio generation did not return a response body.');

  const { audioBase64, transcript, costUsd } = await readAudioSse(res.body);
  if (!audioBase64) throw new Error('OpenRouter audio generation did not return audio data.');

  const bytes = Buffer.from(audioBase64, 'base64');
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, bytes);
  return { outputPath: input.outputPath, format, transcript, costUsd };
}

async function readAudioSse(body: ReadableStream<Uint8Array>): Promise<{
  audioBase64: string;
  transcript: string;
  costUsd?: number;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let audioBase64 = '';
  let transcript = '';
  let costUsd: number | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const events = pending.split('\n\n');
    pending = events.pop() ?? '';

    for (const event of events) {
      for (const line of event.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice('data:'.length).trim();
        if (!data || data === '[DONE]') continue;
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { audio?: { data?: string; transcript?: string } } }>;
          usage?: { cost?: number };
        };
        const audio = parsed.choices?.[0]?.delta?.audio;
        if (audio?.data) audioBase64 += audio.data;
        if (audio?.transcript) transcript += audio.transcript;
        if (typeof parsed.usage?.cost === 'number') costUsd = parsed.usage.cost;
      }
    }

    if (done) break;
  }

  return { audioBase64, transcript, costUsd };
}

async function writeDataUrlImage(dataUrl: string, outputPath: string): Promise<void> {
  const match = dataUrl.match(/^data:(image\/([a-z0-9.+-]+));base64,(.+)$/i);
  if (!match) {
    if (/^https?:\/\//i.test(dataUrl)) {
      const res = await fetch(dataUrl);
      if (!res.ok) throw new Error(`OpenRouter image download failed: ${res.status} ${await res.text()}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      await writeImageBytes(bytes, outputPath, res.headers.get('content-type') ?? undefined);
      return;
    }
    throw new Error('OpenRouter image generation returned an unsupported image URL format.');
  }
  const bytes = Buffer.from(match[3], 'base64');
  await writeImageBytes(bytes, outputPath, match[1]);
}

async function writeImageBytes(bytes: Buffer, outputPath: string, sourceMime?: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  if (outputPath.toLowerCase().endsWith('.png') && !isPng(bytes)) {
    await convertImageToPng(bytes, outputPath, extensionForImage(bytes, sourceMime));
    return;
  }
  await writeFile(outputPath, bytes);
}

async function convertImageToPng(bytes: Buffer, outputPath: string, sourceExt: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'showrunner-image-'));
  const inputPath = join(dir, `input.${sourceExt}`);
  try {
    await writeFile(inputPath, bytes);
    try {
      await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inputPath, outputPath]);
    } catch (ffmpegError) {
      try {
        await execFileAsync('sips', ['-s', 'format', 'png', inputPath, '--out', outputPath]);
      } catch {
        throw ffmpegError;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

function extensionForImage(bytes: Buffer, sourceMime?: string): string {
  if (isPng(bytes)) return 'png';
  if (isJpeg(bytes)) return 'jpg';
  if (isWebp(bytes)) return 'webp';
  if (/image\/jpe?g/i.test(sourceMime ?? '')) return 'jpg';
  if (/image\/webp/i.test(sourceMime ?? '')) return 'webp';
  return 'img';
}

export async function previewSpeechRequest(input: {
  model: string;
  text: string;
  voice?: string;
  responseFormat?: 'mp3' | 'pcm';
}): Promise<Record<string, unknown>> {
  return {
    model: input.model,
    input: input.text,
    voice: input.voice ?? 'alloy',
    response_format: input.responseFormat ?? 'mp3',
  };
}

async function openRouterJson<T>(pathOrUrl: string, apiKey?: string, init: RequestInit = {}): Promise<T> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
  const timeoutMs = Number(process.env.SHOWRUNNER_OPENROUTER_TIMEOUT_MS ?? 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        ...authHeaders(apiKey),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`OpenRouter API failed: ${res.status} ${await res.text()}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function contextLengthOf(model: OpenRouterModel): number | undefined {
  const value = model.context_length ?? model.top_provider?.context_length;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
