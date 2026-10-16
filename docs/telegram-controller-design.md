# Telegram 多 Session 非同步任務控制器 — 架構設計

- **文件狀態：** v1 設計基準；實際驗證狀態見 §14–§15。真實 Telegram 尚未驗證。
- **需求基準：** [Telegram 控制器需求](telegram-controller-requirements.md)
- **工程基準：** 既有 Node.js、TypeScript、Fastify、ESM 專案
- **範圍：** Telegram 私訊、多 Session、持久排程與三步 demo v1

需求文件定義外部行為；本文件定義符合該行為的實作邊界。需求與設計發生衝突時，不得靜默改變需求。

## 1. 設計摘要

- 延續現有 Node.js + TypeScript + Fastify 專案。維持單程序、模組化程式。
- 使用 Node 內建 `node:sqlite` 的 `DatabaseSync`。SQLite 是必要業務狀態的唯一持久來源。
- SQLite 使用 WAL、`foreign_keys` 與 `busy_timeout` pragma。SQL 使用參數綁定。
- 不新增 npm 套件，不移除既有 Fastify health endpoint。`src/app.ts` 保留 health；`src/server.ts` 負責設定、接線與生命週期。
- 單程序 scheduler、Telegram long polling 與 outbox sender 共用同一 SQLite。資料目錄 exclusive lock 防止多程序同時執行。
- Demo 使用 durable checkpoint 與 cooperative safe point。SQLite transaction 內不得 `await`，也不得呼叫 Telegram 或其他網路服務。
- `node:sqlite` 在 Node 22 是 experimental。此選擇符合目前單人 v1、單程序、無新增套件的需求，但不是 HA 或多節點方案。

## 2. 元件與資料流

```text
Telegram getUpdates
        │ update_id 順序
        ▼
[授權：chat.type=private + from.id=設定值]
        ├── 不符合 ──► ignore + 去重/offset 交易
        ▼
[Router：先辨識明確命令，再辨識補充問題 reply，再處理一般文字]
        ▼
[SQLite 同步交易]
  update 去重 + 固定 user/chat/session/job
  + sequence + 業務變更或直接查詢
  + 回覆 outbox + poll offset
        ├── query ───────────────► 讀取狀態，不建立 Job
        ├── queued ──────────────► QUEUED Job
        └── steering ────────────► 原 Job 的 pending steering
                                      │
                                      ▼
                           [Scheduler 短輪詢／併發限制]
                                      │
                                      ▼
                           [Demo runner safe point]
                       checkpoint + 套用 steering 交易
                                      │
                      狀態改變 + 通知 outbox 交易
                                      ▼
[Outbox sender] ──► Telegram sendMessage 純文字
        │
        └── 問題送達成功：保存 chat_id + message_id → Job mapping
```

Update 路由、資料庫操作與網路傳送是分離的步驟。所有 Telegram 輸入的去重、業務處理、回覆 outbox 與 offset 必須先在同一交易提交，之後才可 poll 較高 offset。

## 3. 模組責任與檔案邊界

新增程式集中於 `src/controller/`。以下記錄 v1 元件責任邊界；實際離線驗證狀態見 §14–§15。

| 檔案 | 責任 |
| --- | --- |
| `src/controller/types.ts` | Session、Job、Message、steering、outbox、Telegram update 的內部型別、IDs、狀態及錯誤類別。 |
| `src/controller/config.ts` | 解析並驗證環境設定；辨識 health mode 與 Bot mode；不讀取或輸出 token 到 log。 |
| `src/controller/store.ts` | SQLite schema／版本、參數化 SQL、同步 transaction、持久化查詢與狀態轉換。交易 callback 不得 await。 |
| `src/controller/router.ts` | Telegram update 授權後的命令／文字路由、輸入驗證、session/job 目標解析及一致錯誤回覆。不得呼叫 Telegram 網路。 |
| `src/controller/runner.ts` | Scheduler、FIFO 分區、bounded concurrency、deadline、三步 cooperative demo、checkpoint 與 safe-point steering。 |
| `src/controller/telegram.ts` | 內建 `fetch` Telegram API client、timeout／abort、polling 與 `sendMessage` response/error 分類。 |
| `src/controller/service.ts` | 接線 Router、Store、Runner、Telegram client、poll loop、outbox loop、啟停與 graceful shutdown。 |
| `src/controller/lifecycle.ts` | 建立權限受限的資料目錄、exclusive lock、SQLite Store 與有序資源釋放。 |

