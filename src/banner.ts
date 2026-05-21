import type { AgentConfig } from './config.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[97m';

const LOGO = [
  '██████╗ ██╗  ██╗ ██████╗ ██╗    ██╗',
  '██╔════╝██║  ██║██╔═══██╗██║    ██║',
  '██████╗ ███████║██║   ██║██║ █╗ ██║',
  '╚════██╗██╔══██║██║   ██║██║███╗██║',
  '██████╔╝██║  ██║╚██████╔╝╚███╔███╔╝',
  '╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ',
  '██████╗ ██╗   ██╗███╗   ██╗███╗   ██╗███████╗██████╗ ',
  '██╔══██╗██║   ██║████╗  ██║████╗  ██║██╔════╝██╔══██╗',
  '██████╔╝██║   ██║██╔██╗ ██║██╔██╗ ██║█████╗  ██████╔╝',
  '██╔══██╗██║   ██║██║╚██╗██║██║╚██╗██║██╔══╝  ██╔══██╗',
  '██║  ██║╚██████╔╝██║ ╚████║██║ ╚████║███████╗██║  ██║',
  '╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝',
];

const COMPACT_LOGO = [
  '███████╗██╗  ██╗ ██████╗ ██╗    ██╗',
  '██╔════╝██║  ██║██╔═══██╗██║    ██║',
  '███████╗███████║██║   ██║██║ █╗ ██║',
  '╚════██║██╔══██║██║   ██║██║███╗██║',
  '███████║██║  ██║╚██████╔╝╚███╔███╔╝',
  '╚══════╝╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ',
  '█████╗ ██╗   ██╗███╗  ██╗███╗  ██╗█████╗ █████╗',
  '██╔═██╗██║   ██║████╗ ██║████╗ ██║██╔══╝ ██╔═██╗',
  '█████╔╝██║   ██║██╔██╗██║██╔██╗██║████╗  █████╔╝',
  '██╔██╗ ██║   ██║██║╚████║██║╚████║██╔═╝  ██╔██╗ ',
  '██║ ██╗╚██████╔╝██║ ╚███║██║ ╚███║█████╗ ██║ ██╗',
  '╚═╝ ╚═╝ ╚═════╝ ╚═╝  ╚══╝╚═╝  ╚══╝╚════╝ ╚═╝ ╚═╝',
];

const LOGO_GRADIENT = [
  '\x1b[38;2;255;245;157m',
  '\x1b[38;2;255;211;105m',
  '\x1b[38;2;255;170;83m',
  '\x1b[38;2;255;128;96m',
  '\x1b[38;2;218;96;147m',
  '\x1b[38;2;164;103;255m',
  '\x1b[38;2;125;146;255m',
  '\x1b[38;2;80;190;255m',
  '\x1b[38;2;57;217;207m',
  '\x1b[38;2;104;227;164m',
  '\x1b[38;2;167;230;117m',
  '\x1b[38;2;255;215;104m',
];

function shouldColor(): boolean {
  return process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
}

function paint(text: string, color: string): string {
  return shouldColor() ? `${color}${text}${RESET}` : text;
}

