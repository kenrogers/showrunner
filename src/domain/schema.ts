import { z } from 'zod';

export const StageSchema = z.enum([
  'brief',
  'scene_plan',
  'shot_plan',
  'references',
  'takes',
  'take_reviews',
  'selected_takes',
  'assembly',
  'sound_mix',
  'export',
  'final_review',
  'complete',
]);

export const STAGES = StageSchema.options;

export const RoutingPolicySchema = z.enum(['best_quality', 'balanced', 'budget_aware']);

export const ProductionSchema = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string(),
  stage: StageSchema,
  target: z.object({
    platform: z.string().optional(),
    aspectRatio: z.enum(['16:9', '9:16', '1:1']),
    runtimeSeconds: z.number(),
    format: z.literal('mp4'),
  }),
  budgetGuardrail: z.object({
    maxUsd: z.number(),
    approvalThresholdUsd: z.number(),
    spentUsd: z.number(),
  }),
  autonomyPolicy: z.object({
    enabled: z.boolean(),
    maxUsd: z.number(),
    maxTakesPerShot: z.number(),
    allowedModels: z.array(z.string()).optional(),
    finalReviewThreshold: z.enum(['pass', 'pass_with_minor_issues']),
  }),
  routing: z.object({
    policy: RoutingPolicySchema,
    roles: z.record(z.string(), z.object({ model: z.string() })).optional(),
    modalities: z.record(z.string(), z.object({ preferredModels: z.array(z.string()) })).optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const SceneSchema = z.object({
  id: z.string(),
  productionId: z.string(),
  order: z.number(),
  title: z.string(),
  purpose: z.string(),
  continuity: z.object({
    location: z.string().optional(),
    characters: z.array(z.string()).optional(),
    style: z.string().optional(),
    lighting: z.string().optional(),
    emotionalBeat: z.string().optional(),
    audioIntent: z.string().optional(),
  }),
  musicCueIds: z.array(z.string()),
});

export const ShotSchema = z.object({
  id: z.string(),
  sceneId: z.string(),
  order: z.number(),
  intent: z.string(),
  durationSeconds: z.number(),
  promptDraft: z.string(),
  camera: z.string(),
  subjectMotion: z.string(),
  continuityCritical: z.boolean(),
  referenceSetIds: z.array(z.string()).default([]),
  referenceIds: z.array(z.string()),
  selectedTakeId: z.string().optional(),
  status: z.enum(['planned', 'previewed', 'approved', 'rendering', 'needs_review', 'reviewed', 'selected', 'needs_fix']),
});

export const ReferenceKindSchema = z.enum([
  'character_sheet',
  'wardrobe_sheet',
  'prop_scale',
  'environment_plate',
  'style_frame',
  'first_frame',
  'last_frame',
  'return_frame',
]);

export const ReferenceSetPurposeSchema = z.enum([
  'production_continuity',
  'character_continuity',
  'shot_continuity',
  'environment_continuity',
  'prop_continuity',
  'frame_continuity',
]);

export const ReferenceSetSchema = z.object({
  id: z.string(),
  ownerType: z.enum(['production', 'scene', 'shot']),
  ownerId: z.string(),
  name: z.string(),
  purpose: ReferenceSetPurposeSchema,
  requiredKinds: z.array(ReferenceKindSchema),
  referenceIds: z.array(z.string()),
});

export const ReferenceSchema = z.object({
  id: z.string(),
  ownerType: z.enum(['production', 'scene', 'shot']),
  ownerId: z.string(),
  referenceSetId: z.string().optional(),
  kind: ReferenceKindSchema.default('style_frame'),
  source: z.enum(['user', 'generated']),
  description: z.string(),
  path: z.string().optional(),
});

export const TakeSchema = z.object({
  id: z.string(),
  shotId: z.string(),
  model: z.string(),
  request: z.unknown(),
  jobId: z.string().optional(),
  generationId: z.string().optional(),
  status: z.enum(['previewed', 'approved', 'pending', 'in_progress', 'completed', 'failed', 'rejected', 'reviewed']),
  mediaPath: z.string().optional(),
  nativeAudio: z.object({
    present: z.boolean(),
    extractedPath: z.string().optional(),
    intendedUse: z.enum(['keep', 'mute', 'duck', 'replace', 'undecided']),
  }).optional(),
  costUsd: z.number().optional(),
  createdAt: z.string(),
});

export const FinishedShotSchema = z.object({
  id: z.string(),
  shotId: z.string(),
  takeId: z.string(),
  sourcePath: z.string(),
  outputPath: z.string(),
  status: z.enum(['planned', 'completed', 'failed']),
  pipeline: z.object({
    upscale: z.boolean(),
    cleanup: z.boolean(),
    grain: z.boolean(),
    targetResolution: z.enum(['source', '1080p', '4k']),
    frameRate: z.number().optional(),
    adapter: z.string(),
  }),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});

export const TakeReviewSchema = z.object({
  id: z.string(),
  takeId: z.string(),
  reviewer: z.enum(['media', 'visual', 'story', 'audio', 'provenance', 'human', 'layered']),
  verdict: z.enum(['pass', 'needs_fix', 'reject']),
  findings: z.array(z.string()),
  requiredFixes: z.array(z.string()),
  optionalImprovements: z.array(z.string()),
});

export const ApprovalSchema = z.object({
  id: z.string(),
  kind: z.enum(['paid_generation', 'selected_take', 'export', 'final_review']),
  status: z.enum(['pending', 'approved', 'cancelled', 'superseded']),
  subjectId: z.string(),
  costUsd: z.number().optional(),
  reason: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});

export const AssemblySchema = z.object({
  id: z.string(),
  productionId: z.string(),
  selectedTakeIds: z.array(z.string()),
  timeline: z.array(z.object({
    takeId: z.string(),
    startSeconds: z.number(),
    endSeconds: z.number(),
    transition: z.enum(['cut', 'fade']).optional(),
  })),
  soundMixId: z.string().optional(),
});

export const SoundMixSchema = z.object({
  id: z.string(),
  assemblyId: z.string(),
  narrationIds: z.array(z.string()),
  dialogueIds: z.array(z.string()).default([]),
  musicCueIds: z.array(z.string()),
  nativeTakeAudio: z.array(z.object({
    takeId: z.string(),
    treatment: z.enum(['keep', 'mute', 'duck', 'replace']),
  })),
  loudnessTarget: z.string(),
  outputPath: z.string().optional(),
});

export const IdentityLockSchema = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  genderPresentation: z.string().optional(),
  ageRange: z.string().optional(),
  face: z.string().optional(),
  hair: z.string().optional(),
  build: z.string().optional(),
  wardrobe: z.string().optional(),
  continuityPrompt: z.string(),
});

