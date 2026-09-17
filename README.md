# AI Agent Controller

企業級、受控的 AI Agent Runtime。本 repository 目前只包含可編譯、可測試的 Node.js／TypeScript 專案初始化骨架，尚未實作 Agent、Session、Tool、IAM 或其他業務功能。

## 技術基礎

- Node.js 22／24 LTS
- TypeScript 6（strict mode、ES modules）
- Fastify 5
- Vitest 5
- ESLint 10 + typescript-eslint
- Prettier 3
- npm + `package-lock.json`

初始化設計與選型取捨請參閱 [Project Initialization Design](docs/project-initialization-design.md)。

## Prerequisites

- Node.js `>=22.13 <23` or `>=24 <25`
- npm `>=10`

## Quick start

```bash
npm ci
npm run check
npm run dev
```

Development server 預設監聽 `0.0.0.0:3000`。目前唯一的 HTTP contract 是 liveness endpoint：

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

## Scripts

| Command                | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | 以 watch mode 啟動 TypeScript server            |
| `npm run build`        | 將 `src/` 編譯至 `dist/`                        |
| `npm start`            | 執行已編譯的 server                             |
| `npm test`             | 執行 Vitest 測試                                |
| `npm run test:watch`   | 以 watch mode 執行測試                          |
| `npm run typecheck`    | 執行 TypeScript 靜態檢查                        |
| `npm run lint`         | 執行 ESLint，warning 視為失敗                   |
| `npm run format`       | 以 Prettier 格式化檔案                          |
| `npm run format:check` | 檢查格式，不修改檔案                            |
| `npm run check`        | 依序執行 format、lint、typecheck、test 與 build |

## Project structure

```text
src/
├── app.ts       # Fastify application factory
└── server.ts    # process configuration and lifecycle
test/
└── app.test.ts  # HTTP application smoke test
docs/
└── project-initialization-design.md
```

`src/app.ts` 不啟動 network listener，因此測試可以使用 Fastify injection；`src/server.ts` 只負責環境變數、listener 與 graceful shutdown。

## Project status and scope

目前刻意未加入：

- Agent、Session、Tool、IAM、Policy 或 Usage 實作
- LLM SDK、database、ORM、cache、queue 或 event broker
- Authentication、rate limiting、telemetry 或 production readiness endpoint
- Docker、Kubernetes 或 deployment manifest
- Agent framework、DI framework 或 monorepo tooling

這些選擇須待後續需求與 architecture design 確認後再加入，避免初始化骨架預先限制業務設計。

## Documents

- [Project initialization design](docs/project-initialization-design.md)
