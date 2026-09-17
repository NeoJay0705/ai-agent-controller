import type { JsonObject } from '../../shared/types.js';

export interface AuditRecordInput {
  readonly tenantId: string;
  readonly subjectId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly action: string;
  readonly resource?: JsonObject;
  readonly status: string;
  readonly policyVersion?: string;
  readonly metadata: JsonObject;
  readonly occurredAt: string;
}

export interface AuditSink {
  append(record: AuditRecordInput): Promise<void>;
}
