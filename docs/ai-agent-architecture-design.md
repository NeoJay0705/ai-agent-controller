# Enterprise AI Agent — Architecture Design v0.1

- **Status:** Proposed
- **需求基準：** `docs/ai-agent-requirements.md` v0.1
- **工程基準：** `docs/project-initialization-design.md` v1.0
- **範圍：** v1 Controlled Enterprise Agent Runtime
- **最後更新：** 2026-09-17

## 1. 文件目的與設計結論

本文件將需求轉換成可直接指導實作的架構、模組責任、資料一致性規則與測試邊界。需求仍是產品行為與驗收的來源；本文件負責回答如何實現。兩者衝突時，不得靜默以實作覆寫需求，必須先修正文檔或留下明確的設計變更紀錄。

v1 採用以下整體方案：

- 延續既有 Node.js、TypeScript、Fastify 與 ESM 工程基準。
- 採模組化單體，不先拆微服務。
- HTTP JSON API 負責命令與查詢，Server-Sent Events（SSE）負責可重連的 Run event stream。
- API process 與 Runtime Worker 使用同一程式碼庫及部署產物，但可分別啟動、獨立擴展。
- PostgreSQL 是 Session、Run、Message、Approval、Attachment metadata、版本與 usage ledger 的唯一持久狀態來源。
- Redis 僅負責分散式 rate limit 與即時喚醒／取消通知；通知遺失不得造成資料遺失，正確性仍以 PostgreSQL 為準。
- Agent Runtime 採自行維護的薄型、顯式狀態機，不在 v1 引入通用 workflow engine 或 Agent framework。
- Model、IAM／Authorization、object storage、malware scanner、secret provider 與企業 Tool downstream 皆經 adapter boundary 整合。
- Tool 僅能是部署時信任並明確註冊的 handler；v1 不允許動態下載程式碼、任意 HTTP、Shell 或 code execution。

這些決策足以支援 v1，同時沒有加入 RAG、Multi-Agent、任意執行環境、Kafka 或每模組獨立服務等超出需求的能力。

## 2. 需求理解與合理假設

### 2.1 v1 必須成立的行為

1. 經驗證的使用者可在單一可信 Tenant context 中建立 Session 並進行多輪對話。
2. Session 同時間最多一個 active Run；terminal Run 後的新訊息才建立下一個 Run。
3. Active Run 收到的新訊息先持久化，再依 Session sequence 於安全處理點套用。
4. Follow-up 與 Human Approval 恢復原 Run，不建立第二個並行 Run。
5. LLM 只提出 Tool request；schema、authorization、obligation、approval、usage、credential 與結果過濾都由可信程式碼執行。
6. Controlled Write Tool 可用，但必須遵循 side-effect、idempotency、approval 與 `UNKNOWN_OUTCOME` 規則。
7. Attachment 通過掃描、分類與授權前，不得提供給 Model 或 Tool。
8. Usage admission 採 hard reject；已產生的 usage 不因 Run 失敗或取消而回滾。
9. Session 刪除後立即不可見且不可作為 context，實體資料依 retention policy 非同步清除；最小 Audit metadata 獨立保存。

### 2.2 設計假設

- v1 對外必要 channel 是 HTTP API；Web、Slack 與 Lark UI／adapter 不在本次實作，但可使用同一 application service。
- 每個 production request 必須解析出一個 `subject_id` 與一個 `tenant_id`。使用者可否隸屬多個 Tenant 由上游 IAM 決定；單次 request 不允許跨 Tenant。
- `tenant_id` 只能來自已驗證的 identity claim 或 server-side mapping，不接受 request body、prompt 或 Tool argument 指定。
- v1 是互動式執行。`WAITING_USER_INPUT` 與 `WAITING_APPROVAL` 必須可跨 process restart 恢復；任意長時間背景工作仍不在 v1。
- Model Provider、企業 IAM、實際 authorization backend、資料分類 mapping、retention 天數、quota 數值與 SLO 尚未定案，因此放在 adapter 或 validated configuration，不硬編碼為產品規則。
- Attachment object storage 採 S3-compatible API；malware scanner 採 ClamAV-compatible adapter。若部署環境已有等價服務，只替換 adapter。
- v1 不承諾掃描所有媒體格式。允許的 media type 與對應 parser 必須明確註冊；未註冊類型拒絕上傳。
- Approval 的可核准人由 Authorization Adapter 回傳的 approver constraint 決定；實際核准者及 decision time 會被持久化。

上述假設不改變核心邊界。組織政策定案時應以設定或 adapter 置換，不應修改 Agent loop。

## 3. 系統架構

```text
Client / Channel Adapter
          │ HTTP + SSE
          ▼
┌──────────────────────────────────────────────────────────────┐
│                  Agent Application                           │
│                                                              │
│  API                                                         │
│   ├─ Identity resolution                                     │
│   ├─ Session / Message / Run commands                         │
│   ├─ Approval / Attachment / Admin commands                   │
│   └─ Persisted event stream                                   │
│                                                              │
│  Runtime Worker                                              │
│   ├─ Run lease + explicit state machine                       │
│   ├─ Context assembly                                         │
│   ├─ Model Gateway                                            │
│   └─ Tool orchestration                                       │
│                                                              │
│  Security and Governance                                     │
│   ├─ Authorization + obligations                              │
│   ├─ Approval                                                 │
│   ├─ Usage / budget                                           │
│   ├─ Result filtering                                         │
│   └─ Audit / telemetry                                        │
└──────────────┬──────────────────────┬────────────────────────┘
               │                      │
        PostgreSQL                  Redis
       durable source         rate limit + wake-up
               │
        Attachment metadata ──────► S3-compatible object storage

External adapters:
IAM / Authorization │ Model Provider │ Secret Provider
Malware Scanner      │ Tool downstream systems
```

