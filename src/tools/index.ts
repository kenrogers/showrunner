import { execFile } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { serverTool, tool, type Tool } from '@openrouter/agent';
import { z } from 'zod';
import { inspectArtifacts, materializeProductionArtifacts, soundMixSourceSummary } from '../artifacts.js';
import { advanceDeterministicStages, applyAction, legalActions, nextRecommendedAction, summarizeState } from '../domain/controller.js';
import { createInitialState, loadProductionState, productionDir, saveProductionState } from '../domain/state.js';
import { renderProductionPages } from '../html/render.js';
import {
  applyProductionPlan,
  planProductionWithOpenRouter,
  planSummary,
  refineProductionTextWithOpenRouter,
  type ProductionPlan,
  type TextRefinementResult,
} from '../planning.js';
import type { ProductionState } from '../domain/schema.js';
import {
  downloadVideo,
  generateAudio,
  generateImage,
  listModelsByOutputModality,
  listVideoModels,
  pollVideoJob,
  previewVideoRequest,
  synthesizeSpeech,
  submitVideoJob,
  type OpenRouterModel,
  type VideoJob,
  type VideoModel,
} from '../openrouter/api.js';
import type { RoutingPolicy } from '../config.js';
import { recordModalityModel, selectAudioModel, selectSpeechModel, selectVideoModelForShot } from '../mediaRouting.js';
import { videoPromptForShot } from '../videoPrompt.js';
import { recordRoleModel, selectTextModelForRole, type RoleModelSelection, type TextModelRole } from '../modelRouting.js';
import {
  missingReferenceAssetsForContinuity,
  referenceReadinessForShot,
  rebuildReferenceSetsFromCurrentState,
  referencesForShot,
} from '../references.js';
import { planReferenceImageGeneration } from '../referenceCraft.js';
import type { ProductionActivityInput, ProductionActivitySink } from '../activity.js';

export interface ToolRuntime {
  apiKey: string;
  controllerModel: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  frameReferenceModel?: string;
  ttsModel: string;
  ttsVoice: string;
  musicModel: string;
  productionRoot: string;
  routingPolicy: RoutingPolicy;
  getProductionDir: () => string | undefined;
  setProductionDir: (dir: string) => void;
  webSearch: {
    enabled: boolean;
    engine: 'auto' | 'native' | 'exa' | 'firecrawl' | 'parallel';
    maxResults: number;
    maxTotalResults: number;
    searchContextSize: 'low' | 'medium' | 'high';
  };
  activity?: ProductionActivitySink;
}

const execFileAsync = promisify(execFile);

export interface RegenerateShotsInput {
  shotIds: string[];
  approvedBudgetUsd: number;
  reason?: string;
  model?: string;
  generateAudio: boolean;
  refreshPrompts: boolean;
}

export interface ToolProgressHooks {
  onProgress?: (message: string) => void;
  activity?: ProductionActivitySink;
}

export interface GenerateRemainingTakesInput {
  approvedBudgetUsd: number;
  model?: string;
  generateAudio: boolean;
  maxTakes: number;
}

export interface RunFullProductionInput {
  approvedBudgetUsd: number;
  referenceBudgetUsd?: number;
  imageModel?: string;
  videoModel?: string;
  generateAudio: boolean;
  maxReferences: number;
  maxTakes: number;
}

