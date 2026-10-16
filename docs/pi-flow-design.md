# Pi Flow 狀態機任務控制器 — 架構設計

- **文件狀態：** 第一階段建立 Flow 定義與領域邏輯。第二階段實作 FlowStore 與 schema v1→v2 migration。第三階段加入固定 Pi CLI JSONL/RPC child-process adapter。第四階段加入 FlowExecutor、FlowRunner、原子輸入 checkpoint 與純文字 presentation。第五階段已接線 production server、ControllerService、TelegramRouter、FlowRunner／Executor、Pi CLI runtime 與 outbox sender。第六階段加入明確 Pi OAuth source、token refresh validity／cancellation 處理與 child credential snapshot 隔離。Integration tests 使用模擬 Telegram、synthetic auth source 和 fake runtime；真實 provider request、真 Telegram 與部署尚未驗證。
- **需求基準：** [Pi Flow 需求規格](pi-flow-requirements.md)。
- **既有背景：** [Telegram Controller 設計](telegram-controller-design.md)與[需求](telegram-controller-requirements.md)。這些檔案未修改。
- **CLI 基準：** 本機安裝的 `@earendil-works/pi-coding-agent@1.2.0`，固定解析 package manifest 的 CLI entry；source guard 與 build dist guard 的 offline RPC/history smoke 已通過。測試使用 synthetic credential、`PI_OFFLINE=1`，不發出 model prompt 或 Telegram 請求。

## 1. 設計摘要與責任界線

Pi Flow 是既有 Telegram Controller 上方的受限領域工作流程，不替換 Router、Controller Session、SQLite、FIFO partition 或直接 `/status`。

- Controller 接受訊息、授權、固定 Session、排程 Job、保存狀態、管理 prompt generation，並經 outbox 傳送通知。
- FlowRegistry 驗證純 declarative Flow 定義、節點圖、runtime、limits、contract 名稱及工具名稱。Registry 不載入或執行 Flow 內任意程式碼。
- `PiCliRpcRuntime` 以固定版本 Pi CLI JSONL/RPC child process，在一個 Controller Session 對應的 Pi history 上執行 Agent Node。
- Server 控制節點負責明確 Flow 選擇、固定問題、輸入驗證、MBTI 計分、星盤計算、transition 驗證與 terminal 判定。
- Pi 只能回傳結構化 JSON。Server 驗證 result contract 與已宣告 transition 後，才可更新 Flow state。
- Scheduler 一次只允許一個 Job 操作同一 Controller Session 的 Pi 歷史。不同 Controller Session 有獨立歷史與 slot。
- Pi 不是 sandbox。限制工具和資源探索不會隔離 process 權限；未來部署仍須以 OS 權限、資料目錄權限和網路規則限制損害範圍。

第一階段建立 requirements/design、純型別、嚴格 Registry/config、固定 Flow templates、MBTI domain 與離線 natal calculator。第二階段新增 FlowStore 與 additive schema v1→v2 migration。第三階段以固定 Pi CLI JSONL/RPC child process 取代 SDK runtime，並新增 fake-child 測試與獨立 real-CLI offline metadata/history smoke。第四階段新增 host-controlled FlowExecutor、FlowRunner、safe-point persistence 和 pure-text presentation；當時只用 fake runtime 與本機合成 SQLite 驗證，且不接線 production service、controller runner、router 或 Telegram。這是第四階段範圍，不是最終產品禁止 wiring。第五階段已將這些元件接入 production path，並以模擬 Telegram／fake runtime integration tests 驗收；不讀真實 `data`，也不發出真實 provider request 或 Telegram 請求。

## 2. 資料流

```text
Telegram update
      │ private chat / single-user auth / READY date gate
      ▼
[Router: command, direct status, ordinary task]
      │ one synchronous transaction
      ▼
[SQLite: update offset + Controller Session + Job + outbox]
      │
      ├── /status ───────────────────────────────► direct read; no Job/Pi
      │
      ▼
[Scheduler: Controller Session FIFO + global slot]
      │ Job pins immutable FlowBundle/version snapshot
      ▼
[Flow state machine: intake recommendation]
      │ user explicitly chooses; server checks choice
      ▼
[Server input validation / fixed question / safe point]
      ├── server chooses next transition and bounds
      ├── declared Agent Node ──► Pi Runtime ──► shared Pi history for this Session
      │                              │ structured result only
      │                              ▼
      │                    contract + output + transition validators
      │                              │ accepted result only
      └──────────────────────────────┴──► [SQLite state transition + outbox]
                                               │
                                               ▼
                                         [Outbox sender]
                                               │
                                               ▼
                                         Telegram message
```

正式路徑為 Telegram update → Router／SQLite → FlowRunner／FlowExecutor → Agent Node 的 Pi CLI JSONL/RPC runtime 或 Server Node handler → durable outbox sender → Telegram。Bot mode 載入 `PI_FLOW_CONFIG` 後使用固定 Pi CLI runtime；production 不會 fallback 到 `DemoRunner`。所有 Controller update 的去重、業務狀態、回覆 outbox 與 offset 仍依既有 Telegram Controller 交易契約。Pi network request 不可在 SQLite transaction 內執行。

## 3. Declarative Flow 與 Registry

### 3.1 型別和建構

純領域型別位於 `src/flow/types.ts`。主要型別為：

- `FlowRuntime`：`provider`、`model`、`thinking`、`apiKeyEnv` 與可選 `auth.mode`。`api-key` 與 `pi-login` 明確互斥；舊設定省略 `auth` 時維持 API-key-only。
- `FlowLimits`：`nodeTimeoutMs`、`waitTimeoutMs`、`jobTimeoutMs`、`maxTransitions`、`maxRetries`、`maxModelTurns`、`maxToolCalls`、`maxOutputChars`。
- `NodeDefinition`：`id`、`kind`、`systemPrompt`、`prompt`、`expectedResult`、`resultContract`、`next`、`tools`，以及可選 runtime／limits override。
- `FlowDefinition`：固定版本、描述、aliases、完整 runtime／limits、entry node 與 nodes。
- `FlowBundle`：schema version 與 `intake`、`mbti`、`natal` 三個 definitions。
- `AgentRuntime` 與 `AgentNodeResult`：Pi adapter 的公開介面契約。`src/flow/pi-rpc-runtime.ts` 提供受控 CLI 實作；`src/flow/store.ts` 提供持久化介面。