### 3.1 部署單位

同一個 repository 產生一個 application artifact，提供兩個 entry point：

- `api`：HTTP、SSE、identity resolution、validation 與 application commands。
- `worker`：取得 Run lease，執行 agent loop、Model／Tool calls 與 retention jobs。

開發環境可在單一 process 啟動兩者；production 可分開部署及水平擴展。這不是微服務拆分，兩者共用 domain、application layer、資料庫 schema 與版本。

API 與 Worker 都不將必要 Session／Run state 保存在 process memory。執行中的 provider connection、AbortController 與 lease heartbeat 可以是暫時的 process-local state，但 process 消失後必須能依持久狀態得到明確 recovery 結果。

### 3.2 為何不用通用 Agent／Workflow Framework

v1 只需要一個受控 agent loop、有限狀態、可靠 inbox 與明確 security gateway。自行維護小型狀態機可讓授權、approval、budget 與副作用邊界直接可見，也避免框架 checkpoint 語意成為資料模型。若未來加入長時間 workflow 或 Multi-Agent，必須以量化需求重新評估，而不是在 v1 預先引入。

## 4. 專案組織與模組邊界

維持單一 package，依業務能力分模組：

```text
src/
├── app.ts                    # composition root / Fastify factory
├── server.ts                 # API process lifecycle
├── worker.ts                 # worker process lifecycle
├── config/                   # environment parsing and validation
├── api/                      # routes, schemas, auth hook, SSE transport
├── modules/
│   ├── identity/             # trusted IdentityContext
│   ├── sessions/             # Session, Message, deletion
│   ├── runtime/              # Run state machine and agent loop
│   ├── models/               # provider-neutral model port
│   ├── tools/                # registry, policy path, trusted handlers
│   ├── approvals/            # approval lifecycle
│   ├── attachments/          # quarantine, scan, parse, use, delete
│   ├── usage/                # admission, budget, ledger
│   ├── configuration/        # immutable version references
│   └── audit/                # security audit records
├── infrastructure/
│   ├── postgres/             # repositories, transactions, migrations
│   ├── redis/                # rate limit and best-effort notifications
│   ├── telemetry/            # logs, metrics, traces
│   └── adapters/             # external provider implementations
└── shared/                   # errors, IDs, clock; no business workflows

test/
├── unit/
├── integration/
├── contract/
├── security/
└── e2e/
```

規則：

- `api` 只處理 transport，不直接查資料庫或呼叫 Model／Tool。
- 模組公開介面由各模組的 `index.ts` 匯出；不得跨模組 import 私有檔案。
- Domain state transition 不依賴 Fastify、PostgreSQL、Redis 或 provider SDK。
- `infrastructure` 實作模組定義的 ports，不包含產品決策。
- `shared` 不得成為放置任意 helper 的共用垃圾桶。
- 不為未實作的 RAG、Multi-Agent、sandbox 或 marketplace 建立 placeholder 模組。

## 5. 元件責任

### 5.1 API Layer

- 驗證 route schema、request size 與 mutation idempotency key。
- 經 `IdentityProvider` 取得可信 `IdentityContext`。
- 將 identity 明確傳入 application service，不使用隱含 global context。
- 對跨 Tenant 或非 owner 資源統一回傳不可枚舉的 not-found／denied 結果。
- 將 domain error 映射成穩定 HTTP error envelope。
- SSE 僅傳送已持久化的 Run event，支援 `Last-Event-ID` 重連。

### 5.2 Session Module

- 建立、查詢、retention 與刪除 Session。
- 在資料庫交易中配置單調遞增 `message_sequence`。
- 決定新 Message 是建立新 Run、恢復 waiting Run，或加入 active Run inbox。
- 保證同一 Session 至多一個 active Run。
- 刪除時先將 Session 標記為不可見，再排程實體資料清理。

### 5.3 Runtime Module

- 以 lease 取得可執行 Run，執行顯式狀態轉換。
- 在每次 Model call 前及 Tool call 後處理尚未套用的 Message。
- 組裝 bounded context；不將 secret、未授權 attachment 或 raw Tool result 放入 context。
- 持久化事件、LLM call、Tool call、usage 與 terminal state。
- 處理 cancellation、timeout、budget 與 process crash 後的 lease recovery。

Context 組裝採可重現的順序：immutable system prompt、已套用的 Message、可用且獲授權的 Attachment 衍生內容，以及已過濾的 Tool result。v1 先使用 token-budget-aware window，保留 system prompt 與最近的完整對話 turn，超出上限的較舊內容不送入 Model，但仍依 Session policy 保存。v1 不自動產生 LLM summary；未來若加入 compaction，必須保存來源範圍、產生版本與 classification，並遵循 Session deletion。

Runtime 不自行授權、不取得 credential、不直接連線企業 downstream。

### 5.4 Model Module

- 將 provider-neutral request 轉換至選定 Model Provider。
- 在送出前檢查 model policy 與 context data classification。
- 正規化 streaming、usage、rate limit、timeout、cancellation 與 provider error。
- retry 只限尚未對外產生不可安全重播結果的 transient failure，並受 attempt 與總 deadline 限制。

