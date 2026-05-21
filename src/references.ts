import type { ProductionState, Reference, ReferenceKind, ReferenceSet, Shot } from './domain/schema.js';

export interface ShotReferencePlanInput {
  shotId: string;
  intent: string;
  description?: string;
  continuityCritical: boolean;
}

export interface ReferencePlanInput {
  visualRules: string[];
  shots: ShotReferencePlanInput[];
}

export interface ReferenceReadiness {
  shotId: string;
  requiredReferenceSetIds: string[];
  missingReferenceIds: string[];
  missingRequiredKinds: ReferenceKind[];
  usableReferenceIds: string[];
  ready: boolean;
}

export function rebuildReferenceSets(state: ProductionState, input: ReferencePlanInput): void {
  state.referenceSets = [];
  state.references = [];

  const productionSet = createReferenceSet(state, {
    ownerType: 'production',
    ownerId: state.production.id,
    name: 'Production Continuity Reference Set',
    purpose: 'production_continuity',
    requiredKinds: ['character_sheet', 'environment_plate', 'style_frame'],
  });

  const pack = state.filmPackage;
  createReference(state, productionSet, {
    ownerType: 'production',
    ownerId: state.production.id,
    kind: 'character_sheet',
    description: pack?.visualContinuity.heroIdentity
      ? `Hero character sheet: front, profile, full body, close-up. ${pack.visualContinuity.heroIdentity.continuityPrompt}`
      : pack?.visualContinuity.hero
      ? `Hero character sheet: front, profile, full body, close-up. ${pack.visualContinuity.hero}`
      : 'Main character sheet: front, profile, full body, close-up.',
  });
  if (pack?.visualContinuity.guide) {
    createReference(state, productionSet, {
      ownerType: 'production',
      ownerId: state.production.id,
      kind: 'character_sheet',
      description: `Guide character sheet: front, profile, full body, close-up. ${pack.visualContinuity.guideIdentity?.continuityPrompt ?? pack.visualContinuity.guide}`,
    });
  }
  createReference(state, productionSet, {
    ownerType: 'production',
    ownerId: state.production.id,
    kind: 'environment_plate',
    description: `Environment plate: ${state.scenes.map((scene) => scene.continuity.location).filter(Boolean).join('; ') || state.production.brief}`,
  });
  createReference(state, productionSet, {
    ownerType: 'production',
    ownerId: state.production.id,
    kind: 'style_frame',
    description: input.visualRules.length > 0
      ? `Style frame: ${input.visualRules.join(' ')}`
      : `Style frame for ${state.production.brief}`,
  });
  if ((pack?.visualContinuity.motifs.length ?? 0) > 0) {
    productionSet.requiredKinds = uniqueKinds([...productionSet.requiredKinds, 'prop_scale']);
    createReference(state, productionSet, {
      ownerType: 'production',
      ownerId: state.production.id,
      kind: 'prop_scale',
      description: `Prop and motif scale sheet: ${pack?.visualContinuity.motifs.join(', ')}`,
    });
  }

  for (const shot of state.shots) {
    shot.referenceSetIds = [productionSet.id];
    shot.referenceIds = [...productionSet.referenceIds];
  }

  for (const item of input.shots) {
    const shot = state.shots.find((candidate) => candidate.id === item.shotId);
    if (!shot || !item.continuityCritical) continue;
    const shotSet = createReferenceSet(state, {
      ownerType: 'shot',
      ownerId: shot.id,
      name: `${shot.id} ${item.intent} Reference Set`,
      purpose: 'frame_continuity',
      requiredKinds: ['first_frame'],
    });
    createReference(state, shotSet, {
      ownerType: 'shot',
      ownerId: shot.id,
      kind: 'first_frame',
      description: item.description || `First frame for ${item.intent}: ${shot.promptDraft}`,
    });
    shot.referenceSetIds = uniqueStrings([...shot.referenceSetIds, shotSet.id]);
    shot.referenceIds = uniqueStrings([...shot.referenceIds, ...shotSet.referenceIds]);
  }

  state.nextIds.referenceSet = state.referenceSets.length + 1;
  state.nextIds.reference = state.references.length + 1;
}

export function rebuildReferenceSetsFromCurrentState(state: ProductionState): void {
  rebuildReferenceSets(state, {
    visualRules: visualRulesFromFilmPackage(state),
    shots: state.shots.map((shot) => ({
      shotId: shot.id,
      intent: shot.intent,
      description: firstFrameDescriptionFromShot(state, shot),
      continuityCritical: shot.continuityCritical,
    })),
  });
}

