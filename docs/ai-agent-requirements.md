# Enterprise AI Agent — System Requirements v0.1

**Status:** Draft
**Version:** 0.1
**Purpose:** 定義企業級 AI Agent 平台之功能需求、資安需求、非功能性需求與核心系統邊界。

本文件規範用語：

* `MUST`：v1 驗收必要，不得省略。
* `SHOULD`：預設應實作；若偏離，必須留下理由與影響。
* `MAY`：選配，不列入 v1 必要驗收。

---

# 1. 目標

本系統提供企業內部或企業產品使用的 AI Agent Runtime，使使用者能透過自然語言：

1. 提出問題並取得回答。
2. 與 Agent 進行 multi-turn conversation。
3. 在資訊不足時，由 Agent 提出 follow-up question。
4. 由 Agent 使用企業開發人員註冊的受控 Tool 存取企業系統或執行特定能力。
5. 依既有企業 Authentication / Authorization System 控制使用者可使用的 Tool、Resource 與資料範圍。
6. 對每個 User / Tenant / Run 進行 usage、rate、quota 與 cost 控制。
7. 保留必要的 execution trace 與 audit record，以支援安全稽核、問題追蹤與成本分析。

本系統定位為：

```text
Controlled Enterprise Agent Runtime

而不是：

General-purpose Coding Agent
或
Unrestricted Computer-Use Agent
```

---

# 2. 核心設計原則

## P-01 — LLM 不構成 Security Boundary

LLM 可以：

* 判斷使用哪個 Tool
* 產生 Tool arguments
* 判斷是否需要 follow-up
* 整理 Tool result
* 產生最終回答

LLM 不得決定：

* 使用者是否有權使用 Tool
* 是否有權存取 Resource
* 是否可以跨 Tenant 存取
* 是否可以解除 Parameter Constraint
* 是否可以讀取 Restricted Data
* 是否可以取得 Credential

原則：

```text
LLM Decision
≠
Authorization Decision
```

---

## P-02 — 所有企業能力經由受控 Tool 提供

Agent 不預設具有：

* Shell
* SSH
* arbitrary filesystem access
* arbitrary HTTP access
* database credential
* production credential
* arbitrary code execution

企業能力由開發人員透過 Tool Contract 顯式提供。

```text
Agent
 ↓
Approved Tool
 ↓
Policy Enforcement
 ↓
Enterprise System
```

---

## P-03 — 沿用既有 IAM

Agent Platform 不建立平行的企業帳號與權限系統。

Authentication / Authorization 優先沿用既有：

* SSO
* IdP
* OAuth/OIDC
* API Gateway identity
* Internal IAM
* RBAC system
* ACL
* Legacy permission service/database

由於目前企業內部尚無統一公用 IAM Interface，Agent Platform 必須提供 Adapter Abstraction。

---

## P-04 — Tool Extension 與 Agent Core 分離

新增業務能力原則上不修改 Agent Runtime。

```text
Agent Core

+
Tool / Skill Extension

+
Policy Configuration
```

Agent Runtime 應保持相對穩定。

Pi 的 agent core 採取 stateful agent loop、tool execution 與 event streaming 的薄核心設計，而 coding-agent 將更多能力透過 extensions / skills 擴充，可作為此原則的實作參考。

---

# 3. Scope

## 3.1 In Scope

第一階段包含：

* User authentication integration
* Agent Session
* Multi-turn conversation
* Follow-up question
* Agent Run
* Active Run message injection
* LLM invocation
* Streaming response
* Human Approval
* Developer-defined Tool
* Tool Registry
* Tool input schema
* Tool authorization
* Controlled Write Tool
* Parameter / resource constraint
* Tool result filtering
* Attachment upload / list / use / delete
* Usage metering
* Rate limit
* Concurrency control
* Quota / credit
* Session retention
* Session deletion
* Cancellation
* Timeout
* Error / retry
* Audit
* Observability
* Admin control
* Model abstraction
* Prompt / Agent configuration versioning

---

## 3.2 Out of Scope — v1

除非未來另行加入，第一階段不包含：

* 任意 Shell execution
* Agent 自動 SSH
* Agent 任意操作 OS
* LLM-generated arbitrary code execution
* Agent 自動安裝 Tool
* Agent 修改自己的 security policy
* Agent 建立永久 Credential
* Autonomous production remediation
* Unrestricted DB write
* Retrieval-Augmented Generation (RAG)
* Multi-Agent orchestration
* Long-running autonomous background agent
* Agent 自行修改 source code / commit / deploy
* Agent 自行擴充自己的 runtime capability

`Unrestricted DB write` 不在 v1 範圍；這不排除經 schema validation、
authorization、approval 與 audit 保護的受控 Write Tool。

若未來加入 code/computer execution，應使用獨立隔離 runtime，而不能直接延伸目前 Tool 執行權限。OpenHands 將 sandbox/workspace 與 agent core 分離，以及 smolagents 對 untrusted code 建議使用 isolated execution，均反映相同安全邊界。

---

# 4. 核心術語