### 5.5 Tool Module

- 維護 immutable、versioned Tool definition 及 enablement。
- 支援 register、enable、disable、deprecate 與新版本並存；既有版本不得原地改寫。
- 僅 expose 經 Agent、Tenant 與 User 初步篩選的 Tool；執行時仍重新授權。
- 強制執行固定 security path：

```text
resolve exact Tool version
→ validate requested_input
→ authorize Tool and resource
→ apply obligations to effective_input
→ require or validate approval
→ reserve usage / check Run budget
→ resolve scoped credential
→ execute trusted handler with deadline and abort signal
→ classify UNKNOWN_OUTCOME when required
→ filter / redact / size-limit result
→ record usage and audit
→ return Agent-visible result
```

- Tool handler 不能讀取 HTTP cookie，也不能信任 arguments 中的 user／tenant identity。
- Tool registration 只登錄 metadata 與已部署 handler 的 mapping，不載入遠端程式碼。

v1 Tool 開發流程固定為：

1. 實作 repository 內的 typed `ToolHandler`。
2. 提供 versioned definition、JSON input/output schema、risk、side-effect、idempotency、timeout 與 policy reference。
3. 通過 schema、authorization、tenant isolation、timeout、result filtering 及副作用 contract tests。
4. 在 composition root 明確綁定 `(tool name, version)` 與 handler。
5. 部署程式碼後由 authorized admin 登錄 definition；新版本預設 disabled，經審查後才對指定 Agent／Tenant enable。

v1 的 Tool SDK 是 repository 內可匯出的 TypeScript contract，不建立獨立 npm package；需要第三方獨立開發時再依相同 contract 拆包。

### 5.6 Approval Module

- 建立與 Tool execution snapshot 綁定的 pending Approval。
- 驗證 approver constraint、Tenant、自我核准 policy、expiry 與 terminal status。
- 對 decision 操作提供 idempotent semantics 並寫入 Audit。
- 核准後喚醒原 Run；Tool 執行前重新 authorization 並比較 snapshot。
- snapshot 或 policy 改變時取消舊 Approval，重新建立才可執行。

### 5.7 Attachment Module

- 將新檔案寫入 tenant-scoped quarantine key，初始狀態為 `PENDING_SCAN`。
- 驗證數量、大小、media type 與 checksum，再非同步掃描及解析。
- 僅 `AVAILABLE` 且通過 classification／authorization 的 Attachment 可加入 context 或 Tool input。
- 原始檔與解析內容一律標記為 untrusted；解析內容不得改變 policy 或 identity。
- Delete 先使 metadata 不可用，再非同步刪除 object、derived content 與 cache。

### 5.8 Usage Module

- 在建立新 Run 前執行 rate、concurrency 與 quota admission；任一失敗即不建立 Run。
- 在每次 LLM／Tool call 前檢查並預留 per-run budget，完成後依實際用量結算。
- 以 append-only ledger 記錄實際 usage，支援 Run、Session、User、Tenant 聚合。
- terminal transition 釋放 concurrency reservation；reconciler 修正 crash 造成的過期 reservation。
- Credit 是 ledger 的下游計算，不進入 agent loop。

### 5.9 Audit 與 Observability

- Audit 記錄安全與治理事實；application log 用於除錯，兩者分開保存及授權。
- 所有 Run、LLM call、Tool call、Approval 都帶 correlation IDs。
- 原始 prompt、完整對話、credential、附件內容與 raw sensitive Tool result 預設不寫入 log／trace／audit。

## 6. 核心資料模型

下表定義必要持久實體及責任，不提前指定所有 SQL 型別與 index 細節；migration 實作時必須維持列出的 invariant。

| 實體 | 必要內容 | 關鍵不變量 |
| --- | --- | --- |
| `agent_config_versions` | Agent、prompt、model、Tool set、policy 的 immutable version refs 與 checksum | 已被 Run 使用的版本不可原地改寫 |
| `sessions` | tenant、owner、agent、config version、status、next message sequence、timestamps | 所有讀寫必須帶 tenant；deleted Session 不可作 context |
| `messages` | session、run target、sequence、role、content reference、received/applied time | `(session_id, sequence)` unique；先存後用 |
| `runs` | session、status、state version、budget、lease、config refs、timestamps、failure code | 每個 Session 最多一個 active Run；terminal immutable |
| `run_events` | run、monotonic sequence、type、safe payload、created time | SSE 只讀此表；重連不得依賴 process memory |
| `llm_calls` | run、provider/model ref、attempt、status、usage、deadline | 每個 attempt 可追蹤，usage 不可因失敗回滾 |
| `tool_definitions` | name/version、schemas、risk、operation、idempotency、timeout、policy、enabled | `(name, version)` immutable unique |
| `tool_calls` | run、definition、requested/effective input refs、resource、decision、attempt、status、outcome | 執行只使用 effective input；副作用結果不可推測 |
| `approvals` | requester、approver constraint/decision、tenant、execution snapshot hash、policy version、expiry、status | terminal immutable；同一 snapshot 的有效 pending approval 唯一 |
| `attachments` | tenant、owner、session、object refs、hash、size、media type、scan/classification/status | 非 AVAILABLE 不可使用；object key 不由 client 決定 |
| `usage_ledger` | tenant、subject、session/run/call、kind、quantity、cost、timestamp | append-only；具來源事件唯一鍵以防重複計量 |
| `usage_reservations` | scope、bucket／run、reserved amount、expiry、status | admission 與 budget check 原子化 |
| `audit_records` | actor、tenant、action、resource refs、decision/status、policy version、safe metadata、timestamp | 一般 User 不得修改或刪除 |

