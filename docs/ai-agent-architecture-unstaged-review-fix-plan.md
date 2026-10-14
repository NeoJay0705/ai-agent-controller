> **歷史標記（已取代）：** 本修正計畫依據先前 Enterprise AI Agent 架構，不是目前實作指示。請改以[Telegram 控制器需求](telegram-controller-requirements.md)與[Telegram 控制器架構設計](telegram-controller-design.md)為準。原文保留。
>
> ---

# AI Agent unstaged changes 必要修正計畫

- **狀態：** Ready for implementation
- **審查基準：** `docs/ai-agent-architecture-design.md`
- **前置修正計畫：** `docs/ai-agent-architecture-staged-review-fix-plan.md`
- **適用範圍：** 本文件建立時的 unstaged implementation changes
- **目的：** 補齊 review 後仍確認存在的安全限制、原子性及必要回歸測試缺口

## 1. 修正邊界

本輪只處理下列三類問題：

1. Tool obligations 必須以最終 `effectiveInput` 驗證所有限制，且無效的 policy 上限必須 fail closed。
2. In-memory Session store 套用 Message 與建立 `user_message_applied` event 時，不可因可預期的 dependency exception 留下部分狀態。
3. 補齊前置修正計畫已明列、但現有測試尚未提供明確證據的回歸案例。

本輪不新增新的業務能力，不實作 PostgreSQL、HTTP routes、Worker、SSE、production adapter、Audit、retention 或其他架構設計中的後續項目。也不為了減少測試重複而建立新的 fixture framework、repository abstraction 或通用 policy language。

預估修改約 **70–100 行**，其中 production code 約 20–30 行、測試約 50–70 行。行數是範圍估算，不應為符合估算而增加抽象或壓縮可讀性。

## 2. Tool obligations 必須驗證最終結果

### 問題

`src/modules/tools/tool-policy.ts` 目前先檢查 `allowedValues`／`deniedValues`，之後才套用 `maxRows`、`maxTimeRangeMs` 與 `resourceScope`。後續 obligation 因此可能把已通過檢查的欄位改成禁止值，使最終 `effectiveInput` 不再符合完整 policy。

此外，`applyMaximum()` 只驗證 request 內既有值，未驗證 Authorization Adapter 回傳的 `maximum`。負數、`NaN` 或無限值可能被注入 `effectiveInput`；不能假設每一個 Tool schema 都會定義足以攔截這些 policy 錯誤的 minimum 或格式限制。

### 修改檔案

- `src/modules/tools/tool-policy.ts`
- `test/unit/governance.test.ts`

### 具體修改方法

調整 `applyObligations()` 的處理順序：

1. 複製 `requestedInput`。
2. 套用會改寫輸入的 obligations：`forceParameters`、`maxRows`、`maxTimeRangeMs`、`resourceScope`。
3. 對改寫完成的最終值檢查 `allowedValues` 與 `deniedValues`。
4. 回到 `evaluate()` 後，維持現有的 JSON Schema 再驗證。

不得只在套用 `resourceScope` 前檢查 allowed/denied values，因為安全限制應作用於實際送給 Tool handler 的最終輸入。

在 `applyMaximum()` 一開始驗證 policy 上限：

```typescript
if (!Number.isFinite(maximum) || maximum < 0) {
  fail('AUTHORIZATION_DENIED', `Policy maximum for ${parameter} is invalid`);
}
```

維持現有的 request value 驗證及 `Math.min(value, maximum)` 行為。此輪不新增 decimal／integer 等額外規則；是否必須為整數應由 Tool JSON Schema 決定，避免超出既有設計。

### 必要測試

在 `test/unit/governance.test.ts` 補充：

- `resourceScope` 將欄位改成 `deniedValues` 中的值時，evaluation 回傳 `AUTHORIZATION_DENIED`。
- `resourceScope` 將欄位改成不在 `allowedValues` 中的值時，evaluation 回傳 `AUTHORIZATION_DENIED`。
- `maxRows` 或 `maxTimeRangeMs` 為負數或非有限數值時，evaluation fail closed。

只需挑選最小代表案例覆蓋「最終值重新受限制」及「無效 policy maximum」兩種行為，不需要枚舉所有數值組合。

## 3. Message applied 與 event 的 in-memory 原子語意

### 問題

`src/infrastructure/memory/in-memory-session-store.ts` 的 `applyNextMessage()` 目前先呼叫 `messages.set()`，再透過 `createEvent()` 取得時間、配置 ID 並更新 event collections。若 Clock 或 IdGenerator 拋錯，方法雖失敗，Message 卻已留下 `appliedAt`，違反單一 store operation 要同時產生 Message applied state 與 persisted event 的 contract。

Production PostgreSQL adapter 後續仍必須使用真正 transaction；本輪只修正現有 in-memory adapter 在可觀察 exception 下的部分寫入，不試圖讓記憶體 adapter具備跨 process durability。

### 修改檔案

- `src/infrastructure/memory/in-memory-session-store.ts`
- `test/unit/runtime.test.ts`

### 具體修改方法

在 `applyNextMessage()` 中採用「先準備、後提交」：

1. 找出 pending Message 後，只在區域變數建立新的 `Message`。
2. 在任何 Map mutation 前取得 timestamp、下一個 event sequence 與 event ID，並建立完整 `RunEvent`。
3. 所有可能由注入 dependency 拋錯的計算完成後，再依序更新：
   - `messages`
   - `events`
   - `eventSequences`
4. 回傳同一批建立的 `{ message, event }`。

更新 events 時使用新的陣列，例如：

```typescript
const runEvents = [...(this.events.get(runId) ?? []), event];
```