`createFlowBundle()` 是 typed template factory。呼叫者必須傳入 intake、mbti、natal 各自的完整 runtime 與 limits。Factory 不含預設模型、憑證或 SDK 預設值。

`FlowRegistry` 輸入只包含 trusted declarative data。它確認 bundle shape、unknown fields、IDs、version、圖、reachable terminal、validator 名稱、tool 名稱、runtime 和 bounded limits。成功後複製並深度凍結 bundle；Registry 沒有熱更新方法。Job 取得的整份 bundle snapshot 固定到該 Job 終止。

`next` 的 key 是可選 transition，value 是同 Flow node ID 或 `flowId/nodeId`。Server 只能選擇已宣告的 transition。Agent 的 transition 欄位亦必須對應該 Node 的 `next` key；不從自然語言推斷。

### 3.2 Runtime 與 limits

- Flow runtime 每次呼叫都明確指出 provider、model 與 thinking；auth mode 明確決定使用環境變數名稱或 `PI_FLOW_AUTH_FILE` source。舊設定省略 `auth` 時是 API-key-only。無憑證模式 fallback、無模型 fallback、無較低 thinking fallback，也不採用 Pi 的預設選擇。
- Agent Node 可完整覆寫 runtime；Server Node 不可宣告 runtime，也不可呼叫隱含模型。
- Flow limits 必須完整。Node limit override 可部分指定，其餘只取該 Flow 已宣告值。
- `maxTransitions` 限制循環；Node timeout、等待 timeout、Job timeout、retry、model turns、tool calls 和輸出字元各自受上限控制。
- Stage 1 的 bounded 整數範圍在 Registry constants 明確列出。超界、缺少值、非 safe integer 或 `maxRetries`／`maxToolCalls` 負值都拒絕。
- Pi CLI 的自動 retry 與 compaction 關閉。Runtime 監聽 RPC retry／compaction event，任何發生都 fail closed。Flow `maxRetries` 由 Controller orchestration 解釋；Pi provider 不可自行 retry。
- 執行期收到取消時先送 `clear_queue`，再送 `abort`，然後關閉 child stdin。Runtime 等 child process exit；逾時時送 SIGTERM／SIGKILL。只送 abort request 不等於工作已停止。

### 3.3 JSON config

`src/flow/config.ts` 只解析呼叫者提供的 JSON string，不讀檔、不讀 `.env`、不展開變數、不載入 plugin，也不 eval。

- UTF-8 byte size 上限為 256 KiB。
- Root、Flow、Node、runtime、limits 和 result contract 都拒絕 unknown fields。
- 明確拒絕秘密欄位、常見 credential-like literal、`!shell` 文字與非 JSON 輸入。
- `apiKeyEnv` 只能是 env name 或 null，不可包含 key value。`auth.mode` 只接受 `api-key`／`pi-login`；`pi-login` 要求 `apiKeyEnv: null`，`api-key` 必須指出 env name。
- config 中的 tool／validator 名稱必須已在 host registry 登記。未知名稱 fail closed。

## 4. 固定 Flow 圖

### 4.1 Intake

```text
recommend (agent; recommendation contract; tools=[])
       │ ready
       ▼
choose (server; user explicit choice only; tools=[])
       ├── mbti ──► mbti/collect
       ├── natal ──► natal/input
       └── unsupported ──► unsupported (terminal)
```

`recommend` 只列出 capability、Node 摘要、建議選項和使用者如何選。其輸出 `suggestedFlow` 不是授權或 transition 選擇。`choose` 只處理使用者明確的本次選擇。`unsupported` 只回報能力缺口並請縮小目標，不轉進其他流程。

### 4.2 MBTI

```text
collect (server; fixed question bank; <=4 questions)
   │ parse
   ▼
parse_answers (agent; mbti_answers contract; tools=[])
   │ parsed
   ▼
score (server; strict validation + deterministic scoring; tools=[])
   ├── collect ──► collect
   └── analyze ──► analyze (agent; interpretation contract; tools=[])
                              │ complete
                              ▼
                         done (server terminal)
```

- Bank version 固定為 `mbti-original-v1`，IDs 1–12，四軸每軸三題。題句由本 repository 原創，不依賴付費題庫。
- Server 決定本次最多四題，依本人與 bankVersion 篩選缺答／澄清題。Agent 只把明確回覆解析成答案，不得猜答案或人格。
- Server 驗證 ID、型別、重複、owner、bankVersion，再以純函式重算分數、候選與證據。模型不能提交自算 transition 或分數作為權威。
- 完整 12 題可以包含 null。每軸至少兩個非 null 且絕對總分至少 2 才有字母，其他維持 `?`。候選是未定軸的所有組合，最多 16 種。不產生 confidence percentage。
- 固定 disclaimer 說明結果是非官方自我反思，不是心理診斷。

### 4.3 出生星盤

```text
input (server; explicit birth fields / DST validation; tools=[])
   ├── more ──► input
   └── ready
         ▼
calculate (server; explicitly declares calculate_natal_chart)
         │ calculated
         ▼
analyze (agent; interpretation contract; tools=[])
         │ complete
         ▼
   done (server terminal)
```

Server 先確認使用者明確提供日期、時間、緯度、經度與 IANA zone，並通過 DST 驗證。未知時間不計算完整星盤。城市名稱不觸發網路查詢。

