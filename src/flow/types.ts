export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export type FlowAuth =
  { readonly mode: 'pi-login' } | { readonly mode: 'api-key' };

export interface FlowRuntime {
  readonly provider: string;
  readonly model: string;
  readonly thinking: PiThinkingLevel;
  /** Environment variable name only. Never store a credential value here. */
  readonly apiKeyEnv: string | null;
  /** Omitted auth preserves the legacy API-key-only interpretation. */
  readonly auth?: FlowAuth;
}

export interface FlowLimits {
  readonly nodeTimeoutMs: number;
  readonly waitTimeoutMs: number;
  readonly jobTimeoutMs: number;
  readonly maxTransitions: number;
  readonly maxRetries: number;
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
  readonly maxOutputChars: number;
}

export type FlowLimitOverrides = Partial<FlowLimits>;
export type NodeKind = 'agent' | 'server';

export interface NodeDefinition {
  readonly id: string;
  readonly kind: NodeKind;
  /** Required for server nodes. The registry only validates this host name. */
  readonly handler?: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly expectedResult: string;
  readonly resultContract: string | null;
  /** Keys are allowed transition names; values are local node IDs or flow/node references. */
  readonly next: Readonly<Record<string, string>>;
  /** Missing tools means no tools. */
  readonly tools?: readonly string[];
  /** Agent nodes may explicitly replace the flow runtime. */
  readonly runtime?: FlowRuntime;
  /** Overrides are merged over the required flow limits. */
  readonly limits?: FlowLimitOverrides;
}

export interface FlowDefinition {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly resultDescription: string;
  readonly aliases: readonly string[];
  readonly runtime: FlowRuntime;
  readonly limits: FlowLimits;
  readonly entryNode: string;
  readonly nodes: readonly NodeDefinition[];
}

