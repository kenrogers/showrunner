const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const WAVE = ['\x1b[38;5;245m', '\x1b[38;5;250m', '\x1b[38;5;255m', '\x1b[38;5;250m'];

export class Loader {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | undefined;
  private readonly text: string;

  constructor(text = 'Preparing the production') {
    this.text = text;
  }

  start(): void {
    if (this.interval) return;
    this.frame = 0;
    this.interval = setInterval(() => this.draw(), 90);
    this.draw();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
    process.stdout.write('\r\x1b[K');
  }

  private draw(): void {
    const spin = FRAMES[this.frame % FRAMES.length];
    let shimmer = '';
    for (let i = 0; i < this.text.length; i++) {
      shimmer += WAVE[(this.frame + i) % WAVE.length] + this.text[i];
    }
    process.stdout.write(`\r${DIM}${spin}${RESET} ${shimmer}${RESET}`);
    this.frame++;
  }
}