局部輔助程式可在實作階段依既有風格列入，不新增通用框架。既有 `src/app.ts` 繼續提供 `/health`；`src/server.ts` 建立設定與 controller service，並管理 HTTP 與 service lifecycle。

## 4. Domain model 與不變量

### 4.1 IDs、ownership 與 sequence

- Session、Job、Message 使用 server-generated unique IDs。Telegram `update_id`、`chat_id`、`from.id`、`message_id` 是外部識別值，不當作內部 Job／Session ID。
- Telegram user ID 以不失精度的方式保存與比較。Session `owner_user_id` 建立後不可更改。
- UI binding 的 key 是 `(user_id, chat_id)`，value 是目前 selected `session_id`。Binding 只可指向該 owner 的 Session。
- Session 具有單調遞增的 server sequence。新 queued／steering Message 在交易內取 sequence；Job FIFO 順序由初始 queued Message 的 sequence 決定。
- 每次接收新 update 時，Router 在交易內解析並固定目標 session/job。之後切換 binding 不改變已存 Job 或 prompt mapping。

### 4.2 Job 狀態與 Session partition

```text
QUEUED → RUNNING → COMPLETED | FAILED
                  └→ WAITING_INPUT → RUNNING → COMPLETED | FAILED
```

- `COMPLETED` 與 `FAILED` terminal 且不可改寫。Timeout 以 `FAILED` + `TIMEOUT` 表示。
- 同一 Session 最多一筆 `RUNNING` 或 `WAITING_INPUT` Job；可有多筆 `QUEUED` Job。
- `RUNNING` 與 `WAITING_INPUT` 都持有 Session partition。只有 `RUNNING` 佔全域 execution slot。
- `WAITING_INPUT` 恢復前必須取得 execution slot。該 Session 的 queued Job 在其 terminal 前不得啟動。
- 建議以 partial unique index 維持每 Session 至多一筆 `RUNNING`／`WAITING_INPUT` Job。所有 job/session foreign key 與索引須共同維持 partition invariant。

### 4.3 Message 與 steering

`messages` 保存 `kind=queued|steering`、Session sequence、Job ID、內容、接收時間與套用時間。Steering 另有 `pending|applied|not_applied` 狀態。

- 新 Job 與初始 queued Message 在同一交易建立。
- Steering 必須在授權 user 所擁有的目標 Job 上新增，不依 selected Session 推導目標。
- Runner 只在 safe point 套用。已接收、已套用與 Job 完成分別保存，不能以接收狀態冒充已套用。
- Steering 不會立即中斷正在執行的步驟，也不會回溯或復原既有副作用。v1 demo 不執行外部副作用；未來 executor 必須另外定義副作用與恢復保證。
- terminal Job 不接受新 steering。若 Runner 以失敗或 timeout 結束，該 Job 的 pending steering 一併標為 `not_applied`。
- `ask:` Job 在 step 1 前收到 steering 時，step 1 會套用該 steering，但 Job 仍會提出一次問題；使用者仍須提供新的補充才可恢復。
- 最後一步完成交易同時讀取並消費 pending steering、保存最終 checkpoint、關閉補充問題 mapping、改 Job 為 `COMPLETED`，並建立完成通知 outbox。收到新 steering 與完成競爭時，由 SQLite 寫入交易順序決定：先提交的 steering 由完成交易消費；先完成者使後到 steering 失敗。

## 5. SQLite schema 與交易

### 5.1 必要持久資料

至少建立下列資料表或等價 schema：

| 資料 | 必要內容與約束 |
| --- | --- |
| `meta` | Schema version、下一個 Telegram polling offset。 |
| `processed_updates` | `update_id` unique，用於輸入去重；和業務操作、回覆 outbox、offset 同交易。 |
| `sessions` | ID、固定 owner user ID、name、建立時間、下一個 monotonic sequence。 |
| `bindings` | `(user_id, chat_id)` unique key、selected session；外鍵／條件保證 Session owner 相符。 |
| `jobs` | ID、Session、建立 sequence、初始輸入、狀態、demo checkpoint、deadline、failure code、timestamps。 |
| `messages` | ID、Job、Session、kind、sequence、內容、received/applied 時間、steering 狀態。 |
| `outbox` | 通知類型、Session／Job、純文字片段、重試時間／次數、delivery 狀態、prompt 關聯資訊。每個片段分別保存。 |
| `prompt_bindings` | `(chat_id, message_id)` 與 Job、owner、有效狀態的 mapping；送達成功後建立，Job terminal 時關閉。 |
| `job_events`（可選） | 可稽核的狀態／checkpoint 事件；不作為另一份必要狀態來源。 |

