import type { JsonValue, MbtiAnswerValue } from './types.js';
import type { MbtiAssessment } from './mbti.js';
import type { BirthChartInput, NatalChartResult } from './natal.js';
import type { InterpretationResult } from './types.js';

export type FlowInputSource = 'queued' | 'steering';

export interface FlowInputRecord {
  readonly id: string;
  readonly sequence: number;
  readonly source: FlowInputSource;
  readonly content: string;
}

export interface FlowSourceReferences {
  readonly jobId: string;
  readonly queuedMessageIds: readonly string[];
  readonly steeringMessageIds: readonly string[];
  readonly confirmationMessageIds: readonly string[];
  readonly subject: 'unknown' | 'self';
}

export interface MbtiCandidate {
  readonly answers: readonly MbtiAnswerValue[];
  readonly presented: boolean;
  readonly afterSequence: number | null;
  readonly sourceMessageIds: readonly string[];
}

/**
 * Strict, versioned host-owned JSON state. Agent output is stored only in
 * candidate/interpretation fields and never becomes a confirmed fact directly.
 */
export interface FlowExecutionState {
  readonly schemaVersion: 1;
  readonly request: string;
  readonly inputs: readonly FlowInputRecord[];
  readonly sources: FlowSourceReferences;
  readonly pendingPurpose: string | null;
  readonly suggestedFlow: string | null;
  readonly selectedFlow: string | null;
  readonly choiceAfterSequence: number | null;
  readonly askedQuestionIds: readonly number[];
  readonly answerAfterSequence: number | null;
  readonly mbtiAnswers: readonly MbtiAnswerValue[];
  readonly mbtiCandidate: MbtiCandidate | null;
  readonly mbtiAssessment: MbtiAssessment | null;
  readonly mbtiReuse: boolean;
  readonly birthParseText: string | null;
  readonly birthParseRefs: readonly string[];
  readonly birthParsedInitial: boolean;
  readonly birthTimeUnknown: boolean;
  readonly birthCandidate: Partial<BirthChartInput> | null;
  readonly birthCandidateRefs: readonly string[];
  readonly birthCandidatePresented: boolean;
  readonly birthAfterSequence: number | null;
  readonly natalConfirmed: BirthChartInput | null;
  readonly chart: NatalChartResult | null;
  readonly interpretation: InterpretationResult | null;
}

export function createInitialExecutionState(input: {
  readonly jobId: string;
  readonly request: string;
  readonly queuedMessageId: string;
  readonly queuedSequence: number;
}): FlowExecutionState {
  const record: FlowInputRecord = {
    id: input.queuedMessageId,
    sequence: input.queuedSequence,
    source: 'queued',
    content: input.request,
  };
  return {
    schemaVersion: 1,
    request: input.request,
    inputs: [record],
    sources: {
      jobId: input.jobId,
      queuedMessageIds: [input.queuedMessageId],
      steeringMessageIds: [],
      confirmationMessageIds: [],
      subject: 'unknown',
    },
    pendingPurpose: null,
    suggestedFlow: null,
    selectedFlow: null,
    choiceAfterSequence: null,
    askedQuestionIds: [],
    answerAfterSequence: null,
    mbtiAnswers: [],
    mbtiCandidate: null,
    mbtiAssessment: null,
    mbtiReuse: false,
    birthParseText: null,
    birthParseRefs: [],
    birthParsedInitial: false,
    birthTimeUnknown: false,
    birthCandidate: null,
    birthCandidateRefs: [],
    birthCandidatePresented: false,
    birthAfterSequence: null,
    natalConfirmed: null,
    chart: null,
    interpretation: null,
  };
}

