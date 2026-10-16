# 受控多使用者試用與互動式任務管理

> 目前已接線，仍處於驗收階段。不得在指定測試完成前宣稱全數通過。

## 1. 目標與界線

本功能已接線至 Router、Service、SQLite、Runner、outbox 與 Agent runtime。現在進行最後離線安全驗收。試用政策集中在 `TrialPolicy`，環境變數只在 bot mode 解析。健康檢查模式不新增認證或 Flow 依賴。政策由建構子傳入領域元件；領域元件不讀 `.env`。

非目標包括資料刪除、公開註冊、付款、模型 fallback、認證變更與部署。詳細元件與交易邊界見[受控試用設計](controlled-trial-design.md)。

不得將合成測試視為真 Telegram、provider 或部署驗收。此設計不表示產品功能已完成。

## 2. 政策預設值與驗證

| 環境變數 | 預設值 |
| --- | ---: |
| `TRIAL_DURATION_MS` | 3600000 |
| `INVITE_TTL_MS` | 600000 |
| `TRIAL_MAX_JOBS` | 3 |
| `TRIAL_JOB_WINDOW_MS` | 600000 |
| `TRIAL_MAX_JOBS_PER_WINDOW` | 2 |
| `TRIAL_MAX_MESSAGES` | 100 |
| `TRIAL_MESSAGE_WINDOW_MS` | 60000 |
| `TRIAL_MAX_MESSAGES_PER_WINDOW` | 20 |
| `TRIAL_MAX_PENDING_JOBS` | 2 |
| `TRIAL_MAX_SESSIONS` | 2 |
| `TRIAL_MAX_RUNNING_JOBS` | 1 |
| `TRIAL_SESSION_TOKEN_LIMIT` | 100000 |
| `TRIAL_USER_TOKEN_LIMIT` | 200000 |
| `COMMAND_DIALOG_TTL_MS` | 300000 |
| `CONTROL_MAX_PER_MINUTE` | 10 |

每個值必須是正的安全整數。Timer 上限為 2147483647。計數及 token 上限為 1000000000。

## 3. 持久化與遷移

Schema version 為 3。v0、v1、v2 均可升級。v1 offset 仍接受精確零小數格式並 canonicalize；v2 offset 必須是嚴格 canonical 格式。v3 驗證所有新必要表及欄位。

一次啟動的完整遷移必須在同一原子交易完成。失敗時保留原 schema version、offset 和資料。空資料庫初始化亦使用同一交易。foreign keys 在 `BEGIN IMMEDIATE` 前關閉，遷移完成後於 `finally` 恢復開啟。v1→v2 DDL 與 offset canonicalize 使用同一外層交易，不得在 v2 中間提交。

重建 `jobs` 時使用 `jobs_new`：建立新表、複製 rows、刪除舊表、重新命名新表、重建既有 indexes。不得先 rename 舊表。保留欄位、UNIQUE、所有 FK。Job status CHECK 接受 `QUEUED`、`RUNNING`、`WAITING_INPUT`、`CANCELLING`、`COMPLETED`、`FAILED`、`CANCELLED`。每 Session 活躍 Job index 包含 `CANCELLING`。提交前執行 `PRAGMA foreign_key_check`。不得使用 `writable_schema`。

新增 STRICT 表：

- `trial_users(user_id PK, chat_id nullable, expires_at, revoked_at nullable, jobs_used, messages_used, tokens_used, usage_uncertain bool)`。
- `trial_events(user_id, kind='job'|'message'|'control', update_id, at, PK(user_id,kind,update_id))`。
- `trial_invites(token_hash PK, created_by, expires_at, trial_duration_ms, used_by nullable, used_at nullable, revoked_at nullable)`。
- `command_dialogs(user_id,chat_id,command,expires_at,revision, PK(user_id,chat_id))`。
- `trial_usage_operations(id PK, owner_id, session_id FK sessions, job_id FK jobs, started_at, completed_at nullable, state='pending'|'complete'|'uncertain', total_tokens, event_count)`。
- `trial_usage_events(operation_id FK, sequence, total_tokens, PK(operation_id,sequence))`。
- `command_menu_sync(chat_id PK, role='default'|'guest'|'owner', generation, attempts, next_attempt_at)`。

新表的計數欄位必須非負。程式另驗證所有安全整數。Outbox 增加 `delivery_class`，預設 `business`，只接受 `business` 或 `control`。

遷移合成測試須驗證 offset、outbox、facts、Pi mapping、FK 與 rollback。

## 4. TrialStore 契約

`TrialStore` 是 `ControllerStore` 上的同步領域 primitive。建構子為 `TrialStore(store, ownerId, policy, options={now,id/random})`。primitive 不自行開啟交易；呼叫端負責 `store.transaction()`。

存取結果必須區分 Owner、有效 guest 與拒絕。Owner 不可 grant 或 revoke。Grant 首次建立記錄；既有記錄只更新到期／撤銷，不清除累計額度。撤權與到期處理清除 command dialog、安排選單更新，並在同交易取消該使用者所有未完成 Job。

邀請碼使用 `randomBytes(32).toString('base64url')`，資料庫只保存 SHA256 hash。回傳 raw token 供後續正常 outbox 輸出。兌換必須在外層交易條件式單次消耗；已有 `trial_users` 記錄的使用者不得重新兌換或重設額度。

提供 `chargeMessage(userId,updateId,channel)`、`assertCanCreateSession(userId)`、`chargeJob(userId,updateId)`、dialog get/set/clear、clear-all、usage begin/record/finish/recovery，以及 command menu desired/read/成功刪除 CAS 與 retry 操作。

