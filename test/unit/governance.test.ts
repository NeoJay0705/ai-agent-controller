import { describe, expect, it } from 'vitest';

import { InMemoryApprovalRepository } from '../../src/infrastructure/memory/in-memory-approval-repository.js';
import { ApprovalService } from '../../src/modules/approvals/approval-service.js';
import { ToolExecutionPolicy } from '../../src/modules/tools/tool-policy.js';
import { UsagePolicy } from '../../src/modules/usage/usage-policy.js';
import type { Clock, IdGenerator } from '../../src/shared/support.js';
import type {
  IdentityContext,
  JsonObject,
  ToolDefinition,
} from '../../src/shared/types.js';

const requester: IdentityContext = {
  subjectId: 'requester',
  tenantId: 'tenant-1',
  roles: [],
  groups: [],
  attributes: {},
};

const approver: IdentityContext = {
  subjectId: 'approver',
  tenantId: 'tenant-1',
  roles: ['approver'],
  groups: [],
  attributes: {},
};

const otherTenantActor: IdentityContext = {
  subjectId: 'other-user',
  tenantId: 'tenant-2',
  roles: ['approver'],
  groups: [],
  attributes: {},
};

const unprivilegedActor: IdentityContext = {
  subjectId: 'unprivileged',
  tenantId: 'tenant-1',
  roles: [],
  groups: [],
  attributes: {},
};

