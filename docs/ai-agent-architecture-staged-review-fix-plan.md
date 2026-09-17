# AI Agent staged review 必要修正計畫

- **狀態：** Ready for implementation
- **審查基準：** `docs/ai-agent-architecture-design.md`
- **適用範圍：** 本文件建立時的 staged implementation changes
- **目的：** 修正已確認會破壞安全性、一致性或必要流程的問題

## 1. 修正邊界

本輪只修正下列六類問題：

1. Approval 查詢與冪等 decision 的授權順序及 Tenant scope。
2. Approval 與原 Run／Tool Call 的必要關聯。
3. Message 套用與 `user_message_applied` event 的原子性。
4. Tool obligations 的完整限制與 fail-closed 行為。
5. Approval／Attachment 狀態更新的 optimistic concurrency，以及 Approval terminal state 不可改寫。
6. Attachment 建立前的 Session ownership 驗證。

本輪不實作 PostgreSQL、Redis、HTTP routes、Worker loop、SSE、production provider adapter、完整 Audit、retention job 或其他 v1 功能。這些屬於後續設計實作階段，不是本次 staged skeleton review 的必要修正。

預估修改約 **180–240 行**，其中 production code／contracts 約 110–150 行，測試約 70–90 行。實際行數可因格式與共用測試 fixture 略有差異，不應為符合估算而增加抽象。

## 2. Approval 授權與 Tenant scope

### 問題

`ApprovalService.decide()` 對已完成的相同 decision 直接回傳，發生在 Tenant、approver constraint 與 self-approval 檢查之前。未授權呼叫者只要取得 Approval ID，就可能透過冪等路徑取得 Approval 資料。

此外，`ApprovalRepository.get()` 與 `save()` 未要求 Tenant scope，不符合 repository 必須強制 Tenant isolation 的設計。

### 修改方法

修改：

- `src/modules/approvals/ports.ts`
- `src/modules/approvals/approval-service.ts`
- `src/infrastructure/memory/in-memory-approval-repository.ts`
- `test/unit/governance.test.ts`

將 repository contract 改為 Tenant-scoped：

```typescript
interface ApprovalRepository {
  create(tenantId: string, approval: Approval): Promise<Approval>;
  get(tenantId: string, approvalId: string): Promise<Approval | null>;
  save(
    tenantId: string,
    approval: Approval,
    expectedStateVersion: number,
  ): Promise<Approval>;
}
```

`ApprovalService.decide()` 必須依下列順序處理：

1. 使用 `actor.tenantId` 查詢 Approval；其他 Tenant 一律視為 `NOT_FOUND`。
2. 檢查 approver constraint，以及 approve 操作適用的 self-approval policy。
3. 驗證完成後，才處理相同 decision 的冪等回傳。
4. terminal status 收到相反 decision 時回傳 `CONFLICT`。
5. pending decision 使用 expected state version 寫入；CAS conflict 時重新讀取一次，再依相同 decision／相反 decision 規則決定回傳或衝突。

對 API 使用的公開 Approval 查詢必須接收 `IdentityContext`，並只允許 requester 或符合 approver constraint 的同 Tenant actor 讀取。`decide()` 也必須使用 actor-scoped lookup；不得先透過未授權的 ID-only lookup 判斷冪等結果。供 execution path 使用的內部查詢則以 snapshot 中的 Tenant scope 取得。不得提供任意未限定 Tenant 的公開查詢。

### 必要測試

- 不同 Tenant 對已 `APPROVED` 的 Approval 重送 `approve`，必須得到 `NOT_FOUND`，不可取得原結果。
- 不具 approver 權限者對已完成 decision 重送相同 decision，仍必須被拒絕。
- 已授權 approver 重送相同 decision，取得原結果。
- 已授權 approver送出相反 decision，取得 `CONFLICT`。

## 3. Approval 綁定原 Run 與 Tool Call

### 問題

目前 Approval 沒有 `runId` 或 `toolCallId`，無法可靠定位等待中的原 Run，也無法證明核准的是哪一次 Tool execution。這使後續 `WAITING_APPROVAL → RUNNING` 與 execution snapshot 驗證缺少必要識別資訊。

### 修改方法

修改：

- `src/shared/types.ts`
- `src/modules/approvals/approval-service.ts`
- `test/unit/governance.test.ts`

在 `ApprovalSnapshot` 加入：

```typescript
readonly runId: string;
readonly toolCallId: string;
```

`Approval` 亦保存這兩個欄位，且 `snapshotHash()` 必須將兩者納入 canonical payload。`ApprovalService.create()` 只從 snapshot 複製這些 server-generated identifiers，不接受 LLM 或 Tool argument 覆寫。

