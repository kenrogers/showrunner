import { existsSync } from 'node:fs';
import { readFile, stat, watch } from 'node:fs/promises';

const POINTER = '.showrunner/latest-session.json';

async function main(): Promise<void> {
  if (!existsSync(POINTER)) throw new Error(`No session pointer found at ${POINTER}. Start Showrunner first.`);
  const pointer = JSON.parse(await readFile(POINTER, 'utf-8')) as { path?: unknown };
  if (typeof pointer.path !== 'string') throw new Error(`${POINTER} does not contain a session path.`);
  const path = pointer.path;
  console.log(`Observing ${path}\n`);

  let offset = 0;
  if (existsSync(path)) {
    const content = await readFile(path, 'utf-8');
    offset = Buffer.byteLength(content);
    process.stdout.write(content);
  }

  for await (const _event of watch(path)) {
    const info = await stat(path);
    if (info.size <= offset) continue;
    const content = await readFile(path, 'utf-8');
    const next = content.slice(offset);
    offset = Buffer.byteLength(content);
    process.stdout.write(next);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
