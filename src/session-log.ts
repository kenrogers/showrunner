import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfig } from './config.js';

export interface SessionLog {
  id: string;
  path: string;
  write: (type: string, data?: unknown) => Promise<void>;
}

export async function createSessionLog(config: AgentConfig): Promise<SessionLog> {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = join('.showrunner', 'sessions');
  const path = join(dir, `${id}.jsonl`);
  await mkdir(dir, { recursive: true });
  await writeFile('.showrunner/latest-session.json', `${JSON.stringify({ id, path }, null, 2)}\n`);

  const log: SessionLog = {
    id,
    path,
    write: async (type, data) => {
      const event = {
        ts: new Date().toISOString(),
        type,
        data: sanitize(data),
      };
      await appendFile(path, `${JSON.stringify(event)}\n`);
    },
  };

  await log.write('session_start', {
    pid: process.pid,
    cwd: process.cwd(),
    model: config.model,
    threadPath: config.threadPath,
    productionRoot: config.productionRoot,
    webSearchEnabled: config.webSearchEnabled,
  });
  return log;
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitize);
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/api.?key|authorization|token|secret/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = sanitize(raw);
    }
  }
  return output;
}

function truncate(value: string, max = 16000): string {
  return value.length > max ? `${value.slice(0, max)}\n[truncated ${value.length - max} chars]` : value;
}