export function buildTools(runtime: ToolRuntime) {
  const tools: Tool[] = [
    tool({
      name: 'showrunner_create_production',
      description:
        'Create a new Showrunner Production from a natural-language brief. Use this when the user describes a video to make and no active Production exists.',
      inputSchema: z.object({
        brief: z.string().describe('The user-facing natural-language production brief.'),
        title: z.string().optional().describe('Optional short Production title.'),
        advanceToFirstApproval: z.boolean().default(true).describe('Whether to run non-paid planning gates until the first approval or blocker.'),
      }),
      execute: async ({ brief, title, advanceToFirstApproval }) => {
        let state = createInitialState({ brief, title, routingPolicy: runtime.routingPolicy });
        applyBriefConstraints(state, brief);
        emitActivity(runtime, undefined, state, {
          kind: 'run',
          title: 'Planning new Production',
          detail: state.production.title,
          subject: { type: 'Production', id: state.production.id },
        });
        const directorModel = await routeTextModel(runtime, state, 'director');
        emitActivity(runtime, undefined, state, {
          kind: 'model',
          title: 'Routed Director planning',
          model: directorModel.model,
          subject: { type: 'Model', id: directorModel.model },
        });
        const plan = await planProductionWithOpenRouter({
          apiKey: runtime.apiKey,
          model: directorModel.model,
          brief,
          runtimeSeconds: state.production.target.runtimeSeconds,
        });
        applyProductionPlan(state, plan.plan);
        emitActivity(runtime, undefined, state, {
          kind: 'stage',
          title: 'Storyboard plan ready',
          detail: planSummary(plan.plan),
          subject: { type: 'Production', id: state.production.id },
        });
        const refinements = await refineCreativeText(runtime, state);
        rebuildReferenceSetsFromCurrentState(state);
        state.eventLog.push(`Created ${plan.source} storyboard plan${plan.model ? ` with ${plan.model}` : ''}: ${planSummary(plan.plan)}`);
        logTextRefinements(state, refinements);
        if (plan.warning) state.eventLog.push(`Planner fallback warning: ${plan.warning}`);
        const dir = productionDir(runtime.productionRoot, state);
        const messages = [
          'Production created.',
          `Storyboard plan: ${planSummary(plan.plan)}`,
          ...filmPackageDecisionMessages(state),
          ...refinements.map(refinementMessage),
        ];
        if (advanceToFirstApproval) {
          for (let i = 0; i < 10; i++) {
            const action = nextRecommendedAction(state);
            if (!action || action.type === 'approve_pending') break;
            const result = applyAction(state, action);
            state = result.state;
            messages.push(result.message);
            emitActivity(runtime, undefined, state, {
              kind: result.blocked ? 'blocked' : 'stage',
              level: result.blocked ? 'warning' : 'info',
              title: result.message,
            });
            if (result.blocked || state.approvals.some((approval) => approval.status === 'pending')) break;
          }
        }
        await saveProductionState(dir, state);
        await renderProductionPages(state, dir);
        emitActivity(runtime, undefined, state, {
          kind: 'complete',
          level: 'success',
          title: 'Production plan saved',
          detail: dir,
          artifactPath: `${dir}/pages/production.html`,
        });
        runtime.setProductionDir(dir);
        return {
          directory: dir,
          messages,
          planSource: plan.source,
          plannerModel: plan.model,
          roleModels: state.production.routing.roles ?? {},
          textRefinements: refinements,
          planWarning: plan.warning,
          summary: summarizeState(state),
          legalActions: legalActions(state),
        };
      },
    }),
    tool({
      name: 'showrunner_replan_production',
      description:
        'Rebuild the active Production storyboard, shots, references, and video prompts from the brief using the Showrunner planner. Use when the current takes are off-brief, incoherent, garbage, or the user asks to fix/replan/rewrite the production. Existing generated takes are marked rejected and kept on disk for audit.',
      inputSchema: z.object({
        brief: z.string().optional().describe('Optional replacement brief. If omitted, the current Production brief is reused.'),
        discardExistingTakes: z.boolean().default(true).describe('Mark existing takes rejected and reset downstream stages/artifacts.'),
      }),
      execute: async ({ brief, discardExistingTakes }) => {
        const dir = requireProductionDir(runtime);
        const state = await loadProductionState(dir);
        emitActivity(runtime, undefined, state, {
          kind: 'run',
          title: 'Replanning Production',
          detail: brief?.trim() ? 'Using replacement brief.' : 'Using current brief.',
          subject: { type: 'Production', id: state.production.id },
        });
        if (brief?.trim()) {
          state.production.brief = brief.trim();
          state.production.title = brief.trim().slice(0, 60);
          applyBriefConstraints(state, brief);
        }
        if (discardExistingTakes) rejectExistingTakesAndDownstream(state);
        const directorModel = await routeTextModel(runtime, state, 'director');
        emitActivity(runtime, undefined, state, {
          kind: 'model',
          title: 'Routed Director planning',
          model: directorModel.model,
          subject: { type: 'Model', id: directorModel.model },
        });
        const plan = await planProductionWithOpenRouter({
          apiKey: runtime.apiKey,
          model: directorModel.model,
          brief: state.production.brief,
          runtimeSeconds: state.production.target.runtimeSeconds,
        });
        applyProductionPlan(state, plan.plan);
        const refinements = await refineCreativeText(runtime, state);
        rebuildReferenceSetsFromCurrentState(state);
        state.production.stage = 'takes';
        state.eventLog.push(`Replanned Production with ${plan.source} storyboard${plan.model ? ` via ${plan.model}` : ''}: ${planSummary(plan.plan)}`);
        logTextRefinements(state, refinements);
        if (plan.warning) state.eventLog.push(`Planner fallback warning: ${plan.warning}`);
        await saveProductionState(dir, state);
        const pages = await renderProductionPages(state, dir);
        emitActivity(runtime, undefined, state, {
          kind: 'complete',
          level: 'success',
          title: 'Replan saved',
          detail: planSummary(plan.plan),
          artifactPath: pages[0],
        });
        return {
          message: `Replanned Production. ${planSummary(plan.plan)}`,
          decisions: filmPackageDecisionMessages(state),
          directory: dir,
          planSource: plan.source,
          plannerModel: plan.model,
          roleModels: state.production.routing.roles ?? {},
          textRefinements: refinements,
          planWarning: plan.warning,
          summary: summarizeState(state),
          shots: state.shots.map((shot) => ({
            id: shot.id,
            intent: shot.intent,
            durationSeconds: shot.durationSeconds,
            promptDraft: shot.promptDraft,
          })),
          pages,
        };
      },
    }),
    tool({
      name: 'showrunner_status',
      description: 'Read the current Showrunner Production State summary and legal next actions.',
      inputSchema: z.object({}),
      execute: async () => {
        const dir = requireProductionDir(runtime);
        const state = await loadProductionState(dir);
        return {
          summary: summarizeState(state),
          legalActions: legalActions(state),
          roleModels: state.production.routing.roles ?? {},
          artifacts: await inspectArtifacts(state, dir),
          recentEvents: state.eventLog.slice(-8),
        };
      },
    }),
    tool({
      name: 'showrunner_generate_reference_assets',
      description:
        'Generate missing continuity Reference images with OpenRouter image generation under an explicit approved budget. Use before paid video generation for character, setting, product, or style continuity-critical Shots.',
      inputSchema: z.object({
        approvedBudgetUsd: z.number().positive().max(25).describe('The user-approved incremental spend cap for reference image generation.'),
        model: z.string().optional().describe('Optional OpenRouter image model override. Defaults to SHOWRUNNER_DEFAULT_IMAGE_MODEL or a discovered image-output model.'),
        maxReferences: z.number().int().min(1).max(20).default(12).describe('Maximum missing References to generate in this run.'),
      }),
      execute: async ({ approvedBudgetUsd, model, maxReferences }) => {
        const dir = requireProductionDir(runtime);
        const state = await loadProductionState(dir);
        const generated = await ensureReferenceAssets(runtime, dir, state, {
          approvedBudgetUsd,
          model,
          maxReferences,
        });
        await saveProductionState(dir, state);
        const pages = await renderProductionPages(state, dir);
        return {
          message: `Generated ${generated.length} continuity Reference assets.`,
          directory: dir,
          generated,
          summary: summarizeState(state),
          pages,
        };
      },
    }),
    tool({
      name: 'showrunner_run_full_production',
      description:
        'Run a real end-to-end paid Production under an explicit approved budget: generate missing Reference images, generate remaining real video Takes, then finish/export verified artifacts. Use this for full production tests or when the user says to make the whole film for real.',
      inputSchema: z.object({
        approvedBudgetUsd: z.number().positive().max(100).describe('The user-approved incremental spend cap for this full production run.'),
        referenceBudgetUsd: z.number().positive().max(25).optional().describe('Optional spend cap reserved for Reference image generation. Defaults to up to $5 within the total cap.'),
        imageModel: z.string().optional().describe('Optional OpenRouter image model override. Defaults to SHOWRUNNER_DEFAULT_IMAGE_MODEL, usually Recraft.'),
        videoModel: z.string().optional().describe('Optional OpenRouter video model override. Defaults to quality routing, usually Kling v3 Pro.'),
        generateAudio: z.boolean().default(true).describe('Whether to request native model audio when no narration track exists.'),
        maxReferences: z.number().int().min(1).max(20).default(20).describe('Maximum missing References to generate before video.'),
        maxTakes: z.number().int().min(1).max(20).default(20).describe('Maximum Takes to submit in this run.'),
      }),
      execute: async ({ approvedBudgetUsd, referenceBudgetUsd, imageModel, videoModel, generateAudio, maxReferences, maxTakes }) => {
        return runFullProductionWithOpenRouter(runtime, {
          approvedBudgetUsd,
          referenceBudgetUsd,
          imageModel,
          videoModel,
          generateAudio,
          maxReferences,
          maxTakes,
        });
      },
    }),
    tool({
      name: 'showrunner_advance',
      description:
        'Advance the current Production through deterministic stage gates until the next approval, blocker, or completion. Do not use this to approve a pending paid generation unless the user explicitly approved it.',
      inputSchema: z.object({
        maxSteps: z.number().min(1).max(10).default(1).describe('Maximum deterministic stage-gate steps to run.'),
      }),
      execute: async ({ maxSteps }) => {
        const dir = requireProductionDir(runtime);
        let state = await loadProductionState(dir);
        const messages: string[] = [];
        for (let i = 0; i < maxSteps; i++) {
          const action = nextRecommendedAction(state);
          if (!action) {
            messages.push('Production is already complete.');
            break;
          }
          if (action.type === 'approve_pending') {
            messages.push('Pending approval requires explicit user confirmation.');
            break;
          }
          if (action.type === 'submit_take_mock') {
            messages.push('Approved Take requires real paid generation. Use showrunner_generate_approved_take or showrunner_generate_remaining_takes; mock submission is disabled for conversational advance.');
            break;
          }
          const result = applyAction(state, action);
          state = result.state;
          messages.push(result.message);
          if (result.blocked || state.approvals.some((approval) => approval.status === 'pending')) break;
        }
        const artifacts = await materializeProductionArtifacts(state, dir);
        await saveProductionState(dir, state);
        await renderProductionPages(state, dir);
        return {
          messages,
          summary: summarizeState(state),
          legalActions: legalActions(state),
          artifacts,
        };
      },
    }),
    tool({
      name: 'showrunner_approve_pending',
      description:
        'Approve the single pending Showrunner approval gate. Only call when the user clearly approves, accepts, says yes, or tells Showrunner to continue past the pending approval. If the user also asked to generate the approved paid Take, continue by calling showrunner_generate_approved_take in the same turn.',
      inputSchema: z.object({}),
      execute: async () => {
        const dir = requireProductionDir(runtime);
        const state = await loadProductionState(dir);
        const result = applyAction(state, { type: 'approve_pending' });
        await saveProductionState(dir, result.state);
        await renderProductionPages(result.state, dir);
        return { message: result.message, blocked: result.blocked, summary: summarizeState(result.state) };
      },
    }),
    tool({
      name: 'showrunner_generate_approved_take',
      description:
        'Submit the currently approved Take to OpenRouter video generation, poll until completion, download the MP4, update Production State, and render pages. Only use after explicit user approval and when a Take has status approved.',
      inputSchema: z.object({
        model: z.string().optional().describe('Optional OpenRouter video model override. Defaults to quality routing, usually Kling v3 Pro.'),
        generateAudio: z.boolean().default(true).describe('Whether to request native model audio if supported.'),
      }),
      execute: async ({ model, generateAudio }) => {
        const dir = requireProductionDir(runtime);
        const state = await loadProductionState(dir);
        const result = await generateApprovedTake(runtime, dir, state, {
          model,
          generateAudio,
        });

        return {
          message: `Generated ${result.takeId} with ${result.model}.`,
          directory: dir,
          mediaPath: result.mediaPath,
          costUsd: result.costUsd,
          fileSize: result.fileSize,
          summary: summarizeState(result.state),
        };
      },
    }),
    tool({
      name: 'showrunner_generate_remaining_takes',
      description:
        'Generate all remaining planned Takes with OpenRouter video under an explicit approved budget, then advance deterministic review, selection, assembly, sound mix, export, and final review gates. Only use when the user explicitly approves a budget for paid generation.',
      inputSchema: z.object({
        approvedBudgetUsd: z.number().positive().max(100).describe('The user-approved incremental spend cap for this run.'),
        model: z.string().optional().describe('Optional OpenRouter video model override. Defaults to quality routing, usually Kling v3 Pro.'),
        generateAudio: z.boolean().default(true).describe('Whether to request native model audio if supported.'),
        maxTakes: z.number().int().min(1).max(20).default(20).describe('Maximum number of Takes to submit in this batch.'),
      }),
      execute: async ({ approvedBudgetUsd, model, generateAudio, maxTakes }) => {
        return generateRemainingTakesWithOpenRouter(runtime, {
          approvedBudgetUsd,
          model,
          generateAudio,
          maxTakes,
        });
      },
    }),
    tool({
      name: 'showrunner_regenerate_shots',
      description:
        'Replace specific off-brief, incoherent, visually weak, or failed Shots with new paid OpenRouter video Takes under an explicit approved budget. Use this instead of replanning the whole Production when only some selected Takes need repair.',
      inputSchema: z.object({
        shotIds: z.array(z.string()).min(1).max(10).describe('Shot IDs to regenerate, for example ["shot_5", "shot_11"].'),
        approvedBudgetUsd: z.number().positive().max(100).describe('The user-approved incremental spend cap for this repair run.'),
        reason: z.string().optional().describe('Why these shots need replacement. Saved to the event log.'),
        model: z.string().optional().describe('Optional OpenRouter video model override. Defaults to quality routing, usually Kling v3 Pro.'),
        generateAudio: z.boolean().default(true).describe('Whether to request native model audio if supported.'),
        refreshPrompts: z.boolean().default(true).describe('Refresh the target shot prompts from the current planner before regenerating.'),
      }),
      execute: async ({ shotIds, approvedBudgetUsd, reason, model, generateAudio, refreshPrompts }) => {
        return regenerateShotsWithOpenRouter(runtime, {
          shotIds,
          approvedBudgetUsd,
          reason,
          model,
          generateAudio,
          refreshPrompts,
        });
      },
    }),
    tool({
      name: 'showrunner_finish_production',
      description:
        'Render the current Production for real: create the Sound Mix audio file, mux the final MP4 Export, save state, render HTML pages, and verify files on disk. Use this when the user asks to finish, complete, export, render, or verify the Production for real.',
      inputSchema: z.object({}),
      execute: async () => {
        const dir = requireProductionDir(runtime);
        let state = await loadProductionState(dir);
        emitActivity(runtime, undefined, state, {
          kind: 'run',
          title: 'Finishing Production',
          detail: 'Building Sound Mix, Export, and Final Review artifacts.',
          subject: { type: 'Production', id: state.production.id },
        });
        const advanced = advanceDeterministicStages(state, 100);
        state = advanced.state;
        for (const message of advanced.messages) {
          emitActivity(runtime, undefined, state, { kind: 'stage', title: message });
        }
        await ensureFilmAudio(runtime, dir, state);
        const afterAudioAdvanced = advanceDeterministicStages(state, 100);
        state = afterAudioAdvanced.state;
        for (const message of afterAudioAdvanced.messages) {
          emitActivity(runtime, undefined, state, {
            kind: afterAudioAdvanced.blocked ? 'blocked' : 'stage',
            level: afterAudioAdvanced.blocked ? 'warning' : 'info',
            title: message,
          });
        }
        const artifacts = await materializeProductionArtifacts(state, dir);
        await saveProductionState(dir, state);
        const pages = await renderProductionPages(state, dir);
        emitActivity(runtime, undefined, state, {
          kind: 'complete',
          level: afterAudioAdvanced.blocked ? 'warning' : 'success',
          title: afterAudioAdvanced.blocked ? 'Finish paused' : 'Finished production artifacts',
          artifactPath: pages[0],
        });
        const soundMixSources = state.soundMixes.map((mix) => ({
          id: mix.id,
          summary: soundMixSourceSummary(mix),
          nativeTakeAudio: mix.nativeTakeAudio,
          narrationIds: mix.narrationIds,
          musicCueIds: mix.musicCueIds,
        }));
        return {
          message: ['Finished production artifacts.', ...soundMixSources.map((mix) => `${mix.id}: ${mix.summary}.`)].join(' '),
          directory: dir,
          stageMessages: [...advanced.messages, ...afterAudioAdvanced.messages],
          blocked: afterAudioAdvanced.blocked,
          summary: summarizeState(state),
          artifacts,
          soundMixSources,
          pages,
          missingArtifacts: artifacts.filter((artifact) => !artifact.exists),
        };
      },
    }),
    tool({
      name: 'showrunner_render_pages',
      description: 'Render static HTML Production Pages from current Production State, materializing real media artifacts first when Export or Sound Mix records exist.',
      inputSchema: z.object({}),
      execute: async () => {
        const dir = requireProductionDir(runtime);
        const state = await loadProductionState(dir);
        const artifacts = await materializeProductionArtifacts(state, dir);
        await saveProductionState(dir, state);
        return { pages: await renderProductionPages(state, dir), artifacts };
      },
    }),
    tool({
      name: 'openrouter_list_video_models',
      description: 'List currently available OpenRouter video generation models and their key capabilities.',
      inputSchema: z.object({
        limit: z.number().min(1).max(50).default(10),
      }),
      execute: async ({ limit }) => {
        const models = await listVideoModels(runtime.apiKey);
        return {
          count: models.length,
          models: models.slice(0, limit).map((model) => ({
            id: model.id,
            durations: model.supported_durations,
            resolutions: model.supported_resolutions,
            aspectRatios: model.supported_aspect_ratios,
            frameImages: model.supported_frame_images,
            passthrough: model.allowed_passthrough_parameters,
          })),
        };
      },
    }),
    tool({
      name: 'openrouter_list_audio_models',
      description: 'List currently available OpenRouter audio-output models for speech, music, or sound generation scouting.',
      inputSchema: z.object({
        modality: z.enum(['audio', 'speech']).default('audio'),
        limit: z.number().min(1).max(50).default(10),
      }),
      execute: async ({ modality, limit }) => {
        const models = await listModelsByOutputModality(modality, runtime.apiKey);
        return {
          count: models.length,
          models: models.slice(0, limit).map((model) => ({
            id: model.id,
            name: model.name,
            inputModalities: model.input_modalities,
            outputModalities: model.output_modalities,
          })),
        };
      },
    }),
    tool({
      name: 'openrouter_list_image_models',
      description: 'List currently available OpenRouter image-output models, including Recraft options for Reference image generation.',
      inputSchema: z.object({
        limit: z.number().min(1).max(50).default(20),
      }),
      execute: async ({ limit }) => {
        const models = await listModelsByOutputModality('image', runtime.apiKey);
        return {
          count: models.length,
          defaultImageModel: runtime.defaultImageModel,
          frameReferenceModel: runtime.frameReferenceModel,
          models: models.slice(0, limit).map((model) => ({
            id: model.id,
            name: model.name,
            inputModalities: model.input_modalities,
            outputModalities: model.output_modalities,
          })),
        };
      },
    }),
    tool({
      name: 'openrouter_list_role_text_models',
      description: 'Show the currently routed OpenRouter text model for each Showrunner role, including discovered frontier defaults.',
      inputSchema: z.object({}),
      execute: async () => {
        const dir = runtime.getProductionDir();
        const state = dir ? await loadProductionState(dir) : undefined;
        const roles: TextModelRole[] = ['director', 'motion_prompt_writer', 'scriptwriter', 'reviewer', 'controller'];
        const selections: RoleModelSelection[] = [];
        for (const role of roles) {
          selections.push(await selectTextModelForRole({
            role,
            apiKey: runtime.apiKey,
            state,
            fallbackModel: runtime.controllerModel,
          }));
        }
        return {
          selections,
          activeProductionRoleModels: state?.production.routing.roles ?? {},
        };
      },
    }),
    tool({
      name: 'openrouter_preview_video_request',
      description: 'Build a video generation request body for review. This does not submit the paid job.',
      inputSchema: z.object({
        model: z.string(),
        prompt: z.string(),
        durationSeconds: z.number().optional(),
        resolution: z.string().optional(),
        aspectRatio: z.string().optional(),
        generateAudio: z.boolean().optional(),
      }),
      execute: async (input) => ({ request: previewVideoRequest(input) }),
    }),
  ];

  if (runtime.webSearch.enabled) {
    tools.push(serverTool({
      type: 'openrouter:web_search',
      parameters: {
        engine: runtime.webSearch.engine,
        maxResults: runtime.webSearch.maxResults,
        maxTotalResults: runtime.webSearch.maxTotalResults,
        searchContextSize: runtime.webSearch.searchContextSize,
      },
    }));
  }

  return tools;
}