身份資料不另建可登入的 User 資料庫。資料表保存外部 `subject_id` 與必要 display snapshot，只用於 ownership、audit 與查詢，不成為 IAM source of truth。

### 6.1 Run 狀態分類

```text
active:   CREATED, RUNNING, WAITING_USER_INPUT, WAITING_APPROVAL
terminal: COMPLETED, FAILED, CANCELLED, TIMED_OUT, LIMIT_EXCEEDED
```

允許轉換由單一 transition function 定義；repository 以 `state_version` compare-and-set 更新。任何 terminal state 都不可返回 active state。

必要補充規則：

- `WAITING_USER_INPUT + user message → RUNNING`，仍是同一 Run。
- `WAITING_APPROVAL + approved decision → RUNNING`，仍是同一 Run。
- rejection、expiry 或 cancellation 依 policy 結束為 `CANCELLED` 或明確 `FAILED`，不得繞過 Approval。
- process 在外部呼叫中消失時，read-only／可安全重試操作可由 lease recovery 重試；無法確認的副作用必須成為 `UNKNOWN_OUTCOME`，並終止自動執行。

### 6.2 Attachment 狀態

```text
PENDING_UPLOAD → PENDING_SCAN → PROCESSING → AVAILABLE
                         ├──► REJECTED
                         └──► PROCESSING_FAILED
any non-deleted state ──────► DELETING → DELETED
```

只有 `AVAILABLE` 可被 Message 引用。Delete、scan result 與 parser result 更新皆使用 optimistic concurrency，避免刪除後重新變為可用。

## 7. 持久化、交易與並行控制

### 7.1 PostgreSQL

選擇 PostgreSQL 是因為 Session／Run 狀態、唯一 active Run、message ordering、approval snapshot 與 usage reservation 需要交易、一致性 constraint 及 durable recovery。v1 使用明確 SQL migration 與 repository，不引入會隱藏交易語意的重型 ORM。

必要 constraint 包含：

- active Run 的 partial unique index，保證每個 Session 至多一筆 active Run。
- tenant-scoped composite key／foreign key，避免只靠呼叫端記得檢查 Tenant。
- Run event 與 Message sequence 的 unique constraint。
- Tool version、usage source event 與 mutation idempotency key 的 unique constraint。
- 所有時間由 server clock 產生並以 UTC 保存。

外部 Model、Tool、IAM、scanner 或 object storage 呼叫不得包在資料庫 transaction 內。流程以「先持久化意圖／狀態、外部呼叫、再以 compare-and-set 寫回結果」完成。

### 7.2 Worker lease

Worker 以短 lease claim Run；lease 具有 owner、expiry 與 heartbeat。取得 lease 不是狀態轉換，另一 worker 只能在 lease expiry 後接管。每個安全處理點都先確認：

1. Run 尚未 terminal。
2. lease 仍有效。
3. cancellation 未被要求。
4. budget 尚可執行下一步。
5. 是否有新的 Message／Approval decision。

lease 避免同一 Run 被兩個 worker 同時推進；資料庫 constraint 與冪等性仍是最後防線。

### 7.3 Redis

Redis 用於：

- user／tenant／global rate-limit atomic counter。
- 通知持有 Run lease 的 worker 有新 Message、cancel 或 Approval decision。
- SSE instance 的低延遲 event wake-up。

Redis Pub/Sub 是提示，不是 queue。consumer 收到通知後必須重新讀 PostgreSQL；通知遺失時以短週期 polling 補償。Redis 不保存唯一一份 Session、Run、Message、Approval 或 usage 資料。

Rate-limit store 無法使用時，新 Run admission 採 fail closed 並回傳 dependency unavailable，不靜默略過限制。已在執行中的 Run 仍依 PostgreSQL budget 決定是否繼續。

## 8. 主要資料流

### 8.1 建立 Session 與送出 Message

1. API 驗證 credential，解析可信 `IdentityContext`。
2. 建立 Session 前驗證 Agent／Tenant 可用性；Session 綁定當下 configuration version。
3. mutation request 使用 client `Idempotency-Key`，相同 subject、route 與 key 回傳相同結果；payload 不同則回傳 conflict。
4. 收到 Message 時鎖定 tenant-scoped Session，配置下一個 sequence 並持久化。
5. 若沒有 active Run，先完成 rate／quota／concurrency admission，再在同一交易建立 Run。
6. 若存在 active Run，將 Message 綁定該 Run；waiting Run 轉回 `RUNNING`，running Run 保持原狀。
7. 寫入 `user_message_received` event 後 commit，再通知 worker。
8. Worker 在安全點標記 Message `applied_at` 並寫入 `user_message_applied`。

Admission 失敗時不得留下隱藏 Run。User Message 是否保存由 API contract 明確處理：用於啟動新 Run 的 Message 與 Run 建立在同一交易中，admission 失敗則整筆不建立；active Run injection 不建立新 Run，因此仍可被接收，但後續每一步受該 Run budget 限制。

### 8.2 Model streaming 與訊息插入

1. Runtime 建立 bounded model request，通過 classification policy 後呼叫 Model Gateway。
2. 每個 provider delta 先轉成 normalized event，再持久化後供 SSE 讀取。
3. 新 Message 到達時，runtime 設定 generation interruption intent。
4. Provider 支援 cancellation 時中斷當次 generation；已持久化 delta 不刪除，寫入 `generation_interrupted`。
5. 套用新 Message 後建立新的 LLM call attempt，不覆寫舊 attempt。

