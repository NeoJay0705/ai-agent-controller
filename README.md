# Pi Flow 任務控制器

本專案提供單一授權使用者透過 Telegram 私訊管理 Session 與非同步 Flow Job。正式路徑如下：

```text
Telegram → TelegramRouter／SQLite → FlowRunner／FlowExecutor
         → Pi CLI JSONL/RPC（Agent Node）或 server handler（Server Node）
         → 持久 outbox sender → Telegram
```

Production 不會 fallback 到 `DemoRunner`。`DemoRunner` 只供保留的 legacy demo／regression tests 使用。

目前產品基準是[Pi Flow 需求規格](docs/pi-flow-requirements.md)與[Pi Flow 架構設計](docs/pi-flow-design.md)。舊版[Telegram 控制器需求](docs/telegram-controller-requirements.md)與[架構設計](docs/telegram-controller-design.md)記錄底座歷史；若規則不同，以 Pi Flow 的 restart 與 READY 規則為準。

## Flow 能力與界線

| Flow    | 結果                                                                              | 限制                                                                                                       |
| ------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mbti`  | 使用原創生活偏好題估算四軸分數與候選，提供逐題依據和模型解讀。每批最多四題。      | 非官方自我反思，不是心理診斷。未知軸保留 `?`，不產生信心百分比，也不硬定類型。                             |
| `natal` | 以明確出生資料離線計算 UTC、十個行星、ASC／MC、十二宮與主要相位，再提供模型解讀。 | 必須有日期、時間、緯度、經度和 IANA 時區。不能只提供城市或未知時間。結果不保證預測，不提供醫療或投資保證。 |

星盤的數值計算在本機離線完成，但 intake、資料解析與模型解讀會使用 Flow 設定中的 provider。視流程與輸入內容，系統可能將相關請求、出生資料或 MBTI 答案傳送至 provider，並產生 API 費用。Provider 對資料的處理依其政策。離線數值計算不代表整個產品不連網。

新 Job 先進入 `intake`.系統會呈現可用 Flow，並等待使用者明確選擇。建議不等於選擇。系統不會改跑其他 Flow、通用聊天或 restricted fallback。Pi 與其子程序不是 OS sandbox。

## 需求環境與限制

- Node.js `>=22.19.0 <23` 或 `>=24.0.0 <25`。此範圍與 `package.json` 的 `engines.node` 一致。
- npm `>=10`。
- 使用 Node 內建 `node:sqlite`。
- Controller 需要 Linux 與系統提供的 `/usr/bin/flock`（util-linux）。Kernel lock 只支援本機 filesystem；不支援共享跨主機 data、HA、多程序或水平擴展。

## 安裝與啟動

1. 在 Telegram 官方 BotFather 建立 Bot，取得 token。不要把 token 放進 repository、聊天、command line 或 log。
2. 先由本人開啟 Bot 私訊並傳送 `/start`。Bot 必須先收到本人訊息，才能主動傳送通知。
3. 使用本人 Telegram numeric user ID 作授權依據。不要使用 username。不要把 token 或其他秘密交給第三方 Bot。需要查 ID 時，可先在本機把 Bot token 放在安全環境變數，再由本人傳送 `/start`，並在啟動 Controller 前查詢自己的 Bot `getUpdates` 中的 `message.from.id`。不要分享完整 URL、shell history 或回應內容。啟動 Controller 後，不要再開另一個 polling 程序。
4. 確認 Bot 沒有 webhook。程式不會自動呼叫 `deleteWebhook`。同一個 Bot 只能由一個 poller 使用。
5. 在可信任的 checkout 執行 `npm ci`，再執行 `npm run build`。
6. 只有在 `.env` 不存在時才從範例建立。若 `.env` 已存在，不要覆蓋；請安全地編輯既有檔案並補上必要欄位。保護檔案權限：

   ```bash
   if [ ! -e .env ]; then cp .env.example .env; fi
   chmod 600 .env
   ```

   不要執行 `source .env` 或 `. .env`。不要用 `set -x`、`env` 輸出、shell history、command line 或 log 洩漏 token／provider key。設定檔與日誌不得包含秘密。

7. 設定 `.env` 後，以 Node 載入它並啟動 production server：

   ```bash
   node --env-file=.env --enable-source-maps dist/server.js
   ```

`npm run dev` 與 `npm start` 不會自動載入 `.env`。`/health` 只表示 HTTP 程序存活，不表示 DB、Telegram、Flow runtime 或 provider/OAuth 已 READY。READY 是 Controller readiness；來源登入是否有效只會在 Agent Node 執行時確認。

### 必要設定與相容欄位

Bot mode 必須同時設定 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_USER_ID` 與 `PI_FLOW_CONFIG`。主要設定沿用 Pi 登入；完整範例如下：