export const VideoKindSchema = z.enum([
  'short_film',
  'music_video',
  'trailer',
  'marketing_video',
  'explainer',
  'documentary',
  'social_clip',
  'other',
]);

export const ProductionProcessSchema = z.object({
  kind: VideoKindSchema,
  primaryGoal: z.string(),
  processSummary: z.string(),
  planningPriorities: z.array(z.string()).default([]),
  requiredCreativeDecisions: z.array(z.string()).default([]),
  requiredAssets: z.array(z.string()).default([]),
  shotDesignRules: z.array(z.string()).default([]),
  audioPlan: z.string(),
  reviewCriteria: z.array(z.string()).default([]),
});

export const StoryTreatmentSchema = z.object({
  format: z.string(),
  storyType: z.string(),
  audiencePromise: z.string(),
  protagonist: z.string(),
  goal: z.string(),
  obstacle: z.string(),
  stakes: z.string(),
  ending: z.string(),
  groundingRules: z.array(z.string()).default([]),
  styleRules: z.array(z.string()).default([]),
});

export const AudioStrategySchema = z.object({
  mode: z.enum(['dialogue_music', 'narration_music', 'music_led', 'hybrid', 'selected_take_audio', 'silent']),
  dialogueApproach: z.string().optional(),
  narrationApproach: z.string().optional(),
  voiceDirection: z.string().optional(),
  speechTagProfile: z.enum(['none', 'brooding_thriller']).optional(),
  musicRequired: z.boolean().default(false),
  musicPrompt: z.string().optional(),
});

