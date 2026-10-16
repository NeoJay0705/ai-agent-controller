import { DomainError, ControllerStore } from '../controller/store.js';
import type {
  AgentRuntime,
  AgentNodeResult,
  FlowDefinition,
  JsonValue,
  NodeDefinition,
} from './types.js';
import { validateAgentNodeResult } from './types.js';
import { effectiveNodeLimits, FlowRegistry } from './registry.js';
import { FlowStore } from './store.js';
import type {
  FlowJobContext,
  FlowRun,
  FlowStepResult,
  PendingSteering,
  SessionFactWrite,
} from './store.js';
import {
  MBTI_BANK_VERSION,
  MBTI_DISCLAIMER,
  MBTI_QUESTIONS,
  evaluateMbtiAnswers,
  mergeMbtiAnswerHistory,
  selectMbtiQuestionBatch,
  validateMbtiAnswers,
} from './mbti.js';
import type { MbtiAnswer } from './mbti.js';
import {
  BirthValidationError,
  NATAL_METHOD_VERSION,
  calculateNatalChart,
  resolveBirthTimeToUtc,
  validateBirthChartInput,
} from './natal.js';
import type { BirthChartInput } from './natal.js';
import {
  flowExecutionStateJson,
  lastInputSequence,
  parseFlowExecutionState,
} from './execution-types.js';
import type { FlowExecutionState } from './execution-types.js';
import {
  getFlowChoiceOptions,
  renderChoicePrompt,
  renderChoiceRetry,
  renderMbtiCandidate,
  renderMbtiQuestions,
  renderMbtiResult,
  renderNatalCandidate,
  renderNatalChart,
  renderNatalMissing,
  renderNatalValidationError,
  renderThirdPartyClarification,
  renderUnsupported,
} from './presentation.js';
import type { FlowChoiceOption } from './presentation.js';
import { PiCliRpcRuntimeError } from './pi-rpc-runtime.js';

export interface FlowExecutorOptions {
  readonly now?: () => number;
}

interface ServerPlan {
  readonly kind: 'wait' | 'transition' | 'finish';
  readonly state: FlowExecutionState;
  readonly prompt?: string;
  readonly transition?: string;
  readonly facts?: readonly SessionFactWrite[];
  readonly notification?: string;
}

interface AgentInvocation {
  readonly result: AgentNodeResult;
  readonly run: FlowRun;
}

class DirtyCompletion extends Error {
  constructor() {
    super('FLOW_DIRTY');
  }
}

class ExecutionFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const STABLE_RUNTIME_CODES = new Set([
  'FLOW_CREDENTIAL_MISSING',
  'FLOW_AUTH_SOURCE_MISSING',
  'FLOW_AUTH_SOURCE_INVALID',
  'FLOW_AUTH_LOGIN_REQUIRED',
  'FLOW_AUTH_REFRESH_FAILED',
  'FLOW_AUTH_SNAPSHOT_INVALID',
  'FLOW_PROVIDER_UNSUPPORTED',
  'FLOW_SESSION_BUSY',
  'FLOW_SESSION_IDENTITY_INVALID',
  'FLOW_HISTORY_MISSING',
  'FLOW_HISTORY_INVALID',
  'FLOW_HISTORY_LIMIT',
  'FLOW_NODE_TIMEOUT',
  'FLOW_ABORTED',
  'FLOW_MODEL_UNAVAILABLE',
  'UNSUPPORTED_THINKING',
  'FLOW_TOOL_UNAVAILABLE',
  'FLOW_TOOL_FORBIDDEN',
  'FLOW_TOOL_LIMIT',
  'FLOW_MODEL_TURN_LIMIT',
  'FLOW_RETRY_FORBIDDEN',
  'FLOW_CONTEXT_LIMIT',
  'FLOW_OUTPUT_LIMIT',
  'FLOW_OUTPUT_INVALID',
  'FLOW_PROMPT_INVALID',
  'FLOW_PROMPT_NOT_STARTED',
  'FLOW_GUARD_HANDSHAKE_FAILED',
  'FLOW_RPC_CHILD_START_FAILED',
  'FLOW_RPC_CHILD_EXITED',
  'FLOW_RPC_PROTOCOL_FAILED',
  'FLOW_MODEL_REQUEST_FAILED',
  'FLOW_RESULT_INVALID',
  'FLOW_RUNTIME_DISPOSED',
  'FLOW_TOKEN_LIMIT',
  'FLOW_USAGE_UNKNOWN',
  'FLOW_ACCESS_DENIED',
  'FLOW_STORAGE_INVALID',
]);

const STABLE_DOMAIN_CODES = new Set([
  'FLOW_EXECUTION_FAILED',
  'FLOW_HANDLER_INVALID',
  'FLOW_SNAPSHOT_INVALID',
  'TIMEOUT',
  'FLOW_ALREADY_PINNED',
  'FLOW_NOT_FOUND',
  'FLOW_SNAPSHOT_INVALID',
  'FLOW_STORAGE_INVALID',
  'FLOW_STEP_INVALID',
  'FLOW_TRANSITION_INVALID',
  'FLOW_TARGET_INVALID',
  'FLOW_RESULT_INVALID',
  'FLOW_TRANSITION_LIMIT',
  'FLOW_WAIT_INVALID',
  'FLOW_COMPLETE_INVALID',
  'FLOW_FAILURE_INVALID',
  'FLOW_NOTIFICATION_INVALID',
  'FLOW_INPUT_CHECKPOINT_INVALID',
  'FLOW_REVISE_INVALID',
  'FLOW_TOOL_UNAVAILABLE',
]);

/** Runs a pinned Flow synchronously between asynchronous Agent safe points. */
export class FlowExecutor {
  private readonly controllerStore: ControllerStore;
  private readonly flowStore: FlowStore;
  private readonly agentRuntime: AgentRuntime;
  private readonly now: () => number;
  private disposePromise: Promise<void> | null = null;

  constructor(
    controllerStore: ControllerStore,
    flowStore: FlowStore,
    agentRuntime: AgentRuntime,
    options: FlowExecutorOptions = {},
  ) {
    this.controllerStore = controllerStore;
    this.flowStore = flowStore;
    this.agentRuntime = agentRuntime;
    this.now = options.now ?? Date.now;
  }

  async execute(jobId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.runUntilPause(jobId, signal);
    } catch (error) {
      const runtimeCode = stableFailureCode(error);
      if (runtimeCode === 'FLOW_STORAGE_INVALID')
        throw new ExecutionFailure(runtimeCode);
      const reason = abortReason(signal);
      if (reason === 'RUNNER_STOPPED' || reason === 'JOB_CANCELLED') return;
      const code = reason === 'TIMEOUT' ? 'TIMEOUT' : runtimeCode;
      this.failCurrent(jobId, code);
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposePromise = this.agentRuntime.dispose();
    return this.disposePromise;
  }