| 名稱               | 定義                                                  |
| ---------------- | --------------------------------------------------- |
| User             | 使用 Agent 的終端使用者                                     |
| Tenant           | 資料及權限隔離單位                                           |
| Agent            | 根據 Prompt、Model 與 Tool 完成任務的邏輯實體                    |
| Session          | 使用者看到的一段持續 Agent 對話                                 |
| Message          | User / Assistant / System 之單一訊息                     |
| Run              | 由 User Input 啟動、可在 terminal state 前接收額外輸入的一次 agent loop 執行 |
| LLM Call         | Run 中對模型的一次 invocation                              |
| Tool             | 由開發人員提供、Agent 可呼叫的受控能力                              |
| Tool Call        | Agent 對 Tool 的一次 invocation                         |
| Tool Registry    | Tool definition 與版本的管理機制                            |
| Policy           | 決定 Tool / Resource 是否可存取及其限制的規則                     |
| Obligation       | Authorization Allow 後仍必須執行的限制                       |
| Identity Context | Runtime 使用的標準化 User/Tenant Identity                 |
| Audit Record     | 為安全與治理保留的不可任意修改事件記錄                                 |
| Usage            | Token、LLM calls、Tool calls、cost、execution time 等使用量 |

---

# 5. High-Level Architecture

```text
                    Client / Slack / Lark / Web
                              │
                              ▼
                       API / Channel Gateway
                              │
                       Authentication
                              │
                              ▼
                     Identity Resolution
                              │
                              ▼
┌─────────────────────────────────────────────────────┐
│                   Agent Platform                    │
│                                                     │
│  Session Manager                                    │
│  Agent Runtime                                      │
│  Context Manager                                    │
│  Model Gateway                                      │
│  Usage Controller                                   │
│                                                     │
│              Agent Tool Request                     │
└───────────────────────┬─────────────────────────────┘
                        │
                        ▼
                Tool / Policy Gateway
                        │
                Schema Validation
                        │
                  Authorization
                        │
                   Obligations
                        │
                Parameter Enforcement
                        │
               ┌────────┴────────┐
               ▼                 ▼
         Tool Executor       Approval
               │
               ▼
       Enterprise Systems
               │
               ▼
          Raw Tool Result
               │
        Result / DLP Filter
               │
               ▼
            Agent
               │
               ▼
          Final Response


Cross-cutting:

Identity / IAM
Audit
Tracing
Metrics
Usage
Secrets
Configuration
```

---

# 6. Domain Model

核心關係：

```text
Organization / Tenant
        │
        └── User
             │
             └── Session
                   │
                   ├── Message
                   │
                   ├── Run
                   │    ├── LLM Call
                   │    └── Tool Call
                   │
                   └── Run
                        ├── LLM Call
                        └── Tool Call
```

最低識別欄位：

```text
tenant_id
user_id
session_id
message_id
run_id
llm_call_id
tool_call_id
trace_id
```

---

# 7. Session Model

## FR-001 — Session Creation

系統 MUST 能為 authenticated User 建立 Agent Session。

Session 至少保存：

* session_id
* tenant_id
* user_id
* agent_id
* created_at
* updated_at
* status
* configuration version

---

## FR-002 — Multi-turn Conversation

相同 Session 的後續訊息 MUST 可使用該 Session 既有 context。

Agent SHOULD 能理解：

```text
User:
幫我查這個訂單為什麼失敗。

Agent:
請提供 order id。

User:
12345
```

第二次訊息屬於同一 Session。

同一 Session 同時間最多有一個 active Run。Session idle 時收到 User
message 建立新 Run；active Run 執行中收到的 User message MUST 先持久化，
再加入該 Run 的 input queue，不得建立第二個並行 Run。`WAITING_USER_INPUT`
收到訊息後 MUST 恢復同一 Run；terminal Run 完成後的下一則 User message
才建立新 Run。

---

## FR-003 — Session Deletion

Session 可由：

* User 主動刪除
* Authorized Admin 刪除
* System retention policy 自動刪除

刪除範圍 MUST 包含：

* Messages
* Tool result retained data
* Compacted context
* Session attachment
* Session-specific cache
* Derived context

Session 刪除後 MUST 立即對一般查詢不可見，也不得再用於 Agent context。
實體清除完成時間與 backup expiration 可由 deletion policy 設定，並由
Security / Privacy owner 負責。Audit metadata 不隨 Session 一起刪除，
可依獨立 Compliance Retention Policy 保存；Audit 預設不得保存完整對話、
附件內容、credential 或 raw sensitive Tool result。

---

## FR-004 — Session Retention

System MUST 支援 configurable retention policy。

例如：

```text
inactive_after = TBD
delete_after = TBD
audit_retention = TBD
```

Policy SHOULD 可依 Tenant 設定。`subject_id` 是否需要假名化由適用的
privacy / compliance policy 決定，不在需求階段強制指定。

---

# 8. Agent Run Lifecycle

Agent Run 狀態至少包含：

```text
CREATED
RUNNING
WAITING_USER_INPUT
WAITING_APPROVAL
COMPLETED
FAILED
CANCELLED
TIMED_OUT
LIMIT_EXCEEDED
```

Session 同時間最多有一個 active Run。Run terminal state 一旦確定即不可
改寫。Run 的 message input queue 必須保留訊息的伺服器 sequence，並依
sequence 順序套用；已接收但尚未套用的訊息不得遺失、重複或任意重排。

狀態轉換：

```text
CREATED
   │
   ▼
RUNNING
   │
   ├──────── need information
   │                  │
   │                  ▼
   │         WAITING_USER_INPUT
   │                  │
   │                  └──────► RUNNING
   │
   ├──────── approval
   │                  │
   │                  ▼
   │          WAITING_APPROVAL
   │                  │
   │                  └──────► RUNNING
   │
   ├──── success ─────────────► COMPLETED
   │
   ├──── cancel ──────────────► CANCELLED
   │
   ├──── timeout ─────────────► TIMED_OUT
   │
   ├──── budget ──────────────► LIMIT_EXCEEDED
   │
   └──── failure ─────────────► FAILED
```