離線 calculator 使用 pinned `astronomy-engine@2.1.19`：10 個指定天體以 `GeoVector(body, time, true)` 和 `Ecliptic` 取得 geocentric apparent tropical ecliptic-of-date longitude。Ascendant 先用核准公式計算兩個解，再用 east dot product 選 rising 解。MC 使用核准公式。Equal-house cusp 為 Ascendant 加 30°；行星宮位以相對 Ascendant 的標準化經度計算。Aspects 僅使用五種主要角度、6° orb、唯一 planet pair。所有輸出數字都驗證 finite。

結果帶有 input、UTC、calculator/method version、座標框架、tropical zodiac、equal houses、10 行星、Ascendant、MC、12 cusp 和 unique aspects。解讀聲明限於娛樂與自我反思；不宣稱科學預測，不提供醫療、投資或重大決策意見。

## 5. Pi CLI Runtime 與能力限制

Pi Agent runtime 不使用 Pi SDK `createAgentSession()`。Pi CLI runtime 只解析本機 `@earendil-works/pi-coding-agent@1.2.0` package manifest 的 `bin.pi` entry，並確認版本與 entry path。版本、entry 或 wrapper 不符時 fail closed；沒有 SDK runtime fallback。`pi-login` 的 OAuth broker 使用 `@earendil-works/pi-coding-agent@1.2.0` 提供的 internal `FileAuthStorageBackend`，以及 `@earendil-works/pi-ai@1.2.0` 提供的 builtin provider OAuth resolver，不建立 SDK Agent session。這些是 pinned version-specific internal interfaces，不保證相容任意 Pi 版本或不使用同一鎖的 writer。

- 固定 wrapper 以 `process.execPath`、`shell: false` 啟動本機 CLI。TypeScript 開發環境只載入本機 `tsx` loader；production 編譯後直接執行 JavaScript wrapper。Wrapper 設定 `umask(0o077)`，並只 import 已驗證的 absolute CLI entry。
- 每個 Controller Session 對應 `dataDir/pi/<controllerSessionId>/`。Pi history、workspace、agent settings、HOME、XDG config/data 與 temp 均分隔。Session 目錄為 0700；history、settings、prompt、guard config 為 0600。History ID、絕對路徑、symlink 狀態、v3 header、cwd 與 credential-like 內容都經驗證。映射失效時不建立替代 history。
- Pi history 是 host resource，不是 context-token limit。Baseline 與 post-run 檔案各自不得超過 `MAX_PI_HISTORY_BYTES = 32 * 1024 * 1024`。Runtime 以 `O_NOFOLLOW`、regular-file metadata、bounded `limit + 1` read、fatal UTF-8 與完整 JSONL plain-record 驗證，在 spawn 前拒絕 oversize、錯誤 header、壞 JSONL、credential 或 path。檢查接受 Pi 的 `session_info`、`model_change`、`thinking_level_change` 等合法 entry type；不以本程式的 typed-entry schema 拒絕新型別。
- Baseline 只以 exact `Buffer` 保存在記憶體，不建立 disk backup。Provider error、timeout、cancel 或 invalid result 後，只要 post-run history 合法且無 credential，就保留安全 entries。只有 post-run credential leak、corruption 或 oversize 才在 child close/join 後，以同 Session directory 的隨機 exclusive 0600 暫存檔寫入 exact baseline、fsync，再 atomic rename；操作前重驗 canonical Session directory 與非 escaping target，操作後驗證 ID、cwd、credential 與 0600。Restore 失敗回報 `FLOW_HISTORY_INVALID`；restore 成功仍回報原本的 stable failure。
- Oversize baseline 回報 `FLOW_HISTORY_LIMIT`，不 spawn，也不截斷歷史。使用者需改用新的 Controller Session，或由 operator 受控管理歷史。本版不實作自動 retention 或 compaction。安全 Pi history 不等於 DB-validated 或 user-confirmed fact。
- Runtime 只傳固定 argv allowlist：RPC mode、明確 provider/model/thinking、固定 history/session-dir、private prompt/config、host guard extension、關閉 builtin tools／其他 extensions／MCP／skills／prompt templates／themes／context files，以及 offline/no-approve flags。Pi 原生 system prompt 保留；Controller 共用規則與 Node 指令分別以重複的 `--append-system-prompt` 附加，順序固定為「Pi 原生 system prompt → Controller 共用規則 → Node 指令」。既有 `host-system-prompt.txt` 路徑保留，但不再用 `--system-prompt` 覆蓋 Pi 原生 prompt。本版沒有覆蓋需求或覆蓋選項；只有未來有明確需求並經設計確認，才可考慮覆蓋。保留原生 prompt 不會增加工具權限；工具預設仍為 none，實際工具仍由 Node 宣告與 host guard 限制。Guard config 不使用 extension flag：Pi 1.2.0 在 extension factory 完成後才套用 CLI flag values，所以 factory 內的 `registerFlag()`／`getFlag()` 讀不到該值。Runtime 把 absolute 0600 config path 明確設為 child-only `PI_FLOW_GUARD_CONFIG`；不複製 parent ambient 值，也不把 path 放入 argv。使用 `spawn()`，不使用 shell，不把 prompt 或 credential 放入 argv。
- 子程序環境只包含 `PATH`、必要 locale/platform 變數、該 Session 的 HOME/XDG/TMP、child-only `PI_FLOW_GUARD_CONFIG`、Pi offline/telemetry flags，以及 API-key mode 下由 `apiKeyEnv` 指定值重新映射至 provider allowlist key。Pi-login mode 的 child 環境不含來源路徑；只以 private settings snapshot 提供當次 provider 的 access token，snapshot refresh token 必須清空。未知 provider、缺少 credential 或未知 env mapping 都停止。不得讀 `.env`、繼承任意 ambient env、使用 extension flag 傳 guard path、傳 `--api-key`，或把來源路徑、refresh token 寫入 history/config/settings/log/error。
- 私有 settings 關閉 Pi retry、compaction 與 cache warming，並停用外部 discovery。Host guard config 包含 nonce、exact provider/model/thinking、Node tools、limits、Node ID、result contract 與 transitions；檔案權限為 0600。Guard extension 在 session start 發出 bounded ready notification，並回報實際 active tool names 與其 registered metadata。Runtime 必須驗證 nonce、model、thinking、tools metadata，再讀取 RPC state；握手失敗時不送 prompt。
- Runtime 使用 bounded JSONL transport。只允許固定 command 子集，其中唯讀 history 查詢只有 `get_entries` 和 `get_messages`；其餘仍為原有明確命令。也只允許 known event 子集、correlated response IDs、strict JSON、fatal UTF-8、每 frame 1 MiB 與每 child 8 MiB wire 上限。stderr 只 drain 並計數，不轉送或保存。Malformed、未知、過大或錯誤 correlation 一律 fail closed。
- Runtime 驗證 RPC state 的 exact provider/model、thinking、session ID/file、display name 和 auto-compaction。它再次檢查 available thinking levels。任何 mismatch 都以穩定 error code 停止；不換模型、不降低 thinking、不做 unrestricted fallback。
- Host guard 只註冊 Node 明確宣告的 `calculate_natal_chart`。工具 schema 不接受模型參數；工具只讀取當次 host 提供且經驗證的出生資料。未宣告工具、nested tool、retry、compaction、model/thinking 變更或 host guard failure 都 abort。
- Runtime 對 prompt、RPC frame、tool output、assistant output、model turns、tool calls 與 node timeout 套用界限。每次 Agent Node 建立一個 child。取消時送 `clear_queue` 與 `abort`，關閉 stdin，等待 process exit；必要時依序送 SIGTERM、SIGKILL。Session lock 直到 child exit 才釋放。
- Fake-child 測試覆蓋 allowlist、child-only guard path、nonce、credential redaction、model/thinking mismatch、tool/turn/output limits、malformed RPC、backpressure、callback/error/close/timeout cleanup、cancel 與 child join。獨立 real-CLI offline smoke 分別以 source guard 與 build dist guard 啟動固定 CLI 1.2.0；它驗證 nonce、exact model/thinking、active tool metadata、RPC state、設定 session name、跨 process 的 `get_entries`／`get_messages` history reopen，並選擇 natal tool metadata。Smoke 專用的第二個 explicit extension 是 test-only observer；它只在 `session_start` 讀取 `ctx.getSystemPrompt()`，並將原生 preamble、`<tools>`／`<rules>`／`<docs>`、兩段 synthetic append 及順序寫成 0600 私有 JSON boolean audit。Parent 在 `get_state` 後檢查 source、dist 與 tool variant 的 audit。Observer 不改 prompt、tools、model 或 history，也不屬於 production runtime。Smoke 不送 prompt、不呼叫 tool 或 model，也不連網。

