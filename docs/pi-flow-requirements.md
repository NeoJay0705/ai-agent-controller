# Pi Flow 狀態機任務控制器 — 需求規格

- **文件狀態：** 第一階段需求基準。第二階段已實作 FlowStore 與 schema v1→v2 migration。第三階段加入固定版本 Pi CLI JSONL/RPC child-process adapter。第四階段加入本機 FlowExecutor、FlowRunner、原子 safe-point persistence 與純文字 presentation。第五階段已接線 production server、ControllerService、TelegramRouter、FlowRunner／Executor、Pi CLI runtime 與 outbox sender。第六階段定義沿用明確 Pi OAuth 登入來源，並維持 Flow child 執行環境隔離。自動測試使用 synthetic credential、模擬 Telegram 和 fake runtime；離線 CLI smoke 不送 prompt。真實 provider request、真實 Telegram 與部署仍未驗證。
- **目標：** Pi Flow 狀態機任務控制器。
- **背景：** [Telegram 多 Session 控制器需求](telegram-controller-requirements.md) 與[架構設計](telegram-controller-design.md)維持原狀，作為既有 Router、Session 分區、FIFO、直接 `/status` 與 Telegram 行為的背景。
- **設計：** [Pi Flow 架構設計](pi-flow-design.md)。

本文定義 Pi Flow 第一版的需求與可驗收條件。`MUST` 表示必須符合。文件列出設計基準，不代表尚未執行的整合或部署已通過。

## 1. 產品目標與範圍

第一版提供兩項分析能力：原創 MBTI 提問推估，以及出生星盤。Controller 保留既有單一授權 private chat、Controller Session 分區、Session 內 FIFO 排程和直接狀態查詢。Pi Flow 將 Agent 工作建模為具版本的有限狀態機。

### 1.1 第一版範圍

- 使用者先描述目標。Agent 只建議可用 Flow、呈現能力摘要與可選項，以及說明如何明確選擇。Agent 不說明推薦理由。
- 使用者明確選擇 Flow 後，系統才收集或驗證參數，並開始分析。
- 支援 MBTI 原創生活偏好題與出生星盤離線計算。
- 同一 Controller Session 共用一份持久 Pi 對話歷史。不同 Controller Session 的歷史完全隔離。
- 同一 Controller Session 的 Job 維持 FIFO。使用中的 Pi 歷史不可被兩個 Job 並行操作。
- 只有出生星盤 Flow 可宣告 `calculate_natal_chart`。第一版沒有其他通用工具、Extensions、MCP 或資源探索。

### 1.2 不在第一版範圍

- 任意程式碼、Shell、網路地名定位、檔案／附件處理、通用工具、Extension、MCP、資源探索或工具搜尋。
- 未明確選擇 Flow 就分析或驗證業務參數。
- 不支援目標的 restricted fallback、隱含模型、無上限執行或 Pi 自帶預設工具。
- 群組、多人授權、第二個通訊平台、水平擴展或多程序共享一份 Pi Session。
- 第三、四階段的交付範圍當時不接線 production Controller／runner／router／server；不發出模型 prompt 或 Telegram 請求；不操作真實資料庫或部署。這是初期階段限制，不是最終產品禁止 wiring。第五階段已加入 production wiring，詳見本文件第 8 節。

第二階段新增 `src/flow/store.ts` 與 SQLite schema v1→v2 additive migration。第三階段以 `src/flow/pi-rpc-runtime.ts`、固定版本 Pi CLI JSONL/RPC child process 和 host guard extension 取代 SDK runtime。第四階段新增 `src/flow/execution-types.ts`、`src/flow/executor.ts`、`src/flow/runner.ts` 與 `src/flow/presentation.ts`，並擴充 `FlowStore` safe-point 操作。Fake-child 測試只使用合成 credential；第四階段使用 fake runtime 和合成 SQLite。Real-CLI smoke 以 source guard、build dist guard 驗證離線 metadata、RPC state、工具 metadata、session name 與 synthetic history reopen；不送 prompt。第五階段由 `src/server.ts`、`src/controller/service.ts`、`src/controller/router.ts` 接線 production Flow lifecycle，細節見第 8 節。自動整合測試與 CLI smoke 仍不代表真實 provider request 或 Telegram 已驗證。

## 2. 使用者、Session 與 Job

### PF-REQ-001 — 授權與既有 Controller 契約

- 延續既有 Controller 的單一授權 private chat 規則。不得擴大授權範圍。
- Controller Session 仍是 Session 分區。每 Session 的 Job 依既有 FIFO 執行。
- `/status` 仍直接讀取 Controller 持久狀態。查詢不得建立 Job，也不得呼叫 Pi。
- 同一 Controller Session 的所有 Job 共用一份 Pi 歷史。不同 Controller Session 的歷史不得混用。
- 同 Session 的 Pi Job 不可並行。Job 在等待使用者輸入時保留 Session partition，但不占用全域執行 slot。

### PF-REQ-002 — 先建議、再明確選擇

- 使用者目標先進入內部 `intake` Flow。
- Intake 僅可呈現已註冊 Flow 的能力、節點摘要、建議選項及明確選擇方式。不得說明推薦理由。
- 建議不是授權。使用者必須明確選擇 `mbti` 或 `natal`，系統才可驗證該 Flow 的參數或開始分析。
- Host／Server 控制節點負責接受使用者選擇。Agent 不可代替使用者選擇或改變控制圖。
- 沒有適用 Flow 時，只回報能力缺口並請使用者縮小目標。不得改跑其他 Flow、通用聊天或 restricted fallback。

