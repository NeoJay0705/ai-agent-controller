import { describe, expect, it } from 'vitest';

import { createFlowBundle } from '../../src/flow/definitions.js';
import {
  getFlowChoiceOptions,
  renderChoicePrompt,
  renderMbtiCandidate,
  renderMbtiQuestions,
  renderNatalChart,
  renderNatalMissing,
  renderNatalValidationError,
} from '../../src/flow/presentation.js';
import { MBTI_QUESTIONS } from '../../src/flow/mbti.js';
import { calculateNatalChart } from '../../src/flow/natal.js';
import type {
  FlowBundle,
  FlowLimits,
  FlowRuntime,
} from '../../src/flow/types.js';

const runtime: FlowRuntime = {
  provider: 'openai',
  model: 'gpt-6-luna',
  thinking: 'max',
  apiKeyEnv: null,
};
const limits: FlowLimits = {
  nodeTimeoutMs: 1_000,
  waitTimeoutMs: 10_000,
  jobTimeoutMs: 20_000,
  maxTransitions: 20,
  maxRetries: 0,
  maxModelTurns: 5,
  maxToolCalls: 1,
  maxOutputChars: 10_000,
};
const bundle: FlowBundle = createFlowBundle({
  runtimes: { intake: runtime, mbti: runtime, natal: runtime },
  limits: { intake: limits, mbti: limits, natal: limits },
});

describe('Telegram-safe Flow presentation', () => {
  it('derives choices from pinned graph targets and shows no Agent rationale', () => {
    const choiceFlow = bundle.flows.find((flow) =>
      flow.nodes.some((node) => node.handler === 'choice'),
    );
    const choice = choiceFlow?.nodes.find((node) => node.handler === 'choice');
    if (choiceFlow === undefined || choice === undefined) {
      throw new Error('Missing choice Node.');
    }
    const options = getFlowChoiceOptions(
      bundle,
      choiceFlow.id,
      choice.id,
      choice.next,
    );
    expect(options.map((option) => option.id)).toEqual(['mbti', 'natal']);
    const prompt = renderChoicePrompt(options, 'mbti', 'job_1');
    expect(prompt).toContain('MBTI 提問推估');
    expect(prompt).toContain('出生星盤');
    expect(prompt).toContain('節點摘要');
    expect(prompt).toContain('parse_answers');
    expect(prompt).toContain('parse_birth');
    expect(prompt).toContain('參考建議：mbti');
    expect(prompt).toContain('建議不會代替你的選擇');
    expect(prompt).toContain('回覆此 Telegram 訊息');
    expect(prompt).toContain('/steer job_1');
    expect(prompt).not.toContain('recommendation reason');
  });

  it('renders at most four fixed MBTI questions with valid answer guidance and本人 confirmation', () => {
    const prompt = renderMbtiQuestions(MBTI_QUESTIONS.slice(0, 4), 'job_2');
    expect(prompt).toContain('1.');
    expect(prompt).toContain('-2、-1、0、1、2 或 null');
    expect(prompt).toContain('範例：1=2、2=0、3=null');
    expect(prompt).toContain('只回答你本人的情況');
    expect(prompt).toContain('/steer job_2');
    const candidate = renderMbtiCandidate(
      [{ questionId: 1, value: 2 }],
      'job_2',
      [{ questionId: 1, oldValue: 1, newValue: 2 }],
    );
    expect(candidate).toContain('已確認 1');
    expect(candidate).toContain('候選 2');
    expect(candidate).toContain('確認本人');
    expect(candidate).toContain('尚未保存');
  });

  it('asks for missing natal fields and produces complete non-truncated result sections', () => {
    const prompt = renderNatalMissing(
      ['latitude', 'longitude', 'timeZone', 'localTime'],
      'job_3',
    );
    expect(prompt).toContain('只有城市名稱不足');
    expect(prompt).toContain('未知時間不能計算完整星盤');
    expect(prompt).toContain('IANA 時區');
    expect(prompt).toContain('/steer job_3');
    expect(
      renderNatalValidationError('AMBIGUOUS_LOCAL_TIME', 'job_3'),
    ).toContain('UTC offset');

    const chart = calculateNatalChart({
      localDate: '2000-01-01',
      localTime: '12:00',
      latitude: 0,
      longitude: 0,
      timeZone: 'UTC',
    });
    const result = renderNatalChart(chart, {
      summary: '合成解讀。',
      sections: [{ title: '反思', content: '合成內容。' }],
    });
    expect(result).toContain(chart.utcDate);
    expect(result).toContain('Sun:');
    expect(result).toContain('Pluto:');
    expect(result).toContain('Ascendant');
    expect(result).toContain('MC');
    expect(result).toContain('第 12 宮');
    expect(result).toContain('主要相位');
    expect(result).toContain('不保證科學預測');
  });
});
