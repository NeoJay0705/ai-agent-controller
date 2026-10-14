# Telegram 多 Session 非同步任務控制器 — 需求規格

- **文件狀態：** v1 需求基準；驗收狀態見本文末節。真實 Telegram 尚未驗證。
- **目標名稱：** Telegram 多 Session 非同步任務控制器
- **版本：** v1
- **設計文件：** [Telegram 控制器架構設計](telegram-controller-design.md)

本文定義 v1 的使用行為與可驗收要求。`MUST` 表示 v1 必須符合。實作與離線測試證據只依本文末節追蹤；未列為已驗證的行為仍未驗證。

## 1. 目標與使用情境

本系統讓唯一設定的使用者透過 Telegram 私訊 Bot，建立並切換多個 Session，排入非同步示範工作，向既有工作補充 steering，並直接查詢狀態。系統須持久保存工作與通知狀態，並在程序重啟後恢復。

v1 先提供可驗證排程與 steering 行為的三步示範工作。v1 不使用 AI，也不執行實際外部業務操作。

主要使用情境：

1. 使用者建立數個 Session，在其中一個 Session 排入工作，再切換到另一個 Session 繼續操作。
2. 使用者於同一 Session 排入多筆工作。工作依接收順序執行；同一時間只有一筆工作能持有該 Session 的執行分區。
3. 工作執行時，使用者用 `/steer` 或回覆該工作提出的補充問題，將資料送入原 Job。Runner 在安全點套用資料。
4. 使用者查詢 Job 或目前 Session 的工作摘要。查詢直接讀取持久狀態，不建立 Job，也不進入工作佇列。
5. 程序重啟後，系統從持久 checkpoint 恢復工作，並繼續傳送尚未完成的通知。

## 2. 範圍

### 2.1 v1 範圍

- 限制 Bot 僅服務一個設定好的 Telegram user ID，且只接受私訊。
- 建立、列出、切換 Session；Session 是 server-side partition。
- 接收 queued 工作與指定 Job 的 steering。
- 直接查詢工作狀態。
- 以單程序 scheduler、SQLite 與 outbox 提供持久化、重啟恢復和通知。
- 提供三步 cooperative demo、補充問題及明確失敗示範。
- 保留既有 HTTP `/health` liveness endpoint。

### 2.2 不在 v1 範圍

- LLM、Agent framework、任意程式碼、Shell、附件、檔案處理或實際外部業務副作用。
- 群組、頻道、Webhook、其他 Telegram 使用者或其他通訊平台。
- 多程序／水平擴展、高可用、分散式排程或外部 queue。
- 使用者、Tenant、IAM、權限管理或管理者介面。
- 對已發出的外部副作用提供重播安全保證。

## 3. 身分、識別碼與排序

### TC-REQ-001 — 私訊授權與資料隱私

- 唯一授權依據是 `TELEGRAM_ALLOWED_USER_ID` 與 Telegram update 的 `from.id` 相符，且 `chat.type` 為 `private`。
- 不得以 username、display name 或訊息內容作為授權依據。
- 未授權 update 不得建立、查詢或改變任何 Session、Job、binding 或訊息。拒絕處理時不得洩露 Session、Job 或其存在與否。
- 不支援群組及非文字輸入。

### TC-REQ-002 — IDs、owner 與 UI binding

- Session ID、Job ID、Message ID 由 server 產生，並在系統內唯一。Telegram `update_id` 與 Telegram `message_id` 保留為來源識別資料，不取代內部 ID。
- Session 的 owner 固定為建立它的 Telegram user ID，不可轉移。
- 選取中的 Session 以 `(user_id, chat_id)` binding 保存。新工作接收時，必須在接收該 update 的同一交易內解析並固定 Session；之後 `/use` 不得改變既有 Job 或 steering 的目標。
- 各 Session 維護 server-side 單調遞增 sequence。每筆 queued／steering Message 在接收交易內取得 sequence；同 Session 工作依 Job 建立 sequence FIFO 執行。

## 4. Job、Session 分區與訊息語意

### TC-REQ-003 — queued 工作

- 一般文字與 `/queue <text>` 都建立新的 `QUEUED` Job；普通文字預設 queued。
- 兩者都必須使用目前 `(user_id, chat_id)` 選中的 Session。未選 Session 時須清楚拒絕，不得建立 Job。
- 新 Job、其初始訊息、更新 Telegram update 去重／offset，以及回覆 outbox 項目必須原子提交。
- 達到未結束 Job 上限時，必須拒絕新工作並說明原因，不得部分建立資料。