export async function regenerateShotsWithOpenRouter(
  runtime: ToolRuntime,
  input: RegenerateShotsInput,
  hooks: ToolProgressHooks = {},
) {
  const dir = requireProductionDir(runtime);
  let state = await loadProductionState(dir);
  const startSpent = state.production.budgetGuardrail.spentUsd;
  const spendCeiling = Math.min(state.production.budgetGuardrail.maxUsd, startSpent + input.approvedBudgetUsd);
  const targetIds = [...new Set(input.shotIds)];
  const messages: string[] = [];

  assertKnownShots(state, targetIds);
  emitActivity(runtime, hooks, state, {
    kind: 'run',
    title: 'Starting Shot regeneration',
    detail: `Repairing ${targetIds.join(', ')} with a $${input.approvedBudgetUsd.toFixed(2)} cap.`,
    subject: { type: 'Shot', label: targetIds.join(', ') },
  });

  if (input.refreshPrompts) {
    progressActivity(runtime, hooks, state, `Refreshing Motion Prompts`, {
      detail: targetIds.join(', '),
      subject: { type: 'Shot', label: targetIds.join(', ') },
    });
    const directorModel = await routeTextModel(runtime, state, 'director');
    emitActivity(runtime, hooks, state, {
      kind: 'model',
      title: 'Routed Director planning',
      model: directorModel.model,
      subject: { type: 'Model', id: directorModel.model },
    });
    const plan = await planProductionWithOpenRouter({
      apiKey: runtime.apiKey,
      model: directorModel.model,
      brief: state.production.brief,
      runtimeSeconds: state.production.target.runtimeSeconds,
    });
    refreshTargetShotPrompts(state, plan.plan, targetIds);
    const refinements = await refineCreativeText(runtime, state, targetIds);
    logTextRefinements(state, refinements);
    messages.push(`Refreshed ${targetIds.length} Shot prompts from ${plan.source} planner.`);
    messages.push(...refinements.map(refinementMessage));
    if (plan.warning) messages.push(`Planner fallback warning: ${plan.warning}`);
  }

  const rejected = prepareShotRegeneration(state, targetIds, input.reason);
  messages.push(`Rejected ${rejected.length} prior Takes for repair.`);
  progressActivity(runtime, hooks, state, 'Queued paid repair', {
    detail: `Rejected ${rejected.length} prior Takes.`,
    subject: { type: 'Take', label: `${rejected.length} rejected` },
  });
  await saveProductionState(dir, state);
  await renderProductionPages(state, dir);

  const generated: Array<{
    takeId: string;
    shotId: string;
    model: string;
    mediaPath: string;
    costUsd: number;
    fileSize: number;
  }> = [];

  for (let i = 0; i < targetIds.length; i++) {
    if (state.approvals.some((approval) => approval.status === 'pending')) {
      const approved = applyAction(state, { type: 'approve_pending' });
      state = approved.state;
      messages.push(approved.message);
    }

    if (!state.takes.some((take) => take.status === 'approved')) {
      const action = nextRecommendedAction(state);
      if (!action) break;
      if (action.type !== 'preview_take') {
        messages.push(`Stopped before ${action.type}; expected a Take preview step.`);
        break;
      }
      const previewed = applyAction(state, action);
      state = previewed.state;
      messages.push(previewed.message);
    }

    if (state.approvals.some((approval) => approval.status === 'pending')) {
      const approved = applyAction(state, { type: 'approve_pending' });
      state = approved.state;
      messages.push(approved.message);
    }

    const approvedTake = state.takes.find((take) => take.status === 'approved');
    progressActivity(runtime, hooks, state, 'Submitting video Take', {
      detail: approvedTake ? `${approvedTake.id} for ${approvedTake.shotId}` : targetIds[i],
      subject: { type: 'Take', id: approvedTake?.id, label: approvedTake?.shotId ?? targetIds[i] },
      progress: { label: 'repair', current: i + 1, total: targetIds.length },
    });
    const result = await generateApprovedTake(runtime, dir, state, {
      model: input.model,
      generateAudio: input.generateAudio,
      spendCeilingUsd: spendCeiling,
    }, hooks);
    state = result.state;
    generated.push({
      takeId: result.takeId,
      shotId: result.shotId,
      model: result.model,
      mediaPath: result.mediaPath,
      costUsd: result.costUsd,
      fileSize: result.fileSize,
    });
    messages.push(`Regenerated ${result.takeId} for ${result.shotId}.`);
    emitActivity(runtime, hooks, state, {
      kind: 'artifact',
      level: 'success',
      title: 'Downloaded repaired Take',
      detail: `${result.takeId} for ${result.shotId}`,
      subject: { type: 'Take', id: result.takeId, label: result.shotId },
      artifactPath: result.mediaPath,
      costUsd: result.costUsd,
    });
  }

  progressActivity(runtime, hooks, state, 'Rebuilding Assembly, Sound Mix, Export, and Final Review');
  const advanced = advanceDeterministicStages(state, 100);
  state = advanced.state;
  messages.push(...advanced.messages);
  await ensureFilmAudio(runtime, dir, state, hooks);
  const afterAudioAdvanced = advanceDeterministicStages(state, 100);
  state = afterAudioAdvanced.state;
  messages.push(...afterAudioAdvanced.messages);
  const artifacts = await materializeProductionArtifacts(state, dir);
  await saveProductionState(dir, state);
  const pages = await renderProductionPages(state, dir);

  return {
    message: `Regenerated ${generated.length}/${targetIds.length} Shots within approved $${input.approvedBudgetUsd.toFixed(2)} repair cap.`,
    directory: dir,
    reason: input.reason,
    spendThisRunUsd: state.production.budgetGuardrail.spentUsd - startSpent,
    spendCeilingUsd: spendCeiling,
    rejected,
    generated,
    messages,
    blocked: afterAudioAdvanced.blocked,
    summary: summarizeState(state),
    artifacts,
    pages,
  };
}