LangGraph 的 thread/checkpoint 及 interrupt 模型證明了 conversation persistence、human input、resume 與 fault recovery 可以建立於持久化 execution state 之上；本平台不要求採 LangGraph，但 execution semantics 應預留相同能力。

---

# 9. Conversation Functional Requirements

## FR-010 — User Question

Authenticated User MUST 可以向 Agent 發出自然語言問題。

---

## FR-011 — Direct Answer

若 Agent 不需要 Tool 或額外資訊，MAY 直接使用 LLM 回答。

---

## FR-012 — Follow-up Question

若任務缺少必要資訊，Agent MUST 可以：

```text
Run → WAITING_USER_INPUT
```

並回傳：

* 問題
* missing information description
* resume identifier

使用者回覆後 MUST 恢復原 Run，不得因 follow-up 建立第二個並行 Run。

---

## FR-012A — Active Run Message Injection

Active Run 執行期間收到的 User message MUST：

* 先持久化，再由 Agent Runtime 消費。
* 使用由伺服器產生、於同一 Session 內單調遞增的 sequence。
* 先產生 `user_message_received`，在安全處理點套用後再產生
  `user_message_applied`。
* 依 sequence 順序套用，不得遺失、重複或任意重排。

Agent loop SHOULD 在下一次 LLM call 前或 Tool 完成後套用新訊息。LLM
streaming 期間 MAY 中斷該次 generation，加入新訊息後重新推理；Tool
執行期間仍 MUST 接收訊息，但不得假設所有 Tool 都能安全中斷。已開始
產生副作用的 Write Tool 不得因新訊息到達而被標示為已取消。

---

## FR-013 — Streaming

Agent MUST 支援 streaming event。

事件類型至少可表示：

```text
run_started
text_delta
tool_started
tool_completed
waiting_user
waiting_approval
user_message_received
user_message_applied
generation_interrupted
run_completed
run_failed
usage_update
```

---

## FR-014 — Cancellation

User 或 Authorized System MUST 可以取消 Running Run。

Cancellation SHOULD 傳遞至：

* active LLM request
* active Tool invocation
* downstream cancellable operation

---

## FR-015 — Attachment Lifecycle

具權限的 authenticated User MUST 能在 Session 上傳、列出、使用及刪除
Attachment。Attachment metadata 至少 MUST 包含：

```text
tenant
owner
session
size
media_type
hash
scan_status
data_classification
```

系統 MUST 限制單檔大小、檔案數量及允許類型。Malware scan 通過前，原始
檔案不得提供給 Model 或 Tool。原始檔與解析後內容 MUST 視為 untrusted
input，並適用 prompt-injection 防護。傳送至特定 Model 或 Tool 前，MUST
執行 data-classification 與 authorization 判斷。

Session 刪除時，原始檔、解析內容、衍生 context 與 cache MUST 一併進入
deletion policy。上傳失敗、掃描拒絕、解析失敗及權限拒絕 MUST 有可區分
的錯誤結果。儲存服務、virus scanner 與 parser 的選型留待 Architecture
Design。

---

# 10. Model Gateway Requirements

## FR-020 — Model Abstraction

Agent Runtime MUST 不直接綁定單一 Model Provider。

模型設定至少包含：

```text
provider
model_id
capabilities
context_limit
pricing
data_policy
enabled
```

---

## FR-021 — Model Policy

不同 Tenant / Agent MAY 被限制只能使用指定 Model。

---

## FR-022 — Data Classification Compatibility

Model Gateway MUST 能依：

```text
Data Classification
+
Model Policy
```

判斷 Context 是否可傳送至 Model。

例如：

```text
PUBLIC       → Model A/B/C
INTERNAL     → Model A/B
CONFIDENTIAL → Model B
RESTRICTED   → Private Model only
```

實際 mapping 為 organization policy。

---

## FR-023 — Model Timeout / Retry

Model Gateway MUST 支援：

* request timeout
* transient retry
* rate-limit handling
* cancellation
* usage collection

---

# 11. Tool Platform

## FR-030 — Tool Definition

Tool 至少 MUST 宣告：

```text
name
version
description
input_schema
risk_level
operation_type
idempotency_capability
side_effect_semantics
authorization_policy
timeout
max_result_size
```

建議結構：

```typescript
interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;

  riskLevel: "low" | "medium" | "high" | "critical";

  operationType:
    | "read"
    | "write"
    | "delete"
    | "external_action";

  idempotencyCapability: "required" | "supported" | "unsupported";
  sideEffectSemantics: "none" | "reversible" | "irreversible";

  authorizationPolicy: string;

  timeoutMs: number;
  maxResultBytes: number;
}
```

---

## FR-031 — Tool Naming

Tool 名稱 MUST 穩定且具 Domain 語意。

推薦：

```text
order.get
order.search
elk.search_logs
wiki.search
customer.get
```

不推薦：

```text
search
query
run
execute
```

---

## FR-032 — Tool Registry

平台 MUST 提供 Tool Registry。

至少支援：

```text
register
enable
disable
version
deprecate
```

---

## FR-033 — Tool Exposure

Runtime SHOULD 僅將該 User / Agent 有可能使用的 Tool expose 給 LLM。

即使 Tool 未 expose，backend authorization 仍 MUST 執行。

Tool filtering：

```text
Available Tools
∩
Agent Allowed Tools
∩
Tenant Allowed Tools
∩
User Permission
=
Tools exposed to LLM
```

---

## FR-034 — Input Validation

所有 Tool Call MUST 在執行前通過 input schema validation。

Invalid input 不得直接到 downstream system。

---