function style(text: string, ...codes: string[]): string {
  return shouldColor() ? `${codes.join('')}${text}${RESET}` : text;
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function center(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  return `${' '.repeat(left)}${text}${' '.repeat(width - text.length - left)}`;
}

function frameLine(left: string, width: number, right: string, label?: string): string {
  if (!label) return `${paint(left, GRAY)}${paint('─'.repeat(width + 2), GRAY)}${paint(right, GRAY)}`;
  const raw = ` ${label} `;
  const remaining = Math.max(0, width + 2 - raw.length);
  const before = Math.floor(remaining / 2);
  const after = remaining - before;
  return `${paint(left, GRAY)}${paint('─'.repeat(before), GRAY)}${style(raw, DIM, WHITE)}${paint('─'.repeat(after), GRAY)}${paint(right, GRAY)}`;
}

function row(content: string, width: number): string {
  return `${paint('│', GRAY)} ${content} ${paint('│', GRAY)}`;
}

function cell(label: string, value: string, width: number, color = WHITE): string {
  const labelWidth = 8;
  const valueWidth = Math.max(0, width - labelWidth - 1);
  return `${style(label.padEnd(labelWidth), DIM)} ${paint(fit(value, valueWidth), color)}`;
}

function detailRow(
  leftLabel: string,
  leftValue: string,
  rightLabel: string,
  rightValue: string,
  width: number,
  leftColor = WHITE,
  rightColor = WHITE,
): string {
  const gutter = ` ${paint('│', GRAY)} `;
  const leftWidth = Math.ceil((width - 3) * 0.58);
  const rightWidth = width - 3 - leftWidth;
  const left = cell(leftLabel, leftValue, leftWidth, leftColor);
  const right = cell(rightLabel, rightValue, rightWidth, rightColor);
  return row(`${left}${gutter}${right}`, width);
}

function fullRow(label: string, value: string, width: number, color = WHITE): string {
  return row(cell(label, value, width, color), width);
}

function compactLogo(width: number): string[] {
  const source = width >= 66 ? LOGO : COMPACT_LOGO;
  return source.map((line, index) => {
    const safeLine = line.length > width ? line.slice(0, width) : center(line, width);
    const color = LOGO_GRADIENT[index % LOGO_GRADIENT.length];
    return paint(style(safeLine, BOLD), color);
  });
}

function sourceLabel(config: AgentConfig): string {
  if (config.modelSource === 'env') return 'env';
  if (config.modelSource === 'local') return 'saved';
  return 'default';
}

function budgetLabel(config: AgentConfig): string {
  return `$${config.maxCost.toFixed(2)} turn guardrail`;
}

function keyLabel(config: AgentConfig): { text: string; color: string } {
  return config.apiKey
    ? { text: 'OpenRouter key loaded', color: GREEN }
    : { text: 'OpenRouter key missing', color: YELLOW };
}

export function printBanner(config: AgentConfig): void {
  const terminalWidth = process.stdout.columns || 96;
  const width = Math.min(Math.max(terminalWidth - 4, 54), 92);
  const key = keyLabel(config);
  const pipeline = 'brief -> treatment -> references -> takes -> reviews -> assembly -> export';

  console.log();
  for (const line of compactLogo(width)) console.log(`  ${line}`);
  console.log();
  console.log(`  ${style(center('local-first AI video production through OpenRouter', width), DIM, WHITE)}`);
  console.log();
  console.log(frameLine('╭', width, '╮', 'studio console'));
  console.log(fullRow('pipeline', pipeline, width, CYAN));
  console.log(frameLine('├', width, '┤'));
  if (width < 74) {
    console.log(fullRow('model', `${config.model} (${sourceLabel(config)})`, width));
    console.log(fullRow('routing', config.routingPolicy, width));
    console.log(fullRow('video', config.defaultVideoModel, width));
    console.log(fullRow('image', config.defaultImageModel, width));
    console.log(fullRow('voice', `${config.ttsModel} / ${config.ttsVoice}`, width));
    console.log(fullRow('music', config.musicModel, width));
    console.log(fullRow('budget', budgetLabel(config), width));
    console.log(fullRow('key', key.text, width, key.color));
  } else {
    console.log(detailRow('model', `${config.model} (${sourceLabel(config)})`, 'routing', config.routingPolicy, width));
    console.log(detailRow('video', config.defaultVideoModel, 'image', config.defaultImageModel, width));
    console.log(detailRow('voice', `${config.ttsModel} / ${config.ttsVoice}`, 'music', config.musicModel, width));
    console.log(detailRow('budget', budgetLabel(config), 'key', key.text, width, WHITE, key.color));
  }
  console.log(frameLine('╰', width, '╯'));
  console.log();
}

export function printTryBrief(): void {
  console.log(`${BOLD}Try${RESET}`);
  console.log(`  Create a 45-second vertical noir trailer for a luxury espresso machine: rain on glass, macro chrome, whispered narration, jazz-club percussion, and a final hero shot that feels like a midnight heist.`);
  console.log();
}

export function printModelHint(model: string): void {
  console.log(`${DIM}model${RESET} ${CYAN}${model}${RESET} ${DIM}· type "model" to switch${RESET}\n`);
}