### PF-REQ-003 — 歷史事實與來源

- 可沿用同一 Controller Session 中，由本人明確提供且適用於當次 Flow 的資料。
- 當次明確提供的資料優先於歷史資料。
- 歷史資料與當次資料衝突時，系統必須先詢問澄清，不得自行選值。
- 模型推測、模型摘要或第三方資料不得當作本人已確認的事實。
- 不同 Controller Session 或其他使用者的資料不得合併。

## 3. Flow 宣告與安全邊界

### PF-REQ-004 — Declarative Flow 與版本

每個 Flow 定義包含 `id`、`version`、`name`、`resultDescription`、`aliases`、`runtime`、`limits`、`entryNode` 和 `nodes`。每個 Node 包含 `id`、`kind`、`systemPrompt`、`prompt`、`expectedResult`、`resultContract`、`next` 與 `tools`；Node 可明確覆寫 runtime 或 Flow limits。

- Registry 只接受受信任的 declarative definitions，以及已註冊的 validator／tool 名稱。不得從定義載入或執行任意程式。
- Flow runtime 必須明確提供 `provider`、`model`、`thinking` 與 `apiKeyEnv`，可選 `auth.mode` 為 `api-key` 或 `pi-login`。省略 `auth` 維持舊 API-key-only 解讀。`api-key` 必須指定環境變數名稱；`pi-login` 必須設 `apiKeyEnv: null`。不得存 key 值，也不得在模式間 fallback。Thinking 只可為 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。
- 每個 Flow 必須宣告完整 limits：`nodeTimeoutMs`、`waitTimeoutMs`、`jobTimeoutMs`、`maxTransitions`、`maxRetries`、`maxModelTurns`、`maxToolCalls`、`maxOutputChars`。
- Limits 必須是 safe bounded integers。`maxRetries` 與 `maxToolCalls` 可為 0；其餘必須大於 0。缺少 runtime 或必要 limits 時必須 fail closed，不得依賴 SDK defaults。
- Node 可明確覆寫 Flow limits。沒有覆寫時只使用該 Flow 已宣告的限制。Agent Node 可明確覆寫 runtime；沒有覆寫時只使用該 Flow runtime。
- 工具清單缺省為 `[]`。拒絕未知 Node、transition、tool、result contract、重複 ID、無法到達的 Node、無可達 terminal、超限設定與未設執行上限的循環。
- JSON 設定只接受嚴格 JSON。拒絕 unknown fields、秘密值、`!shell` 內容與超過 256 KiB 的設定。不讀檔、不展開環境變數、不 `eval`。
- 每個 Job 固定使用啟動時取得的 Flow version 與內容 snapshot。既有 Job 不因重新載入或新版本而改變；不支援熱更新。

### PF-REQ-005 — Agent、Server 與工具權限

- Server 驗證 Agent 輸出、result contract、轉移及所有權。Agent 不得修改圖、選擇未宣告轉移或提升權限。
- Agent 輸出必須是嚴格 JSON 結構。不可從自然語言猜測 transition。須驗證欄位、shape、有限數字與輸出大小。
- Server 控制節點只做選擇、提問、評分、計算及驗證，不呼叫隱含模型。
- Pi 與 Extension 都不是 sandbox。第一版不載入 Extension、MCP、通用工具或 resource discovery。
- `calculate_natal_chart` 是第一版唯一可註冊工具。所有直接或間接呼叫都必須在當前 Node 的 `tools` 宣告內；未宣告的呼叫一律拒絕。
- 工具能力不可由模型輸出、提示內容、歷史或使用者輸入擴大。

### PF-REQ-006 — Runtime result contract

Pi adapter 的介面為：

```ts
AgentRuntime.run({
  controllerSessionId,
  jobId,
  node,
  definition,
  input,
  state,
  historyFacts,
  signal,
}): Promise<AgentNodeResult>;
AgentRuntime.dispose(): Promise<void>;
```

`AgentNodeResult` 是結構化 JSON，包含宣告過的 transition 和結果資料；文字不能代替 transition。第一版固定契約為：

- `recommendation`：`suggestedFlow: string | null`。非 null 值必須符合 Registry 的 Flow ID regex `^[a-z][a-z0-9_-]{0,63}$`。純契約驗證只檢查格式，不代表該 ID 已註冊。`FlowStore.commitFlowStep()` 必須在資料寫入前依 Job pinned 的 FlowBundle 驗證 membership；拒絕不存在的 ID 與 `intake`，不得轉移或 fallback。合法註冊的 custom Flow 可作為建議。
- `mbti_answers`：題目 `questionId` 與 `value: -2 | -1 | 0 | 1 | 2 | null`。
- `birth_input`：出生輸入欄位，只能包含使用者明確提供的值；不得猜日期、時間、座標或時區。
- `interpretation`：固定欄位 `summary` 與 `sections`，每一 section 只包含 `title` 與 `content`。未知欄位必須拒絕。

`src/flow/pi-rpc-runtime.ts` 實作此介面。`api-key` 模式只從 `apiKeyEnv` 指定的環境變數名稱讀取 credential；`pi-login` 模式只讀取 `PI_FLOW_AUTH_FILE` 明確指定的來源，沒有 API-key fallback。Runtime 只解析本地安裝的 `@earendil-works/pi-coding-agent@1.2.0` CLI entry。固定 wrapper 以 `shell: false` 啟動 CLI。Runtime 只傳入明確 allowlist 的參數與子程序環境。它不載入 SDK Agent runtime，也沒有 SDK fallback。