export function parseFlowExecutionState(value: unknown): FlowExecutionState {
  if (!isRecord(value) || value['schemaVersion'] !== 1) {
    throw new TypeError('Flow execution state version is invalid.');
  }
  const allowed = new Set([
    'schemaVersion',
    'request',
    'inputs',
    'sources',
    'pendingPurpose',
    'suggestedFlow',
    'selectedFlow',
    'choiceAfterSequence',
    'askedQuestionIds',
    'answerAfterSequence',
    'mbtiAnswers',
    'mbtiCandidate',
    'mbtiAssessment',
    'mbtiReuse',
    'birthParseText',
    'birthParseRefs',
    'birthParsedInitial',
    'birthTimeUnknown',
    'birthCandidate',
    'birthCandidateRefs',
    'birthCandidatePresented',
    'birthAfterSequence',
    'natalConfirmed',
    'chart',
    'interpretation',
  ]);
  assertOnlyKeys(value, allowed, 'Flow execution state');
  const request = requiredString(value['request'], 'request', 100_000);
  const inputs = parseInputRecords(value['inputs']);
  const sources = parseSources(value['sources']);
  const pendingPurpose = nullableString(value['pendingPurpose'], 64);
  const suggestedFlow = nullableString(value['suggestedFlow'], 64);
  const selectedFlow = nullableString(value['selectedFlow'], 64);
  const choiceAfterSequence = nullableInteger(value['choiceAfterSequence']);
  const askedQuestionIds = integerArray(value['askedQuestionIds'], 12);
  const answerAfterSequence = nullableInteger(value['answerAfterSequence']);
  const mbtiAnswers = parseAnswerArray(value['mbtiAnswers']);
  const mbtiCandidate = parseMbtiCandidate(value['mbtiCandidate']);
  const mbtiAssessment = nullablePlainObject(value['mbtiAssessment']);
  if (typeof value['mbtiReuse'] !== 'boolean')
    invalid('Flow execution state MBTI reuse flag is invalid.');
  const birthParseText = nullableString(value['birthParseText'], 100_000);
  const birthParseRefs = stringArray(value['birthParseRefs'], 10_000);
  if (typeof value['birthParsedInitial'] !== 'boolean')
    invalid('Flow execution state birth parse flag is invalid.');
  if (typeof value['birthTimeUnknown'] !== 'boolean')
    invalid('Flow execution state birth time flag is invalid.');
  const birthCandidate = parseBirthCandidate(value['birthCandidate']);
  const birthCandidateRefs = stringArray(value['birthCandidateRefs'], 10_000);
  if (typeof value['birthCandidatePresented'] !== 'boolean')
    invalid('Flow execution state birth confirmation flag is invalid.');
  const birthAfterSequence = nullableInteger(value['birthAfterSequence']);
  const natalConfirmed = nullablePlainObject(value['natalConfirmed']);
  const chart = nullablePlainObject(value['chart']);
  const interpretation = nullablePlainObject(value['interpretation']);
  if (sources.jobId.length === 0 || sources.queuedMessageIds.length === 0) {
    invalid('Flow execution state source references are incomplete.');
  }
  if (
    inputs.some(
      (item) =>
        item.source === 'queued' && !sources.queuedMessageIds.includes(item.id),
    ) ||
    inputs.some(
      (item) =>
        item.source === 'steering' &&
        !sources.steeringMessageIds.includes(item.id),
    )
  ) {
    invalid('Flow execution state inputs do not match their sources.');
  }
  return {
    schemaVersion: 1,
    request,
    inputs,
    sources,
    pendingPurpose,
    suggestedFlow,
    selectedFlow,
    choiceAfterSequence,
    askedQuestionIds,
    answerAfterSequence,
    mbtiAnswers,
    mbtiCandidate,
    mbtiAssessment: mbtiAssessment as unknown as MbtiAssessment | null,
    mbtiReuse: value['mbtiReuse'],
    birthParseText,
    birthParseRefs,
    birthParsedInitial: value['birthParsedInitial'],
    birthTimeUnknown: value['birthTimeUnknown'],
    birthCandidate,
    birthCandidateRefs,
    birthCandidatePresented: value['birthCandidatePresented'],
    birthAfterSequence,
    natalConfirmed: natalConfirmed as unknown as BirthChartInput | null,
    chart: chart as unknown as NatalChartResult | null,
    interpretation: interpretation as unknown as InterpretationResult | null,
  };
}

export function flowExecutionStateJson(state: FlowExecutionState): JsonValue {
  return state as unknown as JsonValue;
}

export function lastInputSequence(state: FlowExecutionState): number {
  return state.inputs.reduce(
    (sequence, item) => Math.max(sequence, item.sequence),
    0,
  );
}

function parseInputRecords(value: unknown): readonly FlowInputRecord[] {
  if (!Array.isArray(value) || value.length > 20_000)
    invalid('Flow execution state inputs are invalid.');
  const ids = new Set<string>();
  let previousSequence = 0;
  return value.map((entry) => {
    if (!isRecord(entry)) invalid('Flow execution input is invalid.');
    assertOnlyKeys(
      entry,
      new Set(['id', 'sequence', 'source', 'content']),
      'Flow execution input',
    );
    const id = requiredString(entry['id'], 'input ID', 256);
    const sequence = requiredInteger(entry['sequence'], 'input sequence');
    const source = entry['source'];
    const content = requiredString(entry['content'], 'input content', 100_000);
    if (
      ids.has(id) ||
      sequence < 1 ||
      sequence < previousSequence ||
      (source !== 'queued' && source !== 'steering')
    ) {
      invalid('Flow execution input references are invalid.');
    }
    ids.add(id);
    previousSequence = sequence;
    return { id, sequence, source, content };
  });
}

function parseSources(value: unknown): FlowSourceReferences {
  if (!isRecord(value)) invalid('Flow execution sources are invalid.');
  assertOnlyKeys(
    value,
    new Set([
      'jobId',
      'queuedMessageIds',
      'steeringMessageIds',
      'confirmationMessageIds',
      'subject',
    ]),
    'Flow execution sources',
  );
  const subject = value['subject'];
  if (subject !== 'unknown' && subject !== 'self')
    invalid('Flow execution subject is invalid.');
  return {
    jobId: requiredString(value['jobId'], 'job ID', 256),
    queuedMessageIds: stringArray(value['queuedMessageIds'], 10_000),
    steeringMessageIds: stringArray(value['steeringMessageIds'], 10_000),
    confirmationMessageIds: stringArray(
      value['confirmationMessageIds'],
      10_000,
    ),
    subject,
  };
}

