import {
  FLOW_CONTRACT_IDS,
  PI_THINKING_LEVELS,
  type FlowBundle,
  type FlowDefinition,
  type FlowLimitOverrides,
  type FlowLimits,
  type FlowRuntime,
  type NodeDefinition,
} from './types.js';

export const FLOW_TOOL_NAMES = ['calculate_natal_chart'] as const;
export const FLOW_SERVER_HANDLER_NAMES = [
  'choice',
  'unsupported',
  'mbti_collect',
  'mbti_score',
  'mbti_done',
  'natal_input',
  'natal_calculate',
  'natal_done',
] as const;

export const FLOW_LIMIT_BOUNDS = {
  nodeTimeoutMs: { min: 1, max: 300_000 },
  waitTimeoutMs: { min: 1, max: 604_800_000 },
  jobTimeoutMs: { min: 1, max: 604_800_000 },
  maxTransitions: { min: 1, max: 1_000 },
  maxRetries: { min: 0, max: 10 },
  maxModelTurns: { min: 1, max: 100 },
  maxToolCalls: { min: 0, max: 100 },
  maxOutputChars: { min: 1, max: 100_000 },
} as const;

const FLOW_KEYS = [
  'id',
  'version',
  'name',
  'resultDescription',
  'aliases',
  'runtime',
  'limits',
  'entryNode',
  'nodes',
] as const;
const NODE_KEYS = [
  'id',
  'kind',
  'handler',
  'systemPrompt',
  'prompt',
  'expectedResult',
  'resultContract',
  'next',
  'tools',
  'runtime',
  'limits',
] as const;
const RUNTIME_KEYS = [
  'provider',
  'model',
  'thinking',
  'apiKeyEnv',
  'auth',
] as const;
const LIMIT_KEYS = Object.keys(FLOW_LIMIT_BOUNDS);

export class FlowDefinitionError extends TypeError {
  readonly code = 'INVALID_FLOW_DEFINITION';

  constructor(message: string) {
    super(message);
    this.name = 'FlowDefinitionError';
  }
}

export interface FlowRegistryOptions {
  readonly registeredValidatorNames?: Iterable<string>;
  readonly registeredToolNames?: Iterable<string>;
  readonly registeredServerHandlerNames?: Iterable<string>;
}

/**
 * An immutable registry of trusted declarative data. It never imports or evaluates
 * code from a flow definition or configuration file.
 */
export class FlowRegistry {
  readonly bundle: FlowBundle;
  private readonly flows: ReadonlyMap<string, FlowDefinition>;
  private readonly aliases: ReadonlyMap<string, string>;

  constructor(bundle: unknown, options: FlowRegistryOptions = {}) {
    const registeredValidatorNames = new Set(
      options.registeredValidatorNames ?? FLOW_CONTRACT_IDS,
    );
    const registeredToolNames = new Set(
      options.registeredToolNames ?? FLOW_TOOL_NAMES,
    );
    const registeredServerHandlerNames = new Set(
      options.registeredServerHandlerNames ?? FLOW_SERVER_HANDLER_NAMES,
    );
    this.bundle = validateFlowBundle(bundle, {
      registeredValidatorNames,
      registeredToolNames,
      registeredServerHandlerNames,
    });
    this.flows = new Map(this.bundle.flows.map((flow) => [flow.id, flow]));
    this.aliases = new Map(
      this.bundle.flows.flatMap((flow) =>
        flow.aliases.map((alias) => [alias, flow.id] as const),
      ),
    );
  }

  get(idOrAlias: string): FlowDefinition | undefined {
    const id = this.flows.has(idOrAlias)
      ? idOrAlias
      : this.aliases.get(idOrAlias);
    return id === undefined ? undefined : this.flows.get(id);
  }

  getNode(flowId: string, nodeId: string): NodeDefinition | undefined {
    return this.flows.get(flowId)?.nodes.find((node) => node.id === nodeId);
  }

  getTarget(
    flowId: string,
    nodeId: string,
    transition: string,
  ): {
    readonly flowId: string;
    readonly nodeId: string;
  } {
    const node = this.getNode(flowId, nodeId);
    const target = node?.next[transition];
    if (node === undefined || target === undefined) {
      throw new FlowDefinitionError(
        'Transition is not declared by the current node.',
      );
    }
    return parseNodeReference(flowId, target);
  }

  /** The returned content is deeply frozen and safe to pin to one Job. */
  snapshot(): FlowBundle {
    return this.bundle;
  }

  list(): readonly FlowDefinition[] {
    return this.bundle.flows;
  }
}

