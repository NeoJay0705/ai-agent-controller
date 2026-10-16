import { ControllerStore, DomainError } from '../controller/store.js';
import type { JobStatus } from '../controller/types.js';
import {
  createInitialExecutionState,
  flowExecutionStateJson,
  parseFlowExecutionState,
  type FlowExecutionState,
  type FlowInputRecord,
} from './execution-types.js';
import { effectiveNodeLimits, FlowRegistry } from './registry.js';
import { validateAgentNodeResult } from './types.js';
import type {
  AgentNodeResult,
  FlowBundle,
  FlowDefinition,
  JsonValue,
  NodeDefinition,
} from './types.js';
import type { FlowRegistryOptions } from './registry.js';

const MAX_STORED_JSON_CHARS = 1_000_000;
const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+\S+/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SECRET_KEYS = /^(?:api[_-]?key|token|secret|password)$/i;

export interface FlowStoreOptions {
  readonly now?: () => number;
  readonly registryOptions?: FlowRegistryOptions;
}

export interface FlowRun {
  readonly jobId: string;
  readonly bundle: FlowBundle;
  readonly flowId: string;
  readonly nodeId: string;
  readonly state: JsonValue;
  readonly revision: number;
  readonly transitions: number;
  readonly promptGeneration: number;
  readonly waitDeadline: number | null;
  readonly jobDeadline: number | null;
}

export interface SessionFact {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly value: JsonValue;
  readonly source: JsonValue;
  readonly flowVersion: string | null;
  readonly bankVersion: string | null;
  readonly createdAt: number;
  readonly provenance: 'user_confirmed';
}

export interface SessionFactWrite {
  readonly kind: string;
  readonly value: JsonValue;
  readonly source: JsonValue;
  readonly flowVersion?: string | null;
  readonly bankVersion?: string | null;
  readonly confirmed: true;
}

export interface PiIdentity {
  readonly piSessionId: string;
  readonly filePath: string;
}

export interface SteeringCapture {
  readonly id: string;
  readonly sequence: number;
}

export interface PendingSteering extends SteeringCapture {
  readonly content: string;
  readonly receivedAt: number;
}

export interface FlowJobContext {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerId: string;
  readonly chatId: string;
  readonly sequence: number;
  readonly input: string;
  readonly status: JobStatus;
  readonly startedAt: number | null;
  readonly deadlineAt: number | null;
  readonly queuedMessageId: string;
  readonly queuedMessageSequence: number;
}

export interface ReservedFlowJob {
  readonly jobId: string;
  readonly sessionId: string;
  readonly deadlineAt: number;
}

export type FlowStepOutcome = 'run' | 'wait' | 'complete' | 'fail';

export interface FlowStepInput {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly currentNodeId: string;
  readonly agentResult?: AgentNodeResult;
  readonly transition?: string;
  readonly target?: { readonly flowId: string; readonly nodeId: string };
  readonly state: JsonValue;
  readonly outcome: FlowStepOutcome;
  readonly waitPrompt?: string;
  readonly notificationText?: string;
  readonly failureCode?: string;
  readonly facts?: readonly SessionFactWrite[];
}

export type FlowStepResult =
  | { readonly status: 'committed'; readonly run: FlowRun }
  | { readonly status: 'dirty'; readonly run: FlowRun }
  | { readonly status: 'stale'; readonly run: FlowRun | null };

/**
 * Additive Flow persistence over the ControllerStore's SQLite connection.
 * Every write callback is synchronous. Model, network, and other async work
 * must finish before calling a write method.
 */
export class FlowStore {
  private readonly store: ControllerStore;
  private readonly registry: FlowRegistry;
  private readonly registryOptions: FlowRegistryOptions;
  private readonly now: () => number;
  private savepointCounter = 0;

  constructor(
    store: ControllerStore,
    registry: FlowRegistry,
    options: FlowStoreOptions = {},
  ) {
    this.store = store;
    this.registry = registry;
    this.registryOptions = options.registryOptions ?? {};
    this.now = options.now ?? Date.now;
  }

