const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { Agent } = require('undici');
const fs = require('fs');
const path = require('path');

const swaggerSpec = require('./swagger');

const app = express();

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const PORT = Number(process.env.PORT) || 3000;
const POLL_INTERVAL = 30 * 1000;

const BMC_USERNAME = process.env.BMC_USERNAME || 'root';
const BMC_PASSWORD = process.env.BMC_PASSWORD || '0penBmc';

// 防止同時間執行多次整批輪詢
let polling = false;

// 每台機器前一次成功取得的 Firmware 版本（key: machine.name）
const previousFirmwareVersions = new Map();

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MACHINES_FILE = path.join(ROOT_DIR, 'machines.json');

// 如果 data 資料夾不存在，就自動建立
fs.mkdirSync(DATA_DIR, { recursive: true });

// 對應 curl -k，忽略 HTTPS 憑證驗證
const httpsAgent = new Agent({
  connect: {
    rejectUnauthorized: false
  }
});

/**
 * 讀取 machines.json，取得所有要輪詢的機器
 */
function loadMachines() {
  try {
    const fileContent = fs.readFileSync(MACHINES_FILE, 'utf8');
    const parsed = JSON.parse(fileContent);
    return Array.isArray(parsed.machines) ? parsed.machines : [];
  } catch (error) {
    console.error('讀取 machines.json 失敗：', error.message);
    return [];
  }
}

/**
 * 將機器名稱轉換成安全的檔名
 */
function sanitizeFilename(name) {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
}

function getHistoryFilePath(machine) {
  return path.join(DATA_DIR, `${sanitizeFilename(machine.name)}.json`);
}

function getBmcUrl(machine) {
  return `https://${machine.ip}/redfish/v1/UpdateService/FirmwareInventory?$expand=*($levels=1)`;
}

/**
 * 取得單一機器的歷史紀錄
 */
function readHistory(historyFile) {
  try {
    if (!fs.existsSync(historyFile)) {
      return [];
    }

    const fileContent = fs.readFileSync(historyFile, 'utf8').trim();

    if (!fileContent) {
      return [];
    }

    const history = JSON.parse(fileContent);

    if (!Array.isArray(history)) {
      console.error(`歷史 JSON 不是陣列，將重新建立：${historyFile}`);
      return [];
    }

    return history;
  } catch (error) {
    console.error(`讀取 Firmware 歷史紀錄失敗（${historyFile}）：`, error.message);
    return [];
  }
}

/**
 * 寫入單一機器的歷史紀錄
 *
 * status:
 * - UPDATED：第一次成功或版本有變更
 *
 * API 失敗或拿到空資料時不記錄
 */
function writeHistoryRecord(historyFile, record) {
  try {
    const history = readHistory(historyFile);

    history.push({
      timestamp: new Date().toISOString(),
      ...record
    });

    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');

    console.log(`已寫入紀錄：${historyFile}`);
  } catch (error) {
    console.error(`寫入 Firmware 歷史紀錄失敗（${historyFile}）：`, error.message);
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
 * 呼叫單一機器的 BMC Firmware API
 */
async function pollMachine(machine) {
  const bmcUrl = getBmcUrl(machine);
  const historyFile = getHistoryFilePath(machine);

  try {
    const basicAuth = Buffer
      .from(`${BMC_USERNAME}:${BMC_PASSWORD}`)
      .toString('base64');

    console.log(`[${machine.name}] 開始讀取 Firmware API：${bmcUrl}`);

    const response = await fetch(bmcUrl, {
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
      console.log(`[${machine.name}] Firmware API 回傳空資料，不記錄`);
      return;
    }

    // 只使用 Id 和 Version 判斷版本是否變更
    const currentFirmwareVersions = normalizeFirmwareVersions(firmwareList);
    const previousList = previousFirmwareVersions.get(machine.name) || [];

    const hasChanged = hasFirmwareVersionChanged(
      currentFirmwareVersions,
      previousList
    );

    if (!hasChanged) {
      console.log(`[${machine.name}] Firmware 版本沒有變化，跳過寫入`);
      return;
    }

    /**
     * 第一次成功或版本有變更
     */
    console.log(`[${machine.name}] 偵測到 Firmware 版本更新：`);
    console.table(firmwareList);

    // 寫入完整 Firmware 模組資訊
    writeHistoryRecord(historyFile, {
      machine: machine.name,
      ip: machine.ip,
      status: 'UPDATED',
      modules: firmwareList
    });

    /**
     * 只有成功取得並寫入更新資料後，
     * 才更新前一次版本
     */
    previousFirmwareVersions.set(machine.name, currentFirmwareVersions);

  } catch (error) {
    console.error(`[${machine.name}] 輪詢失敗，不記錄：`, error.message);
  }
}

/**
 * 平行輪詢所有機器
 */
async function pollAll() {
  if (polling) {
    console.log('上一次輪詢尚未完成，跳過這次');
    return;
  }

  polling = true;

  try {
    const machines = loadMachines();
    await Promise.all(machines.map((machine) => pollMachine(machine)));
  } finally {
    polling = false;

    // 30 秒後執行下一次輪詢
    setTimeout(pollAll, POLL_INTERVAL);
  }
}

/**
 * 首頁
 */
app.get('/', (req, res) => {
  res.send('Hello Docker + Node.js!');
});

/**
 * @openapi
 * /machines:
 *   get:
 *     summary: 查看 machines.json 內容
 *     responses:
 *       200:
 *         description: machines.json 的完整內容
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/machines', (req, res) => {
  try {
    const fileContent = fs.readFileSync(MACHINES_FILE, 'utf8');
    res.json(JSON.parse(fileContent));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @openapi
 * /history:
 *   get:
 *     summary: 查看所有機器目前儲存的歷史紀錄
 *     responses:
 *       200:
 *         description: 以機器名稱為 key 的歷史紀錄物件
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/history', (req, res) => {
  try {
    const machines = loadMachines();
    const result = {};

    for (const machine of machines) {
      result[machine.name] = readHistory(getHistoryFilePath(machine));
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @openapi
 * /history/{machine_type}:
 *   get:
 *     summary: 查看單一機器的歷史紀錄
 *     parameters:
 *       - in: path
 *         name: machine_type
 *         required: true
 *         schema:
 *           type: string
 *         description: 機器類型
 *     responses:
 *       200:
 *         description: 該機器的歷史紀錄陣列
 *       404:
 *         description: 找不到機器
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/history/:machine_type', (req, res) => {
  try {
    const machines = loadMachines();
    const machine = machines.find((m) => m.machine_type === req.params.machine_type);

    if (!machine) {
      return res.status(404).json({
        error: `找不到機器：${req.params.machine_type}`
      });
    }

    res.json(readHistory(getHistoryFilePath(machine)));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @openapi
 * /poll:
 *   get:
 *     summary: 手動觸發一次所有機器的 Firmware 輪詢
 *     responses:
 *       200:
 *         description: 輪詢完成
 *       409:
 *         description: 目前已有輪詢正在執行
 */
app.get('/poll', async (req, res) => {
  if (polling) {
    return res.status(409).json({
      message: '目前已有輪詢正在執行'
    });
  }

  await pollAll();

  res.json({
    message: 'Firmware 輪詢完成'
  });
});

/**
 * 啟動 Web Server
 */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);

  // Server 啟動後立即執行第一次輪詢
  pollAll();
});