  private async runUntilPause(
    jobId: string,
    runnerSignal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (runnerSignal.aborted) {
        if (abortReason(runnerSignal) === 'RUNNER_STOPPED') return;
        if (abortReason(runnerSignal) === 'TIMEOUT') {
          this.failCurrent(jobId, 'TIMEOUT');
          return;
        }
        throw new ExecutionFailure('FLOW_ABORTED');
      }
      const context = this.flowStore.getJobContext(jobId);
      const run = this.flowStore.getPinnedFlowRun(jobId);
      if (context === null || run === null) {
        if (context?.status === 'RUNNING' || run !== null) {
          throw new ExecutionFailure('FLOW_STORAGE_INVALID');
        }
        return;
      }
      if (
        context.status === 'COMPLETED' ||
        context.status === 'FAILED' ||
        context.status === 'CANCELLING' ||
        context.status === 'CANCELLED'
      )
        return;
      if (context.status !== 'RUNNING') return;
      const persistedJob = this.controllerStore.statusForJob(
        context.ownerId,
        jobId,
      );
      if (persistedJob === null || persistedJob.status !== context.status)
        return;
      if (context.deadlineAt !== null && this.now() >= context.deadlineAt) {
        this.failCurrent(jobId, 'TIMEOUT');
        return;
      }
      const state = parseFlowExecutionState(run.state);
      const registry = new FlowRegistry(run.bundle);
      const flow = registry.get(run.flowId);
      const node = registry.getNode(run.flowId, run.nodeId);
      if (flow === undefined || node === undefined) {
        throw new ExecutionFailure('FLOW_SNAPSHOT_INVALID');
      }
      const pending = this.flowStore.getPendingSteering(jobId);
      if (pending.length > 0) {
        const captured = captures(pending);
        const checkpoint =
          node.kind === 'agent' && node.next['revise'] !== undefined
            ? this.flowStore.discardAgentAndRevise({
                jobId,
                expectedRevision: run.revision,
                currentNodeId: run.nodeId,
                captured,
                state: flowExecutionStateJson(state),
              })
            : this.flowStore.checkpointInput({
                jobId,
                expectedRevision: run.revision,
                currentNodeId: run.nodeId,
                captured,
                state: flowExecutionStateJson(state),
              });
        if (checkpoint.status === 'stale') return;
        continue;
      }
      if (node.kind === 'server') {
        const plan = this.handleServerNode({
          jobId,
          sessionId: context.sessionId,
          ownerId: context.ownerId,
          state,
          run,
          flow,
          node,
          registry,
        });
        if (plan.kind === 'wait') {
          const result = this.flowStore.waitAtCurrentNode({
            jobId,
            expectedRevision: run.revision,
            currentNodeId: run.nodeId,
            state: flowExecutionStateJson(plan.state),
            waitPrompt: requiredString(plan.prompt, 'wait prompt'),
          });
          if (result.status === 'stale') return;
          return;
        }
        if (plan.kind === 'finish') {
          const result = this.flowStore.finish({
            jobId,
            expectedRevision: run.revision,
            currentNodeId: run.nodeId,
            state: flowExecutionStateJson(plan.state),
            notificationText: requiredString(plan.notification, 'notification'),
          });
          if (result.status === 'dirty') {
            this.checkpointServerDirty(jobId, run, state);
            continue;
          }
          if (result.status === 'stale') return;
          return;
        }
        const result = this.flowStore.commitFlowStep({
          jobId,
          expectedRevision: run.revision,
          currentNodeId: run.nodeId,
          transition: requiredString(plan.transition, 'server transition'),
          state: flowExecutionStateJson(plan.state),
          outcome: 'run',
          ...(plan.facts === undefined ? {} : { facts: plan.facts }),
        });
        if (result.status === 'stale') return;
        if (result.status === 'dirty') {
          this.checkpointServerDirty(jobId, run, state);
        }
        continue;
      }
      const limits = effectiveNodeLimits(flow, node);
      if (run.transitions >= limits.maxTransitions) {
        throw new ExecutionFailure('FLOW_TRANSITION_LIMIT');
      }
      const invocation = await this.invokeAgent({
        jobId,
        sessionId: context.sessionId,
        ownerId: context.ownerId,
        run,
        state,
        flow,
        node,
        registry,
        runnerSignal,
      });
      if (invocation === null) return;
      if (invocation === 'checkpointed') continue;
      const { result: agentResult, run: freshRun } = invocation;
      if (agentResult.transition === 'revise') {
        const revised = this.flowStore.discardAgentAndRevise({
          jobId,
          expectedRevision: freshRun.revision,
          currentNodeId: freshRun.nodeId,
          captured: captures(this.flowStore.getPendingSteering(jobId)),
          state: flowExecutionStateJson(state),
        });
        if (revised.status === 'stale') return;
        continue;
      }
      if (agentResult.transition === 'complete') {
        const completed = this.completeAgentTerminal({
          jobId,
          run: freshRun,
          state: this.stateWithAgentResult(state, node, agentResult),
          agentResult,
        });
        if (completed === 'dirty') {
          this.reviseDirtyAgent(jobId, freshRun, state, node);
          continue;
        }
        return;
      }
      const stateWithResult = this.stateWithAgentResult(
        state,
        node,
        agentResult,
      );
      const result = this.flowStore.commitFlowStep({
        jobId,
        expectedRevision: freshRun.revision,
        currentNodeId: freshRun.nodeId,
        transition: agentResult.transition,
        agentResult,
        state: flowExecutionStateJson(stateWithResult),
        outcome: 'run',
      });
      if (result.status === 'stale') return;
      if (result.status === 'dirty') {
        this.reviseDirtyAgent(jobId, freshRun, state, node);
      }
    }
  }

  private async invokeAgent(input: {
    readonly jobId: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly run: FlowRun;
    readonly state: FlowExecutionState;
    readonly flow: FlowDefinition;
    readonly node: NodeDefinition;
    readonly registry: FlowRegistry;
    readonly runnerSignal: AbortSignal;
  }): Promise<AgentInvocation | 'checkpointed' | null> {
    let run = input.run;
    const limits = effectiveNodeLimits(input.flow, input.node);
    for (let retry = 0; ; retry += 1) {
      if (input.runnerSignal.aborted) {
        if (abortReason(input.runnerSignal) === 'RUNNER_STOPPED') return null;
        if (abortReason(input.runnerSignal) === 'TIMEOUT') {
          this.failCurrent(input.jobId, 'TIMEOUT');
          return null;
        }
        throw new ExecutionFailure('FLOW_ABORTED');
      }
      const context = this.flowStore.getJobContext(input.jobId);
      if (
        context === null ||
        context.status !== 'RUNNING' ||
        (context.deadlineAt !== null && this.now() >= context.deadlineAt)
      ) {
        this.failCurrent(input.jobId, 'TIMEOUT');
        return null;
      }
      const pendingBeforeRun = this.flowStore.getPendingSteering(input.jobId);
      if (pendingBeforeRun.length > 0) {
        const pendingState =
          input.node.next['revise'] !== undefined
            ? this.flowStore.discardAgentAndRevise({
                jobId: input.jobId,
                expectedRevision: run.revision,
                currentNodeId: run.nodeId,
                captured: captures(pendingBeforeRun),
                state: flowExecutionStateJson(input.state),
              })
            : this.flowStore.checkpointInput({
                jobId: input.jobId,
                expectedRevision: run.revision,
                currentNodeId: run.nodeId,
                captured: captures(pendingBeforeRun),
                state: flowExecutionStateJson(input.state),
              });
        return pendingState.status === 'stale' ? null : 'checkpointed';
      }
      const controller = new AbortController();
      const externalAbort = (): void => {
        controller.abort(input.runnerSignal.reason);
      };
      input.runnerSignal.addEventListener('abort', externalAbort, {
        once: true,
      });
      const deadlineDelay =
        context.deadlineAt === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, context.deadlineAt - this.now());
      const timeoutDelay = Math.min(limits.nodeTimeoutMs, deadlineDelay);
      const timeoutReason =
        deadlineDelay <= limits.nodeTimeoutMs ? 'TIMEOUT' : 'NODE_TIMEOUT';
      const timeout = setTimeout(() => {
        controller.abort(timeoutReason);
      }, timeoutDelay);
      let raw: AgentNodeResult;
      try {
        raw = await this.agentRuntime.run({
          controllerSessionId: input.sessionId,
          jobId: input.jobId,
          node: input.node,
          definition: input.flow,
          input: this.buildAgentInput(input.node, input.state, input.registry),
          state: flowExecutionStateJson(input.state),
          historyFacts: this.historyFacts(
            input.sessionId,
            input.ownerId,
            input.flow,
          ),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        input.runnerSignal.removeEventListener('abort', externalAbort);
        const code = stableFailureCode(error);
        if (code === 'FLOW_STORAGE_INVALID') throw new ExecutionFailure(code);
        if (controller.signal.aborted) {
          const reason = abortReason(controller.signal);
          if (reason === 'RUNNER_STOPPED' || reason === 'JOB_CANCELLED')
            return null;
          if (reason === 'TIMEOUT') {
            this.failCurrent(input.jobId, 'TIMEOUT');
            return null;
          }
          if (reason === 'NODE_TIMEOUT')
            throw new ExecutionFailure('FLOW_NODE_TIMEOUT');
          throw new ExecutionFailure('FLOW_ABORTED');
        }
        if (code === 'FLOW_MODEL_REQUEST_FAILED' && retry < limits.maxRetries) {
          const currentContext = this.flowStore.getJobContext(input.jobId);
          if (
            currentContext === null ||
            (currentContext.deadlineAt !== null &&
              this.now() >= currentContext.deadlineAt)
          ) {
            this.failCurrent(input.jobId, 'TIMEOUT');
            return null;
          }
          const pending = this.flowStore.getPendingSteering(input.jobId);
          if (pending.length > 0) {
            const currentState = this.flowStore.getPinnedFlowRun(input.jobId);
            if (currentState === null) return null;
            this.reviseDirtyAgent(
              input.jobId,
              currentState,
              input.state,
              input.node,
            );
            return 'checkpointed';
          }
          const stepped = this.flowStore.advanceControlStep({
            jobId: input.jobId,
            expectedRevision: run.revision,
            currentNodeId: run.nodeId,
          });
          if (stepped.status !== 'committed') return null;
          run = stepped.run;
          continue;
        }
        throw new ExecutionFailure(code);
      } finally {
        clearTimeout(timeout);
        input.runnerSignal.removeEventListener('abort', externalAbort);
      }
      if (controller.signal.aborted) {
        const reason = abortReason(controller.signal);
        if (reason === 'RUNNER_STOPPED' || reason === 'JOB_CANCELLED')
          return null;
        if (reason === 'TIMEOUT') {
          this.failCurrent(input.jobId, 'TIMEOUT');
          return null;
        }
        if (reason === 'NODE_TIMEOUT')
          throw new ExecutionFailure('FLOW_NODE_TIMEOUT');
        throw new ExecutionFailure('FLOW_ABORTED');
      }
      let validated: AgentNodeResult;
      try {
        validated = validateAgentNodeResult(
          raw,
          input.node,
          limits.maxOutputChars,
        );
      } catch {
        throw new ExecutionFailure('FLOW_RESULT_INVALID');
      }
      const latest = this.flowStore.getPinnedFlowRun(input.jobId);
      if (
        latest === null ||
        latest.revision !== run.revision ||
        latest.nodeId !== run.nodeId
      ) {
        return null;
      }
      return { result: validated, run };
    }
  }

  private handleServerNode(input: {
    readonly jobId: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly state: FlowExecutionState;
    readonly run: FlowRun;
    readonly flow: FlowDefinition;
    readonly node: NodeDefinition;
    readonly registry: FlowRegistry;
  }): ServerPlan {
    switch (input.node.handler) {
      case 'choice':
        return this.handleChoice(input);
      case 'unsupported':
        return {
          kind: 'finish',
          state: input.state,
          notification: renderUnsupported(),
        };
      case 'mbti_collect':
        return this.handleMbtiCollect(input);
      case 'mbti_score':
        return this.handleMbtiScore(input);
      case 'mbti_done':
        return this.mbtiTerminal(input.state);
      case 'natal_input':
        return this.handleNatalInput(input);
      case 'natal_calculate':
        return this.handleNatalCalculate(input);
      case 'natal_done':
        return this.natalTerminal(input.state);
      default:
        throw new ExecutionFailure('FLOW_HANDLER_INVALID');
    }
  }

  private handleChoice(input: {
    readonly jobId: string;
    readonly state: FlowExecutionState;
    readonly run: FlowRun;
    readonly node: NodeDefinition;
    readonly registry: FlowRegistry;
  }): ServerPlan {
    const options = getFlowChoiceOptions(
      input.registry.snapshot(),
      input.run.flowId,
      input.run.nodeId,
      input.node.next,
    );
    const marker = input.state.choiceAfterSequence;
    if (marker === null && input.state.suggestedFlow === null) {
      return {
        kind: 'transition',
        state: {
          ...input.state,
          pendingPurpose: null,
          selectedFlow: null,
          choiceAfterSequence: lastInputSequence(input.state),
        },
        transition: 'unsupported',
      };
    }
    const choices = marker === null ? [] : steeringAfter(input.state, marker);
    const choiceText = choices.at(-1)?.content;
    if (choiceText !== undefined) {
      if (isUnsupportedChoice(choiceText)) {
        return {
          kind: 'transition',
          state: {
            ...input.state,
            pendingPurpose: null,
            selectedFlow: null,
            choiceAfterSequence: lastInputSequence(input.state),
          },
          transition: 'unsupported',
        };
      }
      const option = resolveChoice(choiceText, options);
      if (option !== null) {
        const transition = Object.keys(input.node.next).find((key) => {
          const target = input.registry.getTarget(
            input.run.flowId,
            input.run.nodeId,
            key,
          );
          return target.flowId === option.id;
        });
        if (transition === undefined)
          throw new ExecutionFailure('FLOW_TARGET_INVALID');
        return {
          kind: 'transition',
          state: {
            ...input.state,
            pendingPurpose: null,
            selectedFlow: option.id,
            choiceAfterSequence: lastInputSequence(input.state),
          },
          transition,
        };
      }
      const state = {
        ...input.state,
        pendingPurpose: 'choice',
        choiceAfterSequence: lastInputSequence(input.state),
      };
      return {
        kind: 'wait',
        state,
        prompt: renderChoiceRetry(options, input.jobId),
      };
    }
    if (marker === null) {
      const state = {
        ...input.state,
        pendingPurpose: 'choice',
        choiceAfterSequence: lastInputSequence(input.state),
      };
      const suggested = state.suggestedFlow;
      const suggestion =
        suggested !== null && options.some((option) => option.id === suggested)
          ? suggested
          : null;
      return {
        kind: 'wait',
        state,
        prompt: renderChoicePrompt(options, suggestion, input.jobId),
      };
    }
    const state = {
      ...input.state,
      pendingPurpose: 'choice',
      choiceAfterSequence: lastInputSequence(input.state),
    };
    return {
      kind: 'wait',
      state,
      prompt: renderChoicePrompt(
        options,
        input.state.suggestedFlow,
        input.jobId,
      ),
    };
  }

  private handleMbtiCollect(input: {
    readonly jobId: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly state: FlowExecutionState;
    readonly flow: FlowDefinition;
  }): ServerPlan {
    const history = this.mbtiHistory(
      input.sessionId,
      input.ownerId,
      input.flow,
    );
    let state = input.state;
    if (history !== null) {
      state = {
        ...state,
        mbtiAnswers:
          state.mbtiAnswers.length === 0 ? history : state.mbtiAnswers,
        sources: { ...state.sources, subject: 'self' },
      };
    }
    const lastSteer = state.inputs
      .filter((item) => item.source === 'steering')
      .at(-1);
    const explicitSelf =
      lastSteer !== undefined &&
      /本人|我自己|for myself|my own/i.test(lastSteer.content);
    if (
      (lastSteer !== undefined && isThirdPartyRequest(lastSteer.content)) ||
      (isThirdPartyRequest(state.request) && !explicitSelf)
    ) {
      const nextState = {
        ...state,
        pendingPurpose: 'mbti_questions',
        answerAfterSequence: lastInputSequence(state),
      };
      return {
        kind: 'wait',
        state: nextState,
        prompt: renderThirdPartyClarification(input.jobId),
      };
    }
    if (lastSteer !== undefined && isGoalChange(lastSteer.content)) {
      const nextState = {
        ...state,
        pendingPurpose: 'mbti_questions',
        answerAfterSequence: lastInputSequence(state),
      };
      return {
        kind: 'wait',
        state: nextState,
        prompt: renderGoalChangePrompt('MBTI', input.jobId),
      };
    }

    const marker = state.answerAfterSequence;
    const newInputs = marker === null ? [] : steeringAfter(state, marker);
    const clarification = state.pendingPurpose === 'mbti_clarification';
    const questionMode =
      state.pendingPurpose === 'mbti_questions' || clarification;
    if (questionMode && newInputs.length > 0) {
      const explicitIds = questionIdsIn(
        newInputs.map((item) => item.content).join('\n'),
      );
      const confirmedIds = new Set(
        state.mbtiAnswers.map((answer) => answer.questionId),
      );
      const requestedCorrections = explicitIds.filter((id) =>
        confirmedIds.has(id),
      );
      if (requestedCorrections.length > 0) {
        state = {
          ...state,
          askedQuestionIds: uniqueNumbers([
            ...state.askedQuestionIds,
            ...requestedCorrections,
          ]),
          pendingPurpose: 'mbti_clarification',
        };
      }
      const ids = state.askedQuestionIds;
      if (ids.length === 0) {
        const extracted = questionIdsIn(
          newInputs.map((item) => item.content).join('\n'),
        );
        if (extracted.length === 0) {
          const nextState = {
            ...state,
            pendingPurpose: 'mbti_clarification',
            answerAfterSequence: lastInputSequence(state),
          };
          return {
            kind: 'wait',
            state: nextState,
            prompt: renderMbtiIdClarification(input.jobId),
          };
        }
        state = { ...state, askedQuestionIds: extracted };
      }
      return {
        kind: 'transition',
        state: { ...state, pendingPurpose: 'mbti_parse' },
        transition: 'parse',
      };
    }
    if (marker !== null && newInputs.length > 0 && !questionMode) {
      const extracted = questionIdsIn(
        newInputs.map((item) => item.content).join('\n'),
      );
      if (extracted.length > 0) {
        state = {
          ...state,
          askedQuestionIds: extracted,
          answerAfterSequence: marker,
          pendingPurpose: 'mbti_parse',
        };
        return { kind: 'transition', state, transition: 'parse' };
      }
      const waitState = {
        ...state,
        askedQuestionIds: [],
        pendingPurpose: 'mbti_clarification',
        answerAfterSequence: lastInputSequence(state),
      };
      return {
        kind: 'wait',
        state: waitState,
        prompt: renderMbtiIdClarification(input.jobId),
      };
    }

    if (state.mbtiAnswers.length === MBTI_QUESTIONS.length) {
      state = {
        ...state,
        mbtiReuse: true,
        askedQuestionIds: [],
        answerAfterSequence: lastInputSequence(state),
        pendingPurpose: 'mbti_parse',
      };
      return { kind: 'transition', state, transition: 'parse' };
    }
    const clarificationIds = clarification ? state.askedQuestionIds : [];
    const questions = selectMbtiQuestionBatch(
      state.mbtiAnswers,
      clarificationIds,
    );
    if (questions.length === 0) {
      state = {
        ...state,
        mbtiReuse: true,
        askedQuestionIds: [],
        answerAfterSequence: lastInputSequence(state),
        pendingPurpose: 'mbti_parse',
      };
      return { kind: 'transition', state, transition: 'parse' };
    }
    const nextState = {
      ...state,
      pendingPurpose: clarification ? 'mbti_clarification' : 'mbti_questions',
      askedQuestionIds: questions.map((question) => question.id),
      answerAfterSequence: lastInputSequence(state),
    };
    return {
      kind: 'wait',
      state: nextState,
      prompt: renderMbtiQuestions(questions, input.jobId),
    };
  }

  private handleMbtiScore(input: {
    readonly jobId: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly state: FlowExecutionState;
    readonly flow: FlowDefinition;
  }): ServerPlan {
    const state = input.state;
    const history = this.mbtiHistory(
      input.sessionId,
      input.ownerId,
      input.flow,
    );
    if (state.mbtiReuse) {
      const answers = history ?? state.mbtiAnswers;
      if (answers.length !== MBTI_QUESTIONS.length) {
        return {
          kind: 'transition',
          state: { ...state, mbtiReuse: false, mbtiCandidate: null },
          transition: 'collect',
        };
      }
      const assessment = evaluateMbtiAnswers(answers);
      return {
        kind: 'transition',
        state: {
          ...state,
          mbtiAnswers: answers,
          mbtiAssessment: assessment,
          mbtiCandidate: null,
          mbtiReuse: false,
          pendingPurpose: null,
          sources: { ...state.sources, subject: 'self' },
        },
        transition: 'analyze',
      };
    }
    const candidate = state.mbtiCandidate;
    if (candidate === null) {
      return {
        kind: 'transition',
        state: {
          ...state,
          pendingPurpose: 'mbti_questions',
          answerAfterSequence: lastInputSequence(state),
          askedQuestionIds: [],
        },
        transition: 'collect',
      };
    }
    if (!candidate.presented) {
      const answers = validateMbtiAnswers(candidate.answers);
      if (answers.length === 0) {
        return {
          kind: 'transition',
          state: {
            ...state,
            mbtiCandidate: null,
            pendingPurpose: 'mbti_questions',
            answerAfterSequence: lastInputSequence(state),
            askedQuestionIds: [],
          },
          transition: 'collect',
        };
      }
      if (
        answers.some(
          (answer) => !state.askedQuestionIds.includes(answer.questionId),
        )
      ) {
        throw new ExecutionFailure('FLOW_RESULT_INVALID');
      }
      const existing = new Map(
        (history ?? []).map((answer) => [answer.questionId, answer.value]),
      );
      const conflicts = answers.flatMap((answer) => {
        const oldValue = existing.get(answer.questionId);
        return oldValue !== undefined && oldValue !== answer.value
          ? [
              {
                questionId: answer.questionId,
                oldValue,
                newValue: answer.value,
              },
            ]
          : [];
      });
      const presentedCandidate = {
        ...candidate,
        answers,
        presented: true,
        afterSequence: lastInputSequence(state),
      };
      return {
        kind: 'wait',
        state: {
          ...state,
          mbtiCandidate: presentedCandidate,
          pendingPurpose: 'mbti_confirmation',
        },
        prompt: renderMbtiCandidate(answers, input.jobId, conflicts),
      };
    }
    const after = candidate.afterSequence;
    const replies = after === null ? [] : steeringAfter(state, after);
    const reply = replies.at(-1)?.content;
    if (reply === undefined) {
      return {
        kind: 'wait',
        state,
        prompt: renderMbtiCandidate(candidate.answers, input.jobId),
      };
    }
    if (isThirdPartyRequest(reply)) {
      return {
        kind: 'wait',
        state: {
          ...state,
          pendingPurpose: 'mbti_confirmation',
          mbtiCandidate: {
            ...candidate,
            afterSequence: lastInputSequence(state),
          },
        },
        prompt: renderThirdPartyClarification(input.jobId),
      };
    }
    if (replies.length === 1 && isSelfConfirmation(reply)) {
      const existing =
        history === null
          ? null
          : {
              ownerId: input.ownerId,
              bankVersion: MBTI_BANK_VERSION,
              answers: history,
            };
      const clarificationIds = candidate.answers.map(
        (answer) => answer.questionId,
      );
      const merged = mergeMbtiAnswerHistory(
        existing,
        input.ownerId,
        candidate.answers,
        clarificationIds,
      );
      const assessment = evaluateMbtiAnswers(merged.answers);
      const priorFact = this.flowStore.getSessionFact(
        input.sessionId,
        input.ownerId,
        'mbti_answers',
      );
      const confirmedState: FlowExecutionState = {
        ...state,
        pendingPurpose: null,
        sources: {
          ...state.sources,
          subject: 'self',
          confirmationMessageIds: uniqueStrings([
            ...sourceConfirmationIds(priorFact?.source ?? null),
            replies[0]?.id ?? '',
          ]),
        },
        mbtiAnswers: merged.answers,
        mbtiCandidate: null,
        mbtiAssessment: assessment,
        mbtiReuse: false,
        answerAfterSequence: lastInputSequence(state),
        askedQuestionIds: [],
      };
      const source = factSource(
        confirmedState,
        input.flow.version,
        MBTI_BANK_VERSION,
      );
      const fact: SessionFactWrite = {
        kind: 'mbti_answers',
        value: {
          bankVersion: MBTI_BANK_VERSION,
          answers: merged.answers,
        } as unknown as JsonValue,
        source,
        flowVersion: input.flow.version,
        bankVersion: MBTI_BANK_VERSION,
        confirmed: true,
      };
      return {
        kind: 'transition',
        state: confirmedState,
        transition: assessment.complete ? 'analyze' : 'collect',
        facts: [fact],
      };
    }
    const explicitAnswers =
      /(?:^|\s)(?:[1-9]|1[0-2])\s*[=:：]\s*(?:-2|-1|0|1|2|null)(?:\s|$)/i.test(
        reply,
      );
    const clarified = {
      ...state,
      pendingPurpose: 'mbti_clarification',
      askedQuestionIds: candidate.answers.map((answer) => answer.questionId),
      answerAfterSequence:
        explicitAnswers && after !== null ? after : lastInputSequence(state),
      mbtiCandidate: null,
      mbtiReuse: false,
    };
    return {
      kind: 'transition',
      state: clarified,
      transition: 'collect',
    };
  }

  private mbtiTerminal(state: FlowExecutionState): ServerPlan {
    if (state.mbtiAssessment === null || state.interpretation === null) {
      throw new ExecutionFailure('FLOW_RESULT_INVALID');
    }
    return {
      kind: 'finish',
      state,
      notification: renderMbtiResult(
        state.mbtiAssessment,
        state.interpretation,
      ),
    };
  }

  private handleNatalInput(input: {
    readonly jobId: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly state: FlowExecutionState;
    readonly flow: FlowDefinition;
  }): ServerPlan {
    let state = input.state;
    const history = this.natalHistory(
      input.sessionId,
      input.ownerId,
      input.flow,
    );
    if (history !== null) {
      state = {
        ...state,
        natalConfirmed: state.natalConfirmed ?? history,
        sources: { ...state.sources, subject: 'self' },
      };
    }
    const latest = state.inputs
      .filter((item) => item.source === 'steering')
      .at(-1);
    const unknownBirthTime =
      (latest !== undefined && claimsUnknownBirthTime(latest.content)) ||
      (!state.birthParsedInitial && claimsUnknownBirthTime(state.request));
    const suppliedBirthTime =
      latest !== undefined && hasExplicitBirthTime(latest.content);
    if (unknownBirthTime || (state.birthTimeUnknown && suppliedBirthTime)) {
      state = {
        ...state,
        birthTimeUnknown: unknownBirthTime || !suppliedBirthTime,
        chart: null,
        interpretation: null,
      };
    }
    if (latest !== undefined && isGoalChange(latest.content)) {
      const nextState = {
        ...state,
        pendingPurpose: 'natal_input',
        birthAfterSequence: lastInputSequence(state),
      };
      return {
        kind: 'wait',
        state: nextState,
        prompt: renderGoalChangePrompt('出生星盤', input.jobId),
      };
    }
    if (latest !== undefined && isThirdPartyRequest(latest.content)) {
      const refs = uniqueStrings([
        ...state.birthParseRefs,
        ...state.inputs.map((item) => item.id),
      ]);
      const nextState = {
        ...state,
        birthParsedInitial: true,
        birthParseRefs: refs,
        pendingPurpose: 'natal_input',
        birthAfterSequence: lastInputSequence(state),
      };
      return {
        kind: 'wait',
        state: nextState,
        prompt: renderThirdPartyClarification(input.jobId),
      };
    }

    const newInputs = state.inputs.filter(
      (item) =>
        item.source === 'steering' && !state.birthParseRefs.includes(item.id),
    );
    if (
      state.pendingPurpose === 'natal_confirmation' &&
      state.birthCandidatePresented
    ) {
      const after = state.birthAfterSequence;
      const replies = after === null ? [] : steeringAfter(state, after);
      const reply = replies.at(-1)?.content;
      if (reply === undefined) {
        return {
          kind: 'wait',
          state,
          prompt: renderNatalCandidate(
            state.birthCandidate ?? {},
            input.jobId,
            state.natalConfirmed ?? undefined,
          ),
        };
      }
      if (replies.length === 1 && isSelfConfirmation(reply)) {
        const full = fullBirthInput(state.birthCandidate, state.natalConfirmed);
        if (full === null) throw new ExecutionFailure('FLOW_RESULT_INVALID');
        this.validateBirthInput(full);
        const priorFact = this.flowStore.getSessionFact(
          input.sessionId,
          input.ownerId,
          'natal_birth',
        );
        const confirmed: FlowExecutionState = {
          ...state,
          sources: {
            ...state.sources,
            subject: 'self',
            confirmationMessageIds: uniqueStrings([
              ...sourceConfirmationIds(priorFact?.source ?? null),
              replies[0]?.id ?? '',
            ]),
          },
          pendingPurpose: null,
          natalConfirmed: full,
          birthCandidate: full,
          birthCandidatePresented: false,
          birthTimeUnknown: false,
          birthAfterSequence: lastInputSequence(state),
          chart: null,
          interpretation: null,
        };
        const fact: SessionFactWrite = {
          kind: 'natal_birth',
          value: full as unknown as JsonValue,
          source: factSource(
            confirmed,
            input.flow.version,
            NATAL_METHOD_VERSION,
          ),
          flowVersion: input.flow.version,
          bankVersion: NATAL_METHOD_VERSION,
          confirmed: true,
        };
        return {
          kind: 'transition',
          state: confirmed,
          transition: 'ready',
          facts: [fact],
        };
      }
      if (isThirdPartyRequest(reply)) {
        return {
          kind: 'wait',
          state: {
            ...state,
            pendingPurpose: 'natal_confirmation',
            birthAfterSequence: lastInputSequence(state),
          },
          prompt: renderThirdPartyClarification(input.jobId),
        };
      }
      const replyInputs = replies;
      if (replyInputs.length > 0) {
        const refs = replyInputs.map((item) => item.id);
        return {
          kind: 'transition',
          state: {
            ...state,
            pendingPurpose: 'natal_parse',
            birthParseText: replyInputs.map((item) => item.content).join('\n'),
            birthParseRefs: uniqueStrings([...state.birthParseRefs, ...refs]),
            birthCandidatePresented: false,
            birthCandidateRefs: [],
            birthTimeUnknown:
              claimsUnknownBirthTime(
                replyInputs.map((item) => item.content).join('\n'),
              ) ||
              (state.birthTimeUnknown &&
                !replyInputs.some((item) =>
                  hasExplicitBirthTime(item.content),
                )),
          },
          transition: 'parse',
        };
      }
    }

    if (!state.birthParsedInitial) {
      const refs = state.inputs.map((item) => item.id);
      if (isThirdPartyRequest(state.request)) {
        const nextState = {
          ...state,
          birthParsedInitial: true,
          birthParseRefs: uniqueStrings([...state.birthParseRefs, ...refs]),
          pendingPurpose: 'natal_input',
          birthAfterSequence: lastInputSequence(state),
        };
        return {
          kind: 'wait',
          state: nextState,
          prompt: renderThirdPartyClarification(input.jobId),
        };
      }
      return {
        kind: 'transition',
        state: {
          ...state,
          birthParsedInitial: true,
          birthParseText: state.request,
          birthParseRefs: uniqueStrings([...state.birthParseRefs, ...refs]),
          birthTimeUnknown: claimsUnknownBirthTime(state.request),
          pendingPurpose: 'natal_parse',
        },
        transition: 'parse',
      };
    }

    if (newInputs.length > 0 && state.pendingPurpose !== 'natal_confirmation') {
      if (newInputs.some((item) => isThirdPartyRequest(item.content))) {
        return {
          kind: 'wait',
          state: {
            ...state,
            birthParseRefs: uniqueStrings([
              ...state.birthParseRefs,
              ...newInputs.map((item) => item.id),
            ]),
            pendingPurpose: 'natal_input',
            birthAfterSequence: lastInputSequence(state),
          },
          prompt: renderThirdPartyClarification(input.jobId),
        };
      }
      return {
        kind: 'transition',
        state: {
          ...state,
          pendingPurpose: 'natal_parse',
          birthParseText: newInputs.map((item) => item.content).join('\n'),
          birthParseRefs: uniqueStrings([
            ...state.birthParseRefs,
            ...newInputs.map((item) => item.id),
          ]),
          birthCandidatePresented: false,
          birthCandidateRefs: [],
          birthTimeUnknown:
            claimsUnknownBirthTime(
              newInputs.map((item) => item.content).join('\n'),
            ) ||
            (state.birthTimeUnknown &&
              !newInputs.some((item) => hasExplicitBirthTime(item.content))),
        },
        transition: 'parse',
      };
    }

    const candidate = state.birthTimeUnknown
      ? withoutBirthTime(state.birthCandidate)
      : state.birthCandidate;
    const confirmedForInput = state.birthTimeUnknown
      ? withoutBirthTime(state.natalConfirmed)
      : state.natalConfirmed;
    const full = fullBirthInput(candidate, confirmedForInput);
    if (
      candidate === null &&
      state.natalConfirmed !== null &&
      !state.birthTimeUnknown
    ) {
      this.validateBirthInput(state.natalConfirmed);
      return {
        kind: 'transition',
        state: {
          ...state,
          pendingPurpose: null,
          birthCandidate: state.natalConfirmed,
          chart: null,
          interpretation: null,
        },
        transition: 'ready',
      };
    }
    if (full === null) {
      const base = candidate ?? confirmedForInput ?? {};
      const missing = missingBirthFields(base);
      return {
        kind: 'wait',
        state: {
          ...state,
          pendingPurpose: 'natal_input',
          birthCandidate: candidate,
          birthCandidatePresented: false,
          birthAfterSequence: lastInputSequence(state),
        },
        prompt: renderNatalMissing(missing, input.jobId),
      };
    }
    try {
      this.validateBirthInput(full);
    } catch (error) {
      const code =
        error instanceof BirthValidationError ? error.code : 'INVALID_INPUT';
      return {
        kind: 'wait',
        state: {
          ...state,
          birthCandidate: full,
          pendingPurpose: 'natal_input',
          birthCandidatePresented: false,
          birthAfterSequence: lastInputSequence(state),
        },
        prompt: renderNatalValidationError(code, input.jobId),
      };
    }
    const hasNewCandidate =
      candidate !== null && state.birthCandidateRefs.length > 0;
    if (!hasNewCandidate && state.natalConfirmed !== null) {
      return {
        kind: 'transition',
        state: {
          ...state,
          natalConfirmed: state.natalConfirmed,
          birthCandidate: state.natalConfirmed,
          pendingPurpose: null,
          chart: null,
          interpretation: null,
        },
        transition: 'ready',
      };
    }
    const conflicts =
      state.natalConfirmed !== null &&
      !sameBirthInput(full, state.natalConfirmed);
    return {
      kind: 'wait',
      state: {
        ...state,
        birthCandidate: full,
        birthCandidatePresented: true,
        birthAfterSequence: lastInputSequence(state),
        pendingPurpose: 'natal_confirmation',
      },
      prompt: renderNatalCandidate(
        full,
        input.jobId,
        conflicts ? (state.natalConfirmed ?? undefined) : undefined,
      ),
    };
  }

  private handleNatalCalculate(input: {
    readonly state: FlowExecutionState;
    readonly flow: FlowDefinition;
    readonly node: NodeDefinition;
  }): ServerPlan {
    if (
      !(input.node.tools ?? []).includes('calculate_natal_chart') ||
      effectiveNodeLimits(input.flow, input.node).maxToolCalls < 1
    ) {
      throw new ExecutionFailure('FLOW_TOOL_UNAVAILABLE');
    }
    if (
      input.state.natalConfirmed === null ||
      input.state.sources.subject !== 'self' ||
      input.state.birthTimeUnknown
    ) {
      throw new ExecutionFailure('FLOW_RESULT_INVALID');
    }
    this.validateBirthInput(input.state.natalConfirmed);
    const chart = calculateNatalChart(input.state.natalConfirmed);
    return {
      kind: 'transition',
      state: {
        ...input.state,
        chart,
        interpretation: null,
        pendingPurpose: null,
      },
      transition: 'calculated',
    };
  }

  private natalTerminal(state: FlowExecutionState): ServerPlan {
    if (state.chart === null || state.interpretation === null) {
      throw new ExecutionFailure('FLOW_RESULT_INVALID');
    }
    return {
      kind: 'finish',
      state,
      notification: renderNatalChart(state.chart, state.interpretation),
    };
  }

  private stateWithAgentResult(
    state: FlowExecutionState,
    node: NodeDefinition,
    result: AgentNodeResult,
  ): FlowExecutionState {
    if (node.resultContract === 'recommendation') {
      const payload = result.result as {
        readonly suggestedFlow: string | null;
      };
      return { ...state, suggestedFlow: payload.suggestedFlow };
    }
    if (node.resultContract === 'mbti_answers') {
      const payload = result.result as unknown as {
        readonly answers: readonly MbtiAnswer[];
      };
      if (state.mbtiReuse && payload.answers.length !== 0) {
        throw new ExecutionFailure('FLOW_RESULT_INVALID');
      }
      if (
        payload.answers.some(
          (answer) => !state.askedQuestionIds.includes(answer.questionId),
        )
      ) {
        throw new ExecutionFailure('FLOW_RESULT_INVALID');
      }
      const sourceIds = inputsAfter(state, state.answerAfterSequence).map(
        (item) => item.id,
      );
      return {
        ...state,
        mbtiCandidate: {
          answers: validateMbtiAnswers(payload.answers),
          presented: false,
          afterSequence: null,
          sourceMessageIds: sourceIds,
        },
        mbtiReuse: state.mbtiReuse,
      };
    }
    if (node.resultContract === 'birth_input') {
      const received = result.result as Partial<BirthChartInput>;
      const payload = state.birthTimeUnknown
        ? withoutBirthTime(received)
        : received;
      const currentCandidate = state.birthTimeUnknown
        ? withoutBirthTime(state.birthCandidate)
        : state.birthCandidate;
      const recentSteering = state.inputs.filter(
        (item) =>
          item.source === 'steering' && !state.birthParseRefs.includes(item.id),
      );
      const candidate = mergeBirthCandidate(currentCandidate, payload);
      const refs = uniqueStrings([
        ...state.birthCandidateRefs,
        ...state.birthParseRefs,
        ...recentSteering.map((item) => item.id),
      ]);
      return {
        ...state,
        birthCandidate: Object.keys(candidate).length === 0 ? null : candidate,
        birthCandidateRefs: refs,
        birthParseRefs: uniqueStrings([
          ...state.birthParseRefs,
          ...recentSteering.map((item) => item.id),
        ]),
        birthParseText: null,
        pendingPurpose: null,
      };
    }
    if (node.resultContract === 'interpretation') {
      const interpretation =
        result.result as FlowExecutionState['interpretation'];
      if (interpretation === null)
        throw new ExecutionFailure('FLOW_RESULT_INVALID');
      return { ...state, interpretation };
    }
    throw new ExecutionFailure('FLOW_RESULT_INVALID');
  }

  private buildAgentInput(
    node: NodeDefinition,
    state: FlowExecutionState,
    registry: FlowRegistry,
  ): string {
    switch (node.resultContract) {
      case 'recommendation': {
        const updates = state.inputs
          .filter((item) => item.source === 'steering')
          .map((item) => ({ messageId: item.id, content: item.content }));
        const businessFlows = registry
          .list()
          .filter((flow) => flow.id !== 'intake')
          .map((flow) => ({
            id: flow.id,
            name: flow.name,
            aliases: flow.aliases,
            resultDescription: flow.resultDescription,
            nodes: flow.nodes.map((flowNode) => ({
              id: flowNode.id,
              kind: flowNode.kind,
              summary: flowNode.expectedResult,
            })),
          }));
        return JSON.stringify({
          request: state.request,
          updates,
          businessFlows,
          instruction:
            '只能使用 businessFlows 中列出的 Flow ID。不得猜測或建立 Registry ID。',
        });
      }
      case 'mbti_answers': {
        const questions = MBTI_QUESTIONS.filter((question) =>
          state.askedQuestionIds.includes(question.id),
        );
        const rawAnswers = inputsAfter(state, state.answerAfterSequence).map(
          (item) => ({
            messageId: item.id,
            sequence: item.sequence,
            text: item.content,
          }),
        );
        return JSON.stringify({
          bankVersion: MBTI_BANK_VERSION,
          questions,
          askedQuestionIds: state.askedQuestionIds,
          rawAnswers,
          reuseConfirmedHistory: state.mbtiReuse,
        });
      }
      case 'birth_input': {
        const additional = state.inputs.filter(
          (item) =>
            item.source === 'steering' &&
            !state.birthParseRefs.includes(item.id),
        );
        return JSON.stringify({
          explicitUserText: [
            state.birthParseText,
            ...additional.map((item) => item.content),
          ]
            .filter((text): text is string => text !== null && text.length > 0)
            .join('\n'),
          sourceMessageIds: uniqueStrings([
            ...state.birthParseRefs,
            ...additional.map((item) => item.id),
          ]),
        });
      }
      case 'interpretation': {
        if (state.mbtiAssessment !== null) {
          return JSON.stringify({
            request: state.request,
            bankVersion: state.mbtiAssessment.bankVersion,
            type: state.mbtiAssessment.type,
            candidates: state.mbtiAssessment.candidates,
            axes: state.mbtiAssessment.axes,
            disclaimer: MBTI_DISCLAIMER,
          });
        }
        if (state.chart !== null) {
          return JSON.stringify({
            request: state.request,
            confirmedBirthInput: state.natalConfirmed,
            chart: state.chart,
          });
        }
        throw new ExecutionFailure('FLOW_RESULT_INVALID');
      }
      default:
        return JSON.stringify({ request: state.request });
    }
  }

  private historyFacts(
    sessionId: string,
    ownerId: string,
    flow: FlowDefinition,
  ): readonly JsonValue[] {
    const facts = this.flowStore.getSessionFacts(sessionId, ownerId);
    return facts.flatMap((fact) => {
      const source = isRecord(fact.source) ? fact.source : null;
      const subject = source?.['subject'];
      if (fact.flowVersion !== flow.version || subject !== 'self') return [];
      try {
        if (
          flow.id === 'mbti' &&
          fact.kind === 'mbti_answers' &&
          fact.bankVersion === MBTI_BANK_VERSION
        ) {
          if (
            !isRecord(fact.value) ||
            fact.value['bankVersion'] !== MBTI_BANK_VERSION
          ) {
            return [];
          }
          validateMbtiAnswers(fact.value['answers']);
          return [fact.value];
        }
        if (
          flow.id === 'natal' &&
          fact.kind === 'natal_birth' &&
          fact.bankVersion === NATAL_METHOD_VERSION
        ) {
          const birthInput = validateBirthChartInput(fact.value);
          resolveBirthTimeToUtc(birthInput);
          return [fact.value];
        }
      } catch {
        return [];
      }
      return [];
    });
  }

  private mbtiHistory(
    sessionId: string,
    ownerId: string,
    flow: FlowDefinition,
  ): readonly MbtiAnswer[] | null {
    const fact = this.flowStore.getSessionFact(
      sessionId,
      ownerId,
      'mbti_answers',
    );
    if (
      fact === null ||
      fact.bankVersion !== MBTI_BANK_VERSION ||
      fact.flowVersion !== flow.version ||
      !sourceIsSelf(fact.source)
    ) {
      return null;
    }
    if (
      !isRecord(fact.value) ||
      fact.value['bankVersion'] !== MBTI_BANK_VERSION
    ) {
      return null;
    }
    try {
      return validateMbtiAnswers(fact.value['answers']);
    } catch {
      return null;
    }
  }

  private natalHistory(
    sessionId: string,
    ownerId: string,
    flow: FlowDefinition,
  ): BirthChartInput | null {
    const fact = this.flowStore.getSessionFact(
      sessionId,
      ownerId,
      'natal_birth',
    );
    if (
      fact === null ||
      fact.bankVersion !== NATAL_METHOD_VERSION ||
      fact.flowVersion !== flow.version ||
      !sourceIsSelf(fact.source)
    ) {
      return null;
    }
    try {
      const input = validateBirthChartInput(fact.value);
      resolveBirthTimeToUtc(input);
      return input;
    } catch {
      return null;
    }
  }

  private validateBirthInput(value: BirthChartInput): void {
    validateBirthChartInput(value);
    resolveBirthTimeToUtc(value);
  }

  private checkpointServerDirty(
    jobId: string,
    run: FlowRun,
    state: FlowExecutionState,
  ): void {
    const pending = this.flowStore.getPendingSteering(jobId);
    if (pending.length === 0) return;
    this.flowStore.checkpointInput({
      jobId,
      expectedRevision: run.revision,
      currentNodeId: run.nodeId,
      captured: captures(pending),
      state: flowExecutionStateJson(state),
    });
  }

  private reviseDirtyAgent(
    jobId: string,
    run: FlowRun,
    state: FlowExecutionState,
    node: NodeDefinition,
  ): void {
    const pending = this.flowStore.getPendingSteering(jobId);
    if (node.next['revise'] !== undefined) {
      this.flowStore.discardAgentAndRevise({
        jobId,
        expectedRevision: run.revision,
        currentNodeId: run.nodeId,
        captured: captures(pending),
        state: flowExecutionStateJson(state),
      });
      return;
    }
    this.flowStore.checkpointInput({
      jobId,
      expectedRevision: run.revision,
      currentNodeId: run.nodeId,
      captured: captures(pending),
      state: flowExecutionStateJson(state),
    });
  }

  private completeAgentTerminal(input: {
    readonly jobId: string;
    readonly run: FlowRun;
    readonly state: FlowExecutionState;
    readonly agentResult: AgentNodeResult;
  }): 'committed' | 'dirty' | 'stale' {
    try {
      const result = this.flowStore.transaction(() => {
        const step = this.flowStore.commitFlowStep({
          jobId: input.jobId,
          expectedRevision: input.run.revision,
          currentNodeId: input.run.nodeId,
          transition: input.agentResult.transition,
          agentResult: input.agentResult,
          state: flowExecutionStateJson(input.state),
          outcome: 'run',
        });
        if (step.status !== 'committed') return step.status;

        const registry = new FlowRegistry(step.run.bundle);
        const terminalFlow = registry.get(step.run.flowId);
        const terminalNode = registry.getNode(step.run.flowId, step.run.nodeId);
        if (
          terminalFlow === undefined ||
          terminalNode?.kind !== 'server' ||
          Object.keys(terminalNode.next).length !== 0
        ) {
          throw new ExecutionFailure('FLOW_COMPLETE_INVALID');
        }
        const context = this.flowStore.getJobContext(input.jobId);
        if (context === null || context.status !== 'RUNNING') {
          throw new ExecutionFailure('FLOW_STORAGE_INVALID');
        }
        const plan = this.handleServerNode({
          jobId: input.jobId,
          sessionId: context.sessionId,
          ownerId: context.ownerId,
          state: input.state,
          run: step.run,
          flow: terminalFlow,
          node: terminalNode,
          registry,
        });
        if (plan.kind !== 'finish') {
          throw new ExecutionFailure('FLOW_COMPLETE_INVALID');
        }
        const terminal = this.flowStore.finish({
          jobId: input.jobId,
          expectedRevision: step.run.revision,
          currentNodeId: step.run.nodeId,
          state: flowExecutionStateJson(plan.state),
          notificationText: requiredString(plan.notification, 'notification'),
        });
        if (terminal.status === 'dirty' || terminal.status === 'stale') {
          throw new DirtyCompletion();
        }
        return terminal.status;
      });
      return result;
    } catch (error) {
      if (error instanceof DirtyCompletion) return 'dirty';
      throw error;
    }
  }

  private failCurrent(jobId: string, code: string): void {
    const stable = stableFailureCode(code);
    let run: FlowRun | null;
    let context: FlowJobContext | null;
    try {
      run = this.flowStore.getPinnedFlowRun(jobId);
      context = this.flowStore.getJobContext(jobId);
    } catch {
      throw new ExecutionFailure('FLOW_STORAGE_INVALID');
    }
    if (run === null) {
      if (context?.status === 'RUNNING') {
        throw new ExecutionFailure('FLOW_STORAGE_INVALID');
      }
      return;
    }
    if (context === null) throw new ExecutionFailure('FLOW_STORAGE_INVALID');
    if (
      context.status === 'COMPLETED' ||
      context.status === 'FAILED' ||
      context.status === 'CANCELLING' ||
      context.status === 'CANCELLED'
    )
      return;
    let result: FlowStepResult;
    try {
      result = this.flowStore.fail({
        jobId,
        expectedRevision: run.revision,
        currentNodeId: run.nodeId,
        state: run.state,
        failureCode: stable,
      });
    } catch {
      throw new ExecutionFailure('FLOW_STORAGE_INVALID');
    }
    if (result.status === 'stale') {
      try {
        if (this.flowStore.getJobContext(jobId)?.status === 'RUNNING') {
          throw new ExecutionFailure('FLOW_STORAGE_INVALID');
        }
      } catch (error) {
        if (error instanceof ExecutionFailure) throw error;
        throw new ExecutionFailure('FLOW_STORAGE_INVALID');
      }
    }
  }
}

