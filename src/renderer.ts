import type { AgentEvent } from './agent.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';

type ToolFormatter = (args: Record<string, unknown>) => string;

interface PendingTool {
  name: string;
  callId: string;
  args: Record<string, unknown>;
  output?: string;
}

const LABELS: Record<string, string> = {
  showrunner_create_production: 'Created production',
  showrunner_replan_production: 'Replanned production',
  showrunner_status: 'Read production status',
  showrunner_advance: 'Advanced stage gates',
  showrunner_approve_pending: 'Approved gate',
  showrunner_generate_approved_take: 'Generated approved take',
  showrunner_generate_remaining_takes: 'Generated remaining takes',
  showrunner_regenerate_shots: 'Regenerated shots',
  showrunner_finish_production: 'Finished production',
  showrunner_render_pages: 'Rendered production pages',
  openrouter_list_video_models: 'Scouted video models',
  openrouter_list_audio_models: 'Scouted audio models',
  openrouter_preview_video_request: 'Drafted video request',
  web_search: 'Searched web',
};

const FORMATTERS: Record<string, ToolFormatter> = {
  showrunner_create_production: (args) => trunc(String(args.title ?? args.brief ?? ''), 74),
  showrunner_replan_production: (args) => trunc(String(args.brief ?? 'current brief'), 74),
  showrunner_advance: (args) => `max steps ${String(args.maxSteps ?? 1)}`,
  showrunner_generate_remaining_takes: (args) => `$${String(args.approvedBudgetUsd ?? '?')} cap`,
  showrunner_regenerate_shots: (args) => `${Array.isArray(args.shotIds) ? args.shotIds.join(', ') : 'shots'} · $${String(args.approvedBudgetUsd ?? '?')} cap`,
  openrouter_list_video_models: (args) => `limit ${String(args.limit ?? 10)}`,
  openrouter_list_audio_models: (args) => String(args.modality ?? 'audio'),
  openrouter_preview_video_request: (args) => String(args.model ?? ''),
};

function trunc(value: string, max = 88): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function summarizeOutput(output: string): string {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed.summary === 'string') return trunc(parsed.summary.split('\n')[0]);
    if (Array.isArray(parsed.messages)) return trunc(parsed.messages.join(' / '));
    if (Array.isArray(parsed.pages)) return trunc(parsed.pages.join(', '));
    if (typeof parsed.message === 'string') return trunc(parsed.message);
    if (typeof parsed.count === 'number') return `${parsed.count} found`;
  } catch {
    // Fall through to raw output.
  }
  return trunc(output.split('\n')[0] ?? '');
}

export class TuiRenderer {
  private pending: PendingTool[] = [];
  private streaming = false;
  private runningToolCalls = new Set<string>();

  handle(event: AgentEvent): void {
    if (event.type === 'text') {
      this.flushTools();
      this.streaming = true;
      process.stdout.write(event.delta);
      return;
    }
    if (event.type === 'tool_call') {
      this.endStreaming();
      const existing = this.pending.find((item) => item.callId === event.callId);
      if (existing) {
        existing.name = event.name;
        existing.args = event.args;
        return;
      }
      const runningKey = `${event.callId}:${event.name}`;
      if (this.runningToolCalls.has(runningKey)) return;
      this.runningToolCalls.add(runningKey);
      this.pending.push({
        name: event.name,
        callId: event.callId,
        args: event.args,
      });
      this.flushTools();
      return;
    }
    if (event.type === 'tool_result') {
      const pending = this.pending.find((item) => item.callId === event.callId);
      if (pending) pending.output = event.output;
      else this.pending.push({ name: event.name, callId: event.callId, args: {}, output: event.output });
      return;
    }
    if (event.type === 'server_tool') {
      this.endStreaming();
      const pending = this.pending.find((item) => item.callId === event.callId);
      const output = event.sources?.length ? event.sources.slice(0, 3).join(', ') : event.status ?? 'running';
      const args = { query: event.query ?? '', status: event.status ?? '' };
      if (pending) {
        pending.name = event.name;
        pending.args = args;
        pending.output = output;
      } else {
        this.pending.push({ name: event.name, callId: event.callId, args, output });
      }
      return;
    }
    if (event.type === 'reasoning') {
      if (process.env.SHOWRUNNER_SHOW_REASONING !== 'true') return;
      this.flushTools();
      this.endStreaming();
      if (event.delta.trim()) process.stdout.write(`${DIM}${event.delta}${RESET}`);
    }
  }

  endTurn(): void {
    this.flushTools();
    this.endStreaming();
  }

  private flushTools(): void {
    if (this.pending.length === 0) return;
    const width = Math.min(process.stdout.columns || 92, 110);
    const rule = `${GRAY}${'─'.repeat(Math.max(24, width - 8))}${RESET}`;
    console.log(`${GRAY}╭${rule}${RESET}`);
    for (const item of this.pending) {
      const label = LABELS[item.name] ?? item.name;
      const formatter = FORMATTERS[item.name];
      const detail = formatter ? formatter(item.args) : '';
      const output = item.output ? summarizeOutput(item.output) : 'running';
      const title = `${label}${detail ? ` ${detail}` : ''}`;
      const titleLines = wrapPlain(title, Math.max(20, width - 8));
      for (const [index, line] of titleLines.entries()) {
        const marker = index === 0 ? `${GREEN}●${RESET}` : ' ';
        console.log(`│ ${marker} ${BOLD}${line}${RESET}`);
      }
      for (const [index, line] of wrapPlain(output, Math.max(20, width - 10)).entries()) {
        const arrow = index === 0 ? `${CYAN}↳${RESET}` : ' ';
        console.log(`│   ${arrow} ${MAGENTA}${line}${RESET}`);
      }
    }
    console.log(`${GRAY}╰${rule}${RESET}\n`);
    this.pending = [];
  }

  private endStreaming(): void {
    if (!this.streaming) return;
    process.stdout.write(`${RESET}\n`);
    this.streaming = false;
  }
}

function wrapPlain(value: string, width: number): string[] {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return [''];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.flatMap((line) => hardWrap(line, width));
}

function hardWrap(value: string, width: number): string[] {
  if (value.length <= width) return [value];
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines;
}
