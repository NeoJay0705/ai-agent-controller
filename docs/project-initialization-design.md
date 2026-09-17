# Project Initialization Design v1.0

- **Status:** Implemented locally; CI pending
- **Scope:** 程式語言與工程專案初始化
- **不包含：** AI Agent 業務架構與功能實作
- **最後更新：** 2026-09-17

## 1. 文件目的

本文件是初始化階段的設計與實作依據，定義：

- 採用的語言、runtime、framework 與開發工具。
- 初始 repository 結構與每個檔案的責任。
- 最小可執行行為、錯誤處理及 process lifecycle。
- build、test、lint、format 與 CI contract。
- 初始化完成的驗收條件。

本文件不設計 Session、Run、Agent、Tool、IAM、Policy、Usage、Audit、資料庫或任何其他業務能力。後續功能不得因本初始化骨架而被迫採用尚未核准的架構。

## 2. 需求理解

### 2.1 目標

初始化成果 MUST：

1. 能以單一標準流程安裝 dependencies。
2. 能編譯並啟動一個最小 HTTP application。
3. 能執行自動化測試、靜態型別檢查、lint 與格式檢查。
4. 將 application composition 與 process 啟動分離，使測試不需開啟實際 network port。
5. 提供 CI，驗證專案支援的 Node.js 版本。
6. 提供足夠文件，讓不熟悉專案的開發者能完成安裝與驗證。
7. 不實作或假設任何業務需求。

### 2.2 合理假設

- Repository 將託管於 GitHub，因此 CI 使用 GitHub Actions。
- 專案目前是單一 server application，尚無需要獨立發布的 SDK 或 package。
- Linux 是主要 production runtime，但 source code 與 npm scripts 不應依賴 Unix-only shell command。
- 專案尚未決定開源授權，因此 package 保持 private，且不新增 LICENSE。
- 本階段不需要 container 或 deployment manifest；本機與 CI 可直接使用 Node.js 執行。

## 3. 技術選型

| 類別 | 選擇 | 初始化基準 | 理由 |
| --- | --- | --- | --- |
| Language | TypeScript | 6.0.x | 強型別 contract、良好 refactoring 支援，適合後續 schema 與 adapter boundary。 |
| Runtime | Node.js | `>=22.13 <23 || >=24 <25` | 支援 Node.js 22 與 24 LTS。 |
| HTTP framework | Fastify | 5.x | 核心精簡、啟動快速、支援 async、schema 與 application injection test。 |
| Package manager | npm | 10+ | 目前環境已具備，不額外引入 package-manager bootstrap。 |
| Test runner | Vitest | 5.x | TypeScript／ESM 開發體驗簡單，可執行快速 smoke test。 |
| Linter | ESLint + typescript-eslint | 10.x / 8.x | 支援 type-aware lint，及早發現非同步與型別誤用。 |
| Formatter | Prettier | 3.x | 將格式決策自 code review 移除。 |
| Dev runner | tsx | 4.x | 開發時直接執行 TypeScript，production 仍執行編譯後 JavaScript。 |
| Module system | ESM | NodeNext | 使用 Node.js 原生 module semantics，避免建立新的 CommonJS 專案。 |

### 3.1 版本規則

- `package.json` MUST 宣告 Node.js 與 npm engine range。
- Direct dependencies 使用相容的 semver range；`package-lock.json` MUST 提交並固定完整 dependency graph。
- TypeScript 使用 tilde range，避免尚未驗證的 compiler minor version 自動變更型別行為。
- CI MUST 測試 Node.js 22 與 24。
- 實作時若表中版本已無法安裝，僅可更新到相同 major 的最新相容版本；跨 major 變更需先更新本文件並說明影響。

### 3.2 未選擇其他方案的原因

- **Python：** AI ecosystem 完整，但初始化目標是 typed HTTP service 與工程 contract，而不是模型訓練或資料科學。未來 Python 仍可用於獨立 Tool 或 evaluation workload。
- **Go：** 部署與 concurrency 表現良好，但 TypeScript 對 JSON contract、schema 與未來 client／Tool SDK 的共享成本較低。若量化 NFR 證明 Node.js 不適合，再以 ADR 重評。
- **NestJS：** 提供完整 DI 與 module convention，但目前會引入尚無需求支持的 abstraction。Fastify 足以建立薄骨架。
- **pnpm workspace／monorepo：** 目前只有一個 application，採用 workspace 不會帶來實際邊界或發布效益。