## FR-035 — Controlled Write Tool

Write、delete 或 external action Tool MUST 宣告 idempotency capability 與
side-effect semantics。高風險或不可逆操作是否需要 Human Approval MUST 由
policy 決定，不得由 LLM 自行決定。

不支援 idempotency 的 Write Tool 不得自動 retry。若 timeout 或連線中斷
導致無法確認下游結果，平台 MUST 回傳 `UNKNOWN_OUTCOME`，不得宣稱成功
或失敗。Tool 執行時 MUST 使用 policy enforcement 後的
`effective_input`；LLM 的 `requested_input` 不得直接送往 downstream。

具 idempotency 保證的操作，因 client retry 或重複 approval 重新送出時，
不得重複產生副作用。實際 idempotency key 格式、下游支援方式與
compensation strategy 留待個別 Tool contract 定義。

---

# 12. Identity Integration

## FR-040 — Existing Authentication

Agent Platform MUST 優先沿用既有 enterprise authentication。

平台 SHOULD 接受 upstream validated identity，例如：

```text
OIDC token
JWT
Gateway Identity
SSO Session
```

---

## FR-041 — Identity Adapter

因現階段 IAM 無統一 API，平台 MUST 定義 Identity Adapter。

概念介面：

```typescript
interface IdentityProvider {
  resolve(
    credential: Credential
  ): Promise<IdentityContext>;
}
```

標準化結果：

```typescript
interface IdentityContext {
  subjectId: string;
  organizationId?: string;
  tenantId?: string;

  roles: string[];
  groups: string[];

  attributes: Record<string, unknown>;
}
```

---

## FR-042 — No Parallel Identity Database

Agent Platform MUST NOT 將自身資料庫變成企業權限的最終 Source of Truth。

Local cache MAY 使用，但須有 TTL 與 invalidation strategy。

---

# 13. Authorization

## FR-050 — Central Authorization Contract

Runtime MUST 使用統一 Authorization Interface。

```typescript
interface AuthorizationService {
  authorize(
    request: AuthorizationRequest
  ): Promise<AuthorizationDecision>;
}
```

---

## FR-051 — Authorization Request

Request SHOULD 支援：

```text
Subject
Action
Resource
Input
Environment Context
```

概念：

```text
authorize(
  user,
  action = "elk.search_logs",
  resource = {
      service: "payment-service",
      environment: "production"
  }
)
```

---

## FR-052 — Authorization Decision

Authorization 至少有：

```text
ALLOW
DENY
REQUIRE_APPROVAL
```

Authorization service SHOULD 支援：

```text
ALLOW + obligations
```

---

## FR-053 — Tool-level Authorization

系統 MUST 檢查：

> User 是否可使用該 Tool？

---

## FR-054 — Resource-level Authorization

若 Tool 存取具 resource identity 的資料，系統 MUST 能檢查：

> User 是否可存取此次 Tool Call 指定的 Resource？

例如：

```text
tenant
project
service
environment
customer
region
```

---

## FR-055 — Execution-time Authorization

高風險或敏感 Tool MUST 在實際 Tool Invocation 時重新授權。

不得只依登入時取得的角色永久信任整個 Session。

---

## FR-056 — Fail Closed

Protected Tool 在 Authorization Service 不可用或無法取得明確授權時 MUST NOT 執行。

---

# 14. Policy Obligations / Parameter Constraints

Authorization 不只回答：

```text
可以 / 不可以
```

亦需能表達：

```text
可以，但有以下限制。
```

標準 obligation SHOULD 考慮：

```text
force_parameter
allowed_values
denied_values
max_rows
max_time_range
resource_scope
mask_fields
remove_fields
max_result_size
require_approval
```

例如：

```text
User role = support

ALLOW elk.search_logs

Obligations:

tenant_id = current user tenant
time_range <= 24h
max_rows <= 500
remove authorization header
remove cookie
```

---

## FR-060 — Requested vs Effective Input

系統 MUST 區分：

```text
requested_input
```

與：

```text
effective_input
```

例如 LLM 要求：

```json
{
  "tenant": "*",
  "days": 365
}
```

Policy enforcement 可能得到：

```json
{
  "tenant": "tenant-a",
  "days": 30
}
```

Audit MUST 能識別兩者差異。

---

# 15. Tool Execution Context

Runtime 應向 Tool 傳入 standardized execution context，而非要求每個 Tool 自行解析 Authentication Token。

```typescript
interface ToolExecutionContext {
  requestId: string;
  runId: string;
  sessionId: string;

  identity: IdentityContext;

  trace: TraceContext;

  signal: AbortSignal;
}
```

Tool SHOULD NOT：

* 自行解析 UI cookie
* 自行相信 LLM 提供 user ID
* 從 Tool argument 接受任意 tenant identity
* 將 Credential 暴露給 LLM

---

# 16. Credential Management

## SEC-001 — Credential Isolation

LLM Context MUST NOT 包含：

```text
DB_PASSWORD
API_SECRET
AWS_SECRET_ACCESS_KEY
long-lived service credential
private signing key
```

---

## SEC-002 — Credential Injection

需要 downstream credential 時：

```text
Tool Gateway
 ↓
Credential Provider / Secret Manager
 ↓
Tool
```

credential 由 infrastructure 注入。

---

## SEC-003 — Short-lived Credential

若既有企業架構允許，SHOULD 優先使用：

* short-lived token
* delegated identity
* scoped token
* workload identity

---

# 17. Tool Result

## FR-070 — Standard Result Contract

Tool SHOULD 使用統一 Result Contract。

例如：

