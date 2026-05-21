import type { ProductionActivityEvent } from './activity.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const GRAY = '\x1b[90m';

export class ProductionConsole {
  private started = false;
  private currentStage = '-';
  private active = 'Preparing';
  private recent: ProductionActivityEvent[] = [];

  handle(event: ProductionActivityEvent): void {
    this.started ||= this.start();
    if (event.stage) this.currentStage = event.stage;
    this.active = event.title;
    this.recent.push(event);
    this.recent = this.recent.slice(-6);
    this.printEvent(event);
  }

  end(): void {
    if (!this.started) return;
    console.log(`${GRAY}╰─${'─'.repeat(70)}${RESET}\n`);
    this.started = false;
  }

  private start(): true {
    console.log(`${GRAY}╭─${'─'.repeat(70)}${RESET}`);
    console.log(`│ ${BOLD}Production Console${RESET} ${DIM}live Production activity${RESET}`);
    return true;
  }

  private printEvent(event: ProductionActivityEvent): void {
    const width = Math.min(process.stdout.columns || 92, 110);
    const marker = markerFor(event);
    const stage = event.stage ?? this.currentStage;
    const subject = event.subject ? formatSubject(event.subject) : undefined;
    const progress = event.progress ? formatProgress(event.progress) : undefined;
    const extras = [
      event.model ? `${DIM}model${RESET} ${CYAN}${event.model}${RESET}` : undefined,
      event.costUsd === undefined ? undefined : `${DIM}cost${RESET} $${event.costUsd.toFixed(4)}`,
      event.artifactPath ? `${DIM}file${RESET} ${event.artifactPath}` : undefined,
      progress,
    ].filter(Boolean).join(` ${GRAY}·${RESET} `);
    const title = [
      `${GRAY}[${stage}]${RESET}`,
      marker,
      `${BOLD}${event.title}${RESET}`,
      subject ? `${DIM}${subject}${RESET}` : undefined,
    ].filter(Boolean).join(' ');
    console.log(`│ ${title}`);
    if (event.detail) {
      for (const [index, line] of wrapPlain(stripAnsi(event.detail), Math.max(28, width - 12)).entries()) {
        const prefix = index === 0 ? `${GRAY}│${RESET}   ${DIM}` : `${GRAY}│${RESET}   ${DIM}`;
        console.log(`${prefix}${line}${RESET}`);
      }
    }
    if (extras) console.log(`│   ${extras}`);
    this.active = event.title;
  }
}

function markerFor(event: ProductionActivityEvent): string {
  if (event.level === 'error') return `${RED}x${RESET}`;
  if (event.level === 'warning') return `${YELLOW}!${RESET}`;
  if (event.kind === 'complete' || event.level === 'success') return `${GREEN}✓${RESET}`;
  if (event.kind === 'model') return `${CYAN}◆${RESET}`;
  return `${GREEN}●${RESET}`;
}

function formatSubject(subject: NonNullable<ProductionActivityEvent['subject']>): string {
  const label = subject.label ?? subject.id;
  return label ? `${subject.type} ${label}` : subject.type;
}

function formatProgress(progress: NonNullable<ProductionActivityEvent['progress']>): string {
  const count = progress.current !== undefined && progress.total !== undefined
    ? `${progress.current}/${progress.total}`
    : undefined;
  return [progress.label, count].filter(Boolean).join(' ');
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
  return lines;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}