export function validateFlowBundle(
  value: unknown,
  options: {
    readonly registeredValidatorNames: ReadonlySet<string>;
    readonly registeredToolNames: ReadonlySet<string>;
    readonly registeredServerHandlerNames: ReadonlySet<string>;
  } = {
    registeredValidatorNames: new Set(FLOW_CONTRACT_IDS),
    registeredToolNames: new Set(FLOW_TOOL_NAMES),
    registeredServerHandlerNames: new Set(FLOW_SERVER_HANDLER_NAMES),
  },
): FlowBundle {
  assertRecord(value, 'Flow bundle');
  assertOnlyKeys(value, ['schemaVersion', 'flows'], 'Flow bundle');
  if (value['schemaVersion'] !== 1)
    invalid('Unsupported flow bundle schema version.');
  if (
    !Array.isArray(value['flows']) ||
    value['flows'].length < 1 ||
    value['flows'].length > 32
  ) {
    invalid('A flow bundle must contain 1 to 32 definitions.');
  }

  const flows = value['flows'].map((flow, index) =>
    validateFlow(flow, `flows[${String(index)}]`, options),
  );
  const flowIds = new Set<string>();
  const requiredFlowIds = new Set(['intake']);
  const aliases = new Map<string, string>();
  for (const flow of flows) {
    if (flowIds.has(flow.id)) invalid('Flow IDs must be unique.');
    flowIds.add(flow.id);
    requiredFlowIds.delete(flow.id);
    for (const alias of flow.aliases) {
      if (flowIds.has(alias) || aliases.has(alias)) {
        invalid('Flow aliases and IDs must not collide.');
      }
      aliases.set(alias, flow.id);
    }
  }
  if (requiredFlowIds.size > 0) {
    invalid('A flow bundle must define intake.');
  }
  for (const id of flowIds) {
    if (aliases.has(id)) invalid('Flow aliases and IDs must not collide.');
  }

  const byAddress = new Map<string, NodeDefinition>();
  const flowById = new Map(flows.map((flow) => [flow.id, flow]));
  for (const flow of flows) {
    for (const node of flow.nodes) {
      byAddress.set(address(flow.id, node.id), node);
    }
  }
  for (const flow of flows) {
    if (!byAddress.has(address(flow.id, flow.entryNode))) {
      invalid(`Flow ${flow.id} has an unknown entry node.`);
    }
    for (const node of flow.nodes) {
      for (const [transition, reference] of Object.entries(node.next)) {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(transition)) {
          invalid(`Node ${flow.id}/${node.id} has an invalid transition name.`);
        }
        const target = parseNodeReference(flow.id, reference);
        if (
          !flowById.has(target.flowId) ||
          !byAddress.has(address(target.flowId, target.nodeId))
        ) {
          invalid(
            `Node ${flow.id}/${node.id} references an unknown target node.`,
          );
        }
      }
    }
  }

  const allReachable = new Set<string>();
  for (const flow of flows) {
    const root = address(flow.id, flow.entryNode);
    const reachable = reachableFrom(root, byAddress, flowById);
    if (
      ![...reachable].some(
        (nodeAddress) =>
          byAddress.get(nodeAddress)?.next !== undefined &&
          Object.keys(byAddress.get(nodeAddress)?.next ?? {}).length === 0,
      )
    ) {
      invalid(`Flow ${flow.id} cannot reach a terminal node.`);
    }
    for (const nodeAddress of reachable) allReachable.add(nodeAddress);
  }
  if (allReachable.size !== byAddress.size) {
    invalid('Flow bundle contains unreachable nodes.');
  }

  const normalized: FlowBundle = {
    schemaVersion: 1,
    flows,
  };
  return deepFreeze(normalized);
}

export function effectiveNodeLimits(
  flow: FlowDefinition,
  node: NodeDefinition,
): FlowLimits {
  return { ...flow.limits, ...(node.limits ?? {}) };
}

export function effectiveNodeRuntime(
  flow: FlowDefinition,
  node: NodeDefinition,
): FlowRuntime {
  return node.runtime ?? flow.runtime;
}

