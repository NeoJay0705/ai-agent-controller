# Pi Agent 單次 Prompt 執行流程與程序邊界分析

文件日期：2026-10-13  
原始碼追查日期：2026-10-13  
基準套件：本機 @earendil-works/pi-coding-agent 1.1.0 與其相依的 Pi 套件

本機 CLI 已由 0.80.7 升級至 1.1.0。ai-agent-controller 沒有 Pi 依賴，本次不把 Pi 導入 controller。本文依固定 v1.1.0 tag 的靜態原始碼分析，不依 main 分支。

本次驗證涵蓋既有 CLI 啟動與依賴完整性、模型／thinking 靜態核對、角色與父 policy 檔解析，以及文件格式。本文未進行真實模型 request 或 extension 整合測試。

## 1. 目標與需求完整性

目標：Pi 1.1.0 本機升級與執行流程文件同步。

需求足以進行靜態追查。範圍包括 prompt 主流程、模型與工具迴圈、重試、compact、status、session persistence、OS 程序邊界及錯誤處理。

本文的假設如下：

- 「Pi agent」指本機的 pi-coding-agent 1.1.0。
- 「process」分成程式處理階段與 OS 程序。
- 「status」分成工作指示、終端狀態、RPC 狀態及 session 統計。
- 沒有核對使用者的 extension 設定。因此，本文不推定自訂 extension 的模型請求或其他副作用。

若需求要求實際 PID、網路請求時序或特定 extension 的行為，則需要另行做動態追蹤。

## 2. 版本與原始碼位置

ai-agent-controller 本身沒有 Pi 原始碼或 Pi 依賴。專案根目錄的 [package.json](package.json) 沒有 Pi 依賴。[src/app.ts](src/app.ts) 目前只有 /health HTTP 路由。專案有 controller 模組，但尚未接入 Pi。

本機 Node.js 為 v22.21.1。Pi v1.1.0 要求 Node.js >=22.19.0。CLI bundle 入口為 dist/bundle/cli.js。發布包也包含未 bundle 的 dist/core、dist/modes 等程式碼。本文用 PI_ROOT 代表本機發布包根目錄：

/home/neojhou/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent

目錄概觀：

```text
PI_ROOT/
+-- dist/
|   +-- bundle/
|   |   +-- cli.js
|   +-- core/
|   +-- modes/
|   +-- utils/
+-- node_modules/
    +-- @earendil-works/
        +-- pi-agent-core/
        +-- pi-ai/
        +-- pi-tui/
```