## 4. 架構與責任邊界

初始化只建立兩個 runtime responsibility：

```text
Operating System / Environment
              │
              ▼
        src/server.ts
  process config and lifecycle
              │
              ▼
         src/app.ts
  Fastify application composition
              │
              ▼
         GET /health
      static liveness response
```

### 4.1 `src/app.ts`

責任：

- 匯出 `buildApp(options)` factory。
- 建立 Fastify instance。
- 註冊唯一的初始化 route：`GET /health`。
- 不讀取 process environment。
- 不啟動 network listener。

這個邊界讓測試可使用 Fastify injection，而不依賴 port、socket 或 child process。

### 4.2 `src/server.ts`

責任：

- 讀取 `HOST` 與 `PORT`。
- 驗證 `PORT` 是 `1..65535` 的整數。
- 建立 application 並啟動 listener。
- 處理 startup failure。
- 接收 `SIGINT`／`SIGTERM` 並關閉 application。

`server.ts` MUST NOT 註冊 route 或包含業務邏輯。

### 4.3 Health contract

初始化唯一的 HTTP contract：

```http
GET /health
```

成功結果：

```json
{
  "status": "ok"
}
```

| 欄位 | 型別 | 意義 |
| --- | --- | --- |
| `status` | literal `"ok"` | Process 已啟動且 Fastify 可處理 request。 |

限制：

- 這是 liveness，不是 dependency readiness。
- 不連線至 database、model、IAM 或其他 downstream。
- 不承諾 production monitoring contract；後續若需要 readiness，應另外設計。

### 4.4 核心資料模型與資料流

初始化沒有業務資料模型，也沒有持久化資料。唯一資料結構是 `HealthResponse`。

Request flow：

1. Fastify 接收 `GET /health`。
2. Route handler 建立固定的 `HealthResponse`。
3. Fastify 依 response JSON Schema 序列化結果。
4. Client 收到 HTTP 200 與 JSON body。

不存在 upstream identity、external downstream、message queue 或 storage contract。

## 5. 專案結構

實作階段只新增或修改下列檔案：

```text
.
├── .editorconfig
├── .gitattributes
├── .github/
│   └── workflows/
│       └── ci.yml
├── .gitignore
├── .nvmrc
├── .prettierignore
├── .prettierrc.json
├── README.md
├── eslint.config.js
├── package.json
├── package-lock.json
├── src/
│   ├── app.ts
│   └── server.ts
├── test/
│   └── app.test.ts
├── tsconfig.build.json
└── tsconfig.json
```

各檔案的必要性：

| 檔案 | 必要原因 |
| --- | --- |
| `package.json` | 定義 dependency、engine 與標準 scripts。 |
| `package-lock.json` | 提供 CI 與 contributor 可重現安裝。 |
| `tsconfig.json` | 定義 editor、test 與 typecheck 的嚴格型別規則。 |
| `tsconfig.build.json` | 將 production build 限制在 `src/`，避免輸出 test。 |
| `eslint.config.js` | 提供 type-aware correctness rules。 |
| `.prettierrc.json`、`.prettierignore` | 提供一致格式並排除 generated files。 |
| `.editorconfig`、`.gitattributes` | 統一基本 whitespace 與 line ending。 |
| `.gitignore` | 排除 dependency、build、coverage、log、secret-like local env files。 |
| `.nvmrc` | 提供本機 Node.js baseline。 |
| `src/app.ts` | 提供可測試的 application factory。 |
| `src/server.ts` | 提供 production process entry point。 |
| `test/app.test.ts` | 驗證 framework composition 與唯一 HTTP contract。 |
| `.github/workflows/ci.yml` | 在支援的 runtime versions 自動執行相同品質檢查。 |
| `README.md` | 提供安裝、指令、狀態及範圍說明。 |

MUST NOT 為尚未存在的業務模組建立空目錄、placeholder interface 或 speculative abstraction。

## 6. Build 與開發介面

`package.json` MUST 提供以下 scripts：

