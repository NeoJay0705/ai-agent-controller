import { fail } from '../../shared/errors.js';
import type { Approval } from '../../shared/types.js';
import type { ApprovalRepository } from '../../modules/approvals/ports.js';

/** Test/local adapter. Production uses the PostgreSQL approval repository. */
export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly approvals = new Map<string, Approval>();

  create(tenantId: string, approval: Approval): Promise<Approval> {
    if (approval.tenantId !== tenantId) {
      fail('AUTHORIZATION_DENIED', 'Approval tenant scope does not match');
    }
    if (this.approvals.has(approval.id)) {
      fail('CONFLICT', 'Approval already exists');
    }

    this.approvals.set(approval.id, approval);
    return Promise.resolve(approval);
  }

  get(tenantId: string, approvalId: string): Promise<Approval | null> {
    const approval = this.approvals.get(approvalId);
    return Promise.resolve(
      approval !== undefined && approval.tenantId === tenantId
        ? approval
        : null,
    );
  }

  save(
    tenantId: string,
    approval: Approval,
    expectedStateVersion: number,
  ): Promise<Approval> {
    const current = this.approvals.get(approval.id);
    if (current === undefined || current.tenantId !== tenantId) {
      fail('NOT_FOUND', 'Approval not found');
    }
    if (
      current.stateVersion !== expectedStateVersion ||
      approval.tenantId !== tenantId ||
      approval.stateVersion !== expectedStateVersion + 1
    ) {
      fail('CONFLICT', 'Approval state changed before update');
    }

    this.approvals.set(approval.id, approval);
    return Promise.resolve(approval);
  }
}