Runtime 為每個 Controller Session 建立私有 0700 工作目錄、0600 settings／prompt／guard 檔案與獨立 HOME／XDG 目錄。Pi JSONL history 依 `pi_sessions` identity 重開，並驗證路徑、symlink、權限和 v3 header。遺失或無效的映射必須 fail closed，不建立替代歷史。

Guard config path 由 Runtime 明確設為 child-only `PI_FLOW_GUARD_CONFIG` absolute path。不可從 parent ambient env 複製同名變數，也不可用 `registerFlag()`／`getFlag()` 傳遞。Pi 1.2.0 在 extension factory 完成後才套用 parsed extension flag values，因此 factory 內讀不到該 flag。Pi 原生 system prompt 必須保留。Controller 共用規則與 Node 指令分別以重複的 `--append-system-prompt` 附加，順序固定為「Pi 原生 system prompt → Controller 共用規則 → Node 指令」。不得以 `--system-prompt` 覆蓋。本版沒有覆蓋需求或覆蓋選項；只有未來有明確需求並經設計確認，才可考慮覆蓋。保留 Pi 原生 prompt 不會新增工具權限；工具預設仍為 none，實際工具仍由 Node 宣告與 host guard 限制。Pi 原生 prompt 也不構成 sandbox。

History 是 host resource，不是 context-token limit。Baseline 與 post-run JSONL 檔案各自上限為 `MAX_PI_HISTORY_BYTES = 32 * 1024 * 1024`。Runtime 必須以 `O_NOFOLLOW`、regular-file metadata 與 bounded `limit + 1` read，驗證完整 bytes、fatal UTF-8、每行 plain JSON record、v3 header、session ID、cwd 與 no-credential；baseline invalid 時不得 spawn 或暗中修復。合法 Pi entry 的 type 不限於本程式定義的 schema。

Baseline exact bytes 只存於記憶體，不寫 disk backup。Provider failure、timeout、cancel 或 invalid result 後，若 post-run history 合法且無 credential，必須保留安全 entries。只有 credential leak、corruption 或 oversize 才能在 child close/join 後使用同 Session directory 隨機 exclusive 0600 暫存檔、fsync 與 atomic rename 還原 exact baseline。操作前重驗 canonical Session directory 和非 escaping target；restore 後重驗 header、cwd、credential 與 0600。Restore 失敗回報 `FLOW_HISTORY_INVALID`；成功 restore 仍回報原 stable failure。Oversize baseline 回報 `FLOW_HISTORY_LIMIT` 並拒絕新 run，不截斷歷史。Operator 可受控管理歷史或改用新 Controller Session；本版不實作自動 retention／compaction。安全 history 不等於 DB-validated 或 user-confirmed fact。

Runtime 只允許固定 JSONL/RPC command 與 event 子集。唯讀 history command 僅有 `get_entries` 與 `get_messages`。Host guard extension 必須以隨機 nonce 握手。Runtime 驗證實際 provider、model、thinking、active tool names 與 registered tool metadata、session、history、session name、自動 compaction 狀態和 available thinking levels。Credential 只注入當次 provider 的 allowlisted key 環境變數。Runtime 關閉 built-in tools、MCP、其他 Extension、skills、prompt templates、themes 和 context files。唯一可用工具為當前 Node 宣告的 `calculate_natal_chart`。

逾時、取消、model／thinking 不符、未宣告 tool、retry／compaction event、超限或 malformed RPC 一律以穩定錯誤分類停止。Runtime 先清除 queue，再 abort，最後等待 child process 結束；必要時送 SIGTERM／SIGKILL。不得換 model、降低 thinking 或輸出原始 child stderr／provider error。Fake-child 測試不得發出模型 request。獨立 real-CLI smoke 使用 `PI_OFFLINE=1` 和 synthetic `FLOW_TEST_API_KEY`，只送 metadata RPC，不送 prompt。

## 4. Controller 啟動、重啟與輸入時間界線

### PF-REQ-007 — READY 與離線輸入

- Controller READY 之前收到的 Telegram request 不得建立 Job、呼叫 Agent 或進行分析。
- Controller 啟動時計算下一個整數 UTC 秒 `readyAtSec = floor(nowMs / 1000) + 1`。在該秒之前維持不接受狀態。
- Telegram `message.date < readyAtSec` 時，跳過訊息，並在同一 SQLite 交易推進 update offset。
- `message.date >= readyAtSec` 時才可接受該訊息。
- 缺少或無法驗證 `message.date` 的 update 必須跳過，寫入分類 log，並在同一交易推進 offset。此路徑不得讀取訊息內容。
- READY 通知必須告知使用者重送啟動期間的訊息。HTTP `/health` 仍只代表 liveness，不代表 READY。
- Telegram 日期只有秒精度。時鐘偏差不保證可完全消除；部署環境必須同步系統時間。

### PF-REQ-008 — Restart recovery

Controller restart 時必須：

- 將所有 `QUEUED`、`RUNNING` 與 `WAITING_INPUT` Job 結束為 `FAILED`，failure code 為 `SERVER_RESTART`。
- 將該 Job 所有 pending steering 標為 `not_applied`，並使舊 prompt inactive。
- 取消尚未送出的舊提問；取消不是 Telegram delivery failure。
- 保留 Pi 歷史與已完成結果。
- 繼續送出其他有效通知，並補入 restart failure 通知。
- 不把已送達的舊提問當作新問題，也不讓舊 prompt 的回覆啟動 Job。