function validateFlow(
  value: unknown,
  label: string,
  options: {
    readonly registeredValidatorNames: ReadonlySet<string>;
    readonly registeredToolNames: ReadonlySet<string>;
    readonly registeredServerHandlerNames: ReadonlySet<string>;
  },
): FlowDefinition {
  assertRecord(value, label);
  assertOnlyKeys(value, FLOW_KEYS, label);
  const id = requiredString(value['id'], `${label}.id`, 64);
  const version = requiredString(value['version'], `${label}.version`, 64);
  const name = requiredString(value['name'], `${label}.name`, 120);
  const resultDescription = requiredString(
    value['resultDescription'],
    `${label}.resultDescription`,
    2_000,
  );
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) invalid(`${label}.id is invalid.`);
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
    invalid(`${label}.version must be a fixed semantic version.`);
  }
  if (!Array.isArray(value['aliases']))
    invalid(`${label}.aliases must be an array.`);
  const aliases = value['aliases'].map((alias, index) =>
    requiredString(alias, `${label}.aliases[${String(index)}]`, 64),
  );
  if (new Set(aliases).size !== aliases.length)
    invalid(`${label} has duplicate aliases.`);
  for (const alias of aliases) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(alias))
      invalid(`${label} has an invalid alias.`);
  }
  const runtime = validateRuntime(value['runtime'], `${label}.runtime`);
  const limits = validateLimits(value['limits'], `${label}.limits`, false);
  const entryNode = requiredString(
    value['entryNode'],
    `${label}.entryNode`,
    64,
  );
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entryNode))
    invalid(`${label}.entryNode is invalid.`);
  if (
    !Array.isArray(value['nodes']) ||
    value['nodes'].length < 1 ||
    value['nodes'].length > 128
  ) {
    invalid(`${label}.nodes must contain 1 to 128 nodes.`);
  }
  const nodes = value['nodes'].map((node, index) =>
    validateNode(node, `${label}.nodes[${String(index)}]`, options),
  );
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) invalid(`${label} has duplicate node IDs.`);
    nodeIds.add(node.id);
    validateLimits(
      { ...limits, ...(node.limits ?? {}) },
      `${label}/${node.id}.limits`,
      false,
    );
  }
  return {
    id,
    version,
    name,
    resultDescription,
    aliases,
    runtime,
    limits,
    entryNode,
    nodes,
  };
}

function validateNode(
  value: unknown,
  label: string,
  options: {
    readonly registeredValidatorNames: ReadonlySet<string>;
    readonly registeredToolNames: ReadonlySet<string>;
    readonly registeredServerHandlerNames: ReadonlySet<string>;
  },
): NodeDefinition {
  assertRecord(value, label);
  assertOnlyKeys(value, NODE_KEYS, label);
  const id = requiredString(value['id'], `${label}.id`, 64);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) invalid(`${label}.id is invalid.`);
  const kind = value['kind'];
  if (kind !== 'agent' && kind !== 'server')
    invalid(`${label}.kind is invalid.`);
  const handlerValue = value['handler'];
  let handler: string | undefined;
  if (kind === 'server') {
    handler = requiredString(handlerValue, `${label}.handler`, 64);
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(handler) ||
      !options.registeredServerHandlerNames.has(handler)
    ) {
      invalid(`${label}.handler names an unregistered server handler.`);
    }
  } else if (handlerValue !== undefined) {
    invalid(`${label} agent nodes cannot declare a server handler.`);
  }
  const systemPrompt = requiredString(
    value['systemPrompt'],
    `${label}.systemPrompt`,
    16_000,
  );
  const prompt = requiredString(value['prompt'], `${label}.prompt`, 16_000);
  const expectedResult = requiredString(
    value['expectedResult'],
    `${label}.expectedResult`,
    10_000,
  );
  const resultContract = value['resultContract'];
  if (resultContract !== null && typeof resultContract !== 'string') {
    invalid(
      `${label}.resultContract must be a registered validator name or null.`,
    );
  }
  if (
    resultContract !== null &&
    !options.registeredValidatorNames.has(resultContract)
  ) {
    invalid(`${label}.resultContract names an unregistered validator.`);
  }
  if (kind === 'agent' && resultContract === null) {
    invalid(`${label} agent nodes require an explicit result contract.`);
  }
  const nextValue = value['next'];
  assertRecord(nextValue, `${label}.next`);
  const next: Record<string, string> = {};
  for (const [transition, target] of Object.entries(nextValue)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(transition)) {
      invalid(`${label}.next has an invalid transition name.`);
    }
    next[transition] = requiredString(
      target,
      `${label}.next.${transition}`,
      129,
    );
  }
  const toolsValue = value['tools'];
  let tools: string[] = [];
  if (toolsValue !== undefined) {
    if (!Array.isArray(toolsValue)) invalid(`${label}.tools must be an array.`);
    tools = toolsValue.map((tool, index) =>
      requiredString(tool, `${label}.tools[${String(index)}]`, 128),
    );
  }
  if (new Set(tools).size !== tools.length)
    invalid(`${label} has duplicate tool names.`);
  for (const tool of tools) {
    if (!options.registeredToolNames.has(tool))
      invalid(`${label} names an unregistered tool.`);
  }

  let runtime: FlowRuntime | undefined;
  if (value['runtime'] !== undefined) {
    if (kind !== 'agent')
      invalid(`${label} server control nodes cannot override a model runtime.`);
    runtime = validateRuntime(value['runtime'], `${label}.runtime`);
  }
  let limits: FlowLimitOverrides | undefined;
  if (value['limits'] !== undefined) {
    limits = validateLimits(value['limits'], `${label}.limits`, true);
  }
  return {
    id,
    kind,
    ...(handler === undefined ? {} : { handler }),
    systemPrompt,
    prompt,
    expectedResult,
    resultContract,
    next,
    tools,
    ...(runtime === undefined ? {} : { runtime }),
    ...(limits === undefined ? {} : { limits }),
  };
}