使用外鍵與索引維持 Session owner、Job partition、Message 順序、update 去重、outbox 掃描與 prompt mapping。所有 SQL 均使用 binding parameters。對所有連線設定 `foreign_keys`、WAL 與 `busy_timeout` pragma。

### 5.2 交易界線

- Store 提供同步 transaction。transaction 中不得 `await`、sleep、呼叫 `fetch`，或執行其他網路 I/O。
- 每個 Telegram update 在單一交易內完成：檢查／記錄 `update_id`、授權後的命令業務變更或直接 query、回覆 outbox、更新下一個 poll offset。無關或未授權 update 可不建立業務資料，但仍須去重及持久推進 offset。
- DB 交易失敗時 Router 不得處理下一個 update，也不得向 Telegram 傳入較高 offset。重啟時從資料庫讀取已 commit 的 offset。
- Scheduler claim、Job 狀態轉換、checkpoint、steering consumption 與對應 outbox 變更均以交易保存。
- SQLite 是唯一必要狀態來源；process memory 只保存 loop、AbortController、timer 等暫態資訊。

## 6. Telegram 授權、命令與 routing

### 6.1 輸入順序

1. 依 `update_id` 順序接收 update。
2. 檢查 `chat.type === private` 及 `from.id === TELEGRAM_ALLOWED_USER_ID`。不符合時不提供資源資訊，仍持久更新去重與 offset。
3. 驗證文字類型、長度、空內容與命令格式。非文字、空白、超限與錯誤命令寫入明確拒絕回覆，不建立 Job。
4. 先解析明確命令。未知 slash command 是不支援命令，不能降級成普通 queued 工作。
5. 對非命令文字，檢查 `reply_to_message.message_id` 加同一 chat 的 `prompt_bindings`。有效 mapping 將文字導向原 Job；mapping 已關閉時明確拒絕，不能建立其他 Job。
6. 沒有 prompt mapping 的普通文字建立新 queued Job，使用交易當下的 `(user_id, chat_id)` selected Session。
7. 同一交易保存回覆 outbox 和下一個 offset。Outbox sender 在 commit 後才可傳送回覆。

有效補充問題 mapping 的目標以 owner、chat、Job 狀態共同驗證，不受 `/use` 影響。已 terminal 的 Job 或已關閉的 mapping 是過期問題。明確 `/queue`、`/steer` 或其他支援命令優先於 reply mapping。

### 6.2 命令效果

- `/new <name>` 在 transaction 中建立 Session、更新 binding 並加入確認回覆。
- `/sessions`、`/status [job_id]` 直接讀取 Store，並在同一 update transaction 中建立回覆 outbox；不得呼叫 Scheduler 或建 Job。
- `/use <session_id>` 只更新 `(user_id, chat_id)` binding，並先驗證 owner。
- `/queue <text>` 與普通文字建立 queued Job、初始 queued Message、sequence 與確認 outbox。
- `/steer <job_id> <text>` 先查明 Job 屬於授權 owner 且尚未 terminal，再依上限寫入 pending steering。`WAITING_INPUT` Job 可由此重新進入待執行狀態；實際恢復須取得 scheduler slot。
- 回覆問題的文字使用問題 mapping 指定 Job，寫成該 Job 的 steering；不依目前 selected Session 建立新工作。

## 7. Scheduler、demo 與恢復

### 7.1 Scheduler

- 單程序 scheduler 以約 100 ms 短輪詢持久狀態。只有符合 Session partition 規則的最舊 queued Job 可啟動。
- 同時最多 `JOB_CONCURRENCY` 筆 Job 為 `RUNNING`。預設 2。`WAITING_INPUT` 不佔這個 slot，但持有其 Session partition。
- 接收 update 只提交 queued／steering 狀態，不等待 runner 完成。
- scheduler 依持久狀態 claim/resume 工作。重啟時，舊 `RUNNING` 從最後一筆 durable checkpoint 恢復，並仍受目前 concurrency 限制。
- 若目前 `JOB_CONCURRENCY` 小於 durable `RUNNING` Job 數量，啟動拒絕，且不修改任何 Job。