## 5. MBTI 提問推估

### PF-REQ-009 — 原創題庫、評分與歷史

- 題庫固定 12 題，每軸 3 題。題目文字與 1–12 IDs 固定，題目為原創生活偏好，不使用官方付費題庫。
- 回答值為 `-2` 至 `2` 的整數；`0` 表中立；`null` 表示不知道。
- 正分依序對應 E、S、T、J；負分依序對應 I、N、F、P。
- 每軸至少 2 個非 null 答案，且 `abs(sum) >= 2`，才可判定該軸字母。否則輸出 `?`。
- 結果列出回答依據，不產生虛構 confidence 數值。未定軸可保留 `?`；候選最多 16 種，不可硬定。
- 每次最多問 4 題。只問缺答或明確要求澄清的題目。
- 只有 bankVersion 相同、且歸屬同一使用者的答案可沿用。改動既有答案須有明確澄清。其他使用者的資料不得混入。
- 完整 12 題可包含 `null`，仍可完成並明示不確定性。
- 嚴格拒絕未知題目 ID、重複 ID、非整數／超範圍答案與未授權來源資料。
- 提問和結果必須含非官方、自我反思、非心理診斷聲明。

## 6. 出生星盤

### PF-REQ-010 — 明確出生資料與離線計算

- 必要輸入：`localDate` (`YYYY-MM-DD`)、`localTime` (`HH:mm`)、`latitude`、`longitude`、`timeZone` (IANA)。`utcOffsetMinutes` 可選，只用來解決 DST 重疊。
- 接受年份 1900–2100 的有效曆日。拒絕日期 overflow、無效時刻、未知 IANA zone、座標非有限值、緯度低於 -66 或高於 66、經度超出 [-180, 180]。
- 使用 `Intl` 解析時區。從目標前後 48 小時以 6 小時間隔取樣時區 offset 秒，再建立候選 UTC。每個候選都必須 round-trip 回相同年月日時分。
- DST 不存在的 local time 必須拒絕。DST 重疊時，沒有 `utcOffsetMinutes` 必須要求澄清；提供 offset 時只接受相符候選。不得使用 server local time zone 或固定假設台灣時區。
- 地點以座標加 IANA 時區提供。不得網路定位城市。只有城市名時，必須要求使用者補座標與時區。
- 出生時間未知時，第一版不提供完整星盤，也不得假設時間後計算。
- 使用 MIT `astronomy-engine` 離線計算。對 Sun、Moon、Mercury、Venus、Mars、Jupiter、Saturn、Uranus、Neptune、Pluto，以 `GeoVector(body, time, true)` 和 `Ecliptic` 計算 geocentric apparent tropical ecliptic-of-date longitude。
- Ascendant／MC 依核准公式與東方 rising 解計算。House 使用 equal-house；十二宮每宮 30 度；行星 house 由相對 Ascendant 的經度計算。MC 不必位於第十宮。
- 計算 conjunction 0°、sextile 60°、square 90°、trine 120°、opposition 180°；orb 上限 6°，每組行星只列一次。
- 結果包含原始輸入、UTC 日期、方法／版本、熱帶黃道與 equal-house 設定、10 個行星經度／星座／宮位、Ascendant、MC、12 宮 cusp 與 aspects。所有數值必須有限。
- 星座名稱固定。結果是娛樂與自我反思，不保證科學預測，不提供醫療、投資或其他重大決策建議。

### PF-REQ-011 — Host-controlled 本機 Flow execution

- `FlowExecutor` 必須讀取 pinned Flow snapshot，使用 versioned plain-data host state，並只將 Agent result 當作待驗證候選。Server handler 負責選擇、提問、資料驗證、計分、星盤計算、確認、facts provenance 與 terminal outcome。
- 持久輸入 checkpoint 必須以 revision、node、pending steering ID／sequence 驗證。只套用捕獲到且未跳過的 pending prefix；state、source references、steering 狀態、revision 和 transition 必須在同一交易成功或 rollback。
- Agent analyze 收到 pending steering 時，必須丟棄舊 interpretation/chart，並只依 pinned graph 宣告的 `revise` transition 前進。Terminal commit 若仍有 pending steering，不可完成 Job。
- Wait 必須留在目前非 terminal Server Node，原子更新 prompt generation、outbox prompt 與 `WAITING_INPUT`；wait deadline 不可超過 Job deadline。過期 Job 必須以穩定 `TIMEOUT` 終止。
- `FlowRunner` 必須按 Controller Session partition 和 FIFO 管理 worker slot。等待使用者輸入的 Job 不占 slot，但仍阻止同 Session 後續 Job。Stop 必須 abort workers、等待 executor join，再 dispose runtime。
- Retry 只可由明確 `FLOW_MODEL_REQUEST_FAILED` 且在 Node `maxRetries` 內觸發。未知 child exit、結果錯誤或其他 failure 不得自動重送。
- FlowExecutor、FlowRunner 與純文字 presentation 必須可用 fake runtime／synthetic data 測試。這些測試本身不證明 production wiring、真實 Pi provider request 或 Telegram E2E；production wiring 另依 AT-PF-18 驗收。

### PF-REQ-012 — 沿用 Pi 登入與 Flow 執行隔離