describe('governance policies', () => {
  it('requires approval for a protected Tool and preserves effective input', () => {
    const policy = new ToolExecutionPolicy({
      validate: (_schema, input): input is JsonObject =>
        typeof input === 'object' && input !== null && !Array.isArray(input),
    });
    const result = policy.evaluate(
      toolDefinition,
      { tenant: '*', limit: 1000 },
      {
        effect: 'REQUIRE_APPROVAL',
        policyVersion: 'policy-1',
        approverConstraint: 'role:approver',
        obligations: {
          forceParameters: { tenant: 'tenant-1' },
          maxRows: 100,
          requireApproval: true,
        },
      },
    );

    expect(result.requiresApproval).toBe(true);
    expect(result.approverConstraint).toBe('role:approver');
    expect(result.effectiveInput).toEqual({ tenant: 'tenant-1', limit: 100 });
  });

  it('preserves an approver constraint from ALLOW obligations', () => {
    const policy = new ToolExecutionPolicy({
      validate: (_schema, input): input is JsonObject =>
        typeof input === 'object' && input !== null && !Array.isArray(input),
    });

    const result = policy.evaluate(
      toolDefinition,
      { tenant: 'tenant-1' },
      {
        effect: 'ALLOW',
        policyVersion: 'policy-1',
        approverConstraint: 'role:approver',
        obligations: {
          requireApproval: true,
          maxRows: 100,
          maxTimeRangeMs: 60_000,
        },
      },
    );

    expect(result).toMatchObject({
      requiresApproval: true,
      approverConstraint: 'role:approver',
      effectiveInput: {
        tenant: 'tenant-1',
        limit: 100,
        timeRangeMs: 60_000,
      },
    });
  });

  it('fails closed when approval or effective input policy is incomplete', () => {
    const policy = new ToolExecutionPolicy({
      validate: (_schema, input): input is JsonObject =>
        typeof input === 'object' && input !== null && !Array.isArray(input),
    });

    expect(() =>
      policy.evaluate(
        toolDefinition,
        { tenant: 'tenant-1' },
        {
          effect: 'ALLOW',
          policyVersion: 'policy-1',
          obligations: { requireApproval: true },
        },
      ),
    ).toThrow();

    const strictPolicy = new ToolExecutionPolicy({
      validate: (_schema, input): input is JsonObject =>
        typeof input === 'object' &&
        input !== null &&
        !Array.isArray(input) &&
        typeof input['tenant'] === 'string',
    });
    expect(() =>
      strictPolicy.evaluate(
        toolDefinition,
        { tenant: 'tenant-1' },
        {
          effect: 'ALLOW',
          policyVersion: 'policy-1',
          obligations: { forceParameters: { tenant: 123 } },
        },
      ),
    ).toThrow();
  });

  it('checks final obligation values and rejects invalid policy limits', () => {
    const policy = new ToolExecutionPolicy({
      validate: (_schema, input): input is JsonObject =>
        typeof input === 'object' && input !== null && !Array.isArray(input),
    });

    expectDomainError(
      () =>
        policy.evaluate(
          toolDefinition,
          { tenant: 'tenant-1' },
          {
            effect: 'ALLOW',
            policyVersion: 'policy-1',
            obligations: {
              allowedValues: { tenant: ['tenant-1'] },
              resourceScope: { tenant: 'tenant-2' },
            },
          },
        ),
      'AUTHORIZATION_DENIED',
    );
    expectDomainError(
      () =>
        policy.evaluate(
          toolDefinition,
          { tenant: 'tenant-1' },
          {
            effect: 'ALLOW',
            policyVersion: 'policy-1',
            obligations: {
              deniedValues: { tenant: ['tenant-2'] },
              resourceScope: { tenant: 'tenant-2' },
            },
          },
        ),
      'AUTHORIZATION_DENIED',
    );
    expectDomainError(
      () =>
        policy.evaluate(
          toolDefinition,
          { tenant: 'tenant-1' },
          {
            effect: 'ALLOW',
            policyVersion: 'policy-1',
            obligations: { maxRows: -1 },
          },
        ),
      'AUTHORIZATION_DENIED',
    );
    expectDomainError(
      () =>
        policy.evaluate(
          toolDefinition,
          { tenant: 'tenant-1' },
          {
            effect: 'ALLOW',
            policyVersion: 'policy-1',
            obligations: { maxTimeRangeMs: Number.POSITIVE_INFINITY },
          },
        ),
      'AUTHORIZATION_DENIED',
    );
  });

  it('rejects quota admission and over-budget Run usage', () => {
    const policy = new UsagePolicy();

    expect(() => {
      policy.assertAdmission({
        rateAllowed: true,
        counters: {
          activeUserRuns: 1,
          activeTenantRuns: 1,
          userTokens: 0,
          tenantTokens: 0,
          userRuns: 0,
          tenantRuns: 0,
        },
        limits: { maxConcurrentUserRuns: 1 },
      });
    }).toThrow();

    expect(() => {
      policy.assertRunBudget(
        { maxOutputTokens: 10 },
        {
          llmCalls: 1,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 9,
          cost: 0,
          durationMs: 0,
        },
        { outputTokens: 2 },
      );
    }).toThrow();
  });

  it('does not allow requester self-approval by default', async () => {
    let id = 0;
    const clock: Clock = {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    };
    const ids: IdGenerator = { next: () => `approval-${String(id++)}` };
    const service = new ApprovalService({
      repository: new InMemoryApprovalRepository(),
      clock,
      ids,
      isAuthorizedApprover: () => Promise.resolve(true),
    });
    const approval = await service.create({
      requesterSubjectId: requester.subjectId,
      snapshot: {
        tenantId: requester.tenantId,
        runId: 'run-1',
        toolCallId: 'tool-call-1',
        toolName: 'order.refund',
        toolVersion: '1.0.0',
        effectiveInput: { orderId: '123' },
        policyVersion: 'policy-1',
      },
      approverConstraint: 'role:approver',
      expiresAt: '2026-01-01T01:00:00.000Z',
    });

    await expect(
      service.decide(approval.id, requester, 'approve'),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  });

  it('authorizes idempotent decisions and binds execution snapshots', async () => {
    let id = 0;
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock: Clock = { now: () => new Date(now) };
    const repository = new InMemoryApprovalRepository();
    const service = new ApprovalService({
      repository,
      clock,
      ids: { next: () => `approval-${String(id++)}` },
      isAuthorizedApprover: (actor) =>
        Promise.resolve(actor.roles.includes('approver')),
    });
    const snapshot = createSnapshot();
    const approval = await service.create({
      requesterSubjectId: requester.subjectId,
      snapshot,
      approverConstraint: 'role:approver',
      expiresAt: '2026-01-01T01:00:00.000Z',
    });

    await expect(service.get(requester, approval.id)).resolves.toMatchObject({
      id: approval.id,
    });
    await expect(
      service.get(otherTenantActor, approval.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const approved = await service.decide(approval.id, approver, 'approve');
    await expect(
      service.decide(approval.id, approver, 'approve'),
    ).resolves.toMatchObject({ status: 'APPROVED' });
    await expect(
      service.decide(approval.id, requester, 'approve'),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(
      service.decide(approval.id, unprivilegedActor, 'approve'),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(
      service.decide(approval.id, otherTenantActor, 'approve'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.decide(approval.id, approver, 'reject'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expectDomainError(
      () =>
        repository.save(
          requester.tenantId,
          {
            ...approval,
            status: 'REJECTED',
            stateVersion: approval.stateVersion + 1,
            decidedAt: '2026-01-01T00:30:00.000Z',
          },
          approval.stateVersion,
        ),
      'CONFLICT',
    );
    await expect(
      repository.get(requester.tenantId, approved.id),
    ).resolves.toMatchObject({ status: 'APPROVED', stateVersion: 1 });

    await expect(
      service.assertExecutable(approved.id, {
        ...snapshot,
        runId: 'different-run',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(
      service.assertExecutable(approved.id, {
        ...snapshot,
        toolCallId: 'different-tool-call',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    now = Date.parse('2026-01-01T02:00:00.000Z');
    await expect(
      service.assertExecutable(approved.id, snapshot),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    await expect(
      repository.get(requester.tenantId, approved.id),
    ).resolves.toMatchObject({ status: 'APPROVED', stateVersion: 1 });
  });
});

function expectDomainError(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected DomainError with code ${code}`);
}

function createSnapshot() {
  return {
    tenantId: requester.tenantId,
    runId: 'run-1',
    toolCallId: 'tool-call-1',
    toolName: 'order.refund',
    toolVersion: '1.0.0',
    effectiveInput: { orderId: '123' },
    policyVersion: 'policy-1',
  };
}

const toolDefinition: ToolDefinition = {
  name: 'order.refund',
  version: '1.0.0',
  description: 'Refund an order',
  inputSchema: { type: 'object' },
  riskLevel: 'high',
  operationType: 'write',
  idempotencyCapability: 'required',
  sideEffectSemantics: 'irreversible',
  authorizationPolicy: 'order.refund',
  timeoutMs: 5_000,
  maxResultBytes: 16_384,
  enabled: true,
};