function parseAnswerArray(value: unknown): readonly MbtiAnswerValue[] {
  if (!Array.isArray(value) || value.length > 12)
    invalid('Flow execution MBTI answers are invalid.');
  const seen = new Set<number>();
  return value.map((entry) => {
    if (!isRecord(entry)) invalid('Flow execution MBTI answer is invalid.');
    assertOnlyKeys(entry, new Set(['questionId', 'value']), 'MBTI answer');
    const questionId = requiredInteger(entry['questionId'], 'question ID');
    const answer = entry['value'];
    if (
      questionId < 1 ||
      questionId > 12 ||
      seen.has(questionId) ||
      !isAnswerValue(answer)
    ) {
      invalid('Flow execution MBTI answer is invalid.');
    }
    seen.add(questionId);
    return { questionId, value: answer };
  });
}

function parseMbtiCandidate(value: unknown): MbtiCandidate | null {
  if (value === null) return null;
  if (!isRecord(value)) invalid('Flow execution MBTI candidate is invalid.');
  assertOnlyKeys(
    value,
    new Set(['answers', 'presented', 'afterSequence', 'sourceMessageIds']),
    'MBTI candidate',
  );
  if (typeof value['presented'] !== 'boolean')
    invalid('Flow execution MBTI candidate is invalid.');
  return {
    answers: parseAnswerArray(value['answers']),
    presented: value['presented'],
    afterSequence: nullableInteger(value['afterSequence']),
    sourceMessageIds: stringArray(value['sourceMessageIds'], 10_000),
  };
}

function parseBirthCandidate(value: unknown): Partial<BirthChartInput> | null {
  if (value === null) return null;
  if (!isRecord(value)) invalid('Flow execution birth candidate is invalid.');
  assertOnlyKeys(
    value,
    new Set([
      'localDate',
      'localTime',
      'latitude',
      'longitude',
      'timeZone',
      'utcOffsetMinutes',
    ]),
    'Birth candidate',
  );
  for (const key of ['localDate', 'localTime', 'timeZone'] as const) {
    const field = value[key];
    if (
      field !== undefined &&
      (typeof field !== 'string' || field.length === 0 || field.length > 128)
    ) {
      invalid('Flow execution birth candidate is invalid.');
    }
  }
  for (const key of ['latitude', 'longitude', 'utcOffsetMinutes'] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== 'number')
      invalid('Flow execution birth candidate is invalid.');
  }
  return value;
}

function nullablePlainObject(value: unknown): Record<string, JsonValue> | null {
  if (value === null) return null;
  if (!isRecord(value)) invalid('Flow execution object is invalid.');
  validateJson(value, 0);
  return value as Record<string, JsonValue>;
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 32) invalid('Flow execution JSON is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Flow execution JSON is invalid.');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (!isRecord(value)) invalid('Flow execution JSON is invalid.');
  for (const item of Object.values(value)) validateJson(item, depth + 1);
}

function integerArray(value: unknown, limit: number): readonly number[] {
  if (!Array.isArray(value) || value.length > limit)
    invalid('Flow execution integer array is invalid.');
  const seen = new Set<number>();
  return value.map((item) => {
    const number = requiredInteger(item, 'integer array item');
    if (seen.has(number)) invalid('Flow execution integer array is invalid.');
    seen.add(number);
    return number;
  });
}

function stringArray(value: unknown, limit: number): readonly string[] {
  if (!Array.isArray(value) || value.length > limit)
    invalid('Flow execution string array is invalid.');
  const seen = new Set<string>();
  return value.map((entry) => {
    const text = requiredString(entry, 'string array item', 4096);
    if (seen.has(text)) invalid('Flow execution string array is invalid.');
    seen.add(text);
    return text;
  });
}

function nullableString(value: unknown, maxLength: number): string | null {
  return value === null
    ? null
    : requiredString(value, 'state string', maxLength);
}

function nullableInteger(value: unknown): number | null {
  return value === null ? null : requiredInteger(value, 'state integer');
}

function requiredString(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || value.length > limit)
    invalid(`Flow execution ${label} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    invalid(`Flow execution ${label} is invalid.`);
  return value;
}

function isAnswerValue(value: unknown): value is MbtiAnswerValue['value'] {
  return (
    value === null ||
    value === -2 ||
    value === -1 ||
    value === 0 ||
    value === 1 ||
    value === 2
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

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    invalid(`${label} contains an unknown field.`);
}

function invalid(message: string): never {
  throw new TypeError(message);
}