```typescript
interface ToolResult {
  status:
    | "success"
    | "partial"
    | "denied"
    | "error";

  data?: unknown;

  metadata: {
    rowCount?: number;
    truncated?: boolean;
    dataClassification?: string[];
    durationMs?: number;
  };

  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
```

---

## FR-071 — Result Filtering

Raw Tool Result 在進入 LLM 前 MUST 可經過：

```text
Raw Result
 ↓
Tool-specific filtering
 ↓
Authorization obligations
 ↓
DLP / Sensitive Data Filtering
 ↓
Size / Token limiting
 ↓
Agent-visible Result
```

---

## FR-072 — Sensitive Data

Tool 有能力取得某資料：

```text
≠
```

LLM 一定有權取得該資料。

Result policy MUST 可移除或 mask：

* secret
* credential
* PII
* tenant-external data
* Restricted fields

---

# 18. Human Approval

Human Approval 為 v1 contract。受 policy 保護的 Tool 在未核准前不得執行。

Decision：

```text
ALLOW
DENY
REQUIRE_APPROVAL
```

Approval 狀態至少包含：

```text
PENDING
APPROVED
REJECTED
EXPIRED
CANCELLED
```

Approval MUST 綁定：

```text
requester
authorized approver
tenant
tool name / version
resource
effective input
policy version
created_at
expires_at
```

核准後、實際執行前 MUST 重新執行 authorization。Tool、resource、
effective input 或 policy version 改變時，既有 approval MUST 失效。
Approve / reject 操作本身 MUST 檢查權限並產生 audit event。requester 是否
可自我核准由 policy 決定，預設禁止。Rejected、expired 或 cancelled 的
approval 不得改用其他 Tool 規避。

典型 policy：

```text
search wiki      → allow
query order      → allow
query prod log   → allow with constraints

send email       → approval
refund order     → approval
update database  → approval

delete customer  → deny
```

等待批准：

```text
RUNNING
 ↓
WAITING_APPROVAL
 ↓
RUNNING / CANCELLED
```

---

# 19. Usage Governance

Usage Governance 分四層，不得混成單一 Credit 概念。

## 19.1 Metering

MUST 記錄：

```text
input tokens
output tokens
cached tokens
LLM calls
Tool calls
run duration
model cost
optional tool cost
```

---

## 19.2 Rate Limit

限制短期流量，例如：

```text
requests / minute
runs / minute
tool calls / minute
LLM calls / minute
```

---

## 19.3 Concurrency Limit

MUST 能限制：

```text
concurrent runs per user
concurrent runs per tenant
global concurrent runs
```

---

## 19.4 Quota

限制長期資源：

```text
tokens / day
tokens / month
runs / month
LLM spend / month
tool usage / month
```

Quota、rate limit 與 concurrency limit 超限時 MUST hard reject：不得建立
新 Run、不得提供 grace period，也不得自動切換至低成本 Model。

---

## 19.5 Credit

Credit 屬於 product/business abstraction。

建議：

```text
Raw Usage
   ↓
Metering
   ↓
Billing / Credit Rule
   ↓
Credit Consumption
```

不得在 Runtime 直接假設：

```text
1 token = 1 credit
```

---

# 20. Per-Run Budget

除了 User quota，每個 Run MUST 有獨立 execution budget。

例如：

```yaml
max_duration: TBD
max_llm_calls: TBD
max_tool_calls: TBD
max_input_tokens: TBD
max_output_tokens: TBD
max_cost: TBD
```

超過限制：

```text
Run → LIMIT_EXCEEDED
```

Active Run 超過 per-run budget 時 MUST 終止並進入 `LIMIT_EXCEEDED`。已產生
的 usage 即使 Run 失敗或取消仍 MUST 計量，不得回滾。

禁止無限制：

```text
LLM → Tool → LLM → Tool → ...
```

---

# 21. Error Handling

錯誤至少分類：

```text
VALIDATION_ERROR
AUTHENTICATION_ERROR
AUTHORIZATION_DENIED
RATE_LIMITED
QUOTA_EXCEEDED
LLM_ERROR
TOOL_ERROR
DEPENDENCY_ERROR
TIMEOUT
UNKNOWN_OUTCOME
CANCELLED
INTERNAL_ERROR
```

---

## FR-080 — Retry

只有 retryable error 才 MAY 自動 retry。

不支援 idempotency 的 Write Tool 不得自動 retry。若 timeout 或連線中斷
後無法確認下游結果，MUST 回傳 `UNKNOWN_OUTCOME`，不得宣稱成功或失敗。

例如：

```text
read-only 或具冪等保證的操作發生 transient network timeout → retryable

429 → retryable/backoff

IAM deny → non-retryable

invalid Tool parameter → LLM MAY repair

business validation failed → normally non-retryable
```

---

## FR-081 — Retry Limit

任何 retry MUST 具有：

```text
max_attempts
backoff
total timeout
```

---

## FR-082 — Graceful Degradation

非必要 dependency 無法使用時，Agent SHOULD 能回答：

* 哪些資訊成功取得
* 哪些資訊無法取得
* 哪些結論因此具有不確定性

不得將 dependency failure 虛構成正常結果。

---

# 22. Audit Requirements

Audit 與 application log 必須視為不同資料。

## AUD-001

每個敏感 Tool Call MUST 記錄：

```text
timestamp
tenant_id
subject_id
session_id
run_id
tool_call_id
tool_name
tool_version
authorization_decision
policy_version
requested resource
effective constraints
status
```

---

## AUD-002

依 Security Policy 決定是否保存：

```text
requested_input
effective_input
result metadata
```