Pi CLI Extension 可在 Pi process 權限下執行。Pi 不是 OS sandbox。本 adapter 只載入 host guard，不載入 user/project extension、MCP、skills、prompt templates、themes、context files 或 package discovery。未來若增加能力，必須另做安全審查；不能由本版 allowlist 推導額外授權。

## 6. Persistence、交易與 migration

`ControllerStore` 以單一 transaction 執行 schema v1→v2 additive migration。migration 不刪除或重寫 v1 資料。測試只建立 `.test-artifacts/` 合成資料庫，不讀取或改動真實 `data`。

migration 建立：

| 新表                   | 用途                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pi_sessions`          | Controller Session 到 Pi session ID/path 的唯一映射。                                                                  |
| `session_facts`        | owner、來源 JSON、Flow／bank version、建立時間與固定 `user_confirmed` provenance。模型推論不可寫成已確認事實。          |
| `flow_runs`            | Job 的固定 bundle snapshot、當前 Flow/node、JSON state、revision、transition count、prompt generation 與 deadlines。    |
| `outbox_cancellations` | 對 superseded／terminal／restart prompt 建立 suppression 記錄；取消不會標成 DELIVERED 或 FAILED。                       |

v2 另在 `outbox` 加 nullable `prompt_generation`，在 `prompt_bindings` 加預設為 0 的 `generation`。Migration 只新增資料表／欄位和索引。不得刪除、重寫或清理既有 Session、Job、Message 或 outbox。測試從合成 schema-v1 fixture 驗證 offset、Job、prompt binding 與 outbox row 保留。Pi history 不由 migration 操作。

`FlowStore.commitFlowStep()` 以 revision CAS 驗證固定圖與 Agent result contract，並原子更新 Flow state、Job status、confirmed facts、prompt generation 及 outbox。Recommendation 的非 null `suggestedFlow` 必須是非 `intake` 且存在於該 Job 的 pinned bundle；合法格式但不在 pinned membership 的 ID 仍拒絕。`wait()` 設定 capped wait deadline；`finish()` 若仍有 pending steering 回傳 dirty，不完成 Job；`consumePendingSteering()` 只套用 call 前捕捉到的 message ID／sequence。`restartTerminateAll()` 將 active Job 標成 `FAILED/SERVER_RESTART`、pending steering 標成 `not_applied`、取消 prompt，並且只新增一次 failure notification。這些介面在第四階段結束時尚未接線；第五階段已由 `ControllerService` 啟動流程呼叫，見第 12 節。

## 7. Scheduler、安全點與狀態轉移

- `RUNNING` 持有全域 model slot 與 Controller Session partition。
- `WAITING_INPUT` 釋放全域 model slot，但保留 Session partition，確保同 Session FIFO。
- `PiCliRpcRuntime` 會依 effective Node limits 執行 node timeout、model-turn、tool-call 與 output 上限；逾時會 abort child 並等待 process exit。`FlowExecutor` 與 `FlowRunner` 已提供可本機呼叫的 worker／slot 控制，`FlowStore` 管理 transition count、wait deadline 與 job deadline。Fake runtime 測試覆蓋本地 FIFO、Session partition、slot、timeout、abort join 和 stop；第五階段 `ControllerService` 提供 production timer、startup、poll、runner、outbox sender 與 stop wiring；`test/controller/flow-integration.test.ts` 用模擬 Telegram／fake runtime 驗證這些路徑。此測試不驗證真實 Telegram 或 provider request。
- Steer 或補充內容依 Session sequence 排序，在 safe point 的 SQLite transaction 中消費。回覆接收成功不表示已套用。
- 執行完成準備 terminal transition 時，transaction 必須再檢查 pending steer。若存在已先 commit 的 pending steer，不能直接 complete；先消費該內容並按圖繼續或要求新的 Agent step。若完成先 commit，後到 steer 依既有 terminal 規則拒絕。
- Agent 只能提議已宣告 transition。Server 以最新持久 state、contract validator、owner 與 allowed transition 再判斷；失敗時不前進圖。
- Prompt 綁定包含 `jobId`、generation、chat/message identity 和 active 狀態。生成新問題、Job 結束或 restart 時，舊 generation 原子失效。舊問題 reply 不可成為一般新 Job。
- 任何「最後模型輸出」都不是 terminal 的權威依據。只有經 SQLite 交易確認的 server transition 可以 complete。

## 8. 啟動、restart 與 READY gate

### 8.1 Restart

`FlowStore.restartTerminateAll()` 在單一 transaction 中找出所有 `QUEUED`、`RUNNING`、`WAITING_INPUT` Job，標為 `FAILED/SERVER_RESTART`；pending steering 標為 `not_applied`，prompt bindings inactive，未送出的舊 prompt 寫入 cancellation suppression，並新增一次 failure outbox。Pi Session 歷史、已完成 Job 結果和其他有效通知保留。第四階段時此方法尚未接線；第五階段由 `ControllerService.start()` 在 READY gate 前呼叫，並由 outbox sender 在 READY 後送有效通知。

取消未送 prompt 是 cancellation，不是 delivery failure；不得增加 `failedDeliveries`。已送達的 prompt mapping 仍標 inactive，reply 只能收到舊問題已過期的拒絕。

### 8.2 READY 時間界線

啟動時計算下一個整數秒 UTC `readyAtSec = floor(nowMs / 1000) + 1`。Controller 在此界線前不接受新任務。Poll update 檢查只用 envelope 的 Telegram `message.date`，不能讀取 message text/content 來判斷離線請求。

- `date < readyAtSec`：在同一 SQLite update transaction 記錄處理並推進 offset，不建立 Job 或呼叫 Pi。
- `date >= readyAtSec`：才允許一般授權、Router 與 Job 流程。
- `date` 缺少或無法驗證：記錄分類 log，不讀訊息內容；以同一交易跳過 update 並推進 offset。
- readiness gate 過後，Controller 才發 READY 通知。使用者需重送啟動期間的請求。

Telegram `message.date` 精度為秒。用戶端與伺服器 clock skew 仍可能造成界線錯判，所以部署必須同步系統時間。`/health` 是 liveness，不是 readiness。

## 9. Privacy、logging 與操作

- Pi transcript、出生日期／時間、座標、MBTI 答案與 history facts 都是敏感資料。Pi session file、SQLite 和父目錄權限限制為執行帳號可讀寫；檔案採 0600、目錄採 0700。
- 不 log DOB、精確出生時間／位置、原始 AI output、原始 prompt、raw provider exception、credential、token 或含 credential 的完整 URL。
- Log 只輸出穩定分類、Flow／Node ID（不含個資）、Job ID（依既有安全策略）、取消原因與非敏感錯誤碼。
- DB 備份同樣包含個人敏感資料，必須套用等同存取限制與 retention policy。第二、三階段不操作真資料，也不新增備份清理程式。
- 不讀 `.env` 或真實 `data`。測試只使用合成資料、`FLOW_TEST_API_KEY` 與 `PI_OFFLINE=1`；不連線外部模型、Telegram 或城市定位服務。Real-CLI smoke 只送 metadata RPC，不送 model prompt。

## 10. 驗證計畫與未驗證界線

第三階段指定檢查：

```text
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm exec vitest run test/flow/{registry,mbti,natal,store,pi-runtime,pi-rpc-client,pi-rpc-guard}.test.ts
npm run typecheck
npm run lint
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm run check
PI_FLOW_CLI_SMOKE=1 PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm exec vitest run test/flow/pi-cli-smoke.test.ts
git diff --check
```

Vitest 與 smoke test 只寫入 `.test-artifacts/`；`npm run check` 可寫入授權的 `dist/`。不得連線 Telegram、LLM 或城市定位服務。

#### 第三至第四階段歷史驗證結果（數字保留；不代表第六階段驗收）

Final quality pass 的指定 Flow tests 通過 7 個 test files、80 tests。全域 `npm run check` 通過 format、lint、typecheck、18 個 test files（17 passed、1 skipped；146 tests passed、1 skipped）與 build。Build 後的 real-CLI offline smoke 通過 1 test。`npm run typecheck`、`npm run lint` 與 `git diff --check` 也通過。Fake-child history cases 驗證 32 MiB baseline/post-run 上限、safe entries 保留、leak/corruption/oversize atomic restore、child join、cross-Session symlink isolation 與 stable error redaction。FlowStore cases 驗證 recommendation membership 使用 pinned bundle。

Offline `--list-models` 找到 `gpt-6-luna`。Source guard、build dist guard、nonce、exact provider/model/thinking、tools=[]、RPC state、retry/compaction 設定、session name 與兩 process synthetic history reopen 已由真 Pi CLI smoke 通過。另以 `maxToolCalls=1` 驗證實際選取及註冊的 natal tool metadata；未送 prompt、未呼叫 tool 或 model，也未連網。本次 append-prompt 驗證中，fake-child runtime 測試通過 20 tests；`npm run check` 通過 format、lint、typecheck、18 個 test files（17 passed、1 skipped；146 tests passed、1 skipped）與 build；gated real-CLI smoke 通過 1 test。Test-only observer 對 source guard、dist guard 與 tool variant 的五個 effective-system-prompt boolean audit 全部為 true；observer 與三份 audit 均為 0600。Audit 確認 Pi 原生 preamble、`<tools>`／`<rules>`／`<docs>`、Controller 共用 append、Node append，以及原生→共用→Node 順序。Smoke 仍不送 prompt、不呼叫 tool 或 model，也不連網。該次第四階段驗證未涵蓋 production wiring；第五階段 wiring 與模擬整合測試另列於第 12 節。真實 provider request、模型輸出品質、真 Telegram、production credentials、部署時間同步與 Node 24 執行矩陣仍未驗證。READY／restart／outbox race 的程式接線以模擬 Telegram integration test 驗證，不代表外部 Telegram delivery 已驗證。Pi 不是 OS sandbox。天文結果沒有獨立外部 ephemeris golden。

## 11. 第四階段：本機 Flow 執行與持久化

第四階段在既有 Flow graph、`ControllerStore`、`FlowStore` 與 `AgentRuntime` 之上新增可本機呼叫的執行層。該階段不改 controller、Pi runtime adapter、套件依賴或 production service wiring；這是當時的階段範圍，不是最終產品禁止 wiring。

### 11.1 公開執行 API

- `FlowExecutor(controllerStore, flowStore, agentRuntime, options?)` 提供 `execute(jobId, signal): Promise<void>` 與 `dispose(): Promise<void>`。Executor 只在 Agent safe point 呼叫 runtime。Server handler、Flow membership、Node limits、Agent result contract 和 declared transition 都由 host 驗證。
- `FlowRunner(controllerStore, flowStore, executor, { concurrency, now?, onError? })` 提供 `tick(): void` 與 `stop(): Promise<void>`。呼叫端負責安排 `tick()`；本模組沒有 production timer 或 service lifecycle wiring。Worker map 管理全域 slot 與 Controller Session partition。等待輸入的 Job 釋放 slot，但保留 Session partition。
- `FlowStore.reserveReadyJobs(now, slots, excludedSessionIds?)` 以單一 transaction 保留 WAITING steering 或每 Session 最早 QUEUED Job。首次 reserve 固定 pinned bundle、host state、started time 和 effective Job deadline。
- `FlowStore.checkpointInput({ jobId, expectedRevision, currentNodeId, captured, state })` 驗證捕獲的 pending steering ID／sequence 是未跳過的 pending prefix，再於同一交易保存版本化 state、來源引用、steering applied 狀態、revision 與 transition count。失敗時全部 rollback。
- `FlowStore.discardAgentAndRevise(...)` 只接受目前 Agent Node 的明確 `revise` edge。它在同一交易套用捕獲輸入、清除未確認候選和舊分析、更新 Flow/node/deadline，並保存 revision。
- `FlowStore.waitAtCurrentNode(...)` 只允許非 terminal Server Node。它在同一交易保存 state、generation、wait deadline、`WAITING_INPUT`、舊 prompt cancellation 和新 outbox prompt。Wait deadline 不可超過 Job deadline。
- `FlowStore.failExpiredWaitingJobs(now)` 將過期等待 Job 以 `TIMEOUT` 原子終止。Pi runtime request 與 child-process 等待不在 SQLite transaction 內執行。

### 11.2 Host state 與 Flow presentation

`src/flow/execution-types.ts` 定義 schema version 1 的 plain-data state。Parser 拒絕錯誤版本、未知欄位、重複或無效輸入引用。Agent result 只先進入待確認候選或受限 interpretation 欄位；host 計分、出生資料驗證、星盤計算、confirmation、fact provenance、transition 和 terminal outbox 都由 Server 控制。

`src/flow/presentation.ts` 產生純文字 choice、MBTI 問題／候選／結果、出生資料缺項／候選／錯誤／星盤結果及固定 disclaimer。Presentation 不呼叫模型、Telegram 或 geolocation service。MBTI 歷史只依同一 Session／owner／bank version 沿用。出生時間標示未知時，即使已有舊本人 fact，也不得把舊時間當成當次有效輸入；必須取得明確時間並重新確認候選。

### 11.3 第四階段驗證邊界

第四階段 tests 使用記憶體 SQLite、synthetic message/fact、fake `AgentRuntime` 與合成 `FLOW_TEST_API_KEY`。測試驗證 intake 明確選擇、MBTI batching/本人確認/facts、natal missing fields/時間與本人確認/離線 chart、pending steering CAS/rollback、Session FIFO/slot、timeout/abort join/stop dispose 及 presentation。它們不啟動 `PiCliRpcRuntime` child,不呼叫 OpenAI API,不送 Telegram update,也不驗證 production outbox sender 或 service wiring。第四階段最終指定 Flow suite 通過 7 個 test files、67 tests;`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 與 `git diff --check` 均通過。第五階段 production wiring 的整合驗收見第 12 節。