- 每個 effective Agent Node 的 runtime 明確選擇 `api-key` 或 `pi-login`。省略 `auth` 維持舊 API-key-only 行為。兩種模式不互相 fallback。API-key Node override 覆蓋 Flow runtime；只有任一 effective Agent Node 仍為 `pi-login` 時才要求來源設定。
- Bot mode 可選讀取 `PI_FLOW_AUTH_FILE`。相對路徑依 `parseControllerConfig` 的 cwd 解析，正規化為 lexical absolute path；不展開 `~`、`$HOME`，不自動尋找個人 Pi 目錄。health mode 不讀取此變數。
- `PI_FLOW_AUTH_FILE` 不得位於本 Controller 的 `dataDir/pi` 本身或其私有 Session subtree，避免 snapshot cleanup 刪除或覆寫來源；其他 `dataDir` 路徑不受此限制。
- 若 bundle 中任一 effective Agent runtime 使用 `pi-login`，`PI_FLOW_AUTH_FILE` 必須是非空 canonical absolute path。Server 在建立 app、SQLite resources 或 listener 前拒絕缺少設定。ControllerService 在建立 Registry／FlowStore 前再次驗證；test-only runtime injection 不得跳過。
- 只有 Agent Node 執行時才讀來源檔。來源必須是已存在、regular、0600、同 UID、無 symlink 的檔案；來源路徑及 parent 必須 canonical，且可更新來源與建立 Pi 原生鎖。Controller 不自動 chmod、登入或修復檔案。來源錯誤只回固定安全碼，不回顯路徑或底層例外。
- Pi OAuth 需保留足夠 token validity，涵蓋 Agent Node timeout、Pi 原生五分鐘 refresh window 和 startup margin。取消在鎖等待期間可停止等待；Pi 開始 refresh 後必須等待旋轉結果寫回、解鎖，再回報 Job failure。Timeout、dispose、external abort 不可丟棄已旋轉的單次 refresh token。
- Source auth file 使用 `@earendil-works/pi-coding-agent@1.2.0` 的 native `FileAuthStorageBackend` file lock；provider OAuth resolver 來自 `@earendil-works/pi-ai@1.2.0`。這些是 pinned、版本特定的 internal interface，不是 SDK Agent runtime，不保證相容任意 Pi 版本或不使用同鎖的外部 writer。
- Child 只取得當次 provider 的短期 access token 和必要 metadata。Child snapshot 的 refresh token 為空，且不含來源路徑。Runtime 在 child join 後清理 snapshot；crash 遺留檔在下一次使用前處理。Flow 不共用個人 history、settings、models、extensions、MCP、skills、prompts、themes、AGENTS、SYSTEM、HOME、XDG 或 workspace。隔離不是 OS sandbox；同帳號／root 權限及記憶體殘留仍是限制。
- OAuth refresh 可能寫回原 `auth.json` 中當次 provider。其他 provider JSON 值保留，但整份 JSON 可能重新排版。來源與 parent 必須可寫。READY 只表示 Controller readiness，不保證 OAuth 或 provider 可用。登入失效時 Job 安全失敗；重新登入或修設定後需建立新 Job。

## 7. 可驗收條件

下列條件涵蓋第一階段基準與後續階段新增驗收項目。測試證據只在實際執行指定測試後成立。