### 7.2 三步 cooperative demo

- Demo 共三步。每步等待可設定的 `DEMO_STEP_MS`，預設 1000 ms；等待需可由 shutdown abort。
- 一步完成後以單一 Store transaction 消費當下可套用的 pending steering、記錄其 `applied`、推進 checkpoint。已 commit 的 step checkpoint 不重播；crash 發生在 commit 前時只重做未 commit step。
- 完成步驟輸出包含完整原始輸入與已套用 steering 內容，使測試可觀察差異。
- 輸入以 `ask:` 開頭時，第一步 transaction 將 Job 標為 `WAITING_INPUT`、保存 checkpoint、建立補充問題 outbox。問題只建立一次；outbox 重試不重建問題。收到有效 reply 或 `/steer` 後，Job 恢復執行原剩餘步驟。
- `WAITING_INPUT` 時 deadline 繼續倒數。等候不占 execution slot，但占用 Session partition。
- 輸入以 `fail:` 開頭時，Job 以明確 failure code 轉為 `FAILED`，pending steering 標成 `not_applied`，關閉問題 mapping，建立失敗 outbox。Terminal 後 scheduler 可執行同 Session 下一筆 queued Job。
- 不引入 LLM、Shell、任意 code、附件、資料庫以外的業務副作用或可執行使用者輸入。

### 7.3 Deadline 與上限

- `MAX_PENDING_JOBS` 預設 100，計算所有 `QUEUED`、`RUNNING`、`WAITING_INPUT` Job。
- `MAX_PENDING_STEERING` 預設 100，計算指定 Job 的 pending steering。
- 輸入上限 4096 字元；在建立任何 Job／Message 前驗證。
- Job 取得第一次 `RUNNING` 時保存絕對 deadline，預設 `JOB_TIMEOUT_MS=60000`。Job 在 `WAITING_INPUT` 時不暫停時間，重啟不重設。
- 到期 transaction 將 Job 設為 `FAILED/TIMEOUT`、將 pending steering 標為 `not_applied`、關閉 prompt mapping、建立失敗 outbox。Terminal transition 釋放 Session partition。

## 8. Telegram polling 與 outbox delivery

### 8.1 Long polling

- 使用內建 `fetch` 呼叫 `getUpdates`。Telegram long-poll `timeout=25` 秒；HTTP request deadline 35 秒。
- 一批 updates 依 `update_id` 升冪逐筆處理。只在各 update 交易成功 commit 後，才可送出高於持久 offset 的下一個 poll offset。
- 以 `processed_updates.update_id` unique constraint 去重。若交易 commit 結果不明，重啟後先讀 durable offset／去重資料，不得跳過未提交 update。
- 不建立 Webhook；不將 polling 與 webhook 混用；不呼叫 `deleteWebhook`。Polling 回報 webhook conflict 時分類為永久設定錯誤並停止 controller。

### 8.2 Outbox sender