## 12. 第五階段：Production wiring 與整合驗收

### 12.1 啟動與設定載入

`startServer()` 先呼叫 `parseControllerConfig()`。Bot mode 必須有 `PI_FLOW_CONFIG`；server 以 `loadFlowBundleConfig()` 讀取並驗證 JSON bundle，再建立 Controller resources 和 `ControllerService`。HTTP listener 成功後才呼叫 `service.start()`。Production 建立固定 Pi CLI runtime；`agentRuntimeForTests` 是 test-only injection，不是 fallback。

`ControllerService` 建立 `FlowRegistry`、`FlowStore`、`PiCliRpcRuntime`、`FlowExecutor`、`FlowRunner` 與 `TelegramRouter`。`start()` 先執行 `restartTerminateAll()`，將舊的 `QUEUED`、`RUNNING`、`WAITING_INPUT` Job 結束為 `FAILED/SERVER_RESTART`，再設定 `readyAtSec = floor(nowMs / 1000) + 1`。達到 READY 邊界後，service 寫入 READY 通知並啟動 poll、runner、outbox loops。

### 12.2 輸入、執行、通知與停止

- Poll loop 取得 updates，按 update ID 排序後交給 Router。Router 在讀取訊息文字前驗證 `message.date`；早於 READY、缺少或無效日期的 update 會跳過並推進 SQLite offset。使用者需在 READY 後重送。
- Router 透過 SQLite 建立 Session、Job、prompt binding 和 outbox。`/status` 直接讀持久狀態，不建立 Job 或呼叫 Pi。
- Runner loop 定期呼叫 `FlowRunner.tick()`。Runner 管理 FIFO、global slot 與 Session partition。`FlowExecutor` 執行 Server handler；Agent Node 呼叫 production `PiCliRpcRuntime`。等待輸入的 Job 不占 global slot，但保留 Session partition。
- Outbox loop 取得 due rows，送出前重查 sendability。成功時記錄 Telegram message identity／prompt binding；永久錯誤標示 failed；暫時錯誤排程 retry。已開始的外部 send 無法撤回，因此舊訊息仍可能晚到，但被取代的 prompt binding 保持 inactive。
- `stop()` abort service loops，停止並等待 FlowRunner workers 和 runtime dispose，最後關閉 Controller resources。`startServer().close()` 也會關閉 HTTP app。