| ID       | 可驗收條件                                                                                                           | 需求            | 主要測試                        |
| -------- | -------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------- |
| AT-PF-01 | 文件涵蓋既有 Controller 邊界、雙 Flow、選擇與 restart 規則，並區分未驗證項目。                                       | PF-REQ-001–008  | 文件檢視                        |
| AT-PF-02 | Registry 拒絕未知 capability／transition／node／tool／contract、重複 ID、無 terminal 與非法 limits。                 | PF-REQ-004–006  | `test/flow/registry.test.ts`    |
| AT-PF-03 | JSON config 嚴格拒絕 unknown fields、秘密值、`!shell` 及大於 256 KiB 的內容。                                        | PF-REQ-004      | `test/flow/registry.test.ts`    |
| AT-PF-04 | FlowBundle 有 intake、MBTI、natal；每個 Flow factory 呼叫者都必須提供 runtime 與完整 limits。                        | PF-REQ-002、004 | `test/flow/registry.test.ts`    |
| AT-PF-05 | MBTI 測試涵蓋四軸正／負／中立／unknown、門檻、候選、題目 batch、歷史版本、重複／未知／無效答案與 owner 隔離。        | PF-REQ-009      | `test/flow/mbti.test.ts`        |
| AT-PF-06 | 星盤測試涵蓋無效曆日、閏日、日期範圍、IANA zone、未知時間、NY DST gap／overlap、座標與 offset 錯誤。                 | PF-REQ-010      | `test/flow/natal.test.ts`       |
| AT-PF-07 | J2000 或指定日期 Sun longitude 為 280.4° ±1°、Moon longitude 為 223.3° ±1°；提供 10 行星與有效 house／cusp／aspect。 | PF-REQ-010      | `test/flow/natal.test.ts`       |
| AT-PF-08 | 相同 local date/time 在不同 zone 產生不同 UTC；相同輸入計算可重現且結果 finite。                                     | PF-REQ-010      | `test/flow/natal.test.ts`       |
| AT-PF-09 | 固定版本 Pi CLI adapter 使用 strict argv/env allowlist、host guard handshake 和 bounded JSONL/RPC；fake child 不發出外部模型請求。 | PF-REQ-006 | `test/flow/pi-runtime.test.ts` |
| AT-PF-10 | 初期實作階段的範圍限制：當時不接線 production service／runner／router／server，也不讀取保護檔案或真實資料。此階段限制不是最終產品禁止 wiring；第五階段 wiring 依 AT-PF-18 驗收。 | 全部 | 歷史階段範圍與 `git status`／diff 檢查 |
| AT-PF-11 | FlowStore 固定 snapshot，並以 revision CAS 驗證 graph／result、atomic state、confirmed facts、steering 與 notifications。 | PF-REQ-003–006  | `test/flow/store.test.ts`       |
| AT-PF-12 | Schema v1→v2 migration 保留既有資料；prompt generation 與 cancellation suppression 可持久化。                          | PF-REQ-008      | `test/controller/store.test.ts`、`test/controller/outbox.test.ts` |
| AT-PF-13 | Pi 歷史依 Controller Session 持久化；credential、model、thinking、tools、resource、limit 與 abort／child-exit join fail closed。 | PF-REQ-001、005、006 | `test/flow/pi-runtime.test.ts` |
| AT-PF-14 | 真正固定 Pi CLI 1.2.0 分別以 source guard 與 build dist guard 驗證 nonce、exact provider/model/thinking、tools=[] 和 RPC state。兩個 process 共用 synthetic v3 history；第二個透過 `get_entries`／`get_messages` 驗證前次 messages、entry IDs 與 session name。另以 `maxToolCalls=1` 驗證 `calculate_natal_chart` 的實際 registered／active metadata。Test-only observer 在 `session_start` 以 `ctx.getSystemPrompt()` 稽核原生 preamble、`<tools>`／`<rules>`／`<docs>`、共用及 Node synthetic append 與順序；只寫 0600 私有 JSON booleans，不輸出 prompt。全程不 prompt、不執行工具、不呼叫模型或網路。 | PF-REQ-006 | `test/flow/pi-cli-smoke.test.ts` |
| AT-PF-15 | Baseline 與 post-run history 均受 32 MiB 上限、bounded read、UTF-8／JSONL／credential／header／path 驗證。普通 failure 保留合法安全 entries；leak、corruption、oversize 在 child join 後 atomic restore exact baseline。跨 Session symlink 不得改寫他 Session。 | PF-REQ-006 | `test/flow/pi-runtime.test.ts` |
| AT-PF-16 | Recommendation 的 non-null ID 必須是非 `intake` 的 pinned-bundle member。未知／intake 拒絕、null 接受、合法 custom Flow 接受；更新後 global registry 不可改變既有 Job membership。 | PF-REQ-006 | `test/flow/store.test.ts` |
| AT-PF-17 | Host execution state 有版本且拒絕非法輸入；FlowExecutor 以 fake runtime 驗證 intake／MBTI／natal、明確 confirmation、facts provenance、工具限制、穩定錯誤與 retry；FlowStore 測試 CAS、captured steering prefix、state／steering rollback、revise edge、同節點 wait 與 Job deadline；FlowRunner 測試 FIFO、Session partition、slot、timeout abort/join、stop/dispose；純文字 presentation 不洩漏 Agent rationale。 | PF-REQ-011 | `test/flow/{store,executor,runner,presentation}.test.ts` |
| AT-PF-18 | 第五階段歷史驗收：Flow JSON config load、Service start／stop、READY date gate、restart termination、Flow routing／execution 與 outbox sender wiring 由 config tests 和模擬 Telegram／fake runtime integration test 驗證。Integration harness 直接載入 JSON 並建立 Service；不等於 `startServer()` 真 Bot 啟動，也不表示真 Telegram 或 provider request 成功。 | PF-REQ-001–011 | `test/flow/config-file.test.ts`、`test/controller/flow-integration.test.ts` |
| AT-PF-19 | 第六階段驗收兩種 auth mode、effective Agent Node override、bot／health config、production auth source wiring、五個固定安全碼、OAuth token validity／lock cancellation／rotation persistence，以及子程序不取得來源路徑或 refresh token。使用 synthetic auth source 與原生 file lock，不呼叫真 provider 或 Telegram。 | PF-REQ-012 | `test/flow/{pi-auth,pi-runtime,config-file,executor}.test.ts`、`test/controller/{config,server,service}.test.ts` |

#### 第一至第五階段歷史驗證紀錄（數字保留；不代表第六階段驗收）

第二階段另驗收 `FlowStore` 的 pinned snapshot、revision CAS、Agent result contract、facts provenance、steering capture、wait／finish／fail 交易、prompt generation、restart cleanup 及 schema v1→v2 合成 migration。Final quality pass 的指定 Flow suite 通過 7 個 files、80 tests。全域 check 通過 18 個 test files（17 passed、1 skipped；146 tests passed、1 skipped），並通過 format、lint、typecheck 與 build。Build 後 offline CLI smoke 通過 1 test。Fake-child tests 覆蓋 32 MiB history cap、普通 failure 保留安全 entries、exact atomic restore、child join、cross-Session isolation 與 stable error redaction；FlowStore tests 覆蓋 pinned recommendation membership。Real-CLI offline `--list-models` 找到 `gpt-6-luna`。Source guard 與 build dist guard smoke 已通過 nonce、exact model/thinking、tools=[]、RPC state、session name、兩 process history reopen 及 active tool metadata；未送出任何 model prompt，也未連網。Offline metadata/RPC/history smoke 不驗證真實 model request。上述第四階段報告記錄的是當時尚未 wiring 的狀態。第五階段 production wiring 與模擬 Telegram integration acceptance 另列於第 8 節；真實 Telegram／provider request、部署與外部 chart golden 仍未驗證。本次 append-prompt 驗收執行 runtime suite 20 tests、`npm run check` 18 個 test files（17 passed、1 skipped；146 tests passed、1 skipped）及 build，並通過 gated CLI smoke 1 test。Test-only observer 的 source guard、dist guard、tool variant effective-prompt audit 五項 booleans 全部為 true。Observer 與 audit JSON 權限為 0600。未發出 model prompt，未呼叫 tool/model，未連網。該次第四階段結果不代表當時已接線，也不代表真實 model request 或 Telegram 已驗證；production wiring 的第五階段狀態與驗收證據另列於第 8 節。

