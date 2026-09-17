import { fail } from '../../shared/errors.js';
import type {
  AuthorizationDecision,
  JsonObject,
  JsonValue,
  ObligationSet,
  ToolDefinition,
} from '../../shared/types.js';

export interface ToolInputValidator {
  validate(schema: JsonObject, input: JsonValue): input is JsonObject;
}

export interface ToolPolicyEvaluation {
  readonly requestedInput: JsonObject;
  readonly effectiveInput: JsonObject;
  readonly requiresApproval: boolean;
  readonly policyVersion: string;
  readonly approverConstraint?: string;
}

export interface RetryContext {
  readonly attempt: number;
  readonly idempotencyKey?: string;
  readonly outcomeKnown: boolean;
}

export class ToolExecutionPolicy {
  private readonly validator: ToolInputValidator;

  constructor(validator: ToolInputValidator) {
    this.validator = validator;
  }

  evaluate(
    definition: ToolDefinition,
    requestedInput: JsonValue,
    decision: AuthorizationDecision,
  ): ToolPolicyEvaluation {
    if (!definition.enabled) {
      fail('TOOL_ERROR', 'Tool is disabled');
    }
    if (!this.validator.validate(definition.inputSchema, requestedInput)) {
      fail('VALIDATION_ERROR', 'Tool input does not match its schema');
    }
    if (decision.effect === 'DENY') {
      fail('AUTHORIZATION_DENIED', 'Tool authorization was denied');
    }

    const obligations = decision.obligations;
    const effectiveInput = applyObligations(requestedInput, obligations);
    const requiresApproval =
      decision.effect === 'REQUIRE_APPROVAL' ||
      obligations?.requireApproval === true;
    if (requiresApproval && decision.approverConstraint === undefined) {
      fail(
        'AUTHORIZATION_DENIED',
        'Approval requirement has no approver constraint',
      );
    }
    if (!this.validator.validate(definition.inputSchema, effectiveInput)) {
      fail('AUTHORIZATION_DENIED', 'Policy produced invalid Tool input');
    }

    return {
      requestedInput,
      effectiveInput,
      requiresApproval,
      policyVersion: decision.policyVersion,
      ...(decision.approverConstraint === undefined
        ? {}
        : { approverConstraint: decision.approverConstraint }),
    };
  }

  assertRetryAllowed(definition: ToolDefinition, context: RetryContext): void {
    if (context.attempt < 1) {
      fail('VALIDATION_ERROR', 'Tool attempt must be positive');
    }
    if (
      definition.operationType !== 'read' &&
      definition.idempotencyCapability === 'required' &&
      context.idempotencyKey === undefined
    ) {
      fail('VALIDATION_ERROR', 'Write Tool requires an idempotency key');
    }
    if (
      context.attempt > 1 &&
      definition.operationType !== 'read' &&
      definition.idempotencyCapability === 'unsupported'
    ) {
      fail('TOOL_ERROR', 'Non-idempotent Tool cannot be retried');
    }
    if (!context.outcomeKnown && context.attempt > 1) {
      fail('UNKNOWN_OUTCOME', 'Tool outcome is unknown; retry is not safe');
    }
  }

  assertResultSize(definition: ToolDefinition, resultBytes: number): void {
    if (resultBytes > definition.maxResultBytes) {
      fail('TOOL_ERROR', 'Tool result exceeds the configured size limit');
    }
  }
}

function applyObligations(
  requestedInput: JsonObject,
  obligations: ObligationSet | undefined,
): JsonObject {
  if (obligations === undefined) {
    return requestedInput;
  }

  const effective: Record<string, JsonValue> = { ...requestedInput };
  for (const [key, value] of Object.entries(
    obligations.forceParameters ?? {},
  )) {
    effective[key] = value;
  }

  if (obligations.maxRows !== undefined) {
    effective['limit'] = applyMaximum(
      effective['limit'],
      obligations.maxRows,
      'limit',
    );
  }
  if (obligations.maxTimeRangeMs !== undefined) {
    effective['timeRangeMs'] = applyMaximum(
      effective['timeRangeMs'],
      obligations.maxTimeRangeMs,
      'timeRangeMs',
    );
  }
  for (const [key, value] of Object.entries(obligations.resourceScope ?? {})) {
    effective[key] = value;
  }

  for (const [key, values] of Object.entries(obligations.allowedValues ?? {})) {
    const value = effective[key];
    if (value !== undefined && !values.some((allowed) => allowed === value)) {
      fail('AUTHORIZATION_DENIED', `Parameter ${key} is outside its policy`);
    }
  }

  for (const [key, values] of Object.entries(obligations.deniedValues ?? {})) {
    const value = effective[key];
    if (value !== undefined && values.some((denied) => denied === value)) {
      fail('AUTHORIZATION_DENIED', `Parameter ${key} is denied by policy`);
    }
  }

  return effective;
}

function applyMaximum(
  value: JsonValue | undefined,
  maximum: number,
  parameter: string,
): number {
  if (!Number.isFinite(maximum) || maximum < 0) {
    fail('AUTHORIZATION_DENIED', `Policy maximum for ${parameter} is invalid`);
  }
  if (value === undefined) {
    return maximum;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('AUTHORIZATION_DENIED', `Parameter ${parameter} is invalid`);
  }
  return Math.min(value, maximum);
}
