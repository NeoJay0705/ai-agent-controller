# Telegram 多 Session 非同步任務控制器

本專案提供單一授權使用者透過 Telegram 私訊管理多個 Session、排入非同步示範工作、補充 steering 與查詢狀態。資料存於本機 SQLite。v1 不使用 AI，也不執行外部業務操作。

需求與架構基準：

- [Telegram 控制器需求](docs/telegram-controller-requirements.md)
- [Telegram 控制器架構設計](docs/telegram-controller-design.md)

## 需求環境

- Node.js `>=22.13 <23` 或 `>=24 <25`
- npm `>=10`
- Node 內建 `node:sqlite`。此 API 在 Node 22 為 experimental。

Controller 使用單程序與 SQLite WAL。它不支援 HA、多程序或水平擴展。

## 啟動

不設定 Telegram 兩個環境變數時，只啟動 HTTP liveness endpoint：

```bash
npm run dev
curl http://localhost:3000/health
# {"status":"ok"}
```

`/health` 只表示 HTTP 程序存活。它不代表 DB、Telegram 或通知服務已就緒。

啟用 Bot 模式：

1. 在 Telegram 的官方 BotFather 建立 Bot，取得 bot token。不要把 token 放進 repository、聊天或 log。
2. 先由本人開啟 Bot 私訊並傳送 `/start`。Bot 必須先收到本人訊息，才能主動傳送通知。
3. 設定本人 Telegram numeric user ID。不要使用 username 作授權依據。不要為取得 ID 把 token 或其他秘密交給第三方 Bot。可在本機以自己的 Bot 呼叫 Telegram `getUpdates`，只讀取 `message.from.id`；在查詢前先傳送 `/start`，並把 token 放在本機環境變數，不要寫入 shell history 或分享完整 URL。請在啟動 controller 前完成，避免兩個 polling 程序同時使用 Bot。
4. 確認 Bot 沒有使用 webhook。程式不會自動呼叫 `deleteWebhook`。
5. 首次安裝時執行 `npm ci`。
6. 執行 `cp .env.example .env`，接著執行 `chmod 600 .env`，再編輯 `.env` 填入秘密與設定。`npm run dev` 與 `npm start` 不會自動載入 `.env`。
7. 正式啟動時執行 `npm run build`，再依下列指令啟動：

   ```bash
   node --env-file=.env --enable-source-maps dist/server.js
   ```

不要使用 `source .env` 或 `. .env` 載入不受信任的設定。不要把 token 放在 command line 或 shell history。開發指令也不會自動載入 `.env`；請使用安全的環境變數管理方式。

設定範例：

```dotenv
TELEGRAM_BOT_TOKEN=123456:REPLACE_WITH_BOTFATHER_TOKEN
TELEGRAM_ALLOWED_USER_ID=123456789
CONTROLLER_DATA_DIR=./data
JOB_CONCURRENCY=2
DEMO_STEP_MS=1000
JOB_TIMEOUT_MS=60000
MAX_PENDING_JOBS=100
MAX_PENDING_STEERING=100
HOST=0.0.0.0
PORT=3000
```

`TELEGRAM_BOT_TOKEN` 與 `TELEGRAM_ALLOWED_USER_ID` 必須同時設定。兩者都未設定時是 health-only mode。空字串、只有一個設定或格式錯誤會使啟動失敗。範例 token 是佔位值，不可用於連線。

設定限制與預設：

| 環境變數                   | 預設      | 驗證範圍／說明                                                        |
| -------------------------- | --------- | --------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | 無        | Bot mode 必填。token 不寫入 log。                                     |
| `TELEGRAM_ALLOWED_USER_ID` | 無        | Bot mode 必填。正的 safe integer；不接受 username。                   |
| `CONTROLLER_DATA_DIR`      | `./data`  | 相對路徑以啟動時的 working directory 為準。                           |
| `JOB_CONCURRENCY`          | `2`       | `1..128`。                                                            |
| `DEMO_STEP_MS`             | `1000`    | 正整數，最大 `2147483647` ms。                                        |
| `JOB_TIMEOUT_MS`           | `60000`   | 正整數，最大 `2147483647` ms。從首次 RUNNING 起計，包含等待輸入時間。 |
| `MAX_PENDING_JOBS`         | `100`     | `1..100000`。計算全系統未結束工作。                                   |
| `MAX_PENDING_STEERING`     | `100`     | `1..100000`，每 Job 計算。                                            |
| `HOST`                     | `0.0.0.0` | HTTP listener host。                                                  |
| `PORT`                     | `3000`    | `1..65535`。                                                          |

訊息上限為 4096 UTF-16 code units。Session 名稱限制為 1..100 UTF-16 code units。Outbox 每片最多 3500 UTF-16 code units，並保留完整 surrogate pair。

## BotFather 與使用方式

BotFather 只用來建立 Bot 與管理 Bot 設定。授權依據是 update 的 `from.id`，且 `chat.type` 必須為 `private`。程式不以 username、display name 或訊息內容授權。

支援命令：

| 命令／輸入               | 行為                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `/start`、`/help`        | 顯示說明。                                                                                      |
| `/new <name>`            | 建立 Session，並選中它。名稱長度為 1..100 UTF-16 code units。                                   |
| `/sessions`              | 列出本人 Session。                                                                              |
| `/use <session_id>`      | 切換目前私訊的 Session。                                                                        |
| 一般文字                 | 建立 queued Job；如果是有效且仍開啟的 prompt reply，則成為該 Job 的 steering。                  |
| `/queue <text>`          | 明確建立 queued Job。                                                                           |
| `/steer <job_id> <text>` | 對指定非 terminal Job 加入 pending steering。不建立 Job，也不依目前 selected Session 決定目標。 |
| `/status [job_id]`       | 直接查 Job，或查目前 Session 的非 terminal 工作與最近 10 筆 terminal 工作。                     |