  transaction<T>(callback: () => T): T {
    const database = this.store.database;
    if (!database.isTransaction) {
      return this.store.transaction(() => runSynchronous(callback));
    }
    const savepoint = `flow_nested_${String(++this.savepointCounter)}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = runSynchronous(callback);
      database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
      } catch {
        // Preserve the original Flow operation error.
      }
      throw error;
    }
  }

  getPinnedFlowRun(jobId: string): FlowRun | null {
    const row = this.store.database
      .prepare('SELECT * FROM flow_runs WHERE job_id=?')
      .get(jobId) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.mapFlowRun(row);
  }

  getJobContext(jobId: string): FlowJobContext | null {
    const row = this.store.database
      .prepare(
        `SELECT j.id, j.session_id, j.owner_id, j.chat_id, j.sequence, j.input,
                j.status, j.started_at, j.deadline_at, m.id AS queued_message_id,
                m.sequence AS queued_sequence
         FROM jobs j JOIN messages m ON m.job_id=j.id AND m.kind='queued'
         WHERE j.id=?`,
      )
      .get(jobId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      id: asString(row['id'], 'job ID'),
      sessionId: asString(row['session_id'], 'job session ID'),
      ownerId: asString(row['owner_id'], 'job owner ID'),
      chatId: asString(row['chat_id'], 'job chat ID'),
      sequence: asInteger(row['sequence'], 'job sequence'),
      input: asString(row['input'], 'job input'),
      status: asJobStatus(row['status']),
      startedAt: nullableInteger(row['started_at'], 'job start time'),
      deadlineAt: nullableInteger(row['deadline_at'], 'job deadline'),
      queuedMessageId: asString(row['queued_message_id'], 'queued message ID'),
      queuedMessageSequence: asInteger(
        row['queued_sequence'],
        'queued sequence',
      ),
    };
  }

  getSessionNextSequence(sessionId: string): number {
    const row = this.store.database
      .prepare('SELECT next_sequence FROM sessions WHERE id=?')
      .get(sessionId) as { next_sequence?: unknown } | undefined;
    if (row === undefined)
      throw new DomainError('NOT_FOUND', 'Controller Session not found.');
    return asInteger(row.next_sequence, 'session next sequence');
  }

  getOrCreatePinnedFlowRun(
    jobId: string,
    flowId: string,
    initialState: JsonValue = {},
  ): FlowRun {
    return this.transaction(() => {
      const existing = this.getPinnedFlowRun(jobId);
      if (existing !== null) {
        if (existing.flowId !== flowId) {
          throw new DomainError(
            'FLOW_ALREADY_PINNED',
            'This Job already has a pinned Flow.',
          );
        }
        return existing;
      }
      const flow = this.registry.get(flowId);
      if (flow === undefined) {
        throw new DomainError('FLOW_NOT_FOUND', 'The Flow is not registered.');
      }
      const job = this.store.database
        .prepare('SELECT status, deadline_at FROM jobs WHERE id=?')
        .get(jobId) as { status?: unknown; deadline_at?: unknown } | undefined;
      if (job === undefined)
        throw new DomainError('NOT_FOUND', 'Job not found.');
      const status = asJobStatus(job.status);
      if (status === 'COMPLETED' || status === 'FAILED') {
        throw new DomainError('TERMINAL', 'That job has already finished.');
      }
      const stateJson = serializeSafeJson(initialState, 'Flow state');
      const bundleJson = serializeSafeJson(
        this.registry.snapshot(),
        'Flow snapshot',
      );
      const now = this.now();
      const existingDeadline = nullableInteger(job.deadline_at, 'job deadline');
      const jobDeadline =
        existingDeadline === null
          ? now + flow.limits.jobTimeoutMs
          : Math.min(existingDeadline, now + flow.limits.jobTimeoutMs);
      this.store.database
        .prepare(
          `INSERT INTO flow_runs(job_id, bundle_json, flow_id, node_id, state_json,
                                 revision, transitions, prompt_generation, wait_deadline, job_deadline)
           VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL, ?)`,
        )
        .run(
          jobId,
          bundleJson,
          flow.id,
          flow.entryNode,
          stateJson,
          jobDeadline,
        );
      this.store.database
        .prepare(
          'UPDATE jobs SET deadline_at=CASE WHEN deadline_at IS NULL THEN ? ELSE MIN(deadline_at, ?) END WHERE id=?',
        )
        .run(jobDeadline, jobDeadline, jobId);
      const created = this.getPinnedFlowRun(jobId);
      if (created === null) throw new Error('Pinned Flow was not stored.');
      return created;
    });
  }

  getControllerSessionName(sessionId: string): string {
    const row = this.store.database
      .prepare('SELECT name FROM sessions WHERE id=?')
      .get(sessionId) as { name?: unknown } | undefined;
    if (row === undefined)
      throw new DomainError('NOT_FOUND', 'Controller Session not found.');
    return asString(row.name, 'session name');
  }

  getSessionFact(
    sessionId: string,
    ownerId: string,
    kind: string,
  ): SessionFact | null {
    const row = this.store.database
      .prepare(
        `SELECT session_id, owner_id, kind, value_json, source_json, flow_version,
                bank_version, created_at, provenance
         FROM session_facts
         WHERE session_id=? AND owner_id=? AND kind=? AND provenance='user_confirmed'`,
      )
      .get(sessionId, ownerId, kind) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.mapFact(row);
  }

  getSessionFacts(sessionId: string, ownerId: string): readonly SessionFact[] {
    const rows = this.store.database
      .prepare(
        `SELECT session_id, owner_id, kind, value_json, source_json, flow_version,
                bank_version, created_at, provenance
         FROM session_facts
         WHERE session_id=? AND owner_id=? AND provenance='user_confirmed'
         ORDER BY kind`,
      )
      .all(sessionId, ownerId) as Record<string, unknown>[];
    return rows.map((row) => this.mapFact(row));
  }

  saveSessionFact(
    sessionId: string,
    ownerId: string,
    fact: SessionFactWrite,
  ): SessionFact {
    return this.transaction(() => {
      this.writeFacts(sessionId, ownerId, [fact]);
      const saved = this.getSessionFact(sessionId, ownerId, fact.kind);
      if (saved === null) throw new Error('Confirmed fact was not stored.');
      return saved;
    });
  }

  getPiIdentity(sessionId: string): PiIdentity | null {
    const row = this.store.database
      .prepare(
        'SELECT pi_session_id, file_path FROM pi_sessions WHERE session_id=?',
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      piSessionId: asString(row['pi_session_id'], 'Pi session ID'),
      filePath: asString(row['file_path'], 'Pi session file path'),
    };
  }

  savePiIdentity(sessionId: string, identity: PiIdentity): PiIdentity {
    if (
      identity.piSessionId.length === 0 ||
      identity.filePath.length === 0 ||
      identity.piSessionId.length > 128 ||
      identity.filePath.length > 4096 ||
      containsCredential(identity.piSessionId) ||
      containsCredential(identity.filePath)
    ) {
      throw new DomainError(
        'PI_IDENTITY_INVALID',
        'Pi Session identity is invalid.',
      );
    }
    return this.transaction(() => {
      const existing = this.getPiIdentity(sessionId);
      if (existing !== null) {
        if (
          existing.piSessionId !== identity.piSessionId ||
          existing.filePath !== identity.filePath
        ) {
          throw new DomainError(
            'PI_IDENTITY_CONFLICT',
            'Controller Session already maps to a different Pi Session.',
          );
        }
        return existing;
      }
      try {
        this.store.database
          .prepare(
            'INSERT INTO pi_sessions(session_id, pi_session_id, file_path) VALUES (?, ?, ?)',
          )
          .run(sessionId, identity.piSessionId, identity.filePath);
      } catch {
        throw new DomainError(
          'PI_IDENTITY_CONFLICT',
          'Pi Session identity is already mapped.',
        );
      }
      return identity;
    });
  }

  getPendingSteering(jobId: string): readonly PendingSteering[] {
    const rows = this.store.database
      .prepare(
        `SELECT id, sequence, content, received_at FROM messages
         WHERE job_id=? AND kind='steering' AND steering_state='pending'
         ORDER BY sequence`,
      )
      .all(jobId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row['id'], 'steering ID'),
      sequence: asInteger(row['sequence'], 'steering sequence'),
      content: asString(row['content'], 'steering content'),
      receivedAt: asInteger(row['received_at'], 'steering received time'),
    }));
  }

  reserveReadyJobs(
    now: number,
    slots: number,
    excludedSessionIds: ReadonlySet<string> = new Set(),
    canReserve: (
      ownerId: string,
      sessionId: string,
      jobId: string,
    ) => boolean = () => true,
  ): readonly ReservedFlowJob[] {
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(slots) ||
      slots < 0
    ) {
      throw new TypeError('Flow reservation limits are invalid.');
    }
    if (slots === 0) return [];
    return this.transaction(() => {
      const occupied = new Set(excludedSessionIds);
      const reserved: ReservedFlowJob[] = [];
      const waiting = this.store.database
        .prepare(
          `SELECT j.id, j.session_id, j.owner_id FROM jobs j
           WHERE j.status='WAITING_INPUT'
             AND EXISTS (SELECT 1 FROM messages m WHERE m.job_id=j.id
                         AND m.kind='steering' AND m.steering_state='pending')
             AND (j.deadline_at IS NULL OR j.deadline_at>?)
             AND NOT EXISTS (SELECT 1 FROM flow_runs f WHERE f.job_id=j.id
                             AND f.wait_deadline IS NOT NULL AND f.wait_deadline<=?)
           ORDER BY j.created_at, j.sequence`,
        )
        .all(now, now) as {
        id: unknown;
        session_id: unknown;
        owner_id: unknown;
      }[];
      for (const row of waiting) {
        if (reserved.length >= slots) break;
        const jobId = asString(row.id, 'job ID');
        const sessionId = asString(row.session_id, 'job session ID');
        const ownerId = asString(row.owner_id, 'job owner ID');
        if (occupied.has(sessionId) || !canReserve(ownerId, sessionId, jobId))
          continue;
        const run = this.getPinnedFlowRun(jobId);
        if (run === null) continue;
        const changed = this.store.database
          .prepare(
            "UPDATE jobs SET status='RUNNING', updated_at=? WHERE id=? AND status='WAITING_INPUT'",
          )
          .run(now, jobId);
        if (changed.changes !== 1) continue;
        this.store.database
          .prepare('UPDATE flow_runs SET wait_deadline=NULL WHERE job_id=?')
          .run(jobId);
        occupied.add(sessionId);
        reserved.push({
          jobId,
          sessionId,
          deadlineAt: run.jobDeadline ?? Number.MAX_SAFE_INTEGER,
        });
      }

      if (reserved.length < slots) {
        const queued = this.store.database
          .prepare(
            `SELECT j.id, j.session_id, j.owner_id, j.input, j.deadline_at
             FROM jobs j WHERE j.status='QUEUED'
               AND NOT EXISTS (SELECT 1 FROM jobs active
                 WHERE active.session_id=j.session_id
                   AND active.status IN ('RUNNING','WAITING_INPUT','CANCELLING'))
               AND NOT EXISTS (SELECT 1 FROM jobs earlier
                 WHERE earlier.session_id=j.session_id AND earlier.status='QUEUED'
                   AND earlier.sequence<j.sequence)
             ORDER BY j.created_at, j.sequence`,
          )
          .all() as Record<string, unknown>[];
        for (const row of queued) {
          if (reserved.length >= slots) break;
          const jobId = asString(row['id'], 'job ID');
          const sessionId = asString(row['session_id'], 'job session ID');
          const ownerId = asString(row['owner_id'], 'job owner ID');
          if (occupied.has(sessionId) || !canReserve(ownerId, sessionId, jobId))
            continue;
          const context = this.getJobContext(jobId);
          if (context === null || context.status !== 'QUEUED') continue;
          const initialState = createInitialExecutionState({
            jobId,
            request: context.input,
            queuedMessageId: context.queuedMessageId,
            queuedSequence: context.queuedMessageSequence,
          });
          const run = this.getOrCreatePinnedFlowRun(
            jobId,
            'intake',
            flowExecutionStateJson(initialState),
          );
          const changed = this.store.database
            .prepare(
              `UPDATE jobs SET status='RUNNING', started_at=COALESCE(started_at, ?),
                 deadline_at=?, updated_at=? WHERE id=? AND status='QUEUED'`,
            )
            .run(now, run.jobDeadline, now, jobId);
          if (changed.changes !== 1) continue;
          occupied.add(sessionId);
          reserved.push({
            jobId,
            sessionId,
            deadlineAt: run.jobDeadline ?? Number.MAX_SAFE_INTEGER,
          });
        }
      }
      return reserved;
    });
  }

  failExpiredWaitingJobs(now: number): number {
    if (!Number.isSafeInteger(now))
      throw new TypeError('Flow expiration time is invalid.');
    return this.transaction(() => {
      const due = this.store.database
        .prepare(
          `SELECT j.id FROM jobs j LEFT JOIN flow_runs f ON f.job_id=j.id
           WHERE j.status='WAITING_INPUT'
             AND (j.deadline_at<=? OR f.wait_deadline<=?)
           ORDER BY MIN(COALESCE(j.deadline_at, ?), COALESCE(f.wait_deadline, ?)), j.sequence`,
        )
        .all(now, now, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) as {
        id: unknown;
      }[];
      for (const row of due) {
        const jobId = asString(row.id, 'job ID');
        this.store.database
          .prepare(
            "UPDATE messages SET steering_state='not_applied' WHERE job_id=? AND kind='steering' AND steering_state='pending'",
          )
          .run(jobId);
        this.store.database
          .prepare(
            "UPDATE jobs SET status='FAILED', failure_code='TIMEOUT', updated_at=? WHERE id=? AND status='WAITING_INPUT'",
          )
          .run(now, jobId);
        this.store.database
          .prepare(
            'UPDATE flow_runs SET revision=revision+1, wait_deadline=NULL WHERE job_id=?',
          )
          .run(jobId);
        this.store.deactivatePrompts(jobId, 'JOB_TERMINAL');
        this.store.enqueueJobNotification(
          jobId,
          'failed',
          'Job failed (TIMEOUT).',
        );
      }
      return due.length;
    });
  }

  waitAtCurrentNode(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly currentNodeId: string;
    readonly state: JsonValue;
    readonly waitPrompt: string;
  }): FlowStepResult {
    return this.transaction(() => {
      const current = this.getPinnedFlowRun(input.jobId);
      if (
        current === null ||
        current.revision !== input.expectedRevision ||
        current.nodeId !== input.currentNodeId
      ) {
        return { status: 'stale', run: current };
      }
      const registry = this.registryFor(current.bundle);
      const flow = registry.get(current.flowId);
      const node = registry.getNode(current.flowId, current.nodeId);
      if (
        flow === undefined ||
        node === undefined ||
        node.kind !== 'server' ||
        Object.keys(node.next).length === 0
      ) {
        throw new DomainError(
          'FLOW_WAIT_INVALID',
          'Only a non-terminal server node can wait at its current position.',
        );
      }
      if (
        current.transitions >= effectiveNodeLimits(flow, node).maxTransitions
      ) {
        throw new DomainError(
          'FLOW_TRANSITION_LIMIT',
          'Flow transition limit has been reached.',
        );
      }
      const stateJson = serializeSafeJson(input.state, 'Flow state');
      const prompt = validateNotification(input.waitPrompt, 'Prompt');
      const job = this.store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(input.jobId) as { status?: unknown } | undefined;
      if (job === undefined)
        throw new DomainError('NOT_FOUND', 'Job not found.');
      const status = asJobStatus(job.status);
      if (status !== 'RUNNING' && status !== 'WAITING_INPUT')
        return { status: 'stale', run: current };
      const now = this.now();
      const waitDeadline = Math.min(
        now + effectiveNodeLimits(flow, node).waitTimeoutMs,
        current.jobDeadline ?? Number.MAX_SAFE_INTEGER,
      );
      const generation = current.promptGeneration + 1;
      this.store.deactivatePrompts(input.jobId, 'PROMPT_SUPERSEDED');
      const jobUpdate = this.store.database
        .prepare(
          "UPDATE jobs SET status='WAITING_INPUT', updated_at=? WHERE id=? AND status IN ('RUNNING','WAITING_INPUT')",
        )
        .run(now, input.jobId);
      if (jobUpdate.changes !== 1) {
        throw new DomainError(
          'FLOW_WAIT_INVALID',
          'Job changed before the wait checkpoint.',
        );
      }
      const flowUpdate = this.store.database
        .prepare(
          `UPDATE flow_runs SET state_json=?, revision=revision+1, transitions=transitions+1,
             prompt_generation=?, wait_deadline=? WHERE job_id=? AND revision=?`,
        )
        .run(
          stateJson,
          generation,
          waitDeadline,
          input.jobId,
          input.expectedRevision,
        );
      if (flowUpdate.changes !== 1) {
        throw new DomainError(
          'FLOW_WAIT_INVALID',
          'Flow changed before the wait checkpoint.',
        );
      }
      this.store.enqueueJobNotification(
        input.jobId,
        'prompt',
        prompt,
        generation,
      );
      const updated = this.getPinnedFlowRun(input.jobId);
      if (updated === null)
        throw new Error('Waiting Flow state was not stored.');
      return { status: 'committed', run: updated };
    });
  }

  checkpointInput(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly currentNodeId: string;
    readonly captured: readonly SteeringCapture[];
    readonly state: JsonValue;
  }): FlowStepResult {
    return this.transaction(() => {
      const current = this.getPinnedFlowRun(input.jobId);
      if (
        current === null ||
        current.revision !== input.expectedRevision ||
        current.nodeId !== input.currentNodeId
      ) {
        return { status: 'stale', run: current };
      }
      const job = this.store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(input.jobId) as { status?: unknown } | undefined;
      if (job === undefined)
        throw new DomainError('NOT_FOUND', 'Job not found.');
      if (asJobStatus(job.status) !== 'RUNNING')
        return { status: 'stale', run: current };
      const registry = this.registryFor(current.bundle);
      const flow = registry.get(current.flowId);
      const node = registry.getNode(current.flowId, current.nodeId);
      if (flow === undefined || node === undefined) {
        throw new DomainError(
          'FLOW_INPUT_CHECKPOINT_INVALID',
          'Input checkpoint requires the current pinned node.',
        );
      }
      if (
        current.transitions >= effectiveNodeLimits(flow, node).maxTransitions
      ) {
        throw new DomainError(
          'FLOW_TRANSITION_LIMIT',
          'Flow transition limit has been reached.',
        );
      }
      const selected = this.validateSteeringCapture(
        input.jobId,
        input.captured,
      );
      const state = appendCapturedInputs(input.state, input.jobId, selected);
      const stateJson = serializeSafeJson(
        flowExecutionStateJson(state),
        'Flow state',
      );
      this.markSteeringApplied(input.jobId, selected);
      const flowUpdate = this.store.database
        .prepare(
          `UPDATE flow_runs SET state_json=?, revision=revision+1,
             transitions=transitions+1, wait_deadline=NULL WHERE job_id=? AND revision=?`,
        )
        .run(stateJson, input.jobId, input.expectedRevision);
      if (flowUpdate.changes !== 1) {
        throw new DomainError(
          'FLOW_INPUT_CHECKPOINT_INVALID',
          'Flow changed before the input checkpoint.',
        );
      }
      const updated = this.getPinnedFlowRun(input.jobId);
      if (updated === null) throw new Error('Input checkpoint was not stored.');
      return { status: 'committed', run: updated };
    });
  }

  discardAgentAndRevise(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly currentNodeId: string;
    readonly captured: readonly SteeringCapture[];
    readonly state: JsonValue;
  }): FlowStepResult {
    return this.transaction(() => {
      const current = this.getPinnedFlowRun(input.jobId);
      if (
        current === null ||
        current.revision !== input.expectedRevision ||
        current.nodeId !== input.currentNodeId
      ) {
        return { status: 'stale', run: current };
      }
      const job = this.store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(input.jobId) as { status?: unknown } | undefined;
      if (job === undefined)
        throw new DomainError('NOT_FOUND', 'Job not found.');
      if (asJobStatus(job.status) !== 'RUNNING')
        return { status: 'stale', run: current };
      const registry = this.registryFor(current.bundle);
      const flow = registry.get(current.flowId);
      const node = registry.getNode(current.flowId, current.nodeId);
      if (flow === undefined || node === undefined || node.kind !== 'agent') {
        throw new DomainError(
          'FLOW_REVISE_INVALID',
          'Only the current Agent node can revise its declared result.',
        );
      }
      const reference = node.next['revise'];
      if (reference === undefined) {
        throw new DomainError(
          'FLOW_REVISE_INVALID',
          'The current Agent node has no declared revise transition.',
        );
      }
      const target = registry.getTarget(
        current.flowId,
        current.nodeId,
        'revise',
      );
      const targetFlow = registry.get(target.flowId);
      const targetNode = registry.getNode(target.flowId, target.nodeId);
      if (targetFlow === undefined || targetNode?.kind !== 'server') {
        throw new DomainError(
          'FLOW_REVISE_INVALID',
          'The declared revise transition must target a server node.',
        );
      }
      if (
        current.transitions >= effectiveNodeLimits(flow, node).maxTransitions
      ) {
        throw new DomainError(
          'FLOW_TRANSITION_LIMIT',
          'Flow transition limit has been reached.',
        );
      }
      const selected = this.validateSteeringCapture(
        input.jobId,
        input.captured,
      );
      let state = appendCapturedInputs(input.state, input.jobId, selected);
      state = {
        ...state,
        pendingPurpose: null,
        askedQuestionIds: [],
        mbtiCandidate: null,
        mbtiAssessment: null,
        mbtiReuse: false,
        birthParseText: null,
        birthCandidate: null,
        birthCandidateRefs: [],
        birthCandidatePresented: false,
        birthAfterSequence: null,
        chart: null,
        interpretation: null,
        ...(selected.length > 0
          ? { sources: { ...state.sources, subject: 'unknown' as const } }
          : {}),
      };
      const stateJson = serializeSafeJson(
        flowExecutionStateJson(state),
        'Flow state',
      );
      this.markSteeringApplied(input.jobId, selected);
      const now = this.now();
      const jobDeadline =
        targetFlow.id === current.flowId
          ? current.jobDeadline
          : current.jobDeadline === null
            ? now + targetFlow.limits.jobTimeoutMs
            : Math.min(
                current.jobDeadline,
                now + targetFlow.limits.jobTimeoutMs,
              );
      const jobUpdate = this.store.database
        .prepare(
          "UPDATE jobs SET status='RUNNING', deadline_at=?, updated_at=? WHERE id=? AND status='RUNNING'",
        )
        .run(jobDeadline, now, input.jobId);
      if (jobUpdate.changes !== 1) {
        throw new DomainError(
          'FLOW_REVISE_INVALID',
          'Job changed before the revise checkpoint.',
        );
      }
      const flowUpdate = this.store.database
        .prepare(
          `UPDATE flow_runs SET flow_id=?, node_id=?, state_json=?, revision=revision+1,
             transitions=transitions+1, wait_deadline=NULL, job_deadline=?
           WHERE job_id=? AND revision=?`,
        )
        .run(
          target.flowId,
          target.nodeId,
          stateJson,
          jobDeadline,
          input.jobId,
          input.expectedRevision,
        );
      if (flowUpdate.changes !== 1) {
        throw new DomainError(
          'FLOW_REVISE_INVALID',
          'Flow changed before the revise checkpoint.',
        );
      }
      const updated = this.getPinnedFlowRun(input.jobId);
      if (updated === null)
        throw new Error('Revised Flow state was not stored.');
      return { status: 'committed', run: updated };
    });
  }

  advanceControlStep(input: {
    readonly jobId: string;
    readonly expectedRevision: number;
    readonly currentNodeId: string;
  }): FlowStepResult {
    return this.transaction(() => {
      const current = this.getPinnedFlowRun(input.jobId);
      if (
        current === null ||
        current.revision !== input.expectedRevision ||
        current.nodeId !== input.currentNodeId
      ) {
        return { status: 'stale', run: current };
      }
      const job = this.store.database
        .prepare('SELECT status FROM jobs WHERE id=?')
        .get(input.jobId) as { status?: unknown } | undefined;
      if (job === undefined)
        throw new DomainError('NOT_FOUND', 'Job not found.');
      if (asJobStatus(job.status) !== 'RUNNING')
        return { status: 'stale', run: current };
      const registry = this.registryFor(current.bundle);
      const flow = registry.get(current.flowId);
      const node = registry.getNode(current.flowId, current.nodeId);
      if (flow === undefined || node === undefined)
        throw new DomainError(
          'FLOW_SNAPSHOT_INVALID',
          'Pinned node is invalid.',
        );
      if (
        current.transitions >= effectiveNodeLimits(flow, node).maxTransitions
      ) {
        throw new DomainError(
          'FLOW_TRANSITION_LIMIT',
          'Flow transition limit has been reached.',
        );
      }
      this.store.database
        .prepare(
          'UPDATE flow_runs SET revision=revision+1, transitions=transitions+1 WHERE job_id=? AND revision=?',
        )
        .run(input.jobId, input.expectedRevision);
      const updated = this.getPinnedFlowRun(input.jobId);
      if (updated === null) throw new Error('Control step was not stored.');
      return { status: 'committed', run: updated };
    });
  }

  consumePendingSteering(
    jobId: string,
    captured: readonly SteeringCapture[],
  ): readonly PendingSteering[] {
    return this.transaction(() => {
      const unique = new Set<string>();
      for (const item of captured) {
        if (
          item.id.length === 0 ||
          !Number.isSafeInteger(item.sequence) ||
          item.sequence < 1 ||
          unique.has(item.id)
        ) {
          throw new DomainError(
            'STEERING_CAPTURE_INVALID',
            'Captured steering references are invalid.',
          );
        }
        unique.add(item.id);
      }
      if (captured.length === 0) return [];
      const pending = this.getPendingSteering(jobId);
      const byId = new Map(pending.map((item) => [item.id, item]));
      const selected = captured
        .flatMap((capture) => {
          const item = byId.get(capture.id);
          return item !== undefined && item.sequence === capture.sequence
            ? [item]
            : [];
        })
        .sort((left, right) => left.sequence - right.sequence);
      const update = this.store.database.prepare(
        `UPDATE messages SET steering_state='applied', applied_at=?
         WHERE id=? AND job_id=? AND kind='steering' AND steering_state='pending' AND sequence=?`,
      );
      const now = this.now();
      for (const item of selected) {
        update.run(now, item.id, jobId, item.sequence);
      }
      return selected;
    });
  }

  commitFlowStep(input: FlowStepInput): FlowStepResult {
    if (
      input.jobId.length === 0 ||
      input.currentNodeId.length === 0 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      !isFlowStepOutcome(input.outcome)
    ) {
      throw new DomainError(
        'FLOW_STEP_INVALID',
        'Flow step reference is invalid.',
      );
    }
    return this.transaction(() => {
      const current = this.getPinnedFlowRun(input.jobId);
      if (
        current === null ||
        current.revision !== input.expectedRevision ||
        current.nodeId !== input.currentNodeId
      ) {
        return { status: 'stale', run: current };
      }
      if (
        (input.outcome !== 'fail' && input.failureCode !== undefined) ||
        (input.outcome !== 'wait' && input.waitPrompt !== undefined) ||
        (input.outcome !== 'complete' && input.notificationText !== undefined)
      ) {
        throw new DomainError(
          'FLOW_STEP_INVALID',
          'Flow step fields are invalid.',
        );
      }
      const pinnedRegistry = this.registryFor(current.bundle);
      const currentFlow = pinnedRegistry.get(current.flowId);
      const currentNode = pinnedRegistry.getNode(
        current.flowId,
        current.nodeId,
      );
      if (currentFlow === undefined || currentNode === undefined)
        throw new DomainError(
          'FLOW_SNAPSHOT_INVALID',
          'Pinned Flow node is invalid.',
        );
      let target: { readonly flowId: string; readonly nodeId: string } | null =
        null;
      let targetFlow: FlowDefinition | undefined;
      let targetNode: NodeDefinition | undefined;
      if (input.outcome === 'run' || input.outcome === 'wait') {
        if (input.transition === undefined) {
          throw new DomainError(
            'FLOW_TRANSITION_INVALID',
            'A declared transition is required.',
          );
        }
        target = pinnedRegistry.getTarget(
          current.flowId,
          current.nodeId,
          input.transition,
        );
        if (
          input.target !== undefined &&
          (input.target.flowId !== target.flowId ||
            input.target.nodeId !== target.nodeId)
        ) {
          throw new DomainError(
            'FLOW_TARGET_INVALID',
            'Transition target does not match the pinned Flow graph.',
          );
        }
        targetFlow = pinnedRegistry.get(target.flowId);
        targetNode = pinnedRegistry.getNode(target.flowId, target.nodeId);
        if (targetFlow === undefined || targetNode === undefined) {
          throw new DomainError(
            'FLOW_TARGET_INVALID',
            'Transition target is not registered.',
          );
        }
        if (
          current.transitions >=
          effectiveNodeLimits(currentFlow, currentNode).maxTransitions
        ) {
          throw new DomainError(
            'FLOW_TRANSITION_LIMIT',
            'Flow transition limit has been reached.',
          );
        }
      }
      if (input.outcome === 'wait' && targetNode?.kind !== 'server') {
        throw new DomainError(
          'FLOW_WAIT_INVALID',
          'A waiting transition must target a server node.',
        );
      }
      if (input.outcome === 'complete') {
        if (
          input.transition !== undefined ||
          input.target !== undefined ||
          currentNode.kind !== 'server' ||
          Object.keys(currentNode.next).length !== 0
        ) {
          throw new DomainError(
            'FLOW_COMPLETE_INVALID',
            'Completion requires the current server node to be terminal.',
          );
        }
      } else if (input.outcome === 'fail') {
        if (input.transition !== undefined || input.target !== undefined) {
          throw new DomainError(
            'FLOW_STEP_INVALID',
            'Failure cannot select a Flow transition.',
          );
        }
      }
      if (currentNode.kind === 'agent' && input.outcome !== 'fail') {
        if (input.agentResult === undefined) {
          throw new DomainError(
            'FLOW_RESULT_INVALID',
            'Agent result is required.',
          );
        }
        let validatedResult: AgentNodeResult;
        try {
          validatedResult = validateAgentNodeResult(
            input.agentResult,
            currentNode,
            effectiveNodeLimits(currentFlow, currentNode).maxOutputChars,
          );
        } catch {
          throw new DomainError(
            'FLOW_RESULT_INVALID',
            'Agent result is invalid.',
          );
        }
        if (validatedResult.transition !== input.transition) {
          throw new DomainError(
            'FLOW_TRANSITION_INVALID',
            'Agent result transition does not match the committed transition.',
          );
        }
        if (currentNode.resultContract === 'recommendation') {
          const suggestedFlow = (
            validatedResult.result as { readonly suggestedFlow: string | null }
          ).suggestedFlow;
          if (
            suggestedFlow !== null &&
            (suggestedFlow === 'intake' ||
              pinnedRegistry.get(suggestedFlow) === undefined)
          ) {
            throw new DomainError(
              'FLOW_RESULT_INVALID',
              'Agent result is invalid.',
            );
          }
        }
      } else if (input.agentResult !== undefined) {
        throw new DomainError(
          'FLOW_RESULT_INVALID',
          'Agent result is not accepted for this Flow node.',
        );
      }
      const stateJson = serializeSafeJson(input.state, 'Flow state');
      const facts = input.facts ?? [];
      const job = this.store.database
        .prepare('SELECT session_id, owner_id, status FROM jobs WHERE id=?')
        .get(input.jobId) as
        | { session_id?: unknown; owner_id?: unknown; status?: unknown }
        | undefined;
      if (job === undefined)
        throw new DomainError('NOT_FOUND', 'Job not found.');
      const jobStatus = asJobStatus(job.status);
      if (
        jobStatus === 'COMPLETED' ||
        jobStatus === 'FAILED' ||
        jobStatus === 'CANCELLED' ||
        jobStatus === 'CANCELLING'
      ) {
        return { status: 'stale', run: current };
      }
      if (input.outcome === 'complete' || currentNode.kind === 'agent') {
        const pending = this.store.database
          .prepare(
            "SELECT 1 AS found FROM messages WHERE job_id=? AND kind='steering' AND steering_state='pending' LIMIT 1",
          )
          .get(input.jobId);
        if (pending !== undefined) return { status: 'dirty', run: current };
      }
      const sessionId = asString(job.session_id, 'job session ID');
      const ownerId = asString(job.owner_id, 'job owner ID');
      this.writeFacts(sessionId, ownerId, facts, currentFlow.version);
      const now = this.now();
      if (input.outcome === 'fail') {
        const failureCode = input.failureCode ?? 'FLOW_FAILED';
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(failureCode)) {
          throw new DomainError(
            'FLOW_FAILURE_INVALID',
            'Failure code is invalid.',
          );
        }
        this.store.database
          .prepare(
            "UPDATE messages SET steering_state='not_applied' WHERE job_id=? AND kind='steering' AND steering_state='pending'",
          )
          .run(input.jobId);
        this.store.database
          .prepare(
            "UPDATE jobs SET status='FAILED', failure_code=?, updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT')",
          )
          .run(failureCode, now, input.jobId);
        this.store.database
          .prepare(
            'UPDATE flow_runs SET state_json=?, revision=revision+1, wait_deadline=NULL WHERE job_id=? AND revision=?',
          )
          .run(stateJson, input.jobId, input.expectedRevision);
        this.store.deactivatePrompts(input.jobId, 'JOB_TERMINAL');
        this.store.enqueueJobNotification(
          input.jobId,
          'failed',
          `Job failed (${failureCode}).`,
        );
      } else if (input.outcome === 'wait') {
        const prompt = validateNotification(input.waitPrompt, 'Prompt');
        if (
          target === null ||
          targetFlow === undefined ||
          targetNode === undefined
        )
          throw new Error('Wait target was not resolved.');
        const waitTimeout = effectiveNodeLimits(
          targetFlow,
          targetNode,
        ).waitTimeoutMs;
        const proposedDeadline = now + waitTimeout;
        const jobDeadline =
          targetFlow.id === current.flowId
            ? current.jobDeadline
            : current.jobDeadline === null
              ? now + targetFlow.limits.jobTimeoutMs
              : Math.min(
                  current.jobDeadline,
                  now + targetFlow.limits.jobTimeoutMs,
                );
        const waitDeadline =
          jobDeadline === null
            ? proposedDeadline
            : Math.min(proposedDeadline, jobDeadline);
        const generation = current.promptGeneration + 1;
        this.store.deactivatePrompts(input.jobId, 'PROMPT_SUPERSEDED');
        this.store.database
          .prepare(
            "UPDATE jobs SET status='WAITING_INPUT', deadline_at=?, updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT')",
          )
          .run(jobDeadline, now, input.jobId);
        this.store.database
          .prepare(
            `UPDATE flow_runs SET flow_id=?, node_id=?, state_json=?, revision=revision+1,
             transitions=transitions+1, prompt_generation=?, wait_deadline=?, job_deadline=? WHERE job_id=? AND revision=?`,
          )
          .run(
            target.flowId,
            target.nodeId,
            stateJson,
            generation,
            waitDeadline,
            jobDeadline,
            input.jobId,
            input.expectedRevision,
          );
        this.store.enqueueJobNotification(
          input.jobId,
          'prompt',
          prompt,
          generation,
        );
      } else if (input.outcome === 'complete') {
        this.store.deactivatePrompts(input.jobId, 'JOB_TERMINAL');
        this.store.database
          .prepare(
            "UPDATE jobs SET status='COMPLETED', updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT')",
          )
          .run(now, input.jobId);
        this.store.database
          .prepare(
            'UPDATE flow_runs SET state_json=?, revision=revision+1, wait_deadline=NULL WHERE job_id=? AND revision=?',
          )
          .run(stateJson, input.jobId, input.expectedRevision);
        this.store.enqueueJobNotification(
          input.jobId,
          'completed',
          validateNotification(
            input.notificationText ?? 'Flow completed.',
            'Completion notification',
          ),
        );
      } else {
        if (target === null || targetFlow === undefined)
          throw new Error('Flow target was not resolved.');
        const jobDeadline =
          targetFlow.id === current.flowId
            ? current.jobDeadline
            : current.jobDeadline === null
              ? now + targetFlow.limits.jobTimeoutMs
              : Math.min(
                  current.jobDeadline,
                  now + targetFlow.limits.jobTimeoutMs,
                );
        this.store.database
          .prepare(
            "UPDATE jobs SET status='RUNNING', deadline_at=?, updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT')",
          )
          .run(jobDeadline, now, input.jobId);
        this.store.database
          .prepare(
            `UPDATE flow_runs SET flow_id=?, node_id=?, state_json=?, revision=revision+1,
             transitions=transitions+1, wait_deadline=NULL, job_deadline=? WHERE job_id=? AND revision=?`,
          )
          .run(
            target.flowId,
            target.nodeId,
            stateJson,
            jobDeadline,
            input.jobId,
            input.expectedRevision,
          );
      }
      const committed = this.getPinnedFlowRun(input.jobId);
      if (committed === null) throw new Error('Committed Flow was not stored.');
      return { status: 'committed', run: committed };
    });
  }

  wait(
    input: Omit<FlowStepInput, 'outcome'> & { readonly waitPrompt: string },
  ): FlowStepResult {
    return this.commitFlowStep({ ...input, outcome: 'wait' });
  }

  finish(
    input: Omit<FlowStepInput, 'outcome'> & {
      readonly notificationText?: string;
    },
  ): FlowStepResult {
    return this.commitFlowStep({ ...input, outcome: 'complete' });
  }

  fail(
    input: Omit<FlowStepInput, 'outcome'> & { readonly failureCode?: string },
  ): FlowStepResult {
    return this.commitFlowStep({ ...input, outcome: 'fail' });
  }

  restartTerminateAll(): number {
    return this.transaction(() => {
      const now = this.now();
      const cancelling = this.store.database
        .prepare(
          "SELECT id FROM jobs WHERE status='CANCELLING' ORDER BY created_at, sequence",
        )
        .all() as { id: unknown }[];
      for (const row of cancelling)
        this.store.finishCancellation(asString(row.id, 'job ID'));
      const active = this.store.database
        .prepare(
          "SELECT id FROM jobs WHERE status IN ('QUEUED','RUNNING','WAITING_INPUT') ORDER BY created_at, sequence",
        )
        .all() as { id: unknown }[];
      for (const row of active) {
        const jobId = asString(row.id, 'job ID');
        this.store.database
          .prepare(
            "UPDATE messages SET steering_state='not_applied' WHERE job_id=? AND kind='steering' AND steering_state='pending'",
          )
          .run(jobId);
        this.store.database
          .prepare(
            "UPDATE jobs SET status='FAILED', failure_code='SERVER_RESTART', updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING','WAITING_INPUT')",
          )
          .run(now, jobId);
        this.store.deactivatePrompts(jobId, 'SERVER_RESTART');
        this.store.database
          .prepare('UPDATE flow_runs SET wait_deadline=NULL WHERE job_id=?')
          .run(jobId);
        this.store.enqueueJobNotification(
          jobId,
          'failed',
          'Job failed (SERVER_RESTART).',
        );
      }
      const terminalWithPrompts = this.store.database
        .prepare(
          `SELECT DISTINCT j.id FROM jobs j JOIN outbox o ON o.job_id=j.id
           WHERE j.status IN ('COMPLETED','FAILED','CANCELLED') AND o.kind='prompt' AND o.status='PENDING'`,
        )
        .all() as { id: unknown }[];
      for (const row of terminalWithPrompts) {
        this.store.deactivatePrompts(
          asString(row.id, 'job ID'),
          'JOB_TERMINAL',
        );
      }
      return active.length;
    });
  }

  private validateSteeringCapture(
    jobId: string,
    captured: readonly SteeringCapture[],
  ): readonly PendingSteering[] {
    const seenIds = new Set<string>();
    const seenSequences = new Set<number>();
    for (const item of captured) {
      if (
        item.id.length === 0 ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 1 ||
        seenIds.has(item.id) ||
        seenSequences.has(item.sequence)
      ) {
        throw new DomainError(
          'STEERING_CAPTURE_INVALID',
          'Captured steering references are invalid.',
        );
      }
      seenIds.add(item.id);
      seenSequences.add(item.sequence);
    }
    const pending = this.getPendingSteering(jobId);
    if (captured.length > pending.length) {
      throw new DomainError(
        'STEERING_CAPTURE_INVALID',
        'Captured steering is no longer pending.',
      );
    }
    const selected = pending.slice(0, captured.length);
    for (let index = 0; index < captured.length; index += 1) {
      const capture = captured[index];
      const actual = selected[index];
      if (
        capture === undefined ||
        actual === undefined ||
        capture.id !== actual.id ||
        capture.sequence !== actual.sequence
      ) {
        throw new DomainError(
          'STEERING_CAPTURE_INVALID',
          'Captured steering skipped or mismatched an earlier message.',
        );
      }
    }
    return selected;
  }

  private markSteeringApplied(
    jobId: string,
    selected: readonly PendingSteering[],
  ): void {
    const update = this.store.database.prepare(
      `UPDATE messages SET steering_state='applied', applied_at=?
       WHERE id=? AND job_id=? AND kind='steering'
         AND steering_state='pending' AND sequence=?`,
    );
    const now = this.now();
    for (const item of selected) {
      const result = update.run(now, item.id, jobId, item.sequence);
      if (result.changes !== 1) {
        throw new DomainError(
          'STEERING_CAPTURE_INVALID',
          'Captured steering changed before its checkpoint.',
        );
      }
    }
  }

  private writeFacts(
    sessionId: string,
    ownerId: string,
    facts: readonly SessionFactWrite[],
    flowVersion: string | null = null,
  ): void {
    if (facts.length === 0) return;
    const session = this.store.database
      .prepare('SELECT 1 AS found FROM sessions WHERE id=? AND owner_id=?')
      .get(sessionId, ownerId);
    if (session === undefined)
      throw new DomainError('NOT_FOUND', 'Controller Session not found.');
    const seen = new Set<string>();
    const write = this.store.database.prepare(
      `INSERT INTO session_facts(session_id, owner_id, kind, value_json, source_json,
                                 flow_version, bank_version, created_at, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_confirmed')
       ON CONFLICT(session_id, kind) DO UPDATE SET owner_id=excluded.owner_id,
         value_json=excluded.value_json, source_json=excluded.source_json,
         flow_version=excluded.flow_version, bank_version=excluded.bank_version,
         created_at=excluded.created_at, provenance='user_confirmed'`,
    );
    for (const fact of facts) {
      if (
        !isExplicitlyConfirmed(fact) ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(fact.kind) ||
        seen.has(fact.kind)
      ) {
        throw new DomainError(
          'FACT_NOT_CONFIRMED',
          'Only unique, explicitly confirmed facts can be saved.',
        );
      }
      seen.add(fact.kind);
      const valueJson = serializeSafeJson(fact.value, 'Fact value');
      const sourceJson = serializeSafeJson(fact.source, 'Fact source');
      const factFlowVersion = fact.flowVersion ?? flowVersion;
      const bankVersion = fact.bankVersion ?? null;
      if (
        (factFlowVersion !== null &&
          (factFlowVersion.length === 0 || factFlowVersion.length > 128)) ||
        (bankVersion !== null &&
          (bankVersion.length === 0 || bankVersion.length > 128))
      ) {
        throw new DomainError('FACT_INVALID', 'Fact version is invalid.');
      }
      write.run(
        sessionId,
        ownerId,
        fact.kind,
        valueJson,
        sourceJson,
        factFlowVersion,
        bankVersion,
        this.now(),
      );
    }
  }

  private mapFlowRun(row: Record<string, unknown>): FlowRun {
    const bundleValue = parseSafeJson(row['bundle_json'], 'Flow snapshot');
    let bundle: FlowBundle;
    try {
      bundle = new FlowRegistry(bundleValue, this.registryOptions).snapshot();
    } catch {
      throw new DomainError(
        'FLOW_SNAPSHOT_INVALID',
        'Stored Flow snapshot is invalid.',
      );
    }
    const flowId = asString(row['flow_id'], 'Flow ID');
    const nodeId = asString(row['node_id'], 'node ID');
    const snapshotRegistry = this.registryFor(bundle);
    if (
      snapshotRegistry.get(flowId) === undefined ||
      snapshotRegistry.getNode(flowId, nodeId) === undefined
    ) {
      throw new DomainError(
        'FLOW_STORAGE_INVALID',
        'Stored Flow position is invalid.',
      );
    }
    const revision = asInteger(row['revision'], 'Flow revision');
    const transitions = asInteger(row['transitions'], 'Flow transitions');
    const promptGeneration = asInteger(
      row['prompt_generation'],
      'Flow prompt generation',
    );
    if (revision < 0 || transitions < 0 || promptGeneration < 0) {
      throw new DomainError(
        'FLOW_STORAGE_INVALID',
        'Flow counters are invalid.',
      );
    }
    return {
      jobId: asString(row['job_id'], 'job ID'),
      bundle,
      flowId,
      nodeId,
      state: parseSafeJson(row['state_json'], 'Flow state') as JsonValue,
      revision,
      transitions,
      promptGeneration,
      waitDeadline:
        row['wait_deadline'] === null
          ? null
          : asInteger(row['wait_deadline'], 'Flow wait deadline'),
      jobDeadline:
        row['job_deadline'] === null
          ? null
          : asInteger(row['job_deadline'], 'Flow job deadline'),
    };
  }

  private mapFact(row: Record<string, unknown>): SessionFact {
    return {
      sessionId: asString(row['session_id'], 'fact session ID'),
      ownerId: asString(row['owner_id'], 'fact owner ID'),
      kind: asString(row['kind'], 'fact kind'),
      value: parseSafeJson(row['value_json'], 'Fact value') as JsonValue,
      source: parseSafeJson(row['source_json'], 'Fact source') as JsonValue,
      flowVersion:
        row['flow_version'] === null
          ? null
          : asString(row['flow_version'], 'fact Flow version'),
      bankVersion:
        row['bank_version'] === null
          ? null
          : asString(row['bank_version'], 'fact bank version'),
      createdAt: asInteger(row['created_at'], 'fact creation time'),
      provenance: 'user_confirmed',
    };
  }

  private registryFor(bundle: FlowBundle): FlowRegistry {
    try {
      return new FlowRegistry(bundle, this.registryOptions);
    } catch {
      throw new DomainError(
        'FLOW_SNAPSHOT_INVALID',
        'Stored Flow snapshot is invalid.',
      );
    }
  }
}

function appendCapturedInputs(
  value: JsonValue,
  jobId: string,
  selected: readonly PendingSteering[],
): FlowExecutionState {
  const state = parseFlowExecutionState(value);
  if (state.sources.jobId !== jobId) {
    throw new DomainError(
      'FLOW_INPUT_CHECKPOINT_INVALID',
      'Input checkpoint belongs to a different Job.',
    );
  }
  const existingIds = new Set(state.inputs.map((item) => item.id));
  if (selected.some((item) => existingIds.has(item.id))) {
    throw new DomainError(
      'STEERING_CAPTURE_INVALID',
      'Captured steering was already persisted.',
    );
  }
  const newInputs: FlowInputRecord[] = selected.map((item) => ({
    id: item.id,
    sequence: item.sequence,
    source: 'steering',
    content: item.content,
  }));
  const steeringMessageIds = [
    ...state.sources.steeringMessageIds,
    ...selected.map((item) => item.id),
  ];
  const isConfirmation =
    state.pendingPurpose === 'mbti_confirmation' ||
    state.pendingPurpose === 'natal_confirmation';
  const confirmationMessageIds = isConfirmation
    ? [
        ...state.sources.confirmationMessageIds,
        ...selected.map((item) => item.id),
      ]
    : state.sources.confirmationMessageIds;
  return {
    ...state,
    inputs: [...state.inputs, ...newInputs].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    sources: {
      ...state.sources,
      steeringMessageIds,
      confirmationMessageIds,
    },
  };
}

function runSynchronous<T>(callback: () => T): T {
  const result = callback();
  if (isPromiseLike(result)) {
    throw new TypeError('Flow transaction callback must be synchronous.');
  }
  return result;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : asInteger(value, label);
}

function isFlowStepOutcome(value: unknown): value is FlowStepOutcome {
  return (
    value === 'run' ||
    value === 'wait' ||
    value === 'complete' ||
    value === 'fail'
  );
}

function isExplicitlyConfirmed(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const confirmation = Object.getOwnPropertyDescriptor(value, 'confirmed');
  return confirmation?.value === true;
}

function validateNotification(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 100_000 ||
    containsCredential(value)
  ) {
    throw new DomainError('FLOW_NOTIFICATION_INVALID', `${label} is invalid.`);
  }
  return value;
}

function serializeSafeJson(value: unknown, label: string): string {
  assertJson(value, 0, { count: 0 }, label);
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new DomainError('FLOW_JSON_INVALID', `${label} is invalid JSON.`);
  }
  if (text.length > MAX_STORED_JSON_CHARS || containsCredential(text)) {
    throw new DomainError('FLOW_JSON_INVALID', `${label} exceeds safe limits.`);
  }
  return text;
}

function parseSafeJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string' || value.length > MAX_STORED_JSON_CHARS) {
    throw new DomainError('FLOW_STORAGE_INVALID', `${label} is invalid.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new DomainError('FLOW_STORAGE_INVALID', `${label} is invalid.`);
  }
  assertJson(parsed, 0, { count: 0 }, label);
  if (containsCredential(value)) {
    throw new DomainError('FLOW_STORAGE_INVALID', `${label} is invalid.`);
  }
  return parsed;
}