function captures(pending: readonly PendingSteering[]) {
  return pending.map(({ id, sequence }) => ({ id, sequence }));
}

function stableFailureCode(error: unknown): string {
  if (typeof error === 'string') {
    return STABLE_RUNTIME_CODES.has(error) || STABLE_DOMAIN_CODES.has(error)
      ? error
      : 'FLOW_EXECUTION_FAILED';
  }
  if (error instanceof ExecutionFailure) return stableFailureCode(error.code);
  if (
    error instanceof PiCliRpcRuntimeError &&
    STABLE_RUNTIME_CODES.has(error.code)
  ) {
    return error.code;
  }
  if (error instanceof DomainError && STABLE_DOMAIN_CODES.has(error.code)) {
    return error.code;
  }
  if (isRecord(error) && typeof error['code'] === 'string') {
    const code = error['code'];
    if (STABLE_RUNTIME_CODES.has(code) || STABLE_DOMAIN_CODES.has(code))
      return code;
  }
  return 'FLOW_EXECUTION_FAILED';
}

function abortReason(signal: AbortSignal): string | null {
  if (!signal.aborted) return null;
  const reason: unknown = signal.reason;
  return typeof reason === 'string' ? reason : null;
}

function requiredString(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExecutionFailure(
      label === 'notification'
        ? 'FLOW_NOTIFICATION_INVALID'
        : 'FLOW_STEP_INVALID',
    );
  }
  return value;
}

