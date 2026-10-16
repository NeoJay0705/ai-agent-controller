import { MBTI_DISCLAIMER, MBTI_QUESTIONS } from './mbti.js';
import type { BirthChartInput, NatalChartResult } from './natal.js';
import type { FlowBundle } from './types.js';
import { FlowRegistry } from './registry.js';
import type { MbtiAssessment, MbtiAnswer } from './mbti.js';
import type { InterpretationResult } from './types.js';

export const NATAL_DISCLAIMER =
  '星盤內容僅供娛樂與自我反思，不保證科學預測，也不是醫療、投資或重大決策建議。';

export interface FlowChoiceOption {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly name: string;
  readonly resultDescription: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly summary: string;
  }[];
}

export function getFlowChoiceOptions(
  bundle: FlowBundle,
  currentFlowId: string,
  currentNodeId: string,
  currentNext: Readonly<Record<string, string>>,
): readonly FlowChoiceOption[] {
  const registry = new FlowRegistry(bundle);
  return Object.keys(currentNext).flatMap((transition) => {
    const target = registry.getTarget(currentFlowId, currentNodeId, transition);
    if (target.flowId === currentFlowId) return [];
    const flow = registry.get(target.flowId);
    return flow === undefined
      ? []
      : [
          {
            id: flow.id,
            aliases: flow.aliases,
            name: flow.name,
            resultDescription: flow.resultDescription,
            nodes: flow.nodes.map((node) => ({
              id: node.id,
              kind: node.kind,
              summary: node.expectedResult,
            })),
          },
        ];
  });
}

export function renderChoicePrompt(
  options: readonly FlowChoiceOption[],
  suggestedFlow: string | null,
  jobId: string,
): string {
  const available = options
    .map(
      (option) =>
        `• ${option.id}${option.aliases.length === 0 ? '' : `（別名：${option.aliases.join('、')}）`} — ${option.name}：${option.resultDescription}\n  節點摘要：${option.nodes.map((node) => `${node.id}（${node.kind}）：${node.summary}`).join('；')}`,
    )
    .join('\n');
  const suggestion =
    suggestedFlow === null
      ? '目前沒有符合目標的已註冊能力。'
      : `參考建議：${suggestedFlow}。建議不會代替你的選擇。`;
  return [
    suggestion,
    available || '目前沒有可選的分析能力。',
    `請明確回覆 Flow ID 或別名。請回覆此 Telegram 訊息，或使用 /steer ${jobId} <選項>。`,
  ].join('\n');
}

export function renderUnsupported(): string {
  return '目前沒有符合目標的已註冊能力。請縮小目標後重新提出需求。';
}

export function renderChoiceRetry(
  options: readonly FlowChoiceOption[],
  jobId: string,
): string {
  return [
    '我無法確認你的明確選擇。請只回覆下列 Flow ID 或別名。',
    options
      .map(
        (option) =>
          `• ${option.id}${option.aliases.map((alias) => ` / ${alias}`).join('')}`,
      )
      .join('\n'),
    `請回覆此 Telegram 訊息，或使用 /steer ${jobId} <選項>。`,
  ].join('\n');
}

export function renderThirdPartyClarification(jobId: string): string {
  return [
    '第一版只保存你本人明確確認的資料。我不會把他人的答案或出生資料存成你的事實。',
    '如果你要繼續，請只提供你本人的資料；否則請另開新 Job。',
    `請回覆此 Telegram 訊息，或使用 /steer ${jobId} <內容>。`,
  ].join('\n');
}

export function renderMbtiQuestions(
  questions: readonly { readonly id: number; readonly statement: string }[],
  jobId: string,
): string {
  const list = questions
    .map((question) => `${String(question.id)}. ${question.statement}`)
    .join('\n');
  return [
    '以下是原創生活偏好題。請只回答你本人的情況。',
    list || '目前沒有缺少的題目。',
    '每題請用 -2、-1、0、1、2 或 null 作答。-2/2 表示較不同意/較同意，0 表中立，null 表示不知道。',
    '範例：1=2、2=0、3=null。一次最多回答四題。',
    MBTI_DISCLAIMER,
    `請回覆此 Telegram 訊息，或使用 /steer ${jobId} <題號=答案>。`,
  ].join('\n');
}

