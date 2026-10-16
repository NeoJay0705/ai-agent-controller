import { describe, expect, it } from 'vitest';

import { createFlowBundle } from '../../src/flow/definitions.js';
import {
  createAgentResponseJsonSchema,
  createAgentResultContractPrompt,
} from '../../src/flow/result-contract-prompt.js';
import {
  CONTRACT_OUTPUT_LIMITS,
  validateAgentNodeResult,
} from '../../src/flow/types.js';
import type {
  FlowLimits,
  FlowRuntime,
  NodeDefinition,
} from '../../src/flow/types.js';

const limits: FlowLimits = {
  nodeTimeoutMs: 10_000,
  waitTimeoutMs: 60_000,
  jobTimeoutMs: 60_000,
  maxTransitions: 10,
  maxRetries: 0,
  maxModelTurns: 5,
  maxToolCalls: 0,
  maxOutputChars: 20_000,
};
const runtime: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: 'FLOW_TEST_API_KEY',
};
const bundle = createFlowBundle({
  runtimes: { intake: runtime, mbti: runtime, natal: runtime },
  limits: { intake: limits, mbti: limits, natal: limits },
});

function nodeFor(contract: string): NodeDefinition {
  const node = bundle.flows
    .flatMap((flow) => flow.nodes)
    .find((candidate) => candidate.resultContract === contract);
  if (node === undefined) throw new Error(`Missing ${contract} fixture.`);
  return node;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a schema object.');
  }
  return value as Record<string, unknown>;
}

function properties(schema: unknown): Record<string, unknown> {
  return record(record(schema)['properties']);
}

function validEnvelope(node: NodeDefinition): Record<string, unknown> {
  switch (node.resultContract) {
    case 'recommendation':
      return { transition: 'ready', result: { suggestedFlow: 'mbti' } };
    case 'mbti_answers':
      return {
        transition: 'parsed',
        result: { answers: [{ questionId: 1, value: null }] },
      };
    case 'birth_input':
      return { transition: 'parsed', result: { latitude: 0, longitude: 0 } };
    case 'interpretation':
      return {
        transition: 'complete',
        result: {
          summary: 'Summary',
          sections: [{ title: 'Title', content: 'Content' }],
        },
      };
    default:
      throw new Error('Unknown contract fixture.');
  }
}

