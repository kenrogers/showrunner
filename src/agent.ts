import { callModel, maxCost, OpenRouter, stepCountIs } from '@openrouter/agent';
import type { AgentConfig } from './config.js';
import { buildTools } from './tools/index.js';
import type { ProductionActivitySink } from './activity.js';

export type AgentEvent =
  | { type: 'text'; delta: string; itemId?: string }
  | { type: 'tool_call'; name: string; callId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; callId: string; output: string }
  | { type: 'server_tool'; name: string; callId: string; status?: string; query?: string; sources?: string[] }
  | { type: 'reasoning'; delta: string; itemId?: string };

export async function runShowrunnerAgent(input: string, options: {
  config: AgentConfig;
  getProductionDir: () => string | undefined;
  setProductionDir: (dir: string) => void;
  threadContext?: string;
  onEvent?: (event: AgentEvent) => void;
  activity?: ProductionActivitySink;
}): Promise<string> {
  if (!options.config.apiKey) throw new Error('OPENROUTER_API_KEY is required for conversational control.');

  const client = new OpenRouter({ apiKey: options.config.apiKey });
  const result = callModel(client, {
    model: options.config.model,
    instructions: [
      'You are the conversational Showrunner Controller for a local AI video-production harness.',
      'The user should be able to interact in natural language. Do not ask them to use slash commands.',
      'Interpret natural-language intent, then use deterministic tools to create, inspect, advance, approve, or render Production State.',
      'Tools are the source of truth. If older persistent context claims a capability is missing but a current tool exists for it, use the current tool.',
      'If there is no active Production and the user describes a video, call showrunner_create_production.',
      'If the user says the current plan or takes are off-brief, incoherent, garbage, unrelated, or need to be fixed/replanned, call showrunner_replan_production before generating more takes.',
      'When creating a Production, let the tool advance through non-paid planning to the first approval gate unless the user only wants a saved shell.',
      'For new or replanned Productions, surface the production process, story treatment, and audio strategy in normal language so the user can steer coherence before paid generation.',
      'If the user asks to continue, proceed, keep going, or run the next step, call showrunner_advance.',
      'If the user asks to finish, complete, render, export, verify, or make the current Production real, call showrunner_finish_production before answering.',
      'If a pending approval exists, do not approve it unless the user clearly says yes, approve, proceed, continue, or otherwise explicitly confirms.',
      'Only submit paid video, image, speech, audio, or music generation after explicit user approval and a budget check. Otherwise preview requests and explain approval requirements.',
      'If the user explicitly approves a paid video budget and asks you to make the whole film or generate the remaining planned clips, call showrunner_generate_remaining_takes instead of making them approve one Take at a time.',
      'If the user explicitly approves a full-production budget and asks to make, finish, export, test, or run the whole Production, call showrunner_run_full_production. This generates missing Reference images first, then real Takes, then finished artifacts.',
      'If the user approves budget to replace specific weak, incoherent, off-brief, or failed Shots, call showrunner_regenerate_shots with those Shot IDs instead of replanning the whole Production.',
      'If the user explicitly approves paid generation and an approved Take exists, call showrunner_generate_approved_take in the same turn.',
      'Never use mock submission for a paid or full-production request. Mock state is only for the throwaway prototype path.',
      'Never claim OpenRouter has no image models from memory. If Reference images are needed, call the current Reference or image-model tools in the current turn.',
      'Never describe an Export, Sound Mix, or media path as a real file unless tool output verifies the artifact exists. Planned state records are not finished files.',
      'Do not invent narration, music, speech, sound effects, or other generated audio assets. Report only the audio sources returned by tools; if generated narration/music is absent, say the Sound Mix used selected Take audio only.',
      'Use web search when the user asks for research, current facts, external resources, creative references, unclear named entities, or anything likely to have changed.',
      'When you use web search, cite the useful source URLs in your response.',
      'Preserve the domain language: Production, Scene, Shot, Take, Selected Take, Assembly, Sound Mix, Export, Final Review.',
      'Use the persistent thread context when it is provided, but answer only the new user message.',
      'Keep responses concise and operational. Report what changed and the next natural thing to do.',
    ].join('\n'),
    input: buildAgentInput(input, options.threadContext),
    tools: buildTools({
      apiKey: options.config.apiKey,
      controllerModel: options.config.model,
      defaultImageModel: options.config.defaultImageModel,
      defaultVideoModel: options.config.defaultVideoModel,
      frameReferenceModel: options.config.frameReferenceModel,
      ttsModel: options.config.ttsModel,
      ttsVoice: options.config.ttsVoice,
      musicModel: options.config.musicModel,
      productionRoot: options.config.productionRoot,
      routingPolicy: options.config.routingPolicy,
      getProductionDir: options.getProductionDir,
      setProductionDir: options.setProductionDir,
      webSearch: {
        enabled: options.config.webSearchEnabled,
        engine: options.config.webSearchEngine,
        maxResults: options.config.webSearchMaxResults,
        maxTotalResults: options.config.webSearchMaxTotalResults,
        searchContextSize: options.config.webSearchContextSize,
      },
      activity: options.activity,
    }),
    stopWhen: [stepCountIs(options.config.maxSteps), maxCost(options.config.maxCost)],
    allowFinalResponse: 'Summarize what changed, any real media generated, artifact paths, cost used, and the next natural action.',
  });

  if (options.onEvent) await streamEvents(result, options.onEvent);
  return await result.getText();
}