function factSource(
  state: FlowExecutionState,
  flowVersion: string,
  bankVersion: string,
): Record<string, JsonValue> {
  return {
    jobId: state.sources.jobId,
    queuedMessageIds: [...state.sources.queuedMessageIds],
    steeringMessageIds: [...state.sources.steeringMessageIds],
    confirmationMessageIds: [...state.sources.confirmationMessageIds],
    subject: 'self',
    flowVersion,
    bankVersion,
  };
}

function sourceIsSelf(value: JsonValue): boolean {
  return isRecord(value) && value['subject'] === 'self';
}

function steeringAfter(
  state: FlowExecutionState,
  sequence: number,
): FlowExecutionState['inputs'] {
  return state.inputs.filter(
    (item) => item.source === 'steering' && item.sequence > sequence,
  );
}

function inputsAfter(
  state: FlowExecutionState,
  sequence: number | null,
): FlowExecutionState['inputs'] {
  if (sequence === null) return [];
  return steeringAfter(state, sequence);
}

function resolveChoice(
  text: string,
  options: readonly FlowChoiceOption[],
): FlowChoiceOption | null {
  const selection = choiceToken(text);
  if (selection === null) return null;
  const normalized = selection.toLowerCase();
  return (
    options.find(
      (option) =>
        option.id.toLowerCase() === normalized ||
        option.aliases.some((alias) => alias.toLowerCase() === normalized),
    ) ?? null
  );
}

