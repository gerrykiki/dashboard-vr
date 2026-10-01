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
       "machine_info_base": "https://es9-devops-report.thbsms.com/.cd-dashboard",
       "machines": [
           {
               "name": "機器名稱",
               "machine_type": "自訂類型代碼",
               "machine_info": ".oa-vader-xxx-<mac>/bmc_data.json"
           }
       ]
   }
   ```

   `machine_info` 是該機器 `bmc_data.json` 的路徑，會接在 `machine_info_base` 後面組成完整網址；也可以直接寫完整網址（`https://...`），就不會套用 `machine_info_base`。輪詢時會從中取得 `bmc_ip`（見下方「機器 IP 來源」）。

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

### 更新機器清單，不用重新部署

[docker-compose.yml](docker-compose.yml) 已將 `machines.json` 以唯讀 volume 掛進容器，且程式每次輪詢（每 30 秒）與每次呼叫 `/api/machines`、`/api/history` 等 API 都會重新讀檔，不會快取。

所以要新增／移除機器或修改 `machine_info` 時，直接編輯 host 上的 [machines.json](machines.json) 並存檔即可，**不需要 `docker compose build` 或 `restart`**，最慢 30 秒內下一輪輪詢就會套用新設定。

> 若要立即套用而不想等下一輪，可呼叫 `GET /api/poll` 手動觸發一次輪詢。

### 機器 IP 來源

機器的 BMC IP 不是固定的，所以 `machines.json` 不直接寫 IP，而是每台機器設定 `machine_info`（該機器的 `bmc_data.json` 網址）。每次輪詢都會先讀取 `machine_info`，取出其中的 `bmc_ip` 再呼叫 Redfish API，IP 變動會自動跟上，不需另外同步。

```json
{
    "machine_info_base": "https://es9-devops-report.thbsms.com/.cd-dashboard",
    "machines": [
        {
            "name": "OALan Vader.QS1 for Bespin TSC",
            "machine_type": "QS1_TSC",
            "machine_info": ".oa-vader-qs1-6e:b6:90:c2:4c:8e/bmc_data.json"
        }
    ]
}
```

實際讀取的網址為 `https://es9-devops-report.thbsms.com/.cd-dashboard/.oa-vader-qs1-6e:b6:90:c2:4c:8e/bmc_data.json?t=<timestamp>`（加上 `t` 避免快取）。

若 `machine_info` 讀取失敗或沒有 `bmc_ip`，該機器這一輪會跳過且不記錄。

### 透過 API 執行 script

放在 [scripts/](scripts/) 資料夾內的檔案才能被執行（白名單），API 只能指定檔名與參數，不經過 shell，參數不會被當成指令解析。

```bash
curl -X POST http://localhost:3000/api/scripts/hello.sh \
  -H 'Content-Type: application/json' \
  -d '{"args": ["world"]}'
```

回傳：

```json
{ "script": "hello.sh", "args": ["world"], "exit_code": 0, "timed_out": false, "duration_ms": 8, "stdout": "Hello, world!\n", "stderr": "" }
```

- 依副檔名選擇執行方式：`.sh` 用 `sh`、`.js` 用 `node`、`.py` 用 `python3`（容器為 node:alpine，預設沒有 `bash`／`python3`），其他副檔名直接執行（需有執行權限）。
- 會等 script 執行結束才回應；exit code 非 0 仍回 HTTP 200，請看 `exit_code`。
- 逾時預設 60 秒（`SCRIPT_TIMEOUT_SECONDS` 可調整），逾時會被中止並回傳 `timed_out: true`。
- 同一支 script 執行中再呼叫會回 409。
- compose 已將 `./scripts` 唯讀掛進容器，新增／修改 script 不需重建 image。

### 資料保存

- `./data`：每台機器的 Firmware 歷史紀錄（JSON，檔名為 `<machine_type>.json`），透過 volume 掛載，容器重建不會遺失。修改 `name` 不影響歷史紀錄，但 `machine_type` 改了就會接不上舊檔。
- 舊版以 `name` 當檔名，升級後第一次讀取時會自動改名為 `<machine_type>.json`。

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
| GET | `/api/machines` | 查看目前 `machines.json` 內容 |
| GET | `/api/machines/ip` | 即時讀取每台機器 `machine_info` 的 `bmc_ip` |
| GET | `/api/history` | 查看所有機器的 Firmware 歷史紀錄 |
| GET | `/api/history/:machine_type` | 查看單一機器的歷史紀錄 |
| GET | `/api/poll` | 手動觸發一次輪詢 |
| GET | `/api/scripts` | 列出 `scripts/` 內可執行的 script |
| POST | `/api/scripts/:name` | 執行指定 script，body 可帶 `{"args": ["..."]}` |
| GET | `/api-docs` | Swagger API 文件 |

## 環境變數

| 變數 | 說明 | 預設值 |
| --- | --- | --- |
| `PORT` | 服務監聽埠號 | `3000` |
| `BMC_USERNAME` | BMC Redfish API 帳號 | `root` |
| `BMC_PASSWORD` | BMC Redfish API 密碼 | `0penBmc` |