export async function runFullProductionWithOpenRouter(
  runtime: ToolRuntime,
  input: RunFullProductionInput,
  hooks: ToolProgressHooks = {},
) {
  const dir = requireProductionDir(runtime);
  let state = await loadProductionState(dir);
  const startSpent = state.production.budgetGuardrail.spentUsd;
  const totalCeiling = Math.min(state.production.budgetGuardrail.maxUsd, startSpent + input.approvedBudgetUsd);
  const referenceBudget = Math.min(
    input.referenceBudgetUsd ?? Math.min(5, input.approvedBudgetUsd),
    Math.max(0, totalCeiling - state.production.budgetGuardrail.spentUsd),
  );

  emitActivity(runtime, hooks, state, {
    kind: 'run',
    title: 'Starting full Production run',
    detail: `Approved cap $${input.approvedBudgetUsd.toFixed(2)}. Reference cap $${referenceBudget.toFixed(2)}.`,
    subject: { type: 'Production', id: state.production.id },
  });
  progressActivity(runtime, hooks, state, 'Generating missing References', {
    detail: `$${referenceBudget.toFixed(2)} Reference cap`,
  });
  const references = referenceBudget > 0
    ? await ensureReferenceAssets(runtime, dir, state, {
      approvedBudgetUsd: referenceBudget,
      model: input.imageModel,
      maxReferences: input.maxReferences,
    }, hooks)
    : [];
  await saveProductionState(dir, state);
  await renderProductionPages(state, dir);

  const afterReferencesSpent = state.production.budgetGuardrail.spentUsd;
  const remainingBudget = totalCeiling - afterReferencesSpent;
  if (remainingBudget <= 0) {
    throw new Error(`Reference generation consumed the approved budget ceiling $${totalCeiling.toFixed(2)} before video generation could start.`);
  }

  progressActivity(runtime, hooks, state, 'Generating remaining Takes', {
    detail: `$${remainingBudget.toFixed(2)} remaining cap`,
    subject: { type: 'Take', label: 'remaining planned Takes' },
  });
  const takeRun = await generateRemainingTakesBatch(runtime, dir, state, {
    approvedBudgetUsd: remainingBudget,
    model: input.videoModel,
    generateAudio: input.generateAudio,
    maxTakes: input.maxTakes,
  }, hooks);

  return {
    message: `Ran full Production within approved $${input.approvedBudgetUsd.toFixed(2)} cap.`,
    directory: dir,
    spendThisRunUsd: takeRun.spendThisRunUsd + (afterReferencesSpent - startSpent),
    spendCeilingUsd: totalCeiling,
    referenceBudgetUsd: referenceBudget,
    references,
    takeRun,
    generated: takeRun.generated,
    messages: [
      `Generated ${references.length} Reference images.`,
      ...takeRun.messages,
    ],
    blocked: takeRun.blocked,
    summary: takeRun.summary,
    artifacts: takeRun.artifacts,
    pages: takeRun.pages,
  };
}

export async function generateRemainingTakesWithOpenRouter(
  runtime: ToolRuntime,
  input: GenerateRemainingTakesInput,
  hooks: ToolProgressHooks = {},
) {
  const dir = requireProductionDir(runtime);
  const state = await loadProductionState(dir);
  return generateRemainingTakesBatch(runtime, dir, state, input, hooks);
}

async function generateRemainingTakesBatch(
  runtime: ToolRuntime,
  dir: string,
  state: ProductionState,
  input: GenerateRemainingTakesInput,
  hooks: ToolProgressHooks = {},
) {
  const startSpent = state.production.budgetGuardrail.spentUsd;
  const spendCeiling = Math.min(state.production.budgetGuardrail.maxUsd, startSpent + input.approvedBudgetUsd);
  const generated: Array<{
    takeId: string;
    shotId: string;
    model: string;
    mediaPath: string;
    costUsd: number;
    fileSize: number;
  }> = [];
  const messages: string[] = [];
  emitActivity(runtime, hooks, state, {
    kind: 'run',
    title: 'Generating planned Takes',
    detail: `Budget ceiling $${spendCeiling.toFixed(2)}.`,
    subject: { type: 'Take', label: 'planned Takes' },
  });

  for (let i = 0; i < input.maxTakes; i++) {
    if (state.production.stage !== 'takes') break;

    if (state.approvals.some((approval) => approval.status === 'pending')) {
      const approved = applyAction(state, { type: 'approve_pending' });
      state = approved.state;
      messages.push(approved.message);
    }

    if (!state.takes.some((take) => take.status === 'approved')) {
      const action = nextRecommendedAction(state);
      if (!action) break;
      if (action.type === 'advance_takes') {
        const advanced = applyAction(state, action);
        state = advanced.state;
        messages.push(advanced.message);
        emitActivity(runtime, hooks, state, {
          kind: 'stage',
          title: advanced.message,
        });
        break;
      }
      if (action.type !== 'preview_take') {
        messages.push(`Stopped before ${action.type}; expected a Take preview step.`);
        break;
      }
      const previewed = applyAction(state, action);
      state = previewed.state;
      messages.push(previewed.message);
      emitActivity(runtime, hooks, state, {
        kind: previewed.blocked ? 'blocked' : 'approval',
        level: previewed.blocked ? 'warning' : 'info',
        title: previewed.message,
      });
    }

    if (state.approvals.some((approval) => approval.status === 'pending')) {
      const approved = applyAction(state, { type: 'approve_pending' });
      state = approved.state;
      messages.push(approved.message);
    }

    const approvedTake = state.takes.find((take) => take.status === 'approved');
    if (approvedTake) {
      progressActivity(runtime, hooks, state, 'Submitting video Take', {
        detail: `${approvedTake.id} for ${approvedTake.shotId}`,
        subject: { type: 'Take', id: approvedTake.id, label: approvedTake.shotId },
        progress: { label: 'Takes', current: generated.length + 1, total: Math.min(input.maxTakes, state.shots.length) },
      });
    }
    const result = await generateApprovedTake(runtime, dir, state, {
      model: input.model,
      generateAudio: input.generateAudio,
      spendCeilingUsd: spendCeiling,
    }, hooks);
    state = result.state;
    generated.push({
      takeId: result.takeId,
      shotId: result.shotId,
      model: result.model,
      mediaPath: result.mediaPath,
      costUsd: result.costUsd,
      fileSize: result.fileSize,
    });
    messages.push(`Generated ${result.takeId} for ${result.shotId}.`);
    emitActivity(runtime, hooks, state, {
      kind: 'artifact',
      level: 'success',
      title: 'Downloaded Take',
      detail: `${result.takeId} for ${result.shotId}`,
      subject: { type: 'Take', id: result.takeId, label: result.shotId },
      artifactPath: result.mediaPath,
      costUsd: result.costUsd,
    });
  }

  progressActivity(runtime, hooks, state, 'Rebuilding Assembly, Sound Mix, Export, and Final Review');
  const advanced = advanceDeterministicStages(state, 100);
  state = advanced.state;
  messages.push(...advanced.messages);
  for (const message of advanced.messages) {
    emitActivity(runtime, hooks, state, { kind: 'stage', title: message });
  }
  await ensureFilmAudio(runtime, dir, state, hooks);
  const afterAudioAdvanced = advanceDeterministicStages(state, 100);
  state = afterAudioAdvanced.state;
  messages.push(...afterAudioAdvanced.messages);
  for (const message of afterAudioAdvanced.messages) {
    emitActivity(runtime, hooks, state, {
      kind: afterAudioAdvanced.blocked ? 'blocked' : 'stage',
      level: afterAudioAdvanced.blocked ? 'warning' : 'info',
      title: message,
    });
  }
  const artifacts = await materializeProductionArtifacts(state, dir);
  await saveProductionState(dir, state);
  const pages = await renderProductionPages(state, dir);
  emitActivity(runtime, hooks, state, {
    kind: 'complete',
    level: afterAudioAdvanced.blocked ? 'warning' : 'success',
    title: afterAudioAdvanced.blocked ? 'Production run paused' : 'Production run complete',
    detail: summarizeState(state).split('\n')[0],
    artifactPath: pages[0],
  });

  return {
    message: `Generated ${generated.length} Takes within approved $${input.approvedBudgetUsd.toFixed(2)} cap.`,
    directory: dir,
    spendThisRunUsd: state.production.budgetGuardrail.spentUsd - startSpent,
    spendCeilingUsd: spendCeiling,
    generated,
    messages,
    blocked: afterAudioAdvanced.blocked,
    summary: summarizeState(state),
    artifacts,
    pages,
  };
}

function requireProductionDir(runtime: ToolRuntime): string {
  const dir = runtime.getProductionDir();
  if (!dir) throw new Error('No active Production. Create or load one first.');
  return dir;
}

function emitActivity(
  runtime: ToolRuntime,
  hooks: ToolProgressHooks | undefined,
  state: ProductionState,
  input: ProductionActivityInput,
): void {
  const event = {
    productionId: state.production.id,
    stage: state.production.stage,
    ...input,
  };
  runtime.activity?.emit(event);
  hooks?.activity?.emit(event);
}