第四階段 AT-PF-17 的最終指定 Flow suite 通過 7 個 test files、67 tests。`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 和 `git diff --check` 均通過。Fake-runtime 測試涵蓋 host state、明確選擇與確認、MBTI／natal persistence、未知出生時間不沿用歷史時間、steering CAS／rollback、Agent revise、Session FIFO／slot、timeout abort/join、runner stop/dispose 和 pure-text presentation。這些測試未發出模型或 Telegram 請求，也不驗證該階段以外的 wiring。第五階段 wiring 與後續本次 offline quality pass 的結果另行記錄；真實 Pi provider request 與 Telegram E2E 仍未驗證。

## 8. 第五階段：Production wiring 與整合驗收

第五階段將 Pi Flow 接入 Bot mode production path。正式路徑為 Telegram → `TelegramRouter`／SQLite → `FlowRunner`／`FlowExecutor` → Agent Node 的固定 Pi CLI JSONL/RPC runtime 或 Server Node handler → durable outbox sender → Telegram。Production 不會 fallback 到 legacy `DemoRunner`。

### 8.1 實作對照

- `src/server.ts` 解析 Controller environment；Bot mode 必須載入 `PI_FLOW_CONFIG`。它建立 resources 與 `ControllerService`，先啟動 HTTP listener，再呼叫 service start。Production 使用 `PiCliRpcRuntime`；fake runtime injection 僅供測試。
- `ControllerService` 建立 `FlowRegistry`、`FlowStore`、`FlowExecutor`、`FlowRunner` 與 `TelegramRouter`。`start()` 先呼叫 `restartTerminateAll()`，再設定 `readyAtSec = floor(nowMs / 1000) + 1`。到 READY 邊界後才排入 READY 通知並啟動 poll、runner 與 outbox loops。
- Router 依 Telegram `message.date` 套用 READY cutoff。過早、缺少或無效日期的 update 會略過內容並推進 offset；READY 後才路由命令與 Flow input。
- Runner loop 定期 tick `FlowRunner`。Runner 以 Session FIFO 和 partition 管理 workers；Agent Node 交由 Pi CLI RPC，Server Node 由 executor handler 執行。
- Outbox loop 在送出前重查 sendability；成功後記錄 delivery 與 prompt binding，永久錯誤記錄 failure，暫時錯誤排程 retry。Stop 會 abort loops、停止並 join FlowRunner／runtime，再關閉 resources。
- Service restart 將所有 `QUEUED`、`RUNNING`、`WAITING_INPUT` Job 設為 `FAILED/SERVER_RESTART`。舊 prompt 失效；Pi history 與已完成結果保留。READY 後 sender 繼續送出有效通知。

### 8.2 整合驗收與未驗證界線

AT-PF-18 由 `test/flow/config-file.test.ts` 與 `test/controller/flow-integration.test.ts` 驗收。Integration harness 直接載入範例 JSON，再建立 `ControllerService`；它不透過 `startServer()` 啟動 Bot mode。Harness 使用模擬 Telegram transport、合成 SQLite、受控時鐘與 fake `AgentRuntime`。測試情境涵蓋 READY 前不 poll／不建立 work、離線 update skip 與 offset、MBTI 三批問題及本人確認、fact reuse、unsupported goal、natal input／確認／結果、`/status` 不呼叫 runtime、Session FIFO、restart failure、舊 prompt cancellation、有效通知續送、cancel suppression 與 in-flight late-send 的 inactive binding。

#### 第五階段歷史驗證紀錄（數字保留；不代表第六階段驗收）

此 integration suite 不啟動 Pi CLI runtime，也不呼叫 provider 或真實 Telegram。Pi CLI offline smoke 僅稽核 metadata、RPC state、history 與 prompt boolean；不送 prompt、不呼叫工具或模型、不連網。兩者都不是外部服務驗收。前一輪中間離線 quality pass 的結果：指定 focused tests 退出碼 0，通過 12 個 files、100 tests。`npm run check` 退出碼 1；format check 通過，lint 在未授權的 `test/controller/service.test.ts:1256` 與 `:1259` 發現兩個 `@typescript-eslint/require-await` 錯誤。依任務限制未修改該檔案，也未繼續 typecheck、全套 tests 或 build。因本次未完成 build，build 後 gated Pi CLI smoke 未執行。完整命令、退出碼與 logs 位於 `.test-artifacts/pi-flow/wiring-final/logs/`。這不是外部服務驗收。真實 Telegram、provider request、部署、backup／restore 與 Node 24 矩陣仍未驗證。

本次 wiring-complete 最終驗證：`PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm exec vitest run test/flow/store.test.ts` 退出碼 0，通過 1 個 test file、12 個 tests。`PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm run check` 退出碼 0；`format:check`、`lint`、`typecheck`、Vitest 與 `build` 全部通過。全套測試通過 23 個 files（22 passed、1 skipped）及 194 個 tests（193 passed、1 skipped）。Build 成功後，gated `PI_FLOW_CLI_SMOKE=1 npm exec vitest run test/flow/pi-cli-smoke.test.ts` 退出碼 0，通過 1 個 file、1 個 test。Source guard、build dist guard 與 tool variant 的 effective-prompt audit 各有 5 個 boolean，值均為 true；只彙整路徑與布林值至 `.test-artifacts/pi-flow/wiring-complete/smoke-audit-summary.json`，不保存或輸出 prompt 內容。

先前記錄的 lint failure 與 restart fixture failure 都是中間過程，不是最終結果。本次 full check 的 lint 階段通過；本任務沒有修改 `test/controller/service.test.ts`。Restart fixture 現在在 enqueue transaction 內先將 Job 設為 `WAITING_INPUT`，符合 prompt sendability。Terminal pending prompt 以 raw SQL 取得指定 row ID；restart 前確認 row 仍為 `PENDING`、沒有 cancellation、不可投遞且不在 `dueOutbox`。Restart 後確認 cancellation 已寫入，且 cancellation 不計為 delivery failure。首次 post-edit full check 曾因 `test/flow/store.test.ts` 格式不符而停在 `format:check`；只格式化該授權測試後，重新執行的 focused test 與 full check 均通過。命令及完整 logs 位於 `.test-artifacts/pi-flow/wiring-complete/logs/`；baseline 與既有狀態記錄位於 `.test-artifacts/pi-flow/wiring-complete/baseline/`。此 CLI smoke 只驗離線 metadata、RPC、history 與 boolean audit；不送 prompt、不執行工具或模型、不連網。文件更新後，最後執行 `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm run format:check` 與 `git diff --check`，兩者退出碼均為 0；完整 logs 位於 `.test-artifacts/pi-flow/wiring-complete/logs/final-format-check.log` 與 `git-diff-check.log`。真實 Telegram、provider request、部署、backup／restore 與 Node 24 矩陣仍未驗證。

## 9. 第六階段：沿用 Pi 登入與 Flow 執行隔離

本階段以明確來源檔沿用操作者在一般 Pi 的 provider 登入。Runtime 不讀取個人 Pi 目錄，不執行 login 命令，也不提供 API-key fallback。`config/pi-flow.example.json` 維持 API-key 範例；`config/pi-flow.oauth.example.json` 使用相同 Flow graph、model、thinking、工具與 limits，僅 auth mode 不同。兩份範例明確使用 `openai/gpt-6-luna/max`；這不表示 provider 或帳戶一定可用。

Production config 在 bot mode 才讀 `PI_FLOW_AUTH_FILE`。Server 在 app、resources 與 listener 建立前呼叫 `assertFlowAuthConfiguration()`；Service 也在建立 Registry／FlowStore 前呼叫。此檢查只分析已載入 bundle 的 effective Agent runtime，不讀來源檔、不刷新、不連網。API-key Node override 可消除該 Node 的來源需求；若仍有任一 Pi-login Agent Node，來源仍必填。health mode 不讀變數。

Pi OAuth broker 使用明確來源 `auth.json` 和 Pi 1.2.0 native `FileAuthStorageBackend` 內部鎖。Broker 只為當次 provider 載入 OAuth credential，使用 InMemoryCredentialStore 和固定 builtin provider 觸發 Pi 原生 refresh。此 internal backend 是 pinned version-specific interface，不是 SDK Agent runtime。Delivery validity 使用 `max(5 minutes, nodeTimeoutMs + 60 seconds) + nodeTimeoutMs`；getAuth 再多要求 60 秒 startup margin。鎖等待可取消；一旦 refresh 開始，必須等待 refresh、寫回旋轉 token 和釋放鎖。來源內容只在 Agent Node 執行時讀取。

Child private snapshot 僅包含當次 provider 的 access token 與必要 metadata；refresh token 清空，來源路徑不傳入 child。Runtime join child 後清理 snapshot。Child crash 遺留 snapshot 會在下一次使用前處理。Controller、Pi history、模型結果和 Job/outbox 只使用固定安全分類，不暴露來源路徑、raw auth、provider exception 或 SQLite exception。失效登入時安全失敗；修正登入或設定後需建立新 Job。

此隔離只分離 Flow child 的個人設定、資料及工作目錄，不是 OS sandbox。同一 UID 或 root 仍可存取檔案；記憶體 credential 不能保證絕對清除。Source refresh 可能重新排版整份 auth JSON。其他 provider JSON values 會保留，但與不使用同一原生鎖的任意 writer 不保證安全。

第六階段驗收包括：180 秒 Node／約七分鐘來源 token 必須 refresh 成功；timeout、dispose 與 external abort 可取消 native lock wait；refresh 已開始時 timeout／dispose 仍等待旋轉 token 寫回，且不 spawn child；bot／health config 的 env 讀取嚴格；effective Node override 正確；production Server／Service 將 auth path 傳給真 PiCliRpcRuntime，並以 malformed synthetic source 於 spawn/provider request 前得到 `FLOW_AUTH_SOURCE_INVALID`；API-key runtime 不讀無效 auth source；五個 auth stable codes 經 Executor 寫入 Job/outbox 時不帶 raw source/provider exception。原生 file lock 競爭測試使用 synthetic source，不呼叫真 provider。此驗收不包含真實 OAuth/provider 或 Telegram E2E。
