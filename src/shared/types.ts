export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type DataClassification =
  'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export interface IdentityContext {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly groups: readonly string[];
  readonly attributes: Readonly<Record<string, JsonValue>>;
}

export type SessionStatus = 'ACTIVE' | 'DELETING' | 'DELETED';

export interface Session {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerSubjectId: string;
  readonly agentId: string;
  readonly configurationVersion: string;
  readonly status: SessionStatus;
  readonly nextMessageSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly receivedAt: string;
  readonly appliedAt?: string;
}

export type RunStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'WAITING_USER_INPUT'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'LIMIT_EXCEEDED';

export interface RunBudget {
  readonly maxDurationMs?: number;
  readonly maxLlmCalls?: number;
  readonly maxToolCalls?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxCost?: number;
}

export interface Run {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly stateVersion: number;
  readonly configurationVersion: string;
  readonly budget: RunBudget;
  readonly cancelRequestedAt?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RunEventType =
  | 'run_started'
  | 'text_delta'
  | 'tool_started'
  | 'tool_completed'
  | 'waiting_user'
  | 'waiting_approval'
  | 'user_message_received'
  | 'user_message_applied'
  | 'generation_interrupted'
  | 'run_completed'
  | 'run_failed'
  | 'usage_update';

export interface RunEvent {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly payload: JsonObject;
  readonly occurredAt: string;
}

export type OperationType = 'read' | 'write' | 'delete' | 'external_action';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type IdempotencyCapability = 'required' | 'supported' | 'unsupported';
export type SideEffectSemantics = 'none' | 'reversible' | 'irreversible';

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly riskLevel: RiskLevel;
  readonly operationType: OperationType;
  readonly idempotencyCapability: IdempotencyCapability;
  readonly sideEffectSemantics: SideEffectSemantics;
  readonly authorizationPolicy: string;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly enabled: boolean;
}

export interface ToolExecutionContext {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly identity: IdentityContext;
  readonly traceId: string;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly status: 'success' | 'partial' | 'denied' | 'error';
  readonly data?: JsonValue;
  readonly metadata: {
    readonly rowCount?: number;
    readonly truncated?: boolean;
    readonly dataClassification?: readonly DataClassification[];
    readonly durationMs?: number;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface AuthorizationRequest {
  readonly identity: IdentityContext;
  readonly action: string;
  readonly resource?: JsonObject;
  readonly input: JsonObject;
  readonly environment?: JsonObject;
}

export interface ObligationSet {
  readonly forceParameters?: Readonly<Record<string, JsonValue>>;
  readonly allowedValues?: Readonly<Record<string, readonly JsonValue[]>>;
  readonly deniedValues?: Readonly<Record<string, readonly JsonValue[]>>;
  readonly maxRows?: number;
  readonly maxTimeRangeMs?: number;
  readonly resourceScope?: JsonObject;
  readonly maskFields?: readonly string[];
  readonly removeFields?: readonly string[];
  readonly maxResultSize?: number;
  readonly requireApproval?: boolean;
}

export type AuthorizationDecision =
  | {
      readonly effect: 'ALLOW';
      readonly policyVersion: string;
      readonly obligations?: ObligationSet;
      readonly approverConstraint?: string;
    }
  | {
      readonly effect: 'DENY';
      readonly policyVersion: string;
      readonly reasonCode: string;
    }
  | {
      readonly effect: 'REQUIRE_APPROVAL';
      readonly policyVersion: string;
      readonly obligations?: ObligationSet;
      readonly approverConstraint: string;
    };

export interface ApprovalSnapshot {
  readonly tenantId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly resource?: JsonObject;
  readonly effectiveInput: JsonObject;
  readonly policyVersion: string;
}

export type ApprovalStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface Approval {
  readonly id: string;
  readonly requesterSubjectId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly resource?: JsonObject;
  readonly effectiveInput: JsonObject;
  readonly policyVersion: string;
  readonly snapshotHash: string;
  readonly approverConstraint: string;
  readonly status: ApprovalStatus;
  readonly stateVersion: number;
  readonly approvedBySubjectId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
}

export type AttachmentStatus =
  | 'PENDING_UPLOAD'
  | 'PENDING_SCAN'
  | 'PROCESSING'
  | 'AVAILABLE'
  | 'REJECTED'
  | 'PROCESSING_FAILED'
  | 'DELETING'
  | 'DELETED';

export interface Attachment {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerSubjectId: string;
  readonly sessionId: string;
  readonly size: number;
  readonly mediaType: string;
  readonly hash: string;
  readonly dataClassification?: DataClassification;
  readonly scanStatus: 'pending' | 'clean' | 'rejected' | 'failed';
  readonly status: AttachmentStatus;
  readonly stateVersion: number;
  readonly objectKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UsageSnapshot {
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly durationMs: number;
}
