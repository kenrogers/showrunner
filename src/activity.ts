import { randomUUID } from 'node:crypto';
import type { Stage } from './domain/schema.js';

export type ProductionActivityKind =
  | 'run'
  | 'stage'
  | 'model'
  | 'progress'
  | 'artifact'
  | 'cost'
  | 'approval'
  | 'blocked'
  | 'complete';

export type ProductionActivityLevel = 'info' | 'success' | 'warning' | 'error';

export interface ProductionActivitySubject {
  type: 'Production' | 'Scene' | 'Shot' | 'Take' | 'Reference' | 'Sound Element' | 'Assembly' | 'Export' | 'Approval' | 'Model';
  id?: string;
  label?: string;
}

export interface ProductionActivityProgress {
  label: string;
  current?: number;
  total?: number;
}

export interface ProductionActivityEvent {
  id: string;
  ts: string;
  kind: ProductionActivityKind;
  level: ProductionActivityLevel;
  title: string;
  detail?: string;
  productionId?: string;
  stage?: Stage;
  subject?: ProductionActivitySubject;
  progress?: ProductionActivityProgress;
  model?: string;
  costUsd?: number;
  artifactPath?: string;
}

export type ProductionActivityInput = Omit<ProductionActivityEvent, 'id' | 'ts' | 'level'> & {
  level?: ProductionActivityLevel;
};

export interface ProductionActivitySink {
  emit(input: ProductionActivityInput): ProductionActivityEvent;
}

export function createProductionActivitySink(
  onEvent: (event: ProductionActivityEvent) => void,
): ProductionActivitySink {
  return {
    emit: (input) => {
      const event: ProductionActivityEvent = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        level: input.level ?? 'info',
        ...input,
      };
      onEvent(event);
      return event;
    },
  };
}

export function summarizeActivityEvent(event: ProductionActivityEvent): string {
  const pieces = [
    event.stage ? `[${event.stage}]` : undefined,
    event.title,
    event.detail,
    event.model ? `model ${event.model}` : undefined,
    event.costUsd === undefined ? undefined : `$${event.costUsd.toFixed(4)}`,
    event.artifactPath,
  ].filter(Boolean);
  return pieces.join(' - ');
}