function choiceToken(text: string): string | null {
  const clean = text
    .trim()
    .replace(/^\/steer\s+\S+\s+/i, '')
    .trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0] ?? null;
  if (
    parts.length === 2 &&
    ['選擇', '選', 'choose', 'select', 'flow'].includes(
      (parts[0] ?? '').toLowerCase(),
    )
  ) {
    return parts[1] ?? null;
  }
  return null;
}

function isUnsupportedChoice(text: string): boolean {
  const token = choiceToken(text);
  return token?.toLowerCase() === 'unsupported';
}

function isSelfConfirmation(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^\/steer\s+\S+\s+/i, '')
    .trim()
    .toLowerCase();
  return [
    '確認本人',
    '是本人',
    '本人確認',
    '是本人，確認',
    '是本人,確認',
    '確認本人並更正',
    'yes, i confirm this is me',
    'i confirm this is me',
  ].includes(normalized);
}

function isThirdPartyRequest(text: string): boolean {
  return /朋友|他人|別人|其他人|家人|同事|客戶|伴侶|孩子|兒子|女兒|替我朋友|幫朋友|for my friend|my friend|someone else|another person/i.test(
    text,
  );
}

function isGoalChange(text: string): boolean {
  return /改成|改做|不要(?:做|分析)?(?:mbti|星盤)|改為|instead|switch to|not (?:mbti|natal)/i.test(
    text,
  );
}

