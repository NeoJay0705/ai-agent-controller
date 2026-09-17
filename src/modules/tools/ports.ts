import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../../shared/types.js';

export interface ToolHandler {
  execute(
    input: JsonObject,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface ToolRegistry {
  register(definition: ToolDefinition, handler: ToolHandler): Promise<void>;
  get(name: string, version: string): Promise<ToolDefinition | null>;
  resolveHandler(name: string, version: string): Promise<ToolHandler | null>;
}

export interface BlobStore {
  putQuarantined(input: {
    readonly objectKey: string;
    readonly content: AsyncIterable<Uint8Array>;
    readonly declaredSize: number;
  }): Promise<void>;
  read(objectKey: string): AsyncIterable<Uint8Array>;
  delete(objectKey: string): Promise<void>;
}

export interface MalwareScanner {
  scan(
    objectKey: string,
    signal: AbortSignal,
  ): Promise<'clean' | 'rejected' | 'failed'>;
}

export interface SecretProvider {
  issue(input: {
    readonly toolName: string;
    readonly tenantId: string;
    readonly deadline: string;
  }): Promise<{ readonly value: string; readonly expiresAt: string }>;
}