function validateRuntime(value: unknown, label: string): FlowRuntime {
  assertRecord(value, label);
  assertOnlyKeys(value, RUNTIME_KEYS, label);
  const provider = requiredString(value['provider'], `${label}.provider`, 80);
  const model = requiredString(value['model'], `${label}.model`, 200);
  const thinking = value['thinking'];
  if (!isPiThinkingLevel(thinking)) {
    invalid(`${label}.thinking is not a supported Pi thinking level.`);
  }
  const apiKeyEnv = value['apiKeyEnv'];
  if (
    apiKeyEnv !== null &&
    (typeof apiKeyEnv !== 'string' ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(apiKeyEnv))
  ) {
    invalid(`${label}.apiKeyEnv must be an environment variable name or null.`);
  }
  let auth: FlowRuntime['auth'];
  if (value['auth'] !== undefined) {
    assertRecord(value['auth'], `${label}.auth`);
    assertOnlyKeys(value['auth'], ['mode'], `${label}.auth`);
    const mode = value['auth']['mode'];
    if (mode === 'pi-login') {
      if (apiKeyEnv !== null) {
        invalid(`${label}.pi-login requires apiKeyEnv to be null.`);
      }
      auth = { mode };
    } else if (mode === 'api-key') {
      if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) {
        invalid(`${label}.api-key requires a non-empty apiKeyEnv.`);
      }
      auth = { mode };
    } else {
      invalid(`${label}.auth.mode is invalid.`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider))
    invalid(`${label}.provider is invalid.`);
  return {
    provider,
    model,
    thinking,
    apiKeyEnv,
    ...(auth === undefined ? {} : { auth }),
  };
}

function isPiThinkingLevel(value: unknown): value is FlowRuntime['thinking'] {
  return PI_THINKING_LEVELS.some((level) => level === value);
}

function validateLimits(
  value: unknown,
  label: string,
  partial: false,
): FlowLimits;
function validateLimits(
  value: unknown,
  label: string,
  partial: true,
): FlowLimitOverrides;
function validateLimits(
  value: unknown,
  label: string,
  partial: boolean,
): FlowLimits | FlowLimitOverrides {
  assertRecord(value, label);
  assertOnlyKeys(value, LIMIT_KEYS, label);
  const result: Partial<{
    -readonly [Key in keyof FlowLimits]: FlowLimits[Key];
  }> = {};
  for (const [key, bound] of Object.entries(FLOW_LIMIT_BOUNDS)) {
    const field = value[key];
    if (field === undefined) {
      if (!partial) invalid(`${label}.${key} is required.`);
      continue;
    }
    if (
      typeof field !== 'number' ||
      !Number.isSafeInteger(field) ||
      field < bound.min ||
      field > bound.max
    ) {
      invalid(`${label}.${key} is outside its safe bounded integer range.`);
    }
    result[key as keyof FlowLimits] = field;
  }
  return result;
}

function reachableFrom(
  root: string,
  nodes: ReadonlyMap<string, NodeDefinition>,
  flows: ReadonlyMap<string, FlowDefinition>,
): ReadonlySet<string> {
  const reached = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reached.has(current)) continue;
    const node = nodes.get(current);
    if (node === undefined) continue;
    reached.add(current);
    const flowId = current.slice(0, current.indexOf('/'));
    for (const reference of Object.values(node.next)) {
      const target = parseNodeReference(flowId, reference);
      if (flows.has(target.flowId))
        pending.push(address(target.flowId, target.nodeId));
    }
  }
  return reached;
}

function parseNodeReference(
  currentFlowId: string,
  reference: string,
): { readonly flowId: string; readonly nodeId: string } {
  if (typeof reference !== 'string' || reference.length === 0) {
    invalid('Node references must be non-empty strings.');
  }
  const parts = reference.split('/');
  if (parts.length === 1) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(reference))
      invalid('Node reference is invalid.');
    return { flowId: currentFlowId, nodeId: reference };
  }
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(parts[0]) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(parts[1])
  ) {
    invalid('Cross-flow node reference is invalid.');
  }
  return { flowId: parts[0], nodeId: parts[1] };
}

function address(flowId: string, nodeId: string): string {
  return `${flowId}/${nodeId}`;
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${label} must be a plain JSON object.`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) invalid(`${label} contains an unknown field.`);
  }
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    invalid(`${label} must be a non-empty string within its length limit.`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function invalid(message: string): never {
  throw new FlowDefinitionError(message);
}