Production 路徑是 Telegram → Router／SQLite → FlowRunner／Executor → Pi CLI RPC（Agent Node）或 server handler（Server Node）→ outbox sender → Telegram。正式執行不會 fallback 到 `DemoRunner`；legacy DemoRunner 只留在原有 demo／regression tests。

### 12.3 Integration tests 與界線

`test/controller/flow-integration.test.ts` 對 ControllerService、Router、FlowRunner／Executor 與 outbox sender 做整合測試。它直接載入範例 Flow JSON，再建立 Service；不透過 `startServer()` 啟動 Bot mode。測試使用合成 SQLite、受控時鐘、模擬 Telegram transport 及 fake `AgentRuntime`。測試涵蓋 READY gate、Flow selection、MBTI batches／confirmation／history reuse、unsupported target、natal input／confirmation／chart output、`/status`、restart failure／prompt invalidation、有效 outbox notification、cancel suppression 與 late-send inactive binding。這些情境不使用真 Telegram 或 provider credential，也不呼叫 Pi runtime。

本文件記錄的是 production wiring 實作對照，不把 fake tests 當成外部驗收。

#### 第五階段歷史驗證紀錄（數字保留；不代表第六階段驗收）

真 Pi CLI offline smoke 是獨立檢查，只稽核 metadata、RPC state、history 與 prompt boolean；不送 prompt、不呼叫 tool/model、不連網。前次中間 quality pass 指定 focused tests 退出碼 0，通過 12 個 files、100 tests。`npm run check` 退出碼 1；它先通過 `format:check`，再於未授權的 `test/controller/service.test.ts:1256`、`:1259` 因 `@typescript-eslint/require-await` 失敗。依任務限制未改該檔，也未繼續 typecheck、全套 tests 或 build。因此 build 後 gated Pi CLI smoke 未執行。命令、退出碼與完整 logs 位於 `.test-artifacts/pi-flow/wiring-final/logs/`。這不代表真實 provider request、真 Telegram、部署或 backup／restore 已驗證；Node 24 矩陣也未驗證。

