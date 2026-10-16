import type { MbtiAnswerValue } from './types.js';

export const MBTI_BANK_VERSION = 'mbti-original-v1';
export const MBTI_DISCLAIMER =
  '此為原創、非官方的自我反思練習，不是心理測驗或心理診斷。';
export const MBTI_QUESTIONS_PER_BATCH = 4;

export type MbtiAxis = 'EI' | 'SN' | 'TF' | 'JP';
export type MbtiLetter = 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P';

export interface MbtiQuestion {
  readonly id: number;
  readonly axis: MbtiAxis;
  readonly statement: string;
  readonly positiveLetter: MbtiLetter;
  readonly negativeLetter: MbtiLetter;
}

export type MbtiAnswer = MbtiAnswerValue;

export interface MbtiAnswerHistory {
  readonly ownerId: string;
  readonly bankVersion: string;
  readonly answers: readonly MbtiAnswer[];
}

export interface MbtiAxisEvidence {
  readonly axis: MbtiAxis;
  readonly letter: MbtiLetter | '?';
  readonly score: number;
  readonly answeredCount: number;
  readonly evidence: readonly {
    readonly questionId: number;
    readonly value: -2 | -1 | 0 | 1 | 2;
    readonly statement: string;
  }[];
}

export interface MbtiAssessment {
  readonly bankVersion: string;
  readonly type: string;
  readonly candidates: readonly string[];
  readonly axes: readonly MbtiAxisEvidence[];
  /** True after all 12 questions have an explicit numeric or null answer. */
  readonly complete: boolean;
  readonly disclaimer: string;
}

const questionRows: readonly MbtiQuestion[] = [
  {
    id: 1,
    axis: 'EI',
    statement: '在不熟悉的小組裡，我通常會先開口和別人交流。',
    positiveLetter: 'E',
    negativeLetter: 'I',
  },
  {
    id: 2,
    axis: 'EI',
    statement: '參加社交活動後，我常想再和更多人相處一段時間。',
    positiveLetter: 'E',
    negativeLetter: 'I',
  },
  {
    id: 3,
    axis: 'EI',
    statement: '討論新想法時，我常透過說出想法來整理思路。',
    positiveLetter: 'E',
    negativeLetter: 'I',
  },
  {
    id: 4,
    axis: 'SN',
    statement: '做判斷時，我通常先看具體細節和已確認的事實。',
    positiveLetter: 'S',
    negativeLetter: 'N',
  },
  {
    id: 5,
    axis: 'SN',
    statement: '學習新事物時，實際例子通常比抽象模式更能幫助我。',
    positiveLetter: 'S',
    negativeLetter: 'N',
  },
  {
    id: 6,
    axis: 'SN',
    statement: '我較常留意眼前可觀察的事情，而不是延伸猜想。',
    positiveLetter: 'S',
    negativeLetter: 'N',
  },
  {
    id: 7,
    axis: 'TF',
    statement: '做重要決定時，一致的原則通常比維持和諧更優先。',
    positiveLetter: 'T',
    negativeLetter: 'F',
  },
  {
    id: 8,
    axis: 'TF',
    statement: '意見不同時，我會先找出論點是否前後一致。',
    positiveLetter: 'T',
    negativeLetter: 'F',
  },
  {
    id: 9,
    axis: 'TF',
    statement: '給建議時，我通常先指出問題與可行的修正方式。',
    positiveLetter: 'T',
    negativeLetter: 'F',
  },
  {
    id: 10,
    axis: 'JP',
    statement: '安排一段時間的工作時，我喜歡先訂下計畫和時程。',
    positiveLetter: 'J',
    negativeLetter: 'P',
  },
  {
    id: 11,
    axis: 'JP',
    statement: '有明確待辦事項時，我偏好先完成再開始下一件事。',
    positiveLetter: 'J',
    negativeLetter: 'P',
  },
  {
    id: 12,
    axis: 'JP',
    statement: '決定一個方向後，我通常希望按原計畫持續推進。',
    positiveLetter: 'J',
    negativeLetter: 'P',
  },
];

export const MBTI_QUESTIONS: readonly MbtiQuestion[] = Object.freeze(
  questionRows.map((question) => Object.freeze(question)),
);

const QUESTION_BY_ID = new Map(
  MBTI_QUESTIONS.map((question) => [question.id, question]),
);
const AXES: readonly MbtiAxis[] = ['EI', 'SN', 'TF', 'JP'];

export function validateMbtiAnswers(value: unknown): readonly MbtiAnswer[] {
  if (!Array.isArray(value))
    throw new TypeError('MBTI answers must be an array.');
  if (value.length > MBTI_QUESTIONS.length) {
    throw new TypeError('MBTI answers contain too many items.');
  }
  const seen = new Set<number>();
  const answers = value.map((answer) => {
    if (!isRecord(answer))
      throw new TypeError('Each MBTI answer must be an object.');
    assertOnlyKeys(answer, ['questionId', 'value']);
    const questionId = answer['questionId'];
    const answerValue = answer['value'];
    if (
      typeof questionId !== 'number' ||
      !Number.isSafeInteger(questionId) ||
      !QUESTION_BY_ID.has(questionId)
    ) {
      throw new TypeError('MBTI answer has an unknown question ID.');
    }
    if (seen.has(questionId))
      throw new TypeError('MBTI answers contain a duplicate question ID.');
    if (!isMbtiAnswerValue(answerValue)) {
      throw new TypeError(
        'MBTI answer value must be an integer from -2 to 2 or null.',
      );
    }
    seen.add(questionId);
    return { questionId, value: answerValue };
  });
  return answers.sort((left, right) => left.questionId - right.questionId);
}

