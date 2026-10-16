import { CONTRACT_OUTPUT_LIMITS } from './types.js';
import type { FlowContractId, NodeDefinition } from './types.js';

export interface AgentResponseJsonSchema {
  readonly type: 'object';
  readonly additionalProperties: false;
  readonly required: readonly ['transition', 'result'];
  readonly properties: Readonly<Record<string, unknown>>;
}

const FLOW_ID_PATTERN = '^[a-z][a-z0-9_-]{0,63}$';

export function createAgentResponseJsonSchema(
  node: NodeDefinition,
  maxOutputChars: number,
): AgentResponseJsonSchema {
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new TypeError('Agent response output limit is invalid.');
  }
  const contract = node.resultContract;
  if (!isFlowContractId(contract)) {
    throw new TypeError('Agent response contract is not registered.');
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['transition', 'result'],
    properties: {
      transition: {
        type: 'string',
        enum: Object.keys(node.next).sort(),
      },
      result: payloadSchema(contract),
      text: { type: 'string', maxLength: maxOutputChars },
    },
  };
}

export function createAgentResultContractPrompt(
  node: NodeDefinition,
  maxOutputChars: number,
): string {
  const schema = createAgentResponseJsonSchema(node, maxOutputChars);
  const contract = node.resultContract;
  if (!isFlowContractId(contract)) {
    throw new TypeError('Agent response contract is not registered.');
  }
  const notes = [
    'Host response protocol:',
    '回覆必須是完整的 {transition,result,text?} JSON object。contract 名稱與 expectedResult 描述的是 result 內的 payload，不是 top-level 格式。transition 只可選 schema enum。不要 Markdown code fence，不要 JSON 前後說明或單獨 payload。不得把舊 history 中的輸出格式當成當前契約。',
    `總輸出，以及 result 與 text 的合計，仍受 host 字元上限 ${String(maxOutputChars)} 限制。JSON Schema 是提供給模型的提示資料，不是新的 validator，也不取代 Server CAS、graph 或 membership 檢查。`,
    ...contractNotes(contract),
    'Current response JSON Schema:',
    JSON.stringify(schema),
  ];
  return notes.join('\n');
}

function payloadSchema(contract: FlowContractId): Record<string, unknown> {
  switch (contract) {
    case 'recommendation':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['suggestedFlow'],
        properties: {
          suggestedFlow: {
            anyOf: [
              { type: 'string', pattern: FLOW_ID_PATTERN },
              { type: 'null' },
            ],
          },
        },
      };
    case 'mbti_answers':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['answers'],
        properties: {
          answers: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['questionId', 'value'],
              properties: {
                questionId: { type: 'integer', minimum: 1, maximum: 12 },
                value: { enum: [-2, -1, 0, 1, 2, null] },
              },
            },
          },
        },
      };
    case 'birth_input':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          localDate: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          localTime: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
            pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
          },
          timeZone: { type: 'string', minLength: 1, maxLength: 128 },
          latitude: { type: 'number', minimum: -66, maximum: 66 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          utcOffsetMinutes: {
            type: 'integer',
            minimum: -840,
            maximum: 840,
          },
        },
      };
    case 'interpretation':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'sections'],
        properties: {
          summary: {
            type: 'string',
            minLength: 1,
            maxLength: CONTRACT_OUTPUT_LIMITS.summary,
          },
          sections: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'content'],
              properties: {
                title: {
                  type: 'string',
                  minLength: 1,
                  maxLength: CONTRACT_OUTPUT_LIMITS.sectionTitle,
                },
                content: {
                  type: 'string',
                  minLength: 1,
                  maxLength: CONTRACT_OUTPUT_LIMITS.sectionContent,
                },
              },
            },
          },
        },
      };
  }
}

function contractNotes(contract: FlowContractId): string[] {
  switch (contract) {
    case 'recommendation':
      return [
        `recommendation 的 suggestedFlow 非 null 時，只可使用當次 businessFlows 中已註冊的 Flow ID（格式 ${FLOW_ID_PATTERN}）；推薦不是本人授權。`,
      ];
    case 'mbti_answers':
      return [
        'mbti_answers 的 answers 不可重複 questionId，而且 questionId 必須是 host 已提問的題目 ID。Schema 不會表達或執行這兩項上下文檢查。',
      ];
    case 'birth_input':
      return [
        'birth_input 的缺少欄位必須省略，不要補 null。localDate 使用 YYYY-MM-DD 格式，localTime 使用 HH:mm 格式；latitude 範圍為 -66 至 66，longitude 範圍為 -180 至 180，utcOffsetMinutes 是 -840 至 840 的整數分鐘。數值 0 是有效值。',
      ];
    case 'interpretation':
      return [
        `interpretation 的 summary 長度上限為 ${String(CONTRACT_OUTPUT_LIMITS.summary)}；sections 的 title 長度上限為 ${String(CONTRACT_OUTPUT_LIMITS.sectionTitle)}，content 長度上限為 ${String(CONTRACT_OUTPUT_LIMITS.sectionContent)}。`,
      ];
  }
}

function isFlowContractId(value: string | null): value is FlowContractId {
  return (
    value === 'recommendation' ||
    value === 'mbti_answers' ||
    value === 'birth_input' ||
    value === 'interpretation'
  );
}