本次 wiring-complete 最終驗證：`PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm exec vitest run test/flow/store.test.ts` 退出碼 0，通過 1 個 test file、12 個 tests。`PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm run check` 退出碼 0；`format:check`、`lint`、`typecheck`、Vitest 與 `build` 全部通過。全套測試通過 23 個 files（22 passed、1 skipped）及 194 個 tests（193 passed、1 skipped）。Build 成功後，gated `PI_FLOW_CLI_SMOKE=1 npm exec vitest run test/flow/pi-cli-smoke.test.ts` 退出碼 0，通過 1 個 file、1 個 test。Source guard、build dist guard 與 tool variant 的 effective-prompt audit 各有 5 個 boolean，值均為 true；只彙整路徑與布林值至 `.test-artifacts/pi-flow/wiring-complete/smoke-audit-summary.json`，不保存或輸出 prompt 內容。

先前記錄的 lint failure 與 restart fixture failure 都是中間過程，不是最終結果。本次 full check 的 lint 階段通過；本任務沒有修改 `test/controller/service.test.ts`。Restart fixture 現在在 enqueue transaction 內先將 Job 設為 `WAITING_INPUT`，符合 prompt sendability。Terminal pending prompt 以 raw SQL 取得指定 row ID；restart 前確認 row 仍為 `PENDING`、沒有 cancellation、不可投遞且不在 `dueOutbox`。Restart 後確認 cancellation 已寫入，且 cancellation 不計為 delivery failure。首次 post-edit full check 曾因 `test/flow/store.test.ts` 格式不符而停在 `format:check`；只格式化該授權測試後，重新執行的 focused test 與 full check 均通過。命令及完整 logs 位於 `.test-artifacts/pi-flow/wiring-complete/logs/`；baseline 與既有狀態記錄位於 `.test-artifacts/pi-flow/wiring-complete/baseline/`。此 CLI smoke 只驗離線 metadata、RPC、history 與 boolean audit；不送 prompt、不執行工具或模型、不連網。文件更新後，最後執行 `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 FLOW_TEST_API_KEY=synthetic-only-flow-key npm run format:check` 與 `git diff --check`，兩者退出碼均為 0；完整 logs 位於 `.test-artifacts/pi-flow/wiring-complete/logs/final-format-check.log` 與 `git-diff-check.log`。真實 Telegram、provider request、部署、backup／restore 與 Node 24 矩陣仍未驗證。

## 13. 第六階段：Pi OAuth source 與 Flow child 隔離

### 13.1 Config 與 production validation