function buildAgentInput(input: string, threadContext?: string): string {
  if (!threadContext?.trim()) return input;
  return [
    threadContext.trim(),
    '',
    '## New User Message',
    input,
  ].join('\n');
}

async function streamEvents(result: unknown, onEvent: (event: AgentEvent) => void): Promise<void> {
  const stream = (result as { getItemsStream?: () => AsyncIterable<unknown> }).getItemsStream?.();
  if (!stream) return;

  const textByItem = new Map<string, number>();
  const reasoningByItem = new Map<string, number>();
  const toolArgsByCallId = new Map<string, string>();
  const emittedToolCalls = new Set<string>();
  const callNames = new Map<string, string>();

  for await (const raw of stream) {
    const item = raw as Record<string, unknown>;
    const type = item.type;
    if (type === 'message') {
      const id = String(item.id ?? 'message');
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content
        .map((part) => {
          const p = part as Record<string, unknown>;
          return typeof p.text === 'string' ? p.text : '';
        })
        .join('');
      const prev = textByItem.get(id) ?? 0;
      if (text.length > prev) {
        onEvent({ type: 'text', delta: text.slice(prev), itemId: id });
        textByItem.set(id, text.length);
      }
    } else if (type === 'function_call') {
      const name = String(item.name ?? 'unknown');
      const callId = String(item.callId ?? item.call_id ?? item.id ?? name);
      const argsKey = stringifyOutput(item.arguments ?? '');
      if (toolArgsByCallId.get(callId) === argsKey) continue;
      toolArgsByCallId.set(callId, argsKey);
      callNames.set(callId, name);
      if (item.status === 'completed' || item.arguments) {
        const parsedArgs = parseArgs(item.arguments);
        const emitKey = `${callId}:${name}:${JSON.stringify(parsedArgs)}`;
        if (emittedToolCalls.has(emitKey)) continue;
        emittedToolCalls.add(emitKey);
        onEvent({ type: 'tool_call', name, callId, args: parsedArgs });
      }
    } else if (type === 'function_call_output') {
      const callId = String(item.callId ?? item.call_id ?? item.id ?? 'unknown');
      const name = callNames.get(callId) ?? 'unknown';
      onEvent({ type: 'tool_result', name, callId, output: stringifyOutput(item.output) });
    } else if (type === 'web_search_call' || type === 'openrouter:web_search') {
      const action = objectValue(item.action);
      const sources = Array.isArray(action?.sources)
        ? action.sources.map(sourceUrl).filter((url): url is string => Boolean(url))
        : undefined;
      onEvent({
        type: 'server_tool',
        name: 'web_search',
        callId: String(item.id ?? 'web_search'),
        status: typeof item.status === 'string' ? item.status : undefined,
        query: typeof action?.query === 'string' ? action.query : undefined,
        sources,
      });
    } else if (type === 'reasoning') {
      const id = String(item.id ?? 'reasoning');
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const text = summary
        .map((part) => {
          const p = part as Record<string, unknown>;
          return typeof p.text === 'string' ? p.text : '';
        })
        .join('');
      const prev = reasoningByItem.get(id) ?? 0;
      if (text.length > prev) {
        onEvent({ type: 'reasoning', delta: text.slice(prev), itemId: id });
        reasoningByItem.set(id, text.length);
      }
    }
  }
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sourceUrl(value: unknown): string | undefined {
  const source = objectValue(value);
  return typeof source?.url === 'string' ? source.url : undefined;
}