- 業務交易只建立 outbox，不在 transaction 內傳 Telegram。
- `sendMessage` deadline 10 秒，純文字，不提供 `parse_mode`。每則通知及每個片段帶 Session ID／名稱與 Job ID。
- 文字切成不超過 3500 UTF-16 code units 的安全片段，不拆開 surrogate pair。每一片有自己的 outbox delivery state 與 retry metadata。
- 成功送出補充問題後，以新的 SQLite transaction 原子標記該 outbox 片段 delivered，並保存 Telegram 回傳的 `chat_id` 和 `message_id` prompt mapping。若先前結果不明而重送，可能有多個 Telegram message ID 指向同一 Job；每個成功回傳的 ID 都可依 Job 有效狀態 routing。
- Telegram `429` 若含有效 `retry_after`，先持久化該 outbox 項目的 `next_attempt_at`，再以可 abort 的 sender backoff 暫停整個 sender 至冷卻期滿；冷卻期間不傳送其他 outbox 項目。Polling 與 runner 照常工作。缺少有效 `retry_after` 時分類為 transient，依一般 bounded backoff 重試。網路錯誤及 `5xx` 只延遲該項，不暫停整個 sender。永久 `4xx` 將該片標為 delivery `FAILED`，不重跑 Job；`/status` 可顯示 Job 通知 delivery 失敗。
- 同一 batch 的長訊息片段依序送達。不同 batch 不保證全域順序；獨立 status reply 可先於較早通知送達。
- 若 Telegram 收到 prompt，但 client 未取得 `message_id`，系統不能可靠建立 reply binding。使用者可使用明確 `/steer <job_id> <text>`，或在 prompt 重送且已知 `message_id` 後 reply。
- `401`／無效 token 與 polling webhook／credential conflict 分類為 controller fatal error，停止 loop，不忙迴圈重試。Bot blocked 等特定收件人永久錯誤標記 delivery `FAILED`，不洩露外部 URL。
- Delivery 為 at-least-once。Telegram 已接收但本地未記錄成功時可能重複傳送；不承諾 exactly-once。已 `delivered` 的 outbox 不會因重啟重送。

## 9. 持久化選型、程序生命週期與設定

### 9.1 SQLite 與單程序限制

- 使用 `node:sqlite` `DatabaseSync`，保持無新增 dependency。Node 22 的 `node:sqlite` 為 experimental；需在正式啟用前明確接受其 API／runtime 風險。
- 啟動時設定 WAL、`foreign_keys`、`busy_timeout`，並以 `meta` schema version 管理資料格式。所有 SQL 參數化。
- `DatabaseSync` 是同步 API。工作量限制為單人 v1，需避免長時間 transaction；交易內不得等待網路或 demo timer。
- SQLite 檔案是唯一必要狀態來源。需備份 DB，且備份／還原流程須正確處理 WAL 狀態；單檔複製若未取得一致 snapshot 不視為可靠備份。
- v1 不提供自動 retention。操作者負責管理、備份與清理本機資料。
- 此方案不是 HA，不支援水平擴展或多 controller process。

### 9.2 Linux kernel lock

- Bot 模式只支援 Linux，並固定使用 `/usr/bin/flock`（util-linux），不安裝依賴、不提供 PID fallback。資料目錄必須 canonical、由目前 UID 擁有且為 `0700`。此鎖只支援本機 filesystem；共享跨主機 data、HA 與多程序資料庫存取不受支援。
- `controller.kernel.lock` 是永久非秘密 anchor。以 no-follow、安全模式開啟後，Node 持有原始 FD；短命 `/usr/bin/flock --exclusive --nonblock --conflict-exit-code 73 3` helper 透過 FD 3 取得 kernel lock。Anchor 不截斷、不 unlink、不 rename；正常關閉後仍存在，存在本身不表示 busy，也不得叫操作者刪除它解鎖。
- `controller.lock` 是給舊版 `wx` 程序相容的原子 marker，記錄版本、PID、隨機 token 與 anchor device/inode。Kernel lock 成功後，若 marker 是同 anchor 的完整已知新版 record，代表遵守本協定的舊 owner 已不再持鎖，可原子取代 stale record。正常關閉只刪除 token 與 inode 都符合本 lease 的 marker。
- Numeric PID-only marker（不論 PID 活著或不存在）、空 marker、毀損／未知格式或不同 anchor marker 一律保留並 fail closed。程式不得依 PID、mtime 或 timeout 判斷 stale，也不得猜測修復。操作者須先確認所有 Controller 停止，再一次性確認移除 legacy／unknown `controller.lock`；不得移除 anchor 或運作中程序的 lock 檔。
- SIGKILL／crash 由 Linux 自動釋放 kernel lock。下次啟動可在取得相同 anchor lock 後回收有效新版 stale marker。非 Linux、helper 不存在、逾時或其他不確定錯誤均安全拒絕啟動。
- Shutdown 與 startup cleanup 順序為關閉業務 SQLite DB，再刪除確切自有 marker，最後關閉 anchor FD。若 DB close 失敗，不得提早釋放 kernel lock。

### 9.3 環境與生命週期