Raw sensitive result SHOULD 預設避免寫入 Audit。

---

## AUD-003

Audit record SHOULD 防止一般 User 任意修改或刪除。

---

## AUD-004

Audit retention 與 Session retention MUST 可獨立設定。

---

# 23. Observability

系統 MUST 支援：

```text
Structured Logs
Metrics
Distributed Tracing
Audit Events
```

每個 Run 至少可透過以下 correlation：

```text
trace_id
session_id
run_id
tool_call_id
llm_call_id
```

---

## Metrics

至少包含：

```text
run_count
run_latency
run_status

active_runs

llm_calls
llm_latency
llm_errors
input_tokens
output_tokens
llm_cost

tool_calls
tool_latency
tool_errors

authorization_denied
approval_requested

rate_limit_rejected
quota_rejected
```

---

# 24. Administration

Authorized Administrator SHOULD 能：

```text
Enable / Disable Agent
Enable / Disable Model
Enable / Disable Tool

Configure Tenant Tool Availability

Configure Rate Limit
Configure Quota
Configure Credit Rule

Configure Retention

Terminate Running Run

Inspect Usage

Inspect Audit

Rollback Agent Configuration
```

第一階段 MAY 使用：

```text
API
Config file
Database config
```

不要求一定有完整 Admin UI。

---

# 25. Configuration / Versioning

每次 Run MUST 可以追蹤：

```text
agent_version
system_prompt_version
model_config_version
tool_version
policy_version
```

目的：

> 能回答「為什麼當時 Agent 會做出這個行為？」

---

## CFG-001 — Immutable Historical Reference

Configuration 更新後，歷史 Run MUST 仍可識別當時使用的 version。

---

## CFG-002 — Rollback

Critical Agent configuration SHOULD 支援 rollback。

---

# 26. Security Requirements

## SEC-010 — Tenant Isolation

不同 Tenant 的：

* Session
* Message
* Tool results
* Cache
* Context
* Attachments
* Usage
* Audit access

MUST 受到隔離。

跨 Tenant data leakage 視為 Critical Security Incident。

---

## SEC-011 — Untrusted Input

以下內容 MUST 視為 untrusted：

```text
User Input
Tool Output
Retrieved Document
External Web Content
Uploaded File Content
```

---

## SEC-012 — Prompt Injection

Untrusted content MUST NOT 能直接：

* 提升 Tool permission
* 解除 authorization
* 取得 secret
* 修改 system policy
* 修改 tenant identity
* 修改 usage limit

---

## SEC-013 — Least Privilege

Tool 所使用 downstream credential SHOULD 採最小權限。

---

## SEC-014 — Secret Redaction

Logs、Trace、Audit、LLM Context SHOULD 有 secret redaction 機制。

---

## SEC-015 — Input Size Limit

API、Message、Attachment、Tool Result MUST 有 size limit。

---

## SEC-016 — Tool Timeout

所有 Tool MUST 有 bounded execution timeout。

---

# 27. Data Lifecycle

需明確管理下列資料：

| Data                 | Retention                         |
| -------------------- | --------------------------------- |
| Session              | Tenant policy                     |
| Messages             | Session policy                    |
| Tool input           | Security policy                   |
| Tool raw result      | Prefer ephemeral                  |
| Filtered tool result | Session policy                    |
| LLM request/response | Session / model governance policy |
| Attachment           | Session policy                    |
| Cache                | Short TTL                         |
| Trace                | Operations policy                 |
| Metrics              | Operations policy                 |
| Audit                | Compliance policy                 |

實際 retention duration 為 `TBD`。

---

# 28. Non-Functional Requirements

## NFR-001 — Availability

目標：

```text
Agent API Availability: TBD
Tool Gateway Availability: TBD
```

建議 production target 評估：

```text
≥ 99.9%
```

---

## NFR-002 — Reliability

單一 process crash MUST NOT 導致所有持久 Session 消失。

---

## NFR-003 — Durability

Session persistent state MUST 存放於 durable storage。

---

## NFR-004 — Recoverability

需定義：

```text
RPO: TBD
RTO: TBD
```

---

## NFR-005 — Horizontal Scalability

Agent Runtime SHOULD 支援 horizontal scaling。

不可將必要 Session state 僅保存於 process local memory。

---

## NFR-006 — Performance

至少定義：

### Time to First Event

```text
P50: TBD
P95: TBD
P99: TBD
```

### Simple LLM Run

```text
P95: TBD
```

### Tool-based Run

```text
P95: TBD
```

由於模型及 downstream system latency 不完全受 Agent Platform 控制，SHOULD 分離：

```text
Platform Overhead
LLM Latency
Tool Latency
```

---

## NFR-007 — Capacity

Capacity planning 至少考慮：

```text
Concurrent Sessions
Concurrent Runs
Concurrent LLM Calls
Concurrent Tool Calls
Requests per Second
Tokens per Minute
```

Target 為 `TBD`。

---

## NFR-008 — Backpressure

當 Model / Tool / Runtime 達到容量上限時，系統 SHOULD：

```text
queue
throttle
reject
```

而非無限制接受 request。

---

## NFR-009 — Security

Security control MUST 不依賴 LLM 正確遵守 prompt。

---

## NFR-010 — Auditability

所有高風險 action MUST 可以追溯：

```text
Who
When
What
Which Resource
Authorization Decision
Result Status
```

---

## NFR-011 — Observability

所有 production Run MUST 可被 trace。

---

## NFR-012 — Extensibility

新增一般 Tool SHOULD 不需要修改 Agent Runtime 核心程式。

---

## NFR-013 — Model Portability

