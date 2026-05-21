import type { ProductionState, Shot } from './domain/schema.js';

export interface ShotPromptComponents {
  subjectMotion: string;
  sceneMotion?: string;
  cameraMotion: string;
  referenceMatch?: string;
  styleDescriptor?: string;
  timing: string;
}

export interface ShotPromptDiagnostics {
  imageBacked: boolean;
  wordCount: number;
  sentenceCount: number;
  violations: string[];
  warnings: string[];
}

export interface CompiledShotPrompt {
  prompt: string;
  components: ShotPromptComponents;
  diagnostics: ShotPromptDiagnostics;
}

export function videoPromptForShot(state: ProductionState, shot: Shot): string {
  return compileShotPrompt(state, shot).prompt;
}

export function compileShotPrompt(state: ProductionState, shot: Shot): CompiledShotPrompt {
  const pack = state.filmPackage;
  const scene = state.scenes.find((item) => item.id === shot.sceneId);
  const imageBacked = shot.referenceIds.length > 0 || state.references.some((ref) => ref.ownerType === 'production' && Boolean(ref.path || ref.description));
  const subjectMotion = subjectMotionOnly(positiveSentence(generalizeSubject(shot.subjectMotion || motionFromDraft(shot.promptDraft), imageBacked)));
  const cameraMotion = positiveSentence(shot.camera || 'locked camera');
  const sceneMotion = sceneMotionFromDraft(shot.promptDraft, subjectMotion, cameraMotion);
  const referenceMatch = referenceMatchForShot(state, imageBacked);
  const styleDescriptor = styleDescriptorForShot(scene?.continuity.style);
  const components: ShotPromptComponents = {
    subjectMotion,
    ...(sceneMotion ? { sceneMotion } : {}),
    cameraMotion,
    ...(referenceMatch ? { referenceMatch } : {}),
    ...(styleDescriptor ? { styleDescriptor } : {}),
    timing: `${shot.durationSeconds}-second single continuous shot`,
  };

  const lines = [
    `Subject motion: ${components.subjectMotion}.`,
    components.sceneMotion ? `Scene motion: ${components.sceneMotion}.` : undefined,
    `Camera motion: ${components.cameraMotion}.`,
    components.referenceMatch ? `Reference match: ${components.referenceMatch}.` : undefined,
    components.styleDescriptor ? `Style: ${components.styleDescriptor}.` : undefined,
    `Timing: ${components.timing}; one clear action and one clear camera move.`,
  ].filter((line): line is string => Boolean(line));

  const prompt = lines.join(' ');
  return {
    prompt,
    components,
    diagnostics: diagnoseMotionPrompt(prompt, { imageBacked, hasFilmPackage: Boolean(pack) }),
  };
}

export function diagnoseMotionPrompt(
  prompt: string,
  options: { imageBacked?: boolean; hasFilmPackage?: boolean } = {},
): ShotPromptDiagnostics {
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const sentenceCount = prompt.split(/[.!?]+/).filter((part) => part.trim()).length;
  const violations: string[] = [];
  const warnings: string[] = [];

  if (negativePhrasingPattern.test(prompt)) violations.push('Motion Prompt uses negative phrasing instead of describing the desired positive action.');
  if (!/\bSubject motion:/i.test(prompt)) violations.push('Motion Prompt is missing Subject motion.');
  if (!/\bCamera motion:/i.test(prompt)) violations.push('Motion Prompt is missing Camera motion.');
  if (wordCount > 110) warnings.push('Motion Prompt is longer than the simple prompt target.');
  if (sentenceCount > 6) warnings.push('Motion Prompt has too many clauses for one short generated Shot.');
  if (options.imageBacked && /same|consistent|continuity lock|wardrobe|no hard hat|hard hat/i.test(prompt)) {
    warnings.push('Image-backed Motion Prompt may be redescribing continuity that should live in References.');
  }
  if (!options.hasFilmPackage) warnings.push('Motion Prompt was compiled without a Film Package.');

  return {
    imageBacked: Boolean(options.imageBacked),
    wordCount,
    sentenceCount,
    violations,
    warnings,
  };
}

