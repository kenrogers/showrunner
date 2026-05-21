import type { ShowrunnerThread } from './thread.js';
import type { ProductionState } from './domain/schema.js';

export function isFreshProductionIntent(line: string, thread?: ShowrunnerThread): boolean {
  const normalized = normalize(line);
  if (/^(new|fresh|start new|start fresh|new production|fresh production|start a fresh production|start a new production)$/.test(normalized)) {
    return true;
  }
  if (/^(new|fresh|start new|start fresh|new production|fresh production)\s*[:|-]\s+/.test(normalized)) {
    return true;
  }
  if (/^(option )?c$/.test(normalized)) return recentAssistantOfferedFreshProduction(thread);
  return /\b(start|create|make)\b.*\b(new|fresh)\b.*\bproduction\b/.test(normalized);
}

export function isReplanProductionIntent(line: string): boolean {
  const normalized = normalize(line);
  return /^(replan|replan it|replan current|rewrite plan|start over current)$/.test(normalized);
}

export function isShowExistingProductionIntent(line: string): boolean {
  const normalized = normalize(line);
  return /^(show me what'?s there|show what'?s there|show existing|review existing|just review what exists|what'?s there)$/.test(normalized);
}

export function resolveFreshProductionBrief(input: {
  line: string;
  thread: ShowrunnerThread;
  state?: ProductionState;
}): string | undefined {
  const inline = input.line.match(/(?:new|fresh|start new|start fresh|new production|fresh production)\s*[:|-]\s*(.+)$/i)?.[1]?.trim();
  if (inline && looksLikeProductionBrief(inline)) return inline;

  for (const turn of [...input.thread.turns].reverse()) {
    if (turn.role !== 'user') continue;
    const content = turn.content.trim();
    if (!content || normalize(content) === normalize(input.line)) continue;
    if (isFreshProductionIntent(content, input.thread) || isReplanProductionIntent(content) || isShowExistingProductionIntent(content)) continue;
    if (looksLikeProductionBrief(content)) return content;
  }

  return input.state?.production.brief;
}

function recentAssistantOfferedFreshProduction(thread?: ShowrunnerThread): boolean {
  if (!thread) return false;
  return [...thread.turns].reverse().slice(0, 4).some((turn) =>
    turn.role === 'assistant' &&
    /\b(option c|new production|fresh production|brand new directory|clean slate)\b/i.test(turn.content));
}

function looksLikeProductionBrief(value: string): boolean {
  const normalized = normalize(value);
  return value.length >= 20 &&
    /\b(create|make|produce|build|generate|short film|film|video|trailer|teaser|production)\b/.test(normalized);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[?.!*"`]+/g, '').replace(/\s+/g, ' ').trim();
}