如果 provider 無法取消，runtime 可停止向 client 發送後續 delta，但仍需完成或等待 bounded timeout，並記錄實際 usage。不得同時啟動第二個會修改相同 Run 的 agent loop。

### 8.3 Tool 與 Approval

1. Model 產生 Tool request，runtime 解析 exact name/version。
2. Tool module 驗證 schema，建立 `requested_input` snapshot。
3. Authorization Adapter 回傳 `ALLOW`、`DENY` 或 `REQUIRE_APPROVAL` 及 obligations／policy version。
4. obligations 產生 `effective_input`；resource 與 snapshot hash 一併保存。
5. `DENY` 不呼叫 downstream；`REQUIRE_APPROVAL` 建立 Approval，Run 進入 `WAITING_APPROVAL`。
6. Approval 通過後恢復同一 Run；執行前重新授權並確認 snapshot、Tool version 與 policy version未變。
7. Usage／budget reservation 成功後，Tool Gateway 取得 scoped credential 並呼叫 handler。
8. 結果先經 Tool-specific filter、obligation、DLP、size limit，才可加入 Agent context。
9. Tool call、usage、audit 與 safe event 都被持久化。

Write Tool timeout 或斷線時：若 handler/downstream 可用相同 idempotency key 查詢或安全重播，依 contract 處理；否則回傳 `UNKNOWN_OUTCOME`，停止自動 retry，要求使用者或 operator 確認。不得以另一 Tool 重做相同副作用來規避。

### 8.4 Attachment

1. API 驗證 Session ownership、檔案數量、宣告 size/media type，配置 server-side object key。
2. upload streaming 寫入 quarantine storage，同時計算 hash 並執行實際大小上限；失敗時不建立可用 Attachment。
3. metadata 進入 `PENDING_SCAN`，worker 呼叫 scanner。
4. scan 通過後依 media type 選擇 parser，保存衍生內容及 classification；失敗狀態可區分 scan reject 與 parse failure。
5. Message 只引用 Attachment ID；runtime 使用前再次檢查 tenant、owner/session、狀態、classification 與 authorization。

### 8.5 Cancellation、刪除與 retention

- Cancel 先持久化 request，再通知 worker；Runtime 停止後續步驟並向可取消的外部呼叫傳遞 signal。
- 已開始的 Write Tool 不因 cancel 被宣稱撤銷；最終狀態依實際 outcome 記錄。
- Session deletion 在交易內標記 `DELETING/DELETED`、取消 active Run 並使一般查詢立即不可見。
- Retention worker 清除 Message、filtered result、attachment object／derived content、context 與 cache，記錄不含敏感內容的 deletion audit。
- Audit 依獨立 policy 保存；backup expiration 由部署與 compliance policy 處理。

## 9. 主要介面

以下為語意介面；實作可調整 TypeScript 命名，但不得改變責任或安全順序。

```typescript
interface IdentityProvider {
  resolve(credential: Credential): Promise<IdentityContext>;
}

interface AuthorizationPort {
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

interface ToolHandler<TInput, TOutput> {
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

interface BlobStore {
  putQuarantined(request: PutObjectRequest): Promise<ObjectReference>;
  read(reference: ObjectReference): AsyncIterable<Uint8Array>;
  delete(reference: ObjectReference): Promise<void>;
}

interface MalwareScanner {
  scan(reference: ObjectReference, signal: AbortSignal): Promise<ScanResult>;
}

interface SecretProvider {
  issue(request: ScopedCredentialRequest): Promise<ScopedCredential>;
}
```

`ToolHandler` 只能由 Tool Gateway 呼叫；Runtime 不取得 `ScopedCredential`。所有 port error 必須正規化成 domain error，不讓 provider-specific exception 穿透 API。

### 9.1 HTTP API surface

v1 最小 resource surface：

```text
POST   /v1/sessions
GET    /v1/sessions/:sessionId
DELETE /v1/sessions/:sessionId

POST   /v1/sessions/:sessionId/messages
GET    /v1/runs/:runId
GET    /v1/runs/:runId/events          # SSE
POST   /v1/runs/:runId/cancel

GET    /v1/approvals/:approvalId
POST   /v1/approvals/:approvalId/decision

POST   /v1/sessions/:sessionId/attachments
GET    /v1/sessions/:sessionId/attachments
DELETE /v1/attachments/:attachmentId
```

Tool Registry、Agent／Model enablement、quota、retention、usage 與 audit 的管理操作置於受管理員授權保護的 `/v1/admin/*`。v1 不要求 Admin UI；確切 payload 由後續 API specification 定義，但不得繞過相同 application service 與 authorization。

所有 mutation endpoint 接受 `Idempotency-Key`。SSE event envelope 至少包含：

```text
event_id       # run-local monotonic sequence; also used as SSE id
event_type
run_id
session_id
occurred_at
payload        # event-specific, already redacted
```

`text_delta` 為 ephemeral user-facing content，但為支援 reconnect，仍需依 Session retention 保存；刪除 Session 時一併清除。

## 10. 技術選型