function renderGoalChangePrompt(flowName: string, jobId: string): string {
  return `目前 Job 已明確選擇${flowName}。我不會在此 Job 偷換目標或改變 Flow。若要其他目標，請另開新 Job；若要繼續，請回答目前問題。\n請回覆此 Telegram 訊息，或使用 /steer ${jobId} <內容>。`;
}

function questionIdsIn(text: string): number[] {
  const ids = new Set<number>();
  const expression = /(?:題目|問題|q)?\s*(1[0-2]|[1-9])\s*(?:[=:：]|題)/gi;
  for (const match of text.matchAll(expression)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value >= 1 && value <= 12)
      ids.add(value);
  }
  return [...ids].sort((left, right) => left - right);
}

function renderMbtiIdClarification(jobId: string): string {
  return `請指出要更正的題目 ID（1 至 12），並說明你本人的新答案。答案使用 -2、-1、0、1、2 或 null。\n請回覆此 Telegram 訊息，或使用 /steer ${jobId} <題目 ID 與答案>。`;
}

function claimsUnknownBirthTime(text: string): boolean {
  return /(?:出生)?時間\s*(?:是|為|[:：=])?\s*(?:未知|不明|不知道|不清楚|不詳)|(?:未知|不明|不知道|不清楚|不詳)\s*(?:出生)?時間|(?:birth\s+)?time\s+(?:is\s+)?unknown|unknown\s+(?:birth\s+)?time/i.test(
    text,
  );
}

