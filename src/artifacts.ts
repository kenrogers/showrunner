import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Assembly, FinishedShot, ProductionState, SoundMix, Take } from './domain/schema.js';

export interface ArtifactStatus {
  kind: 'take' | 'finished_shot' | 'sound_mix' | 'export';
  id: string;
  path: string;
  absolutePath: string;
  exists: boolean;
  sizeBytes?: number;
  note?: string;
}

export async function materializeProductionArtifacts(state: ProductionState, dir: string): Promise<ArtifactStatus[]> {
  const baseDir = resolve(dir);

  for (const assembly of state.assemblies) {
    await ensureFinishedShotsForAssembly(state, assembly, baseDir);
  }

  for (const mix of state.soundMixes) {
    if (!mix.outputPath) continue;

    const targetPath = join(baseDir, mix.outputPath);
    await mkdir(dirname(targetPath), { recursive: true });

    const assembly = state.assemblies.find((candidate) => candidate.id === mix.assemblyId);
    if (!assembly) throw new Error(`Cannot render ${mix.id}: assembly ${mix.assemblyId} is missing.`);

    const media = selectedMedia(state, assembly.selectedTakeIds);
    if (media.length === 0) throw new Error(`Cannot render ${mix.id}: no selected takes have media files.`);

    reconcileSoundMixSources(state, mix, media);
    await renderSoundMix({
      takePaths: media.map((item) => join(baseDir, item.mediaPath)),
      speech: speechSources(state, mix, baseDir),
      musicPath: musicSource(state, mix, baseDir),
      durationSeconds: state.production.target.runtimeSeconds,
      outputPath: targetPath,
    });
    logOnce(state, `Rendered real Sound Mix ${mix.id} to ${mix.outputPath}.`);
  }

  for (const item of state.exports) {
    const targetPath = join(baseDir, item.path);
    await mkdir(dirname(targetPath), { recursive: true });

    const assembly = state.assemblies.find((candidate) => candidate.id === item.assemblyId);
    if (!assembly) throw new Error(`Cannot render ${item.id}: assembly ${item.assemblyId} is missing.`);

    const media = selectedMedia(state, assembly.selectedTakeIds);
    if (media.length === 0) throw new Error(`Cannot render ${item.id}: no selected takes have media files.`);

    const mix = state.soundMixes.find((candidate) => candidate.id === assembly.soundMixId);
    const mixPath = mix?.outputPath ? join(baseDir, mix.outputPath) : undefined;
    if (mixPath && !(await fileInfo(mixPath)).exists) {
      throw new Error(`Cannot render ${item.id}: sound mix ${mix?.id} is missing.`);
    }

    await renderExport(media.map((item) => join(baseDir, item.mediaPath)), mixPath, targetPath, state.production.title);
    logOnce(state, `Rendered real Export ${item.id} to ${item.path}.`);
  }

  return inspectArtifacts(state, baseDir);
}

export async function inspectArtifacts(state: ProductionState, dir: string): Promise<ArtifactStatus[]> {
  const baseDir = resolve(dir);
  const artifacts: ArtifactStatus[] = [];

  for (const take of state.takes) {
    if (!take.mediaPath) continue;
    artifacts.push(await inspectArtifact('take', take.id, take.mediaPath, baseDir));
  }

  for (const item of state.finishedShots) {
    artifacts.push(await inspectArtifact('finished_shot', item.id, item.outputPath, baseDir, `${item.pipeline.adapter}; ${item.pipeline.targetResolution}; grain ${item.pipeline.grain ? 'on' : 'off'}`));
  }

  for (const mix of state.soundMixes) {
    if (!mix.outputPath) continue;
    artifacts.push(await inspectArtifact('sound_mix', mix.id, mix.outputPath, baseDir, soundMixSourceSummary(mix)));
  }

  for (const item of state.exports) {
    artifacts.push(await inspectArtifact('export', item.id, item.path, baseDir));
  }

  return artifacts;
}