### TC-REQ-004 — steering

- `/steer <job_id> <text>` 將 steering 寫入指定的既有 Job，不建立新 Job，也不依目前 UI binding 重新選擇目標 Session。
- Reply to 一則已記錄補充問題的文字訊息，會將回覆綁定到該問題所屬 Job；此規則不受目前 `/use` 選擇影響。
- Steering 先保存為 `pending`，在 Runner 安全點才可成為 `applied`。接收成功不代表已套用，也不代表 Job 已完成。
- 接收 steering 不承諾立即中斷正在執行的步驟，也不會回溯或復原已發生的副作用；v1 demo 本身不執行外部副作用。
- 對非 terminal Job 的 steering 會保留在原 Job；`QUEUED` Job 的 steering 也不建立另一個工作，並在 Runner 安全點處理。
- Job 已 terminal 時必須拒絕 steering，不得改寫 terminal 狀態，也不得把 steering 轉成新 queued Job。
- Job 失敗或逾時時，尚未套用的 steering 必須標為 `not_applied`。
- Job 完成判定與 pending steering 的消費必須在同一儲存交易協調。競爭中的 steering 若先提交，完成交易必須處理它；完成交易若先提交，後到的 steering 必須被拒絕。

### TC-REQ-005 — 查詢

- `/status [job_id]` 是直接讀取：有 `job_id` 時查該 Job；沒有時回報目前選中 Session 的工作摘要。
- `/sessions` 列出使用者擁有的 Session；`/help` 與 `/start` 提供使用說明。
- 查詢不得建立 Job、Message、steering 或排程工作。Telegram update 去重、poll offset 與查詢回覆 outbox 仍須依接收交易規則持久化。
- 跨使用者或不存在的 Session／Job 使用不洩漏資源資訊的回覆。

### 4.1 狀態定義

Job 狀態只有：

```text
QUEUED → RUNNING → COMPLETED
                  ├→ FAILED
                  └→ WAITING_INPUT → RUNNING
                                     ├→ COMPLETED
                                     └→ FAILED
```

- `COMPLETED`、`FAILED` 是 terminal。Terminal Job 不可改寫或恢復。
- Timeout 以 `FAILED` 加 `failure_code=TIMEOUT` 表示，不新增 Job 狀態。
- 每個 Session 最多一筆 `RUNNING` 或 `WAITING_INPUT` Job。Session 可同時有多筆 `QUEUED` Job。
- `RUNNING` 與 `WAITING_INPUT` 都佔用 Session 分區；`WAITING_INPUT` 不佔 scheduler 的執行併發 slot。
- Steering 狀態為 `pending`、`applied` 或 `not_applied`。接收、套用、完成是不同事件。

## 5. Session 與 Telegram 命令

### TC-REQ-006 — 命令契約

| 命令／輸入 | 行為 |
| --- | --- |
| `/start`、`/help` | 顯示使用方式與支援命令。 |
| `/new <name>` | 建立 Session，並在同一操作中選中它。 |
| `/sessions` | 列出此使用者的 Session。 |
| `/use <session_id>` | 驗證 owner 後切換目前 chat binding。 |
| 一般文字 | 建立 queued Job。若為有效補充問題的 reply，則視為原 Job 的 steering。 |
| `/queue <text>` | 明確建立 queued Job。 |
| `/steer <job_id> <text>` | 將文字送入指定的非 terminal Job。`WAITING_INPUT` Job 可因此恢復。 |
| `/status [job_id]` | 直接查詢 Job 或目前 Session 工作摘要。 |

明確命令優先於補充問題 reply routing。未知命令不得當成一般文字排入工作。未知／不支援命令、非文字訊息、空內容、超過 4096 字元、格式錯誤、沒有選中 Session 或沒有資源權限時，系統須提供清楚且不洩露其他使用者資料的回覆。

補充問題 mapping 至少以 `(chat_id, Telegram message_id)` 關聯 Job。只有仍有效且屬於已授權私訊的 mapping 才可接收回覆。過期補充問題必須拒絕，且不得 fallback 成新工作。

## 6. 執行、示範工作與限制

### TC-REQ-007 — 分區排程與併發

- 工作接收不得等待工作執行完成；接收交易成功後回覆已排入。
- 每 Session 依 Job sequence FIFO。其他 Session 可獨立執行，但同時 `RUNNING` Job 數不得超過設定的併發上限。
- Scheduler 以短輪詢工作，建議約 100 ms。`WAITING_INPUT` 不消耗執行 slot；恢復前仍須取得可用 slot。
- 預設 `JOB_CONCURRENCY=2`。