export const FilmPackageSchema = z.object({
  productionProcess: ProductionProcessSchema.optional(),
  storyTreatment: StoryTreatmentSchema.optional(),
  audioStrategy: AudioStrategySchema.optional(),
  visualContinuity: z.object({
    hero: z.string(),
    guide: z.string().optional(),
    heroIdentity: IdentityLockSchema.optional(),
    guideIdentity: IdentityLockSchema.optional(),
    wardrobe: z.string().optional(),
    palette: z.string(),
    motifs: z.array(z.string()),
    forbidden: z.array(z.string()),
    promptPrefix: z.string(),
    frameChaining: z.boolean().default(true),
  }),
  narration: z.array(z.object({
    id: z.string(),
    shotId: z.string(),
    text: z.string(),
    voice: z.string().optional(),
    startSeconds: z.number(),
    endSeconds: z.number(),
    audioPath: z.string().optional(),
  })),
  dialogue: z.array(z.object({
    id: z.string(),
    shotId: z.string(),
    character: z.string(),
    text: z.string(),
    voice: z.string().optional(),
    startSeconds: z.number().optional(),
    endSeconds: z.number().optional(),
    audioPath: z.string().optional(),
  })).default([]),
  music: z.object({
    id: z.string().optional(),
    prompt: z.string(),
    required: z.boolean().default(false),
    model: z.string().optional(),
    audioPath: z.string().optional(),
  }).optional(),
});

export const ExportSchema = z.object({
  id: z.string(),
  assemblyId: z.string(),
  path: z.string(),
  format: z.literal('mp4'),
  codec: z.literal('h264'),
  audioCodec: z.literal('aac'),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']),
  captionArtifactIds: z.array(z.string()),
  finalReviewId: z.string().optional(),
});

export const FinalReviewSchema = z.object({
  id: z.string(),
  exportId: z.string().optional(),
  verdict: z.enum(['pass', 'fail']),
  requiredFixes: z.array(z.string()),
  optionalImprovements: z.array(z.string()),
  routedStage: StageSchema.optional(),
});

export const CostEventSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  kind: z.string(),
  costUsd: z.number(),
  createdAt: z.string(),
});

export const ProductionStateSchema = z.object({
  production: ProductionSchema,
  scenes: z.array(SceneSchema),
  shots: z.array(ShotSchema),
  referenceSets: z.array(ReferenceSetSchema).default([]),
  references: z.array(ReferenceSchema),
  takes: z.array(TakeSchema),
  finishedShots: z.array(FinishedShotSchema).default([]),
  takeReviews: z.array(TakeReviewSchema),
  approvals: z.array(ApprovalSchema),
  assemblies: z.array(AssemblySchema),
  soundMixes: z.array(SoundMixSchema),
  filmPackage: FilmPackageSchema.optional(),
  exports: z.array(ExportSchema),
  finalReviews: z.array(FinalReviewSchema),
  costs: z.array(CostEventSchema),
  eventLog: z.array(z.string()),
  nextIds: z.record(z.string(), z.number()),
});

export type Stage = z.infer<typeof StageSchema>;
export type Production = z.infer<typeof ProductionSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;
export type ReferenceSetPurpose = z.infer<typeof ReferenceSetPurposeSchema>;
export type VideoKind = z.infer<typeof VideoKindSchema>;
export type ReferenceSet = z.infer<typeof ReferenceSetSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type Take = z.infer<typeof TakeSchema>;
export type FinishedShot = z.infer<typeof FinishedShotSchema>;
export type TakeReview = z.infer<typeof TakeReviewSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Assembly = z.infer<typeof AssemblySchema>;
export type SoundMix = z.infer<typeof SoundMixSchema>;
export type FilmPackage = z.infer<typeof FilmPackageSchema>;
export type Export = z.infer<typeof ExportSchema>;
export type FinalReview = z.infer<typeof FinalReviewSchema>;
export type ProductionState = z.infer<typeof ProductionStateSchema>;