本輪只建立正確 contract 與 snapshot binding；實際喚醒 Worker／Run 屬於後續 runtime wiring，不在本輪加入假的 process-local callback。

### 必要測試

- 建立 Approval 後保留原 `runId` 與 `toolCallId`。
- 使用不同 `runId` 或 `toolCallId` 的 snapshot 呼叫 `assertExecutable()` 必須失敗。

## 4. Message 套用與 event 原子化

### 問題

`RunCoordinator.applyNextMessage()` 先呼叫 `store.applyNextMessage()` 標記 Message，再獨立呼叫 `appendEvent()`。兩次寫入之間若 process crash 或 event write 失敗，Message 已被視為套用，但 persisted event stream 不會出現 `user_message_applied`。

### 修改方法

修改：

- `src/modules/sessions/ports.ts`
- `src/modules/sessions/run-coordinator.ts`
- `src/infrastructure/memory/in-memory-session-store.ts`
- `test/unit/runtime.test.ts`

將兩個操作收斂到單一 store contract，例如：

```typescript
interface AppliedMessageResult {
  readonly message: Message;
  readonly event: RunEvent;
}

applyNextMessage(runId: string): Promise<AppliedMessageResult | null>;
```

正式 PostgreSQL adapter 必須在同一 transaction 內完成：

1. 依 Session sequence 取得下一筆未套用 Message。
2. 更新 `appliedAt`。
3. 配置下一個 Run event sequence。
4. 寫入 `user_message_applied` event。
5. 一次 commit。

`RunCoordinator` 不再另外呼叫 `appendEvent()`。In-memory adapter 雖只供測試／local 使用，也應在同一方法完成兩個狀態變更，保持 contract 語意一致。

### 必要測試

- `applyNextMessage()` 回傳的 Message 與 event 使用相同 message/run/session identifiers。
- 事件類型為 `user_message_applied`，payload sequence 與 Message sequence 相同。
- 沒有 pending Message 時不新增 event。

## 5. Tool obligations fail-closed

### 問題

目前 Tool policy 有三個缺口：

- `ALLOW + obligations.requireApproval` 會將 `requiresApproval` 設為 `true`，但可能遺失 Authorization decision 中的 `approverConstraint`。
- `maxRows` 與 `maxTimeRangeMs` 只在 request 已提供且超過上限時縮小；欄位缺少時沒有套用限制。
- obligations 產生的 `effectiveInput` 未重新通過 Tool input schema，錯誤的 policy value 可能進入 downstream。

### 修改方法

修改：

- `src/modules/tools/tool-policy.ts`
- `test/unit/governance.test.ts`

必要行為：

1. `approverConstraint` 從所有非 `DENY` decision 保留下來。
2. `requiresApproval === true` 但沒有 `approverConstraint` 時 fail closed，不得建立不具可核准人條件的 Approval。
3. 有 `maxRows` 時，`limit` 缺少便設為上限；大於上限便縮小。存在但不是有效數字時拒絕。
4. 有 `maxTimeRangeMs` 時，`timeRangeMs` 缺少便設為上限；大於上限便縮小。存在但不是有效數字時拒絕。
5. 套用 `forceParameters`、allowed/denied values、數量上限與 `resourceScope` 後，再以相同 JSON Schema 驗證 `effectiveInput`。無法產生合法 effective input 時 fail closed，不呼叫 Tool handler。

不得在本輪新增通用 policy expression language；只修正現有標準 obligations 的既定語意。

### 必要測試

- `ALLOW + requireApproval + approverConstraint` 正確保留 constraint。
- `requireApproval` 缺少 approver constraint 時拒絕。
- request 未帶 `limit`／`timeRangeMs` 時注入 policy 上限。
- obligations 產生不符合 schema 的 effective input 時拒絕。

## 6. Approval 與 Attachment optimistic concurrency

### 問題

Approval 與 Attachment 的 `save()` 都是無條件覆寫：

- 併發 approve／reject 可能由最後寫入者覆蓋先完成的 terminal decision。
- Attachment delete 與 scan／parse 同時發生時，舊資料可能將 `DELETING` 覆寫成 `PROCESSING` 或 `AVAILABLE`。
- `ApprovalService.assertExecutable()` 會把 `APPROVED` 改成 `EXPIRED`，違反 Approval terminal state immutable。

### 修改方法

修改：

- `src/shared/types.ts`
- `src/modules/approvals/ports.ts`
- `src/modules/approvals/approval-service.ts`
- `src/modules/attachments/ports.ts`
- `src/modules/attachments/attachment-service.ts`
- `src/infrastructure/memory/in-memory-approval-repository.ts`
- `src/infrastructure/memory/in-memory-attachment-repository.ts`
- 對應 unit tests