| 變數 | 規則 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | 與 allowed user ID 同時設定才啟用 Bot；不得記錄。 |
| `TELEGRAM_ALLOWED_USER_ID` | 唯一授權 Telegram user ID。 |
| `CONTROLLER_DATA_DIR` | 預設 `./data`。 |
| `JOB_CONCURRENCY` | 預設 `2`。 |
| `DEMO_STEP_MS` | 預設 `1000`。 |
| `JOB_TIMEOUT_MS` | 預設 `60000`。 |
| `MAX_PENDING_JOBS` | 預設 `100`。 |
| `MAX_PENDING_STEERING` | 預設 `100`。 |
| `HOST`、`PORT` | 延續既有 health server 設定。 |

兩個 Telegram 變數都未設定時，只啟動 health mode；只設定一個或任一設定無效時，啟動失敗。Bot 模式取得 lock、開啟／驗證 DB、恢復持久狀態，再啟動 scheduler、polling 與 outbox sender。永久 polling credential／conflict error 停止 controller。

Graceful shutdown 順序：停止接收新 update、abort polling fetch 與 demo sleeps、等待 runner／outbox／poll loop 結束、關閉 SQLite、最後釋放 lock。Runner 只能在持久 checkpoint 邊界恢復；外部副作用 executor 未來必須另定 idempotency／unknown-outcome 保證。

`/health` 保留既有回應，僅作 liveness，不宣稱 SQLite、Telegram 或 outbox ready。

## 10. 失敗處理與秘密保護

- 未授權 update、跨 owner ID 與不存在 ID 不得回傳 Session／Job 名稱或確認其存在。
- 空內容、非文字、未知命令、格式錯誤、輸入超限、未選 Session、容量超限、terminal steering 與過期補充問題都要有穩定、清楚的使用者回覆；業務資料不得留下半筆寫入。
- SQLite error 時不推進 Telegram offset、不處理下一 update；不透過暫存記憶體假裝已持久化。
- `FAILED/TIMEOUT` 是 Job 結果；outbox delivery `FAILED` 是通知結果。通知失敗不重跑 Job，兩者分別呈現在 `/status`。
- Log 不輸出 Bot token、完整含 token 的 URL、Telegram response 中的敏感 URL 或未清理外部錯誤。錯誤記錄採明確分類與安全摘要。
- Bot blocked、invalid token、webhook conflict 需使用明確錯誤分類。Invalid polling credential 與 polling/webhook conflict 終止 controller，不作無限快速 retry。
- 不自動刪除 webhook，也不在測試中連線 Telegram。

## 11. 取捨與已知限制

| 決策 | 取捨 |
| --- | --- |
| `node:sqlite` + `DatabaseSync` | 不增加套件且 transaction 語意直接；Node 22 API 仍屬 experimental，同步操作也會占用 event loop。適合目前單人、低流量 v1，不代表多租戶企業規模或 HA。 |
| SQLite WAL + 單程序 lock | 以本地 durable transaction 簡化 update、checkpoint、steering、outbox 一致性；不提供多程序並行、水平擴展或自動 failover。 |
| cooperative demo | 可直接驗證 queued、steering、安全點、等待輸入、deadline 與重啟；不代表未來有外部副作用的 Agent 可安全重播。 |
| at-least-once outbox | 對不明網路結果保留重試能力；允許通知重複，不宣稱 exactly-once。 |
| `WAITING_INPUT` 保留 Session partition | 保證同 Session 工作順序；其他 Session 可使用剩餘執行 slot，該 Session 仍等候回覆或 deadline。 |
| 僅 liveness health | 保持現有 HTTP contract；不以 health response 誤報 controller 依賴 readiness。 |

SQLite 必須有可操作的備份與還原流程。部署不得以多副本方式啟動同一資料目錄；不支援水平擴展。Backup／restore 操作流程、真實 Telegram 與 Node 24 執行矩陣尚未驗證。

## 12. 手動建立 Bot 與部署驗證需求

這些是部署前的操作者步驟，不代表本次已連線或驗證：