### TC-REQ-008 — Demo 與協作安全點

- Demo 是三步 cooperative 工作；預設每步 1000 ms，並可設定。
- 每步完成時，系統須在交易內套用 pending steering 並保存 checkpoint。已保存的 checkpoint 不得在重啟後重播。
- 最後一步的 pending steering 消費與 Job 完成，必須在同一交易中完成。完成輸出須包含原始輸入與已套用補充資料，以驗證 steering 效果。
- 以 `ask:` 開頭的輸入會在第一步後轉成 `WAITING_INPUT`，並持久建立一則補充問題 outbox 訊息。第一步前收到的 steering 會在 step 1 套用，但 Job 仍須提出一次問題；使用者仍須提供新的補充才可恢復原 Job。收到已確認送達問題的有效 reply 或 `/steer` 後恢復原 Job，不建立另一 Job。每個 Job 只問一次；重啟不得重複建立問題。
- 以 `fail:` 開頭的輸入會示範明確 `FAILED`，pending steering 標為 `not_applied`，並通知失敗。失敗後同 Session 的下一個 queued Job 可繼續。
- 不加入 LLM、Shell、任意 code、附件或外部副作用。

### TC-REQ-009 — 上限與執行期限

- 預設全系統未結束 Job 上限為 100；預設每 Job pending steering 上限為 100；每筆輸入最多 4096 字元。
- Job 執行 deadline 預設 60000 ms，從 Job 開始執行時計算，包含 `WAITING_INPUT` 時間；deadline 必須持久保存，重啟不得重設。
- Deadline 到期時以 `FAILED`、`failure_code=TIMEOUT` 結束，將 pending steering 標為 `not_applied`，排入失敗通知並釋放 Session 分區。
- 所有上限與逾時拒絕須保留一致狀態，不得留下半筆 Job 或 Message。

## 7. 持久性、Telegram transport 與通知

### TC-REQ-010 — Durable state 與重啟

- SQLite 是唯一必要狀態來源。重啟後須保留 Session、binding、Job、Message、steering、poll offset、prompt mapping 與 outbox。
- `RUNNING` Job 從 durable checkpoint 恢復；`QUEUED`、`WAITING_INPUT` 與未完成 outbox 保留。已 delivered outbox 不得再次排入。
- 若 `JOB_CONCURRENCY` 小於 durable `RUNNING` Job 數量，啟動必須拒絕，且不得修改任何 Job。
- v1 不提供自動 retention。操作者負責管理、備份與清理本機資料。
- 完成／失敗 transition、checkpoint、steering 消費、Job event（若有）與相關通知 outbox 必須以交易維持一致。
- 未來加入副作用 executor 時，不得直接宣稱沿用 demo 的 checkpoint 重啟保證。

### TC-REQ-011 — Polling 與 update 原子性

- 使用 Telegram `getUpdates` long polling，Telegram timeout 為 25 秒，HTTP deadline 為 35 秒；依 `update_id` 順序處理。
- 以 `update_id` 去重。Update 去重、命令業務變更、回覆 outbox 與下一個 polling offset 必須在同一 SQLite 交易提交。
- 只有交易提交後才能將較高 offset 傳給 Telegram。忽略的無關／未授權 update 仍須持久推進 offset；資料庫失敗時不得跳過 update。
- 不得同時使用 webhook 與 polling，也不得自動刪除 webhook。

### TC-REQ-012 — Outbox 與通知

- 工作完成、失敗與補充問題通知須經 outbox；每項通知都帶 Session 與 Job 資訊。
- Outbox 訊息使用純文字，不設定 `parse_mode`。每片不超過 3500 UTF-16 code units，且不得拆開 surrogate pair。每片各自持久化並重試。
- Telegram `429` 若含有效 `retry_after`，sender 必須先持久化該 outbox 項目的重試時間，再暫停整個 sender 至冷卻期滿；冷卻期間不得傳送其他 outbox 項目。Polling 與 runner 照常工作。缺少有效 `retry_after` 時依一般 transient bounded backoff 重試。網路錯誤與 `5xx` 只重試該項，不暫停整個 sender；永久 `4xx` 將該 delivery 標為 `FAILED`，並可由 `/status` 查到，不重跑 Job。
- 補充問題送達後，保存送訊息回傳的 `chat_id` 與 `message_id`，供 reply 綁定 Job。
- 通知採 at-least-once。網路結果或 commit 結果不明時可能重複；不得宣稱 exactly-once。
- 同一 batch 的長訊息片段依序傳送；不同 batch 不保證全域順序，獨立 status reply 可先於較早通知送達。
- 若 Telegram 已收到 prompt，但 client 未取得 `message_id`，系統不能可靠建立 reply binding。使用者可用明確 `/steer <job_id> <text>`，或等待成功回傳 ID 的 prompt 重送後再 reply。
- Bot blocked、token invalid、webhook conflict 必須分類處理。永久 polling credential／conflict error 終止 controller，不得忙迴圈重試。

