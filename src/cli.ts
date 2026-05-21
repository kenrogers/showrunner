import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { DEFAULT_SHOWRUNNER_MODEL, loadConfig, type AgentConfig } from './config.js';
import { runShowrunnerAgent, type AgentEvent } from './agent.js';
import { inspectArtifacts, materializeProductionArtifacts } from './artifacts.js';
import { applyAction, legalActions, nextRecommendedAction, summarizeState, type ControllerAction } from './domain/controller.js';
import { createInitialState, loadProductionState, productionDir, saveProductionState } from './domain/state.js';
import type { ProductionState } from './domain/schema.js';
import { renderProductionPages } from './html/render.js';
import { isFreshProductionIntent, isReplanProductionIntent, isShowExistingProductionIntent, resolveFreshProductionBrief } from './intent.js';
import { recordRoleModel, selectTextModelForRole, type RoleModelSelection, type TextModelRole } from './modelRouting.js';
import { getModelContextLength, listModelsByOutputModality, listVideoModels, type OpenRouterModel } from './openrouter/api.js';
import {
  applyProductionPlan,
  planProductionWithOpenRouter,
  planSummary,
  refineProductionTextWithOpenRouter,
  type TextRefinementResult,
} from './planning.js';
import { printBanner, printModelHint, printTryBrief } from './banner.js';
import { detectBg } from './terminal-bg.js';
import { Loader } from './loader.js';
import { TuiRenderer } from './renderer.js';
import { createProductionActivitySink, type ProductionActivitySink } from './activity.js';
import { ProductionConsole } from './production-console.js';
import { rebuildReferenceSetsFromCurrentState } from './references.js';
import { regenerateShotsWithOpenRouter, runFullProductionWithOpenRouter, type ToolRuntime } from './tools/index.js';
import { createSessionLog, type SessionLog } from './session-log.js';
import {
  appendThreadTurn,
  buildThreadContext,
  compactThreadIfNeeded,
  estimateTokens,
  loadThread,
  saveThread,
  summarizeThreadWithOpenRouter,
  threadTokenEstimate,
  updateThreadMeta,
  type CompactThreadResult,
  type ShowrunnerThread,
  type ThreadCompactionPolicy,
} from './thread.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[97m';

interface Runtime {
  config: AgentConfig;
  currentDir: string | undefined;
  state: ProductionState | undefined;
  thread: ShowrunnerThread;
  sessionLog: SessionLog;
  resolvedContextWindowTokens: number | undefined;
  inputBg: string;
  interactive: boolean;
}

async function main() {
  const config = loadConfig();
  const runtime: Runtime = {
    config,
    currentDir: undefined,
    state: undefined,
    thread: await loadThread(config.threadPath),
    sessionLog: await createSessionLog(config),
    resolvedContextWindowTokens: undefined,
    inputBg: '',
    interactive: Boolean(input.isTTY && output.isTTY),
  };

  await hydrateRuntimeFromThread(runtime);
  if (runtime.interactive) runtime.inputBg = await detectBg();
  printBanner(runtime.config);
  printTryBrief();
  printModelHint(runtime.config.model);

  if (!runtime.interactive) {
    const rl = createInterface({ input, output, terminal: false });
    for await (const raw of rl) {
      const shouldContinue = await handleLine(raw, runtime);
      if (!shouldContinue) break;
    }
    return;
  }

  while (true) {
    const raw = await styledReadLine(runtime.inputBg);
    const shouldContinue = await handleLine(raw, runtime);
    if (!shouldContinue) break;
  }
}

async function handleLine(raw: string, runtime: Runtime): Promise<boolean> {
  const line = raw.trim();
  if (!line) return true;

  try {
    await runtime.sessionLog.write('input', {
      line,
      activeProductionDir: runtime.currentDir,
      model: runtime.config.model,
    });
    if (['exit', 'quit', 'q', '/exit', '/quit', '/q'].includes(line.toLowerCase())) return false;
    if (await handleModelIntent(line, runtime)) return true;
    if (await handleContextIntent(line, runtime)) return true;
    if (await handleProductionStatusIntent(line, runtime)) return true;
    if (await handleActivityIntent(line, runtime)) return true;
    if (await handleFullProductionIntent(line, runtime)) return true;
    if (await handleProductionChoiceIntent(line, runtime)) return true;
    if (await handleRegenerateShotsIntent(line, runtime)) return true;
    if (line.startsWith('/')) {
      await dispatchCommand(line.split(' ')[0], line.split(' ').slice(1).join(' ').trim(), runtime);
      return true;
    }

    await maybeAutoCompactThread(runtime, 'pre_turn', false, line);
    const threadContext = buildThreadContext(runtime.thread, {
      activeProductionDir: runtime.currentDir,
      activeProductionState: runtime.state,
    });
    printSubmitStatus(runtime);
    const loader = runtime.interactive ? new Loader() : undefined;
    const renderer = runtime.interactive ? new TuiRenderer() : undefined;
    let seenEvent = false;
    let lastToolResult: Extract<AgentEvent, { type: 'tool_result' }> | undefined;
    const activity = createRuntimeActivity(runtime, {
      onFirstEvent: () => {
        seenEvent = true;
        loader?.stop();
      },
    });
    loader?.start();
    const text = await runShowrunnerAgent(line, {
      config: runtime.config,
      getProductionDir: () => runtime.currentDir,
      setProductionDir: (dir) => { runtime.currentDir = dir; },
      threadContext,
      activity: activity.sink,
      onEvent: renderer ? (event) => {
        void runtime.sessionLog.write('agent_event', event).catch(() => {});
        if (event.type === 'tool_result') lastToolResult = event;
        if (!seenEvent) {
          seenEvent = true;
          loader?.stop();
        }
        renderer.handle(event);
      } : undefined,
    }).finally(() => {
      loader?.stop();
      activity.end();
    });
    renderer?.endTurn();
    const fallbackText = text.trim() ? text : toolOnlySummary(lastToolResult);
    if ((!seenEvent || !text.trim()) && fallbackText.trim()) console.log(`\n${fallbackText}\n`);
    await runtime.sessionLog.write('assistant_output', {
      text: fallbackText,
      activeProductionDir: runtime.currentDir,
      model: runtime.config.model,
    });
    if (runtime.currentDir) runtime.state = await loadProductionState(runtime.currentDir);
    appendThreadTurn(runtime.thread, 'user', line, {
      model: runtime.config.model,
      activeProductionDir: runtime.currentDir,
    });
    appendThreadTurn(runtime.thread, 'assistant', fallbackText,
    {
      model: runtime.config.model,
      activeProductionDir: runtime.currentDir,
    });
    updateThreadMeta(runtime.thread, {
      activeProductionDir: runtime.currentDir,
      model: runtime.config.model,
      contextWindowTokens: runtime.resolvedContextWindowTokens,
    });
    await saveThread(runtime.config.threadPath, runtime.thread);
  } catch (err) {
    await runtime.sessionLog.write('error', {
      message: (err as Error).message,
      stack: (err as Error).stack,
    });
    console.log(`\n${RED}Error:${RESET} ${(err as Error).message}\n`);
  }
  return true;
}

