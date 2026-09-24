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
               "machine_type": "自訂類型代碼",
               "mac": "aa:bb:cc:dd:ee:ff"
           }
       ]
   }
   ```

   `mac` 為選填，僅自動更新 IP 功能會用到（見下方「自動同步機器 IP」）。

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

[docker-compose.yml](docker-compose.yml) 已將 `machines.json` 以唯讀 volume 掛進容器，且程式每次輪詢（每 30 秒）與每次呼叫 `/api/machines`、`/api/history` 等 API 都會重新讀檔，不會快取。

所以要調整機器 IP 或新增／移除機器時，直接編輯 host 上的 [machines.json](machines.json) 並存檔即可，**不需要 `docker compose build` 或 `restart`**，最慢 30 秒內下一輪輪詢就會套用新設定。

> 若要立即套用而不想等下一輪，可呼叫 `GET /api/poll` 手動觸發一次輪詢。

### 自動同步機器 IP（常駐）

內網 IP 可能變動，[scripts/sync-ips.js](scripts/sync-ips.js) 會定時依 `machines.json` 內各機器的 `mac` 找出目前的 IP，有變動就直接更新 `ip` 欄位。Dashboard 每輪詢都會重讀檔，所以更新後不需重啟。

運作方式：

1. 先探測 `machines.json` 目前記錄的 IP，MAC 都對得上就結束（不掃描）。
2. 有對不上的才掃描整個網段，依 MAC 找出新 IP 並原地更新檔案。
3. 找不到 MAC 的機器（例如關機）**不會更動**，只在 log 印出 `[找不到]`。

**注意**

- **需在 host 上執行，不是在容器內。** 容器內看不到區網 ARP，且 compose 將 `machines.json` 掛成唯讀。
- **host 必須與這些機器在同一個 L2 網段。** 腳本靠 ARP 取得 MAC，中間隔了路由器只會看到路由器的 MAC，全部會顯示「找不到」（不會誤改）。
- 執行身分需對 `machines.json` 有寫入權限。
- 需要 Node.js（與本專案相同版本即可），不需額外套件，也不需 root。

先手動跑一次確認可用（只掃描一次就結束）：

```bash
npm run sync-ips:once
```

#### 以 systemd 常駐（Linux，建議）

1. 建立 `/etc/systemd/system/wistron-sync-ips.service`（路徑、使用者請依實際環境調整，Node 路徑可用 `which node` 查詢）：

   ```ini
   [Unit]
   Description=Wistron dashboard - sync machine IPs by MAC
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=gerry
   WorkingDirectory=/opt/wistron-dashboard
   ExecStart=/usr/bin/node scripts/sync-ips.js
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```

2. 啟用並開機自動啟動：

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now wistron-sync-ips
   ```

3. 查看狀態與 log：

   ```bash
   systemctl status wistron-sync-ips
   journalctl -u wistron-sync-ips -f
   ```

#### 以 pm2 常駐（替代方案）

```bash
npm install -g pm2
pm2 start scripts/sync-ips.js --name wistron-sync-ips
pm2 save
pm2 startup   # 依畫面指示執行輸出的指令，即可開機自動啟動
```

#### 可調整的環境變數

| 變數 | 說明 | 預設值 |
| --- | --- | --- |
| `SYNC_INTERVAL_MINUTES` | 掃描間隔（分鐘） | `60` |
| `SYNC_SUBNETS` | 要掃描的網段（CIDR，逗號分隔，例如 `10.33.32.0/22`）。未設定時，自動使用 host 網卡中包含機器 IP 的網段 | 自動偵測 |

在 systemd 中請加在 `[Service]` 區段，例如 `Environment=SYNC_INTERVAL_MINUTES=30`。

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
| GET | `/api/machines` | 查看目前 `machines.json` 內容 |
| GET | `/api/history` | 查看所有機器的 Firmware 歷史紀錄 |
| GET | `/api/history/:machine_type` | 查看單一機器的歷史紀錄 |
| GET | `/api/poll` | 手動觸發一次輪詢 |
| GET | `/api-docs` | Swagger API 文件 |

## 環境變數

| 變數 | 說明 | 預設值 |
| --- | --- | --- |
| `PORT` | 服務監聽埠號 | `3000` |
| `BMC_USERNAME` | BMC Redfish API 帳號 | `root` |
| `BMC_PASSWORD` | BMC Redfish API 密碼 | `0penBmc` |