1. 操作者透過 Telegram 官方 Bot 管理流程手動建立 Bot，將 token 放入受控環境秘密來源；不得提交至 repository、文件或 log。
2. 設定唯一允許的 Telegram numeric user ID。確認 Bot 只預期接受該使用者的 private chat。
3. 使用 polling 前由操作者確認該 Bot 未設定 webhook。若收到 webhook conflict，controller 停止；由操作者另行處理，不由程式自動刪除。
4. 建立權限受限且可持久備份的資料目錄，確保只啟動一個 controller process。
5. 部署驗證至少檢查 health liveness、授權使用者可執行 `/start`、建立／切換 Session、排入與查詢 demo、未授權者不取得資源資訊、重啟後 Job／outbox 恢復，以及 log 無 token。
6. 部署前檢查 Node 22 `node:sqlite` experimental 風險、SQLite 備份還原程序、lock 人工復原程序與單程序限制。

部署驗證不應連入真實外部業務系統；Telegram 手動 smoke test 僅可由部署操作者在明確授權環境執行。

## 13. 歷史程式清理邊界

實作已依核准範圍移除舊的 `src/modules/`、`src/infrastructure/memory/`、`src/shared/` 與 `test/unit/` 舊業務檔。新程式位於 `src/controller/`，entry point 為 `src/server.ts`，`src/app.ts` 的 `/health` contract 與 `test/app.test.ts` 保留。設定、相依與 scripts 保持不變；`package.json` 僅更新 description。新測試位於 `test/controller/`。

先前 Enterprise AI requirements、architecture 與 review fix plans 仍保留為歷史文件。README 已改為 Telegram controller 說明。

## 14. Offline test evidence

以下記錄 v1 的離線測試證據。完整命令為 `npm test`。本次完整執行涵蓋 9 個 `test/controller/*.test.ts` 檔、`test/app.test.ts` 與 63 個測試。測試使用本機 SQLite、fake fetch／Telegram response、受控時間與本機 HTTP listener，沒有連線 Telegram 或其他外部服務。標示「部分」表示只覆蓋列出的情境，不代表整個 PT 通過。

| Offline test ID | 驗證項目 | 離線測試檔與狀態 |
| --- | --- | --- |
| PT-01 | Health-only／Bot 設定組合、無效環境值、資料目錄 lock 與第二程序拒絕。 | `test/controller/config.test.ts`, `test/controller/lifecycle.test.ts`, `test/controller/server.test.ts`, `test/app.test.ts` — 離線驗證；完整 health-only 與 Bot server 啟停均實際測試。 |
| PT-02 | `private` + `from.id` 授權；群組、非文字、username 假冒與未授權資訊隱私。 | `test/controller/router.test.ts`, `test/controller/telegram.test.ts` — 離線驗證；含同 username、不同 ID 情境。 |
| PT-03 | `/new`、`/sessions`、`/use` owner 限制及 `(user_id, chat_id)` binding。 | `test/controller/router.test.ts`, `test/controller/store.test.ts` — 離線驗證；含 owner filter、跨 owner／missing 等價回覆與 reopen binding。 |
| PT-04 | 一般文字、`/queue`、無 selected Session、未知命令、空字串、4097 字元與工作容量上限。 | `test/controller/router.test.ts` — 離線驗證；含 `/queue` 寫入與三種 active 狀態容量拒絕。 |
| PT-05 | Session FIFO、active partition unique invariant、跨 Session concurrency 上限及 `WAITING_INPUT` 不佔 slot。 | `test/controller/runner.test.ts` — 離線驗證；含 partial unique index 衝突 rollback。 |
| PT-06 | queued／running／waiting Job steering、pending/applied/not_applied、safe-point 套用與 terminal 拒絕。 | `test/controller/router.test.ts`, `test/controller/runner.test.ts` — 離線驗證；含 RUNNING safe point、順序與 terminal 拒絕。 |
| PT-07 | Completion 與新 steering 的交易競爭；最後一步同交易消費 steering 並 terminalize。 | `test/controller/runner.test.ts` — 離線驗證；同步 SQLite 先 steer／先 complete 兩種順序。 |
| PT-08 | `/status`、`/sessions` 直接查詢、不建立 Job，及跨 owner 查詢不洩露。 | `test/controller/router.test.ts` — 離線驗證；含不洩漏 existing/missing 對照。 |
| PT-09 | `ask:` 只建一次 prompt、送達後 message mapping、reply 不受 `/use` 影響、過期 reply 不 fallback。 | `test/controller/router.test.ts`, `test/controller/outbox.test.ts`, `test/controller/service.test.ts` — 離線驗證；含 sender mapping 與 Session 切換後恢復。 |
| PT-10 | 三步 checkpoint、`fail:`、timeout、pending steering failure、重啟恢復與 deadline 不重設。 | `test/controller/runner.test.ts`, `test/controller/store.test.ts` — 離線驗證；checkpoint 1 重開後只執行兩步、deadline timeout，且降低 concurrency 時 RUNNING rows 不變。 |
| PT-11 | `update_id` 去重、業務變更／outbox／offset 原子性及 DB error 不跳 update。 | `test/controller/router.test.ts`, `test/controller/service.test.ts` — 離線驗證；SQL trigger 導致 Router rollback，下一 poll 使用未提交 offset 重試。 |
| PT-12 | Outbox 片段 UTF-16 長度與 surrogate pair、delivered 不重送、429 全域 sender 冷卻、network／5xx backoff、永久 4xx 與 HTTP body 清理。 | `test/controller/outbox.test.ts`, `test/controller/telegram.test.ts`, `test/controller/service.test.ts` — 離線驗證；sender 冷卻期間不送其他項目，polling／runner 照常工作，shutdown 可 abort 冷卻；HTTP early classification 會清理未讀 body。 |
| PT-13 | Prompt 回傳 message ID mapping、Bot blocked、invalid token、webhook conflict、停止 polling 且不呼叫 deleteWebhook。 | `test/controller/service.test.ts`, `test/controller/server.test.ts`, `test/controller/telegram.test.ts` — 離線驗證；含 fatal shutdown、prompt mapping 與 API 名稱斷言。 |
| PT-14 | Graceful shutdown 的 abort／loop join／DB close／lock release 順序，以及不含秘密的 log。 | `test/controller/service.test.ts`, `test/controller/server.test.ts`, `test/controller/lifecycle.test.ts` — 離線驗證；fatal 時等待 loop、關閉 DB、釋放 lock，並檢查 logger。 |
| PT-15 | Demo 不呼叫 LLM、Shell、任意 code、附件或外部業務服務。 | `test/controller/service.test.ts`, `test/controller/server.test.ts` 只觀察到 fake API 的 `getUpdates`／`sendMessage`；父 agent 對本次來源檔 review 確認檢視範圍內沒有 LLM／Shell 業務模組。不是靜態掃描，也不證明未來變更行為。 |

