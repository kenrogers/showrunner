const FALLBACK = '\x1b[48;5;235m';

function blend(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

function isLight(r: number, g: number, b: number): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b > 128;
}

function toAnsi(r: number, g: number, b: number): string {
  const ct = process.env.COLORTERM ?? '';
  if (ct.includes('truecolor') || ct.includes('24bit')) {
    return `\x1b[48;2;${r};${g};${b}m`;
  }
  const ri = Math.round((r / 255) * 5);
  const gi = Math.round((g / 255) * 5);
  const bi = Math.round((b / 255) * 5);
  return `\x1b[48;5;${16 + 36 * ri + 6 * gi + bi}m`;
}

function queryTerminalBg(timeoutMs = 160): Promise<[number, number, number] | null> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      resolve(null);
      return;
    }

    const wasRaw = process.stdin.isRaw;
    let settled = false;
    let buf = '';

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onData = (data: Buffer) => {
      buf += data.toString();
      const match = buf.match(/\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
      if (!match) return;
      cleanup();
      resolve([
        parseInt(match[1].slice(0, 2), 16),
        parseInt(match[2].slice(0, 2), 16),
        parseInt(match[3].slice(0, 2), 16),
      ]);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.write('\x1b]11;?\x07');
  });
}

export async function detectBg(): Promise<string> {
  const bg = await queryTerminalBg();
  if (!bg) return FALLBACK;
  const [r, g, b] = bg;
  const [top, alpha]: [[number, number, number], number] = isLight(r, g, b)
    ? [[0, 0, 0], 0.06]
    : [[255, 255, 255], 0.12];
  const [br, bg2, bb] = blend(top, [r, g, b], alpha);
  return toAnsi(br, bg2, bb);
}