操作者需先在一般 Pi 用 `/login` 登入與 Flow runtime 相同的 provider。請在本機 `.env` 設定明確的來源檔路徑。不要貼 token 或 `auth.json`。不要執行 `pi auth print-api-key` 或 `pi auth print-bearer-token`。

`PI_FLOW_AUTH_FILE` 只在 Bot mode 讀取。相對路徑以 process working directory 為準；建議使用 canonical absolute path。程式不展開 `~` 或 `$HOME`。來源必須是已存在、regular、0600、同 UID 且無 symlink 的檔案；來源目錄必須 canonical、可寫，讓 Pi 原生鎖可建立並更新 refresh token。來源不得位於本 Controller 的 `CONTROLLER_DATA_DIR/pi` 本身或其私有 Session subtree，避免 snapshot cleanup 刪除或覆寫來源；其他 `CONTROLLER_DATA_DIR` 路徑不受此限制。Controller 不會自動 chmod、登入或修復來源。health mode 不讀取此設定。

```dotenv
TELEGRAM_BOT_TOKEN=123456:REPLACE_WITH_BOTFATHER_TOKEN
TELEGRAM_ALLOWED_USER_ID=123456789
PI_FLOW_CONFIG=./config/pi-flow.oauth.example.json
PI_FLOW_AUTH_FILE=/home/YOUR_USER/.pi/agent/auth.json
CONTROLLER_DATA_DIR=./data
JOB_CONCURRENCY=2
MAX_PENDING_JOBS=100
MAX_PENDING_STEERING=100
HOST=0.0.0.0
PORT=3000
```

`PI_FLOW_CONFIG` 指向嚴格 JSON Flow 設定。`config/pi-flow.oauth.example.json` 是 Pi 登入範例。`config/pi-flow.example.json` 是 API-key 範例。Flow runtime 明確設定 `auth.mode`：`pi-login` 使用 `apiKeyEnv: null`；`api-key` 使用明確的 `apiKeyEnv` 環境變數名稱。舊設定省略 `auth` 時維持 API-key-only 解讀。兩種模式不互相 fallback；登入失效時 Job 安全失敗，不改用 API key。

Node runtime 可明確覆寫 Flow runtime。只有在所有有效 Agent Node 都不使用 `pi-login` 時，才不需要 `PI_FLOW_AUTH_FILE`。不要因 Flow 層的 runtime 使用 Pi 登入就覆蓋 API-key Node 的設定，也不要把 API key 寫入 JSON、Pi history、prompt 或 log。

兩份範例都使用 provider `openai`、model `gpt-6-luna`、thinking `max`，並保留相同 Flow graph、工具與 limits。範例不是可用性保證。啟動前請確認帳戶與本機 Pi CLI 支援該 provider、model 和 thinking level。系統不猜使用者預設，也沒有 model、thinking 或 authentication fallback；要求的設定不可用時，Job 會 fail closed。

範例 `config/pi-flow.example.json` 對每個 Flow 明列以下 limits：`nodeTimeoutMs=180000`、`waitTimeoutMs=86400000`、`jobTimeoutMs=86400000`、`maxTransitions=120`、`maxRetries=0`、`maxModelTurns=4`、`maxOutputChars=20000`。只有 natal Flow 的 `maxToolCalls=1`；intake 與 MBTI 為 `0`。這些數值是範例 JSON 的明確設定，不是程式預設值。Node 可明確覆寫 Flow runtime 或 limits；沒有覆寫時只使用 Flow 已宣告值。

Pi 原生 system prompt 會保留。Runtime 依序附加 Controller 共用規則及 Node 指令，使用兩個 `--append-system-prompt`。不使用 `--system-prompt` 覆蓋原生 prompt。保留原生 prompt 不會增加工具權限。