## 8. 設定、秘密與操作

### TC-REQ-013 — 啟動設定與生命週期

| 環境變數 | 規則 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot 模式必要秘密；不得寫入 log。 |
| `TELEGRAM_ALLOWED_USER_ID` | Bot 模式必要；唯一授權使用者 ID。 |
| `CONTROLLER_DATA_DIR` | 預設 `./data`；資料目錄需限制存取。 |
| `JOB_CONCURRENCY` | 預設 `2`。 |
| `DEMO_STEP_MS` | 預設 `1000`。 |
| `JOB_TIMEOUT_MS` | 預設 `60000`。 |
| `MAX_PENDING_JOBS` | 預設 `100`。 |
| `MAX_PENDING_STEERING` | 預設 `100`。 |
| `HOST`、`PORT` | 延續既有 health server 設定。 |

- 兩個 Telegram 設定都未設定時，只啟動 health mode；只設定一個或設定無效時，啟動失敗。
- Bot 模式啟動 scheduler、polling 與 outbox sender。單程序以資料目錄 exclusive lock 防止第二個程序；發現既存 lock 時啟動失敗，不自動判斷或清除 stale lock。
- Graceful shutdown 停止接收 update、abort fetch 與 sleep、等待 loop 結束、關閉 DB，再釋放 lock。
- `/health` 是 liveness，不代表 DB、Telegram 或 outbox readiness。

### TC-REQ-014 — Secret 與 transport 安全

- Token、完整含 token 的 Telegram URL、完整外部錯誤 URL 不得進入 log。Log 僅記錄已分類且移除敏感資料的錯誤。
- 程序不得自動呼叫 Telegram `deleteWebhook`。Webhook／polling 衝突須明確回報並終止 polling controller。
- SQLite 檔案須納入備份；此單機方案不提供 HA 或水平擴展。

## 9. 可測試驗收條件

以下是 v1 驗收條件。離線測試證據與未驗證項目見 9.1。

