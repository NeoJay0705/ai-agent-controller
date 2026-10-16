# 受控試用設計

> 此文件記錄目前已決定並已接線的設計。功能仍在最後驗收階段。文件不代表測試全數通過。

## Actor 與權限

- `Owner` 是 `TELEGRAM_ALLOWED_USER_ID`。Owner 可管理 guest，並免除 trial 額度與 guest 執行數限制。Owner 仍受全域 `JOB_CONCURRENCY` 限制。
- `guest` 是 Owner 以 `/allow` 授權或以單次 invite 兌換的使用者。Guest 不需登入 Pi。Agent 使用 Controller 設定的 Owner 認證及 quota。
- 權限來自 Telegram numeric user ID 與 private chat。Bot command menu 不是 ACL。Router、Runner reservation 與 outbox 送出前都重新檢查有效 membership。

## TrialStore 與 Schema

Schema version 為 3。TrialStore 是 ControllerStore 上的同步 primitive，呼叫者負責 transaction。

| Table | 用途與關聯 |
| --- | --- |
| `trial_users` | Guest membership、期限、撤權時間與累計 job/message/token 額度。`user_id` 為主鍵。額度不因重授權而歸零。 |
| `trial_events` | Guest/Owner job、message、control 的去重與 rolling rate events。以 `(user_id,kind,update_id)` 為主鍵。 |
| `trial_invites` | Invite token 的 SHA-256 hash、建立者、到期、trial 時長、兌換者與撤銷時間。此表不保存 raw token；受保護的 outbox 可能保存含原 token 的 invite link。 |
| `command_dialogs` | `(user_id,chat_id)` 的短期 command dialog、期限與 revision。 |
| `trial_usage_operations` | 一個 usage operation 對應一個 user、Session 與 Job；Session/job 外鍵指向既有表。每位 guest user 同時只有一筆 pending operation；此限制不是固定的 Controller Owner。Owner role 免試用 token budget。 |
| `trial_usage_events` | Operation 下 provider request 的 sequence 與累計 token 數；外鍵指向 usage operation，sequence 唯一。 |
| `command_menu_sync` | Telegram command menu 的 durable desired role、generation、attempt 與下次重試時間。 |

Outbox 的 `delivery_class` 將 `business` 與 `control` 分開。控制通知在權限撤銷後仍可送出。Session-only business 通知則在送出前重新驗證 membership。

## Transaction 與 Savepoint 邊界

每個 Telegram update 使用 SQLite 外層同步 transaction。Message charge 在 business savepoint 之外，因此格式錯誤或 business 操作回滾時仍消耗已接收的 guest message 額度。Router 在 `route_business` savepoint 中執行命令業務操作。Job debit 與 Job 建立、queued message、ack outbox 位於同一 savepoint；建立失敗時一起回滾。Update 去重與 offset 在外層 transaction 提交。

Usage operation 的 begin、每筆 provider usage、finish 與 recovery 都使用同步 transaction。Usage event 以 sequence 冪等記錄，並累加 user/session 可核對用量。runtime 等待 Agent promise 真正 settle 後才 finish usage。Storage error 以 `FLOW_STORAGE_INVALID` 傳到 Runner 與 Service；不得轉成一般 Job failure 後繼續排程。

Schema v0/v1/v2 升級到 v3 使用單一原子 migration。v1 offset 保持既有相容解析，v2/v3 offset 嚴格 canonical。遷移成功時將 schema version 設為 3，並保留既有 offset、Job、facts 與 FK；`foreign_key_check` 在提交前執行。遷移失敗時，單一 transaction 回滾，保留原 schema version、offset 與資料。測試可重新開啟 raw SQLite 檢查 rollback 結果，因為 ControllerStore constructor 會關閉失敗連線。

## Router 優先序與 dialog