| Script | Contract |
| --- | --- |
| `dev` | 使用 `tsx watch` 執行 `src/server.ts`。 |
| `build` | 使用 `tsc -p tsconfig.build.json` 輸出至 `dist/`。 |
| `start` | 使用 Node.js 執行 `dist/server.js`。 |
| `typecheck` | 檢查 `src/` 與 `test/`，不產生輸出。 |
| `test` | 使用 Vitest 單次執行測試。 |
| `test:watch` | 使用 Vitest watch mode。 |
| `lint` | 執行 ESLint，warning 視為失敗。 |
| `format` | 使用 Prettier 寫入標準格式。 |
| `format:check` | 只檢查格式，不修改檔案。 |
| `check` | 依序執行 format check、lint、typecheck、test、build。 |

`npm run check` 是 local 與 CI 的共同 verification entry point。CI 不得另外維護一套不同的檢查邏輯。

## 7. Compiler 與程式規則

TypeScript 至少啟用：

- `strict`
- `exactOptionalPropertyTypes`
- `noUncheckedIndexedAccess`
- `noImplicitOverride`
- `noImplicitReturns`
- `noFallthroughCasesInSwitch`
- `noUnusedLocals`
- `noUnusedParameters`
- `forceConsistentCasingInFileNames`
- `verbatimModuleSyntax`

其他規則：

- Source 使用 ESM import/export。
- Relative runtime import 使用 `.js` suffix，以符合編譯後 Node.js ESM resolution。
- Production 執行編譯後 JavaScript，不以 `tsx` 執行。
- 不使用 shell-specific npm script。
- 不新增 runtime dependency，除非它是完成本文件 contract 的必要項目。

## 8. Configuration 與錯誤處理

### 8.1 Environment variables

| 名稱 | 必填 | 預設 | 驗證 |
| --- | --- | --- | --- |
| `HOST` | 否 | `0.0.0.0` | 交由 Node.js listener 驗證。 |
| `PORT` | 否 | `3000` | 必須是 `1..65535` 的整數。 |

本階段不引入 configuration library 或 `.env` loader；Node.js process environment 已足以支援兩個值。

### 8.2 Failure behavior

- Invalid `PORT` MUST 在 listener 啟動前明確失敗。
- Listener startup failure MUST 記錄 error 並設定 non-zero process exit status。
- `SIGINT`／`SIGTERM` MUST 呼叫 Fastify close，停止接受新 request 並等待既有 request 結束。
- Shutdown error 不得被刻意忽略；若實作發現 Fastify close 可能 reject，應記錄 error 並維持 non-zero exit status。
- 本階段不建立 domain error hierarchy 或 HTTP error envelope，因為沒有業務 endpoint。

## 9. 測試策略

### 9.1 初始化所需測試

`test/app.test.ts` MUST 使用 Fastify injection 驗證：

1. `GET /health` 回傳 HTTP 200。
2. Response body 等於 `{ "status": "ok" }`。
3. 每個 test 完成後關閉 application，避免 open handle。

### 9.2 不在初始化階段加入的測試

- 實際 socket／port E2E test。
- Container test。
- Load test。
- Database 或 external dependency integration test。
- Coverage threshold。

上述測試目前不會增加初始化 contract 的信心，反而建立未確認的 dependency 與維護成本。

## 10. CI 設計

GitHub Actions workflow MUST：

- 在 pull request 及 `main` branch push 執行。
- 將 default token permission 限制為 `contents: read`。
- 使用 Node.js 22、24 matrix。
- 使用 `npm ci`，不得使用會更新 lockfile 的 install mode。
- 執行 `npm run check`。
- 使用 npm cache，但不得快取 secret 或 build output。

本階段不加入 release、publish、container build、dependency bot 或 deployment workflow。

## 11. README contract

README MUST 包含：

- 專案一句話定位。
- 清楚標示目前只有 initialization scaffold，沒有業務功能。
- Runtime、language 與主要工具版本。
- Prerequisites。
- `npm ci`、`npm run check`、`npm run dev` 的 quick start。
- 所有 npm scripts 的用途。
- 目前目錄結構。
- 已刻意延後的技術選擇。
- 指向本設計文件的連結。

README 不應宣稱未實作的功能已可使用。

## 12. 關鍵決策與取捨

### 12.1 Application factory 與 server entry point 分離

增加一個檔案，但避免測試需要實際 listener，也讓未來 application composition 可獨立測試。此分離是必要而非預先抽象。