| ID | 可驗收條件 | 需求 |
| --- | --- | --- |
| AT-01 | 無兩個 Telegram 變數時 health mode 可啟動；只設定一個或無效值時啟動失敗。 | TC-REQ-013 |
| AT-02 | Bot 模式拒絕非 private chat、錯誤 `from.id` 與群組 update；username 相同不能取得授權。 | TC-REQ-001 |
| AT-03 | 未授權 update 不建立或查詢資源，回應不含 Session／Job 存在資訊，且 offset 持久推進。 | TC-REQ-001, 011 |
| AT-04 | `/new` 建立並選中 Session；`/sessions` 只列本人 Session；`/use` 不能切換到他人 Session。 | TC-REQ-002, 006 |
| AT-05 | 在無 selected Session 時，一般文字與 `/queue` 都被清楚拒絕，且無 Job／Message 留存。 | TC-REQ-003, 006 |
| AT-06 | 一般文字與 `/queue` 會建立 `QUEUED` Job；同 Session 多 Job 依 sequence FIFO。 | TC-REQ-003, 007 |
| AT-07 | 同一 Session 不會同時有兩筆 `RUNNING`／`WAITING_INPUT`；不同 Session 可並行但不超過設定上限。 | TC-REQ-007 |
| AT-08 | `WAITING_INPUT` 仍阻擋同 Session queued Job，但不占執行 slot；恢復後重新受全域併發上限約束。 | TC-REQ-007, 008 |
| AT-09 | `/steer` 對 `QUEUED`／`RUNNING`／`WAITING_INPUT` 的有效非 terminal Job 建立 steering 而不建立 Job；Runner 只在安全點套用。 | TC-REQ-004, 008 |
| AT-10 | Job 完成與 pending steering 在同一交易競爭；先提交的 steering 被消費，terminal 後到達的 steering 被拒絕且 terminal 狀態不變。 | TC-REQ-004, 008 |
| AT-11 | Job 失敗或逾時後所有 pending steering 為 `not_applied`；其 Session queued Job 可繼續。 | TC-REQ-004, 008, 009 |
| AT-12 | `/status`、`/sessions` 等查詢不建立 Job；指定他人 Job ID 不洩露存在資訊。 | TC-REQ-001, 005 |
| AT-13 | Reply 至已記錄問題會送到原 Job，即使期間已 `/use` 其他 Session；過期問題拒絕且不建立 queued Job。 | TC-REQ-004, 006, 008 |
| AT-14 | `ask:` Job 在第一步後只建立一次問題及轉為 `WAITING_INPUT`；重啟不重建問題；收到回覆後恢復原 Job。 | TC-REQ-008, 010 |
| AT-15 | 三步 demo 結果含原輸入及已套用 steering；重啟從已保存 checkpoint 繼續，不重播已保存步驟。降低 concurrency 至 durable RUNNING 數量以下時拒絕啟動且不修改 Job。 | TC-REQ-008, 010 |
| AT-16 | `fail:` Job 以 `FAILED` 通知；pending steering 為 `not_applied`；後續 queued Job 執行。 | TC-REQ-008 |
| AT-17 | 4097 字元輸入、超出 Job／steering 上限、空白內容與不支援輸入均有明確拒絕且沒有部分寫入。 | TC-REQ-003, 006, 009 |
| AT-18 | Job deadline 從開始時間計算且包含等待輸入；重啟不重設；逾時以 `FAILED/TIMEOUT` 釋放 partition。 | TC-REQ-009, 010 |
| AT-19 | 相同 `update_id` 重送不重複執行命令；DB 交易失敗時 offset 不前進，成功提交後才使用新 offset。 | TC-REQ-011 |
| AT-20 | 成功、429、網路／5xx、永久 4xx、Bot blocked、invalid token 與 webhook conflict 依規定分類；永久 delivery failure 不重跑 Job。 | TC-REQ-012 |
| AT-21 | Outbox 每片不超過 3500 UTF-16 code units，不切開 surrogate pair；已 delivered 項目重啟後不再送。 | TC-REQ-010, 012 |
| AT-22 | 既存 lock 使第二程序啟動失敗；程式不清 lock；graceful shutdown 依序停止 loop、關閉 DB、釋放 lock。 | TC-REQ-013 |
| AT-23 | Log 不含 raw token 或含 token 的完整 URL；health 回應只代表 liveness。 | TC-REQ-013, 014 |
| AT-24 | Demo 不呼叫 LLM、Shell、任意 code、附件或外部業務服務。 | TC-REQ-008 |

測試應使用 fake clock 與受控 demo step，不依賴長時間 sleep。驗收測試不得連線到 Telegram；Telegram client 以受控測試替身驗證協定與錯誤分類。

### 9.1 驗收追蹤與離線證據

完整離線套件命令為 `npm test`。本次完整執行涵蓋 9 個 `test/controller/*.test.ts` 檔、`test/app.test.ts` 與 63 個測試。測試使用本機 SQLite、fake fetch／Telegram response、受控時間與本機 HTTP listener；沒有連線真實 Telegram 或其他外部服務。狀態只描述列出的離線證據，不代表部署驗證。