function hasExplicitBirthTime(text: string): boolean {
  return /(?:time|出生時間|時間)\s*[=:：為]?\s*(?:[01]\d|2[0-3]):[0-5]\d|\b(?:[01]\d|2[0-3]):[0-5]\d\b/i.test(
    text,
  );
}

function withoutBirthTime(
  value: Partial<BirthChartInput>,
): Partial<BirthChartInput>;
function withoutBirthTime(value: null): null;
function withoutBirthTime(
  value: Partial<BirthChartInput> | null,
): Partial<BirthChartInput> | null;
function withoutBirthTime(
  value: Partial<BirthChartInput> | null,
): Partial<BirthChartInput> | null {
  if (value === null) return null;
  const remaining = { ...value };
  delete remaining.localTime;
  return remaining;
}

function missingBirthFields(value: Partial<BirthChartInput>): string[] {
  const fields = [
    'localDate',
    'localTime',
    'latitude',
    'longitude',
    'timeZone',
  ] as const;
  return fields.filter((field) => value[field] === undefined);
}

function mergeBirthCandidate(
  current: Partial<BirthChartInput> | null,
  incoming: Partial<BirthChartInput>,
): Partial<BirthChartInput> {
  const base = current ?? {};
  const changedWallTime =
    (incoming.localDate !== undefined &&
      incoming.localDate !== base.localDate) ||
    (incoming.localTime !== undefined &&
      incoming.localTime !== base.localTime) ||
    (incoming.timeZone !== undefined && incoming.timeZone !== base.timeZone);
  const merged: Partial<BirthChartInput> = { ...base, ...incoming };
  if (changedWallTime && incoming.utcOffsetMinutes === undefined) {
    const clean = { ...merged };
    delete clean.utcOffsetMinutes;
    return clean;
  }
  return merged;
}