describe('Agent response contract prompt data', () => {
  it.each(['recommendation', 'mbti_answers', 'birth_input', 'interpretation'])(
    'builds strict envelope and payload schema for %s',
    (contract) => {
      const node = nodeFor(contract);
      const schema = createAgentResponseJsonSchema(node, 321);
      const fields = properties(schema);
      const transition = record(fields['transition']);
      const result = record(fields['result']);
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['transition', 'result'],
      });
      expect(transition).toEqual({
        type: 'string',
        enum: Object.keys(node.next).sort(),
      });
      expect(fields['text']).toEqual({ type: 'string', maxLength: 321 });
      expect(result['type']).toBe('object');
      expect(result['additionalProperties']).toBe(false);
      expect(validEnvelope(node)).toBeDefined();
      expect(
        validateAgentNodeResult(
          validEnvelope(node),
          node,
          limits.maxOutputChars,
        ),
      ).toEqual(validEnvelope(node));
    },
  );

  it('uses a dynamic node ID, declared transition names, and the explicit response protocol', () => {
    const source = nodeFor('recommendation');
    const node: NodeDefinition = {
      ...source,
      id: 'anonymous-node',
      next: { continue_with_choice: 'target' },
    };
    const prompt = createAgentResultContractPrompt(node, 777);
    const schemaMatch = prompt.match(/Current response JSON Schema:\n(.+)$/s);
    expect(schemaMatch?.[1]).toBeDefined();
    const schema = JSON.parse(schemaMatch?.[1] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(properties(schema)['transition']).toEqual({
      type: 'string',
      enum: ['continue_with_choice'],
    });
    expect(prompt).toContain('完整的 {transition,result,text?} JSON object');
    expect(prompt).toContain('不是 top-level 格式');
    expect(prompt).toContain('不要 Markdown code fence');
    expect(prompt).toContain('不得把舊 history 中的輸出格式當成當前契約');
    expect(prompt).toContain('777');
    expect(prompt).toContain('不取代 Server CAS、graph 或 membership 檢查');
    const accepted = {
      transition: 'continue_with_choice',
      result: { suggestedFlow: null },
    };
    expect(validateAgentNodeResult(accepted, node, 777)).toEqual(accepted);
    expect(() =>
      validateAgentNodeResult({ ...accepted, transition: 'ready' }, node, 777),
    ).toThrow(/undeclared transition/);
  });

  it('describes recommendation scope and refuses an unknown or missing contract', () => {
    const node = nodeFor('recommendation');
    const prompt = createAgentResultContractPrompt(node, 500);
    expect(prompt).toContain('當次 businessFlows 中已註冊的 Flow ID');
    expect(prompt).toContain('推薦不是本人授權');
    expect(() =>
      createAgentResponseJsonSchema(
        { ...node, resultContract: 'unknown' },
        500,
      ),
    ).toThrow(/not registered/);
    expect(() =>
      createAgentResponseJsonSchema({ ...node, resultContract: null }, 500),
    ).toThrow(/not registered/);
  });

  it('describes MBTI values, bounded IDs, and host-only uniqueness constraints', () => {
    const node = nodeFor('mbti_answers');
    const schema = createAgentResponseJsonSchema(node, 500);
    const result = record(properties(schema)['result']);
    expect(result['required']).toEqual(['answers']);
    const answers = record(properties(result)['answers']);
    expect(answers).toMatchObject({ type: 'array', maxItems: 12 });
    const answer = record(answers['items']);
    expect(answer).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['questionId', 'value'],
    });
    expect(properties(answer)['questionId']).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 12,
    });
    expect(properties(answer)['value']).toEqual({
      enum: [-2, -1, 0, 1, 2, null],
    });
    expect(createAgentResultContractPrompt(node, 500)).toContain(
      '不可重複 questionId，而且 questionId 必須是 host 已提問的題目 ID',
    );
  });

  it('keeps birth fields optional and describes omitted values and zero coordinates', () => {
    const node = nodeFor('birth_input');
    const schema = createAgentResponseJsonSchema(node, 500);
    const birth = record(properties(schema)['result']);
    expect(birth['required']).toBeUndefined();
    expect(birth['additionalProperties']).toBe(false);
    expect(properties(birth)).toMatchObject({
      localDate: {
        type: 'string',
        maxLength: 32,
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      },
      localTime: {
        type: 'string',
        maxLength: 32,
        pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
      },
      timeZone: { type: 'string', maxLength: 128 },
      latitude: { type: 'number', minimum: -66, maximum: 66 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      utcOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840 },
    });
    const prompt = createAgentResultContractPrompt(node, 500);
    expect(prompt).toContain('缺少欄位必須省略，不要補 null');
    expect(prompt).toContain('數值 0 是有效值');
    expect(
      validateAgentNodeResult(
        {
          transition: 'parsed',
          result: { latitude: 0, longitude: 0, utcOffsetMinutes: 0 },
        },
        node,
        500,
      ),
    ).toBeDefined();
  });

  it('uses the validator shared interpretation limits and rejects invalid envelopes', () => {
    const node = nodeFor('interpretation');
    const schema = createAgentResponseJsonSchema(node, 500);
    const result = record(properties(schema)['result']);
    expect(result['required']).toEqual(['summary', 'sections']);
    expect(properties(result)['summary']).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: CONTRACT_OUTPUT_LIMITS.summary,
    });
    const sections = record(properties(result)['sections']);
    expect(sections).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 12,
    });
    const section = record(sections['items']);
    expect(section).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title', 'content'],
    });
    expect(properties(section)['title']).toMatchObject({
      minLength: 1,
      maxLength: CONTRACT_OUTPUT_LIMITS.sectionTitle,
    });
    expect(properties(section)['content']).toMatchObject({
      minLength: 1,
      maxLength: CONTRACT_OUTPUT_LIMITS.sectionContent,
    });

    const valid = validEnvelope(node);
    expect(() =>
      validateAgentNodeResult({ result: valid['result'] }, node, 500),
    ).toThrow();
    expect(() =>
      validateAgentNodeResult({ ...valid, extra: true }, node, 500),
    ).toThrow();
    expect(() =>
      validateAgentNodeResult(
        {
          ...valid,
          result: { summary: 'Summary', sections: [], rationale: 'x' },
        },
        node,
        500,
      ),
    ).toThrow();
    expect(() =>
      validateAgentNodeResult(
        { ...valid, transition: 'not_declared' },
        node,
        500,
      ),
    ).toThrow();
    expect(() =>
      validateAgentNodeResult(
        {
          ...valid,
          result: { summary: '', sections: [{ title: 'x', content: 'y' }] },
        },
        node,
        500,
      ),
    ).toThrow();
  });

  it('keeps strict runtime validation for payload-only and invalid contract values', () => {
    const node = nodeFor('recommendation');
    for (const invalid of [
      { suggestedFlow: 'mbti' },
      {
        transition: 'ready',
        result: { suggestedFlow: 'mbti', rationale: 'x' },
      },
      { transition: 'unknown', result: { suggestedFlow: null } },
      { transition: 'ready', result: {} },
      { transition: 'ready', result: { suggestedFlow: 'Invalid ID' } },
    ]) {
      expect(() => validateAgentNodeResult(invalid, node, 500)).toThrow();
    }
    const mbti = nodeFor('mbti_answers');
    for (const result of [
      { answers: [{ questionId: 1, value: 3 }] },
      { answers: [{ questionId: 0, value: null }] },
      {
        answers: [
          { questionId: 1, value: 0 },
          { questionId: 1, value: 2 },
        ],
      },
    ]) {
      expect(() =>
        validateAgentNodeResult({ transition: 'parsed', result }, mbti, 500),
      ).toThrow();
    }
  });
});