const negativePhrasingPattern = /\b(no|not|never|without|avoid|don't|doesn't|do not|shouldn't|must not)\b/i;

function generalizeSubject(input: string, imageBacked: boolean): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (!imageBacked) return normalized;
  return normalized
    .replace(/\ba lone indie software creator in a dark jacket\b/gi, 'the subject')
    .replace(/\bthe indie software creator hero\b/gi, 'the subject')
    .replace(/\bthe software creator\b/gi, 'the subject')
    .replace(/\bsoftware creator\b/gi, 'subject')
    .replace(/\ba calm openrouter wayfinder mentor\b/gi, 'the guide')
    .replace(/\bthe openrouter wayfinder mentor\b/gi, 'the guide')
    .replace(/\bopenrouter wayfinder mentor\b/gi, 'guide')
    .replace(/\bthe wayfinder mentor\b/gi, 'the guide')
    .replace(/\bthe hero\b/gi, 'the subject');
}

function positiveSentence(input: string): string {
  let text = input.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  text = text
    .replace(/\bno camera movement\b/gi, 'locked camera')
    .replace(/\bthe camera does(?:n'?t| not) move\b/gi, 'the camera remains still')
    .replace(/\bno movement\b/gi, 'still subject')
    .replace(/\bno readable text\b/gi, 'abstract nonverbal symbols')
    .replace(/\bwithout readable text\b/gi, 'with abstract nonverbal symbols')
    .replace(/\bno extra speakers\b/gi, 'only the visible subjects move')
    .replace(/\bno random extra protagonist\b/gi, 'the visible subject remains central')
    .replace(/\bno construction imagery\b/gi, 'the studio and route imagery remain central')
    .replace(/\bno logos\b/gi, 'abstract route symbols')
    .replace(/\bavoid\b/gi, 'use')
    .replace(/\bnever\b/gi, 'always');
  text = text.replace(negativePhrasingPattern, '').replace(/\s+/g, ' ').trim();
  return text || 'The subject performs one clear visible action';
}

const visibleActionPattern = /\b(works|edits|starts|tries|sets|clears|clear|pins|pin|places|place|slides|hands|checks|carries|points|catches|assembles|sprints|breathes|looks|rushes|steps|opens|chooses|walks|slams|runs|faces|shares|stands|turns|extends|raises|nods|tracks|moves|glides|screens|rebuilds|delivers|writes)\b/i;

function motionFromDraft(promptDraft: string): string {
  const firstAction = promptDraft.split('.').find((part) => visibleActionPattern.test(part));
  return firstAction?.trim() ?? 'The subject performs one clear visible action';
}

function sceneMotionFromDraft(promptDraft: string, subjectMotion: string, cameraMotion: string): string | undefined {
  const candidate = promptDraft.split('.')
    .map((part) => part.trim())
    .map((part) => positiveSentence(generalizeSubject(part, true)))
    .find((part) => {
      const lower = part.toLowerCase();
      const subject = subjectMotion.toLowerCase();
      const camera = cameraMotion.toLowerCase();
      return part &&
        lower !== subject &&
        lower !== camera &&
        !lower.includes(subject) &&
        !lower.startsWith('camera ') &&
        !lower.startsWith('the camera ') &&
        /\b(dust|rain|light|glow|meters?|tokens?|storm|sparks|smoke|wind|surface|reflection|corridor|map|paths?)\b/i.test(part);
    });
  return candidate;
}

function styleDescriptorForShot(style?: string): string | undefined {
  if (!style) return undefined;
  const compact = positiveSentence(style).split(',').slice(0, 2).join(',').trim();
  return compact || undefined;
}

function referenceMatchForShot(state: ProductionState, imageBacked: boolean): string | undefined {
  if (!imageBacked || !state.filmPackage) return undefined;
  const heroName = state.filmPackage.visualContinuity.heroIdentity?.name;
  const guideName = state.filmPackage.visualContinuity.guideIdentity?.name;
  const names = [heroName, guideName].filter(Boolean).join(' and ');
  return names
    ? `follow the first-frame anchor and character sheets for ${names} when visible`
    : 'follow the first-frame anchor and production character sheets when visible';
}

function subjectMotionOnly(input: string): string {
  const parts = input.split(',').map((part) => part.trim()).filter(Boolean);
  const firstAction = parts.find((part) => /\b(subject|guide|woman|man|person|character|maya|creator|engineer)\b/i.test(part) && visibleActionPattern.test(part));
  return firstAction ?? parts[0] ?? input;
}