為 `Approval` 與 `Attachment` 增加 `stateVersion`，建立時從 `0` 開始。每次合法 transition：

1. service 以目前 `stateVersion` 作為 `expectedStateVersion`。
2. 新物件的 `stateVersion` 加一。
3. repository 只有在 stored version 等於 expected version時才更新，否則回傳 `CONFLICT`。

In-memory repository 必須實作相同 CAS 行為，以便 unit test 驗證；PostgreSQL adapter 後續使用 `UPDATE ... WHERE tenant_id = ? AND id = ? AND state_version = ?`。

Attachment repository 的狀態查詢與寫入也必須是 Tenant-scoped，至少遵循：

```typescript
interface AttachmentRepository {
  create(tenantId: string, attachment: Attachment): Promise<Attachment>;
  get(tenantId: string, attachmentId: string): Promise<Attachment | null>;
  save(
    tenantId: string,
    attachment: Attachment,
    expectedStateVersion: number,
  ): Promise<Attachment>;
}
```

因此 `markScan()`、`markAvailable()` 與其他 worker transition 不得只接受 Attachment ID；worker job 必須攜帶並傳遞可信的 `tenantId`。Repository 必須確認傳入 Tenant 與 entity Tenant 相符，再執行 CAS。

Approval expiry 規則：

- `PENDING` 超時可經 CAS 轉為 `EXPIRED`。
- 已為 `APPROVED` 時，`assertExecutable()` 發現 execution expiry 已過，只拒絕執行，不把 terminal decision 改寫成 `EXPIRED`。
- `REJECTED`、`EXPIRED`、`CANCELLED` 與 `APPROVED` 均不得互相覆寫。

Attachment 的 scan、parse、delete transition 都必須使用 CAS。若 delete 已先將狀態改為 `DELETING`，晚到的 scan／parse save 必須得到 `CONFLICT`，不得使 Attachment 恢復可用。

### 必要測試

- 同一 pending Approval 以相同 version 先後 approve／reject，第二次不得覆蓋第一個 terminal decision。
- 已核准 Approval 超過 execution expiry 時拒絕執行，但持久狀態仍為 `APPROVED`。
- Attachment 進入 `DELETING` 後，使用舊 version 的 scan／parse 更新得到 `CONFLICT`。
- 正常 Attachment transition 每次將 `stateVersion` 加一。

## 7. Attachment 建立前驗證 Session ownership

### 問題

`AttachmentService.createPending()` 直接相信傳入的 `sessionId`，未確認 Session 存在、屬於同一 Tenant／owner，且仍可接受 Attachment。

### 修改方法

修改：

- `src/modules/attachments/ports.ts`
- `src/modules/attachments/attachment-service.ts`
- `test/unit/attachments.test.ts`

在 Attachment module 定義最小的 Session access port，不直接 import Session repository implementation：

```typescript
interface AttachmentSessionAccess {
  canCreateAttachment(
    identity: IdentityContext,
    sessionId: string,
  ): Promise<boolean>;
}
```

將此 port 加入 `AttachmentServiceDependencies`。`createPending()` 必須先確認 access；不存在、跨 Tenant、非 owner、`DELETING` 或 `DELETED` Session 一律回傳不可枚舉的 `NOT_FOUND`。通過後才檢查既有附件數量並配置 object key。

正式 composition root 後續以 Session module 的 application-level adapter 實作此 port；不得讓 Attachment module 直接存取另一模組的私有 repository。

### 必要測試

- owner 可在 active Session 建立 Attachment。
- 不存在、跨 Tenant、非 owner 或已刪除 Session 均不可建立 Attachment。
- Session access 檢查失敗時不寫入 Attachment repository。

## 8. 實作順序

為減少重複修改，依下列順序執行：

1. 更新 `Approval`、`ApprovalSnapshot`、`Attachment` 與 result types。
2. 更新 Approval／Attachment repository ports 與 in-memory CAS adapters。
3. 修正 Approval service 的 Tenant scope、授權順序、terminal expiry 與 execution binding。
4. 原子化 Message applied/event contract。
5. 修正 Tool obligations。
6. 加入 Attachment Session access port。
7. 補齊上述必要測試。
8. 執行 `npm run check`。

## 9. 完成判定

只有同時符合以下條件才算完成：

- 六類問題皆有對應程式修正及回歸測試。
- Approval 的冪等語意不能繞過授權。
- Approval 可唯一關聯原 Run 與 Tool Call。
- Message applied state 與 applied event 由單一持久化操作產生。
- obligations 無法安全套用時一律 fail closed。
- stale Approval／Attachment update 無法覆蓋較新的狀態。
- Attachment 無法附加至未授權或不可用 Session。
- `npm run check` 全部通過。
- 未加入本文件第 1 節排除的後續能力。