export function renderMbtiCandidate(
  answers: readonly MbtiAnswer[],
  jobId: string,
  conflicts: readonly {
    readonly questionId: number;
    readonly oldValue: MbtiAnswer['value'];
    readonly newValue: MbtiAnswer['value'];
  }[] = [],
): string {
  const rows = answers.map((answer) => {
    const question = MBTI_QUESTIONS.find(
      (item) => item.id === answer.questionId,
    );
    return `${String(answer.questionId)}. ${question?.statement ?? '題目資料無效'} — 候選答案：${String(answer.value)}`;
  });
  const conflictLines = conflicts.map(
    (item) =>
      `更正衝突 ${String(item.questionId)}：已確認 ${String(item.oldValue)}；本次候選 ${String(item.newValue)}。`,
  );
  return [
    '請先核對下列解析候選。這些內容尚未保存，也不是人格結果。',
    ...rows,
    ...conflictLines,
    '請確認這是你本人的答案。若正確，回覆「確認本人」；若不正確，請重新提供題號與答案。',
    `請回覆此 Telegram 訊息，或使用 /steer ${jobId} <確認本人或更正>。`,
  ].join('\n');
}

export function renderMbtiResult(
  assessment: MbtiAssessment,
  interpretation: InterpretationResult,
): string {
  const axes = assessment.axes
    .map(
      (axis) =>
        `${axis.axis}: ${axis.letter}（分數 ${String(axis.score)}；有效作答 ${String(axis.answeredCount)}/3）`,
    )
    .join('\n');
  const evidence = assessment.axes
    .flatMap((axis) =>
      axis.evidence.map(
        (item) =>
          `${String(item.questionId)}. ${item.statement} — ${String(item.value)}`,
      ),
    )
    .join('\n');
  const candidates = assessment.candidates.join('、');
  const sections = interpretation.sections
    .map((section) => `${section.title}\n${section.content}`)
    .join('\n\n');
  return [
    `本人 MBTI 自我反思結果：${assessment.type}`,
    `候選：${candidates}`,
    '逐軸結果：',
    axes,
    '逐題依據：',
    evidence || '沒有可用的非 null 作答依據。',
    interpretation.summary,
    sections,
    MBTI_DISCLAIMER,
  ].join('\n\n');
}

export function renderNatalMissing(
  missing: readonly string[],
  jobId: string,
): string {
  const fieldNames: Readonly<Record<string, string>> = {
    localDate: '出生日期（YYYY-MM-DD）',
    localTime: '出生當地時間（HH:mm；未知時間不能計算完整星盤）',
    latitude: '緯度（-66 至 66）',
    longitude: '經度（-180 至 180）',
    timeZone: 'IANA 時區（例如 Asia/Taipei）',
    utcOffsetMinutes: 'DST 重疊時使用的 UTC offset 分鐘數',
  };
  const fields = missing.map((key) => `• ${fieldNames[key] ?? key}`).join('\n');
  return [
    '請提供你本人的完整出生資料。只有城市名稱不足以定位；我不會查詢地名或猜測座標、時區與出生時間。',
    fields,
    '如果出生時間未知，第一版不能計算完整星盤。',
    `請回覆此 Telegram 訊息，或使用 /steer ${jobId} <出生資料>。`,
  ].join('\n');
}

export function renderNatalCandidate(
  candidate: Partial<BirthChartInput>,
  jobId: string,
  previous?: BirthChartInput,
): string {
  const lines = [
    `出生日期：${candidate.localDate ?? '缺少'}`,
    `出生當地時間：${candidate.localTime ?? '缺少'}`,
    `緯度：${String(candidate.latitude ?? '缺少')}`,
    `經度：${String(candidate.longitude ?? '缺少')}`,
    `IANA 時區：${candidate.timeZone ?? '缺少'}`,
    `UTC offset 分鐘：${String(candidate.utcOffsetMinutes ?? '未提供')}`,
  ];
  const conflict =
    previous === undefined
      ? []
      : [
          '已確認資料與本次候選不同。',
          `舊資料：${formatBirthInput(previous)}`,
          `新資料：${formatBirthInput(candidate)}`,
        ];
  return [
    '以下是出生資料候選。尚未保存，也尚未計算星盤。',
    ...lines,
    ...conflict,
    '請確認以上資料是你本人的出生資料。正確時回覆「確認本人」；若要更正，請直接提供新值。',
    `請回覆此 Telegram 訊息，或使用 /steer ${jobId} <確認本人或更正>。`,
  ].join('\n');
}