Node 與 npm 的安裝方式會影響本機絕對路徑。官方 v1.1.0 原始碼固定在 [v1.1.0 tag](https://github.com/earendil-works/pi/tree/v1.1.0)。本文列出的原始碼路徑均以該 tag 為準。

## 3. 組件責任與程序邊界

| 組件            | 主要責任                                                                    |
| --------------- | --------------------------------------------------------------------------- |
| pi-coding-agent | 輸入、session、extensions、compact、模型 runtime 與 retry。                 |
| pi-agent-core   | Agent 與工具迴圈。                                                          |
| pi-ai           | Provider 相容層與串流。                                                     |
| pi-tui          | 終端畫面。                                                                  |
| SessionManager  | 保存 session 訊息、分支與 compaction，並產生模型使用的 session projection。 |
| ModelRuntime    | 管理模型通道與 provider 呼叫。                                              |

上述模組在同一個 Pi Node 程序內執行。模型推論在模型服務端。服務端可能是遠端服務，也可能是本機 endpoint。因此，不能一概將模型描述成遠端子程序。

Bash 工具與 !command 會建立 shell 子程序。命令也可以再建立程序。Codemode 在 worker thread 內執行 QuickJS/WASM sandbox；worker thread 與 Pi 共用 OS process。MCP stdio transport 會依設定啟動 MCP server 子程序。MCP HTTP transport 會依設定連接外部 server。Extension 是否建立其他程序，取決於其實作。圖片縮放也可使用 worker thread；worker thread 不是獨立 OS process。

### 3.1. 哪些處理會送出模型請求

| 處理                                                   | 直接呼叫鏈                                                                                                                                    | 模型請求                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 一般回答與工具後續 turn                                | runLoop -> streamAssistantResponse -> agent.streamFunction -> ModelRuntime.streamSimple -> prepared.provider.streamSimple -> provider adapter | 每個需要 assistant 回應的 turn 可有一次邏輯請求。                                                                                   |
| Compact 歷史摘要                                       | compact -> generateSummaryWithUsage -> completeSummarization -> agent.streamFunction -> ModelRuntime.streamSimple                             | 需要歷史摘要時送出。                                                                                                                |
| Compact split-turn 前段摘要                            | compact -> generateTurnPrefixSummary -> completeSummarization -> agent.streamFunction -> ModelRuntime.streamSimple                            | Split turn 且有前段內容時送出。它可能比歷史摘要多一次請求。                                                                         |
| 可選分支摘要                                           | navigateTree -> generateBranchSummary -> completeSummarization -> agent.streamFunction -> ModelRuntime.streamSimple                           | 有內容需要摘要，且 extension 未提供摘要時送出。                                                                                     |
| Bug report 摘要                                        | AgentSession.summarizeForBugReport -> generateBugReportSummary -> completeSummarization -> agent.streamFunction -> ModelRuntime.streamSimple  | 使用者在 /bug 流程選擇摘要時送出。                                                                                                  |
| CacheWarmer                                            | CacheWarmer -> ModelRuntime.streamSimple -> prepared.provider.streamSimple                                                                    | 依 policy、model 與 cache 狀態按需送出一個 token 的請求。請求設 maxTokens: 1、maxRetries: 0。成功時記錄 appendUsage('cache_warm')。 |
| Session 自動重試與 overflow 恢復                       | _runAgentPrompt -> Agent.continue -> runAgentLoopContinue -> runLoop -> streamAssistantResponse                                               | 重新進入一般回應路徑。                                                                                                              |
| Status、session 統計、JSONL 保存與內建 read/write/edit | 狀態讀取、檔案保存或工具函式                                                                                                                  | 本身不送出模型請求。工具完成後，agent loop 可能再發出請求。                                                                         |
| Virtual routing 與自訂工具                             | 依 routing 或工具實作                                                                                                                         | 可以呼叫 classifier 或其他模型服務。本文不推定請求數。                                                                              |
| Codemode 模型 API                                      | createModelGlobals -> models.classify / models.generateImages -> ModelRegistry facade -> ModelRuntime                                         | 只有 codemode 已載入且執行程式呼叫 API 時送出；不是一般 chat provider stream 路徑。                                                 |

一般回答、compact 摘要、分支摘要與 bug 摘要使用 Agent 的 streamFunction，再進入 ModelRuntime。Agent 建構 option 名稱為 streamFn。CacheWarmer 直接呼叫 ModelRuntime。低階 fallback 可使用 pi-ai 的 completeSimple 或 streamSimple；這不是一般 SDK 固定路徑。

```text
Functions run in Pi Node process; model services run outside Pi.
--------------------------------------------------------------
[M] streamAssistantResponse()---------------+
[C1] generateSummaryWithUsage()-------------+
[C2] generateTurnPrefixSummary()------------+
[B] generateBranchSummary()-----------------+
[D] generateBugReportSummary()--------------+--> agent.streamFunction()---------------------+
[W] CacheWarmer-----------------------------------------------------------------------------+--> ModelRuntime.streamSimple()
                                                                                            -> prepared.provider.streamSimple()
                                                                                            -> provider adapter
                                                                                                 |-- MODEL REQUEST --> [Chat model service]
                                                                                                 |<-- MODEL RESPONSE --[Chat model service]
                                                                                                 v
                                                                                            stream result -> original caller

[X] codemode
    -> ModelRegistry.classify/generateImages()
    -> ModelRuntime.classify/generateImages()
    -> classifier/image provider
          |-- MODEL REQUEST --> [Classifier/image service]
          |<-- MODEL RESPONSE --[Classifier/image service]
          v
    result -> codemode caller
```

[M]、[C1]、[C2]、[B] 與 [D] 經 Agent stream function；[W] 直接進入 ModelRuntime.streamSimple。兩者合流後使用一般 chat provider 路徑。[X] 走獨立的 classifier/image 通道，不接入 chat stream。每個通道中的 request 與 response 箭頭都指向同一 endpoint；不同通道也可能使用相同 endpoint。模型服務在 Pi 程序外，可能是遠端服務或本機 endpoint。沒有標示獨立程序的呼叫者在同一個 Pi Node process 內。

CacheWarming 預設 mode 為 streaming，可設為 off、streaming 或 always。設定來自 global settings，可能產生模型費用。streaming mode 會在 agent settle 時停止；只有 always mode 可在 settle 後於 idle 時繼續。執行前還會依 policy、model 與 cache 狀態判斷。CacheWarmer 錯誤採 best-effort，不中斷主 loop。成功時記錄 usage。它不產生 assistant 對話。

摘要使用專用 summarization context，通常不經過一般工具迴圈。completeSummarization 使用 cacheRetention: 'none'，並包含 retryAssistantCall。邏輯摘要請求可能有內部 retry；provider retry 也可能重送。因此，邏輯請求數不等於 HTTP 嘗試數。

getSessionStats 統計 session entries，包含 compacted history、assistant usage、tool result usage、compaction/branch summary usage 與 usage entries（例如 cache_warm）。它不保證等於 provider 帳單；failed attempts、provider retries 或 extension 自行發出的請求可能不在統計內。

### 3.2. Status 的程序邊界

Status 讀取本身不送出模型請求。Program status reporter 將內部狀態交給 terminal。CacheWarmer 是獨立的模型請求來源，不應畫成 status 讀取的下游行為。

## 4. 單次 prompt execution flow

輸入先由互動模式分流。一般 prompt 進入 AgentSession.prompt。以下流程顯示主要分支：

```text
User input
  -> defaultEditor.onSubmit(text)
       +-> built-in /compact or /session
       |     -> run built-in command
       +-> !command
       |     -> executeBash -> shell subprocess
       +-> TUI session is compacting
       |     -> queue input in TUI -> return
       +-> ordinary input
             -> AgentSession.prompt
             -> extension command hook
                  +-> handled: return
                  +-> continue
             -> compacting?
                  +-> YES: SDK call throws
                  +-> NO: continue
             -> input hook
                  +-> handled: return
                  +-> transform: continue with transformed input
                  +-> continue unchanged
             -> expand skills/templates
             -> isStreaming?
                  +-> YES: queue steer/followUp (required option) -> return
                  +-> NO: continue
             -> flush pending input
             -> validate model/auth
             -> _checkCompaction(lastAssistant, false)
                  +-> needed -> [C] summary request (section 6) -> return---------------+
                  +-> not needed--------------------------------------------------------+
                                                                                        |
             -> before_agent_start <----------------------------------------------------+
             -> normalize images
             -> build user/custom/system/tool-loadout update messages
             -> _runAgentPrompt
             -> Agent.prompt
```

before_agent_start 可選 model、system prompt options、tools 與 custom messages。Compact 中直接呼叫 SDK prompt 會 throw；TUI 可在 UI 自身排隊。Prompt precheck 只在需要時 compact。Compact 後會回到 before_agent_start，再建立訊息。

### 4.1. 一般模型請求子流程

```text
[M] prepareRequest()
  -> SessionManager.buildSessionProjection() (authoritative session projection)
  -> virtual routing (may compact)
  -> streamAssistantResponse()
  -> transformContext()
  -> extension context (non-system messages)
  -> context_with_system (full context)
  -> convertToLlm()
  -> normalizeContext(TranscriptContext)
  -> agent.streamFunction()
  -> ModelRuntime.streamSimple()
  -> prepared.provider.streamSimple()
  -> provider adapter
       |
       |-- MODEL REQUEST ---> [Model service]
       |<-- RESPONSE STREAM --[Model service]
       |
       v
  response stream -> streamAssistantResponse()
       |
       v
  assistant response -> return to [TURN] controller
```

prepareRequest 在 streamAssistantResponse 前執行。SessionManager.buildSessionProjection 是權威 session projection。Virtual routing 可能執行 compact。Provider request、payload、headers、response 與 stream hooks 見第 10 章；headers 與 payload 的相對順序依 provider 路徑。

### 4.2. Turn、工具與 queue 控制迴圈

入口鏈：

```text
Agent.prompt -> runPromptMessages -> runWithLifecycle -> runAgentLoop -> runLoop -> [TURN]
```

每輪先準備下一個 assistant 回應。prepareNextTurn 會呼叫 _compactBeforeNextAssistantResponse 檢查 compact 門檻，並重新載入 model、tools 與 context。需要 compact 時，摘要後回到目前準備步驟，再注入 prepared/queued messages。finishTurn 在 core turn_end 前執行；之後才套用 turn decision。

```text
[TURN] <-----------------------------------------------------------------------------------------------+
previous turn?                                                                                         |
  +-- YES -> prepareNextTurn()                                                                         |
  |          -> _compactBeforeNextAssistantResponse()                                                  |
  |          -> if needed: [C] compact; resume current preparation step                                |
  |          -> reload model/tools/context                                                             |
  +-- NO                                                                                               |
  |                                                                                                    |
  v                                                                                                    |
inject prepared/queued messages -> [M]                                                                 |
  |                                                                                                    |
  v                                                                                                    |
assistant response                                                                                     |
  +-- error/aborted -> finishTurn -> core turn_end -> agent_end -> [POST]                              |
  +-- normal response                                                                                  |
  |                                                                                                    |
  v                                                                                                    |
[T] tool calls if present; otherwise skip [T]                                                          |
  |                                                                                                    |
  v                                                                                                    |
finishTurn (session actionable turn_end boundary)                                                      |
  |                                                                                                    |
  v                                                                                                    |
core turn_end                                                                                          |
  |                                                                                                    |
  v                                                                                                    |
decision.action == end?                                                                                |
  +-- YES -> agent_end -> [POST] (section 4.3)                                                         |
  | NO                                                                                                 |
  v                                                                                                    |
getSteeringMessages()                                                                                  |
hasMoreToolCalls or steering pending?                                                                  |
  +-- YES: set pending input---------------------------------------------------------------------------+
  | NO                                                                                                 |
  v                                                                                                    |
getFollowUpMessages()                                                                                  |
follow-up pending?                                                                                     |
  +-- YES: set pending input---------------------------------------------------------------------------+
  | NO                                                                                                 |
  v                                                                                                    |
decision.action == continue?                                                                           |
  +-- YES: set one context-only continuation-----------------------------------------------------------+
  | NO
  v
agent_end -> [POST] (section 4.3)
```

工具分支：

```text
[T] tool calls present
  -> stopReason is length?
       +-> yes -> failToolCallsFromTruncatedMessage -> error toolResults
       +-> no -> executeToolCalls
                  -> prepareToolCall (validate / beforeToolCall)
                  -> executePreparedToolCall (tool.execute)
                  -> finalizeExecutedToolCall (afterToolCall)
                  -> append toolResults
```

Length 分支不執行截斷的工具參數。一般回應不含工具時會略過 [T]。工具結果、steering 與 follow-up 訊息依圖中的 queue 路徑回到 [TURN]。Steering 在目前 tool batch 後進入下一個 assistant turn。Follow-up 輸入 enqueue 時已進入 queue；inner loop 準備停止時會取出該輸入並續跑，不是在那時才放入 queue。Steering 與 follow-up 兩個 queue 都不會因 enqueue 自動中止目前 request。只有所有 finalized 工具結果都設定 terminate === true，才停止工具的自然續跑。Error 或 aborted response 仍執行 finishTurn，但其 continue decision 不能覆寫 core exit；POST 仍會另外判斷是否 retry。

### 4.3. Session續跑與重試迴圈

agent_end 只結束一次 agent loop。Session 可能在 post-run handler 後續跑，或完成 settle boundary：

```text
_runAgentPrompt -> Agent.prompt -> agent loop [M] -> agent_end
[POST] _handlePostAgentRun() <-------------------------------------------------------------------------+
  -> retry / _checkCompaction() / queued messages                                                      |
need continuation?                                                                                     |
  +-- YES -> Agent.continue() -> core turn loop -> agent_end-------------------------------------------+
  | NO                                                                                                 |
  v                                                                                                    |
_runBeforeSettleBoundary()                                                                             |
  -> emitBoundary(agent_before_settle)                                                                 |
  -> commit drafts; check canContinue and queue                                                        |
continue requested?                                                                                    |
  +-- YES -> Agent.continue() -> core turn loop -> agent_end-------------------------------------------+
  | NO
  v
finally: flush pending input
  |
  v
agent_settled({aborted}) -> exit
```

成功排定重試會續跑，不再執行後續 compact 判斷。Overflow 或 queue 也可能要求續跑。取消時會略過續跑。agent_before_settle 可提交 drafts 並要求續跑。agent_settled 表示本輪 session 工作收束；它不保證 background timer 已停止。CacheWarmer 可依 policy 在 settle 後繼續工作。錯誤與取消差異見第 8 章。

## 5. 事件、排隊與完成條件

Pi 將 Agent 事件送到 session、extensions 及 UI/RPC 訂閱者。訊息結束時會更新持久化記錄：

```text
Agent.processEvents
  -> AgentSession._handleAgentEvent
       +-> extensions
       +-> subscribers (UI / RPC)
       +-> message_end
             -> SessionManager.appendMessage
             -> JSONL
```

agent_end 表示一次 agent loop 結束。agent_settled 表示 session 本輪工作已收束，包含 retry、compact、queue continuation 與 settle boundary。agent_settled({aborted}) 也不等於 status error。只等待 agent_end 不代表整輪工作已完成。

RPC prompt 入口使用同一個 session prompt 流程。成功 response 表示 preflight 通過，輸入已開始執行、排入佇列，或已由 extension 處理。這不表示模型已完成回答。呼叫端須讀取後續事件。

AgentSession.isStreaming 表示本輪 session 工作仍在進行，也包含 post-run continuation。它不是單純的 HTTP 串流狀態。

### 5.1. Messages 的三層資料

SessionManager entries 是已完成歷史的依據；agent.state.messages 包含執行狀態與串流中的 partial message。一般 agent 回答的每次模型請求，會經 prepareRequest 重建目前分支的 session projection，再轉成 provider messages。摘要與 cache warming 使用各自的 context，見第 3.1 節。

| Layer             | 內容與來源                                                                                                                                           | 用途                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Session entries   | `id`、`parentId`、`timestamp`、`type`；`leafId` 選定目前分支。                                                                                       | 預設保存為 JSONL；`SessionManager.inMemory` 不落盤。                            |
| Runtime messages  | `user`、`assistant`、`toolResult`、`system`、`custom` 等訊息。                                                                                       | Agent 執行狀態；`message_start` / `message_update` 可包含串流 partial message。 |
| Provider messages | `prepareRequest` 從目前分支 entries 建立 projection，套用最新 compaction 與 context edit，再經 context hooks、`convertToLlm` 與 `normalizeContext`。 | 供當次 provider request 使用，不等同於原始 entries 或 runtime state。           |

兩條資料路徑分開處理：

```text
Persist a completed message:
message_end -> AgentSession._handleAgentEvent()
  -> extension handlers
  -> appendMessage()
       -> SessionManager entries
       -> JSONL (if persisted)

Build context for the next provider request:
prepareRequest()
  -> SessionManager.buildSessionProjection()
  -> context / context_with_system hooks
  -> convertToLlm() -> normalizeContext()
  -> ModelRuntime.streamSimple()
       |-- MODEL REQUEST --> [Model service]
       |<-- MODEL RESPONSE --[Model service]
       v
  -> message_start / message_update / message_end
```

`message_end` 在 extension 處理完成後才呼叫 `appendMessage`；`custom_message` 另用 `appendCustomMessageEntry`。串流中的每次 token update 不會各寫一條 JSONL。`entry.type = "custom"` 是 extension state entry，本身不進 context。`entry.type = "custom_message"` 會轉成 `message.role = "custom"`，再進入模型 context。Usage entries 只供統計，不進 context。

Compact 摘要會保存為 compaction entry。Projection 將摘要轉成 `compactionSummary`，`convertToLlm` 再產生帶 summary wrapper 的 user message。直接修改 `agent.state.messages` 不會替換下一次 provider context；更新 SessionManager 後呼叫 `refreshContext`。

## 6. Compact

### 6.1. 壓縮入口與摘要請求

Auto、手動及下一個 assistant turn 前的 threshold check 會進入 compact path。手動 compact 先 abort 並等待目前 Agent 工作，不會重啟被中斷的 turn。

```text
auto path:
_checkCompaction or _compactBeforeNextAssistantResponse
  -> _runAutoCompaction -----------------------------+
                                                    |
manual path:                                        |
/compact or RPC compact                             |
  -> session.compact                                |
  -> abort current agent and wait                   |
  --------------------------------------------------+
                                                    v
                                         prepareCompaction
                                                    |
                                                    v
                                         session_before_compact
                                                    |
                                         cancelled or extension summary?
                                           +-> cancelled -> report -> compaction_end
                                           +-> summary supplied -> skip model request
                                           +-> default -> compact() -> summaries
```

Default 摘要路徑會依內容需求順序執行。兩種摘要不一定都需要：

```text
default path -> compact()
  |
  v
history summary needed?
  +-- YES --> generateSummaryWithUsage() --> [C1] summary request --> history summary
  +-- NO ---> skip C1
  |
  v
split-turn prefix needed?
  +-- YES --> generateTurnPrefixSummary() --> [C2] summary request --> prefix summary
  +-- NO ---> skip C2
  |
  v
merge available summaries
  -> appendCompaction()
  -> SessionManager.buildSessionProjection()
  -> _refreshFinalizedContext() / refreshContext()
```

共用摘要請求子流程：

```text
[C1] generateSummaryWithUsage() or [C2] generateTurnPrefixSummary()
  -> completeSummarization()
  -> agent.streamFunction()
  -> ModelRuntime.streamSimple()
  -> prepared.provider.streamSimple()
  -> provider adapter
       |
       |-- MODEL REQUEST ---> [Model service]
       |<-- RESPONSE STREAM --[Model service]
       |
       v
  stream.result() -> completeSummarization() -> original summary caller
```

[C1] 與 [C2] 是不同的按需請求，依需要依序執行。Response 回到對應摘要函式。沒有 history 內容的 split turn 可能只執行 prefix 摘要。若未提供 agent.streamFunction，低階 fallback 可使用 completeSimple 或 streamSimple。Extension 可以提供摘要，這時會略過摘要模型請求；也可以取消 compact。

completeSummarization 使用 cacheRetention: none，並包含 retryAssistantCall。內層 summarization retry 會發出 summarization_retry_* 事件；它與 Agent 回答 retry 是不同路徑。摘要失敗或取消會發出對應事件，不代表整體操作具有 transaction rollback。

### 6.2. 壓縮後回到哪裡

```text
[C] compact path completes
  +-> pre-prompt check
  |     -> return to prompt flow
  |     -> before_agent_start -> build messages -> [TURN]
  +-> prepareNextTurn threshold check
  |     -> finish current preparation step
  |     -> inject prepared/queued messages -> [M]
  +-> post-run overflow or queue
  |     -> return true -> Agent.continue() -> [TURN]
  |     -> agent_end -> [POST] (section 4.3)
  +-> manual or post-run threshold, no queue
        -> return / wait for next input
        -> no ordinary answer request
```

prepareNextTurn 的 threshold compact 完成後，回到目前準備流程並完成該步驟，再將 prepared/queued messages 注入 [M]；不會回到 [TURN] 頂端重做 preparation。Turn 間已有續跑的 threshold compact 會接回當前準備流程。Post-run 的 [POST] 路徑接回第 4.3 節。Manual 或 post-run threshold compact 若沒有 queue，會等待下一筆輸入，不會發出一般回答請求。

Compact 會新增 compaction record，保留原始 JSONL 歷史。之後模型使用 SessionManager 建立的 session projection。不要以直接指定 agent.state.messages 代替 authoritative session 更新。

| 情況              | 行為                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手動 compact      | 先 abort 並等待目前 agent 工作；不重啟被中斷的 turn。                                                                                                                   |
| Threshold compact | 每次下一個 assistant response 前檢查門檻；檢查不表示每輪都會 compact。                                                                                                  |
| Overflow recovery | Context overflow 或 recoverable length 可進行一次 compact-and-retry；已成功完成的回答可只 compact。不是每種 length 都會 compact；摘要失敗不新增成功 compaction record。 |
| 設定              | 預設 reserveTokens: 16384、keepRecentTokens: 20000；可依 model 覆寫。門檻為 contextTokens > contextWindow - reserveTokens。                                             |
| 摘要              | 歷史與 split-turn prefix 可能各有一次摘要請求；extension 可取消或提供摘要。                                                                                             |

### 6.3. Compact 如何改變 messages

以下例圖省略 setup entries。C1 的 `summary` 是文字摘要，不是原訊息的複製：

```text
Before:
  U1 A1 U2 A2 U3 A3

Append:
  C1 {summary: U1..A2, firstKeptEntryId: U3.id}

Stored entries:
  U1 A1 U2 A2 U3 A3 C1

Projected messages:
  [system/tool checkpoint, if present] + summary(C1) + U3 A3

After more input, stored entries:
  U1 A1 U2 A2 U3 A3 C1 U4 A4

Next projection:
  checkpoint + summary(C1) + U3 A3 U4 A4
```

最新 compaction entry 的 `systemMessage` 保存當前 system/tool checkpoint；`firstKeptEntryId` 指向保留尾段的起點。Compact 不刪除舊 JSONL entries，projection 只採目前 `leafId` 所在的 branch path，同一檔案中的其他 branches 不會全送給模型。

Compaction entry 的主要欄位為 `summary`、`firstKeptEntryId`、`tokensBefore`、可選的 `systemMessage`、`usage` 與 `details`。下一次 compact 以 previous summary 加上新要縮減的內容更新摘要，不會每次重送整個檔案。`keepRecentTokens` 是 token 切分預算，實際切分受訊息邊界影響，不代表固定保留筆數；split-turn 可能按需再送第二個 prefix summary request。失敗或取消的記錄與 rollback 行為見第 8 章。

## 7. Status

1.1.0 沒有內建 /status。內建狀態分為 UI 工作指示、footer、RPC/session 統計與 OSC 7501 program status：

| 介面                          | 資料                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| Interactive event handler     | 工作、retry、compact 與工具指示。                              |
| Footer                        | 模型、context、tokens、成本、git 與 extension status。         |
| ctx.ui.setStatus              | Extension 設定的文字。                                         |
| RPC state                     | isStreaming、isCompacting 與 pending counts。                  |
| /session 與 RPC session stats | 根據 session entries 計算 usage 與狀態，可顯示 cache warming。 |
| OSC 7501                      | idle、working、blocked、done、error program status。           |

PI_PROGRAM_STATUS=1 或 PI_PROGRAM_STATUS=0 可覆寫 terminal 能力偵測。UI prompt 與 login 狀態可顯示為 blocked。ProgramStatusReporter 依事件更新內部狀態，並呼叫 terminal.setProgramStatus。

```text
[session / agent events] -> handleEvent -> UI render
[get_state / get_session_stats] -> read state -> RPC response
[footer git branch] -> git subprocess -> cached branch -> footer render
[ProgramStatusReporter] -> currentStatus -> terminal.setProgramStatus
```

以上讀取與狀態輸出路徑本身沒有 MODEL REQUEST。CacheWarmer 有獨立 timer，可能在 agent settle 後按 always policy 發出模型請求；這不是 status 讀取造成的請求。

Agent settle aborted 會映射到 idle。成功完成會映射到 done。最後 assistant error 可映射到 error；若 retry 成功，狀態可再更新為 done。因此，agent_settled({aborted}) 與 program status error 不等價。

getSessionStats 統計 session entries，包含 compacted history、assistant usage、tool result usage、compaction/branch summary usage 與 cache_warm 等 usage entries。它不保證等於 provider 帳單；failed attempts、provider retry 或 extension 自行發出的請求可能不在統計內。

## 8. 錯誤處理

| 情況                                              | 處理方式                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 沒有選定模型或沒有認證                            | Preflight 失敗，不開始一般模型工作。                                                          |
| Agent 正在處理 prompt，但未指定 streamingBehavior | SDK 呼叫會拋錯。明確指定後，輸入可依 steer/followUp 規則排隊。                                |
| 暫時性模型錯誤                                    | Session retry 依設定執行；Provider 也可能有自己的 retry。實際次數依對應設定。                 |
| Recoverable length                                | 可以 compact 並 retry 一次。不是每種 length 錯誤都會 compact。                                |
| 工具不存在、參數無效或執行失敗                    | 產生 error toolResult，交由 loop 決定後續。                                                   |
| Response 的 stopReason 是 length                  | 不執行該 response 的 tool calls，以避免使用截斷參數。                                         |
| Tool call handler 拋錯                            | 轉為工具錯誤結果，不執行該工具。                                                              |
| user_bash handler 拋錯或回傳無效值                | 終止命令，不 fallback 到本機 shell。回傳 undefined 才繼續後續 handler 或預設執行。            |
| Boundary 要求續跑但沒有 runnable context          | 發出 extension error，不續跑。                                                                |
| Bash timeout 或取消                               | Timeout 可選，預設沒有 timeout。發生 timeout 或取消時會終止 process tree。                    |
| 摘要失敗或取消                                    | 發出對應事件。只有成功摘要才會 append 成功的 compaction 記錄；不表示 transaction rollback。   |
| Session 持久化失敗                                | 同步檔案寫入錯誤向上拋出。沒有資料庫式 rollback。                                             |
| 取消工作                                          | Agent abort、retry abort 與專用 compact abort 是不同路徑。一次 abort 不保證取消所有類型工作。 |

Hook 的錯誤處理依 event 而定。不能概括成所有 hook 都忽略錯誤或都會終止工作。

## 9. 設計取捨與適用限制

本文依固定的 v1.1.0 tag 分析，不代表其他版本或使用者自訂設定。

摘要可以減少後續 context，但會增加時間與模型用量，也會省略部分原始內容。下一個 assistant response 前會檢查 compact 門檻，但不是每個 turn 都會 compact。

工具預設 parallel 執行。整體 execution mode 設為 sequential，或同一批包含 executionMode: sequential 的工具時，整批依序執行。具有副作用的工具可依需求設定順序。Extension 與同步 I/O 可能增加延遲。Extension 與 Pi 共用 Node 程序權限；本文不將其描述成 sandbox。

JSONL 保留 session 歷史與 compaction 記錄，但不提供資料庫交易。CacheWarmer idle timer 可在 agent settle 後繼續執行，因此 agent_settled 不表示所有背景工作停止。Codemode 的 QuickJS/WASM sandbox 運行於 worker thread，但與 Pi 共用 OS process。

## 10. Extension API 與 loop 時機

Extension factory 用於註冊 handler、tool 與 command。實際程式碼在 Pi Node 程序內執行，不是 sandbox。以下是型別節錄，省略相依型別的 import 與定義，不新增依賴或 import 程式碼：

```ts
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;
```

pi.on 會回傳 unsubscribe 函式。Extension 載入會等待 async factory 完成。Factory 用於註冊功能；資源應在 session_start 建立，並在 session_shutdown 清理。Handler 依載入與註冊順序 await 執行；慢 handler 會延遲串流或 turn。

### 10.1. Tool 與 context

ToolDefinition 型別節錄如下：

```ts
interface ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<TDetails>>;
}
```

ctx.executeTool 可以呼叫 nested tool。Nested tool 會走相同的 validation、hook 與 permission 路徑。事件可帶 parentToolCallId。Nested call 不會作為獨立訊息加入 transcript；calling result 會包含有界的 nestedCalls 資料。

ExtensionContext 提供唯讀的 sessionManager 介面、modelRegistry、ctx.mode、hasUI、UI/status 與 abort 等介面。modelRegistry 可供呼叫，不是唯讀介面。CommandContext 另外提供 waitForIdle、newSession、switchSession 等 user command API。這些 API 不適合在會等待自身完成的 hook 中呼叫，以免形成 deadlock。

### 10.2. Hook 時機

| Hook / event              | 執行時機與效果                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Extension command         | 可在一般輸入前處理命令並回報 handled。                                                                 |
| Input hook                | 可 handled、transform 或繼續輸入流程。                                                                 |
| before_agent_start        | 選擇 model、system prompt options、tools 與 custom messages。                                          |
| agent_start / turn_start  | Agent 或 assistant turn 開始時通知 extension。                                                         |
| context                   | 修改非 system context；修改不會自動持久化。                                                            |
| context_with_system       | 處理含 system prompt 的完整 context；修改不會自動持久化。                                              |
| before_provider_request   | 可回傳 replacement payload 取代 provider request payload。                                             |
| before_provider_headers   | 可原地修改 headers。Headers 與 payload 的相對順序依 provider 路徑。                                    |
| after_provider_response   | Provider response 回來後通知 status 與 headers。                                                       |
| provider_stream_event     | 在 provider events 正規化前收到 parsed provider event，供觀察且不持久化；await 慢 handler 會延遲串流。 |
| message_end               | 可修改將持久化的 message。                                                                             |
| tool_execution_start      | 在參數驗證與 tool_call hook 前通知工具執行開始。                                                       |
| tool_call                 | 可檢查或阻擋 tool call。                                                                               |
| Tool execute              | 工具執行函式；nested calls 使用 ctx.executeTool。                                                      |
| tool_result               | 可修改工具結果。                                                                                       |
| tool_execution_end        | 工具執行結束通知；durationMs 為 optional，未真正執行的 call 可能沒有此值。                             |
| turn_end                  | Actionable turn boundary；可提供 draft 與 continue decision。                                          |
| agent_before_settle       | Session settle 前的 actionable boundary；可提交 draft 或要求續跑。                                     |
| agent_end / agent_settled | Loop 結束與 session settle 通知；agent_settled 僅通知，不是續跑 boundary。                             |
| Compact before/after      | Compact 前可取消或提供摘要；完成後可接收結果。                                                         |

Boundary handler 可回傳 BoundaryResult：

```ts
interface BoundaryResult {
  entries?: SessionBoundaryDraft[];
  continue?: boolean;
}
```

Draft 類型包含 custom、custom_message、context_edit 與 compaction，並由 session boundary 提交。Context hook 的 transient 修改不會自動寫入 session。一般 event hook 與 actionable boundary 的錯誤處理不同；需依具體 event 判斷。

### 10.3. Steering 與 follow-up

| 行為                 | Steering                                              | Follow-up                             |
| -------------------- | ----------------------------------------------------- | ------------------------------------- |
| Queue 語義           | 對目前工具 batch 後的下一個 assistant turn 提供輸入。 | 在 inner loop 準備退出時提供輸入。    |
| 是否中止目前 request | 不會因 enqueue 自動中止目前 request。                 | 不會因 enqueue 自動中止目前 request。 |
| 執行時機             | 目前工具 batch 結束後，下一個 assistant response 前。 | 目前內層工具迴圈準備停止時。          |
| 結果                 | 進入下一次 turn。                                     | 若被取出，會使 loop 續跑。            |

Steering 與 Follow-up 是不同 queue。API 若要求 streamingBehavior，呼叫者須明確選擇 queue 行為。

### 10.4. Subagent：session fork 與 CLI 背景工作

目標名稱：Pi CLI Subagent 工作管理。需求已足以定義介面、程序與錯誤處理。本節記錄設計，不在 controller 安裝 extension 或加入 Pi 依賴。以下工具名稱與 job 狀態為建議設計，不是 Pi 內建 API。

Pi extension 可以啟動獨立 pi 子程序，指定 prompt、model 與 thinking，並追蹤結果。官方 `examples/extensions/subagent/index.ts` 已示範 `spawn()`、`-p`、`--mode json`、取消與結果解析。但是範例使用 `--no-session`，建立全新且不落盤的 context；它不 fork 父 session。範例的單次、平行與 chain 工具會等待所派工作完成後回傳，沒有 start 後立即回傳 `jobId` 的背景工作介面。

#### 10.4.1. Fork 與模型選擇

父 session 與子 session 必須使用不同檔案。`--session` 會開啟既有 session，不能用它讓兩個程序同時寫父 session。`--fork` 建立新 session 並複製來源歷史；不能與 `--no-session`、`--session`、`--continue` 或 `--resume` 同用。`--session-id` 可與 `--fork` 同用，以指定子 session ID。

命令示意如下。`PI_PARENT_SNAPSHOT` 指已固定分支與邊界的 session 檔案；其餘變數分別為已設定的模型與工作內容。這只是子程序呼叫形狀，不是已執行的測試：

```sh
pi -p --mode json \
  --fork "$PI_PARENT_SNAPSHOT" \
  --model "$PI_CHILD_MODEL" --thinking high \
  -- "Task: $PI_CHILD_TASK"
```

`--model` 可用 `provider/id:<thinking>`，例如模型 ID 後加 `:high`。明確指定 `--thinking` 時會覆蓋 suffix，實際值依模型能力限制。`-p` 代表一次執行後離開；子程序仍執行完整的模型／工具迴圈，也可能執行 retry 與 compact。

`SessionManager.forkFrom()` 複製來源檔案的全部 entries；重新載入時由檔案順序建立 leaf。因此，直接 `--fork` 父檔案不保證對應父程序目前選取的分支。啟動前須固定 source session ID、leaf ID 與快照，並選擇工具呼叫與結果完整的邊界。尚未落盤的 in-memory session 須先建立可載入的快照。不要複製仍在變動或有未配對 tool call 的歷史。Extension command 的 `ctx.fork()` 會切換目前 session，不會啟動獨立 subagent。

完整 fork 可省去重新描述背景，但會複製較多 context，並可能帶入父工作指令。全新 session 加工作摘要可降低 token 成本，但必須明確傳入必要背景。Fork 只分開對話歷史；同一 cwd 仍共用工作檔案。子結果不會自動合併回父 messages，須由 tool result 或完成通知傳回。

#### 10.4.2. Job 介面與 execution flow

| 建議工具          | 輸入與回傳                                           | 責任                                   |
| ----------------- | ---------------------------------------------------- | -------------------------------------- |
| `subagent_start`  | task、model、thinking、context mode、cwd；回傳 jobId | 驗證輸入、建立快照、啟動子程序。       |
| `subagent_status` | jobId；回傳 state、progress、error                   | 讀取工作紀錄，不自行呼叫模型。         |
| `subagent_wait`   | jobId、timeout；回傳目前 state 或完成摘要            | 有上限地等待；逾時等待不等於取消工作。 |
| `subagent_cancel` | jobId；回傳取消狀態                                  | 終止工作，並確認子程序退出。           |

父模型透過工具管理 job。Extension 在父 Node.js 程序內維護工作紀錄，子 pi 在另一個 OS 程序執行。以下圖中的 `dispatchJobTool()` 與 `spawnPi()` 為建議 extension 函式名稱：

```text
Parent process:
  AgentSession.prompt()
    |
    v
  prepareRequest() <----------------------------------------------+
    |                                                             |
    v                                                             |
  ModelRuntime.streamSimple() -> provider request                 |
    |                                                             |
    v                                                             |
  tool calls? --no--> settle / wait for input                     |
    | yes                                                         |
    v                                                             |
  dispatchJobTool(start/status/wait/cancel)                       |
    |                                                             |
    +--> tool result----------------------------------------------+
```

```text
Extension job manager                 Child process
  subagent_start()
    |
    +--> spawnPi(args, cwd) ----------> pi -p --mode json
    |                                    |
    +--> return jobId                    v
                                      AgentSession.prompt()
                                          |
                                          v
                                      prepareRequest() <------------------------------------+
                                          |                                                 |
                                          v                                                 |
                                      ModelRuntime.streamSimple()                           |
                                          |                                                 |
                                          +--> provider request                             |
                                          |                                                 |
                                          v                                                 |
                                      tool calls? --yes--> tools----------------------------+
                                          | no                                              |
                                          v                                                 |
                                      post-run compact/retry                                |
                                          |                                                 |
                                          +--> retry/continue-------------------------------+
                                          | settled
                                          v
  JSONL parser <---------------------- stdout events
    |
    +--> job state/result <----------- process close / stderr
```

圖中的 compact 若需要摘要，會另送出第 6.1 節的 [C1]／[C2] 模型請求；`prepareRequest` 也可能先做 threshold compact。此圖省略其子流程，不表示 compact 沒有模型請求。子圖是概念流程；post-run compact/retry 的 continue 條件也包含後續 queue 續跑，不表示每次完成都會 compact。

父程序的 timer 可以檢查子程序並更新 job state，這個檢查不需要模型請求。主 agent 閒置時不會自行醒來輪詢。若 agent 要在 loop 中等結果，使用有時間上限的 `subagent_wait`，再依 state 決定是否等待。若要完成時啟動主 agent，可呼叫 `pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true })`：父 agent 忙碌時排入 follow-up；閒置時啟動新 turn。避免每次 progress 更新都啟動模型請求。

#### 10.4.3. 讓 agent 知道用法

Extension 用 `pi.registerTool()` 宣告上述工具、參數 schema 與 description，並可用 `promptSnippet`／`promptGuidelines` 加入使用規則。規則須說明何時派工、context mode、jobId、等待與取消方式，以及只有 `succeeded` 才能採用完成結果。只教 agent 用 bash 執行 `pi -p` 也可行，但仍須自行管理 PID、輸出檔案、失敗與取消；註冊工具可集中這些責任。

#### 10.4.4. 完成條件與錯誤處理

建議 job state 為 `queued`、`running`、`succeeded`、`failed`、`cancelled`、`timed_out`。紀錄至少包含 jobId、父／子 session ID、快照 leaf ID、cwd、程序識別、要求與實際 model／thinking、起訖時間、結果與錯誤位置。必須設定同時工作數、執行時間、結果大小與委派深度上限，並定義父 session 結束時是否取消子工作。

使用 `spawn(command, args, { shell: false, cwd, ... })` 傳入參數陣列；prompt 可經 stdin 傳入並關閉 stdin，或放在 `--` 後。不要把 prompt 拼接成 shell 命令。逐行解析 JSONL，處理跨 chunk 的半行，並分開保存 stderr。限制緩衝大小，避免無上限記憶體使用。

Pi 1.1.0 的 JSON print mode 不會對每個 assistant `stopReason=error`／`aborted` 都設定非零 exit code。因此，不能只用 exit code 0 判定成功。必須同時檢查事件中的最終 assistant stopReason、errorMessage、`agent_settled.aborted` 與程序 close 的 code／signal。`agent_end` 之後仍可能 retry／compact；`agent_settled` 也不等於程序已關閉。成功代表程序正常完成且沒有最終錯誤，不保證工作內容已通過驗收。

找不到 pi、模型或憑證錯誤、快照無效、JSON 協定損壞、非零退出、取消與工作逾時均須回傳可辨識錯誤。收到取消後須確認真正退出；不能只用 `proc.killed` 判定結束，必要時採用平台適用的程序樹清理。父程序重啟後，PID 可能被重用，不能僅憑舊 PID 繼續發 signal。不要對可能已修改檔案的失敗工作直接自動重跑。

#### 10.4.5. 內建能力、自訂追蹤與自動派工

本節區分 Pi v1.1.0 原有能力、官方 extension 範例與建議自行開發的功能。第 10.4.2 節的四個 job 工具不是已存在的 Pi API；Node.js timer 也不是 Pi 自帶的 subagent 排程器。

| 能力                                        | 現況                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| CLI fork、model／thinking、print／JSON 模式 | Pi 已提供。                                                     |
| 子程序 stdout、stderr、close 監聽與進度解析 | 官方 subagent extension 範例已有；需載入 extension 才有該工具。 |
| 等待單次／平行／chain 工作完成              | 官方範例已有；工具 execute() 等工作完成後才回傳。               |
| 啟動後立即回傳 jobId，讓父模型繼續做其他事  | 本文建議設計，需自行實作。                                      |
| job 登錄、status／wait／cancel 與重啟後恢復 | 本文建議設計，需自行實作。                                      |
| 按固定時間檢查工作或喚醒父模型              | 需自行實作排程；Pi 不會自動執行。                               |
| 注入工具說明、排入 follow-up、啟動新 turn   | Pi 已提供 API；何時呼叫由 extension 決定。                      |

不必要求使用者每次在 prompt 教 agent 用法。Extension 註冊且啟用工具後，一般 direct tool 的名稱、description 與 parameters 會進入模型請求。`promptSnippet` 可加入預設 system prompt 的 Available tools；`promptGuidelines` 可加入其 Guidelines。若替換預設 system prompt，須確認這些指引仍有帶入。工具說明讓模型知道如何使用；模型是否派工仍依任務與指令決定，不能保證每次選用。

可在 extension 的 `promptGuidelines` 設定這類固定規則：派出可獨立處理的工作後保存 jobId；有其他工作時繼續處理；需要結果時呼叫 status 或有上限的 wait；收到完成通知後再讀取結果。若使用者希望某項工作必須委派，可在該次 prompt 明確指定。若某項排程必須準時執行，須由程式保證，不能只靠模型遵守文字指令。

背景執行由工具程式決定。`subagent_start.execute()` 啟動子程序、保存 handle 並回傳 jobId；它不等待子工作完成。Pi 把這個 tool result 交給父模型，父模型才可繼續下一次請求。官方範例雖然使用非同步子程序，但 `execute()` 仍等待工作完成；因此不能僅因使用 async 或 spawn 就稱為背景 job。`onUpdate()` 是進度顯示通道，不等於父模型收到一次新輸入。

優先使用 stdout data 與 process close 事件更新狀態；這通常不需要定期 polling。需要 watchdog、心跳或逾時檢查時，extension 可另外建立 Node.js timer。這些工作由父程序程式執行，不由 LLM 自行運行時鐘。

若只需完成時通知，close 處理完成條件後，呼叫 `pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true })`。父模型忙碌時排隊，閒置時啟動 turn。若要求模型每隔一段時間親自檢查，則需另寫 timer 送入檢查訊息；這會增加模型請求，且父模型忙碌時不能保證準時處理。必須合併重複通知並避免無上限 queue。

新增圖說明父模型請求、子程序與 extension event handler 的關係：

```text
Parent model request
  -> tool call: subagent_start
  -> extension spawn + save job
  -> immediate tool result: jobId
  -> next parent model request

Extension spawn
  -> child pi loop: independent model request -> tools/retry
  -> child stdout/close -> extension event handlers -> update job
  -> if complete: sendMessage(followUp, triggerTurn)
     -> parent idle: start request
     -> parent busy: queue follow-up
```

#### 10.4.6. 現有範例怎麼讀進度與等待結果

需求已足以說明目前行為與改法。本節分析官方範例原始碼，不代表本機已載入該 extension，也不代表 controller 已有 subagent 工具。

若已載入官方 subagent 範例，互動模式會在 subagent 工具區塊顯示最新文字、工具呼叫與用量；可用 Ctrl+O 展開詳細結果。平行模式另顯示 done／running 數量。這些是執行活動，不是任務完成百分比。單次模式的圖示也不能當作可靠的背景 job state。

| 讀取位置                           | 官方範例目前做法                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `runSingleAgent()`                 | 使用 `spawn()` 啟動 `pi --mode json -p --no-session`，stdout／stderr 設為 pipe。                                    |
| stdout data handler                | 把跨 chunk 半行保留在 buffer；按 LF 分行後交給 `processLine()`。                                                    |
| `processLine()`: `message_end`     | 保存完成的 message；assistant message 更新 turns、usage、model、stopReason 與 errorMessage，再呼叫 `emitUpdate()`。 |
| `processLine()`: `tool_result_end` | 保存 tool result 並呼叫 `emitUpdate()`。                                                                            |
| `emitUpdate()`                     | 用 `onUpdate({ content, details })` 傳出目前輸出與結構化進度。                                                      |
| `renderResult()`                   | 將 details 內的文字、工具呼叫與用量呈現在互動工具畫面。                                                             |
| stderr data handler                | 累積診斷訊息；不是進度百分比。                                                                                      |

子程序 JSONL 也有 `message_update` 等 delta 事件，但此範例的 `processLine()` 主要處理 `message_end` 與 `tool_result_end`，不逐 token 顯示 `text_delta`。若要逐 token 進度，需要擴充 parser。必須持續讀 stdout，不能等程序結束才開始讀取，否則 pipe 填滿可能使子程序停住。

程式上的等待是事件等待，不是定時查詢：`execute()` await `runSingleAgent()`；`runSingleAgent()` await 一個 Promise；`proc.on("close")` 解析最後半行後 resolve exit code；`proc.on("error")` 也可讓 Promise 結束。等待期間 Node.js 仍處理 stdout／stderr 與 `onUpdate`，並非阻塞整個 OS 執行緒；但是父 agent 的這次工具呼叫尚未完成，父模型還沒取得最終 tool result。

拿到 result 後，單次模式使用 `isFailedResult()` 檢查 exitCode、stopReason=error／aborted，並以 `getFinalOutput(result.messages)` 組成 content，連同 details 回傳。`getFinalOutput()` 從後往前找 assistant message，回傳其中第一個 text block；沒有 text 的 assistant 會繼續往前找。平行模式會等待整批工作完成，之後回傳各工作的輸出摘要。`onUpdate` 是 UI／事件更新，不會讓父模型在每次進度更新時自行產生下一個 turn。

```text
Parent tool execute()
  -> await runSingleAgent()
     -> spawn(pi -p --mode json)
     -> await close/error Promise
        |
        +-- stdout data -> processLine() -> emitUpdate() -> UI
        +-- stderr data -> diagnostics
        +-- close/error -> resolve Promise
     -> result
  -> content + details -> parent model request
```

#### 10.4.7. 立即回傳 jobId 的最小改法

目標名稱：Pi Subagent 非同步派工與事件追蹤。保留官方範例的 spawn 與 JSONL 解析，把程序生命週期移到 extension 的 job registry。start 工具只等待啟動確認，不 await 子工作的完成 Promise。完成結果仍由事件監聽器更新。

以下是待實作的介面骨架，不是可直接安裝的 extension。`StartParams`、`makeJob`、`attachJobListeners`、`buildChildArgs` 與 `publicJobSnapshot` 是待實作 helper；`jobs` 放在 extension factory 的 closure。`buildChildArgs()` 須驗證輸入，沿用第 10.4.1 節的分支快照與 `--fork` 規則。程式碼：

```ts
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const jobs = new Map();

pi.registerTool({
  name: 'subagent_start',
  label: 'Subagent start',
  description: 'Start a child and return jobId without waiting for completion.',
  parameters: StartParams,
  async execute(_callId, params, signal, _onUpdate, ctx) {
    signal?.throwIfAborted();
    const args = buildChildArgs(params);
    const child = spawn('pi', args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const job = makeJob(randomUUID(), child);
    jobs.set(job.jobId, job);
    attachJobListeners(job, pi);
    await once(child, 'spawn');
    if (job.state === 'queued') job.state = 'running';
    const snapshot = publicJobSnapshot(job);
    return {
      content: [{ type: 'text', text: JSON.stringify(snapshot) }],
      details: snapshot,
    };
  },
});
```

`once(child, "spawn")` 只等 OS 確認啟動；`error` 會讓它 reject，不等待整個任務完成。成功啟動不代表模型、憑證與 prompt 已通過檢查，這些仍可能稍後失敗。`attachJobListeners()` 必須在等待前註冊 stdout／stderr／error／close handlers，保存錯誤並收集輸出。需處理 `spawn()` 同步拋錯與 error event，並清理未成功啟動的 job。

`publicJobSnapshot()` 至少回傳 jobId 與 state，不序列化 ChildProcess handle。jobId 放在 content 內讓父模型取得，不能只放在供 renderer 使用的 details。不要用 PID 當唯一 jobId。`subagent_status(jobId)` 回傳 registry 的目前 snapshot；`subagent_wait(jobId, timeout)` 有上限地等待完成訊號。需要結果時才回傳有大小上限的 output／error。

`attachJobListeners()` 按以下順序處理後續事件：解析 stdout 更新進度與最終 assistant；讀 stderr 保存診斷；close 後綜合 code／signal、最終 stopReason 與 settled.aborted 決定終態；再決定是否送出一次完成 follow-up。不得只以 exit code 0 標記 succeeded。

start 工具回傳後，原本的 `onUpdate` 不再適合作為該工具的長期進度通道。後續進度改由 registry、status 工具與 extension UI 顯示；完成時才送 follow-up。signal 在啟動階段取消、使用者執行 cancel，以及 extension shutdown 都需有明確的取消與程序清理政策。這些細節仍須實作，不能因為回傳了 jobId 就視為完成背景工作管理。

```text
Parent request -> start.execute()
  -> spawn + save job + attach listeners
  -> await spawn acknowledgement
  -> return jobId -> next parent request

Child JSONL/close
  -> listeners update job
  -> status(jobId) reads snapshot
  -> completion follow-up -> parent request or queue
```

#### 10.4.8. Subagent 名稱、既有功能與重用邊界

Pi 官方已提供 `examples/extensions/subagent/index.ts` 範例。該檔案以 `pi.registerTool({ name: "subagent", ... })` 註冊工具，必須載入 extension 後才可用。範例檔案存在，不等於 Pi 核心預設已啟用 subagent，也不代表本機已載入它。

| 名稱                  | 所屬系統                        | 與本需求的關係                                                                                           |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Pi 官方 subagent 範例 | Pi extension                    | 已提供派工、獨立 pi 子程序、模型選擇、進度、取消，以及 single／parallel／chain；目前等待工作完成後回傳。 |
| 本文背景 job 設計     | 擬擴充的 Pi extension，尚未實作 | 沿用官方範例，增加固定分支快照、fork、job registry、立即回傳 jobId、status／wait／cancel 及完成通知。    |
| ai-agent-controller   | 本專案                          | 目前沒有 Pi 依賴或 subagent 呼叫點；本次僅記錄設計。                                                     |

本文背景 job 設計是官方範例的擴充，應沿用相同啟動與解析流程。

`runSingleAgent()` 是官方範例內的私有 helper，不是另一種 subagent，也不是 Pi SDK 的通用公開 API。subagent 工具 `execute()` 在 single 模式呼叫它；parallel／chain 模式也重用它。它負責 spawn pi、收集 JSONL、更新進度、等待 close／error，以及回傳結果。`execute()` 的 `await runSingleAgent()` 使父工具等待整項子工作完成。

```text
Pi extension example
  -> pi.registerTool("subagent")
  -> tool execute()
     -> await runSingleAgent()
        -> spawn child pi -p --mode json
        -> child model/tool loop
        -> collect progress and result
        -> close/error -> return result
     -> return tool result
  -> next parent model request
```

建議把原本 `runSingleAgent()` 的生命週期拆成「啟動工作」與「等待完成」，同一組程式同時支援前景等待及背景工作。啟動層回傳工作 handle（jobId、completion Promise 與進度狀態），registry 保存 handle；原本同步模式 await `handle.completion`，背景 start 模式立即回傳 jobId，wait 工具再有上限地等待同一個 completion。這些 handle 與工具是待實作設計。

可沿用官方範例的 agent 設定讀取、模型選擇、CLI invocation、JSONL 解析、usage 彙整與 renderer；需要補上背景生命週期與 fork。既有取消與錯誤處理仍須按第 10.4.4 節修正及驗證，不能直接視為已滿足背景工作需求。單純刪除 `await runSingleAgent()` 不足以完成設計：它不會自動產生 jobId、保存工作、處理拒絕的 Promise，或建立 status／wait 介面。

#### 10.4.9. 官方 subagent 工具參數

官方範例以 TypeBox 定義 `SubagentParams`，並在 `pi.registerTool()` 的 `parameters` 使用此 schema。以下 TypeScript 僅表示相同輸入形狀；實際型別與執行時條件以官方範例為準。

```ts
type SubagentTask = {
  agent: string;
  task: string;
  cwd?: string;
};

type SubagentInput = {
  agent?: string;
  task?: string;
  tasks?: SubagentTask[];
  chain?: SubagentTask[];
  agentScope?: 'user' | 'project' | 'both';
  confirmProjectAgents?: boolean;
  cwd?: string;
};
```

| 參數                   | 定義與預設                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                | 單次模式的 agent 名稱；對應已發現的 agent 定義，不是模型 ID。                                                                                 |
| `task`                 | 單次模式的工作 prompt。                                                                                                                       |
| `tasks`                | 平行工作陣列；每項 agent、task 必填，cwd 可省略。最多 8 項，同時最多 4 項；這是範例常數，不能透過工具參數更改。                               |
| `chain`                | 循序工作陣列；每項 agent、task 必填，cwd 可省略。task 可包含 `{previous}`，替換為上一步輸出；第一步的 previous 為空字串。失敗時停止後續步驟。 |
| `agentScope`           | 預設 `user`；`user` 讀使用者 agents，`project` 讀專案 agents，`both` 讀兩者且同名時專案優先。                                                 |
| `confirmProjectAgents` | 預設 `true`；使用專案 agent、存在互動 UI、專案未受信任等條件成立時，範例才顯示確認。不是每次都顯示。                                          |
| `cwd`                  | 頂層只用於單次模式的子程序工作目錄。平行／chain 應在每項設定；省略時使用父 extension `ctx.cwd`。                                              |

single、parallel、chain 三種模式只能選一種。single 需非空 agent + task；tasks 或 chain 需至少一項。Schema 將頂層欄位列為 optional，但 `execute()` 額外檢查模式是否恰好一種，不是任意組合都有效。找不到 agent 時會回傳可用名稱。Agent 定義搜尋基於父 `ctx.cwd`，不因 task 自己的 cwd 改變。

單次模式：

```json
{ "agent": "scout", "task": "Find authentication entry points" }
```

平行模式：

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find API routes" },
    { "agent": "scout", "task": "Find database models" }
  ]
}
```

循序模式：

```json
{
  "chain": [
    { "agent": "scout", "task": "Find authentication code" },
    { "agent": "planner", "task": "Plan changes based on: {previous}" }
  ]
}
```

以上是呼叫 subagent 工具時的 JSON 參數，不是 pi CLI 的命令列參數；agent 名稱必須先有對應定義。

model、thinking 與 tools 不在官方 `SubagentParams` 中。Agent 定義是 Markdown 檔案，frontmatter 支援 `name`、`description`、`tools`、`model`；name 與 description 必須是字串，本文把兩者列為必填。tools 可用逗號分隔字串或 YAML 字串陣列。正文會透過 `--append-system-prompt` 加入子程序。

```text
---
name: scout
description: Inspect code and report findings
tools: read, grep, find, ls
model: provider/model-id:high
---
Inspect the assigned files and report concise findings.
```

`provider/model-id` 是需替換的模型識別。model 不設定時，官方範例繼承派工時父 session 的 model 與 thinking；指定 model 時以該字串選模，可使用 `:high` 等 suffix，範例不另傳父 thinking。沒有獨立的 frontmatter thinking 欄位，也沒有每次工具呼叫的 thinking 參數。

使用者定義預設位於 `~/.pi/agent/agents/*.md`；專案定義位於 `.pi/agents/*.md`（會從父 `ctx.cwd` 往上尋找最近目錄）。使用此工具需要載入 extension 並配置 agent 定義；workflow prompt 範本是選用。不能只因範例隨套件附帶就假設已可用。

官方工具也沒有 background、jobId、fork、timeout、pollInterval 或 maxConcurrency 參數。若需求包含這些選項，須擴充工具 schema 與實作。

#### 10.4.10. Agent Markdown 定義檔是什麼

它是官方 subagent extension 讀取的「子 agent 角色設定檔」。用一般 `.md` 文字檔預先定義角色名稱、說明、工具、可選模型及固定工作規則。每次呼叫工具時，再用 task 提供當次工作。

例如預設使用者目錄的 `~/.pi/agent/agents/scout.md` 可以寫成如下。這是示意內容，本次未建立或載入此檔案。

```text
---
name: scout
description: Inspect source code and report findings
tools: read, grep, find, ls
---
Read files related to the assigned task.
Report file paths and relevant functions.
```

兩個 `---` 之間是 YAML 設定區（frontmatter）。name 是 `subagent({ agent: "scout", ... })` 使用的查找名稱，以此欄位為準，不是單靠檔名。description 是角色說明。tools 指定子程序使用的工具名稱，可省略。model 也是可選欄位；本例省略，因此繼承派工時父 session 的 model 與 thinking。若要固定模型，可依 10.4.9 加入 model 設定。

第二個 `---` 以下是固定角色指令。官方範例把正文寫入暫存文字檔，再以 `--append-system-prompt` 傳給子 pi。當次 task 另以 `Task:` 前綴作為 prompt 傳入；角色規則與每次工作分開管理。因此，同一個 scout 定義可以重複接收不同 task，每次呼叫仍啟動新的子程序。

預設 `agentScope=user` 時讀 `~/.pi/agent/agents/` 的 `.md` 檔案。專案共用角色可放 `.pi/agents/`，並選擇 `agentScope=project` 或 `both`；實際使用者目錄可由 Pi 設定的 agent directory 覆寫。此格式由官方 subagent 範例的 loader 定義；使用工具前仍需載入 extension 並備妥角色檔案。

```text
subagent tool execute({ agent: "scout", task: "..." })
  -> discoverAgents(ctx.cwd, scope)
     -> read .md files and parse frontmatter/body
  -> runSingleAgent()
     -> find agent by name: scout
     -> model/tools become child CLI options
     -> body becomes --append-system-prompt
     -> task becomes child prompt
     -> spawn child pi
        -> AgentSession.prompt()
        -> ModelRuntime.streamSimple()
        -> provider model request
```

#### 10.4.11. 開始使用官方 subagent extension

以下是 Pi 1.1.0 的最小起步方式：載入隨套件附帶的官方 extension，搭配一個使用者層的 scout 角色。這是操作指南；本次未執行本節示範的 scout 角色與 extension 載入命令，也未呼叫真實模型或把 Pi 加入 controller 依賴。

2026-10-13 的讀取檢查：本機套件已有 `examples/extensions/subagent/index.ts` 與 `agents.ts`；預設 `~/.pi/agent/extensions/subagent/index.ts`、`~/.pi/agent/agents/scout.md` 與 `worker.md` 尚不存在，專案也沒有 `.pi` 目錄。這只確認指定路徑，不代表完整列舉所有可能的 extension 設定。當時 `PI_CODING_AGENT_DIR` 未設定；以下命令使用預設目錄。

先在一般 shell 執行以下操作。`PI_SUBAGENT_SRC` 指向目前 npm global prefix 的官方範例；此路徑必須同時有 `index.ts` 與 `agents.ts`。

```sh
PI_SUBAGENT_SRC="$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent"
mkdir -p "$HOME/.pi/agent/agents"
cat > "$HOME/.pi/agent/agents/scout.md" <<'EOF'
---
name: scout
description: Inspect source code and report findings
tools: read, grep, find, ls
---
Read files related to the assigned task.
Report file paths and relevant functions.
EOF
pi -e "$PI_SUBAGENT_SRC/index.ts" --tools +subagent
```

本段建立 `scout.md`；若已有自己的同名角色，應沿用或另取 name 與檔名。這個角色刻意省略 model，讓子程序繼承父 session 當時的 model／thinking。官方附帶的 scout／worker 等角色有固定模型設定，使用前需確認適用於自己的 provider，或調整其 model。`--tools +subagent` 明確啟用此工具並保留其餘預設工具。

若 Pi 尚未設定可用模型，在互動介面先用 `/login` 設定 provider，再用 `/model` 選擇可用模型；已有設定則直接沿用。這兩項不是 subagent 工具的參數。

接著在 Pi 對話輸入：「請使用 subagent 工具，agent 設為 scout，task 是閱讀 package.json 與 src/app.ts，回報健康檢查路由和相關函式。」這會讓主模型呼叫工具，而不是在 shell 執行 subagent 指令。

工具呼叫的等價參數如下：

```json
{
  "agent": "scout",
  "task": "Read package.json and src/app.ts. Report the health-check route and relevant functions."
}
```

這是 JSON 參數示意，通常由主模型產生，不需要把它當 shell 命令。若主模型沒有派工，明確要求使用名為 subagent 的工具與 scout 角色。執行時在工具區塊看進度，Ctrl+O 展開；完成後子結果回到父模型。官方版本會等待這次工作完成，不會立即回傳背景 jobId，也不 fork 父 session。

需要每次啟動 Pi 都載入時，可另採官方 README 的 symlink 方式。下面只設定使用者層 extension，不加專案依賴；使用先前相同 shell 的 `PI_SUBAGENT_SRC`：

```sh
mkdir -p "$HOME/.pi/agent/extensions/subagent"
ln -s "$PI_SUBAGENT_SRC/index.ts" "$HOME/.pi/agent/extensions/subagent/index.ts"
ln -s "$PI_SUBAGENT_SRC/agents.ts" "$HOME/.pi/agent/extensions/subagent/agents.ts"
```

之後重新啟動 Pi 即可自動發現 extension，不必再帶 `-e`；不要同時重複載入同一個 extension。兩個 `ln -s` 若目標已存在會失敗，先確認現有設定，不覆蓋它。Workflow prompt 範本不是必要項目。npm global prefix 或 Node 安裝路徑改變時，須確認 symlink 指向仍存在的官方範例。

| 狀況                    | 檢查與處理                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 找不到 extension 檔案   | 檢查目前 npm root -g 與套件安裝位置；本機已核對的位置為 `/home/neojhou/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`。 |
| Unknown agent: scout    | 檢查角色檔的 name、description 與 agentScope；預設只讀使用者 agents 目錄。                                                                                                                   |
| 模型或驗證錯誤          | 檢查父 session 的模型與 provider；若複製官方角色，另檢查角色指定的 model。                                                                                                                   |
| 沒有 subagent tool call | 檢查 extension 載入錯誤、工具是否啟用，以及 prompt 是否明確要求派工。                                                                                                                        |

#### 10.4.12. 固定模型與實作／測試分工

目標名稱：Pi 固定模型的實作與測試委派。需求足以配置角色與父分工規則。本次只建立使用者層檔案，未導入 controller、未安裝依賴，也未實作背景 job。

| 原指令或項目        | 說明                                                          |
| ------------------- | ------------------------------------------------------------- |
| `pi`                | 啟動 Pi CLI。                                                 |
| `-e path`           | 載入指定的官方 extension。                                    |
| `$PI_SUBAGENT_SRC`  | shell 範例目錄變數。                                          |
| `index.ts`          | 官方 extension 入口，並載入同目錄的 `agents.ts`。             |
| `--tools +subagent` | 在預設工具上增加 subagent，因此父模型仍有 bash、edit、write。 |
| 子模型              | 原指令沒有指定 child model。                                  |

角色檔為 [implementation-worker.md](/home/neojhou/.pi/agent/agents/implementation-worker.md)。它的 `name` 是 `implementation-worker`，`model` 是 `openai/gpt-6-luna:max`，`tools` 是 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。

父分工規則檔為 [subagent-parent-policy.md](/home/neojhou/.pi/agent/subagent-parent-policy.md)。父 CLI 以 `--append-system-prompt` 載入此檔。角色檔由 subagent extension 用於子程序。角色的 model 欄只指定子 agent；它不會設定父 CLI 的 model。

2026-10-13 的本機模型靜態核對中，外部 `timeout 30s` 執行 `pi --no-extensions --no-mcp --list-models gpt-6-luna`，退出碼為 0，列表包含 `openai/gpt-6-luna`。`getSupportedThinkingLevels(model)` 回傳 `off`、`low`、`medium`、`high`、`xhigh`、`max`。`clampThinkingLevel(model, "max")` 回傳 `max`；`thinkingLevelMap.max` 也是 `max`。這只驗證本機 Pi 目錄與模型映射。它不呼叫模型，也不保證供應商帳號可用。

子程序不繼承父 session 的 messages。子程序仍有自己的工作目錄、Pi 設定、可讀取的專案檔案與自動載入的 context 檔。因此，每次 task 都要明確提供背景與工作範圍。父專用規則不放進全域 `AGENTS.md`，避免子 agent 也套用父分工規則。使用 `--append-system-prompt` 只對載入該規則的父 CLI 生效。

以下命令是之後的啟動方式，本次沒有執行：

```sh
PI_SUBAGENT_SRC="$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent"
pi --no-extensions \
  -e "$PI_SUBAGENT_SRC/index.ts" \
  --tools read,grep,find,ls,subagent \
  --append-system-prompt "$HOME/.pi/agent/subagent-parent-policy.md"
```

`--no-extensions` 停用自動發現的 extensions、extension 設定與 built-in extensions；明確使用 `-e` 載入的官方 extension 仍會載入。工具 allowlist 提供父模型 `read`、`grep`、`find`、`ls` 與 `subagent`，不提供 `bash`、`edit` 或 `write`。implementation-worker 會取得角色檔指定的工具。此設定限制模型可呼叫的工具，不是 OS 檔案權限隔離。官方工具接受自由文字 task，無法語義上保證每一種工作類型。父 policy 規定純分析留在父 agent；本次沒有宣稱自動驗證工作類型。

任務文字範例（本次不執行）：

> 目標：只驗證健康檢查測試。  
> 工作目錄：`/home/neojhou/repos/ai-agent-controller`。  
> 讀取檔案：`/home/neojhou/repos/ai-agent-controller/package.json`、`/home/neojhou/repos/ai-agent-controller/src/app.ts`、`/home/neojhou/repos/ai-agent-controller/test/app.test.ts`。  
> 可修改檔案：無。  
> 步驟：讀取上述檔案，執行 `npm test -- test/app.test.ts`。  
> 限制：不改檔、不安裝套件、不自動修復。  
> 驗收：命令退出碼為 0。  
> 失敗：回報命令、退出碼與錯誤。  
> 回報：使用繁體中文與清楚短句。

```text
Parent CLI loads subagent-parent-policy.md with --append-system-prompt
Parent requirements/design/read
  -> subagent tool -> runSingleAgent()
     -> load implementation-worker.md for child
     -> spawn child --model openai/gpt-6-luna:max --no-session
        -> child model request
           -> ModelRuntime.streamSimple() -> provider model request
        -> assigned file changes/tests -> final result
  -> parent review
```

父與子模型請求都由 `ModelRuntime.streamSimple()` 呼叫 provider。一般工具迴圈見第 3.1 與第 4 章。官方 extension 仍等待子工作完成；它不會立即回傳背景 jobId。設定角色的 model 不需要手動修改 auth.json。登入憑證由 Pi 的 /login 管理；本次未執行登入或變更憑證。本次已建立上述使用者層檔案，但沒有啟動互動 Pi。

## 11. v0.80.7 到 v1.1.0 的差異

以下列出本文件涉及的主要 API 與流程變更：

| 面向                | 0.80.7 基準                                       | 1.1.0 基準                                                                                                                                |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| SDK model setup     | SDK options 提供 auth storage 與 model registry。 | 使用 async ModelRuntime.create，再以 createAgentSession({ modelRuntime }) 建立 session。                                                  |
| Context             | Agent context 直接承載 prompt/tool 資料。         | 使用 TranscriptContext；system prompt 與 tool declarations 進入 messages。                                                                |
| Turn completion     | shouldStopAfterTurn 控制結束。                    | finishTurn 在 core turn_end 前處理 actionable boundary。                                                                                  |
| Session messages    | Agent state messages 容易被視為權威狀態。         | 直接指定 agent.state.messages 不會控制後續 provider context；SessionManager 為 authoritative，變更 SessionManager 後呼叫 refreshContext。 |
| Event subscription  | pi.on 回傳 void。                                 | pi.on 回傳 unsubscribe 函式。                                                                                                             |
| Session boundary    | 以 loop 結束 event 為主。                         | turn_end、agent_before_settle 可提交 draft 並要求 continue。                                                                              |
| user_bash           | 舊行為可能落入預設 shell 路徑。                   | Handler 拋錯或回傳無效值時 fail closed；只有 undefined 才繼續。                                                                           |
| Status/event fields | 沒有本文件列出的 v1.1.0 訊號。                    | agent_settled.aborted、tool_execution_end.durationMs 與 OSC 7501 program status。                                                         |
| Model requests      | SDK 與 Agent 呼叫流程較直接。                     | ModelRuntime 統一 provider 通道；CacheWarmer 可獨立發出請求。                                                                             |

ai-agent-controller 沒有 Pi 呼叫點，因此本次沒有 controller migration。

## 12. 本機升級驗證與 rollback

本次升級命令：

```sh
npm install -g --prefix /home/neojhou/.nvm/versions/node/v22.21.1 --ignore-scripts @earendil-works/pi-coding-agent@1.1.0
```

驗證結果：

| 檢查                    | 結果                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js / npm           | Node v22.21.1、npm 10.9.4；package engine >=22.19.0 符合。                                                                                                                                   |
| CLI version             | 30 秒 timeout 內執行 pi --version，exit 0，輸出 1.1.0。                                                                                                                                      |
| CLI help                | pi --help exit 0。                                                                                                                                                                           |
| Installed packages      | pi-coding-agent、pi-agent-core、pi-ai、pi-tui 均為 1.1.0。                                                                                                                                   |
| 模型／thinking 靜態核對 | 2026-10-13：外部 timeout 30 秒執行 --list-models，exit 0，列出 openai/gpt-6-luna；靜態 catalog 支援 off 至 max，clamp(max)=max，thinkingLevelMap.max=max。未呼叫模型。                       |
| 設定解析驗證            | 官方 parseFrontmatter 讀到角色 name/model/tools/body；parseArgs 確認 noExtensions、顯式 -e、工具 allowlist 與 appendSystemPrompt；父 policy task 欄位檢查通過。角色與 policy 檔為 mode 600。 |
| Global package tree     | npm ls -g --prefix /home/neojhou/.nvm/versions/node/v22.21.1 --all --json exit 0。                                                                                                           |
| Controller manifests    | package.json 與 package-lock.json SHA256 前後一致；專案沒有加入 Pi 依賴。                                                                                                                    |
| 專案檔案                | package.json 與 src/app.ts 均存在。                                                                                                                                                          |
| 文件格式                | Prettier write/check 通過；41 個 code fence 成對，所有程式碼區塊皆為 ASCII；章節 1–13 連續，無預留標記。                                                                                     |
| 流程圖欄位              | 3.1 caller join 在第 45 欄、ModelRuntime join 在第 93 欄、prompt precheck 在第 89 欄；TURN 三條與 POST 兩條續跑回線固定在第 104 欄；Subagent 父／子回線固定在第 67／93 欄，均閉合。          |
| 官方 v1.1.0 連結        | 21 個不重複 GitHub tag URL 以 HTTP HEAD 檢查（每個 timeout 20 秒），全部回傳 HTTP 200。                                                                                                      |
| Runtime scope           | 升級時未修改 agent 設定；後續已建立專用角色與父 policy 檔，未修改 auth／provider 設定，未呼叫模型或載入 extension。                                                                          |

升級前備份位於：

/home/neojhou/.local/state/pi-upgrades/20261012T084313Z-0.80.7-to-1.1.0

備份目錄權限為 700，包含舊版完整套件目錄 pi-coding-agent-0.80.7。~/.pi/agent 封存為 agent-data.tar.gz，權限為 600，tar integrity 檢查通過。驗證摘要位於同一備份目錄的 validation-summary.txt。

需要回復時，可用同一 prefix 重新安裝 0.80.7：

```sh
npm install -g --prefix /home/neojhou/.nvm/versions/node/v22.21.1 --ignore-scripts @earendil-works/pi-coding-agent@0.80.7
```

離線時可由舊版 package 備份恢復套件，並恢復原 bin link 至 dist/cli.js。不要自動還原 ~/.pi/agent；這會覆蓋升級後建立的 session。本次沒有執行 rollback。

## 13. 程式碼閱讀索引與完成範圍

以下連結固定至官方 v1.1.0 tag。路徑依原始碼 package 位置列出，不使用 0.80.7 的發布包行號：

| 原始碼路徑                                                                                                                                                                                        | 閱讀內容                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [packages/agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/src/agent-loop.ts)                                                                             | Agent turn、工具與 assistant response loop。 |
| [packages/agent/src/agent.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/src/agent.ts)                                                                                       | Agent prompt、continue 與 event。            |
| [packages/coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts)                                               | Prompt、session、retry、compact 與 settle。  |
| [packages/coding-agent/src/core/sdk.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts)                                                                   | SDK 與 AgentSession 建立。                   |
| [packages/coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/session-manager.ts)                                           | Session persistence 與 projection。          |
| [packages/coding-agent/src/core/model-runtime.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/model-runtime.ts)                                               | ModelRuntime 與 provider 路由。              |
| [packages/coding-agent/src/core/cache-warmer.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/cache-warmer.ts)                                                 | CacheWarmer policy 與請求。                  |
| [packages/coding-agent/src/core/bug-report.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/bug-report.ts)                                                     | Bug report 摘要。                            |
| [packages/coding-agent/src/core/extensions/types.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/types.ts)                                         | Extension API 與型別。                       |
| [packages/coding-agent/src/core/extensions/loader.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/loader.ts)                                       | Extension 載入。                             |
| [packages/coding-agent/src/core/extensions/runner.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/runner.ts)                                       | Extension event 與 boundary 派送。           |
| [packages/coding-agent/src/core/extensions/wrapper.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/wrapper.ts)                                     | Extension ToolDefinition 包裝。              |
| [packages/coding-agent/src/extensions/codemode/execute.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/extensions/codemode/execute.ts)                             | Codemode、QuickJS/WASM 與模型 globals。      |
| [packages/coding-agent/src/core/compaction/](https://github.com/earendil-works/pi/tree/v1.1.0/packages/coding-agent/src/core/compaction)                                                          | Compact、摘要與分支摘要。                    |
| [packages/coding-agent/examples/extensions/subagent/index.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/examples/extensions/subagent/index.ts)                       | 官方子程序工具與 JSONL 解析範例。            |
| [packages/coding-agent/src/modes/print-mode.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/modes/print-mode.ts)                                                   | Print／JSON 模式、事件與退出。               |
| [packages/coding-agent/docs/cli.md](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md)                                                                           | Fork、model、thinking 與 CLI 參數。          |
| [packages/coding-agent/src/modes/interactive/program-status-reporter.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/modes/interactive/program-status-reporter.ts) | ProgramStatusReporter 與 OSC 7501。          |
| [packages/coding-agent/src/modes/interactive/interactive-mode.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/modes/interactive/interactive-mode.ts)               | Interactive input、event 與 status。         |
| [packages/coding-agent/src/modes/rpc/rpc-mode.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)                                               | RPC prompt、state、compact 與統計。          |
| [packages/tui/src/terminal.ts](https://github.com/earendil-works/pi/blob/v1.1.0/packages/tui/src/terminal.ts)                                                                                     | Terminal program status 與環境能力偵測。     |

Unbundled dist/core 與相依模組的 .js.map 可讀取 sourcesContent。CLI bundle 沒有相同的 source map。本文件說明 Pi v1.1.0 的分析結果；ai-agent-controller 沒有 Pi 呼叫點，本次沒有把 Pi 導入 controller。