function assertJson(
  value: unknown,
  depth: number,
  budget: { count: number },
  label: string,
): asserts value is JsonValue {
  if (depth > 32)
    throw new DomainError(
      'FLOW_JSON_INVALID',
      `${label} is nested too deeply.`,
    );
  budget.count += 1;
  if (budget.count > 20_000)
    throw new DomainError(
      'FLOW_JSON_INVALID',
      `${label} contains too many values.`,
    );
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    if (typeof value === 'string' && containsCredential(value)) {
      throw new DomainError(
        'FLOW_JSON_INVALID',
        `${label} contains restricted data.`,
      );
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new DomainError(
        'FLOW_JSON_INVALID',
        `${label} contains an invalid number.`,
      );
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1, budget, label);
    return;
  }
  if (
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DomainError(
      'FLOW_JSON_INVALID',
      `${label} must contain strict JSON.`,
    );
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key))
      throw new DomainError(
        'FLOW_JSON_INVALID',
        `${label} contains a restricted field.`,
      );
    assertJson(item, depth + 1, budget, label);
  }
}

function containsCredential(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new DomainError('FLOW_STORAGE_INVALID', `${label} is invalid.`);
  return value;
}

function asInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DomainError('FLOW_STORAGE_INVALID', `${label} is invalid.`);
  }
  return value;
}

function asJobStatus(value: unknown): JobStatus {
  if (
    value !== 'QUEUED' &&
    value !== 'RUNNING' &&
    value !== 'WAITING_INPUT' &&
    value !== 'CANCELLING' &&
    value !== 'COMPLETED' &&
    value !== 'FAILED' &&
    value !== 'CANCELLED'
  ) {
    throw new DomainError('FLOW_STORAGE_INVALID', 'Job status is invalid.');
  }
  return value;
}