| 面向 | 選擇 | 理由與邊界 |
| --- | --- | --- |
| Language/runtime | TypeScript 6、Node.js 22/24、ESM | 沿用已核准初始化，不新增語言與 build system |
| HTTP | Fastify 5 | 既有 application factory、schema 與 injection test 能力 |
| Streaming | SSE | 需求是 server-to-client event；比 WebSocket 簡單，命令仍走 HTTP |
| Runtime | 顯式 TypeScript state machine | v1 狀態有限，可直接測試安全轉換；不引入 workflow engine |
| Durable store | PostgreSQL | 交易、constraint、lease、ordering 與 durable state |
| DB access | `pg` + versioned SQL migrations | 保持 SQL／鎖／constraint 可見；不導入重型 ORM |
| Ephemeral coordination | Redis | 分散式 rate limit 與低延遲通知；不承擔持久正確性 |
| Schema | JSON Schema + Ajv | Fastify 與 Tool contract 可共用標準 schema；runtime 使用獨立 validator instance |
| Attachment bytes | S3-compatible object storage | 不將大檔放入 DB；支援 quarantine 與 lifecycle policy |
| Malware scan | ClamAV-compatible adapter | 成熟可自架；介面允許替換企業 scanner |
| Logging | Fastify/Pino structured logging | 與既有 framework 整合，加入集中 redaction |
| Telemetry | OpenTelemetry API/SDK + OTLP exporter | vendor-neutral trace/metrics；Audit 仍走獨立儲存 |
| Tests | Vitest；integration 使用真實 PostgreSQL／Redis | 沿用工具鏈；驗證 constraint 與 race，不以 mock 取代資料庫語意 |

不在 Model Provider 與 IAM backend 尚未決定前加入特定 SDK。第一個 production adapter 確定時，只新增對應 infrastructure adapter 及 contract tests。

## 11. 錯誤、Retry 與 Idempotency

### 11.1 Error model

公開 error envelope：

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "safe user-facing message",
    "request_id": "...",
    "retryable": false
  }
}
```

必要分類沿用需求：validation、authentication、authorization、rate limit、quota、LLM、Tool、dependency、timeout、unknown outcome、cancelled 與 internal。Provider detail、credential、SQL、stack trace 與資源存在性不得暴露。

HTTP mapping 原則：

- `400/422`：格式或 domain validation。
- `401`：無法驗證 identity。
- `403`：已知且可安全揭露的 authorization denial；敏感資源可回 `404`。
- `404`：不存在、已刪除或為避免跨 Tenant enumeration。
- `409`：idempotency key payload 衝突或不允許的 state transition。
- `429`：rate、quota 或 concurrency hard reject，以 machine code 區分。
- `502/503/504`：正規化 downstream、unavailable 或 timeout；是否 retry 仍由 `retryable` 和操作語意決定。

Run 開始後的錯誤同時產生 safe event 與 terminal state；不能只關閉 SSE connection。

### 11.2 Retry

- 所有 retry 具有 max attempts、exponential backoff + jitter 及 absolute deadline。
- Authentication、Authorization deny、schema、business validation 不 retry。
- Model 429／transient network error只有在 retry budget 內才 retry。
- 已向 client 發出 delta 的 generation 不做透明重播；以 interrupted／failed attempt 表示，避免重複文字。
- Read Tool 或明確支援 idempotency 的 Tool 才可自動 retry。
- 不支援 idempotency的副作用操作絕不自動 retry。

### 11.3 Idempotency

- Client mutation idempotency record 綁定 tenant、subject、route、key、request hash 與 response reference。
- Approval decision 重送相同 decision 回傳原結果；相反 decision 回傳 conflict。
- Tool call 的 logical idempotency key 在所有 safe retry attempt 中保持相同；下游格式由 Tool contract 決定。
- Usage 與 Audit 使用 source event unique key 防止 worker recovery 重複寫入。

## 12. Security Design

- API boundary 完成 authentication；application service 仍對每個資源檢查 tenant 與 ownership／role。
- Repository API 強制要求 tenant scope，schema 使用 tenant-scoped key 與 foreign key；不得提供未限定 tenant 的一般查詢。
- Authorization fail closed；cache 必須有短 TTL、policy version 並支援 invalidation。高風險 Tool 不使用過期 decision。
- Tool request 中的 tenant、subject、credential、policy 與 budget 欄位由 server context 注入，不從 LLM argument 取得。
- Secret 只在 Tool execution 最後一刻透過 `SecretProvider` 取得，使用 scoped/short-lived credential，且不進入 result、event、log 或 LLM context。
- Attachment 使用 server-generated object key、quarantine bucket/prefix、streaming size enforcement 與 content sniffing；不可只信任副檔名或 client media type。
- Prompt injection 視為不可信資料問題：任何 Model output 都不能跳過程式化 authorization、schema、policy、approval 與 budget gate。
- 平台使用 `PUBLIC`、`INTERNAL`、`CONFIDENTIAL`、`RESTRICTED` 四個 canonical classification；組織來源值由 adapter mapping。無法 mapping 時採較嚴格處理並禁止送往尚未明確允許的 Model／Tool。
- Logs、traces 與 events 由集中 sanitizer 套用 allowlist 欄位；禁止以任意物件 spread 寫入 telemetry。
- Audit write permission 與一般 application data delete permission分離；一般 User 不可更新或刪除 Audit。
- Production config 不允許 plaintext long-lived secrets。Local development 可用明確標示的非 production fake／environment adapter。

## 13. 測試策略

### 13.1 測試層級

| 層級 | 驗證內容 |
| --- | --- |
| Unit | state transition、obligation、effective input、budget、retry、redaction、error mapping |
| Repository integration | transaction、partial unique index、sequence、lease、idempotency、tenant-scoped queries |
| Adapter contract | Identity、Authorization、Model、Tool、Blob、Scanner、Secret 的正常與錯誤正規化 |
| Module integration | Session→Run、Tool security path、Approval resume、Attachment lifecycle、usage settlement |
| Security | cross-tenant、IDOR、prompt injection、secret leakage、approval bypass、fail-closed |
| E2E | HTTP + SSE 的主要使用者流程、重連、取消、刪除與 hard reject |
| Evaluation | 固定模型輸入／fake provider 驗證 Tool selection、unsupported claim 與回歸指標 |

預設 CI 不呼叫付費或不穩定的真實 Model。Model adapter contract test 使用 deterministic fake；真實 provider smoke test 由具 secret 的隔離 workflow 手動或排程執行。

### 13.2 必要競態測試

- 兩個 request 同時在 idle Session 送訊息，只能建立一個 active Run；另一訊息依 sequence 注入該 Run。
- Message 與 Run terminal transition 同時發生時，訊息只會明確歸入舊 Run 或建立新 Run，不遺失或重複。
- Cancel 與 Tool completion 同時發生時，不虛構副作用已撤銷。
- Approval decision、expiry 與 policy version change 同時發生時，只有符合 snapshot 的 decision 可執行。
- Worker lease 過期接管不重複執行非冪等 Write Tool。
- Session deletion 與 attachment scan／parse 同時發生時，Attachment 不會恢復為可用。
- Usage admission 併發請求不突破 quota／concurrency constraint。

### 13.3 需求追蹤

實作時維護下列最小對照；測試名稱可調整，但每個範圍必須有可執行證據。

| 需求範圍 | Owning module | 必要驗收測試 |
| --- | --- | --- |
| FR-001–004 | sessions | create、multi-turn、retention、delete visibility/cleanup |
| FR-010–014 | runtime/api | direct answer、follow-up same Run、injection ordering、SSE reconnect、cancel |
| FR-015 | attachments | quarantine、scan gate、classification/auth、delete propagation |
| FR-020–023 | models | provider abstraction、policy、timeout/retry/cancel/usage |
| FR-030–035 | tools | registry/version、schema、exposure、Write Tool idempotency/unknown outcome |
| FR-040–060 | identity/tools | trusted tenant、central auth、fail closed、obligation/effective input |
| FR-070–072 | tools | normalized result、filter/DLP/size、secret removal |
| §18 | approvals | unauthorized/self approval、expiry、snapshot invalidation、reauthorization |
| §19–20 | usage | hard reject、atomic concurrency/quota、budget terminal、usage no rollback |
| FR-080–082 | runtime/models/tools | retry matrix、bounded attempts、partial/dependency failure honesty |
| AUD/OBS/CFG | audit/configuration | correlation、redaction、immutable historical refs、rollback |
| SEC-010–016 | all boundaries | tenant isolation、untrusted input、secret、size、timeout |

## 14. Configuration、部署與營運

### 14.1 Configuration

啟動設定以 schema 驗證，缺少 production-required value 時立即失敗。設定分成：

- process config：ports、database/Redis endpoints、timeouts、telemetry exporter。
- versioned product config：Agent prompt、Model policy、Tool set、usage／retention policy。
- secrets：只保存 Secret Provider reference，不進入一般 config 或資料庫明文。

每個 Run 在建立時 snapshot 所有 version reference。更新 config 只影響新 Run；既有 Run 保持原版本，除非安全 revocation 明確要求終止。Rollback 是將 active pointer 指向既有 immutable version，不修改歷史內容。

### 14.2 Production topology

最小 production topology：

```text
Load Balancer
  └─ API replicas