Owner 一般試用額度豁免。Control 使用獨立每 60 秒上限，不計入 trial message 額度。Events 只為 Owner 或既有 guest 儲存，不替陌生人建立持久記錄。清除超出最大 rolling window 的 events；不刪 `processed_updates` 或 offset。Message 扣額在 business savepoint 外。Job 扣額須與成功建立 Job 位於同一 savepoint。

Job charge 檢查總額、rolling rate 與未完成數；`CANCELLING` 仍算未完成。Session 上限依 `sessions.owner_id` 計。Usage begin 重新驗權限及總額／Session 額度，拒絕 `usage_uncertain` 或 pending operation，並回傳 session/user 剩餘 token 額度的較小值。Owner 可不建立 usage operation。

Usage event 以 operation 與 sequence 冪等累加，檢查安全整數及 overflow。未知 usage 不得記零後繼續。Finish 不確定時保留已知用量並標記 user `usage_uncertain`。重啟時將殘留 pending 記為不確定。

## 5. Job 取消與 Flow 執行

`ControllerStore.requestCancellation(requesterId,jobId,ownerAdminId,reason)` 只允許 Job owner 或系統 Owner。Terminal 重複取消只回安全狀態。`QUEUED`／`WAITING_INPUT` 轉 `CANCELLED`；`RUNNING` 轉 `CANCELLING`；已有 `CANCELLING` 保持。取消提升 Flow revision、清 wait deadline、將 pending steering 標 `not_applied`、停用 prompts，並取消該 Job 所有 pending outbox（含 ack）。`CANCELLING` 禁止新增 steering。

立即完成的取消建立 control class、`reply` kind 的安全取消通知。執行中的 Job 先回「取消處理中」。只有在 worker 真正 join 後，`finishCancellation(jobId)` 才可建立最終通知並轉 `CANCELLING` 至 `CANCELLED`。此操作冪等，不能覆蓋 `COMPLETED`／`FAILED`。OutboxKind CHECK 不擴充。提供 `enqueueJobControlNotification` 與 `replyControl`。

Outbox record 提供 `deliveryClass`。`dueOutbox`／`isOutboxSendable` 保留 prompt generation 防護，以供後續送出前 membership 檢查。

Flow 所有 commit、finish、fail、wait、checkpoint 對 `CANCELLING`／`CANCELLED` 視為 stale；不得寫 facts、轉移或建立業務 outbox。不可只依賴 UPDATE 影響筆數後仍發通知。Scheduler 排除同 Session 的 `CANCELLING`。Reservation predicate 可依 owner/session/job 檢查授權與 per-owner capacity，現有呼叫預設行為相容。

啟動 recovery 將 `CANCELLING` 轉為 `CANCELLED`，其他未完成 Job 仍依既有 `SERVER_RESTART` 失敗處理，不復活 Job。

Runner tick 發現 `CANCELLING` 時 abort worker，但保留 worker map slot。Worker promise settle 後才在 finally 交易呼叫 `finishCancellation`，之後才能刪除 worker。Stop 亦須 abort 並真 join。Finalize persistence 失敗時回報 `FLOW_STORAGE_INVALID`，不得宣稱取消成功。

Runner 支援 `canRunOwner(ownerId)` 與 `maxWorkersPerOwner(ownerId)` callbacks。Reservation predicate 同時計算實際 worker 與本次 reservation。等待中的 Job 不占 per-owner 執行 slot。Owner 預設不受 guest 上限影響。預設 callbacks 保持單人測試相容。

Executor 收到取消 abort，或 Job 已為 `CANCELLING`／`CANCELLED`，不得用 `failCurrent` 覆寫或發出 failed 通知。由 Runner join 後 finalize。Timeout、shutdown、dirty、retry 與 facts 語意維持。取消與完成採 first-valid-commit-wins。

## 6. Router、menu 與 runtime 行為

Owner 管理命令提供 allow、revoke、guests、invite。一般純文字不得建立 Job。只有明確 `/queue` 或其引導對話可建立 Job。有效 Job prompt 的 reply 仍可 steer。`/cancel` 只取消 Job；缺少參數時引導輸入 Job ID。`/help` 清除 command dialog；其他有效命令取代對話；未知命令不清除。命令 dialog 以 `(user,chat)` 獨立儲存。成功處理時原子清除；可修正錯誤時保留；閒置五分鐘或重啟後失效。

`setMyCommands` 依 default、guest、owner 註冊。暫時錯誤採 retry，不回滾 grant；致命 token 錯誤呼叫 `failController`。Telegram 選單不是 ACL。

Token 用量是 provider usage 的累計，不重複計入 reasoning/cache 子項。最後一個 provider request 可超額。為避免同一 Node 多個 turn 越額，需由子程序 `before_provider_request` 攔截後續 turn。無法取得可靠 usage 時，封鎖後續跨 Session 使用。

驗證表只保存邀請 token hash。但受保護 outbox 的正常業務文字可以包含邀請連結；不得宣稱資料庫完全不保存 raw link。

## 7. 測試與驗收界線

合成測試涵蓋 migration 原子性與資料完整性、primitive 權限／期限／撤權／Owner 保護／邀請單次使用／額度去重／跨 Session／unknown usage／dialog TTL／menu CAS、真正 join 前不釋放 worker slot、取消與完成 race、FIFO 延後 join。不得使用真 Telegram、provider、OAuth 或正式服務。

Router、menu、runtime 尚未接線時必須明列未完成。只有指定離線測試實際通過，才可宣稱該測試驗收通過；不得宣稱整體產品完成。