async function ensureFinishedShotsForAssembly(
  state: ProductionState,
  assembly: Assembly,
  baseDir: string,
): Promise<void> {
  for (const takeId of assembly.selectedTakeIds) {
    const take = state.takes.find((candidate) => candidate.id === takeId);
    if (!take?.mediaPath) continue;
    const outputPath = join('assets', 'finished', `${take.id}.mp4`);
    const existing = state.finishedShots.find((item) => item.takeId === take.id);
    const outputInfo = await fileInfo(join(baseDir, existing?.outputPath ?? outputPath));
    if (existing?.status === 'completed' && outputInfo.exists) continue;

    const item = existing ?? createFinishedShot(state, take, outputPath);
    item.status = 'planned';
    item.sourcePath = take.mediaPath;
    item.outputPath = outputPath;

    try {
      await mkdir(dirname(join(baseDir, outputPath)), { recursive: true });
      await finishTakeMedia({
        inputPath: join(baseDir, take.mediaPath),
        outputPath: join(baseDir, outputPath),
        aspectRatio: state.production.target.aspectRatio,
      });
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
      logOnce(state, `Finished ${take.id} through ${item.pipeline.adapter} to ${item.outputPath}.`);
    } catch (err) {
      item.status = 'failed';
      throw new Error(`Cannot finish ${take.id}: ${(err as Error).message}`);
    }
  }
}

function createFinishedShot(state: ProductionState, take: Take, outputPath: string): FinishedShot {
  const item: FinishedShot = {
    id: nextFinishedShotId(state),
    shotId: take.shotId,
    takeId: take.id,
    sourcePath: take.mediaPath ?? '',
    outputPath,
    status: 'planned',
    pipeline: {
      upscale: true,
      cleanup: true,
      grain: true,
      targetResolution: '1080p',
      frameRate: 30,
      adapter: 'ffmpeg_lanczos_cleanup_grain',
    },
    createdAt: new Date().toISOString(),
  };
  state.finishedShots.push(item);
  return item;
}