Agent business logic SHOULD 不直接綁死單一 LLM provider。

---

## NFR-014 — Backward Compatibility

Tool contract SHOULD 使用 version。

Breaking changes MUST 建立新 major version 或 migration strategy。

---

## NFR-015 — Cost Governance

系統 MUST 能將 Model usage 歸屬至：

```text
Tenant
User
Session
Run
```

---

## NFR-016 — Testability

以下元件 SHOULD 可以獨立測試：

```text
Tool
Authorization Adapter
Policy
Prompt
Agent
Model Gateway
Usage Policy
```

---

# 29. Agent Quality / Evaluation

HTTP 200 不代表 Agent 行為正確。

系統 SHOULD 建立 Agent Evaluation。

至少觀察：

```text
Task completion rate

Tool selection accuracy

Tool call failure rate

Unsupported claim rate

Authorization violation rate

Follow-up rate

User feedback

Average cost per successful run

Average tokens per successful run
```

---

## NFR-020 — Regression Evaluation

Prompt、Model、Tool description 或 Agent workflow 發版前 SHOULD 能執行固定 Evaluation Dataset。

例如：

```text
Agent v1 + Model A
vs
Agent v2 + Model B
```

比較：

```text
quality
latency
tool behavior
cost
policy violation
```

---

# 30. Tool Acceptance Criteria

所有正式 Tool 至少需通過：

### AC-T01

Invalid schema input 不得執行 downstream call。

### AC-T02

Authorization DENY 時 downstream system 不得收到 request。

### AC-T03

Authorization Service 無法判定時 protected Tool 必須 fail closed。

### AC-T04

LLM 不得覆寫 effective permission。

### AC-T05

Tenant constraint 不得由 Tool argument 改寫。

### AC-T06

Secret 不得存在 Agent-visible Tool result。

### AC-T07

Tool timeout 後 Run 不得無限制等待。

### AC-T08

Tool Call 必須可透過 `tool_call_id` trace。

### AC-T09

受保護的 Write Tool 在必要 approval 尚未核准時不得執行；拒絕、逾期或
取消後不得改用其他 Tool 規避 approval。

### AC-T10

不支援 idempotency 的 Write Tool 不得自動 retry；無法確認下游結果時必須
回傳 `UNKNOWN_OUTCOME`。

---

# 31. Authorization Acceptance Criteria

### AC-A01

無 Tool Permission 使用者不得執行該 Tool。

### AC-A02

Tool 有 Permission，但 Resource Permission 不足時不得存取 Resource。

### AC-A03

Policy obligation 必須在 execution 前套用。

### AC-A04

Requested input 與 Effective input 不同時必須可追蹤。

### AC-A05

高風險 authorization SHOULD 使用 execution-time permission。

### AC-A06

Authorization decision 必須產生 audit event。

---

# 32. Session Acceptance Criteria

### AC-S01

相同 Session 可以執行 multi-turn conversation。

### AC-S02

Agent 要求 follow-up 後，後續 User reply MUST 繼續原 Run，不得建立第二個
並行 Run。

### AC-S03

User 可以刪除自己的 Session。

### AC-S04

User 不得刪除其他 User Session。

### AC-S05

Retention job 可以清理 expired Session。

### AC-S06

Session 刪除後不得再出現在一般使用者查詢結果。

### AC-S07

Active Run 收到的 User message 必須先顯示為已接收，再於安全處理點顯示為
已套用；多則訊息依 sequence 順序處理，且不得啟動第二個 Run。

### AC-S08

未通過 malware scan、data classification 或 authorization 的 Attachment
不得提供給 Model 或 Tool；具權限的 User 可列出、使用及刪除自己的
Attachment。

---

# 33. Usage Acceptance Criteria

### AC-U01

超過 User Rate Limit 時不得啟動新 Run。

### AC-U02

超過 Tenant Quota 時必須 hard reject，不得建立新 Run 或自動降級服務。

### AC-U03

每個 LLM Call 必須記錄 usage。

### AC-U04

Usage 可以 aggregate 至：

```text
Run → Session → User → Tenant
```

### AC-U05

單一 Run 超過 Budget 必須終止並進入 `LIMIT_EXCEEDED`。

### AC-U06

超過 User／Tenant Rate Limit 或 Concurrency Limit 時，該 request 必須被
拒絕；已產生的 usage 不得因 Run 失敗或取消而回滾。

---

# 34. Failure Acceptance Criteria

### AC-F01

Tool timeout 不得導致 Agent Runtime process hang。

### AC-F02

LLM 429 MAY retry，但受 retry budget 限制。

### AC-F03

Authorization denial 不得 retry 到成功。

### AC-F04

Run failure MUST 有明確 final state。

### AC-F05

Dependency failure 不得被 Agent 表述成已成功取得資料。

---

# 35. 初期建議部署邊界

第一版建議至少拆成邏輯上的：

```text
API / Channel Gateway

Agent Runtime

Model Gateway

Tool Gateway

Identity / Authorization Adapter

Usage Service

Session Store

Audit / Observability
```

初期不要求全部 microservice。

可以先：

```text
Agent Application
├── Runtime
├── Model module
├── Tool Gateway module
├── IAM adapter
└── Usage module

+
PostgreSQL / equivalent durable store

+
Redis / equivalent rate-limit/cache

+
Observability Platform
```

之後依負載與 ownership 再拆 service。

---

# 36. Tool Security Boundary

核心 enforcement path 固定為：

