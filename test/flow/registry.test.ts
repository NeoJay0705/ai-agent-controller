import { describe, expect, it } from 'vitest';

import { parseFlowBundleConfig } from '../../src/flow/config.js';
import { createFlowBundle } from '../../src/flow/definitions.js';
import {
  FlowDefinitionError,
  FlowRegistry,
  effectiveNodeLimits,
} from '../../src/flow/registry.js';
import { validateAgentNodeResult } from '../../src/flow/types.js';
import type {
  FlowBundle,
  FlowLimits,
  FlowRuntime,
} from '../../src/flow/types.js';

const limits: FlowLimits = {
  nodeTimeoutMs: 30_000,
  waitTimeoutMs: 3_600_000,
  jobTimeoutMs: 86_400_000,
  maxTransitions: 100,
  maxRetries: 0,
  maxModelTurns: 20,
  maxToolCalls: 0,
  maxOutputChars: 20_000,
};

const runtime: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: 'OPENAI_API_KEY',
};

function bundle(): FlowBundle {
  return createFlowBundle({
    runtimes: { intake: runtime, mbti: runtime, natal: runtime },
    limits: { intake: limits, mbti: limits, natal: limits },
  });
}

function mutableBundle(): Record<string, unknown> {
  return structuredClone(bundle()) as unknown as Record<string, unknown>;
}

function flowRows(value: Record<string, unknown>): Record<string, unknown>[] {
  return value['flows'] as Record<string, unknown>[];
}

function nodeRows(flow: Record<string, unknown>): Record<string, unknown>[] {
  return flow['nodes'] as Record<string, unknown>[];
}