export function renderNatalValidationError(
  code: string,
  jobId: string,
): string {
  const messages: Readonly<Record<string, string>> = {
    INVALID_DATE: '出生日期不是有效曆日。請修正日期。',
    DATE_OUT_OF_RANGE: '出生年份必須介於 1900 至 2100。請修正日期。',
    TIME_REQUIRED: '必須提供明確出生時間。未知時間不能計算完整星盤。',
    INVALID_TIME: '出生時間格式無效。請使用 HH:mm。',
    INVALID_TIME_ZONE: 'IANA 時區無效。請提供有效時區名稱。',
    NONEXISTENT_LOCAL_TIME:
      '這個當地時間因時區轉換而不存在。請核對日期、時間與時區。',
    AMBIGUOUS_LOCAL_TIME: '這個當地時間有 DST 重疊。請補充 UTC offset 分鐘數。',
    UTC_OFFSET_MISMATCH: 'UTC offset 與該時區的出生時間不符。請修正資料。',
    INVALID_LATITUDE: '緯度必須介於 -66 至 66。',
    INVALID_LONGITUDE: '經度必須介於 -180 至 180。',
    INVALID_UTC_OFFSET: 'UTC offset 必須是有效的整數分鐘數。',
  };
  return `${messages[code] ?? '出生資料無法驗證。請核對並重新提供。'}\n請回覆此 Telegram 訊息，或使用 /steer ${jobId} <修正資料>。`;
}

export function renderNatalChart(
  chart: NatalChartResult,
  interpretation: InterpretationResult,
): string {
  const planets = chart.planets
    .map(
      (planet) =>
        `${planet.body}: ${planet.longitude.toFixed(4)}° ${planet.sign}，第 ${String(planet.house)} 宮`,
    )
    .join('\n');
  const cusps = chart.houseCusps
    .map(
      (cusp, index) =>
        `第 ${String(index + 1)} 宮：${cusp.longitude.toFixed(4)}° ${cusp.sign}`,
    )
    .join('\n');
  const aspects =
    chart.aspects.length === 0
      ? '無符合 orb 範圍的主要相位。'
      : chart.aspects
          .map(
            (aspect) =>
              `${aspect.first} ${aspect.aspect} ${aspect.second}（${aspect.orbDegrees.toFixed(2)}° orb）`,
          )
          .join('\n');
  const sections = interpretation.sections
    .map((section) => `${section.title}\n${section.content}`)
    .join('\n\n');
  return [
    '出生星盤計算結果',
    `輸入：${formatBirthInput(chart.input)}`,
    `UTC：${chart.utcDate}`,
    `方法：${chart.method.version}；${chart.method.engine} ${chart.method.engineVersion}；${chart.method.coordinates}；${chart.method.zodiac} zodiac；${chart.method.houses} houses。`,
    `Sun 至 Pluto 行星位置：\n${planets}`,
    `Ascendant：${chart.ascendant.longitude.toFixed(4)}° ${chart.ascendant.sign}`,
    `MC：${chart.midheaven.longitude.toFixed(4)}° ${chart.midheaven.sign}`,
    `十二宮 cusp：\n${cusps}`,
    `主要相位：\n${aspects}`,
    interpretation.summary,
    sections,
    NATAL_DISCLAIMER,
  ].join('\n\n');
}

function formatBirthInput(input: Partial<BirthChartInput>): string {
  return [
    `${input.localDate ?? '缺少日期'} ${input.localTime ?? '缺少時間'}`,
    `lat ${String(input.latitude ?? '缺少')}`,
    `lon ${String(input.longitude ?? '缺少')}`,
    `zone ${input.timeZone ?? '缺少'}`,
    `offset ${String(input.utcOffsetMinutes ?? '未提供')}`,
  ].join(' | ');
}