### 12.2 單一 package

目前最簡單且足夠。若未來出現需獨立發布、版本化或由不同團隊維護的 SDK／service，再轉為 npm workspaces。

### 12.3 不選擇 Agent framework

Agent framework 屬於業務架構選擇，與語言專案初始化無關；現在加入會超出需求並形成錯誤約束。

### 12.4 提供 health endpoint

Health endpoint 是唯一為驗證 HTTP framework、schema、test injection 與 runtime 啟動而存在的行為。它不代表任何 Agent 功能，也不檢查 downstream readiness。

## 13. 已知限制與擴充方向

初始化完成後仍然沒有：

- Production readiness endpoint。
- Runtime configuration schema。
- Structured application error contract。
- Dependency injection／module loader。
- Persistence、migration 或 transaction boundary。
- Telemetry、security headers、rate limiting 或 authentication。
- Container 與 deployment definition。

這些限制是刻意的。只有後續需求或 architecture design 明確需要時才加入；不得以「未來可能使用」為由在初始化階段預建。

## 14. 實作順序

實作者依下列順序執行，可降低 configuration 互相依賴造成的返工：

1. 建立 `package.json`、Node.js engine 與 npm scripts。
2. 安裝 dependencies 並產生 `package-lock.json`。
3. 建立 TypeScript build／typecheck configuration。
4. 建立 `app.ts`、`server.ts` 與 health smoke test。
5. 建立 ESLint、Prettier、EditorConfig、Git attributes／ignore。
6. 更新 README。
7. 建立 GitHub Actions CI。
8. 執行 `npm run check`，修正所有錯誤與 warning。
9. 檢查 git diff，確認沒有業務實作或非必要 generated artifact。

## 15. Definition of Done

全部條件皆成立才視為初始化完成：

- [x] `npm ci` 在 clean checkout 成功。
- [x] `npm run check` 成功且沒有 warning。
- [x] `npm run build` 只將 `src/` 輸出至 `dist/`。
- [x] `npm start` 可啟動 compiled application。
- [x] `GET /health` 符合本文件 contract。
- [x] `SIGINT`／`SIGTERM` 可進行 graceful shutdown。
- [ ] CI 在 Node.js 22 與 24 成功（workflow 已建立，需由 GitHub Actions 執行）。
- [x] README 的所有指令與實際 scripts 一致。
- [x] Lockfile 已建立並納入 repository。
- [x] 沒有 Agent、Session、Tool、IAM、database 或其他業務實作。
- [x] 沒有空業務目錄或 speculative abstraction。

## 16. 設計 Review

### 16.1 需求對照

| 初始化需求 | 對應設計 | 判定 |
| --- | --- | --- |
| 選擇程式語言 | TypeScript + Node.js LTS | 符合 |
| 建立可執行專案 | Fastify app factory + server entry | 符合 |
| 不實作業務需求 | 僅有 static liveness endpoint | 符合 |
| 可讀性與可維護性 | 兩個明確 runtime responsibility、strict typing、formatting | 符合 |
| 可測試性 | App factory + injection smoke test | 符合 |
| 可擴充性 | Fastify plugin 能力保留，但不預建業務 abstraction | 符合 |
| 開發者體驗 | 統一 scripts、README、watch mode、single check command | 符合 |
| 成熟開源品質 | Lockfile、CI matrix、lint、format、test、文件 | 符合 |
| 避免過度設計 | 無 monorepo、DI、container、database、Agent framework | 符合 |

### 16.2 必要性檢查

設計中的每項 production code 都有直接驗證目的：

- `app.ts`：建立可測試 HTTP application。
- `server.ts`：建立可執行 process 與正確 lifecycle。
- `/health`：提供最小 HTTP smoke contract。

其餘新增項目只負責 build、quality gate、版本重現或 contributor documentation。沒有業務資料模型、外部服務、抽象 layer 或部署假設，因此未超出初始化需求。

### 16.3 Review 結論

本設計符合「選擇程式語言並初始化專案、暫不實作需求」的範圍。內容足以讓後續實作者在不自行補充架構假設的情況下完成一致的初始化結果；同時沒有預先決定業務模組、storage 或 infrastructure，因此保留後續系統設計所需彈性。