## 15. 需求到設計與離線測試追蹤

| 需求 ID | 設計位置 | Offline test ID（實際狀態見 §14） |
| --- | --- | --- |
| TC-REQ-001 私訊授權與隱私 | §6、§10 | PT-02、PT-08 |
| TC-REQ-002 IDs、owner、binding、sequence | §4.1、§5.1、§6 | PT-03、PT-05、PT-11 |
| TC-REQ-003 queued 工作與原子建立 | §5.2、§6.2、§7.3 | PT-04、PT-11 |
| TC-REQ-004 steering、安全點與 terminal 規則 | §4.3、§7.2、§7.3 | PT-06、PT-07、PT-09、PT-10 |
| TC-REQ-005 直接查詢 | §6.2 | PT-08、PT-11 |
| TC-REQ-006 Telegram 命令與 reply routing | §6 | PT-03、PT-04、PT-08、PT-09 |
| TC-REQ-007 partition、FIFO、併發 | §4.2、§7.1 | PT-05 |
| TC-REQ-008 demo、checkpoint、ask/fail | §7.2 | PT-06、PT-09、PT-10、PT-15 |
| TC-REQ-009 上限與 deadline | §7.3 | PT-04、PT-10 |
| TC-REQ-010 durable state 與重啟 | §5、§7.1–§7.3、§8.2 | PT-10、PT-12 |
| TC-REQ-011 polling、update 原子性 | §5.2、§8.1 | PT-11、PT-13 |
| TC-REQ-012 outbox、通知與 retry | §8.2、§10 | PT-09、PT-12、PT-13 |
| TC-REQ-013 設定、lock、shutdown、health | §3、§9 | PT-01、PT-14 |
| TC-REQ-014 secret 與 transport 安全 | §8.1、§8.2、§9.2、§10、§12 | PT-02、PT-13、PT-14 |

上表追蹤需求與 PT IDs。PT 狀態只依目前離線測試證據判定。未標示通過的項目仍未完整驗證。真實 Telegram、Bot token、部署及 backup／restore 流程均未驗證。