function nextFinishedShotId(state: ProductionState): string {
  const maxId = state.finishedShots.reduce((max, item) => {
    const match = /^finished_(\d+)$/.exec(item.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `finished_${maxId + 1}`;
}

function selectedMedia(state: ProductionState, selectedTakeIds: string[]): Array<{ id: string; mediaPath: string; nativeAudioPresent: boolean }> {
  return selectedTakeIds.flatMap((id) => {
    const take = state.takes.find((candidate) => candidate.id === id);
    if (!take?.mediaPath) return [];
    const finished = state.finishedShots.find((item) => item.takeId === take.id && item.status === 'completed');
    return [{ id: take.id, mediaPath: finished?.outputPath ?? take.mediaPath, nativeAudioPresent: take.nativeAudio?.present ?? false }];
  });
}

async function finishTakeMedia(input: {
  inputPath: string;
  outputPath: string;
  aspectRatio: string;
}): Promise<void> {
  const { width, height } = dimensionsForAspectRatio(input.aspectRatio);
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    'fps=30',
    'hqdn3d=1.2:1.2:3:3',
    'format=yuv420p',
    'noise=alls=2:allf=t+u',
  ].join(',');
  await runMediaCommand('ffmpeg', [
    '-y',
    '-i', input.inputPath,
    '-vf', filter,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-movflags', '+faststart',
    input.outputPath,
  ]);
}

function dimensionsForAspectRatio(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === '16:9') return { width: 1920, height: 1080 };
  if (aspectRatio === '1:1') return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

function reconcileSoundMixSources(
  state: ProductionState,
  mix: SoundMix,
  takes: Array<{ id: string; nativeAudioPresent: boolean }>,
): void {
  const knownNarration = new Set(state.filmPackage?.narration.map((item) => item.id) ?? []);
  const knownDialogue = new Set(state.filmPackage?.dialogue.map((item) => item.id) ?? []);
  const knownMusic = new Set(state.filmPackage?.music ? [state.filmPackage.music.id ?? 'music_1'] : []);
  mix.narrationIds = mix.narrationIds.filter((id) => knownNarration.has(id));
  mix.dialogueIds = (mix.dialogueIds ?? []).filter((id) => knownDialogue.has(id));
  mix.musicCueIds = mix.musicCueIds.filter((id) => knownMusic.has(id));
  if (state.filmPackage?.music?.audioPath && mix.musicCueIds.length === 0) {
    mix.musicCueIds = [state.filmPackage.music.id ?? 'music_1'];
  }
  const hasPlannedAudio = mix.narrationIds.length > 0 || mix.dialogueIds.length > 0 || mix.musicCueIds.length > 0;
  mix.nativeTakeAudio = takes.map((take) => ({
    takeId: take.id,
    treatment: hasPlannedAudio ? 'duck' : take.nativeAudioPresent ? 'keep' : 'mute',
  }));
}

export function soundMixSourceSummary(mix: SoundMix): string {
  const kept = mix.nativeTakeAudio.filter((item) => item.treatment === 'keep').map((item) => item.takeId);
  const muted = mix.nativeTakeAudio.filter((item) => item.treatment === 'mute').map((item) => item.takeId);
  const replaced = mix.nativeTakeAudio
    .filter((item) => item.treatment === 'replace' || item.treatment === 'duck')
    .map((item) => `${item.takeId}:${item.treatment}`);
  const parts: string[] = [];

  if (kept.length > 0) parts.push(`native selected take audio: ${kept.join(', ')}`);
  if (muted.length > 0) parts.push(`silent fallback for takes without native audio: ${muted.join(', ')}`);
  if (replaced.length > 0) parts.push(`native take audio treatments: ${replaced.join(', ')}`);
  parts.push(`narration: ${mix.narrationIds.length > 0 ? mix.narrationIds.join(', ') : 'none'}`);
  parts.push(`dialogue: ${mix.dialogueIds.length > 0 ? mix.dialogueIds.join(', ') : 'none'}`);
  parts.push(`music: ${mix.musicCueIds.length > 0 ? mix.musicCueIds.join(', ') : 'none'}`);

  return parts.join('; ');
}

function speechSources(
  state: ProductionState,
  mix: SoundMix,
  baseDir: string,
): Array<{ id: string; path: string; startSeconds: number; endSeconds: number }> {
  const wanted = new Set(mix.narrationIds);
  const narration = (state.filmPackage?.narration ?? [])
    .filter((line) => wanted.has(line.id) && line.audioPath)
    .map((line) => ({
      id: line.id,
      path: join(baseDir, line.audioPath as string),
      startSeconds: line.startSeconds,
      endSeconds: line.endSeconds,
    }));
  const wantedDialogue = new Set(mix.dialogueIds ?? []);
  const dialogue = (state.filmPackage?.dialogue ?? [])
    .filter((line) => wantedDialogue.has(line.id) && line.audioPath)
    .map((line) => {
      const timing = timingForShot(state, line.shotId);
      return {
        id: line.id,
        path: join(baseDir, line.audioPath as string),
        startSeconds: line.startSeconds ?? timing.startSeconds + 0.35,
        endSeconds: line.endSeconds ?? timing.endSeconds - 0.25,
      };
    });
  return [...narration, ...dialogue].sort((a, b) => a.startSeconds - b.startSeconds);
}

async function renderSoundMix(input: {
  takePaths: string[];
  speech: Array<{ path: string; startSeconds: number; endSeconds: number }>;
  musicPath?: string;
  durationSeconds: number;
  outputPath: string;
}): Promise<void> {
  if (input.speech.length > 0 || input.musicPath) {
    const tempDir = await mkdtemp(join(tmpdir(), 'showrunner-mix-'));
    const nativePath = join(tempDir, 'native.m4a');
    await renderNativeAudio(input.takePaths, nativePath);
    const speechPath = input.speech.length > 0 ? join(tempDir, 'speech.m4a') : undefined;
    if (speechPath) await renderTimedSpeechTrack(input.speech, input.durationSeconds, speechPath);
    await mixAudioTracks({
      nativePath,
      speechPath,
      musicPath: input.musicPath,
      durationSeconds: input.durationSeconds,
      outputPath: input.outputPath,
    });
    return;
  }

  await renderNativeAudio(input.takePaths, input.outputPath);
}

async function renderNativeAudio(inputPaths: string[], outputPath: string): Promise<void> {
  if (inputPaths.length === 1) {
    if (await hasAudioStream(inputPaths[0])) {
      await runMediaCommand('ffmpeg', [
        '-y',
        '-i', inputPaths[0],
        '-vn',
        '-map', '0:a:0',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        outputPath,
      ]);
      return;
    }
    const duration = await mediaDuration(inputPaths[0]);
    await renderSilence(duration, outputPath);
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'showrunner-audio-'));
  const segmentPaths: string[] = [];
  for (const [index, path] of inputPaths.entries()) {
    const segmentPath = join(tempDir, `audio-${index}.m4a`);
    if (await hasAudioStream(path)) {
      await runMediaCommand('ffmpeg', [
        '-y',
        '-i', path,
        '-vn',
        '-map', '0:a:0',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        segmentPath,
      ]);
    } else {
      await renderSilence(await mediaDuration(path), segmentPath);
    }
    segmentPaths.push(segmentPath);
  }

  const listPath = join(tempDir, 'audio-list.txt');
  await writeFile(listPath, concatList(segmentPaths), 'utf-8');
  await runMediaCommand('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
      outputPath,
  ]);
}

function musicSource(state: ProductionState, mix: SoundMix, baseDir: string): string | undefined {
  const music = state.filmPackage?.music;
  const id = music?.id ?? 'music_1';
  if (!music?.audioPath || !mix.musicCueIds.includes(id)) return undefined;
  return join(baseDir, music.audioPath);
}

