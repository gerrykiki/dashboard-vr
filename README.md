# Wistron Dashboard

定時輪詢多台 BMC 機器的 Redfish Firmware API,記錄版本變化歷史，並提供查詢用的 REST API。

## 需求

- Docker / Docker Compose

## 部署方式（建議：Docker Compose）

1. 準備環境變數檔：

   ```bash
   cp .env.example .env
   ```

   依實際環境修改 `.env` 內的 BMC 帳密：

   ```
   BMC_USERNAME=root
   BMC_PASSWORD=0penBmc
   ```

   容器內是以非 root 身分執行，且需與 host 上 `./data` 目錄的擁有者一致才有寫入權限，
   否則輪詢寫入歷史紀錄會失敗。請用 `id -u` / `id -g` 查詢後填入：

   ```
   DASHBOARD_UID=1000
   DASHBOARD_GID=1000
   ```

2. 設定要輪詢的機器清單 [machines.json](machines.json)：

   ```json
   {
       "machines": [
           {
               "name": "機器名稱",
               "ip": "192.168.1.1",
               "machine_type": "自訂類型代碼"
           }
       ]
   }
   ```

3. 啟動服務：

   ```bash
   docker compose up -d --build
   ```

   服務啟動後會在 `http://<host>:3000` 提供 API，並立即開始第一次輪詢。

4. 查看 log：

   ```bash
   docker compose logs -f
   ```

5. 停止服務：

   ```bash
   docker compose down
   ```

### 更新機器 IP／清單，不用重新部署

[docker-compose.yml](docker-compose.yml) 已將 `machines.json` 以唯讀 volume 掛進容器，且程式每次輪詢（每 30 秒）與每次呼叫 `/machines`、`/history` 等 API 都會重新讀檔，不會快取。

所以要調整機器 IP 或新增／移除機器時，直接編輯 host 上的 [machines.json](machines.json) 並存檔即可，**不需要 `docker compose build` 或 `restart`**，最慢 30 秒內下一輪輪詢就會套用新設定。

> 若要立即套用而不想等下一輪，可呼叫 `GET /poll` 手動觸發一次輪詢。

### 資料保存

- `./data`：每台機器的 Firmware 歷史紀錄（JSON），透過 volume 掛載，容器重建不會遺失。

## 手動 Docker 指令（不使用 Compose）

```bash
docker build -t wistron-dashboard .

docker run -d \
  --name wistron-dashboard \
  -p 3000:3000 \
  -e BMC_USERNAME=root \
  -e BMC_PASSWORD=0penBmc \
  -u "$(id -u):$(id -g)" \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/machines.json:/app/machines.json:ro" \
  wistron-dashboard
```

> 若未掛載 `machines.json`，機器清單會被固定在 image 裡，之後修改就必須重新 build。
> `-u "$(id -u):$(id -g)"` 讓容器內執行身分與 host 上 `./data` 的擁有者一致，否則非 root 執行會沒有寫入權限。

## 本機開發（不使用 Docker）

```bash
npm install
npm run dev   # node --watch，程式碼變更自動重啟
```

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/` | 健康檢查用首頁 |
| GET | `/machines` | 查看目前 `machines.json` 內容 |
| GET | `/history` | 查看所有機器的 Firmware 歷史紀錄 |
| GET | `/history/:machine_type` | 查看單一機器的歷史紀錄 |
| GET | `/poll` | 手動觸發一次輪詢 |
| GET | `/api-docs` | Swagger API 文件 |

## 環境變數

| 變數 | 說明 | 預設值 |
| --- | --- | --- |
| `PORT` | 服務監聽埠號 | `3000` |
| `BMC_USERNAME` | BMC Redfish API 帳號 | `root` |
| `BMC_PASSWORD` | BMC Redfish API 密碼 | `0penBmc` |