async function handleModelIntent(line: string, runtime: Runtime): Promise<boolean> {
  if (/^(model|models|choose model|switch model)$/i.test(line)) {
    await chooseModel(runtime);
    return true;
  }

  if (/^(what|which).*\bmodel\b/i.test(line) || /^current model\b/i.test(line)) {
    printModelHint(runtime.config.model);
    return true;
  }

  const match = line.match(/^(?:model|use model|switch model to|switch to|set model to|set showrunner model to)\s+([A-Za-z0-9._:/-]+)$/i);
  if (!match) return false;
  await setModel(runtime, match[1]);
  return true;
}

async function handleContextIntent(line: string, runtime: Runtime): Promise<boolean> {
  const normalized = line.toLowerCase();
  const asksForStatus =
    /^(context|thread|memory)\s*(status|stats)?$/.test(normalized) ||
    /^show\s+(context|thread|memory)\s*(status|stats)?$/.test(normalized) ||
    /\bhow\s+(full|much)\b.*\bcontext\b/.test(normalized);
  if (asksForStatus) {
    await printContextStatus(runtime);
    return true;
  }

  const asksForCompaction =
    /^(compact|compress|summarize)\s+(context|thread|memory)$/.test(normalized) ||
    /\b(compact|compress|summarize)\b.*\b(context|thread|memory)\b/.test(normalized);
  if (asksForCompaction) {
    const result = await maybeAutoCompactThread(runtime, 'manual', true);
    if (result.compacted) {
      console.log(`${GREEN}Compacted context:${RESET} ${result.beforeTokens} -> ${result.afterTokens} estimated tokens.`);
    } else {
      console.log(`${YELLOW}Context unchanged:${RESET} not enough middle turns to compact yet.`);
    }
    console.log();
    return true;
  }

  return false;
}