function timingForShot(state: ProductionState, shotId: string): { startSeconds: number; endSeconds: number } {
  const shot = state.shots.find((candidate) => candidate.id === shotId);
  if (!shot) return { startSeconds: 0, endSeconds: Math.min(4, state.production.target.runtimeSeconds) };
  const startSeconds = (shot.order - 1) * shot.durationSeconds;
  return { startSeconds, endSeconds: startSeconds + shot.durationSeconds };
}

async function renderTimedSpeechTrack(
  speech: Array<{ path: string; startSeconds: number; endSeconds: number }>,
  durationSeconds: number,
  outputPath: string,
): Promise<void> {
  const args = [
    '-y',
    '-f', 'lavfi',
    '-t', String(Math.max(0.1, durationSeconds)),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  ];
  for (const item of speech) args.push('-i', item.path);

  const delayedLabels = speech.map((item, index) => {
    const delay = Math.max(0, Math.round(item.startSeconds * 1000));
    const label = `n${index}`;
    return `[${index + 1}:a]adelay=${delay}|${delay},volume=1.0[${label}]`;
  });
  const inputs = ['[0:a]', ...speech.map((_, index) => `[n${index}]`)].join('');
  const filter = [
    ...delayedLabels,
    `${inputs}amix=inputs=${speech.length + 1}:duration=first:normalize=0,atrim=duration=${durationSeconds},aresample=48000[out]`,
  ].join(';');

  await runMediaCommand('ffmpeg', [
    ...args,
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ]);
}