```text
LLM requests tool
        │
        ▼
Tool Registry
        │
        ▼
Input Schema Validation
        │
        ▼
Authorization
        │
        ├── DENY
        │
        ├── REQUIRE_APPROVAL
        │
        └── ALLOW
                 │
                 ▼
            Obligations
                 │
                 ▼
        Parameter Enforcement
                 │
                 ▼
          Usage / Limits
                 │
                 ▼
          Tool Execution
                 │
                 ▼
           Raw Result
                 │
                 ▼
         Result Filtering
                 │
                 ▼
             Audit
                 │
                 ▼
          Agent-visible
             Result
```

這條 execution path SHOULD 視為平台最重要的不變量之一。

---

# 37. v1 建議 Mandatory Requirements

第一版至少完成：

```text
Session
Multi-turn conversation
Follow-up question
Active Run message injection
Streaming
Cancellation
Human Approval

Model abstraction

Tool Registry
Tool Contract
Schema Validation
Controlled Write Tool
Attachment upload / list / use / delete

Existing IAM Adapter
Tool Authorization
Resource Authorization
Parameter Constraint
Result Filtering

Rate Limit
Concurrency Limit
Usage Metering
Quota
Per-run Budget

Session Retention / Deletion

Tool Timeout
LLM Timeout
Retry Control

Audit
Logs
Metrics
Trace

Tenant Isolation

Config / Prompt / Tool Versioning
```

---

# 38. 後續階段能力

不應阻塞 v1，但 architecture 應避免封死：

```text
Durable pause/resume
Long-running workflows

Knowledge / RAG (v1 out of scope)
Enterprise Search

Agent Skills

Model Routing

Tool Marketplace / Developer Portal

Offline Evaluation Platform

Automatic Knowledge Improvement

Multi-Agent orchestration (v1 out of scope)

Production Remediation

Isolated Code Execution
```

---

# 39. Open Questions / TBD

進入正式 Architecture Design 前，需要由 Product / Security / Platform Team 決定：

| Item                       | Status   |
| -------------------------- | -------- |
| Tenant 的實際定義               | TBD      |
| Session retention          | TBD      |
| Audit retention            | TBD      |
| User quota                 | TBD      |
| Tenant quota               | TBD      |
| Credit calculation         | TBD      |
| Per-run cost limit         | TBD      |
| Concurrent run limits      | TBD      |
| SLA / Availability         | TBD      |
| RPO / RTO                  | TBD      |
| Performance target         | TBD      |
| 可使用的 Model Provider        | TBD      |
| Data classification policy | TBD      |
| Restricted data 是否可進 LLM   | TBD      |
| IAM Source of Truth        | TBD      |
| Approval owner             | TBD      |

---

# 40. Architecture Invariants

無論最終採用 Pi-style runtime、LangGraph、自研 Runtime 或其他 Agent Framework，以下原則不可因 Framework 改變：

```text
1. Authentication 不由 LLM 執行。

2. Authorization 不由 LLM 決定。

3. Tool input 必須受 schema 與 policy 約束。

4. Tool result 在進入 LLM 前可以被過濾。

5. Credential 不得暴露給 LLM。

6. Tenant identity 不得由 LLM/User argument 任意指定。

7. 每個 Run 都有 execution budget。

8. 每個 Tool 都有 timeout。

9. 所有敏感 Tool Call 都可 audit。

10. Session state 使用 durable storage。

11. 使用量可以追到 User / Tenant / Run。

12. Agent Core 與業務 Tool 分離。
```

---

# 41. Framework Selection Implication

本需求刻意不綁定單一 Agent Framework。

Pi 證明薄 Agent Core 可以只負責 state、tool loop、streaming，再將 capability 透過 extension/tool 擴展。

LangGraph 的 persistence/checkpoint/thread 與 interrupt 適合未來需要 durable workflow、pause/resume、human approval 的需求。

OpenHands 則提供 agent core、tool、workspace、agent server 分層與 sandbox execution 的實作參考；若未來 Enterprise Agent 加入 code/computer execution，可參考此類隔離方式，而不是直接讓現有 Agent Runtime 取得主機權限。

因此技術選型應在這份 Requirements 之後進行，而不是讓框架能力反向決定產品需求。

---

# 42. Definition of Done — Requirements Phase

本需求可進入 Architecture Design Review 的條件為：

```text
✓ Product Scope 確認
✓ Session / Run model 確認
✓ Tool Contract 確認
✓ Identity abstraction 確認
✓ Authorization model 確認
✓ Tenant model 確認
✓ Data classification strategy 確認
✓ Usage governance strategy 確認
✓ Security invariants 確認
✓ NFR metrics 至少標示 TBD owner
```

不需要等所有 SLA / quota 數值決定後才開始 Architecture Design。

---

# 43. 建議的下一階段

Requirements v0.1 確認後，下一份文件應為：

```text
Enterprise AI Agent
Architecture Design v0.1
```

Architecture Design 應回答：

```text
Agent Runtime 採 Pi / LangGraph / 自研哪種模式？

Session State 放哪裡？

Agent Runtime 是否 stateless？

Tool Registry 如何實作？

Tool Gateway 是否獨立服務？

IAM Adapter 如何接現有系統？

Authorization / Obligation Engine 如何設計？

Rate Limit / Quota 放在哪一層？

Streaming API 如何設計？

Session / Run DB Schema？

Event Model？

Audit Schema？

Deployment topology？

HA / scaling？

Tool SDK？

開發人員如何新增一個 Tool？

如何測試 Tool + Policy + Agent？

如何 rollout prompt/model/tool version？
```

Architecture Design 完成後，再進入 API、DB Schema、Tool SDK 與工程 Task Breakdown。
