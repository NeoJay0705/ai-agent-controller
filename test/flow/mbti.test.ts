import { describe, expect, it } from 'vitest';

import {
  MBTI_BANK_VERSION,
  MBTI_DISCLAIMER,
  MBTI_QUESTIONS,
  evaluateMbtiAnswers,
  mergeMbtiAnswerHistory,
  selectMbtiQuestionBatch,
  validateMbtiAnswers,
} from '../../src/flow/mbti.js';
import type { MbtiAnswer } from '../../src/flow/mbti.js';

function answers(value: -2 | -1 | 0 | 1 | 2 | null): MbtiAnswer[] {
  return MBTI_QUESTIONS.map((question) => ({ questionId: question.id, value }));
}

describe('MBTI original question bank', () => {
  it('has 12 fixed questions, three on each axis, with stable IDs', () => {
    expect(MBTI_QUESTIONS.map((question) => question.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(
      MBTI_QUESTIONS.filter((question) => question.axis === 'EI'),
    ).toHaveLength(3);
    expect(
      MBTI_QUESTIONS.filter((question) => question.axis === 'SN'),
    ).toHaveLength(3);
    expect(
      MBTI_QUESTIONS.filter((question) => question.axis === 'TF'),
    ).toHaveLength(3);
    expect(
      MBTI_QUESTIONS.filter((question) => question.axis === 'JP'),
    ).toHaveLength(3);
    expect(
      new Set(MBTI_QUESTIONS.map((question) => question.statement)).size,
    ).toBe(12);
  });

  it('maps all positive and negative answers to the fixed axis letters', () => {
    expect(evaluateMbtiAnswers(answers(2)).type).toBe('ESTJ');
    expect(evaluateMbtiAnswers(answers(-2)).type).toBe('INFP');
    expect(evaluateMbtiAnswers(answers(2)).candidates).toEqual(['ESTJ']);
  });

  it('keeps neutral and unknown axes uncertain without invented confidence', () => {
    const neutral = evaluateMbtiAnswers(answers(0));
    expect(neutral.type).toBe('????');
    expect(neutral.candidates).toHaveLength(16);
    expect(neutral.complete).toBe(true);
    expect(neutral.disclaimer).toBe(MBTI_DISCLAIMER);
    expect(neutral).not.toHaveProperty('confidence');

    const unknown = evaluateMbtiAnswers(answers(null));
    expect(unknown.type).toBe('????');
    expect(unknown.candidates).toHaveLength(16);
    expect(unknown.axes.every((axis) => axis.answeredCount === 0)).toBe(true);
  });

  it('requires two non-null answers and an absolute axis sum of at least two', () => {
    const oneStrongAnswer = evaluateMbtiAnswers([
      { questionId: 1, value: 2 },
      { questionId: 2, value: null },
      { questionId: 3, value: null },
    ]);
    expect(oneStrongAnswer.axes[0]?.letter).toBe('?');

    const insufficientSum = evaluateMbtiAnswers([
      { questionId: 1, value: 1 },
      { questionId: 2, value: 0 },
      { questionId: 3, value: null },
    ]);
    expect(insufficientSum.axes[0]?.letter).toBe('?');

    const positiveThreshold = evaluateMbtiAnswers([
      { questionId: 1, value: 1 },
      { questionId: 2, value: 1 },
      { questionId: 3, value: null },
    ]);
    expect(positiveThreshold.axes[0]?.letter).toBe('E');

    const negativeThreshold = evaluateMbtiAnswers([
      { questionId: 1, value: -2 },
      { questionId: 2, value: 0 },
      { questionId: 3, value: null },
    ]);
    expect(negativeThreshold.axes[0]?.letter).toBe('I');
    expect(negativeThreshold.axes[0]?.evidence).toHaveLength(2);
    expect(negativeThreshold.axes[0]?.evidence[0]).toMatchObject({
      questionId: 1,
      value: -2,
    });
  });

  it('marks a full set with nulls complete but leaves omitted questions incomplete', () => {
    expect(evaluateMbtiAnswers(answers(null)).complete).toBe(true);
    expect(evaluateMbtiAnswers([{ questionId: 1, value: null }]).complete).toBe(
      false,
    );
  });

  it('rejects unknown IDs, duplicate IDs, non-integers, out-of-range values, and extra keys', () => {
    expect(() => validateMbtiAnswers([{ questionId: 0, value: 1 }])).toThrow(
      /unknown question ID/,
    );
    expect(() =>
      validateMbtiAnswers([
        { questionId: 1, value: 1 },
        { questionId: 1, value: -1 },
      ]),
    ).toThrow(/duplicate question ID/);
    expect(() => validateMbtiAnswers([{ questionId: 1, value: 1.5 }])).toThrow(
      /integer/,
    );
    expect(() => validateMbtiAnswers([{ questionId: 1, value: 3 }])).toThrow(
      /integer/,
    );
    expect(() =>
      validateMbtiAnswers([{ questionId: 1, value: 1, ownerId: 'other' }]),
    ).toThrow(/unknown field/);
  });
});

describe('MBTI batches and history', () => {
  it('asks four questions per batch and skips prior explicit null answers', () => {
    expect(selectMbtiQuestionBatch([]).map((question) => question.id)).toEqual([
      1, 2, 3, 4,
    ]);
    const firstBatch: MbtiAnswer[] = [
      { questionId: 1, value: 2 },
      { questionId: 2, value: null },
      { questionId: 3, value: 0 },
      { questionId: 4, value: -1 },
    ];
    expect(
      selectMbtiQuestionBatch(firstBatch).map((question) => question.id),
    ).toEqual([5, 6, 7, 8]);
  });

  it('asks only requested clarification items and caps the batch at four', () => {
    expect(
      selectMbtiQuestionBatch([], [1, 4, 7, 10, 12]).map(
        (question) => question.id,
      ),
    ).toEqual([1, 4, 7, 10]);
    expect(() => selectMbtiQuestionBatch([], [1, 1])).toThrow(/duplicate/);
    expect(() => selectMbtiQuestionBatch([], [13])).toThrow(/unknown/);
  });

  it('reuses only same-version, same-owner history and requires explicit clarification to change it', () => {
    const first = mergeMbtiAnswerHistory(null, 'user-a', [
      { questionId: 1, value: 2 },
    ]);
    expect(first.bankVersion).toBe(MBTI_BANK_VERSION);
    const retained = mergeMbtiAnswerHistory(first, 'user-a', [
      { questionId: 2, value: null },
    ]);
    expect(retained.answers).toEqual([
      { questionId: 1, value: 2 },
      { questionId: 2, value: null },
    ]);
    expect(() =>
      mergeMbtiAnswerHistory(retained, 'user-a', [
        { questionId: 1, value: -2 },
      ]),
    ).toThrow(/explicit clarification/);
    expect(
      mergeMbtiAnswerHistory(
        retained,
        'user-a',
        [{ questionId: 1, value: -2 }],
        [1],
      ).answers[0],
    ).toEqual({ questionId: 1, value: -2 });
    expect(() => mergeMbtiAnswerHistory(retained, 'user-b', [])).toThrow(
      /different user/,
    );
  });

  it('does not reuse answers from an older question-bank version', () => {
    const oldHistory = {
      ownerId: 'user-a',
      bankVersion: 'mbti-old-v0',
      answers: [{ questionId: 1, value: 2 }] as const,
    };
    expect(mergeMbtiAnswerHistory(oldHistory, 'user-a', []).answers).toEqual(
      [],
    );
  });
});