async function mixAudioTracks(input: {
  nativePath: string;
  speechPath?: string;
  musicPath?: string;
  durationSeconds: number;
  outputPath: string;
}): Promise<void> {
  const args = ['-y', '-i', input.nativePath];
  let speechInputIndex: number | undefined;
  let musicInputIndex: number | undefined;
  if (input.speechPath) {
    speechInputIndex = args.filter((item) => item === '-i').length;
    args.push('-i', input.speechPath);
  }
  if (input.musicPath) {
    musicInputIndex = args.filter((item) => item === '-i').length;
    args.push('-stream_loop', '-1', '-i', input.musicPath);
  }

  const filters: string[] = ['[0:a]volume=0.10[native]'];
  const labels = ['[native]'];
  if (speechInputIndex !== undefined && musicInputIndex !== undefined) {
    filters.push(`[${speechInputIndex}:a]volume=1.12,asplit=2[speechmix][speechside]`);
    filters.push(`[${musicInputIndex}:a]atrim=duration=${input.durationSeconds},volume=0.20[musicbase]`);
    filters.push('[musicbase][speechside]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=420[duckedmusic]');
    labels.push('[duckedmusic]', '[speechmix]');
  } else {
    if (speechInputIndex !== undefined) {
      filters.push(`[${speechInputIndex}:a]volume=1.08[speech]`);
      labels.push('[speech]');
    }
    if (musicInputIndex !== undefined) {
      filters.push(`[${musicInputIndex}:a]atrim=duration=${input.durationSeconds},volume=0.42[music]`);
      labels.push('[music]');
    }
  }
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,atrim=duration=${input.durationSeconds},aresample=48000[out]`);

  await runMediaCommand('ffmpeg', [
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map', '[out]',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    input.outputPath,
  ]);
}

async function renderExport(inputPaths: string[], mixPath: string | undefined, outputPath: string, title?: string): Promise<void> {
  const videoPath = inputPaths.length === 1 ? inputPaths[0] : await renderVideoConcat(inputPaths);
  const titledVideoPath = title?.trim() ? await renderVideoWithOpeningTitle(videoPath, title.trim()) : videoPath;
  if (mixPath) {
    await runMediaCommand('ffmpeg', [
      '-y',
      '-i', titledVideoPath,
      '-i', mixPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outputPath,
    ]);
    return;
  }

  await runMediaCommand('ffmpeg', [
    '-y',
    '-i', titledVideoPath,
    ...(titledVideoPath !== videoPath ? ['-i', videoPath] : []),
    '-map', '0:v:0',
    '-map', titledVideoPath !== videoPath ? '1:a:0?' : '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ]);
}

async function renderVideoConcat(inputPaths: string[]): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'showrunner-video-'));
  const outputPath = join(tempDir, 'video.mp4');
  const listPath = join(tempDir, 'video-list.txt');
  await writeFile(listPath, concatList(inputPaths), 'utf-8');
  await runMediaCommand('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
  return outputPath;
}

async function renderVideoWithOpeningTitle(videoPath: string, title: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'showrunner-title-'));
  const pngPath = join(tempDir, 'opening-title.png');
  const outputPath = join(tempDir, 'titled-video.mp4');
  await writeFile(pngPath, openingTitlePng(title));
  await runMediaCommand('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-loop', '1',
    '-t', '3.05',
    '-i', pngPath,
    '-filter_complex',
    "[1:v]format=rgba,fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=2.4:d=0.6:alpha=1[title];[0:v][title]overlay=0:0:enable='between(t,0,3.05)',format=yuv420p[v]",
    '-map', '[v]',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
  return outputPath;
}

function openingTitlePng(title: string): Buffer {
  const width = 1080;
  const height = 1920;
  const pixels = Buffer.alloc(width * height * 4);
  const display = title.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ') || 'SHOWRUNNER';
  const scale = Math.max(7, Math.min(11, Math.floor(760 / textUnits(display))));
  const textWidth = textUnits(display) * scale;
  const textHeight = 7 * scale;
  const panelWidth = Math.min(880, textWidth + 118);
  const panelHeight = textHeight + 78;
  const panelX = Math.round((width - panelWidth) / 2);
  const panelY = 118;
  fillRect(pixels, width, panelX, panelY, panelWidth, panelHeight, [5, 5, 6, 118]);
  fillRect(pixels, width, panelX + 58, panelY + 21, panelWidth - 116, 2, [244, 234, 210, 174]);
  fillRect(pixels, width, panelX + 58, panelY + panelHeight - 23, panelWidth - 116, 2, [244, 234, 210, 112]);
  drawText(pixels, width, display, Math.round((width - textWidth) / 2), panelY + Math.round((panelHeight - textHeight) / 2), scale, [244, 234, 210, 232]);
  return pngEncodeRgba(width, height, pixels);
}

function textUnits(text: string): number {
  return [...text].reduce((total, char) => total + (char === ' ' ? 4 : 6), -1);
}

function drawText(
  pixels: Buffer,
  imageWidth: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: [number, number, number, number],
): void {
  let cursor = x;
  for (const char of text) {
    if (char === ' ') {
      cursor += 4 * scale;
      continue;
    }
    const glyph = GLYPHS[char] ?? GLYPHS['?'];
    for (const [row, bits] of glyph.entries()) {
      for (let col = 0; col < bits.length; col += 1) {
        if (bits[col] !== '1') continue;
        fillRect(pixels, imageWidth, cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += 6 * scale;
  }
}

function fillRect(
  pixels: Buffer,
  imageWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number, number],
): void {
  const imageHeight = pixels.length / (imageWidth * 4);
  for (let row = Math.max(0, y); row < Math.min(imageHeight, y + height); row += 1) {
    for (let col = Math.max(0, x); col < Math.min(imageWidth, x + width); col += 1) {
      const offset = (row * imageWidth + col) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}

function pngEncodeRgba(width: number, height: number, pixels: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, row * stride + stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

async function renderSilence(durationSeconds: number, outputPath: string): Promise<void> {
  await runMediaCommand('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(Math.max(0.1, durationSeconds)),
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ]);
}

async function hasAudioStream(path: string): Promise<boolean> {
  const output = await runMediaCommand('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    path,
  ]);
  return output.trim().length > 0;
}

async function mediaDuration(path: string): Promise<number> {
  const output = await runMediaCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    path,
  ]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Cannot determine media duration for ${path}.`);
  return duration;
}

function concatList(paths: string[]): string {
  return paths.map((path) => `file '${path.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`).join('\n') + '\n';
}

function runMediaCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => {
      reject(new Error(`${command} failed to start. Install ffmpeg/ffprobe to render real Showrunner media artifacts. ${err.message}`));
    });
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf-8');
      const err = Buffer.concat(stderr).toString('utf-8');
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(`${command} exited ${code}: ${err || out}`));
    });
  });
}

async function inspectArtifact(
  kind: ArtifactStatus['kind'],
  id: string,
  path: string,
  dir: string,
  note?: string,
): Promise<ArtifactStatus> {
  const absolutePath = join(resolve(dir), path);
  const info = await fileInfo(absolutePath);
  return {
    kind,
    id,
    path,
    absolutePath,
    exists: info.exists,
    sizeBytes: info.sizeBytes,
    note,
  };
}

async function fileInfo(path: string): Promise<{ exists: boolean; sizeBytes?: number }> {
  try {
    const item = await stat(path);
    return { exists: item.isFile(), sizeBytes: item.isFile() ? item.size : undefined };
  } catch {
    return { exists: false };
  }
}

function logOnce(state: ProductionState, message: string): void {
  if (!state.eventLog.includes(message)) state.eventLog.push(message);
  while (state.eventLog.length > 40) state.eventLog.shift();
}
