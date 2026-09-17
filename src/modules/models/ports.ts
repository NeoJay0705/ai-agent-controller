import type {
  DataClassification,
  JsonObject,
  JsonValue,
} from '../../shared/types.js';

export interface ModelDefinition {
  readonly provider: string;
  readonly modelId: string;
  readonly capabilities: readonly string[];
  readonly contextLimit: number;
  readonly pricing: JsonObject;
  readonly dataPolicy: readonly DataClassification[];
  readonly enabled: boolean;
}

export interface ModelRequest {
  readonly model: ModelDefinition;
  readonly messages: readonly JsonObject[];
  readonly tools?: readonly JsonObject[];
  readonly dataClassifications: readonly DataClassification[];
  readonly deadline: string;
}

export type ModelEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_request'; readonly call: JsonObject }
  | {
      readonly type: 'completed';
      readonly usage: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly cost: number;
      };
    };

export interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export function modelCanReceive(
  model: ModelDefinition,
  classifications: readonly DataClassification[],
): boolean {
  return classifications.every((classification) =>
    model.dataPolicy.includes(classification),
  );
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }
  if (typeof value === 'object') {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }
  return false;
}
