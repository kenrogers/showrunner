import type { AgentConfig } from './config.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function colorRow(label: string, value: string, width: number): string {
  const visible = `${label.padEnd(8)}${stripAnsi(value)}`;
  const pad = Math.max(0, width - visible.length);
  return `│ ${DIM}${label.padEnd(8)}${RESET}${value}${' '.repeat(pad)} │`;
}

export function printBanner(config: AgentConfig): void {
  const width = Math.min(Math.max(process.stdout.columns ? process.stdout.columns - 4 : 72, 56), 88);
  const line = '─'.repeat(width);
  const title = 'SHOWRUNNER';
  const source = config.modelSource === 'env' ? 'env' : config.modelSource === 'local' ? 'saved' : 'default';

  console.log();
  console.log(`${GRAY}╭${line}╮${RESET}`);
  console.log(`│ ${BOLD}${CYAN}${fit(title, width)}${RESET} │`);
  console.log(`│ ${DIM}${fit('multi-model video production harness', width)}${RESET} │`);
  console.log(`${GRAY}├${line}┤${RESET}`);
  console.log(colorRow('model', `${CYAN}${config.model}${RESET} ${DIM}(${source})${RESET}`, width));
  console.log(colorRow('video', config.defaultVideoModel, width));
  console.log(colorRow('voice', `${config.ttsModel} / ${config.ttsVoice}`, width));
  console.log(colorRow('key', config.apiKey ? `${GREEN}loaded${RESET}` : `${YELLOW}missing${RESET}`, width));
  console.log(colorRow('budget', `$${config.maxCost.toFixed(2)} per agent turn`, width));
  console.log(colorRow('routing', config.routingPolicy, width));
  console.log(`${GRAY}╰${line}╯${RESET}\n`);
}

export function printTryBrief(): void {
  console.log(`${BOLD}Try${RESET}`);
  console.log(`  Create a 45-second vertical noir trailer for a luxury espresso machine: rain on glass, macro chrome, whispered narration, jazz-club percussion, and a final hero shot that feels like a midnight heist.`);
  console.log();
}

export function printModelHint(model: string): void {
  console.log(`${DIM}model${RESET} ${CYAN}${model}${RESET} ${DIM}· type "model" to switch${RESET}\n`);
}