describe('FlowRegistry', () => {
  it('accepts the three explicit templates and freezes the Job snapshot', () => {
    const registry = new FlowRegistry(bundle());

    expect(registry.list().map((flow) => flow.id)).toEqual([
      'intake',
      'mbti',
      'natal',
    ]);
    expect(registry.get('personality')?.id).toBe('mbti');
    expect(registry.get('birth-chart')?.id).toBe('natal');
    expect(registry.snapshot()).toBe(registry.bundle);
    expect(Object.isFrozen(registry.snapshot())).toBe(true);
    expect(Object.isFrozen(registry.getNode('natal', 'calculate')?.tools)).toBe(
      true,
    );
    expect(registry.getNode('natal', 'calculate')?.tools).toEqual([
      'calculate_natal_chart',
    ]);
    expect(registry.getNode('natal', 'analyze')?.tools).toEqual([]);
    expect(registry.getNode('mbti', 'collect')?.kind).toBe('server');
    expect(registry.getNode('mbti', 'collect')?.handler).toBe('mbti_collect');
    expect(registry.getNode('mbti', 'collect')?.runtime).toBeUndefined();
    expect(registry.getNode('natal', 'input')?.next).toEqual({
      parse: 'parse_birth',
      ready: 'calculate',
      more: 'input',
    });
    expect(registry.getNode('natal', 'parse_birth')?.next).toEqual({
      parsed: 'input',
    });
    expect(registry.getNode('mbti', 'analyze')?.next).toHaveProperty(
      'revise',
      'collect',
    );
    expect(registry.getNode('natal', 'analyze')?.next).toHaveProperty(
      'revise',
      'input',
    );
  });

  it('round-trips explicit Pi login and API-key auth on Flow and Node runtimes', () => {
    const value = mutableBundle();
    const flows = flowRows(value);
    const intake = flows.find((flow) => flow['id'] === 'intake');
    const mbti = flows.find((flow) => flow['id'] === 'mbti');
    if (intake === undefined || mbti === undefined) {
      throw new Error('Test flows are missing.');
    }
    intake['runtime'] = {
      ...runtime,
      apiKeyEnv: null,
      auth: { mode: 'pi-login' },
    };
    const parser = nodeRows(mbti).find(
      (node) => node['id'] === 'parse_answers',
    );
    if (parser === undefined) throw new Error('Test node is missing.');
    parser['runtime'] = {
      ...runtime,
      apiKeyEnv: 'FLOW_TEST_API_KEY',
      auth: { mode: 'api-key' },
    };

    const registry = new FlowRegistry(value);
    expect(registry.get('intake')?.runtime).toEqual({
      ...runtime,
      apiKeyEnv: null,
      auth: { mode: 'pi-login' },
    });
    expect(registry.getNode('mbti', 'parse_answers')?.runtime).toEqual({
      ...runtime,
      apiKeyEnv: 'FLOW_TEST_API_KEY',
      auth: { mode: 'api-key' },
    });
    expect(parseFlowBundleConfig(JSON.stringify(registry.snapshot()))).toEqual(
      registry.snapshot(),
    );
  });

  it('rejects mixed, incomplete, or extended auth mode objects', () => {
    const mixedLogin = mutableBundle();
    const intake = flowRows(mixedLogin).find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test flow is missing.');
    intake['runtime'] = {
      ...runtime,
      apiKeyEnv: 'FLOW_TEST_API_KEY',
      auth: { mode: 'pi-login' },
    };
    expect(() => new FlowRegistry(mixedLogin)).toThrow(
      /pi-login requires apiKeyEnv to be null/,
    );

    const missingApiKeyEnv = mutableBundle();
    const missingFlow = flowRows(missingApiKeyEnv).find(
      (flow) => flow['id'] === 'intake',
    );
    if (missingFlow === undefined) throw new Error('Test flow is missing.');
    missingFlow['runtime'] = {
      ...runtime,
      apiKeyEnv: null,
      auth: { mode: 'api-key' },
    };
    expect(() => new FlowRegistry(missingApiKeyEnv)).toThrow(
      /api-key requires a non-empty apiKeyEnv/,
    );

    const extraAuthField = mutableBundle();
    const extraFlow = flowRows(extraAuthField).find(
      (flow) => flow['id'] === 'intake',
    );
    if (extraFlow === undefined) throw new Error('Test flow is missing.');
    extraFlow['runtime'] = {
      ...runtime,
      apiKeyEnv: null,
      auth: { mode: 'pi-login', extra: true },
    };
    expect(() => new FlowRegistry(extraAuthField)).toThrow(/unknown field/);
  });

  it('keeps legacy null apiKeyEnv as API-key-only configuration', () => {
    const value = mutableBundle();
    const intake = flowRows(value).find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test flow is missing.');
    intake['runtime'] = { ...runtime, apiKeyEnv: null };
    expect(new FlowRegistry(value).get('intake')?.runtime).toEqual({
      ...runtime,
      apiKeyEnv: null,
    });
  });

  it('applies only explicit Node limits over the required Flow limits', () => {
    const registry = new FlowRegistry(bundle());
    const flow = registry.get('mbti');
    const score = registry.getNode('mbti', 'score');
    expect(flow).toBeDefined();
    expect(score).toBeDefined();
    if (flow === undefined || score === undefined)
      throw new Error('Test flow is missing.');
    expect(effectiveNodeLimits(flow, score)).toEqual(limits);
  });

  it('validates strict Agent output shape, contract, transition, and size', () => {
    const registry = new FlowRegistry(bundle());
    const node = registry.getNode('intake', 'recommend');
    if (node === undefined) throw new Error('Test node is missing.');

    expect(
      validateAgentNodeResult(
        { transition: 'ready', result: { suggestedFlow: 'mbti' } },
        node,
        100,
      ),
    ).toEqual({
      transition: 'ready',
      result: { suggestedFlow: 'mbti' },
    });
    expect(() =>
      validateAgentNodeResult(
        { transition: 'not-declared', result: { suggestedFlow: null } },
        node,
        100,
      ),
    ).toThrow(/undeclared transition/);
    expect(() =>
      validateAgentNodeResult(
        {
          transition: 'ready',
          result: { suggestedFlow: null, rationale: 'hidden' },
        },
        node,
        100,
      ),
    ).toThrow(/unknown field/);
    expect(
      validateAgentNodeResult(
        { transition: 'ready', result: { suggestedFlow: 'custom_flow-1' } },
        node,
        100,
      ),
    ).toEqual({
      transition: 'ready',
      result: { suggestedFlow: 'custom_flow-1' },
    });
    expect(
      validateAgentNodeResult(
        { transition: 'ready', result: { suggestedFlow: null } },
        node,
        100,
      ),
    ).toEqual({ transition: 'ready', result: { suggestedFlow: null } });
    for (const suggestedFlow of ['Invalid ID', 'Uppercase', 'x'.repeat(65)]) {
      expect(() =>
        validateAgentNodeResult(
          { transition: 'ready', result: { suggestedFlow } },
          node,
          100,
        ),
      ).toThrow(/invalid flow ID/);
    }
    expect(() =>
      validateAgentNodeResult(
        {
          transition: 'ready',
          result: { suggestedFlow: null },
          text: 'x'.repeat(20),
        },
        node,
        30,
      ),
    ).toThrow(/output limit/);
  });

  it('rejects an unregistered tool name', () => {
    expect(
      () => new FlowRegistry(bundle(), { registeredToolNames: [] }),
    ).toThrow(FlowDefinitionError);
  });

  it('accepts one to thirty-two Flows and requires only intake', () => {
    const one = mutableBundle();
    const flows = flowRows(one);
    const intake = flows.find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Intake flow is missing.');
    flows.splice(1);
    const choose = nodeRows(intake).find((node) => node['id'] === 'choose');
    if (choose === undefined) throw new Error('Choice node is missing.');
    choose['next'] = { unsupported: 'unsupported' };
    expect(new FlowRegistry(one).list()).toHaveLength(1);

    const many = mutableBundle();
    const manyFlows = flowRows(many);
    manyFlows.splice(1);
    const manyIntake = manyFlows[0];
    if (manyIntake === undefined) throw new Error('Intake flow is missing.');
    const manyChoice = nodeRows(manyIntake).find(
      (node) => node['id'] === 'choose',
    );
    if (manyChoice === undefined) throw new Error('Choice node is missing.');
    manyChoice['next'] = { unsupported: 'unsupported' };
    const template = structuredClone(
      nodeRows(manyIntake).find((node) => node['id'] === 'unsupported'),
    );
    if (template === undefined) throw new Error('Terminal node is missing.');
    for (let index = 1; index < 32; index += 1) {
      manyFlows.push({
        id: `extra-${String(index)}`,
        version: '1.0.0',
        name: `Extra ${String(index)}`,
        resultDescription: 'Registered terminal capability.',
        aliases: [],
        runtime,
        limits,
        entryNode: 'terminal',
        nodes: [{ ...template, id: 'terminal' }],
      });
    }
    expect(new FlowRegistry(many).list()).toHaveLength(32);
    manyFlows.push({
      id: 'extra-32',
      version: '1.0.0',
      name: 'Extra 32',
      resultDescription: 'Registered terminal capability.',
      aliases: [],
      runtime,
      limits,
      entryNode: 'terminal',
      nodes: [{ ...template, id: 'terminal' }],
    });
    expect(() => new FlowRegistry(many)).toThrow(/1 to 32 definitions/);
  });

  it('rejects missing and unregistered server handlers and agent handlers', () => {
    const missing = mutableBundle();
    const intake = flowRows(missing).find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test flow is missing.');
    const choose = nodeRows(intake).find((node) => node['id'] === 'choose');
    if (choose === undefined) throw new Error('Test node is missing.');
    delete choose['handler'];
    expect(() => new FlowRegistry(missing)).toThrow(/handler/);

    const unregistered = mutableBundle();
    const natal = flowRows(unregistered).find((flow) => flow['id'] === 'natal');
    if (natal === undefined) throw new Error('Test flow is missing.');
    const calculate = nodeRows(natal).find(
      (node) => node['id'] === 'calculate',
    );
    if (calculate === undefined) throw new Error('Test node is missing.');
    calculate['handler'] = 'choose';
    expect(() => new FlowRegistry(unregistered)).toThrow(
      /unregistered server handler/,
    );
    expect(
      () => new FlowRegistry(bundle(), { registeredServerHandlerNames: [] }),
    ).toThrow(/unregistered server handler/);

    const agent = mutableBundle();
    const mbti = flowRows(agent).find((flow) => flow['id'] === 'mbti');
    if (mbti === undefined) throw new Error('Test flow is missing.');
    const analyze = nodeRows(mbti).find((node) => node['id'] === 'analyze');
    if (analyze === undefined) throw new Error('Test node is missing.');
    analyze['handler'] = 'mbti_score';
    expect(() => new FlowRegistry(agent)).toThrow(/agent nodes cannot declare/);
  });

  it('rejects an unregistered validator name', () => {
    const value = mutableBundle();
    const mbti = flowRows(value).find((flow) => flow['id'] === 'mbti');
    if (mbti === undefined) throw new Error('Test flow is missing.');
    const parser = nodeRows(mbti).find(
      (node) => node['id'] === 'parse_answers',
    );
    if (parser === undefined) throw new Error('Test node is missing.');
    parser['resultContract'] = 'unregistered_contract';

    expect(() => new FlowRegistry(value)).toThrow(/unregistered validator/);
  });

  it('rejects unknown nodes and transitions', () => {
    const value = mutableBundle();
    const intake = flowRows(value).find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test flow is missing.');
    const choose = nodeRows(intake).find((node) => node['id'] === 'choose');
    if (choose === undefined) throw new Error('Test node is missing.');
    choose['next'] = { mbti: 'mbti/not-a-node' };

    expect(() => new FlowRegistry(value)).toThrow(/unknown target node/);
  });

  it('rejects duplicate flow and Node IDs', () => {
    const duplicateFlow = mutableBundle();
    const flows = flowRows(duplicateFlow);
    const secondFlow = flows[1];
    if (secondFlow === undefined) throw new Error('Test Flow is missing.');
    flows[2] = structuredClone(secondFlow);
    expect(() => new FlowRegistry(duplicateFlow)).toThrow(
      /Flow IDs must be unique/,
    );

    const duplicateNode = mutableBundle();
    const mbti = flowRows(duplicateNode).find((flow) => flow['id'] === 'mbti');
    if (mbti === undefined) throw new Error('Test flow is missing.');
    const nodes = nodeRows(mbti);
    const firstNode = nodes[0];
    if (firstNode === undefined) throw new Error('Test node is missing.');
    nodes[1] = { ...firstNode };
    expect(() => new FlowRegistry(duplicateNode)).toThrow(/duplicate node IDs/);
  });

  it('rejects graphs without a reachable terminal node', () => {
    const value = mutableBundle();
    const natal = flowRows(value).find((flow) => flow['id'] === 'natal');
    if (natal === undefined) throw new Error('Test flow is missing.');
    const done = nodeRows(natal).find((node) => node['id'] === 'done');
    if (done === undefined) throw new Error('Test node is missing.');
    done['next'] = { loop: 'done' };

    expect(() => new FlowRegistry(value)).toThrow(/cannot reach a terminal/);
  });

  it('rejects missing, unbounded, or non-safe Flow limits', () => {
    const missing = mutableBundle();
    const intake = flowRows(missing).find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test flow is missing.');
    delete (intake['limits'] as Record<string, unknown>)['maxTransitions'];
    expect(() => new FlowRegistry(missing)).toThrow(
      /maxTransitions is required/,
    );

    const unbounded = mutableBundle();
    const mbti = flowRows(unbounded).find((flow) => flow['id'] === 'mbti');
    if (mbti === undefined) throw new Error('Test flow is missing.');
    (mbti['limits'] as Record<string, unknown>)['maxTransitions'] =
      Number.MAX_SAFE_INTEGER + 1;
    expect(() => new FlowRegistry(unbounded)).toThrow(/safe bounded integer/);
  });

  it('rejects a server node that declares a model override', () => {
    const value = mutableBundle();
    const mbti = flowRows(value).find((flow) => flow['id'] === 'mbti');
    if (mbti === undefined) throw new Error('Test flow is missing.');
    const collect = nodeRows(mbti).find((node) => node['id'] === 'collect');
    if (collect === undefined) throw new Error('Test node is missing.');
    collect['runtime'] = runtime;

    expect(() => new FlowRegistry(value)).toThrow(
      /cannot override a model runtime/,
    );
  });

  it('normalizes omitted tools to an empty allowlist', () => {
    const value = mutableBundle();
    const mbti = flowRows(value).find((flow) => flow['id'] === 'mbti');
    if (mbti === undefined) throw new Error('Test flow is missing.');
    const collect = nodeRows(mbti).find((node) => node['id'] === 'collect');
    if (collect === undefined) throw new Error('Test node is missing.');
    delete collect['tools'];

    expect(new FlowRegistry(value).getNode('mbti', 'collect')?.tools).toEqual(
      [],
    );
  });
});

