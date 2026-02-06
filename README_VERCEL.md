Vercel 部署注意事項

- 必要環境變數
  - `GOOGLE_MAPS_API_KEY`：用於 Google Maps Directions / Geocoding API。請在 Vercel 專案的 Settings → Environment Variables 中新增。

- Google Cloud 必要服務
  - 啟用「Directions API」與「Geocoding API」。

- 為何新增 Serverless function
  - 將需要的 API Key 放在伺服器端（`/api/ai-estimate`），避免在前端暴露 `GOOGLE_MAPS_API_KEY`。
  - 如果專案之前在前端直接 import 需要 API Key 的第三方套件（例如 server-only 的 `@google/generative-ai`），會造成部署或打包錯誤。請把這類功能搬到 serverless function 或後端。

- 測試方式（本機或部署後）
  - 本機（若使用 Vercel 開發伺服器或本地 dev server）
    ```bash
    curl -X POST https://your-deployment-url.vercel.app/api/ai-estimate \
      -H "Content-Type: application/json" \
      -d '{"input":"台積電 南科","origin":"彰化縣北斗鎮四海路二段79號"}'
    ```

- 常見問題
  - 若收到 `GOOGLE_MAPS_API_KEY is not configured`：請確認 env var 名稱與 Vercel environment 設定一致，並重新部署。
  - 若 Directions API 回傳非 `OK`：請到 Google Cloud Console 檢查配額、API 金鑰限制、或是否啟用信用額度。

- 建議
  - 不要在客戶端直接 import 需要服務帳戶金鑰或 server-only 套件。
  - 若需要更複雜的 AI 生成功能（例如使用 Google Generative API），把呼叫放在 serverless function，並在 Vercel 上設定必要的私密環境變數。

- 關於 `@google/generative-ai`
  - 已將專案範例從前端移除對 `@google/generative-ai` 的直接使用，並將相關查詢改為透過 `api/ai-estimate` serverless function（如需要使用 Generative API，請在 server 端安裝並使用）。
  - 若您需要在 serverless function 中使用 `@google/generative-ai`，在專案根目錄執行 `npm install @google/generative-ai`，或在 Vercel 的 Build Step 中以私有方式安裝。