function progressActivity(
  runtime: ToolRuntime,
  hooks: ToolProgressHooks | undefined,
  state: ProductionState,
  title: string,
  input: Omit<ProductionActivityInput, 'title' | 'kind'> = {},
): void {
  hooks?.onProgress?.(input.detail ? `${title}: ${input.detail}` : title);
  emitActivity(runtime, hooks, state, {
    kind: 'progress',
    title,
    ...input,
  });
}

function applyBriefConstraints(state: Awaited<ReturnType<typeof loadProductionState>>, brief: string): void {
  const seconds = brief.match(/\b(\d{1,3})\s*(?:-| )?(?:second|seconds|sec|secs|s)\b/i);
  if (seconds) {
    const runtimeSeconds = Number(seconds[1]);
    if (Number.isFinite(runtimeSeconds) && runtimeSeconds > 0) state.production.target.runtimeSeconds = runtimeSeconds;
  }

  const budget = brief.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*(?:budget|cap|max|maximum)?/i)
    ?? brief.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:dollar|usd)\s*(?:budget|cap|max|maximum)?/i);
  if (budget) {
    const maxUsd = Number(budget[1]);
    if (Number.isFinite(maxUsd) && maxUsd > 0) {
      state.production.budgetGuardrail.maxUsd = maxUsd;
      state.production.budgetGuardrail.approvalThresholdUsd = maxUsd;
      state.production.autonomyPolicy.maxUsd = maxUsd;
    }
  }
}

function rejectExistingTakesAndDownstream(state: Awaited<ReturnType<typeof loadProductionState>>): void {
  for (const take of state.takes) {
    if (['previewed', 'approved', 'pending', 'in_progress', 'completed', 'reviewed'].includes(take.status)) {
      take.status = 'rejected';
    }
  }
  for (const approval of state.approvals) {
    if (approval.status === 'pending') {
      approval.status = 'superseded';
      approval.resolvedAt = new Date().toISOString();
    }
  }
  state.takeReviews = [];
  state.finishedShots = [];
  state.assemblies = [];
  state.soundMixes = [];
  state.exports = [];
  state.finalReviews = [];
  state.eventLog.push('Rejected existing Takes and cleared downstream Finished Shot, Assembly, Sound Mix, Export, and Final Review records for replanning.');
}

async function routeTextModel(
  runtime: ToolRuntime,
  state: ProductionState,
  role: TextModelRole,
): Promise<RoleModelSelection> {
  const selection = await selectTextModelForRole({
    role,
    apiKey: runtime.apiKey,
    state,
    fallbackModel: runtime.controllerModel,
  });
  recordRoleModel(state, selection);
  return selection;
}

async function refineCreativeText(
  runtime: ToolRuntime,
  state: ProductionState,
  shotIds?: string[],
): Promise<TextRefinementResult[]> {
  const motionModel = await routeTextModel(runtime, state, 'motion_prompt_writer');
  const motion = await refineProductionTextWithOpenRouter({
    apiKey: runtime.apiKey,
    model: motionModel.model,
    state,
    scope: 'shots',
    shotIds,
  });

  const scriptModel = await routeTextModel(runtime, state, 'scriptwriter');
  const script = await refineProductionTextWithOpenRouter({
    apiKey: runtime.apiKey,
    model: scriptModel.model,
    state,
    scope: 'script',
    shotIds,
  });

  return [motion, script];
}

function logTextRefinements(state: ProductionState, refinements: TextRefinementResult[]): void {
  for (const refinement of refinements) {
    state.eventLog.push(refinementMessage(refinement));
    if (refinement.warning) state.eventLog.push(`${refinement.scope} refinement warning: ${refinement.warning}`);
  }
}

function refinementMessage(refinement: TextRefinementResult): string {
  if (refinement.source === 'model') {
    return [
      `Refined ${refinement.scope} text with ${refinement.model}`,
      `(${refinement.updatedShots} Shots, ${refinement.updatedNarration} Narration lines, ${refinement.updatedDialogue} Dialogue lines).`,
    ].join(' ');
  }
  return `Skipped ${refinement.scope} text refinement${refinement.model ? ` with ${refinement.model}` : ''}: ${refinement.warning ?? refinement.source}.`;
}

function filmPackageDecisionMessages(state: ProductionState): string[] {
  const process = state.filmPackage?.productionProcess;
  const treatment = state.filmPackage?.storyTreatment;
  const audio = state.filmPackage?.audioStrategy;
  return [
    process ? `Production process: ${process.kind}; goal: ${process.primaryGoal}.` : undefined,
    treatment ? `Treatment: ${treatment.format}; ${treatment.protagonist} wants to ${treatment.goal}; obstacle: ${treatment.obstacle}.` : undefined,
    audio ? `Audio strategy: ${audio.mode}; dialogue ${state.filmPackage?.dialogue.length ?? 0}, narration ${state.filmPackage?.narration.length ?? 0}, music ${audio.musicRequired ? 'required' : 'optional'}.` : undefined,
  ].filter((message): message is string => Boolean(message));
}

function assertKnownShots(state: ProductionState, shotIds: string[]): void {
  const known = new Set(state.shots.map((shot) => shot.id));
  const missing = shotIds.filter((shotId) => !known.has(shotId));
  if (missing.length > 0) throw new Error(`Unknown Shot IDs: ${missing.join(', ')}`);
}

function refreshTargetShotPrompts(state: ProductionState, plan: ProductionPlan, shotIds: string[]): void {
  const targetIds = new Set(shotIds);
  for (const [index, shot] of state.shots.entries()) {
    if (!targetIds.has(shot.id)) continue;
    const planned = plan.shots[index];
    if (!planned) continue;
    shot.intent = planned.intent;
    shot.durationSeconds = planned.durationSeconds;
    shot.promptDraft = planned.promptDraft;
    shot.camera = planned.camera ?? shot.camera;
    shot.subjectMotion = planned.subjectMotion ?? shot.subjectMotion;
    shot.continuityCritical = planned.continuityCritical;
  }
}

function prepareShotRegeneration(state: ProductionState, shotIds: string[], reason?: string): string[] {
  const targetIds = new Set(shotIds);
  const rejected: string[] = [];

  for (const approval of state.approvals) {
    if (approval.status === 'pending') {
      approval.status = 'superseded';
      approval.resolvedAt = new Date().toISOString();
    }
  }

  for (const shot of state.shots) {
    if (!targetIds.has(shot.id)) continue;
    const rejectedForShot: string[] = [];
    for (const take of state.takes.filter((candidate) => candidate.shotId === shot.id && candidate.status !== 'rejected')) {
      take.status = 'rejected';
      rejectedForShot.push(take.id);
      rejected.push(take.id);
    }
    state.takeReviews = state.takeReviews.filter((review) => !rejected.includes(review.takeId));
    state.finishedShots = state.finishedShots.filter((item) => !rejectedForShot.includes(item.takeId));
    shot.selectedTakeId = undefined;
    shot.status = 'needs_fix';
  }

  state.assemblies = [];
  state.soundMixes = [];
  state.exports = [];
  state.finalReviews = [];
  state.production.stage = 'takes';
  state.eventLog.push(`Queued Shot regeneration for ${shotIds.join(', ')}${reason ? `: ${reason}` : '.'}`);
  return rejected;
}

function imageGenerationModalities(model: OpenRouterModel): Array<'image' | 'text'> {
  return model.output_modalities?.includes('text') ? ['image', 'text'] : ['image'];
}

async function ensureReferenceAssets(
  runtime: ToolRuntime,
  dir: string,
  state: ProductionState,
  options: {
    approvedBudgetUsd: number;
    model?: string;
    maxReferences: number;
  },
  hooks: ToolProgressHooks = {},
): Promise<Array<{ id: string; path: string; model: string; costUsd: number }>> {
  if (!runtime.apiKey) throw new Error('Cannot generate Reference assets: OPENROUTER_API_KEY is missing.');
  if (!state.filmPackage) throw new Error('Cannot generate Reference assets before the Film Package exists.');

  const missing = missingReferenceAssetsForContinuity(state).slice(0, options.maxReferences);
  if (missing.length === 0) return [];

  const models = await listModelsByOutputModality('image', runtime.apiKey);
  const estimatedPerImage = Number(process.env.SHOWRUNNER_REFERENCE_IMAGE_ESTIMATE_USD ?? 0.08);
  const startSpent = state.production.budgetGuardrail.spentUsd;
  const spendCeiling = Math.min(state.production.budgetGuardrail.maxUsd, startSpent + options.approvedBudgetUsd);
  const generated: Array<{ id: string; path: string; model: string; costUsd: number }> = [];

  for (const ref of missing) {
    if (state.production.budgetGuardrail.spentUsd + estimatedPerImage > spendCeiling) break;
    const craft = planReferenceImageGeneration({
      state,
      reference: ref,
      models,
      preferredModel: options.model,
      defaultModel: runtime.defaultImageModel,
      frameReferenceModel: runtime.frameReferenceModel,
    });
    const relativePath = join('assets', 'references', `${ref.id}.png`);
    const outputPath = join(dir, relativePath);
    progressActivity(runtime, hooks, state, 'Generating Reference', {
      detail: `${ref.kind} ${ref.id}`,
      subject: { type: 'Reference', id: ref.id, label: ref.kind },
      progress: { label: 'References', current: generated.length + 1, total: missing.length },
      model: craft.model.id,
    });
    const result = await generateImage({
      apiKey: runtime.apiKey,
      model: craft.model.id,
      prompt: craft.prompt,
      outputPath,
      aspectRatio: state.production.target.aspectRatio,
      imageSize: craft.imageSize,
      modalities: imageGenerationModalities(craft.model),
    });
    const costUsd = result.costUsd ?? estimatedPerImage;
    if (state.production.budgetGuardrail.spentUsd + costUsd > spendCeiling) {
      throw new Error(`Reference generation cost $${costUsd.toFixed(4)} would exceed approved reference budget $${options.approvedBudgetUsd.toFixed(2)}.`);
    }
    ref.path = relativePath;
    state.production.budgetGuardrail.spentUsd += costUsd;
    state.costs.push({
      id: `cost_${state.costs.length + 1}`,
      subjectId: ref.id,
      kind: 'reference_image',
      costUsd,
      createdAt: new Date().toISOString(),
    });
    generated.push({ id: ref.id, path: relativePath, model: craft.model.id, costUsd });
    state.eventLog.push(`Generated ${ref.kind} ${ref.id} with ${craft.model.id}: ${craft.selectionReason}.`);
    emitActivity(runtime, hooks, state, {
      kind: 'artifact',
      level: 'success',
      title: 'Reference ready',
      detail: craft.selectionReason,
      subject: { type: 'Reference', id: ref.id, label: ref.kind },
      model: craft.model.id,
      costUsd,
      artifactPath: relativePath,
    });
  }

  if (generated.length > 0) {
    state.eventLog.push(`Generated ${generated.length} continuity Reference assets.`);
  }
  return generated;
}