export function ensureReferenceSetsForContinuity(state: ProductionState): void {
  const productionSet = state.referenceSets.find((set) =>
    set.ownerType === 'production' &&
    set.ownerId === state.production.id &&
    set.purpose === 'production_continuity');

  if (productionSet) {
    for (const shot of state.shots) {
      shot.referenceSetIds = uniqueStrings([...(shot.referenceSetIds ?? []), productionSet.id]);
      shot.referenceIds = uniqueStrings([...(shot.referenceIds ?? []), ...productionSet.referenceIds]);
    }
  }

  for (const shot of state.shots.filter((item) => item.continuityCritical)) {
    const existing = state.referenceSets.find((set) => set.ownerType === 'shot' && set.ownerId === shot.id);
    if (existing) {
      shot.referenceSetIds = uniqueStrings([...(shot.referenceSetIds ?? []), existing.id]);
      shot.referenceIds = uniqueStrings([...(shot.referenceIds ?? []), ...existing.referenceIds]);
      continue;
    }
    const set = createReferenceSet(state, {
      ownerType: 'shot',
      ownerId: shot.id,
      name: `${shot.id} ${shot.intent} Reference Set`,
      purpose: 'frame_continuity',
      requiredKinds: ['first_frame'],
    });
    createReference(state, set, {
      ownerType: 'shot',
      ownerId: shot.id,
      kind: 'first_frame',
      description: `First frame for ${shot.intent}: ${shot.promptDraft}`,
    });
    shot.referenceSetIds = uniqueStrings([...(shot.referenceSetIds ?? []), set.id]);
    shot.referenceIds = uniqueStrings([...(shot.referenceIds ?? []), ...set.referenceIds]);
  }
}

function visualRulesFromFilmPackage(state: ProductionState): string[] {
  const continuity = state.filmPackage?.visualContinuity;
  if (!continuity) return [];
  return [
    continuity.hero,
    continuity.guide,
    continuity.wardrobe ? `Wardrobe continuity: ${continuity.wardrobe}.` : undefined,
    `Palette: ${continuity.palette}.`,
    continuity.motifs.length ? `Motifs: ${continuity.motifs.join(', ')}.` : undefined,
    continuity.forbidden.length ? `Keep out of frame: ${continuity.forbidden.join(', ')}.` : undefined,
  ].filter((item): item is string => Boolean(item));
}

function firstFrameDescriptionFromShot(state: ProductionState, shot: Shot): string {
  const continuity = state.filmPackage?.visualContinuity;
  const identity = continuity?.heroIdentity?.continuityPrompt ?? continuity?.hero;
  return [
    `First frame for ${shot.intent}.`,
    identity ? `Hero identity: ${identity}.` : undefined,
    continuity?.guideIdentity?.continuityPrompt ? `Guide identity when visible: ${continuity.guideIdentity.continuityPrompt}.` : undefined,
    `Shot source: ${shot.promptDraft}`,
  ].filter((item): item is string => Boolean(item)).join(' ');
}

export function referenceSetsForShot(state: ProductionState, shot: Shot): ReferenceSet[] {
  const ids = new Set([...(shot.referenceSetIds ?? [])]);
  for (const set of state.referenceSets) {
    if (set.ownerType === 'production' && set.ownerId === state.production.id) ids.add(set.id);
    if (set.ownerType === 'scene' && set.ownerId === shot.sceneId) ids.add(set.id);
    if (set.ownerType === 'shot' && set.ownerId === shot.id) ids.add(set.id);
  }
  return state.referenceSets.filter((set) => ids.has(set.id));
}

export function referencesForShot(state: ProductionState, shot: Shot): Reference[] {
  const ids = new Set<string>();
  for (const set of referenceSetsForShot(state, shot)) {
    for (const id of set.referenceIds) ids.add(id);
  }
  for (const id of shot.referenceIds) ids.add(id);
  return state.references.filter((reference) => ids.has(reference.id));
}

export function referenceReadinessForShot(state: ProductionState, shot: Shot): ReferenceReadiness {
  const sets = referenceSetsForShot(state, shot);
  const refs = referencesForShot(state, shot);
  const usable = refs.filter((reference) => Boolean(reference.path));
  const missingReferenceIds = refs.filter((reference) => !reference.path).map((reference) => reference.id);
  const missingRequiredKinds = uniqueKinds(sets.flatMap((set) =>
    set.requiredKinds.filter((kind) => !refs.some((reference) => reference.kind === kind && Boolean(reference.path)))));

  return {
    shotId: shot.id,
    requiredReferenceSetIds: sets.map((set) => set.id),
    missingReferenceIds,
    missingRequiredKinds,
    usableReferenceIds: usable.map((reference) => reference.id),
    ready: missingRequiredKinds.length === 0,
  };
}

export function missingReferenceAssetsForContinuity(state: ProductionState): Reference[] {
  const wantedIds = new Set<string>();
  for (const shot of state.shots.filter((item) => item.continuityCritical)) {
    for (const reference of referencesForShot(state, shot)) wantedIds.add(reference.id);
  }
  return state.references.filter((reference) => wantedIds.has(reference.id) && !reference.path);
}

function createReferenceSet(
  state: ProductionState,
  input: Omit<ReferenceSet, 'id' | 'referenceIds'>,
): ReferenceSet {
  const set: ReferenceSet = {
    ...input,
    id: `refset_${state.referenceSets.length + 1}`,
    requiredKinds: uniqueKinds(input.requiredKinds),
    referenceIds: [],
  };
  state.referenceSets.push(set);
  return set;
}

function createReference(
  state: ProductionState,
  set: ReferenceSet,
  input: Omit<Reference, 'id' | 'source' | 'referenceSetId'> & { source?: Reference['source'] },
): Reference {
  const reference: Reference = {
    ...input,
    id: `ref_${state.references.length + 1}`,
    referenceSetId: set.id,
    source: input.source ?? 'generated',
  };
  state.references.push(reference);
  set.referenceIds.push(reference.id);
  return reference;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueKinds(values: ReferenceKind[]): ReferenceKind[] {
  return [...new Set(values)];
}