| 變數                       | 說明                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`       | BotFather token。與授權 ID 一起設定；不要記錄或分享。                                                                                                        |
| `TELEGRAM_ALLOWED_USER_ID` | 唯一允許的正整數 Telegram user ID；不接受 username。                                                                                                         |
| `PI_FLOW_CONFIG`           | Bot mode 必填。主要模式用 `config/pi-flow.oauth.example.json`；API-key 替代模式用 `config/pi-flow.example.json`。相對路徑以 process working directory 為準。 |
| `PI_FLOW_AUTH_FILE`        | 任一有效 Agent Node 使用 `pi-login` 時必填。只指定明確 auth.json 路徑；不展開 `~`／`$HOME`。                                                                 |
| provider credential        | API-key 模式由 Flow `runtime.apiKeyEnv` 指定，例如 `OPENAI_API_KEY`。不要提交或貼出金鑰。                                                                    |
| `CONTROLLER_DATA_DIR`      | SQLite 與 Pi 私有資料目錄；預設 `./data`。                                                                                                                   |
| `JOB_CONCURRENCY`          | 全域 Flow worker slot；預設 `2`，範圍 `1..128`。                                                                                                             |
| `MAX_PENDING_JOBS`         | 全系統未結束 Job 上限；預設 `100`。                                                                                                                          |
| `MAX_PENDING_STEERING`     | 每 Job pending steering 上限；預設 `100`。                                                                                                                   |
| `DEMO_STEP_MS`             | 僅供 legacy `DemoRunner`／設定相容。正式 Flow deadlines 不使用此值。                                                                                         |
| `JOB_TIMEOUT_MS`           | 僅供 legacy `DemoRunner`／設定相容。正式 Flow deadlines 使用 JSON limits，不使用此值。舊 `.env` 可以保留這兩個欄位，但不要依賴它們控制 Flow。                |
| `HOST`、`PORT`             | HTTP listener；預設 `0.0.0.0:3000`。                                                                                                                         |

若 Telegram 的兩個設定都未提供，程序只啟動 health endpoint。只設定其中一個、格式錯誤或 Bot mode 缺少 `PI_FLOW_CONFIG` 時，啟動失敗。

## Bot 命令

授權只檢查 Telegram update 的 `from.id` 與 private chat。程式不以 username、display name 或訊息內容授權。

| 命令／輸入               | 行為                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `/start`、`/help`        | 顯示說明。                                                                                  |
| `/new <name>`            | 建立並選取 Session。名稱長度為 1..100 UTF-16 code units。                                   |
| `/sessions`              | 列出本人 Session。                                                                          |
| `/use <session_id>`      | 切換目前私訊的 Session。                                                                    |
| `/queue <text>`          | 在選取的 Session 建立 Job。                                                                 |
| `/steer <job_id> <text>` | 對指定非 terminal Job 加入 steering；不建立 Job，也不依目前選取 Session 決定目標。          |
| `/status [job_id]`       | 直接查持久狀態，不建立 Job，也不呼叫 Pi。                                                   |
| `/cancel [job_id]`       | 取消指定 Job；不帶 ID 時列出可取消 Job 供選擇。                                             |
| 一般文字                 | 無上下文時不建立 Job；`/queue` 引導後可輸入內容建立 Job；有效 Job prompt reply 補充原 Job。 |

輸入必須是非空文字，最多 4096 UTF-16 code units。過期或 inactive prompt reply 不會重新開啟舊 Job。一般未引用／未回覆 prompt 的文字會新建 Job，不是既有 Job 的補充；請回覆正確的 Flow 訊息，或使用 `/steer <job_id> <text>`。

Owner 另可使用 `/allow`、`/revoke`、`/guests` 與 `/invite` 管理試用權限；詳細行為見下方「Controlled multi-user trials」段落。

## 使用者手動驗收範例

以下是操作者可自行執行的真 Telegram 手動驗收步驟，不是本次已完成的真 Telegram 或 provider 驗收。每個 Job 都會先等待 Flow 建議，再等使用者明確選擇。請等 READY 通知後再送新工作。

### MBTI

1. 建立專用 Session：`/new mbti-test`。
2. 建立 Job：`/queue 幫我用原創問題推估 MBTI`。
3. 等待該 Job 的 Flow 選擇訊息。回覆那則訊息 `mbti`，或傳送 `/steer <job_id> mbti`。
4. 依每批實際題目 ID 作答。每批最多四題；例如：`1=2、2=0、3=-1、4=null`。`-2` 到 `2` 是有效分數，`null` 表示不知道。後續批次的題號以訊息內容為準。
5. 每次收到候選答案時先核對答案與本人資料，再回覆「確認本人」。重複作答直到三批共 12 題完成。
6. 完成後核對四軸分數、候選類型、逐題依據、模型解讀，以及非官方自我反思／非心理診斷聲明。

### 出生星盤

1. 另開 Session：`/new natal-test`。
2. 以本人實際資料建立 Job。格式範例如下；這組資料是合成示例，不代表任何使用者：

   ```text
   /queue 請分析我的出生星盤，date=2000-01-01 time=12:00 lat=25.03 lon=121.56 zone=Asia/Taipei
   ```

3. 等待該 Job 的 Flow 選擇訊息，回覆 `natal`。
4. 核對日期、時間、緯度、經度與 IANA 時區。補齊缺值。若遇到 DST 不存在或重疊時間，依提示修正或提供可驗證的 `utcOffsetMinutes`。資料完整後回覆「確認本人」。
5. 完成後核對輸入資料、轉換後 UTC 與計算方法、十個行星、ASC／MC、十二宮、相位和模型解讀。

不能只提供城市名稱，因為系統不做網路地理定位。出生時間未知時，系統不會猜時間，也不會計算完整星盤。星盤結果不保證預測，不可作醫療或投資保證。

## Session、歷史事實與 Job 排程

- 同一 Controller Session 的 Job 依 FIFO 執行，並共用一份持久 Pi 對話歷史。不同 Session 的 Pi 歷史完全隔離。Pi history 不等於已確認事實。
- `RUNNING` Job 佔用 global worker slot 與該 Session partition。`WAITING_INPUT` 不佔 global slot，但仍鎖住該 partition，並阻止同 Session 後續 Job 越過它。
- 只有同一 Session、適用版本且已由本人確認的 facts 才可能沿用。當次明確資料優先；若與歷史 fact 衝突，系統先要求澄清，不自行選值。
- 一般 steering 在 safe point 才套用。接收確認不等於已套用；以 `/status` 查詢 `pending`／`applied`／`not_applied`。

## 啟動、READY、重啟與通知

Bot mode 載入 Flow 設定後建立 service。Service 啟動時將持久化的 `QUEUED`、`RUNNING`、`WAITING_INPUT` Jobs 全部標為 `FAILED/SERVER_RESTART`。舊 prompt 會失效；有效 failure／其他 outbox 通知在 READY 後繼續送出。重啟不會自動續跑舊 Job；請重新建立 Job。Pi Session history 和已完成結果會保留。

Service 以 `floor(nowMs / 1000) + 1` 作 READY 邊界。Telegram `message.date` 早於邊界的訊息會跳過，並在同一筆 SQLite transaction 推進 update offset。缺少或無效日期的 update 也會跳過，不讀取訊息內容。收到 READY 後請重新傳送啟動期間的訊息。Telegram 日期只有秒精度；主機時間應同步。`/health` 是 liveness，不是 READY。

Outbox 使用 at-least-once delivery。Telegram 已接收但本機尚未記錄成功時，可能重複傳送。同一 batch 的長訊息片段依序傳送；不同 batch 沒有全域順序保證。若新 prompt 取代正在傳送的舊 prompt，舊訊息仍可能稍後抵達，但其 binding 會保持 inactive，不能用來恢復 Job。請使用 `/steer <job_id> <text>` 或回覆目前有效問題。

## 資料安全、備份與保留限制

- Bot mode 使用 Linux kernel `flock` 保護本機資料目錄。`controller.kernel.lock` 是永久、非秘密的 lock anchor；正常關閉不會移除它。Anchor 存在不代表程序仍執行，絕不可用刪除 anchor 解鎖。Kernel lock 會在程序 crash／SIGKILL 後由 OS 釋放；取得 kernel lock 後，程式可回收同一 anchor 的完整新版 stale `controller.lock` marker。
- 舊版只含 PID 的 `controller.lock`、空檔、毀損或未知格式會 fail closed。程式不檢查 PID、mtime 或 timeout，也不會自動移除這些 marker。先確認所有 Controller 已停止，再由操作者一次性確認並移除該 legacy／unknown marker；不要移除 anchor，也不要刪除運作中 Controller 的 marker 或 anchor。
- 資料目錄與 Pi Session 目錄使用 `0700`；SQLite、Pi history、設定與 prompt 檔使用 `0600`。出生資料、MBTI 答案、Pi transcript 與 history facts 都是敏感資料。
- SQLite 使用 WAL。備份需使用一致 snapshot／SQLite backup API，或正確處理 WAL。只複製主 DB 檔而忽略 WAL，不能保證備份完整。
- Pi history 上限為 32 MiB。Runtime 不自動 compact，也不自動清理或保留舊 history。超限時不截斷歷史；操作者需受控管理資料或另開 Session。
- Pi 登入來源不是唯讀。只在需要時可能刷新 OAuth，並將原 `auth.json` 中當次 provider 的旋轉 token 寫回。Runtime 與使用相同 Pi 原生鎖的認證儲存並行。其他 provider JSON 值會保留，但寫回可能重新排版整份 JSON。不同 Pi 版本必須相容 auth 格式與鎖；不承諾能與任意外部 writer 安全並行。
- Child 只取得短期 access token 與 provider 必要 metadata；refresh token 清空，來源路徑不傳給 child。Runtime 在 child join 後清理暫存 auth snapshot。若程序 crash 留下暫存，下一次使用前會處理。使用者需在一般 Pi 重新登入或修正設定後建立新 Job。不要在 Telegram 進行 login 或貼出秘密。
- Flow 執行環境不共用個人 history、settings、models、extensions、MCP、skills、prompts、themes、AGENTS、SYSTEM、HOME、XDG 或 workspace。此隔離不是 OS sandbox。同一帳號或 root 仍有權限存取；記憶體中的 credential 也不能保證絕對清除。
- 限制 Pi tools 或停用 extension 不會隔離作業系統權限。Pi 不是 OS sandbox。部署者仍須限制執行帳號、資料目錄和網路權限。
- 不支援 HA、多程序共享、群組、附件、地名定位、通用工具、任意程式碼或 Shell，也沒有真實外部業務副作用。

Pi OAuth 認證使用固定本機 Pi 1.2.0 的內部 `FileAuthStorageBackend` 介面；這是版本特定介面，不是 SDK Agent runtime。失效登入只回報固定安全碼，例如 `FLOW_AUTH_LOGIN_REQUIRED` 或 `FLOW_AUTH_REFRESH_FAILED`。修正登入或設定後請建立新 Job。

## 離線驗證與未驗證項目

自動測試使用本機 SQLite、合成資料、synthetic credential、fake Telegram response 和 fake `AgentRuntime`。Controller integration tests 使用模擬 Telegram transport；它們不連真 Telegram，也不代表 provider request 成功。固定 Pi CLI offline smoke 只驗證 metadata、history 與 prompt boolean audit；不送 prompt、不呼叫 tool/model，也不連網。測試結果不等於外部服務驗收。

真實 Telegram、真實 provider request／模型輸出、部署環境、backup／restore 操作、Node 24 執行矩陣與共享／非本機 filesystem 行為尚未驗證。`npm run check` 是本機離線 quality pass，不會執行 BotFather、Telegram 或 provider E2E。

## Scripts

| Command                | Purpose                                                   |
| ---------------------- | --------------------------------------------------------- |
| `npm run dev`          | 以 watch mode 啟動 TypeScript server；不自動載入 `.env`。 |
| `npm run build`        | 將 `src/` 編譯至 `dist/`。                                |
| `npm start`            | 執行已編譯 server；不自動載入 `.env`。                    |
| `npm test`             | 執行離線 Vitest 測試。                                    |
| `npm run typecheck`    | 執行 TypeScript 靜態檢查。                                |
| `npm run lint`         | 執行 ESLint；warning 視為失敗。                           |
| `npm run format:check` | 檢查格式，不修改檔案。                                    |
| `npm run check`        | 依序執行格式、lint、typecheck、test 與 build。            |

## Gated live-model MBTI／出生星盤自測

`test/controller/flow-live.test.ts` 提供明確 opt-in 的真 Pi 模型測試。一般 `npm test`／`npm run check` 不會啟用它，也不會讀取個人認證、連線 provider 或連線 Telegram。此測試只 mock Telegram transport；Controller、SQLite、Flow 執行與 `PiCliRpcRuntime` 都是真實實作。Agent 計數 wrapper 只計數並委派給真 runtime，不提供假回應、fallback 或快取。

只有手動設定 `PI_FLOW_LIVE_TEST=1` 才會進入測試。操作者必須明確設定 `PI_FLOW_LIVE_AUTH_FILE` 為既有 Pi `auth.json` 的 absolute path。測試不載入 `.env`、不自動尋找 HOME，也不在模組載入時讀取認證。Pi OAuth broker 可能刷新登入，並將旋轉 token 寫回指定來源檔。執行前請確認來源可由 Pi 安全更新，並接受此副作用。

```bash
PI_FLOW_LIVE_TEST=1 \
PI_FLOW_LIVE_AUTH_FILE=/absolute/path/to/auth.json \
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
FLOW_TEST_API_KEY=synthetic-only-flow-key \
npm exec vitest run test/controller/flow-live.test.ts
```

可選 `PI_FLOW_LIVE_MAX_AGENT_NODES` 設定 Agent Node 預算，範圍為 `1..20`，預設 `12`。這是模型 Agent Node 數量上限，不是 HTTP 請求數；每個 Node 最多仍受範例設定的四個 model turns 限制，實際 HTTP/provider request 數未觀察。測試保留設定中的 `openai`、`gpt-6-luna`、`max`、`maxRetries=0`，不可用或請求失敗時會回報失敗，不會換 model 或降低 thinking。

測試只使用合成使用者、訊息、出生資料與獨立合成 SQLite／Pi Session history。產物寫入唯一 `.test-artifacts/pi-flow/live-model/<UUID>/` 目錄，資料夾權限為 `0700`，報告與 transcript 權限為 `0600`。不會重用或自動刪除舊 run。可用 `PI_FLOW_LIVE_ARTIFACT_ROOT` 指定此 repo 下 `.test-artifacts/pi-flow/live-model/` 之內的子目錄；其他路徑會在建立 Controller 或使用認證前拒絕。

測試不連真 Telegram，也不驗收 Telegram。真模型語意不保證通過。Natal 計算只與本機 server 的 `calculateNatalChart` 重算結果比對，不是外部星曆 golden 驗證。MBTI 結果是非官方自我反思，不是心理診斷。完成 live 執行也不代表整個產品的外部服務或部署環境已驗收。

## Controlled multi-user trials (implemented; offline verification)

The controlled-trial feature is connected to the Router, Service, SQLite store, Runner, outbox, and Agent runtime. Offline verification uses synthetic tests. See the [requirements](docs/controlled-trial-requirements.md) and [design](docs/controlled-trial-design.md). Real Telegram, provider, OAuth, and deployment behavior remain unverified; offline verification is not external acceptance.

The bot keeps `TELEGRAM_ALLOWED_USER_ID` as the owner. The owner can grant access with `/allow <user_id> [duration]`, revoke it with `/revoke <user_id>`, inspect users with `/guests`, and create one-use invite links with `/invite <invite TTL> [trial duration]`. Durations use a positive integer followed by `s`, `m`, `h`, or `d`; each duration is limited to 2147483647 milliseconds. The default trial is one hour and invite links expire after ten minutes.

Guests use `/new`, `/sessions`, `/use`, `/queue <text>`, `/steer <job_id> <text>`, `/status [job_id]`, and `/cancel [job_id]`. Plain text does not create a Job. An invite is redeemed only with `/start <token>`. Revocation and expiry deny new work and cancel queued or active Jobs. Command menus are convenience only; authorization is checked for every update.

Trial limits are configurable with the `TRIAL_*`, `INVITE_TTL_MS`, `COMMAND_DIALOG_TTL_MS`, and `CONTROL_MAX_PER_MINUTE` variables listed in `.env.example`. In v1, each guest user can run only one Job at a time because each guest user has one pending usage operation. `TRIAL_MAX_RUNNING_JOBS` accepts only `1`; it does not silently clamp larger values. The Owner is not limited by this guest trial concurrency setting. Global worker capacity remains controlled by `JOB_CONCURRENCY`.

Token usage uses native provider usage. A Session token limit rejects new model requests for that Session. A user token limit, or unknown usage, rejects new model requests for that guest user across Sessions. Status, cancel, and help control commands remain available. Other guest work is not blocked by these token-limit conditions. The final provider request can exceed the remaining allowance before its usage is known. Cancellation can also leave usage unknown. Guests use the Owner's authenticated provider quota; they do not need to log in to Pi.

Run `npm run check` for offline checks. Synthetic tests do not verify a real Telegram Bot API, provider, OAuth flow, or deployment.