async function ensureFilmAudio(
  runtime: ToolRuntime,
  dir: string,
  state: ProductionState,
  hooks: ToolProgressHooks = {},
): Promise<void> {
  const pack = state.filmPackage;
  if (!pack) return;
  const speechLines = [
    ...pack.narration.map((line) => ({ kind: 'speech_narration' as const, directory: 'narration', voice: line.voice ?? runtime.ttsVoice, line })),
    ...pack.dialogue.map((line) => ({ kind: 'speech_dialogue' as const, directory: 'dialogue', voice: line.voice ?? runtime.ttsVoice, line })),
  ];
  const missingSpeech = speechLines.filter((item) => !item.line.audioPath);
  const needsMusic = Boolean(pack.music && (pack.music.required || pack.audioStrategy?.musicRequired) && !pack.music.audioPath);
  if (missingSpeech.length === 0 && !needsMusic) return;
  if (!runtime.apiKey && missingSpeech.length > 0) throw new Error('Cannot generate dialogue or narration: OPENROUTER_API_KEY is missing.');

  let generatedSpeech = 0;
  if (missingSpeech.length > 0) {
    let speechModels: OpenRouterModel[] = [];
    try {
      speechModels = await listModelsByOutputModality('speech', runtime.apiKey);
    } catch (err) {
      state.eventLog.push(`speech model routing warning: OpenRouter speech model discovery failed: ${(err as Error).message}`);
    }
    const selection = selectSpeechModel({
      models: speechModels,
      state,
      defaultModel: runtime.ttsModel,
    });
    recordModalityModel(state, 'speech', selection);
    const model = selection.model;
    const speechPricePerTokenUsd = await speechPromptPricePerToken(runtime, model, speechModels);

    for (const item of missingSpeech) {
      const audioPath = join('assets', 'audio', item.directory, `${item.line.id}.mp3`);
      const speechText = speechInputTextForLine(state, model, item.line.id, item.line.text);
      const costUsd = estimateSpeechCost(speechText, speechPricePerTokenUsd);
      if (state.production.budgetGuardrail.spentUsd + costUsd > state.production.budgetGuardrail.maxUsd) {
        throw new Error(`Estimated ${item.kind} cost $${costUsd.toFixed(4)} would exceed budget ceiling $${state.production.budgetGuardrail.maxUsd.toFixed(2)}.`);
      }
      progressActivity(runtime, hooks, state, 'Generating speech', {
        detail: `${item.directory} ${item.line.id}`,
        subject: { type: 'Sound Element', id: item.line.id, label: item.directory },
        model,
        costUsd,
      });
      await synthesizeSpeechWithVoiceFallback({
        apiKey: runtime.apiKey,
        model,
        voice: item.voice,
        fallbackVoice: runtime.ttsVoice,
        text: speechText,
        outputPath: join(dir, audioPath),
      });
      item.line.audioPath = audioPath;
      state.production.budgetGuardrail.spentUsd += costUsd;
      state.costs.push({
        id: `cost_${state.costs.length + 1}`,
        subjectId: item.line.id,
        kind: item.kind,
        costUsd,
        createdAt: new Date().toISOString(),
      });
      emitActivity(runtime, hooks, state, {
        kind: 'artifact',
        level: 'success',
        title: 'Speech ready',
        detail: `${item.directory} ${item.line.id}`,
        subject: { type: 'Sound Element', id: item.line.id, label: item.directory },
        model,
        costUsd,
        artifactPath: audioPath,
      });
      generatedSpeech += 1;
    }
  }

  const generatedMusic = needsMusic ? await ensureFilmMusic(runtime, dir, state, hooks) : false;

  if (generatedSpeech > 0 || generatedMusic) {
    if (generatedSpeech > 0) state.eventLog.push(`Generated ${generatedSpeech} speech clips for narration/dialogue.`);
    await saveProductionState(dir, state);
  }
}

export function speechInputTextForLine(state: ProductionState, model: string, lineId: string, text: string): string {
  const profile = state.filmPackage?.audioStrategy?.speechTagProfile;
  if (!profile || profile === 'none' || !supportsInlineSpeechTags(model) || containsSpeechTags(text)) return text;
  if (profile === 'brooding_thriller') return broodingThrillerSpeechText(lineId, text);
  return text;
}

function supportsInlineSpeechTags(model: string): boolean {
  return /^x-ai\/grok-voice/i.test(model);
}

function containsSpeechTags(text: string): boolean {
  return /(?:\[[a-z-]+\]|<\/?[a-z-]+>)/i.test(text);
}

function broodingThrillerSpeechText(lineId: string, text: string): string {
  const paced = text.trim().replace(/\. (?=[A-Z])/g, '. [pause] ');
  if (lineId === 'narration_8' && /peace maintained/i.test(text)) {
    return '<slow><lower-pitch>Peace maintained... [pause] for now.</lower-pitch></slow>';
  }
  if (/\bI am the Sentinel\.?$/i.test(text.trim())) {
    return '<slow><lower-pitch><emphasis>I am the Sentinel</emphasis></lower-pitch></slow>';
  }
  if (/\b(unknown courier|fast mover|wheels|pattern|intent unknown|leaf crosses)\b/i.test(text)) {
    return `<lower-pitch>${paced}</lower-pitch>`;
  }
  if (/\b(perimeter|careless ones|neighbor retreats|mercy holds)\b/i.test(text)) {
    return `<slow>${paced}</slow>`;
  }
  return paced;
}

async function synthesizeSpeechWithVoiceFallback(input: {
  apiKey: string;
  model: string;
  voice: string;
  fallbackVoice: string;
  text: string;
  outputPath: string;
}): Promise<void> {
  try {
    await synthesizeSpeech(input);
  } catch (err) {
    if (input.voice === input.fallbackVoice) throw err;
    await synthesizeSpeech({ ...input, voice: input.fallbackVoice });
  }
}

async function ensureFilmMusic(
  runtime: ToolRuntime,
  dir: string,
  state: ProductionState,
  hooks: ToolProgressHooks,
): Promise<boolean> {
  const music = state.filmPackage?.music;
  if (!music || music.audioPath) return false;
  const audioPath = join('assets', 'audio', 'music', `${music.id ?? 'music_1'}.wav`);
  const outputPath = join(dir, audioPath);
  const musicEstimate = Number(process.env.SHOWRUNNER_MUSIC_ESTIMATED_COST_USD ?? 0.08);
  if (state.production.budgetGuardrail.spentUsd + musicEstimate > state.production.budgetGuardrail.maxUsd) {
    throw new Error(`Estimated music cost $${musicEstimate.toFixed(4)} would exceed budget ceiling $${state.production.budgetGuardrail.maxUsd.toFixed(2)}.`);
  }

  if (runtime.apiKey) {
    try {
      const audioModels = await listModelsByOutputModality('audio', runtime.apiKey);
      const selection = selectAudioModel({
        models: audioModels,
        state,
        defaultModel: runtime.musicModel,
      });
      recordModalityModel(state, 'audio', selection);
      progressActivity(runtime, hooks, state, 'Generating Music Cue', {
        detail: music.id ?? 'music_1',
        subject: { type: 'Sound Element', id: music.id ?? 'music_1', label: 'Music Cue' },
        model: selection.model,
      });
      const result = await generateAudio({
        apiKey: runtime.apiKey,
        model: selection.model,
        prompt: musicPromptForProduction(state),
        outputPath,
        format: 'wav',
      });
      const costUsd = result.costUsd ?? musicEstimate;
      if (state.production.budgetGuardrail.spentUsd + costUsd > state.production.budgetGuardrail.maxUsd) {
        throw new Error(`Music generation cost $${costUsd.toFixed(4)} would exceed budget ceiling $${state.production.budgetGuardrail.maxUsd.toFixed(2)}.`);
      }
      music.audioPath = audioPath;
      music.model = selection.model;
      state.production.budgetGuardrail.spentUsd += costUsd;
      state.costs.push({
        id: `cost_${state.costs.length + 1}`,
        subjectId: music.id ?? 'music_1',
        kind: 'music_cue',
        costUsd,
        createdAt: new Date().toISOString(),
      });
      state.eventLog.push(`Generated music cue ${music.id ?? 'music_1'} with ${selection.model}.`);
      emitActivity(runtime, hooks, state, {
        kind: 'artifact',
        level: 'success',
        title: 'Music Cue ready',
        detail: music.id ?? 'music_1',
        subject: { type: 'Sound Element', id: music.id ?? 'music_1', label: 'Music Cue' },
        model: selection.model,
        costUsd,
        artifactPath: audioPath,
      });
      return true;
    } catch (err) {
      state.eventLog.push(`Music generation fallback: ${(err as Error).message}`);
    }
  }

  progressActivity(runtime, hooks, state, 'Rendering temporary Music Cue', {
    detail: music.id ?? 'music_1',
    subject: { type: 'Sound Element', id: music.id ?? 'music_1', label: 'Music Cue' },
  });
  await renderProceduralMusic({
    outputPath,
    durationSeconds: state.production.target.runtimeSeconds,
  });
  music.audioPath = audioPath;
  music.model = 'ffmpeg_procedural_score';
  state.costs.push({
    id: `cost_${state.costs.length + 1}`,
    subjectId: music.id ?? 'music_1',
    kind: 'music_cue_fallback',
    costUsd: 0,
    createdAt: new Date().toISOString(),
  });
  state.eventLog.push(`Rendered temporary procedural music cue ${music.id ?? 'music_1'} because OpenRouter audio generation was unavailable.`);
  emitActivity(runtime, hooks, state, {
    kind: 'artifact',
    level: 'success',
    title: 'Temporary Music Cue ready',
    detail: music.id ?? 'music_1',
    subject: { type: 'Sound Element', id: music.id ?? 'music_1', label: 'Music Cue' },
    artifactPath: audioPath,
  });
  return true;
}