Worker replicas

PostgreSQL HA deployment
Redis HA deployment
S3-compatible object storage
External IAM/AuthZ, Model, Secret, Scanner and Tool systems
OTLP-compatible observability backend
```

API 不保存 sticky Session state；SSE 可連到任一 replica並由 persisted event sequence 重連。migration 以獨立部署步驟執行，採 backward-compatible expand/migrate/contract，避免多版本 rollout 期間破壞舊 instance。

實際 replica、connection pool、poll interval、retention、backup、SLO、RPO/RTO 與 capacity 必須在 deployment profile 中由負責人定案，不在缺乏量測前寫死。

### 14.3 Observability baseline

- 每個 inbound request 產生 `request_id` 與 trace；Session／Run／Call IDs 作為結構化欄位，不放高 cardinality metric label。
- Metrics 覆蓋需求中的 count、latency、status、active runs、tokens、cost、deny、approval、rate/quota reject。
- Platform overhead、Model latency 與 Tool latency 分開量測。
- Alert threshold 與 SLO 在 capacity test 後配置；程式碼只定義穩定 metric name 與單位。

## 15. 關鍵決策與取捨

### 15.1 模組化單體而非微服務

優點是交易邊界、開發流程與 local testing 簡單；缺點是所有模組共用 release cadence。API／worker entry point 已提供最需要的獨立擴展，待 ownership 或容量證明必要時才沿 port 拆出服務。

### 15.2 PostgreSQL inbox／event log 而非訊息平台

Message 與 Run event 本來就需要持久化、ordering 與 Session transaction。以 PostgreSQL 作可靠 inbox 可避免 DB 與 broker dual-write；代價是極高吞吐時 polling／hot row 可能成為瓶頸。容量未量化前不引入 Kafka。

### 15.3 SSE 而非 WebSocket

v1 client command 都能以 HTTP 表達，只有 server event 需要串流。SSE 原生支援 event ID 與重連；代價是雙向低延遲控制需額外 HTTP request，但不影響 message injection 與 cancel。

### 15.4 薄型自研 runtime 而非框架

可精確實作 security invariant，並避免未使用的 workflow abstraction；代價是 lease、transition 與 recovery 必須自行測試。若未來需求需要 branching workflow、長期 timer 或 Multi-Agent，再以 ADR 比較 LangGraph／workflow engine。

### 15.5 Redis 非持久 source of truth

Redis 提供低延遲 rate limit 與通知，但不承擔 Run 正確性。這使 Redis outage 可以明確降級或 fail closed，而不會遺失對話；代價是需要 database polling fallback。

## 16. 已知限制與可擴充方向

### 16.1 v1 已知限制

- 尚未選定 production Model、IAM/AuthZ、Secret Provider 與資料分類 mapping；對應 adapter 未定案前不能宣稱 production-ready。
- SLA、RPO/RTO、容量與 performance target 仍為 TBD；完成 load test 後才可設定 resource 與 alert threshold。
- Running Run 在 process crash 後只從已持久化的安全點恢復；不保證重建 provider 內尚未持久化的 token stream。
- 不具查詢／冪等能力的 Write Tool 發生不確定結果時需要人工處理，平台不自動 compensation。
- Attachment 只支援明確 allowlist 的類型與 parser，不提供通用文件理解或 RAG。
- Admin UI、外部 Tool SDK package、billing system、跨區 active-active 不屬於 v1 必要成果。

### 16.2 可擴充但不預建

- Model adapter 可增加 provider，不改 Runtime contract。
- IAM/AuthZ、scanner、object storage、secret manager 透過 port 替換。
- Tool handler 未來可從 in-process 移到受控 remote executor，但仍必須通過同一 Tool Gateway。
- PostgreSQL inbox 若經量測成為瓶頸，可導入 broker；資料庫仍保存 authoritative state 與 idempotency record。
- 長時間 workflow、RAG、Multi-Agent、isolated code execution 必須各自重新做 threat model 與 architecture review。

## 17. 實作順序與設計守門

建議依風險及依賴順序實作：

1. Configuration、domain error、ID／clock 與 PostgreSQL migration framework。
2. Identity boundary、Session／Message／Run schema與 transaction invariants。
3. Worker lease、Run state machine、persisted event stream 與 SSE。
4. Usage admission／budget 與 cancellation。
5. Model port、deterministic fake adapter 與基本 agent loop。
6. Tool Registry、完整 security path、Result filtering 與 Audit。
7. Human Approval 與 Controlled Write Tool failure semantics。
8. Attachment quarantine、scan、parse、authorization 與 deletion。
9. Admin operations、retention jobs、telemetry與完整 E2E／security tests。
10. 選定 production adapters 後執行 capacity、failure injection 與 release evaluation。

每一階段都必須：

- 只實作已由需求與本設計支持的能力。
- 讓新增 behavior 對應 requirement、owning module 與 automated test。
- 不以 process-local fake 取代 production 所需的 durability/security semantics；fake 只用於測試或 local profile。
- 若需要偏離本設計，記錄原始決策、實際問題、調整及影響。只有跨模組、安全、資料一致性或不可逆技術選型需要 ADR；私有函式與套件小版本不需要。

## 18. 設計符合性審查

### 18.1 與需求一致

- 所有 v1 mandatory capability 都有 owning module、資料狀態、主要流程及測試入口。
- Session／Run／Message injection、Approval、Write Tool、Attachment 與 usage hard reject 的語意保持需求定義。
- LLM、Model provider 與 Tool 都未被視為 security boundary。
- Durable state、horizontal scaling、audit、trace、version reference、retention 與 tenant isolation 均有明確實作位置。

### 18.2 未超出需求

- HTTP API 與 SSE 是完成既有 API／streaming requirement 的最小 transport 決策，不包含 UI 或聊天平台實作。
- PostgreSQL、Redis、S3-compatible storage 與 ClamAV-compatible scanner只解決需求已明列的 durability、limit、attachment 與 scan 問題。
- Worker、lease、persisted events 與 idempotency record 是多 instance、crash recovery、message ordering 及安全副作用所需機制。
- 沒有加入 RAG、vector database、Multi-Agent、Shell/code execution、通用 workflow engine、Kafka、service mesh 或 speculative microservices。

### 18.3 實作前仍需定案但不阻塞骨架

以下不改變架構，可在 adapter／deployment profile 實作前定案：

| 待決策 | 必要 owner | 最晚決策點 |
| --- | --- | --- |
| production Model Provider、允許的 model list | Platform + Security | production Model adapter 實作前 |
| IAM/AuthZ backend、Tenant mapping、approver policy | Identity/Security owner | production IAM adapter 實作前 |
| classification mapping、Restricted Data model policy | Security/Privacy owner | production data 進入 Model 前 |
| quota、budget、credit 與 attachment limits | Product + Platform/FinOps | production load/cost test 前 |
| Session/Audit retention、backup expiration | Privacy/Compliance + SRE | production data 寫入前 |
| SLO、RPO/RTO、capacity 與 performance target | Product + SRE | production readiness review 前 |
| object storage、scanner、secret manager、telemetry backend | Platform/Security | 對應 production adapter 實作前 |

在上述 production policy 未定案前，可以實作並測試核心模組與 fake／local adapter，但不得宣稱 production rollout 已完成。