| 驗收 ID | 離線測試證據 | 狀態 |
| --- | --- | --- |
| AT-01 | `test/controller/config.test.ts`、`test/controller/lifecycle.test.ts`、`test/controller/server.test.ts`、`test/app.test.ts` | 通過離線驗證；啟動 health mode 與 Bot mode，檢查 HTTP health、資料目錄、lock 與 shutdown。 |
| AT-02 | `test/controller/router.test.ts`、`test/controller/telegram.test.ts` | 通過離線驗證；包含同 username、不同 ID 與 private chat 授權。 |
| AT-03 | `test/controller/router.test.ts` | 通過離線驗證；未授權 update 不建立資源並持久推進 offset。 |
| AT-04 | `test/controller/router.test.ts`、`test/controller/store.test.ts` | 通過離線驗證；owner filter、跨 owner／missing 等價錯誤與 binding reopen。 |
| AT-05 | `test/controller/router.test.ts` | 通過離線驗證；沒有 selected Session 時拒絕一般文字與 `/queue`，不建立 Job／Message。 |
| AT-06 | `test/controller/router.test.ts`、`test/controller/runner.test.ts` | 通過離線驗證；一般文字、`/queue` 建立 Job，並驗證 FIFO。 |
| AT-07 | `test/controller/runner.test.ts` | 通過離線驗證；跨 Session concurrency、FIFO 與 partial unique index SQL violation rollback。 |
| AT-08 | `test/controller/runner.test.ts` | 通過離線驗證；WAITING_INPUT 阻擋同 Session 後續 Job，另一 Session 可執行，且恢復等待 slot。 |
| AT-09 | `test/controller/router.test.ts`、`test/controller/runner.test.ts` | 通過離線驗證；queued／running／waiting steering 與 safe-point 套用。 |
| AT-10 | `test/controller/runner.test.ts` | 通過離線驗證；測試先 steer 後 complete、先 complete 後 steer。測試為同步 SQLite 順序，不使用多執行緒競賽。 |
| AT-11 | `test/controller/runner.test.ts`、`test/controller/store.test.ts` | 通過離線驗證；timeout／demo failure 將 pending 標為 not_applied，並可執行後續 Job。 |
| AT-12 | `test/controller/router.test.ts` | 通過離線驗證；status query 不建立 Job，跨 owner 資訊不洩漏。 |
| AT-13 | `test/controller/router.test.ts`、`test/controller/outbox.test.ts`、`test/controller/service.test.ts` | 通過離線驗證；prompt reply 在切換 Session 後仍恢復原 Job，過期 mapping 不 fallback。 |
| AT-14 | `test/controller/outbox.test.ts`、`test/controller/store.test.ts`、`test/controller/service.test.ts`、`test/controller/runner.test.ts` | 通過離線驗證；prompt reopen 不重建，送達後 mapping 可恢復原 Job；step 1 前 steering 會先套用，但仍需新的補充才能恢復。 |
| AT-15 | `test/controller/runner.test.ts`、`test/controller/store.test.ts` | 通過離線驗證；checkpoint 1 reopen 後只執行兩步，deadline 不變；較低 concurrency 拒絕啟動且 durable RUNNING rows 不變。 |
| AT-16 | `test/controller/runner.test.ts` | 通過離線驗證；fail: Job、pending not_applied 與後續 queued Job。 |
| AT-17 | `test/controller/router.test.ts`、`test/controller/config.test.ts` | 通過離線驗證；4097 字元、空白、格式、MAX_PENDING_JOBS 三種狀態與 MAX_PENDING_STEERING 上限。 |
| AT-18 | `test/controller/runner.test.ts`、`test/controller/store.test.ts` | 通過離線驗證；deadline 在等待與 reopen 後維持，過期 Job 先 TIMEOUT 再排程下一 Job。 |
| AT-19 | `test/controller/router.test.ts`、`test/controller/service.test.ts` | 通過離線驗證；SQLite trigger 在 Router 業務流程造成 rollback；poll loop 使用未提交 offset 重試且只建一筆 Job。 |
| AT-20 | `test/controller/telegram.test.ts`、`test/controller/service.test.ts` | 通過離線驗證；HTTP 分類與未讀 body 清理、429 全域 sender 冷卻、network／5xx、永久 4xx、Bot blocked、invalid token、webhook conflict 與不重跑 Job。 |
| AT-21 | `test/controller/outbox.test.ts`、`test/controller/store.test.ts` | 通過離線驗證；UTF-16 chunk、surrogate pair、delivered 不重送與 PENDING due 時間 reopen。 |
| AT-22 | `test/controller/lifecycle.test.ts`、`test/controller/service.test.ts`、`test/controller/server.test.ts` | 通過離線驗證；fatal 時 loop join、DB 關閉、lock 釋放；callback throw 時 HTTP 仍關閉。 |
| AT-23 | `test/controller/telegram.test.ts`、`test/controller/service.test.ts`、`test/controller/server.test.ts` | 通過離線驗證；logger 不含測試 token／secret URL，health 僅表示 liveness。 |
| AT-24 | `test/controller/service.test.ts`、`test/controller/server.test.ts` | 離線流程只記錄 fake `getUpdates`／`sendMessage` API 呼叫。父 agent 對本次來源檔 review 確認檢視範圍內沒有 LLM／Shell 業務模組；此 review 不是靜態掃描，也不證明未來變更行為。 |

真實 Telegram、backup／restore 流程與 Node 24 執行矩陣尚未驗證。離線證據不代表部署或未來變更已驗證。
