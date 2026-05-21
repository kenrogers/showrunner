import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { callModel, maxCost, OpenRouter, stepCountIs } from '@openrouter/agent';
import type { AgentConfig } from './config.js';

export type ThreadRole = 'user' | 'assistant';

export interface ThreadTurn {
  id: string;
  role: ThreadRole;
  content: string;
  createdAt: string;
  tokenEstimate: number;
  meta?: {
    model?: string;
    activeProductionDir?: string;
    kind?: string;
  };
}

export interface ThreadSummary {
  content: string;
  updatedAt: string;
  sourceTurnIds: string[];
  tokenEstimate: number;
}

export interface ThreadCompaction {
  id: string;
  createdAt: string;
  reason: string;
  model: string;
  beforeTokens: number;
  afterTokens: number;
  summarizedTurnIds: string[];
  keptHeadTurnIds: string[];
  keptTailTurnIds: string[];
}

export interface ShowrunnerThread {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  summary?: ThreadSummary;
  turns: ThreadTurn[];
  compactions: ThreadCompaction[];
  meta: {
    activeProductionDir?: string;
    lastModel?: string;
    contextWindowTokens?: number;
  };
}

export interface ThreadCompactionPolicy {
  contextWindowTokens: number;
  autoCompactRatio: number;
  emergencyCompactRatio: number;
  keepHeadTurns: number;
  keepRecentTurns: number;
  compactionModel: string;
}

export interface ThreadContextOptions {
  activeProductionDir?: string;
  activeProductionState?: unknown;
}

export interface CompactThreadResult {
  compacted: boolean;
  reason: string;
  beforeTokens: number;
  afterTokens: number;
  thresholdTokens: number;
  summarizedTurnCount: number;
}

export type ThreadSummarizer = (input: string) => Promise<string>;

export function createThread(now = new Date()): ShowrunnerThread {
  const timestamp = now.toISOString();
  return {
    version: 1,
    id: randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    turns: [],
    compactions: [],
    meta: {},
  };
}

export async function loadThread(path: string): Promise<ShowrunnerThread> {
  if (!existsSync(path)) return createThread();
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<ShowrunnerThread>;
  if (parsed.version !== 1 || !Array.isArray(parsed.turns)) return createThread();
  return {
    version: 1,
    id: typeof parsed.id === 'string' ? parsed.id : randomUUID(),
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    summary: normalizeSummary(parsed.summary),
    turns: parsed.turns.map(normalizeTurn).filter(Boolean) as ThreadTurn[],
    compactions: Array.isArray(parsed.compactions) ? parsed.compactions.map(normalizeCompaction).filter(Boolean) as ThreadCompaction[] : [],
    meta: parsed.meta && typeof parsed.meta === 'object' ? {
      activeProductionDir: typeof parsed.meta.activeProductionDir === 'string' ? parsed.meta.activeProductionDir : undefined,
      lastModel: typeof parsed.meta.lastModel === 'string' ? parsed.meta.lastModel : undefined,
      contextWindowTokens: typeof parsed.meta.contextWindowTokens === 'number' ? parsed.meta.contextWindowTokens : undefined,
    } : {},
  };
}