Router 先驗證 update 日期、去重與 private-user membership，再計量並進入 business savepoint。有效明確 command 優先於 reply 與 command dialog。有效 Job prompt reply 其次，且只可 steer 對應有效 prompt。Stale prompt reply 不得被當成一般 dialog 輸入。沒有 prompt reply 時，才處理有效 command dialog；最後才拒絕無上下文純文字。

`/help`、`/start` 或其他有效 command 解除或取代 dialog。未知 command 保留現有 dialog。對不存在 Job 的 `/cancel` 輸入以 `NOT_FOUND` 結束等待並清除 dialog。`FORMAT` 錯誤保留 dialog 以便重試。Command dialog 與 Job 的 `WAITING_INPUT` 狀態分離，互不覆蓋。Dialog 在 TTL 到期或 Service restart 時清除。Guest 的 Owner 管理 command 一律拒絕。

## Job 取消與權限生命週期

取消 `QUEUED` 或 `WAITING_INPUT` Job 時可立即轉為 `CANCELLED`。取消 `RUNNING` Job 時先轉 `CANCELLING`、abort runtime，並保留 Worker slot 與 Session partition。只有 runtime promise settle，也就是 child/runtime 真正 join 後，Runner 才可 finalize 為 `CANCELLED`。此期間不可啟動同一排程資源上的下一項工作。Late completion、facts 與 business outbox 必須被 first-valid-commit 規則阻止。

Expiry、revoke 與 membership 在 reservation、執行前與 business outbox 送出前檢查。到期或撤權會清除 dialog、安排 menu role 更新、取消尚未結束的 guest Job。Control cancellation 通知可送；未授權的 Session business 通知不可送。過期或曾有 trial_users 記錄的 user 不可用新 invite 重新建立或重設額度。

## Provider usage 與保守額度

使用 provider native usage。Reasoning 等子集若已包含於 provider total，不重複計算。模型每次 request 前由 runtime usage budget 限制後續 request。最後一個已開始 request 可能在回報 usage 前超過剩餘 quota；只要收到有效 usage，便照實計入並拒絕後續 request。

取消或中斷若沒有完整 usage，將該 guest 標為 `usage_uncertain`。Service restart 會把未完成 pending operation recovery 為 uncertain。此狀態保留已知用量，並封鎖該 guest 發出新的模型請求，避免未知用量被當成零；status 與 cancel 等控制操作仍可使用。

每位 guest user 僅允許一筆 pending usage operation。因此 `TRIAL_MAX_RUNNING_JOBS` 最大值是 1；設定大於 1 會拒絕，不會靜默 clamp。Guest 在不同 Session 間也只能同時執行一個 Job。Owner 不受此 trial 限制，仍可使用全域 worker concurrency。

## Telegram menu desired state

Grant、revoke、expiry 與 startup 建立 durable desired menu。`setMyCommands` 暫時失敗時保留 membership 與 desired row，依 retry 時間重試。成功後以 `(chat_id,generation)` CAS 刪除，避免較舊請求覆蓋新 desired role。Default、guest、Owner 使用各自 command scope。Production 保留此註冊流程；command menu 不能授權操作。

## 測試與資料保留

分層離線驗證使用 memory SQLite/fake runtime、合成 SQLite migration、真 Service/Router/Runner/outbox 加 fake Telegram transport，以及受控 clock、deferred runtime 與 sleeper。測試不得連真 Telegram、provider、OAuth 或正式服務。離線通過只代表相應合成案例通過。

Trial 不提供資料刪除或重置額度功能。Grant/regrant 不清除累計額度。`trial_invites` 表只存 token hash，但受保護 outbox 可含原 invite link；因此不能宣稱整個資料庫完全不含 raw token/link。Guest 使用 Owner 認證的 provider quota；因此不需自行登入 Pi。Session token 上限只拒絕該 Session 的新模型請求。User token 上限或 usage unknown 會拒絕該 guest user 跨 Sessions 的新模型請求。Status、cancel、help 等控制操作仍可使用。
