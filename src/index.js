const express = require('express');
const { Agent } = require('undici');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const POLL_INTERVAL = 30 * 1000;

// BMC 設定
const BMC_URL =
  'https://10.33.33.173/redfish/v1/UpdateService/FirmwareInventory?$expand=*($levels=1)';

const BMC_USERNAME = process.env.BMC_USERNAME || 'root';
const BMC_PASSWORD = process.env.BMC_PASSWORD || '0penBmc';

// 防止同時間執行多次輪詢
let polling = false;

// 儲存前一次成功取得的 Firmware 版本
let previousFirmwareVersions = [];

// JSON 資料儲存位置
// Docker 內的位置：/app/data/firmware-history.json
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'firmware-history.json');

// 如果 data 資料夾不存在，就自動建立
fs.mkdirSync(DATA_DIR, { recursive: true });

// 對應 curl -k，忽略 HTTPS 憑證驗證
const httpsAgent = new Agent({
  connect: {
    rejectUnauthorized: false
  }
});

/**
 * 取得資料夾內的歷史紀錄
 */
function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }

    const fileContent = fs.readFileSync(HISTORY_FILE, 'utf8').trim();

    if (!fileContent) {
      return [];
    }

    const history = JSON.parse(fileContent);

    if (!Array.isArray(history)) {
      console.error('歷史 JSON 不是陣列，將重新建立');
      return [];
    }

    return history;
  } catch (error) {
    console.error('讀取 Firmware 歷史紀錄失敗：', error.message);
    return [];
  }
}

/**
 * 寫入 Firmware 歷史紀錄
 *
 * status:
 * - UPDATED：第一次成功或版本有變更
 * - EMPTY：API 成功，但拿到空資料
 * - FAILED：API 讀取失敗
 */
function writeHistoryRecord(record) {
  try {
    const history = readHistory();

    history.push({
      timestamp: new Date().toISOString(),
      ...record
    });

    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify(history, null, 2),
      'utf8'
    );

    console.log(`已寫入紀錄：${HISTORY_FILE}`);
  } catch (error) {
    console.error('寫入 Firmware 歷史紀錄失敗：', error.message);
  }
}

/**
 * 取得 Firmware 版本比較用的資料
 */
function normalizeFirmwareVersions(list) {
  return list
    .map((item) => ({
      Id: item.Id || '',
      Version: item.Version || ''
    }))
    .sort((a, b) => a.Id.localeCompare(b.Id));
}

/**
 * 比較目前與前一次的 Id + Version
 */
function hasFirmwareVersionChanged(currentList, previousList) {
  const current = normalizeFirmwareVersions(currentList);
  const previous = normalizeFirmwareVersions(previousList);

  return JSON.stringify(current) !== JSON.stringify(previous);
}

/**
 * 呼叫 BMC Firmware API
 */
async function pollApi() {
  if (polling) {
    console.log('上一次輪詢尚未完成，跳過這次');
    return;
  }

  polling = true;

  try {
    const basicAuth = Buffer
      .from(`${BMC_USERNAME}:${BMC_PASSWORD}`)
      .toString('base64');

    console.log(`開始讀取 Firmware API：${BMC_URL}`);

    const response = await fetch(BMC_URL, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json'
      },
      dispatcher: httpsAgent,
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`API 回傳 HTTP ${response.status}`);
    }

    const data = await response.json();

    // 只保留需要的欄位
    const firmwareList = (data.Members || []).map((item) => ({
      Id: item.Id || null,
      Type: item['@odata.type'] || null,
      Version: item.Version || null,
      Description: item.Description || null
    }));

    /**
     * API 成功，但沒有 Members 或 Members 是空陣列
     */
    if (firmwareList.length === 0) {
      console.log('Firmware API 回傳空資料');

      writeHistoryRecord({
        status: 'EMPTY',
        modules: []
      });

      // 清空前一次資料
      // 下一次成功取得資料時會視為更新
      previousFirmwareVersions = [];

      return;
    }

    // 只使用 Id 和 Version 判斷版本是否變更
    const currentFirmwareVersions = normalizeFirmwareVersions(
      firmwareList
    );

    const hasChanged = hasFirmwareVersionChanged(
      currentFirmwareVersions,
      previousFirmwareVersions
    );

    if (!hasChanged) {
      console.log('Firmware 版本沒有變化，跳過寫入');
      return;
    }

    /**
     * 第一次成功或版本有變更
     */
    console.log('偵測到 Firmware 版本更新：');
    console.table(firmwareList);

    // 寫入完整 Firmware 模組資訊
    writeHistoryRecord({
      status: 'UPDATED',
      modules: firmwareList
    });

    /**
     * 只有成功取得並寫入更新資料後，
     * 才更新前一次版本
     */
    previousFirmwareVersions = currentFirmwareVersions;

  } catch (error) {
    console.error('輪詢失敗：', error.message);

    // API 失敗也寫入一筆空資訊
    writeHistoryRecord({
      status: 'FAILED',
      error: error.message,
      modules: []
    });

    // 清空前一次資料
    // 下一次成功取得資料時會視為更新
    previousFirmwareVersions = [];

    console.log('已清空前一次 Firmware 版本資訊');

  } finally {
    polling = false;

    // 30 秒後執行下一次輪詢
    setTimeout(pollApi, POLL_INTERVAL);
  }
}

/**
 * 首頁
 */
app.get('/', (req, res) => {
  res.send('Hello Docker + Node.js!');
});

/**
 * 查看目前儲存的歷史紀錄
 */
app.get('/history', (req, res) => {
  try {
    const history = readHistory();
    res.json(history);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * 手動觸發一次 Firmware 輪詢
 */
app.get('/poll', async (req, res) => {
  if (polling) {
    return res.status(409).json({
      message: '目前已有輪詢正在執行'
    });
  }

  await pollApi();

  res.json({
    message: 'Firmware 輪詢完成'
  });
});

/**
 * 啟動 Web Server
 */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`History file: ${HISTORY_FILE}`);

  // Server 啟動後立即執行第一次輪詢
  pollApi();
});