async function handleProductionStatusIntent(line: string, runtime: Runtime): Promise<boolean> {
  const normalized = line.toLowerCase().replace(/[?.!]+$/, '').trim();
  const asksForStatus =
    /^(status|current status|production status|show status|show production status)$/.test(normalized) ||
    /^(what is|what's|show|give me|display)\s+(the\s+)?(current\s+)?production status$/.test(normalized);
  if (!asksForStatus) return false;

  if (!runtime.state && runtime.currentDir) runtime.state = await loadProductionState(runtime.currentDir);
  const current = requireState(runtime.state);
  console.log(summarizeState(current));
  console.log(`${DIM}Legal actions:${RESET} ${legalActions(current).join(', ')}\n`);
  return true;
}

async function handleActivityIntent(line: string, runtime: Runtime): Promise<boolean> {
  const normalized = line.toLowerCase().replace(/[?.!]+$/, '').trim();
  const asksForActivity =
    /^(activity|trace|events|recent events|what happened|what just happened|what is happening|what's happening|what are you doing)$/.test(normalized) ||
    /^(show|display|give me)\s+(the\s+)?(activity|trace|events|recent events)$/.test(normalized) ||
    /^what\s+is\s+showrunner\s+(doing|working on)$/.test(normalized);
  if (!asksForActivity) return false;

  await printActivityReport(runtime);
  return true;
}

async function handleFullProductionIntent(line: string, runtime: Runtime): Promise<boolean> {
  if (!runtime.currentDir) return false;
  const approvedBudgetUsd = parseBudgetUsd(line);
  if (!approvedBudgetUsd) return false;

  const normalized = line.toLowerCase();
  const asksForFullRun =
    /\b(production test|full production|whole film|entire film|everything|all remaining|remaining takes)\b/.test(normalized) ||
    (/\b(generate|make|create|finish|complete|export|run)\b/.test(normalized) && /\b(real|for real|production|takes?|video|film|export)\b/.test(normalized));
  if (!asksForFullRun) return false;

  if (!runtime.state && runtime.currentDir) runtime.state = await loadProductionState(runtime.currentDir);
  const current = requireState(runtime.state);
  const maxUsd = Math.max(current.production.budgetGuardrail.maxUsd, approvedBudgetUsd);
  current.production.budgetGuardrail.maxUsd = maxUsd;
  current.production.budgetGuardrail.approvalThresholdUsd = maxUsd;
  current.production.autonomyPolicy.maxUsd = maxUsd;
  await saveProductionState(requireDir(runtime.currentDir), current);

  console.log(`${GREEN}Full production run approved:${RESET} real Reference images, real Takes, and verified export with a $${approvedBudgetUsd.toFixed(2)} cap.\n`);
  const activity = createRuntimeActivity(runtime);
  const result = await runFullProductionWithOpenRouter(toToolRuntime(runtime), {
    approvedBudgetUsd,
    referenceBudgetUsd: Math.min(5, approvedBudgetUsd),
    imageModel: runtime.config.defaultImageModel,
    videoModel: runtime.config.defaultVideoModel,
    generateAudio: true,
    maxReferences: 20,
    maxTakes: 20,
  }, {
    activity: activity.sink,
  }).finally(() => activity.end());

  runtime.currentDir = result.directory;
  runtime.state = await loadProductionState(result.directory);
  const summary = formatFullProductionResult(result);
  console.log(`\n${summary}\n`);
  await recordDirectTurn(runtime, line, summary);
  return true;
}

async function handleProductionChoiceIntent(line: string, runtime: Runtime): Promise<boolean> {
  if (isFreshProductionIntent(line, runtime.thread)) {
    const brief = resolveFreshProductionBrief({ line, thread: runtime.thread, state: runtime.state });
    if (!brief) {
      console.log(`${YELLOW}Brief needed:${RESET} tell me the production brief to start from.\n`);
      return true;
    }
    const summary = await createFreshProduction(runtime, brief);
    await recordDirectTurn(runtime, line, summary);
    console.log(`\n${summary}\n`);
    return true;
  }

  if (isShowExistingProductionIntent(line)) {
    if (!runtime.state && runtime.currentDir) runtime.state = await loadProductionState(runtime.currentDir);
    const current = requireState(runtime.state);
    const dir = requireDir(runtime.currentDir);
    const pages = await renderProductionPages(current, dir);
    const summary = [
      summarizeState(current),
      `Pages: ${pages.join(', ')}`,
    ].join('\n');
    await recordDirectTurn(runtime, line, summary);
    console.log(`\n${summary}\n`);
    return true;
  }

  if (isReplanProductionIntent(line)) {
    console.log(`${YELLOW}Budget needed:${RESET} tell me the approved regeneration cap, for example "replan with up to $5".\n`);
    return true;
  }

  return false;
}

async function handleRegenerateShotsIntent(line: string, runtime: Runtime): Promise<boolean> {
  const normalized = line.toLowerCase();
  if (!/\b(regenerate|replace|redo|repair|remake|rerender|re-render)\b/.test(normalized)) return false;

  const shotIds = [...new Set(line.match(/\bshot_\d+\b/gi)?.map((shotId) => shotId.toLowerCase()) ?? [])];
  if (shotIds.length === 0) return false;

  const approvedBudgetUsd = parseBudgetUsd(line);
  if (!approvedBudgetUsd) {
    console.log(`${YELLOW}Budget needed:${RESET} tell me the approved repair cap, for example "regenerate ${shotIds.join(', ')} with up to $1".\n`);
    return true;
  }

  if (!runtime.state && runtime.currentDir) runtime.state = await loadProductionState(runtime.currentDir);
  requireState(runtime.state);
  console.log(`${GREEN}Repair approved:${RESET} regenerating ${shotIds.join(', ')} with a $${approvedBudgetUsd.toFixed(2)} cap.\n`);

  const activity = createRuntimeActivity(runtime);
  const result = await regenerateShotsWithOpenRouter(toToolRuntime(runtime), {
    shotIds,
    approvedBudgetUsd,
    reason: line,
    generateAudio: true,
    refreshPrompts: true,
  }, {
    activity: activity.sink,
  }).finally(() => activity.end());

  runtime.currentDir = result.directory;
  runtime.state = await loadProductionState(result.directory);
  const summary = formatGenerationResult(result);
  console.log(`\n${summary}\n`);
  await runtime.sessionLog.write('assistant_output', {
    text: summary,
    activeProductionDir: runtime.currentDir,
    model: runtime.config.model,
  });
  appendThreadTurn(runtime.thread, 'user', line, {
    model: runtime.config.model,
    activeProductionDir: runtime.currentDir,
  });
  appendThreadTurn(runtime.thread, 'assistant', summary, {
    model: runtime.config.model,
    activeProductionDir: runtime.currentDir,
  });
  updateThreadMeta(runtime.thread, {
    activeProductionDir: runtime.currentDir,
    model: runtime.config.model,
    contextWindowTokens: runtime.resolvedContextWindowTokens,
  });
  await saveThread(runtime.config.threadPath, runtime.thread);
  return true;
}

async function chooseModel(runtime: Runtime): Promise<void> {
  console.log(`${BOLD}Choose Showrunner Model${RESET}`);
  console.log(`${DIM}Current:${RESET} ${CYAN}${runtime.config.model}${RESET}`);

  let choices: OpenRouterModel[] = [];
  try {
    const models = await listModelsByOutputModality('text', runtime.config.apiKey);
    choices = preferredModels(models);
  } catch (err) {
    console.log(`${YELLOW}Could not load model list:${RESET} ${(err as Error).message}`);
  }

  const ids = [
    DEFAULT_SHOWRUNNER_MODEL,
    ...choices.map((model) => model.id).filter((id) => id !== DEFAULT_SHOWRUNNER_MODEL && id !== 'openrouter/auto'),
    'openrouter/auto',
  ];
  for (const [index, id] of ids.slice(0, 12).entries()) {
    const current = id === runtime.config.model ? ` ${GREEN}current${RESET}` : '';
    console.log(`  ${CYAN}${String(index + 1).padStart(2, ' ')}${RESET} ${id}${current}`);
  }
  console.log(`${DIM}Paste any OpenRouter model id to use a model not shown.${RESET}`);

  const answer = (await styledReadLine(runtime.inputBg, 'model')).trim();
  if (!answer) return;
  const selected = /^\d+$/.test(answer) ? ids[Number(answer) - 1] : answer;
  if (!selected) {
    console.log(`${YELLOW}No model changed.${RESET}\n`);
    return;
  }
  await setModel(runtime, selected);
}

function preferredModels(models: OpenRouterModel[]): OpenRouterModel[] {
  const patterns = [
    /claude.*sonnet/i,
    /claude.*opus/i,
    /gemini.*3/i,
    /gpt-5/i,
    /grok/i,
    /deepseek/i,
    /kimi/i,
    /qwen/i,
  ];
  const picked = new Map<string, OpenRouterModel>();
  for (const pattern of patterns) {
    const found = models.find((model) => pattern.test(model.id) || pattern.test(model.name ?? ''));
    if (found) picked.set(found.id, found);
  }
  for (const model of models) {
    if (picked.size >= 11) break;
    picked.set(model.id, model);
  }
  return [...picked.values()];
}

async function setModel(runtime: Runtime, model: string): Promise<void> {
  runtime.config = {
    ...runtime.config,
    model,
    compactionModel: process.env.SHOWRUNNER_COMPACTION_MODEL ? runtime.config.compactionModel : model,
    modelSource: 'local',
  };
  updateThreadMeta(runtime.thread, { model });
  await saveThread(runtime.config.threadPath, runtime.thread);
  await mkdir('.showrunner', { recursive: true });
  await writeFile('.showrunner/config.json', `${JSON.stringify({ model }, null, 2)}\n`);
  console.log(`${GREEN}Model set:${RESET} ${CYAN}${model}${RESET}`);
  if (process.env.SHOWRUNNER_MODEL || process.env.AGENT_MODEL) {
    console.log(`${YELLOW}Note:${RESET} your model env var will still win on the next launch.`);
  }
  console.log();
}

function parseBudgetUsd(line: string): number | undefined {
  const money = line.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
    ?? line.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd)\b/i);
  if (money) {
    const value = Number(money[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  const wordMoney = line.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:dollars?|usd)\b/i);
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return wordMoney ? words[wordMoney[1].toLowerCase()] : undefined;
}

function applyBriefConstraints(state: ProductionState, brief: string): void {
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

function toToolRuntime(runtime: Runtime): ToolRuntime {
  return {
    apiKey: runtime.config.apiKey,
    controllerModel: runtime.config.model,
    defaultImageModel: runtime.config.defaultImageModel,
    defaultVideoModel: runtime.config.defaultVideoModel,
    frameReferenceModel: runtime.config.frameReferenceModel,
    ttsModel: runtime.config.ttsModel,
    ttsVoice: runtime.config.ttsVoice,
    musicModel: runtime.config.musicModel,
    productionRoot: runtime.config.productionRoot,
    routingPolicy: runtime.config.routingPolicy,
    getProductionDir: () => runtime.currentDir,
    setProductionDir: (dir) => { runtime.currentDir = dir; },
    webSearch: {
      enabled: runtime.config.webSearchEnabled,
      engine: runtime.config.webSearchEngine,
      maxResults: runtime.config.webSearchMaxResults,
      maxTotalResults: runtime.config.webSearchMaxTotalResults,
      searchContextSize: runtime.config.webSearchContextSize,
    },
  };
}

function formatGenerationResult(result: Awaited<ReturnType<typeof regenerateShotsWithOpenRouter>>): string {
  const rows = result.generated.map((take) => `- ${take.takeId} (${take.shotId}): ${take.mediaPath}`);
  const artifacts = result.artifacts
    .filter((artifact) => artifact.exists && artifact.kind !== 'take')
    .map((artifact) => `- ${artifact.kind} ${artifact.id}: ${artifact.path}`);
  return [
    result.message,
    `Spend this run: $${result.spendThisRunUsd.toFixed(2)}`,
    `Directory: ${result.directory}`,
    ...rows,
    ...artifacts,
  ].join('\n');
}

function formatFullProductionResult(result: Awaited<ReturnType<typeof runFullProductionWithOpenRouter>>): string {
  const refs = result.references.map((ref) => `- reference ${ref.id}: ${ref.path} (${ref.model}, $${ref.costUsd.toFixed(2)})`);
  const takes = result.generated.map((take) => `- ${take.takeId} (${take.shotId}): ${take.mediaPath} (${take.model}, $${take.costUsd.toFixed(2)})`);
  const artifacts = result.artifacts
    .filter((artifact) => artifact.exists && artifact.kind !== 'take')
    .map((artifact) => `- ${artifact.kind} ${artifact.id}: ${artifact.path}`);
  return [
    result.message,
    `Spend this run: $${result.spendThisRunUsd.toFixed(2)} / $${result.spendCeilingUsd.toFixed(2)} ceiling`,
    `Directory: ${result.directory}`,
    `References: ${result.references.length}`,
    ...refs.slice(0, 6),
    refs.length > 6 ? `... ${refs.length - 6} more references` : '',
    `Takes: ${result.generated.length}`,
    ...takes.slice(0, 8),
    takes.length > 8 ? `... ${takes.length - 8} more takes` : '',
    ...artifacts,
    result.summary,
  ].filter(Boolean).join('\n');
}

async function createFreshProduction(runtime: Runtime, brief: string): Promise<string> {
  let state = createInitialState({ brief, routingPolicy: runtime.config.routingPolicy });
  applyBriefConstraints(state, brief);
  const activity = createRuntimeActivity(runtime);
  activity.sink.emit({
    kind: 'run',
    title: 'Planning new Production',
    detail: state.production.title,
    productionId: state.production.id,
    stage: state.production.stage,
    subject: { type: 'Production', id: state.production.id },
  });

  try {
    console.log(`${GREEN}Starting fresh Production:${RESET} planning from the latest brief.`);
    const directorModel = await routeTextModelDirect(runtime, state, 'director');
    activity.sink.emit({
      kind: 'model',
      title: 'Routed Director planning',
      productionId: state.production.id,
      stage: state.production.stage,
      model: directorModel.model,
      subject: { type: 'Model', id: directorModel.model },
    });
    console.log(`${DIM}Planning storyboard with ${directorModel.model}.${RESET}`);
    const plan = await planProductionWithOpenRouter({
      apiKey: runtime.config.apiKey,
      model: directorModel.model,
      brief,
      runtimeSeconds: state.production.target.runtimeSeconds,
    });
    applyProductionPlan(state, plan.plan);
    activity.sink.emit({
      kind: 'stage',
      title: 'Storyboard plan ready',
      detail: planSummary(plan.plan),
      productionId: state.production.id,
      stage: state.production.stage,
      subject: { type: 'Production', id: state.production.id },
    });

    const refinements = await refineCreativeTextDirect(runtime, state);
    rebuildReferenceSetsFromCurrentState(state);
    state.eventLog.push(`Created ${plan.source} storyboard plan${plan.model ? ` with ${plan.model}` : ''}: ${planSummary(plan.plan)}`);
    for (const refinement of refinements) {
      state.eventLog.push(refinementMessage(refinement));
      if (refinement.warning) state.eventLog.push(`${refinement.scope} refinement warning: ${refinement.warning}`);
    }
    if (plan.warning) state.eventLog.push(`Planner fallback warning: ${plan.warning}`);

    const messages = [
      'Production created.',
      `Storyboard plan: ${planSummary(plan.plan)}`,
      ...filmPackageDecisionMessages(state),
      ...refinements.map(refinementMessage),
    ];
    for (let i = 0; i < 10; i++) {
      const action = nextRecommendedAction(state);
      if (!action || action.type === 'approve_pending') break;
      const result = applyAction(state, action);
      state = result.state;
      messages.push(result.message);
      activity.sink.emit({
        kind: result.blocked ? 'blocked' : 'stage',
        level: result.blocked ? 'warning' : 'info',
        title: result.message,
        productionId: state.production.id,
        stage: state.production.stage,
      });
      if (result.blocked || state.approvals.some((approval) => approval.status === 'pending')) break;
    }

    const dir = productionDir(runtime.config.productionRoot, state);
    await saveProductionState(dir, state);
    const pages = await renderProductionPages(state, dir);
    runtime.currentDir = dir;
    runtime.state = state;
    activity.sink.emit({
      kind: 'complete',
      level: 'success',
      title: 'Production plan saved',
      detail: dir,
      productionId: state.production.id,
      stage: state.production.stage,
      artifactPath: pages[0],
    });

    return [
      `${GREEN}Created fresh Production:${RESET} ${dir}`,
      ...messages,
      `Pages: ${pages.join(', ')}`,
      summarizeState(state),
    ].join('\n');
  } finally {
    activity.end();
  }
}

async function routeTextModelDirect(
  runtime: Runtime,
  state: ProductionState,
  role: TextModelRole,
): Promise<RoleModelSelection> {
  const selection = await selectTextModelForRole({
    role,
    apiKey: runtime.config.apiKey,
    state,
    fallbackModel: runtime.config.model,
  });
  recordRoleModel(state, selection);
  return selection;
}

async function refineCreativeTextDirect(runtime: Runtime, state: ProductionState): Promise<TextRefinementResult[]> {
  const motionModel = await routeTextModelDirect(runtime, state, 'motion_prompt_writer');
  console.log(`${DIM}Refining motion prompts with ${motionModel.model}.${RESET}`);
  const motion = await refineProductionTextWithOpenRouter({
    apiKey: runtime.config.apiKey,
    model: motionModel.model,
    state,
    scope: 'shots',
  });

  const scriptModel = await routeTextModelDirect(runtime, state, 'scriptwriter');
  console.log(`${DIM}Refining narration/dialogue with ${scriptModel.model}.${RESET}`);
  const script = await refineProductionTextWithOpenRouter({
    apiKey: runtime.config.apiKey,
    model: scriptModel.model,
    state,
    scope: 'script',
  });

  return [motion, script];
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

async function recordDirectTurn(runtime: Runtime, line: string, text: string): Promise<void> {
  await runtime.sessionLog.write('assistant_output', {
    text,
    activeProductionDir: runtime.currentDir,
    model: runtime.config.model,
  });
  appendThreadTurn(runtime.thread, 'user', line, {
    model: runtime.config.model,
    activeProductionDir: runtime.currentDir,
  });
  appendThreadTurn(runtime.thread, 'assistant', text, {
    model: runtime.config.model,
    activeProductionDir: runtime.currentDir,
  });
  updateThreadMeta(runtime.thread, {
    activeProductionDir: runtime.currentDir,
    model: runtime.config.model,
    contextWindowTokens: runtime.resolvedContextWindowTokens,
  });
  await saveThread(runtime.config.threadPath, runtime.thread);
}

async function hydrateRuntimeFromThread(runtime: Runtime): Promise<void> {
  const dir = runtime.thread.meta.activeProductionDir;
  if (!dir || !existsSync(dir)) return;
  try {
    runtime.currentDir = dir;
    runtime.state = await loadProductionState(dir);
  } catch {
    runtime.currentDir = undefined;
    runtime.state = undefined;
  }
}

async function maybeAutoCompactThread(
  runtime: Runtime,
  reason: string,
  force = false,
  upcomingInput = '',
): Promise<CompactThreadResult> {
  const policy = await threadPolicy(runtime, true);
  const projectedTokens = threadTokenEstimate(runtime.thread) + estimateTokens(upcomingInput);
  const projectedOverLimit = projectedTokens >= Math.floor(policy.contextWindowTokens * policy.autoCompactRatio);
  const result = await compactThreadIfNeeded(
    runtime.thread,
    policy,
    (inputText) => summarizeThreadWithOpenRouter(inputText, runtime.config),
    reason,
    force || projectedOverLimit,
  );
  if (result.compacted) {
    updateThreadMeta(runtime.thread, {
      activeProductionDir: runtime.currentDir,
      model: runtime.config.model,
      contextWindowTokens: policy.contextWindowTokens,
    });
    await saveThread(runtime.config.threadPath, runtime.thread);
    if (runtime.interactive && reason !== 'manual') {
      console.log(`${DIM}context compacted ${result.beforeTokens} -> ${result.afterTokens} estimated tokens${RESET}\n`);
    }
  }
  return result;
}

async function printContextStatus(runtime: Runtime): Promise<void> {
  const policy = await threadPolicy(runtime, false);
  const estimate = threadTokenEstimate(runtime.thread);
  const threshold = Math.floor(policy.contextWindowTokens * policy.autoCompactRatio);
  const emergency = Math.floor(policy.contextWindowTokens * policy.emergencyCompactRatio);
  const percent = Math.round((estimate / policy.contextWindowTokens) * 100);
  console.log(`${BOLD}Persistent Thread${RESET}`);
  console.log(`  ${DIM}path:${RESET} ${runtime.config.threadPath}`);
  console.log(`  ${DIM}turns:${RESET} ${runtime.thread.turns.length}`);
  console.log(`  ${DIM}summary:${RESET} ${runtime.thread.summary ? 'yes' : 'no'}`);
  console.log(`  ${DIM}compactions:${RESET} ${runtime.thread.compactions.length}`);
  console.log(`  ${DIM}tokens:${RESET} ${estimate} / ${policy.contextWindowTokens} ${GRAY}(${percent}%)${RESET}`);
  console.log(`  ${DIM}auto compact:${RESET} ${threshold} ${GRAY}emergency ${emergency}${RESET}`);
  console.log(`  ${DIM}keeps:${RESET} first ${policy.keepHeadTurns}, recent ${policy.keepRecentTurns}`);
  console.log(`  ${DIM}compaction model:${RESET} ${CYAN}${policy.compactionModel}${RESET}`);
  console.log(`  ${DIM}active production:${RESET} ${runtime.currentDir ?? runtime.thread.meta.activeProductionDir ?? '-'}\n`);
}

async function printActivityReport(runtime: Runtime): Promise<void> {
  if (!runtime.state && runtime.currentDir) runtime.state = await loadProductionState(runtime.currentDir);
  console.log(`${BOLD}Showrunner Activity${RESET}`);
  console.log(`  ${DIM}session:${RESET} ${runtime.sessionLog.path}`);
  console.log(`  ${DIM}model:${RESET} ${CYAN}${runtime.config.model}${RESET}`);

  if (!runtime.state) {
    console.log(`  ${DIM}active production:${RESET} -`);
    console.log(`  ${DIM}next:${RESET} create a Production from a brief\n`);
    return;
  }

  const state = runtime.state;
  const pending = state.approvals.filter((approval) => approval.status === 'pending');
  const nextAction = nextRecommendedAction(state)?.type;
  console.log(`  ${DIM}active production:${RESET} ${runtime.currentDir ?? '-'}`);
  console.log(`  ${DIM}stage:${RESET} ${state.production.stage}`);
  console.log(`  ${DIM}next:${RESET} ${formatActionLabel(nextAction)}`);
  console.log(`  ${DIM}legal actions:${RESET} ${legalActions(state).map(formatActionLabel).join(', ')}`);
  console.log(`  ${DIM}budget:${RESET} $${state.production.budgetGuardrail.spentUsd.toFixed(2)} / $${state.production.budgetGuardrail.maxUsd.toFixed(2)}`);
  console.log(`  ${DIM}pending approvals:${RESET} ${pending.length}`);
  for (const approval of pending) {
    const cost = approval.costUsd === undefined ? 'n/a' : `$${approval.costUsd.toFixed(2)}`;
    console.log(`    ${YELLOW}${approval.kind}${RESET} ${approval.subjectId} ${GRAY}${cost}${RESET} ${approval.reason}`);
  }

  const roleModels = Object.entries(state.production.routing.roles ?? {});
  if (roleModels.length > 0) {
    console.log(`\n${BOLD}Role Routing${RESET}`);
    for (const [role, selection] of roleModels) {
      console.log(`  ${DIM}${role}:${RESET} ${CYAN}${selection.model}${RESET}`);
    }
  }

  const mediaModels = Object.entries(state.production.routing.modalities ?? {});
  if (mediaModels.length > 0) {
    console.log(`\n${BOLD}Media Routing${RESET}`);
    for (const [modality, selection] of mediaModels) {
      console.log(`  ${DIM}${modality}:${RESET} ${selection.preferredModels.join(', ')}`);
    }
  }

  if (state.costs.length > 0) {
    console.log(`\n${BOLD}Recent Costs${RESET}`);
    for (const cost of state.costs.slice(-8)) {
      console.log(`  ${DIM}${cost.createdAt.slice(0, 19)}${RESET} ${cost.kind} ${cost.subjectId}: $${cost.costUsd.toFixed(4)}`);
    }
  }

  if (runtime.currentDir) {
    const artifacts = await inspectArtifacts(state, runtime.currentDir);
    const visibleArtifacts = artifacts.filter((artifact) => artifact.exists || artifact.note).slice(0, 8);
    if (visibleArtifacts.length > 0) {
      console.log(`\n${BOLD}Artifacts${RESET}`);
      for (const artifact of visibleArtifacts) {
        const size = typeof artifact.sizeBytes === 'number' ? ` ${GRAY}${formatBytes(artifact.sizeBytes)}${RESET}` : '';
        const status = artifact.exists ? `${GREEN}exists${RESET}` : `${YELLOW}missing${RESET}`;
        console.log(`  ${status} ${artifact.kind} ${artifact.id}:${size} ${artifact.path}`);
        if (artifact.note) console.log(`    ${DIM}${artifact.note}${RESET}`);
      }
    }
  }

  console.log(`\n${BOLD}Recent Events${RESET}`);
  for (const event of state.eventLog.slice(-12)) {
    console.log(`  ${GRAY}-${RESET} ${event}`);
  }
  console.log();
}

function createRuntimeActivity(runtime: Runtime, options: {
  onFirstEvent?: () => void;
} = {}): { sink: ProductionActivitySink; end: () => void } {
  const consoleView = runtime.interactive ? new ProductionConsole() : undefined;
  let seen = false;
  const sink = createProductionActivitySink((event) => {
    if (!seen) {
      seen = true;
      options.onFirstEvent?.();
    }
    void runtime.sessionLog.write('activity', event).catch(() => {});
    consoleView?.handle(event);
  });
  return {
    sink,
    end: () => consoleView?.end(),
  };
}

async function threadPolicy(runtime: Runtime, allowModelLookup: boolean): Promise<ThreadCompactionPolicy> {
  let contextWindowTokens = runtime.resolvedContextWindowTokens ?? runtime.thread.meta.contextWindowTokens ?? runtime.config.contextWindowTokens;
  if (allowModelLookup && !runtime.resolvedContextWindowTokens) {
    try {
      const modelContext = await getModelContextLength(runtime.config.model, runtime.config.apiKey);
      if (modelContext) {
        runtime.resolvedContextWindowTokens = modelContext;
        contextWindowTokens = modelContext;
      }
    } catch {
      contextWindowTokens = runtime.config.contextWindowTokens;
    }
  }

  return {
    contextWindowTokens,
    autoCompactRatio: runtime.config.autoCompactRatio,
    emergencyCompactRatio: runtime.config.emergencyCompactRatio,
    keepHeadTurns: runtime.config.keepHeadTurns,
    keepRecentTurns: runtime.config.keepRecentTurns,
    compactionModel: runtime.config.compactionModel,
  };
}

async function dispatchCommand(command: string, args: string, runtime: Runtime): Promise<void> {
  const ctx = {
    get state() { return runtime.state; },
    set state(next: ProductionState | undefined) { runtime.state = next; },
    get currentDir() { return runtime.currentDir; },
    set currentDir(next: string | undefined) { runtime.currentDir = next; },
  };

  switch (command) {
    case '/help':
      printHelp();
      return;
    case '/model':
      if (args) await setModel(runtime, args);
      else await chooseModel(runtime);
      return;
    case '/context':
    case '/thread':
      await printContextStatus(runtime);
      return;
    case '/compact': {
      const result = await maybeAutoCompactThread(runtime, 'manual', true);
      if (result.compacted) console.log(`${GREEN}Compacted context:${RESET} ${result.beforeTokens} -> ${result.afterTokens} estimated tokens.\n`);
      else console.log(`${YELLOW}Context unchanged:${RESET} not enough middle turns to compact yet.\n`);
      return;
    }
    case '/new': {
      if (!args) {
        console.log(`${YELLOW}Usage:${RESET} /new <natural-language production brief>`);
        return;
      }
      const newState = createInitialState({ brief: args, routingPolicy: runtime.config.routingPolicy });
      const newDir = productionDir(runtime.config.productionRoot, newState);
      ctx.state = newState;
      ctx.currentDir = newDir;
      await saveAndRender(newDir, newState);
      updateThreadMeta(runtime.thread, { activeProductionDir: newDir, model: runtime.config.model });
      await saveThread(runtime.config.threadPath, runtime.thread);
      console.log(`${GREEN}Created Production:${RESET} ${ctx.currentDir}`);
      return;
    }
    case '/load': {
      if (!args) {
        console.log(`${YELLOW}Usage:${RESET} /load <production-directory>`);
        return;
      }
      const dir = args.startsWith(runtime.config.productionRoot) ? args : join(runtime.config.productionRoot, args);
      if (!existsSync(dir)) throw new Error(`Production directory not found: ${dir}`);
      ctx.currentDir = dir;
      ctx.state = await loadProductionState(dir);
      updateThreadMeta(runtime.thread, { activeProductionDir: dir, model: runtime.config.model });
      await saveThread(runtime.config.threadPath, runtime.thread);
      console.log(summarizeState(ctx.state));
      return;
    }
    case '/status': {
      const current = requireState(ctx.state);
      console.log(summarizeState(current));
      console.log(`${DIM}Legal actions:${RESET} ${legalActions(current).join(', ')}`);
      return;
    }
    case '/activity':
    case '/trace':
      await printActivityReport(runtime);
      return;
    case '/next': {
      const action = nextRecommendedAction(requireState(ctx.state));
      if (!action) {
        console.log(`${GREEN}Complete:${RESET} Production has no next stage action.`);
        return;
      }
      await applyAndSave(ctx, action);
      return;
    }
    case '/approve':
      await applyAndSave(ctx, { type: 'approve_pending' });
      return;
    case '/action': {
      const type = args as ControllerAction['type'];
      if (!type) {
        console.log(`${YELLOW}Usage:${RESET} /action <${legalActions(requireState(ctx.state)).join('|')}>`);
        return;
      }
      await applyAndSave(ctx, { type } as ControllerAction);
      return;
    }
    case '/page': {
      const current = requireState(ctx.state);
      const dir = requireDir(ctx.currentDir);
      await materializeProductionArtifacts(current, dir);
      await saveProductionState(dir, current);
      const pages = await renderProductionPages(current, dir);
      console.log(`${GREEN}Rendered pages:${RESET}\n${pages.map((p) => `  ${p}`).join('\n')}`);
      return;
    }
    case '/models': {
      const kind = args || 'video';
      if (kind === 'video') {
        const models = await listVideoModels(runtime.config.apiKey);
        printModels(models.map((m) => ({
          id: m.id,
          detail: [
            m.supported_aspect_ratios?.join('/'),
            m.supported_resolutions?.join('/'),
            m.supported_durations?.join('/'),
          ].filter(Boolean).join(' | '),
        })));
      } else if (kind === 'speech' || kind === 'audio' || kind === 'image' || kind === 'text') {
        const models = await listModelsByOutputModality(kind, runtime.config.apiKey);
        printModels(models.map((m) => ({ id: m.id, detail: m.name ?? '' })));
      } else {
        console.log(`${YELLOW}Usage:${RESET} /models video|text|speech|audio|image`);
      }
      return;
    }
    default:
      console.log(`${YELLOW}Unknown command:${RESET} ${command}`);
      printHelp();
  }
}

async function applyAndSave(
  ctx: { state: ProductionState | undefined; currentDir: string | undefined },
  action: ControllerAction,
): Promise<void> {
  const current = requireState(ctx.state);
  const result = applyAction(current, action);
  ctx.state = result.state;
  await saveAndRender(requireDir(ctx.currentDir), ctx.state);
  console.log(`${result.blocked ? RED : GREEN}${result.blocked ? 'Blocked' : 'OK'}:${RESET} ${result.message}`);
  console.log(summarizeState(ctx.state));
}

async function saveAndRender(dir: string, state: ProductionState): Promise<void> {
  await materializeProductionArtifacts(state, dir);
  await saveProductionState(dir, state);
  await renderProductionPages(state, dir);
}

function requireState(state: ProductionState | undefined): ProductionState {
  if (!state) throw new Error('No active Production. Type a brief to start one.');
  return state;
}

function requireDir(dir: string | undefined): string {
  if (!dir) throw new Error('No active Production directory.');
  return dir;
}

function printModels(models: Array<{ id: string; detail: string }>): void {
  console.log(`${BOLD}Models${RESET}`);
  for (const model of models.slice(0, 20)) {
    console.log(`  ${CYAN}${model.id}${RESET}${model.detail ? ` ${DIM}${model.detail}${RESET}` : ''}`);
  }
  if (models.length > 20) console.log(`${DIM}Showing 20 of ${models.length}.${RESET}`);
}

function printHelp(): void {
  console.log(`${BOLD}Debug Commands${RESET}`);
  console.log(`  ${CYAN}/model [id]${RESET}      choose or set the Showrunner controller model`);
  console.log(`  ${CYAN}/context${RESET}         show persistent thread and compaction status`);
  console.log(`  ${CYAN}/compact${RESET}         compact the persistent thread now`);
  console.log(`  ${CYAN}/new <brief>${RESET}     create a Production`);
  console.log(`  ${CYAN}/load <dir>${RESET}      load a Production directory`);
  console.log(`  ${CYAN}/status${RESET}          show Production State summary`);
  console.log(`  ${CYAN}/activity${RESET}        show recent events, routing, approvals, costs, and artifacts`);
  console.log(`  ${CYAN}/next${RESET}            run the next recommended stage action`);
  console.log(`  ${CYAN}/approve${RESET}         approve the pending gate`);
  console.log(`  ${CYAN}/models video${RESET}    inspect OpenRouter model surfaces`);
  console.log(`  ${CYAN}/page${RESET}            render static HTML Production Pages`);
  console.log(`  ${CYAN}/exit${RESET}            quit\n`);
}

function printSubmitStatus(runtime: Runtime): void {
  const cwd = process.cwd().replace(process.env.HOME ?? '', '~');
  const active = runtime.currentDir ? ` · ${basename(runtime.currentDir)}` : '';
  console.log(`  ${DIM}${cwd}${active} · ${runtime.config.model}${RESET}\n`);
}

function toolOnlySummary(event: Extract<AgentEvent, { type: 'tool_result' }> | undefined): string {
  if (!event) return '';
  try {
    const parsed = JSON.parse(event.output) as {
      message?: string;
      directory?: string;
      artifacts?: Array<{ kind: string; id: string; path: string; exists: boolean; sizeBytes?: number; note?: string }>;
      soundMixSources?: Array<{ id: string; summary: string }>;
      generated?: Array<{ takeId: string; shotId: string; model: string; mediaPath: string; costUsd: number; fileSize: number }>;
      spendThisRunUsd?: number;
      pages?: string[];
      summary?: string;
    };
    if (event.name === 'showrunner_finish_production') {
      const artifacts = parsed.artifacts ?? [];
      const rows = artifacts.map((artifact) => {
        const size = typeof artifact.sizeBytes === 'number' ? ` (${formatBytes(artifact.sizeBytes)})` : '';
        const note = artifact.note ? ` - ${artifact.note}` : '';
        return `- ${artifact.kind} ${artifact.id}: ${artifact.exists ? 'exists' : 'missing'}${size} ${artifact.path}${note}`;
      });
      const sourceRows = (parsed.soundMixSources ?? []).map((mix) => `Sound mix ${mix.id}: ${mix.summary}.`);
      return [
        parsed.message ?? 'Finished production artifacts.',
        parsed.directory ? `Directory: ${parsed.directory}` : '',
        ...sourceRows,
        ...rows,
      ].filter(Boolean).join('\n');
    }
    if (event.name === 'showrunner_generate_remaining_takes' || event.name === 'showrunner_regenerate_shots') {
      const generated = parsed.generated ?? [];
      const artifacts = parsed.artifacts ?? [];
      const rows = artifacts
        .filter((artifact) => artifact.exists && artifact.kind !== 'take')
        .map((artifact) => `- ${artifact.kind} ${artifact.id}: ${artifact.path}`);
      return [
        parsed.message ?? `Generated ${generated.length} Takes.`,
        typeof parsed.spendThisRunUsd === 'number' ? `Spend this run: $${parsed.spendThisRunUsd.toFixed(2)}` : '',
        parsed.directory ? `Directory: ${parsed.directory}` : '',
        ...generated.slice(0, 5).map((take) => `- ${take.takeId} (${take.shotId}): ${take.mediaPath}`),
        generated.length > 5 ? `... ${generated.length - 5} more takes` : '',
        ...rows,
      ].filter(Boolean).join('\n');
    }
    if (event.name === 'showrunner_replan_production') {
      const shots = Array.isArray((parsed as Record<string, unknown>).shots)
        ? (parsed as { shots: Array<{ id: string; intent: string; durationSeconds: number; promptDraft: string }> }).shots
        : [];
      return [
        parsed.message ?? 'Replanned production.',
        parsed.directory ? `Directory: ${parsed.directory}` : '',
        ...shots.slice(0, 6).map((shot) => `- ${shot.id} (${shot.durationSeconds}s): ${shot.intent} - ${shot.promptDraft}`),
        shots.length > 6 ? `... ${shots.length - 6} more shots` : '',
      ].filter(Boolean).join('\n');
    }
    if (parsed.message) return parsed.message;
    if (parsed.summary) return parsed.summary;
  } catch {
    return '';
  }
  return '';
}

function formatActionLabel(action: string | undefined): string {
  return action ? action.replace(/_/g, ' ') : 'none';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function styledReadLine(bg: string, label = 'brief'): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return new Promise((resolve) => {
      const rl = createInterface({ input, output });
      rl.question('> ', (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve) => {
    let line = '';
    let initialized = false;
    let drawnRows = 0;
    const accent = label === 'model' ? CYAN : GREEN;

    const draw = () => {
      const width = output.columns || 88;
      const contentWidth = Math.max(12, width - 5);
      const lines = wrapInput(line, contentWidth);

      if (!initialized) {
        output.write(`\n${bg}\x1b[K${RESET}\n`);
        initialized = true;
      } else if (drawnRows > 0) {
        for (let i = 0; i < drawnRows; i++) {
          output.write('\r\x1b[2K');
          if (i < drawnRows - 1) output.write('\x1b[1B');
        }
        if (drawnRows > 1) output.write(`\x1b[${drawnRows - 1}A`);
        output.write('\r');
      }

      for (const [index, segment] of lines.entries()) {
        const marker = index === 0 ? `${accent}›${RESET}` : `${DIM}·${RESET}`;
        output.write(`${bg}\x1b[K ${marker}${bg}${WHITE} ${segment}${RESET}`);
        if (index < lines.length - 1) output.write('\n');
      }
      drawnRows = lines.length;
    };

    const done = () => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write(`${RESET}\n`);
      resolve(line);
    };

    const onData = (data: Buffer) => {
      const str = data.toString('utf-8');
      if (str.startsWith('\x1b')) return;
      for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code === 13 || code === 10) {
          done();
          return;
        }
        if (code === 127 || code === 8) {
          line = line.slice(0, -1);
          draw();
          continue;
        }
        if (code === 3) {
          output.write(`${RESET}\n`);
          process.exit(0);
        }
        if (code >= 32) {
          line += str[i];
          draw();
        }
      }
    };

    draw();
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function wrapInput(value: string, width: number): string[] {
  if (!value) return [''];
  const lines: string[] = [];
  let remaining = value;
  while (remaining.length > width) {
    let idx = remaining.lastIndexOf(' ', width);
    if (idx < Math.floor(width * 0.5)) idx = width;
    lines.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).replace(/^\s+/, '');
  }
  lines.push(remaining);
  return lines;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