export async function saveThread(path: string, thread: ShowrunnerThread): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(thread, null, 2)}\n`);
}

export function appendThreadTurn(
  thread: ShowrunnerThread,
  role: ThreadRole,
  content: string,
  meta: ThreadTurn['meta'] = {},
): ThreadTurn {
  const now = new Date().toISOString();
  const turn: ThreadTurn = {
    id: randomUUID(),
    role,
    content,
    createdAt: now,
    tokenEstimate: estimateTokens(content),
    meta,
  };
  thread.turns.push(turn);
  thread.updatedAt = now;
  return turn;
}

export function updateThreadMeta(
  thread: ShowrunnerThread,
  input: { activeProductionDir?: string; model?: string; contextWindowTokens?: number },
): void {
  if (input.activeProductionDir) thread.meta.activeProductionDir = input.activeProductionDir;
  if (input.model) thread.meta.lastModel = input.model;
  if (input.contextWindowTokens) thread.meta.contextWindowTokens = input.contextWindowTokens;
  thread.updatedAt = new Date().toISOString();
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function threadTokenEstimate(thread: ShowrunnerThread): number {
  const summaryTokens = thread.summary?.tokenEstimate ?? 0;
  const turnTokens = thread.turns.reduce((sum, turn) => sum + turn.tokenEstimate + 8, 0);
  return summaryTokens + turnTokens + 64;
}

export function buildThreadContext(thread: ShowrunnerThread, options: ThreadContextOptions = {}): string {
  const lines = [
    '## Persistent Showrunner Thread',
    `thread_id: ${thread.id}`,
    `turns_retained: ${thread.turns.length}`,
    `compactions: ${thread.compactions.length}`,
  ];

  const activeDir = options.activeProductionDir ?? thread.meta.activeProductionDir;
  if (activeDir) lines.push(`active_production_dir: ${activeDir}`);
  if (thread.meta.lastModel) lines.push(`last_showrunner_model: ${thread.meta.lastModel}`);

  if (thread.summary?.content.trim()) {
    lines.push('', '### Compacted Thread Summary', thread.summary.content.trim());
  }

  const head = thread.turns.slice(0, 2);
  const tailStart = Math.max(2, thread.turns.length - 12);
  const recent = thread.turns.slice(tailStart);
  const selected = uniqueTurns([...head, ...recent]);
  if (selected.length) {
    lines.push('', '### Retained Turns');
    for (const turn of selected) lines.push(formatTurn(turn));
  }

  if (options.activeProductionState) {
    lines.push('', '### Active Production State Snapshot');
    lines.push(truncate(JSON.stringify(options.activeProductionState, null, 2), 12000));
  }

  lines.push(
    '',
    'Use this as persistent context only. The next section is the new user message to answer.',
  );
  return lines.join('\n');
}

export async function compactThreadIfNeeded(
  thread: ShowrunnerThread,
  policy: ThreadCompactionPolicy,
  summarizer: ThreadSummarizer,
  reason: string,
  force = false,
): Promise<CompactThreadResult> {
  const beforeTokens = threadTokenEstimate(thread);
  const thresholdTokens = Math.floor(policy.contextWindowTokens * policy.autoCompactRatio);
  if (!force && beforeTokens < thresholdTokens) {
    return { compacted: false, reason, beforeTokens, afterTokens: beforeTokens, thresholdTokens, summarizedTurnCount: 0 };
  }

  const keepHead = Math.max(0, policy.keepHeadTurns);
  const keepRecent = Math.max(1, policy.keepRecentTurns);
  const head = thread.turns.slice(0, keepHead);
  const tailStart = Math.max(keepHead, thread.turns.length - keepRecent);
  const tail = thread.turns.slice(tailStart);
  const middle = thread.turns.slice(keepHead, tailStart);

  if (!middle.length) {
    return { compacted: false, reason, beforeTokens, afterTokens: beforeTokens, thresholdTokens, summarizedTurnCount: 0 };
  }

  const input = buildCompactionInput(thread, middle);
  const summary = (await summarizer(input)).trim();
  if (!summary) throw new Error('Compaction produced an empty thread summary.');

  const previousIds = thread.summary?.sourceTurnIds ?? [];
  const summarizedTurnIds = middle.map((turn) => turn.id);
  thread.summary = {
    content: summary,
    updatedAt: new Date().toISOString(),
    sourceTurnIds: uniqueStrings([...previousIds, ...summarizedTurnIds]),
    tokenEstimate: estimateTokens(summary),
  };
  thread.turns = uniqueTurns([...head, ...tail]);
  thread.compactions.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    reason,
    model: policy.compactionModel,
    beforeTokens,
    afterTokens: threadTokenEstimate(thread),
    summarizedTurnIds,
    keptHeadTurnIds: head.map((turn) => turn.id),
    keptTailTurnIds: tail.map((turn) => turn.id),
  });
  thread.updatedAt = new Date().toISOString();

  return {
    compacted: true,
    reason,
    beforeTokens,
    afterTokens: threadTokenEstimate(thread),
    thresholdTokens,
    summarizedTurnCount: summarizedTurnIds.length,
  };
}

export async function summarizeThreadWithOpenRouter(input: string, config: AgentConfig): Promise<string> {
  if (!config.apiKey) throw new Error('OPENROUTER_API_KEY is required to compact the persistent thread.');
  const client = new OpenRouter({ apiKey: config.apiKey });
  const result = callModel(client, {
    model: config.compactionModel,
    instructions: [
      'You compact a persistent Showrunner video-production thread.',
      'Produce a concise but operational summary that preserves all state needed to continue the same production thread.',
      'Preserve production goals, creative decisions, model/routing/budget preferences, approval state, generated or expected artifact paths, rejected options, unresolved questions, and the next best action.',
      'Do not invent completed media, approvals, files, costs, or reviews. If something was only planned or previewed, say that clearly.',
      'Use stable headings and dense bullets. Prefer concrete facts over conversation color.',
    ].join('\n'),
    input,
    stopWhen: [stepCountIs(1), maxCost(config.compactionMaxCost)],
  });
  return await result.getText();
}

function buildCompactionInput(thread: ShowrunnerThread, middle: ThreadTurn[]): string {
  const parts = [
    'Compact the middle of this Showrunner production thread.',
    '',
    'Keep the summary useful for a future controller turn in the same single persistent thread.',
    '',
  ];

  if (thread.summary?.content.trim()) {
    parts.push('## Previous Compacted Summary', thread.summary.content.trim(), '');
  }

  if (thread.meta.activeProductionDir) parts.push(`active_production_dir: ${thread.meta.activeProductionDir}`);
  if (thread.meta.lastModel) parts.push(`last_showrunner_model: ${thread.meta.lastModel}`);
  parts.push('', '## Turns To Compact');
  for (const turn of middle) parts.push(formatTurn(turn));
  return parts.join('\n');
}

function formatTurn(turn: ThreadTurn): string {
  const meta = [
    turn.meta?.model ? `model=${turn.meta.model}` : '',
    turn.meta?.activeProductionDir ? `production=${turn.meta.activeProductionDir}` : '',
    turn.meta?.kind ? `kind=${turn.meta.kind}` : '',
  ].filter(Boolean).join(' ');
  const header = `- ${turn.role} ${turn.id} ${turn.createdAt}${meta ? ` (${meta})` : ''}`;
  return `${header}\n${indent(truncate(turn.content.trim(), 5000))}`;
}

function indent(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function uniqueTurns(turns: ThreadTurn[]): ThreadTurn[] {
  const seen = new Set<string>();
  const result: ThreadTurn[] = [];
  for (const turn of turns) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    result.push(turn);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeSummary(value: unknown): ThreadSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const summary = value as Partial<ThreadSummary>;
  if (typeof summary.content !== 'string') return undefined;
  return {
    content: summary.content,
    updatedAt: typeof summary.updatedAt === 'string' ? summary.updatedAt : new Date().toISOString(),
    sourceTurnIds: Array.isArray(summary.sourceTurnIds) ? summary.sourceTurnIds.filter((id): id is string => typeof id === 'string') : [],
    tokenEstimate: typeof summary.tokenEstimate === 'number' ? summary.tokenEstimate : estimateTokens(summary.content),
  };
}

function normalizeTurn(value: unknown): ThreadTurn | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const turn = value as Partial<ThreadTurn>;
  if ((turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') return undefined;
  return {
    id: typeof turn.id === 'string' ? turn.id : randomUUID(),
    role: turn.role,
    content: turn.content,
    createdAt: typeof turn.createdAt === 'string' ? turn.createdAt : new Date().toISOString(),
    tokenEstimate: typeof turn.tokenEstimate === 'number' ? turn.tokenEstimate : estimateTokens(turn.content),
    meta: turn.meta,
  };
}

function normalizeCompaction(value: unknown): ThreadCompaction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const compaction = value as Partial<ThreadCompaction>;
  if (typeof compaction.reason !== 'string') return undefined;
  return {
    id: typeof compaction.id === 'string' ? compaction.id : randomUUID(),
    createdAt: typeof compaction.createdAt === 'string' ? compaction.createdAt : new Date().toISOString(),
    reason: compaction.reason,
    model: typeof compaction.model === 'string' ? compaction.model : 'unknown',
    beforeTokens: typeof compaction.beforeTokens === 'number' ? compaction.beforeTokens : 0,
    afterTokens: typeof compaction.afterTokens === 'number' ? compaction.afterTokens : 0,
    summarizedTurnIds: Array.isArray(compaction.summarizedTurnIds) ? compaction.summarizedTurnIds.filter((id): id is string => typeof id === 'string') : [],
    keptHeadTurnIds: Array.isArray(compaction.keptHeadTurnIds) ? compaction.keptHeadTurnIds.filter((id): id is string => typeof id === 'string') : [],
    keptTailTurnIds: Array.isArray(compaction.keptTailTurnIds) ? compaction.keptTailTurnIds.filter((id): id is string => typeof id === 'string') : [],
  };
}