`FlowRuntime.auth` 是可選設定。明確的 `api-key` mode 要求 `apiKeyEnv` 環境變數名稱；明確的 `pi-login` mode 要求 `apiKeyEnv: null`。省略 `auth` 保留舊 API-key-only 行為，不猜測來源，也不在兩種模式間 fallback。effective runtime 依 Agent Node override 優先於 Flow runtime。只有至少一個 effective Agent Node 使用 `pi-login` 時才需來源檔。

Bot mode 從 `PI_FLOW_AUTH_FILE` 取得來源路徑；此設定依 Controller config cwd 解析，不展開 `~`／`$HOME`，也不搜尋一般 Pi 目錄。來源不得位於本 Controller 的 `dataDir/pi` 本身或其私有 Session subtree，避免 snapshot cleanup 刪除或覆寫來源；其他 `dataDir` 路徑不受此限制。health mode 不讀取此變數。Server 在建 app、resources、HTTP listener 前驗證有效 auth config。`ControllerService` 在建立 Registry／FlowStore 前再次驗證，不因注入 fake runtime 而略過。這些檢查不讀 auth file、不執行 OAuth、不連網。相對路徑只在 config parse 時形成 lexical absolute path；真正建立 snapshot 時還會要求來源及 parent 是 canonical absolute path。

OAuth 範例 `config/pi-flow.oauth.example.json` 沿用 API-key 範例的 graph、模型、thinking、tools 與 limits，只將三個 Flow runtime 設為 `auth.mode: "pi-login"`、`apiKeyEnv: null`。預設 `config/pi-flow.example.json` 仍明確使用 API-key mode。兩個範例皆不含 credential 值，且固定 `openai/gpt-6-luna/max`；此 metadata 不保證本機帳號具備該 model/provider access。

### 13.2 Source validation、token rotation 與 cancellation

只在 Agent Node 準備執行時載入 source。來源必須是 bounded JSON、同 UID、regular file、0600、無 symlink；路徑和 parent 必須 canonical，且來源不得位於本 Controller 的 `dataDir/pi` 私有 Session subtree。來源與 parent 必須可寫，供 Pi native lock 和 OAuth rotation 使用。Controller 不建立、chmod、登入或自動修復來源檔。只提取當次 provider credential；其他 provider JSON values 原樣保留於語意內容。Pi 寫回時可能重新排版整份 JSON。與不使用同一 native lock 的外部 writer 不保證安全。

Auth broker 使用 `@earendil-works/pi-coding-agent@1.2.0` 的 `FileAuthStorageBackend.withLockAsync()`。它是 Pi native、pinned-version internal storage interface，不是 Pi SDK Agent runtime。Broker 先驗證 source，再取得 native lock，並確認 lock 讀值和 validated bytes 相同。只在 lock 內透過 `@earendil-works/pi-ai@1.2.0` 的 builtin provider OAuth resolver 和 InMemoryCredentialStore 呼叫 OAuth resolution；不載入來源以外的 Pi auth/settings，不發 model/provider request。Broker 設定 `deliveryValidityMs = max(5 minutes, nodeTimeoutMs + 60 seconds) + nodeTimeoutMs`，並要求 `getAuth()` 再提供 60 秒 startup margin，避免短期 access token 在 Node 交付途中過期。

外部 abort 可中止 native lock wait。進入 lock callback 後會解除這個取消傳遞。OAuth refresh 若已開始，Broker 必須持鎖等待 resolver 完成，再以 native backend 持久化已旋轉 refresh token、釋放鎖，最後回傳固定失敗碼。Node timeout／dispose 因而可延遲完成；它們不得丟棄單次 refresh token，也不得在 token rotation 尚未寫回時 spawn Pi child。若在 callback 前取消，不刷新來源。

### 13.3 Child snapshot 與資料邊界

Pi-login runtime 只把當次 provider 的 access token、expiry 與 provider metadata 寫入 Session-private 0600 snapshot。Snapshot 的 refresh token 清空，且不包含來源 auth path。Pi child 只看見其隔離 HOME／XDG、workspace、history、private settings／prompt／guard 及 snapshot；不會看見個人 Pi config、其他 Extension、MCP、skills、templates、themes、AGENTS／SYSTEM 或來源檔路徑。Child exit/join 後清理 snapshot；若 parent crash 留下暫存檔，下次使用該 Session 前先處理。Credential 絕對清除不保證；child 仍和 Controller 在同 UID 權限下，Pi 也不是 OS sandbox。

API-key Node 不建立或讀取 OAuth source。Pi-login 無 credential、source missing/invalid、login required、refresh failure、snapshot invalid、unsupported provider 或 model unavailable 都回傳固定分類。Executor 只允許五個 auth stable codes 寫入 Job/outbox，不保存 raw auth JSON、source path、OAuth/provider exception 或 SQLite exception。登入失效後須由 operator 修復一般 Pi 登入 source，並建立新 Job；READY 只代表 Controller readiness，不保證 OAuth/provider readiness。

### 13.4 第六階段測試與界線

測試只使用 synthetic auth JSON／token 和 temporary 0600 source；固定 Pi 1.2.0 native file lock 測試不呼叫真 provider。Coverage 包含 180 秒 Agent Node timeout 與約七分鐘來源 token、native lock wait cancellation、timeout／dispose cancellation、refresh 開始後 token rotation 即使取消仍寫回、child 不取得來源 path／refresh token、API-key mode 不讀來源、effective Node override、bot／health config 與 Server／Service production wiring。Wiring 回歸使用真 `PiCliRpcRuntime`，傳入 malformed synthetic source，要求在 spawn／provider request 前以 `FLOW_AUTH_SOURCE_INVALID` 失敗。Fake Runtime 以 Job/outbox 驗證五個 auth stable codes 的安全分類。

所有自動化測試使用離線旗標與合成 credential。沒有真實 OpenAI request、OAuth 網路 refresh、Telegram request 或部署驗收。歷史第四、第五階段測試數字只代表各自原階段執行，不等於第六階段結果。Pi 1.2.0 internal auth interface 版本升級前必須重新檢查 source lock、refresh persistence、cancellation 和 snapshot 清理。