function musicPromptForProduction(state: ProductionState): string {
  const treatment = state.filmPackage?.storyTreatment;
  const strategy = state.filmPackage?.audioStrategy;
  const music = state.filmPackage?.music;
  return [
    'Generate a polished instrumental music cue for a short AI film.',
    `Title: ${state.production.title}`,
    `Brief: ${state.production.brief}`,
    treatment ? `Story: ${treatment.storyType}; protagonist ${treatment.protagonist}; goal ${treatment.goal}; obstacle ${treatment.obstacle}; ending ${treatment.ending}.` : undefined,
    strategy?.musicPrompt ? `Score direction: ${strategy.musicPrompt}` : undefined,
    music?.prompt ? `Music brief: ${music.prompt}` : undefined,
    `Runtime target: ${state.production.target.runtimeSeconds} seconds.`,
    'Keep it cinematic, coherent, emotionally supportive, and mixed to sit under dialogue. No vocals unless the brief explicitly asks for singing.',
  ].filter(Boolean).join('\n');
}

async function renderProceduralMusic(input: {
  outputPath: string;
  durationSeconds: number;
}): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  const duration = Math.max(0.5, input.durationSeconds);
  const fadeOutStart = Math.max(0, duration - 2.5);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=110:duration=${duration}:sample_rate=48000`,
    '-f', 'lavfi',
    '-i', `sine=frequency=220:duration=${duration}:sample_rate=48000`,
    '-f', 'lavfi',
    '-i', `anoisesrc=color=pink:duration=${duration}:sample_rate=48000`,
    '-filter_complex',
    `[0:a]volume=0.10[a0];[1:a]volume=0.045[a1];[2:a]volume=0.018,lowpass=f=1800[a2];[a0][a1][a2]amix=inputs=3:duration=first:normalize=0,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutStart}:d=2.5,aresample=48000[out]`,
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    input.outputPath,
  ]);
}

function filmPackageHasExternalAudio(state: ProductionState): boolean {
  return Boolean(
    state.filmPackage?.narration.length ||
    state.filmPackage?.dialogue.length ||
    state.filmPackage?.music?.required,
  );
}

async function speechPromptPricePerToken(runtime: ToolRuntime, modelId: string, discoveredModels?: OpenRouterModel[]): Promise<number> {
  const configured = Number(process.env.SHOWRUNNER_SPEECH_PRICE_PER_TOKEN_USD);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  const discovered = discoveredModels?.find((item) => item.id === modelId);
  const discoveredPrompt = Number(discovered?.pricing?.prompt);
  if (Number.isFinite(discoveredPrompt) && discoveredPrompt >= 0) return discoveredPrompt;
  try {
    const models = await listModelsByOutputModality('speech', runtime.apiKey);
    const model = models.find((item) => item.id === modelId);
    const prompt = Number(model?.pricing?.prompt);
    if (Number.isFinite(prompt) && prompt >= 0) return prompt;
  } catch {
    // Fall through to the default for the current Grok TTS model.
  }
  return 0.000015;
}

function estimateSpeechCost(text: string, pricePerTokenUsd: number): number {
  return Math.ceil(text.length / 4) * pricePerTokenUsd;
}

async function generateApprovedTake(
  runtime: ToolRuntime,
  dir: string,
  state: ProductionState,
  options: {
    model?: string;
    generateAudio: boolean;
    spendCeilingUsd?: number;
  },
  hooks: ToolProgressHooks = {},
): Promise<{
  state: ProductionState;
  takeId: string;
  shotId: string;
  model: string;
  mediaPath: string;
  costUsd: number;
  fileSize: number;
}> {
  if (state.approvals.some((approval) => approval.status === 'pending')) {
    throw new Error('A pending approval still exists. Ask the user to approve before submitting paid generation.');
  }
  const take = state.takes.find((item) => item.status === 'approved');
  if (!take) throw new Error('No approved Take is ready for paid generation.');
  const shot = state.shots.find((item) => item.id === take.shotId);
  if (!shot) throw new Error(`Take ${take.id} is not linked to a Shot.`);

  const models = await listVideoModels(runtime.apiKey);
  const selection = selectVideoModelForShot({
    models,
    state,
    shot,
    preferredModel: options.model,
    defaultModel: runtime.defaultVideoModel,
    resolution: '720p',
  });
  const selectedModel = selection.model;
  recordModalityModel(state, 'video', selection);
  emitActivity(runtime, hooks, state, {
    kind: 'model',
    title: 'Routed video generation',
    detail: selection.reason,
    subject: { type: 'Shot', id: shot.id },
    model: selectedModel.id,
  });
  validateVideoModel(selectedModel, shot.durationSeconds, state.production.target.aspectRatio);
  const generateAudio = filmPackageHasExternalAudio(state) ? false : options.generateAudio;
  const references = await videoReferenceInputsForShot(dir, state, shot, selectedModel);
  preflightPaidVideoRequest(state, shot, selectedModel, references);
  const request = previewVideoRequest({
    model: selectedModel.id,
    prompt: videoPromptForShot(state, shot),
    durationSeconds: shot.durationSeconds,
    resolution: '720p',
    aspectRatio: state.production.target.aspectRatio,
    generateAudio,
    inputReferences: references.inputReferences,
    frameImages: references.frameImages,
    providerOptions: providerOptionsForVideo(selectedModel, state),
  });
  const estimatedCost = estimateVideoCost(selectedModel, {
    durationSeconds: shot.durationSeconds,
    resolution: '720p',
    generateAudio,
  });
  const ceiling = options.spendCeilingUsd ?? state.production.budgetGuardrail.maxUsd;
  const budgetCeiling = Math.min(state.production.budgetGuardrail.maxUsd, ceiling);
  if (state.production.budgetGuardrail.spentUsd + estimatedCost > budgetCeiling) {
    throw new Error(`Estimated cost $${estimatedCost.toFixed(4)} would exceed budget ceiling $${budgetCeiling.toFixed(2)}.`);
  }
  emitActivity(runtime, hooks, state, {
    kind: 'cost',
    title: 'Estimated Take cost',
    detail: `${take.id} for ${shot.id}`,
    subject: { type: 'Take', id: take.id, label: shot.id },
    model: selectedModel.id,
    costUsd: estimatedCost,
  });

  take.model = selectedModel.id;
  take.request = request;
  take.costUsd = estimatedCost;
  take.status = 'pending';
  await saveProductionState(dir, state);

  const submitted = await submitVideoJob(runtime.apiKey, request, true);
  take.jobId = submitted.id;
  take.status = submitted.status === 'failed' ? 'failed' : 'in_progress';
  state.eventLog.push(`Submitted real video job ${submitted.id} for ${take.id}.`);
  emitActivity(runtime, hooks, state, {
    kind: 'progress',
    title: 'Video job submitted',
    detail: submitted.id,
    subject: { type: 'Take', id: take.id, label: shot.id },
    model: selectedModel.id,
  });
  await saveProductionState(dir, state);
  await renderProductionPages(state, dir);

  const completed = await waitForVideo(runtime.apiKey, submitted, (job) => {
    emitActivity(runtime, hooks, state, {
      kind: 'progress',
      title: 'Waiting on video job',
      detail: `${job.id} is ${job.status}`,
      subject: { type: 'Take', id: take.id, label: shot.id },
      model: selectedModel.id,
    });
  });
  if (completed.status !== 'completed') {
    take.status = 'failed';
    take.generationId = completed.generation_id;
    state.eventLog.push(`Video job ${completed.id} failed: ${JSON.stringify(completed.error ?? completed.status)}`);
    emitActivity(runtime, hooks, state, {
      kind: 'blocked',
      level: 'error',
      title: 'Video job failed',
      detail: JSON.stringify(completed.error ?? completed.status),
      subject: { type: 'Take', id: take.id, label: shot.id },
    });
    await saveProductionState(dir, state);
    await renderProductionPages(state, dir);
    throw new Error(`Video job failed: ${JSON.stringify(completed.error ?? completed.status)}`);
  }

  const url = completed.unsigned_urls?.[0];
  if (!url) throw new Error('Completed video job did not include a download URL.');
  const actualCost = completed.usage?.cost ?? estimatedCost;
  if (state.production.budgetGuardrail.spentUsd + actualCost > budgetCeiling) {
    throw new Error(`Actual cost $${actualCost.toFixed(4)} would exceed budget ceiling $${budgetCeiling.toFixed(2)}.`);
  }

  const relativePath = join('assets', 'takes', `${take.id}.mp4`);
  const mediaPath = join(dir, relativePath);
  await mkdir(join(dir, 'assets', 'takes'), { recursive: true });
  await downloadVideo(runtime.apiKey, url, mediaPath);
  const mediaStat = await stat(mediaPath);

  take.status = 'completed';
  take.generationId = completed.generation_id;
  take.mediaPath = relativePath;
  take.nativeAudio = { present: generateAudio, intendedUse: generateAudio ? 'undecided' : 'mute' };
  take.costUsd = actualCost;
  shot.status = 'needs_review';
  state.production.budgetGuardrail.spentUsd += actualCost;
  state.costs.push({
    id: `cost_${state.costs.length + 1}`,
    subjectId: take.id,
    kind: 'video_take',
    costUsd: actualCost,
    createdAt: new Date().toISOString(),
  });
  state.eventLog.push(`Downloaded real video for ${take.id} to ${relativePath}.`);
  emitActivity(runtime, hooks, state, {
    kind: 'artifact',
    level: 'success',
    title: 'Take media ready',
    detail: `${take.id} for ${shot.id}`,
    subject: { type: 'Take', id: take.id, label: shot.id },
    model: selectedModel.id,
    costUsd: actualCost,
    artifactPath: relativePath,
  });
  await saveProductionState(dir, state);
  await renderProductionPages(state, dir);

  return {
    state,
    takeId: take.id,
    shotId: take.shotId,
    model: selectedModel.id,
    mediaPath,
    costUsd: actualCost,
    fileSize: mediaStat.size,
  };
}

async function videoReferenceInputsForShot(
  dir: string,
  state: ProductionState,
  shot: ProductionState['shots'][number],
  model: VideoModel,
): Promise<{
  inputReferences?: Array<{ type: 'image_url'; image_url: { url: string } }>;
  frameImages?: Array<{ type: 'image_url'; image_url: { url: string }; frame_type: 'first_frame' | 'last_frame' }>;
}> {
  const refs = orderedReferencesForVideo(state, shot);
  const urlsById = new Map<string, string>();
  for (const ref of refs) {
    const url = await referenceUrlForVideo(dir, ref.path);
    if (url) urlsById.set(ref.id, url);
  }
  const urls = refs.map((ref) => urlsById.get(ref.id)).filter((url): url is string => Boolean(url));
  const inputReferences = urls.slice(0, 4).map((url) => ({ type: 'image_url' as const, image_url: { url } }));
  const supportsFirstFrame = model.supported_frame_images?.includes('first_frame');
  const firstFrame = refs.find((ref) => ref.kind === 'first_frame' && ref.ownerType === 'shot' && ref.ownerId === shot.id);
  const firstFrameUrl = firstFrame ? urlsById.get(firstFrame.id) : undefined;
  const frameImages = supportsFirstFrame && firstFrameUrl
    ? [{ type: 'image_url' as const, image_url: { url: firstFrameUrl }, frame_type: 'first_frame' as const }]
    : undefined;
  return {
    inputReferences: inputReferences.length > 0 ? inputReferences : undefined,
    frameImages,
  };
}

function orderedReferencesForVideo(state: ProductionState, shot: ProductionState['shots'][number]): ProductionState['references'] {
  const priority: Record<ProductionState['references'][number]['kind'], number> = {
    first_frame: 0,
    character_sheet: 1,
    environment_plate: 2,
    style_frame: 3,
    prop_scale: 4,
    wardrobe_sheet: 5,
    last_frame: 6,
    return_frame: 7,
  };
  return [...referencesForShot(state, shot)]
    .filter((ref) => Boolean(ref.path))
    .filter((ref) => referenceFitsShot(state, shot, ref))
    .sort((a, b) => {
      const aShotOwned = a.ownerType === 'shot' && a.ownerId === shot.id ? 0 : 1;
      const bShotOwned = b.ownerType === 'shot' && b.ownerId === shot.id ? 0 : 1;
      return aShotOwned - bShotOwned || priority[a.kind] - priority[b.kind] || a.id.localeCompare(b.id);
    });
}

function referenceFitsShot(
  state: ProductionState,
  shot: ProductionState['shots'][number],
  ref: ProductionState['references'][number],
): boolean {
  const brief = state.production.brief;
  const dogSentinel = /\bdog|canine\b/i.test(brief) && /\bsentinel|yard|bark|perimeter\b/i.test(brief);
  if (!dogSentinel || ref.ownerType === 'shot') return true;
  const shotText = [shot.intent, shot.promptDraft, shot.subjectMotion].join(' ');
  const shotNeedsLeaf = /\bleaf|leaves\b/i.test(shotText);
  const referenceCarriesLeafMotif = /\bleaf|leaves\b/i.test(ref.description);
  return shotNeedsLeaf || !referenceCarriesLeafMotif;
}

async function referenceUrlForVideo(dir: string, refPath?: string): Promise<string | undefined> {
  if (!refPath) return undefined;
  if (/^https:\/\//i.test(refPath) || /^data:image\//i.test(refPath)) return refPath;
  if (process.env.SHOWRUNNER_ALLOW_LOCAL_REFERENCE_DATA_URL === 'false') return undefined;
  const path = isAbsolute(refPath) ? refPath : join(dir, refPath);
  const bytes = await readFile(path);
  const mime = mimeForImagePath(path);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function mimeForImagePath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function preflightPaidVideoRequest(
  state: ProductionState,
  shot: ProductionState['shots'][number],
  model: VideoModel,
  references: {
    inputReferences?: Array<{ type: 'image_url'; image_url: { url: string } }>;
    frameImages?: Array<{ type: 'image_url'; image_url: { url: string }; frame_type: 'first_frame' | 'last_frame' }>;
  },
): void {
  const failures: string[] = [];
  if (!state.filmPackage) failures.push('missing Film Package continuity bible');
  failures.push(...briefContinuityFailures(state));
  const readiness = referenceReadinessForShot(state, shot);
  if (shot.continuityCritical && state.filmPackage?.visualContinuity.frameChaining && !readiness.ready) {
    failures.push(`missing Reference Set assets: ${readiness.missingRequiredKinds.join(', ')}`);
  }
  const hasUsableReference = Boolean(references.frameImages?.length || references.inputReferences?.length);
  if (shot.continuityCritical && state.filmPackage?.visualContinuity.frameChaining && !hasUsableReference) {
    failures.push('missing usable Reference image asset for a continuity-critical shot');
  }
  if (shot.continuityCritical && state.filmPackage?.visualContinuity.frameChaining && hasUsableReference && !model.supported_frame_images?.includes('first_frame')) {
    state.eventLog.push(`${model.id} does not advertise first-frame support; using Reference images as guidance only for ${shot.id}.`);
  }
  if (failures.length > 0) {
    throw new Error(`Cannot submit paid video for ${shot.id}: ${failures.join('; ')}. Generate or attach Reference assets before spending on video.`);
  }
}

function briefContinuityFailures(state: ProductionState): string[] {
  const brief = state.production.brief;
  const isDogPovSentinel = /\b(dog|dogs|dog's|dogs'|canine|pup|puppy)\b/i.test(brief) &&
    /\b(sentinel|bark|barks|barking|yard|perimeter|guard|protect|neighbors?|delivery|squirrel|threat)\b/i.test(brief) &&
    (/\b(from (?:the )?dog'?s perspective|perspective of (?:the )?dog|dog pov|dog-?pov|narrat(?:e|es|ed|ion).{0,80}\bdog|inner monologue)\b/i.test(brief) || /\bsentinel\b/i.test(brief));
  if (!isDogPovSentinel) return [];

  const pack = state.filmPackage;
  const continuityText = [
    pack?.storyTreatment?.protagonist,
    pack?.storyTreatment?.goal,
    pack?.visualContinuity.hero,
    pack?.visualContinuity.heroIdentity?.continuityPrompt,
    pack?.visualContinuity.promptPrefix,
  ].filter(Boolean).join(' ');
  const failures: string[] = [];
  if (!/\b(dog|canine|Sentinel)\b/i.test(continuityText)) {
    failures.push('brief requires a dog protagonist, but the Film Package does not lock a dog identity');
  }
  if (pack?.audioStrategy?.mode !== 'narration_music') {
    failures.push('brief requires dog-perspective narration, but the Audio Strategy is not narration_music');
  }
  return failures;
}

function providerOptionsForVideo(model: VideoModel, state: ProductionState): Record<string, unknown> | undefined {
  if (!model.allowed_passthrough_parameters?.includes('negativePrompt')) return undefined;
  const forbidden = state.filmPackage?.visualContinuity.forbidden.join(', ')
    || 'random new protagonist, unrelated costume, gibberish text, distorted face, extra fingers';
  return {
    'google-vertex': {
      parameters: {
        negativePrompt: forbidden,
      },
    },
  };
}

function validateVideoModel(model: VideoModel, durationSeconds: number, aspectRatio: string): void {
  if (!model.supported_durations?.includes(durationSeconds)) throw new Error(`${model.id} does not support duration ${durationSeconds}.`);
  if (!model.supported_resolutions?.includes('720p')) throw new Error(`${model.id} does not support 720p.`);
  if (!model.supported_aspect_ratios?.includes(aspectRatio)) throw new Error(`${model.id} does not support aspect ratio ${aspectRatio}.`);
}

function estimateVideoCost(model: VideoModel, input: { durationSeconds: number; resolution: string; generateAudio: boolean }): number {
  const skus = model.pricing_skus ?? {};
  const candidates = Object.entries(skus)
    .map(([sku, price]) => ({ sku, unitPrice: Number(price) }))
    .filter((item) => Number.isFinite(item.unitPrice) && item.unitPrice > 0);

  const resolution = input.resolution.toLowerCase();
  const audio = input.generateAudio ? 'audio' : 'no_audio';
  const exact = candidates.find((item) => item.sku.toLowerCase().includes(resolution) && item.sku.toLowerCase().includes(audio));
  const resolutionOnly = candidates.find((item) => item.sku.toLowerCase().includes(resolution));
  const unitPrice = exact?.unitPrice ?? resolutionOnly?.unitPrice ?? candidates[0]?.unitPrice;
  if (!unitPrice) throw new Error(`Cannot estimate cost for ${model.id}.`);
  return unitPrice * input.durationSeconds;
}

async function waitForVideo(
  apiKey: string,
  submitted: VideoJob,
  onPoll?: (job: VideoJob) => void,
): Promise<VideoJob> {
  const start = Date.now();
  const intervalMs = Number(process.env.SHOWRUNNER_VIDEO_POLL_MS ?? 15000);
  const maxWaitMs = Number(process.env.SHOWRUNNER_VIDEO_MAX_WAIT_MS ?? 900000);
  let latest = submitted;
  while (Date.now() - start < maxWaitMs) {
    if (latest.status === 'completed' || latest.status === 'failed') return latest;
    onPoll?.(latest);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await pollVideoJob(apiKey, latest.polling_url ?? latest.id);
  }
  throw new Error(`Video job ${submitted.id} did not finish within ${Math.round(maxWaitMs / 1000)}s.`);
}