不要在提交前對既有 event array 呼叫 `push()`，以免後續操作失敗時已改動原陣列。

現有 `appendEvent()` 可繼續使用 `createEvent()`；本輪不需建立 transaction framework。若為避免複製少量 event 建構邏輯而抽出 helper，helper 應只負責建立不帶副作用的 event，實際 Map mutation仍由呼叫端明確完成。

### 必要測試

在 `test/unit/runtime.test.ts` 補充：

- 讓 IdGenerator 在 `user_message_applied` event 建立時拋錯。
- 第一次 `applyNextMessage()` 必須失敗。
- 恢復 IdGenerator 後再次呼叫，仍必須取得原本 pending Message，證明第一次失敗沒有留下 `appliedAt`。
- 最終 event stream 只能有一筆對應的 `user_message_applied` event。
- 所有 Message 已套用後再次呼叫回傳 `null`，且 event 數量不增加。

## 4. 補齊既有必要回歸證據

此節原則上只修改測試。除非測試揭露目前 production code 不符合既有 contract，否則不得順帶改變 service API 或狀態模型。

### 4.1 Approval CAS 與授權結果

修改 `test/unit/governance.test.ts`：

1. 建立一個 `PENDING` Approval，保留相同的初始 `stateVersion`。
2. 以該 version 儲存 `APPROVED` transition。
3. 再以相同舊 version 嘗試儲存 `REJECTED` transition。
4. 第二次更新必須得到 `CONFLICT`，重新讀取後仍為 `APPROVED`。

這個測試直接驗證 in-memory repository 的 CAS contract 即可；不需要建立人工 timer、thread 或通用 concurrency harness。

另加入同 Tenant、非 requester、且不具 approver role 的 actor，對已完成 Approval 重送相同 decision 時必須得到 `AUTHORIZATION_DENIED`。這能區分 approver constraint 檢查與既有 requester self-approval 檢查，證明冪等路徑沒有繞過授權。

將現有只使用 `rejects.toThrow()`、但修正計畫已指定錯誤語意的 assertion 收緊為檢查 `DomainError.code`：

- cross-tenant Approval lookup／decision：`NOT_FOUND`。
- 未授權 approver：`AUTHORIZATION_DENIED`。
- terminal Approval 的相反 decision：`CONFLICT`。
- snapshot mismatch 或 execution expiry：`AUTHORIZATION_DENIED`。

在 snapshot binding 測試中再加入 `toolCallId` 改變的案例；`runId` 與 `toolCallId` 是兩個獨立的必要識別欄位，兩者都必須有回歸證據。

### 4.2 Message event contract

修改 `test/unit/runtime.test.ts` 現有成功案例，使 `user_message_applied` event 除了 payload 外，也明確比對：

- `runId` 等於 Message 的 `runId`。
- `sessionId` 等於 Message 的 `sessionId`。
- payload 的 `messageId` 與 `sequence` 等於 Message。

沒有 pending Message 時不增加 event 的案例可與第 3 節的原子性測試合併，避免重複 setup。

### 4.3 Attachment state version 與不可枚舉錯誤

修改 `test/unit/attachments.test.ts`：

- 正常 `PENDING_SCAN → PROCESSING → AVAILABLE` 流程分別斷言 `stateVersion` 為 `0 → 1 → 2`。
- Session access port 回傳 `false` 時，明確斷言 `NOT_FOUND`，並保留現有「repository 沒有新增資料」的驗證。
- stale scan／parse save 明確斷言 `CONFLICT`，而不是只驗證任意 exception。

Session access port 已將不存在、跨 Tenant、非 owner、`DELETING` 與 `DELETED` 收斂為相同 boolean contract。Service unit test 只需驗證 `false → NOT_FOUND` 且不寫入；各種 Session 狀態的判斷屬於後續實作該 port 的 adapter／module integration tests，本輪不建立假的 Session repository 來重複枚舉。

## 5. 不應進行的修改

為確保修正必要且不超出需求，本輪明確不做：

- 不改變 Approval、Attachment、Run 或 Message 的 public domain model。
- 不新增新的 Approval／Attachment 狀態。
- 不新增 database transaction abstraction。
- 不實作 PostgreSQL repository 或 production composition root。
- 不改變 Attachment session access port 的 boolean contract。
- 不加入通用 obligation dependency solver；只確保現有 obligations 約束最終輸入。
- 不因測試 setup 重複而建立共用 fixture framework。
- 不調整與本輪三類問題無關的 staged 或 unstaged files。

## 6. 實作順序

1. 修正 `applyObligations()` 的轉換／驗證順序及 policy maximum 驗證。
2. 補 Tool obligations 的最小回歸測試。
3. 將 `applyNextMessage()` 改為先準備、後提交。
4. 補 event failure rollback semantic 與 empty queue 測試。
5. 補 Approval、Attachment 與 event contract 的缺漏 assertions。
6. 執行 `npm run check` 及 `git diff --check`。

## 7. 完成判定

只有同時符合下列條件才算完成：

- Tool handler 使用的最終 `effectiveInput` 同時符合所有現有 obligations 與 JSON Schema。
- 無效 policy maximum 一律 fail closed。
- In-memory `applyNextMessage()` 發生 Clock／IdGenerator exception 時不留下 applied Message 或半筆 event state。
- Approval stale update 無法覆蓋既有 terminal decision，且有明確 CAS 測試。
- Approval 的 Tenant、approver、相反 decision 與 snapshot 錯誤碼均有明確測試。
- Message event identifiers、empty queue 行為與 Attachment version progression 有回歸證據。
- `npm run check` 與 `git diff --check` 全部通過。
- 未加入第 1 節及第 5 節排除的能力或重構。

