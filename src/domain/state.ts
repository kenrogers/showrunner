import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProductionStateSchema, type ProductionState } from './schema.js';
import type { RoutingPolicy } from '../config.js';

export function createInitialState(options: {
  id?: string;
  title?: string;
  brief: string;
  routingPolicy: RoutingPolicy;
}): ProductionState {
  const now = new Date().toISOString();
  const id = options.id ?? createProductionId(options.title ?? options.brief);
  return {
    production: {
      id,
      title: options.title ?? titleFromBrief(options.brief),
      brief: options.brief,
      stage: 'brief',
      target: { platform: 'social', aspectRatio: '9:16', runtimeSeconds: 24, format: 'mp4' },
      budgetGuardrail: { maxUsd: 12, approvalThresholdUsd: 0.5, spentUsd: 0 },
      autonomyPolicy: { enabled: false, maxUsd: 6, maxTakesPerShot: 2, finalReviewThreshold: 'pass' },
      routing: { policy: options.routingPolicy },
      createdAt: now,
      updatedAt: now,
    },
    scenes: [],
    shots: [],
    referenceSets: [],
    references: [],
    takes: [],
    finishedShots: [],
    takeReviews: [],
    approvals: [],
    assemblies: [],
    soundMixes: [],
    filmPackage: undefined,
    exports: [],
    finalReviews: [],
    costs: [],
    eventLog: ['Production created from natural-language brief.'],
    nextIds: { scene: 1, shot: 1, referenceSet: 1, reference: 1, take: 1, review: 1, approval: 1 },
  };
}

export function productionDir(root: string, state: ProductionState): string {
  return join(root, state.production.id);
}

export function stateFile(dir: string): string {
  return join(dir, 'production.json');
}

export async function saveProductionState(dir: string, state: ProductionState): Promise<void> {
  const parsed = ProductionStateSchema.parse(state);
  await mkdir(dirname(stateFile(dir)), { recursive: true });
  const file = stateFile(dir);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
}

export async function loadProductionState(dir: string): Promise<ProductionState> {
  const content = await readFile(stateFile(dir), 'utf-8');
  return ProductionStateSchema.parse(JSON.parse(content));
}

function createProductionId(input: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const slug = slugify(input).slice(0, 32) || 'production';
  return `prod_${stamp}_${slug}`;
}

function titleFromBrief(brief: string): string {
  const clean = brief.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Untitled Production';
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