function fullBirthInput(
  candidate: Partial<BirthChartInput> | null,
  confirmed: Partial<BirthChartInput> | null,
): BirthChartInput | null {
  const merged = mergeBirthCandidate(confirmed, candidate ?? {});
  if (
    merged.localDate === undefined ||
    merged.localTime === undefined ||
    merged.latitude === undefined ||
    merged.longitude === undefined ||
    merged.timeZone === undefined
  ) {
    return null;
  }
  return {
    localDate: merged.localDate,
    localTime: merged.localTime,
    latitude: merged.latitude,
    longitude: merged.longitude,
    timeZone: merged.timeZone,
    ...(merged.utcOffsetMinutes === undefined
      ? {}
      : { utcOffsetMinutes: merged.utcOffsetMinutes }),
  };
}

function sameBirthInput(
  left: BirthChartInput,
  right: BirthChartInput,
): boolean {
  return (
    left.localDate === right.localDate &&
    left.localTime === right.localTime &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.timeZone === right.timeZone &&
    left.utcOffsetMinutes === right.utcOffsetMinutes
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function sourceConfirmationIds(value: JsonValue | null): string[] {
  if (!isRecord(value) || !Array.isArray(value['confirmationMessageIds'])) {
    return [];
  }
  return value['confirmationMessageIds'].filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