一般文字與 `/queue` 需要先選 Session。`/steer` 不需要目前選中目標 Session。`/status` 與 `/sessions` 不會建立 Job。查詢跨 owner 或不存在的 ID 時會回覆不洩漏資源資訊的錯誤。

所有輸入都必須是非空文字，長度不可超過 4096 UTF-16 code units。未知命令、錯誤格式、非文字輸入、沒有 selected Session、已結束 Job、過期 prompt 或達到上限時，系統會拒絕並保留一致資料狀態。

## Demo 工作與狀態

每個 Job 執行三步 cooperative demo。每步預設等待 1000 ms。`DEMO_STEP_MS` 可調整等待時間。工作在每個 safe point 交易內儲存 checkpoint，並消費當時的 pending steering。完成輸出包含原始輸入與已套用 steering。

- 輸入以 `ask:` 開頭：第一步後轉為 `WAITING_INPUT`，並持久建立一則問題。第一步前收到的 steering 會在 step 1 套用，但 Job 仍會提出一次問題；使用者仍須提供新的補充才能恢復同一 Job。回覆已確認送達的問題，或使用 `/steer <job_id> <text>` 會恢復原 Job。等待期間 deadline 繼續倒數。問題只建立一次。
- 輸入以 `fail:` 開頭：第一個 safe point 以 `FAILED/DEMO_FAILURE` 結束。尚未套用 steering 標記為 `not_applied`。
- 狀態為 `QUEUED`、`RUNNING`、`WAITING_INPUT`、`COMPLETED` 或 `FAILED`。`COMPLETED` 和 `FAILED` 是 terminal。
- 每 Session 最多一筆 `RUNNING` 或 `WAITING_INPUT`。`WAITING_INPUT` 不佔全域執行 slot，但會阻擋同 Session 後續工作。
- Steering 接收時是 `pending`，僅在 safe point 轉成 `applied`。工作失敗或逾時時，剩餘 steering 轉為 `not_applied`。
- `/status` 顯示 checkpoint、pending/applied/not_applied steering 數量與通知 delivery failure。通知失敗不會重跑 Job。
- Job deadline 預設 60000 ms。逾時使用 `FAILED/TIMEOUT`，並釋放 Session partition。

通知透過持久 outbox 傳送。Delivery 使用 at-least-once；Telegram 已接收但本機尚未記錄成功時，通知可能重複。程式不宣稱 exactly-once。同一通知 batch 的長訊息片段依序傳送；不同 batch 沒有全域順序保證，因此獨立的 `/status` 回覆可能先於較早通知送達。

若 Telegram 已收到補充問題，但 client 沒有取得 `message_id`，系統無法可靠建立 reply binding。請使用 `/steer <job_id> <text>`，或等待重送的問題成功回傳 ID，再回覆該問題。

## 儲存、lock 與備份

Bot mode 會建立權限為 `0700` 的資料目錄、權限為 `0600` 的 SQLite 檔案，並以 exclusive `controller.lock` 防止第二個程序使用同一目錄。已存在的 lock 不會自動判斷或清除。異常退出可能留下 stale lock。操作者必須先確認沒有 controller 程序，再手動移除 lock。

SQLite 使用 WAL、foreign keys 與 busy timeout。備份時需使用 SQLite 一致 snapshot／backup API，或先正確處理 WAL。單純複製主 DB 檔而忽略 WAL，不保證備份包含最新狀態。測試資料只使用 `.test-artifacts/`，正式資料預設使用 `./data/`。

重啟後，queued、waiting、outbox 與 checkpoint 會從 SQLite 恢復。RUNNING Job 從已提交 checkpoint 繼續。若將 `JOB_CONCURRENCY` 調低至小於持久化 RUNNING Job 數量，程序會拒絕啟動，且不修改 Job。v1 沒有自動 retention；操作者負責本機資料的備份、保留與清理。

## 範圍限制與驗證

本版本沒有 AI／LLM、Agent framework、Shell、任意程式碼執行、附件、檔案處理、Webhook、多使用者、群組、外部 queue 或外部業務服務。Demo 不執行外部副作用。本次來源人工 review 涵蓋 v1 候選程式與測試，不是 SAST，也不涵蓋全 Git 歷史或未來變更。npm audit 依當時 registry 與 lockfile 檢查已知套件漏洞，不是 Node runtime CVE 掃描或可利用性驗證。詳見[Telegram 控制器安全檢查紀錄](docs/telegram-controller-security-review.md)。

離線測試使用本機 SQLite、fake fetch／Telegram response、受控時間與本機 HTTP listener。測試不連線真實 Telegram。真實 Telegram、backup／restore 流程及 Node 24 執行矩陣尚未驗證。測試通過不表示 BotFather、真實 token、Telegram 網路或部署環境已驗證。

```bash
npm run check
```

## Scripts

| Command                | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `npm run dev`          | 以 watch mode 啟動 TypeScript server。         |
| `npm run build`        | 將 `src/` 編譯至 `dist/`。                     |
| `npm start`            | 執行已編譯的 server。                          |
| `npm test`             | 執行離線 Vitest 測試。                         |
| `npm run typecheck`    | 執行 TypeScript 靜態檢查。                     |
| `npm run lint`         | 執行 ESLint，warning 視為失敗。                |
| `npm run format:check` | 檢查格式，不修改檔案。                         |
| `npm run check`        | 依序執行格式、lint、typecheck、test 與 build。 |