export function selectMbtiQuestionBatch(
  answersValue: unknown,
  clarificationQuestionIds: readonly number[] = [],
): readonly MbtiQuestion[] {
  const answers = validateMbtiAnswers(answersValue);
  const clarifiedIds = validateQuestionIds(clarificationQuestionIds);
  const selectedIds =
    clarifiedIds.length > 0
      ? clarifiedIds
      : MBTI_QUESTIONS.filter(
          (question) =>
            !answers.some((answer) => answer.questionId === question.id),
        ).map((question) => question.id);
  return selectedIds
    .slice(0, MBTI_QUESTIONS_PER_BATCH)
    .map((id) => QUESTION_BY_ID.get(id))
    .filter((question): question is MbtiQuestion => question !== undefined);
}

export function mergeMbtiAnswerHistory(
  existing: MbtiAnswerHistory | null,
  ownerId: string,
  incomingValue: unknown,
  clarificationQuestionIds: readonly number[] = [],
): MbtiAnswerHistory {
  if (ownerId.length === 0)
    throw new TypeError('MBTI answer owner ID is required.');
  if (existing !== null && existing.ownerId !== ownerId) {
    throw new TypeError('MBTI history belongs to a different user.');
  }
  const incoming = validateMbtiAnswers(incomingValue);
  const clarificationIds = new Set(
    validateQuestionIds(clarificationQuestionIds),
  );
  const current =
    existing !== null && existing.bankVersion === MBTI_BANK_VERSION
      ? validateMbtiAnswers(existing.answers)
      : [];
  const merged = new Map(
    current.map((answer) => [answer.questionId, answer.value]),
  );
  for (const answer of incoming) {
    const previous = merged.get(answer.questionId);
    if (
      previous !== undefined &&
      previous !== answer.value &&
      !clarificationIds.has(answer.questionId)
    ) {
      throw new TypeError(
        'Changing an existing MBTI answer requires explicit clarification.',
      );
    }
    merged.set(answer.questionId, answer.value);
  }
  return {
    ownerId,
    bankVersion: MBTI_BANK_VERSION,
    answers: [...merged.entries()]
      .map(([questionId, value]) => ({ questionId, value }))
      .sort((left, right) => left.questionId - right.questionId),
  };
}

export function evaluateMbtiAnswers(value: unknown): MbtiAssessment {
  const answers = validateMbtiAnswers(value);
  const answerById = new Map(
    answers.map((answer) => [answer.questionId, answer.value]),
  );
  const axes = AXES.map((axis): MbtiAxisEvidence => {
    const questions = MBTI_QUESTIONS.filter(
      (question) => question.axis === axis,
    );
    const evidence = questions.flatMap((question) => {
      const answer = answerById.get(question.id);
      return answer === undefined || answer === null
        ? []
        : [
            {
              questionId: question.id,
              value: answer,
              statement: question.statement,
            },
          ];
    });
    const score = evidence.reduce((total, item) => total + item.value, 0);
    const letter =
      evidence.length >= 2 && Math.abs(score) >= 2
        ? score > 0
          ? (questions[0]?.positiveLetter ?? '?')
          : (questions[0]?.negativeLetter ?? '?')
        : '?';
    return { axis, letter, score, answeredCount: evidence.length, evidence };
  });
  const type = axes.map((axis) => axis.letter).join('');
  let candidates = [''];
  for (const axis of axes) {
    const question = MBTI_QUESTIONS.find((item) => item.axis === axis.axis);
    if (question === undefined)
      throw new Error('MBTI axis has no fixed questions.');
    const letters =
      axis.letter === '?'
        ? [question.positiveLetter, question.negativeLetter]
        : [axis.letter];
    candidates = candidates.flatMap((candidate) =>
      letters.map((letter) => candidate + letter),
    );
  }
  return {
    bankVersion: MBTI_BANK_VERSION,
    type,
    candidates,
    axes,
    complete: answers.length === MBTI_QUESTIONS.length,
    disclaimer: MBTI_DISCLAIMER,
  };
}

function isMbtiAnswerValue(value: unknown): value is MbtiAnswerValue['value'] {
  return (
    value === null ||
    value === -2 ||
    value === -1 ||
    value === 0 ||
    value === 1 ||
    value === 2
  );
}

function validateQuestionIds(values: unknown): readonly number[] {
  if (!Array.isArray(values))
    throw new TypeError('Question IDs must be an array.');
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const candidate of values) {
    if (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      !QUESTION_BY_ID.has(candidate)
    ) {
      throw new TypeError('Question ID is unknown.');
    }
    if (seen.has(candidate))
      throw new TypeError('Question IDs contain a duplicate.');
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key))
      throw new TypeError('MBTI answer contains an unknown field.');
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
