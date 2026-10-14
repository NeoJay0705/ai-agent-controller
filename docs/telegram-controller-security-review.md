# Telegram 控制器安全檢查紀錄

- **檢查日期：** 2026-10-14 UTC。
- **紀錄性質：** 本文件記錄此次 commit 前檢查，不是可重複使用的安全保證。

## 範圍與人工來源 review

檢查範圍是 Telegram v1 候選 source、tests、docs 與 lockfile。
檢查不涵蓋完整 Git 歷史。

環境版本是 Node.js `22.21.1` 與 npm `10.9.4`。

人工 review 摘要如下：

- 授權限於設定的單一使用者與 Telegram private chat。
- 資源查詢與操作透過 Store 執行 owner filter。
- SQLite 查詢使用參數化 SQL。
- 檢視範圍內沒有 `eval`、Shell 或外部 executor。
- 輸入訊息、待處理工作與 steering 有容量限制。
- 資料目錄使用 `0700` 權限。
- SQLite 檔案使用 `0600` 權限。
- 程序使用 exclusive lock 限制同一資料目錄的並行使用。
- Logging 使用分類錯誤摘要，並避免輸出 token 與敏感 URL。

以上內容是人工來源 review 摘要，不是 SAST 證明。
預設 HTTP host 是 `0.0.0.0`。
HTTP endpoint 只提供 liveness。
部署時須限制不必要的網路暴露。
本機資料目錄與環境設定須由可信操作員管理。

本機 `.env` 是 ignored local 設定，不納入 commit。檢查時，權限由 `0664` 收緊為 `0600`，內容未變。舊權限允許 group read/write。Home directory 的 `0750` 可限制未獲該目錄群組權限的其他帳號沿路存取，但不取代 secret file 本身設為 `0600`。README 啟動步驟已加入 `chmod 600 .env`。
本次檢查不把本機 root 或相同 OS 帳號列為已防禦的攻擊者。

## npm audit 結果

本次發現並修正 GHSA-68fv-2mgg-jv7q：<https://github.com/advisories/GHSA-68fv-2mgg-jv7q>。
受影響套件是 `source-map-js`。
版本由 `1.2.1` 更新至 `1.2.2`。
依賴是 transitive dev dependency，鏈為 Vitest → Vite → PostCSS。
公告描述 indexed source-map section offsets 可造成 denial of service。
lockfile 修正只涉及目標依賴的三個欄位。
此結果不表示該弱點可由 production 直接利用。

修正前 full audit 回報 1 個 High vulnerability。
修正前 production audit 回報 0 個 vulnerability。
修正後 all-dependencies 與 production audit 各回報 0 個已知 vulnerability。
結果只適用於查詢當時的 registry 與 lockfile。
此結果不代表專案零漏洞。

執行的 audit 命令如下：

```bash
npm audit --json --registry=https://registry.npmjs.org
npm audit --json --registry=https://registry.npmjs.org --omit=dev
```

當次 npm cache 使用被忽略的 `.test-artifacts/security/npm-cache`。
原始 audit JSON 保留在 ignored `.test-artifacts/security/`。
原始 audit 報告不提交至 Git。
本摘要文件可提交至 Git。

## Regex secret scan

秘密掃描使用本次臨時 regex 工具，不是 gitleaks。
掃描範圍是 tracked existing text files 與本次明列的候選文件。
掃描不涵蓋完整 Git 歷史。
掃描排除 `.env` 本體、兩筆受保護筆記、runtime database、log 與 ignored artifacts。
`.env` 秘密只在記憶體中與候選文件比對。
報告不寫入秘密值、hash 或含秘密的 URL。

掃描規則涵蓋 Telegram token、private key PEM、AWS access key、GitHub token、Slack token 與 generic secret assignment。
四筆明確 placeholder 位於 `.env.example`、README、test helpers 與 Telegram tests。

掃描回報兩筆 generic secret assignment 疑點：`test/controller/server.test.ts:17` 與 `test/controller/service.test.ts:23`。
人工 review 確認兩處是 `.invalid` 網域與 fake query token 的測試 fixture。
掃描沒有對整個 test 或 docs 加入 allowlist。
範圍內未發現實際 secret match。
此結論只適用於上述掃描範圍與規則。

## 驗證命令與證據

```bash
npm run check
node .test-artifacts/security/secret-scan.mjs
npm run format:check
git diff --check
```

`npm run check` 涵蓋 format、lint、typecheck、test 與 build。
既有完整執行通過 10 個 test files 與 63 個 tests。
Audit JSON 與 `check-after.log` 保留在 ignored `.test-artifacts/security/`。
原始報告不提交至 Git。

## 未驗證項目與限制

當次環境未安裝 gitleaks、trufflehog、osv-scanner 與 semgrep。
本次沒有專用 SAST。
本次沒有掃描全 Git 歷史中的 secrets。
本次沒有驗證 Node runtime、OS、部署或 CI action 供應鏈，也沒有驗證弱點可利用性。
Node 24 執行矩陣、真實 Telegram smoke test 與 backup／restore 尚未驗證。
此 npm audit 不是 Node 版本 CVE 掃描。
部署應使用受維護且套用最新安全 patch 的 Node 22 或 Node 24。
本文件不宣稱專案零漏洞或已部署安全。

v1 使用單程序，不提供 HA。
v1 沒有自動 retention。
通知採 at-least-once，可能重複送達。
Demo checkpoint 不代表外部副作用具備重播安全性。