describe('parseFlowBundleConfig', () => {
  it('accepts bounded JSON and rejects unknown fields', () => {
    const source = bundle();
    expect(parseFlowBundleConfig(JSON.stringify(source)).flows).toHaveLength(3);

    const invalid = mutableBundle();
    const firstFlow = flowRows(invalid)[0];
    if (firstFlow === undefined) throw new Error('Test Flow is missing.');
    firstFlow['extra'] = true;
    expect(() => parseFlowBundleConfig(JSON.stringify(invalid))).toThrow(
      /unknown field/,
    );
  });

  it('rejects credential-like literals, secret fields, and shell tags', () => {
    const secret = mutableBundle();
    const intake = flowRows(secret).find((flow) => flow['id'] === 'intake');
    if (intake === undefined) throw new Error('Test flow is missing.');
    intake['apiKey'] = 'test';
    expect(() => parseFlowBundleConfig(JSON.stringify(secret))).toThrow(
      /secret field/,
    );

    const literal = JSON.stringify(bundle()).replace(
      'gpt-6-luna',
      'gpt-6-luna sk-abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(() => parseFlowBundleConfig(literal)).toThrow(/credential-like/);
    expect(() => parseFlowBundleConfig('{"!shell": "echo unsafe"}')).toThrow(
      /Shell-tagged/,
    );
  });

  it('bounds configuration nesting and total value nodes without exposing values', () => {
    const deep = `${'['.repeat(34)}null${']'.repeat(34)}`;
    expect(() => parseFlowBundleConfig(deep)).toThrow(/nested too deeply/);

    const manyValues = {
      ...bundle(),
      extra: Array.from({ length: 20_000 }, () => null),
    };
    expect(() => parseFlowBundleConfig(JSON.stringify(manyValues))).toThrow(
      /too many values/,
    );
  });

  it('rejects configuration larger than 256 KiB', () => {
    const oversized = `${JSON.stringify(bundle()).slice(0, -1)},"padding":"${'x'.repeat(262_145)}"}`;
    expect(() => parseFlowBundleConfig(oversized)).toThrow(/256 KiB/);
  });
});
