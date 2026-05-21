import type { ProductionState } from './domain/schema.js';
import { listModelsByOutputModality, type OpenRouterModel } from './openrouter/api.js';

export type TextModelRole =
  | 'controller'
  | 'producer'
  | 'director'
  | 'cinematographer'
  | 'motion_prompt_writer'
  | 'scriptwriter'
  | 'reviewer'
  | 'compactor';

export interface RoleModelSelection {
  role: TextModelRole;
  model: string;
  source: 'state' | 'env' | 'frontier' | 'fallback';
  candidates: string[];
  warning?: string;
}

const FRONTIER_TEXT_MODELS = [
  'openai/gpt-5.5',
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.4',
  'anthropic/claude-sonnet-4.6',
];

const ROLE_PREFERENCES: Record<TextModelRole, string[]> = {
  controller: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
  producer: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6'],
  director: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6'],
  cinematographer: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6'],
  motion_prompt_writer: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6'],
  scriptwriter: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.6'],
  reviewer: ['anthropic/claude-opus-4.7', 'openai/gpt-5.5', 'anthropic/claude-sonnet-4.6'],
  compactor: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.5', 'anthropic/claude-opus-4.7'],
};

export async function selectTextModelForRole(input: {
  role: TextModelRole;
  apiKey?: string;
  state?: ProductionState;
  fallbackModel: string;
}): Promise<RoleModelSelection> {
  const stateModel = input.state?.production.routing.roles?.[input.role]?.model;
  const envModel = envModelForRole(input.role);
  const candidates = modelCandidatesForRole(input.role, input.fallbackModel, stateModel, envModel);

  if (!input.apiKey) {
    return {
      role: input.role,
      model: stateModel ?? envModel ?? input.fallbackModel,
      source: stateModel ? 'state' : envModel ? 'env' : 'fallback',
      candidates,
      warning: 'OpenRouter API key missing; skipped runtime model discovery.',
    };
  }

  try {
    const models = await listModelsByOutputModality('text', input.apiKey);
    return chooseTextModelForRole({
      role: input.role,
      models,
      fallbackModel: input.fallbackModel,
      stateModel,
      envModel,
    });
  } catch (err) {
    return {
      role: input.role,
      model: stateModel ?? envModel ?? input.fallbackModel,
      source: stateModel ? 'state' : envModel ? 'env' : 'fallback',
      candidates,
      warning: `OpenRouter model discovery failed: ${(err as Error).message}`,
    };
  }
}

export function chooseTextModelForRole(input: {
  role: TextModelRole;
  models: Pick<OpenRouterModel, 'id'>[];
  fallbackModel: string;
  stateModel?: string;
  envModel?: string;
}): RoleModelSelection {
  const available = new Set(input.models.map((model) => model.id));
  const candidates = modelCandidatesForRole(input.role, input.fallbackModel, input.stateModel, input.envModel);
  const stateModel = input.stateModel && modelAvailable(input.stateModel, available) ? input.stateModel : undefined;
  if (stateModel) return { role: input.role, model: stateModel, source: 'state', candidates };

  const envModel = input.envModel && modelAvailable(input.envModel, available) ? input.envModel : undefined;
  if (envModel) return { role: input.role, model: envModel, source: 'env', candidates };

  const frontier = candidates.find((candidate) => modelAvailable(candidate, available));
  if (frontier) return { role: input.role, model: frontier, source: 'frontier', candidates };

  return {
    role: input.role,
    model: input.fallbackModel,
    source: 'fallback',
    candidates,
    warning: `No preferred ${input.role} model was available; using ${input.fallbackModel}.`,
  };
}

export function recordRoleModel(state: ProductionState, selection: RoleModelSelection): void {
  state.production.routing.roles ??= {};
  state.production.routing.roles[selection.role] = { model: selection.model };
  if (selection.warning) state.eventLog.push(`${selection.role} model routing warning: ${selection.warning}`);
  state.eventLog.push(`Routed ${selection.role} role to ${selection.model} (${selection.source}).`);
}

function modelCandidatesForRole(
  role: TextModelRole,
  fallbackModel: string,
  stateModel?: string,
  envModel?: string,
): string[] {
  const configuredFrontier = listFromEnv('SHOWRUNNER_FRONTIER_TEXT_MODELS');
  return unique([
    stateModel,
    envModel,
    ...configuredFrontier,
    ...ROLE_PREFERENCES[role],
    ...FRONTIER_TEXT_MODELS,
    fallbackModel,
  ]);
}

function envModelForRole(role: TextModelRole): string | undefined {
  return process.env[`SHOWRUNNER_${role.toUpperCase()}_MODEL`]?.trim()
    || process.env.SHOWRUNNER_FRONTIER_TEXT_MODEL?.trim()
    || undefined;
}

function listFromEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function modelAvailable(model: string, available: Set<string>): boolean {
  return model === 'openrouter/auto' || available.has(model);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