export interface FlowBundle {
  readonly schemaVersion: 1;
  readonly flows: readonly FlowDefinition[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * Runtime boundary for a controlled Pi adapter. Results are structured data;
 * transition selection is never inferred from prose.
 */
export interface AgentRuntime {
  run(input: {
    readonly controllerSessionId: string;
    readonly jobId: string;
    readonly node: NodeDefinition;
    readonly definition: FlowDefinition;
    readonly input: string;
    readonly state: JsonValue;
    readonly historyFacts: readonly JsonValue[];
    readonly signal: AbortSignal;
  }): Promise<AgentNodeResult>;
  dispose(): Promise<void>;
}

export interface AgentNodeResult {
  readonly transition: string;
  readonly result: JsonValue;
  readonly text?: string;
}

export type FlowContractId =
  'recommendation' | 'mbti_answers' | 'birth_input' | 'interpretation';

export const FLOW_CONTRACT_IDS: readonly FlowContractId[] = [
  'recommendation',
  'mbti_answers',
  'birth_input',
  'interpretation',
];

export interface RecommendationResult {
  readonly suggestedFlow: string | null;
}

export interface MbtiAnswerValue {
  readonly questionId: number;
  readonly value: -2 | -1 | 0 | 1 | 2 | null;
}

export interface MbtiAnswersResult {
  readonly answers: readonly MbtiAnswerValue[];
}

/** A partial extraction. Missing fields mean the user has not supplied them. */
export interface BirthInputResult {
  readonly localDate?: string;
  readonly localTime?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly timeZone?: string;
  readonly utcOffsetMinutes?: number;
}

export interface InterpretationSection {
  readonly title: string;
  readonly content: string;
}

export interface InterpretationResult {
  readonly summary: string;
  readonly sections: readonly InterpretationSection[];
}

export const CONTRACT_OUTPUT_LIMITS = {
  summary: 2000,
  sectionTitle: 120,
  sectionContent: 4000,
} as const;

export function validateAgentNodeResult(
  value: unknown,
  node: NodeDefinition,
  maxOutputChars: number,
): AgentNodeResult {
  if (!isRecord(value))
    throw new TypeError('Agent result must be a JSON object.');
  assertOnlyKeys(value, ['transition', 'result', 'text'], 'agent result');
  const transition = value['transition'];
  if (
    typeof transition !== 'string' ||
    transition.length === 0 ||
    !Object.hasOwn(node.next, transition)
  ) {
    throw new TypeError('Agent result contains an undeclared transition.');
  }
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new TypeError('Agent output limit must be a positive safe integer.');
  }
  const result = validateJsonValue(value['result'], 0);
  const resultText = JSON.stringify(result);
  if (resultText.length > maxOutputChars) {
    throw new TypeError('Agent structured result exceeds its output limit.');
  }
  if (node.resultContract !== null) {
    validateContractPayload(node.resultContract, result, maxOutputChars);
  }
  const output: AgentNodeResult = {
    transition,
    result,
    ...(value['text'] === undefined
      ? {}
      : { text: validateOutputText(value['text'], maxOutputChars) }),
  };
  if (
    output.text !== undefined &&
    output.text.length + resultText.length > maxOutputChars
  ) {
    throw new TypeError('Agent result exceeds its combined output limit.');
  }
  return output;
}

export function validateContractPayload(
  contractId: string,
  value: JsonValue,
  maxOutputChars: number,
): JsonValue {
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new TypeError('Agent output limit must be a positive safe integer.');
  }
  switch (contractId) {
    case 'recommendation': {
      assertRecordKeys(value, ['suggestedFlow'], 'recommendation');
      const suggestedFlow = (value as Record<string, unknown>)['suggestedFlow'];
      if (suggestedFlow !== null && !isValidFlowId(suggestedFlow)) {
        throw new TypeError('Recommendation contains an invalid flow ID.');
      }
      break;
    }
    case 'mbti_answers': {
      assertRecordKeys(value, ['answers'], 'MBTI answers');
      const answers = value['answers'];
      if (!Array.isArray(answers) || answers.length > 12) {
        throw new TypeError(
          'MBTI answers must be an array of at most 12 items.',
        );
      }
      const seen = new Set<number>();
      for (const answer of answers) {
        assertRecordKeys(answer, ['questionId', 'value'], 'MBTI answer');
        const record = answer;
        const questionId = record['questionId'];
        const answerValue = record['value'];
        if (
          typeof questionId !== 'number' ||
          !Number.isInteger(questionId) ||
          questionId < 1 ||
          questionId > 12 ||
          seen.has(questionId)
        ) {
          throw new TypeError(
            'MBTI answer has an unknown or duplicate question ID.',
          );
        }
        if (
          answerValue !== null &&
          answerValue !== -2 &&
          answerValue !== -1 &&
          answerValue !== 0 &&
          answerValue !== 1 &&
          answerValue !== 2
        ) {
          throw new TypeError(
            'MBTI answer value must be an integer from -2 to 2 or null.',
          );
        }
        seen.add(questionId);
      }
      break;
    }
    case 'birth_input': {
      assertRecordKeys(
        value,
        [
          'localDate',
          'localTime',
          'latitude',
          'longitude',
          'timeZone',
          'utcOffsetMinutes',
        ],
        'birth input',
      );
      const record = value as Record<string, unknown>;
      for (const key of ['localDate', 'localTime', 'timeZone'] as const) {
        const field = record[key];
        if (
          field !== undefined &&
          (typeof field !== 'string' ||
            field.length === 0 ||
            field.length > (key === 'timeZone' ? 128 : 32))
        ) {
          throw new TypeError(
            `Birth input ${key} must be a bounded non-empty string when supplied.`,
          );
        }
      }
      if (
        record['localDate'] !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(record['localDate'] as string)
      ) {
        throw new TypeError('Birth input localDate must use YYYY-MM-DD.');
      }
      if (
        record['localTime'] !== undefined &&
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(record['localTime'] as string)
      ) {
        throw new TypeError('Birth input localTime must use HH:mm.');
      }
      for (const key of [
        'latitude',
        'longitude',
        'utcOffsetMinutes',
      ] as const) {
        const field = record[key];
        if (
          field !== undefined &&
          (typeof field !== 'number' ||
            !Number.isFinite(field) ||
            (key === 'latitude' && (field < -66 || field > 66)) ||
            (key === 'longitude' && (field < -180 || field > 180)) ||
            (key === 'utcOffsetMinutes' && (field < -840 || field > 840)))
        ) {
          throw new TypeError(
            `Birth input ${key} must be finite when supplied.`,
          );
        }
      }
      if (
        record['utcOffsetMinutes'] !== undefined &&
        !Number.isInteger(record['utcOffsetMinutes'])
      ) {
        throw new TypeError(
          'Birth input UTC offset must be an integer number of minutes.',
        );
      }
      break;
    }
    case 'interpretation': {
      assertRecordKeys(value, ['summary', 'sections'], 'interpretation');
      const record = value as Record<string, unknown>;
      const summary = record['summary'];
      const sections = record['sections'];
      if (
        typeof summary !== 'string' ||
        summary.length === 0 ||
        summary.length > CONTRACT_OUTPUT_LIMITS.summary
      ) {
        throw new TypeError('Interpretation summary has an invalid length.');
      }
      if (
        !Array.isArray(sections) ||
        sections.length < 1 ||
        sections.length > 12
      ) {
        throw new TypeError('Interpretation must contain 1 to 12 sections.');
      }
      for (const section of sections) {
        assertRecordKeys(
          section,
          ['title', 'content'],
          'interpretation section',
        );
        const sectionRecord = section;
        const title = sectionRecord['title'];
        const content = sectionRecord['content'];
        if (
          typeof title !== 'string' ||
          title.length === 0 ||
          title.length > CONTRACT_OUTPUT_LIMITS.sectionTitle
        ) {
          throw new TypeError(
            'Interpretation section title has an invalid length.',
          );
        }
        if (
          typeof content !== 'string' ||
          content.length === 0 ||
          content.length > CONTRACT_OUTPUT_LIMITS.sectionContent
        ) {
          throw new TypeError(
            'Interpretation section content has an invalid length.',
          );
        }
      }
      break;
    }
    default:
      throw new TypeError('Agent result uses an unregistered contract.');
  }
  if (JSON.stringify(value).length > maxOutputChars) {
    throw new TypeError('Agent contract result exceeds its output limit.');
  }
  return value;
}

function isValidFlowId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function validateOutputText(value: unknown, maxOutputChars: number): string {
  if (typeof value !== 'string' || value.length > maxOutputChars) {
    throw new TypeError('Agent output text has an invalid length.');
  }
  return value;
}

function validateJsonValue(value: unknown, depth: number): JsonValue {
  if (depth > 32)
    throw new TypeError('Agent result JSON is nested too deeply.');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Agent result numbers must be finite.');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => validateJsonValue(item, depth + 1));
  }
  if (!isRecord(value))
    throw new TypeError('Agent result must contain strict JSON values.');
  const entries: [string, JsonValue][] = [];
  for (const [key, item] of Object.entries(value)) {
    entries.push([key, validateJsonValue(item, depth + 1)]);
  }
  return Object.fromEntries(entries);
}

function assertRecordKeys(
  value: unknown,
  allowedKeys: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be a JSON object.`);
  assertOnlyKeys(value, allowedKeys, name);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  name: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`${name} contains an unknown field.`);
  }
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
