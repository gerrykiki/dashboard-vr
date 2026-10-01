const express = require('express');
const swaggerUi = require('swagger-ui-express');
const { Agent } = require('undici');
const fs = require('fs');
const https = require('https');
const path = require('path');

const swaggerSpec = require('./swagger');
const sshManager = require('./sshManager');
const scriptRunner = require('./scriptRunner');

const app = express();

app.use(express.json());

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const PORT = Number(process.env.PORT) || 3000;
// HTTPS 埠號（容器內非 root 無法聽 443，由 docker-compose 把 host 443 對應過來）
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const POLL_INTERVAL = 30 * 1000;

const BMC_USERNAME = process.env.BMC_USERNAME || 'root';
const BMC_PASSWORD = process.env.BMC_PASSWORD || '0penBmc';

// 防止同時間執行多次整批輪詢
let polling = false;

// 每台機器前一次成功取得的 Firmware 版本（key: machine.machine_type）
const previousFirmwareVersions = new Map();

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MACHINES_FILE = path.join(ROOT_DIR, 'machines.json');
const METADATA_FILE = path.join(ROOT_DIR, 'metadata.json');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DIST_INDEX_FILE = path.join(DIST_DIR, 'index.html');
// 自簽憑證（產生方式見 README），兩個檔案都存在才會啟動 HTTPS
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || path.join(ROOT_DIR, 'certs', 'cert.pem');
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || path.join(ROOT_DIR, 'certs', 'key.pem');

// 如果 data 資料夾不存在，就自動建立
fs.mkdirSync(DATA_DIR, { recursive: true });

// 提供 Vue build 出來的靜態檔案（dist），若不存在則略過（例如本機開發環境）
app.use(express.static(DIST_DIR));

// 對應 curl -k，忽略 HTTPS 憑證驗證
const httpsAgent = new Agent({
  connect: {
    rejectUnauthorized: false
  }
});

/**
 * machine_info 若是完整網址就直接使用，
 * 否則視為相對路徑，接在 machine_info_base 後面
 */
function resolveMachineInfoUrl(machineInfo, base) {
  if (!machineInfo || /^https?:\/\//i.test(machineInfo) || !base) {
    return machineInfo;
  }

  return `${base.replace(/\/+$/, '')}/${machineInfo.replace(/^\/+/, '')}`;
}

/**
 * 讀取 machines.json，取得所有要輪詢的機器
 * 回傳的 machine_info 已組成完整網址
 */
function loadMachines() {
  try {
    const fileContent = fs.readFileSync(MACHINES_FILE, 'utf8');
    const parsed = JSON.parse(fileContent);

    if (!Array.isArray(parsed.machines)) {
      return [];
    }

    const jumpHosts = parsed.jump_hosts || {};

    return parsed.machines.map((machine) => ({
      ...machine,
      machine_info: resolveMachineInfoUrl(machine.machine_info, parsed.machine_info_base),
      jump_config: machine.jump_host ? jumpHosts[machine.jump_host] : undefined
    }));
  } catch (error) {
    console.error('讀取 machines.json 失敗：', error.message);
    return [];
  }
}

/**
 * 將字串轉換成安全的檔名
 */
function sanitizeFilename(name) {
  return name.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 歷史紀錄檔名使用 machine_type（唯一且固定），修改 name 不會影響歷史紀錄
 *
 * 舊版以 name 當檔名，若只找到舊檔就改名成新檔名，沿用原本的紀錄
 */
function getHistoryFilePath(machine) {
  const historyFile = path.join(DATA_DIR, `${sanitizeFilename(machine.machine_type)}.json`);

  if (!fs.existsSync(historyFile) && machine.name) {
    const legacyFile = path.join(DATA_DIR, `${sanitizeFilename(machine.name)}.json`);

    if (legacyFile !== historyFile && fs.existsSync(legacyFile)) {
      try {
        fs.renameSync(legacyFile, historyFile);
        console.log(`歷史紀錄改名：${legacyFile} -> ${historyFile}`);
      } catch (error) {
        console.error(`歷史紀錄改名失敗（${legacyFile}）：`, error.message);
        return legacyFile;
      }
    }
  }

  return historyFile;
}

function getBmcUrl(bmcHost) {
  return `https://${bmcHost}/redfish/v1/UpdateService/FirmwareInventory?$expand=*($levels=1)`;
}

/**
 * 需要透過跳板機的機器（有設定 jump_host），
 * 先經 jump_host 建立 SSH tunnel，改連本機 127.0.0.1:<tunnel port>
 */
async function resolveBmcHost(machine, bmcIp) {
  if (!machine.jump_host) {
    return bmcIp;
  }

  if (!machine.jump_config) {
    throw new Error(`jump_hosts 找不到 ${machine.jump_host}`);
  }

  const localPort = await sshManager.getTunnelPort(machine.jump_host, machine.jump_config, bmcIp, 443);
  return `127.0.0.1:${localPort}`;
}

/**
 * 讀取 machine_info（bmc_data.json），取得目前的 bmc_ip
 * IP 不是固定的，所以每次輪詢都重新讀取
 */
async function fetchBmcIp(machine) {
  // network: RD 的機器是固定 IP，直接使用 machines.json 的 ip
  if (machine.network === 'RD') {
    if (!machine.ip) {
      throw new Error('network 為 RD 但 machines.json 未設定 ip');
    }

    return machine.ip;
  }

  if (!machine.machine_info) {
    throw new Error('machines.json 未設定 machine_info');
  }

  // 加上 t=timestamp 避免拿到快取的舊資料
  const infoUrl = new URL(machine.machine_info);
  infoUrl.searchParams.set('t', Date.now());

  const response = await fetch(infoUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    },
    dispatcher: httpsAgent,
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error(`machine_info 回傳 HTTP ${response.status}`);
  }

  const info = await response.json();
  const bmcIp = typeof info.bmc_ip === 'string' ? info.bmc_ip.trim() : '';

  if (!bmcIp) {
    throw new Error('machine_info 沒有 bmc_ip');
  }

  return bmcIp;
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
 * 依 timestamp 由新到舊排序歷史紀錄
 */
function sortHistoryByTimestampDesc(history) {
  return [...history].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );
}

/**
 * 取資料的 API 回傳的 modules 維持 Id/Type/Version/Description 四個欄位，
 * 存檔本身仍是整包資料
 */
function toSummaryModules(modules) {
  return (modules || []).map((item) => ({
    Id: item.Id || null,
    Type: item.Type || null,
    Version: item.Version || null,
    Description: item.Description || null
  }));
}

function toSummaryHistory(history) {
  return history.map((record) => ({
    ...record,
    modules: toSummaryModules(record.modules)
  }));
}

/**
 * 把物件裡含特殊符號的 key（如 @odata.id、@odata.type、XXX@odata.count）
 * 改成合法的 key 名稱，遞迴處理巢狀物件與陣列
 *
 * @odata.id / @odata.type 一律覆蓋掉同層原本的 Id / Type，不受欄位順序影響
 */
function sanitizeKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeKeys(item));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const result = {};
  const overrides = {};

  for (const [key, val] of Object.entries(value)) {
    const sanitizedVal = sanitizeKeys(val);

    if (key === '@odata.id') {
      overrides.Id = sanitizedVal;
      continue;
    }

    if (key === '@odata.type') {
      overrides.Type = sanitizedVal;
      continue;
    }

    const countMatch = key.match(/^(.+)@odata\.count$/);
    if (countMatch) {
      result[`${countMatch[1]}Count`] = sanitizedVal;
      continue;
    }

    result[key] = sanitizedVal;
  }

  return { ...result, ...overrides };
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
  const historyFile = getHistoryFilePath(machine);

  try {
    const bmcIp = await fetchBmcIp(machine);
    const bmcUrl = getBmcUrl(await resolveBmcHost(machine, bmcIp));

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

    // 整筆存下來，只清洗 key（不篩選欄位）
    const firmwareList = (data.Members || []).map((item) => sanitizeKeys(item));

    /**
     * API 成功，但沒有 Members 或 Members 是空陣列
     */
    if (firmwareList.length === 0) {
      console.log(`[${machine.name}] Firmware API 回傳空資料，不記錄`);
      return;
    }

    // 只使用 Id 和 Version 判斷版本是否變更
    const currentFirmwareVersions = normalizeFirmwareVersions(firmwareList);
    const previousList = previousFirmwareVersions.get(machine.machine_type) || [];

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
    console.table(firmwareList.map(({ Id, Description }) => ({ Id, Description })));

    // 寫入完整 Firmware 模組資訊
    writeHistoryRecord(historyFile, {
      machine: machine.name,
      ip: bmcIp,
      status: 'UPDATED',
      modules: firmwareList
    });

    /**
     * 只有成功取得並寫入更新資料後，
     * 才更新前一次版本
     */
    previousFirmwareVersions.set(machine.machine_type, currentFirmwareVersions);

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
 * /api/machines:
 *   get:
 *     summary: 查看 machines.json 內容
 *     responses:
 *       200:
 *         description: machines.json 的完整內容
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/api/machines', (req, res) => {
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
 * /api/machines/ip:
 *   get:
 *     summary: 查看每台機器目前的 BMC IP（即時讀取 machine_info 的 bmc_ip）
 *     responses:
 *       200:
 *         description: 每台機器的 name、machine_type、ip；讀取失敗時 ip 為 null 並附上 error
 */
app.get('/api/machines/ip', async (req, res) => {
  const machines = loadMachines();

  const result = await Promise.all(machines.map(async (machine) => {
    try {
      return {
        name: machine.name,
        machine_type: machine.machine_type,
        ip: await fetchBmcIp(machine)
      };
    } catch (error) {
      return {
        name: machine.name,
        machine_type: machine.machine_type,
        ip: null,
        error: error.message
      };
    }
  }));

  res.json(result);
});

/**
 * @openapi
 * /api/metadata:
 *   get:
 *     summary: 查看 metadata.json 內容
 *     responses:
 *       200:
 *         description: metadata.json 的完整內容
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/api/metadata', (req, res) => {
  try {
    const fileContent = fs.readFileSync(METADATA_FILE, 'utf8');
    res.json(JSON.parse(fileContent));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @openapi
 * /api/history:
 *   get:
 *     summary: 查看所有機器目前儲存的歷史紀錄
 *     responses:
 *       200:
 *         description: 以機器名稱為 key 的歷史紀錄物件
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/api/history', (req, res) => {
  try {
    const machines = loadMachines();
    const result = {};

    for (const machine of machines) {
      result[machine.name] = toSummaryHistory(
        sortHistoryByTimestampDesc(readHistory(getHistoryFilePath(machine)))
      );
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
 * /api/history/{machine_type}:
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
app.get('/api/history/:machine_type', (req, res) => {
  try {
    const machines = loadMachines();
    const machine = machines.find((m) => m.machine_type === req.params.machine_type);

    if (!machine) {
      return res.status(404).json({
        error: `找不到機器：${req.params.machine_type}`
      });
    }

    res.json(toSummaryHistory(
      sortHistoryByTimestampDesc(readHistory(getHistoryFilePath(machine)))
    ));
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @openapi
 * /api/poll:
 *   get:
 *     summary: 手動觸發一次所有機器的 Firmware 輪詢
 *     responses:
 *       200:
 *         description: 輪詢完成
 *       409:
 *         description: 目前已有輪詢正在執行
 */
app.get('/api/poll', async (req, res) => {
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
 * @openapi
 * /api/scripts:
 *   get:
 *     summary: 列出 scripts/ 資料夾內可執行的 script
 *     responses:
 *       200:
 *         description: script 檔名陣列
 *       500:
 *         description: 伺服器錯誤
 */
app.get('/api/scripts', (req, res) => {
  try {
    res.json(scriptRunner.listScripts());
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * @openapi
 * /api/scripts/{name}:
 *   post:
 *     summary: 執行 scripts/ 資料夾內的 script，等執行結束後回傳結果
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: script 檔名（例如 hello.sh）
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               args:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["world"]
 *     responses:
 *       200:
 *         description: 執行結果（exit_code、timed_out、duration_ms、stdout、stderr），exit code 非 0 也回 200
 *       400:
 *         description: args 格式錯誤
 *       404:
 *         description: 找不到 script
 *       409:
 *         description: 該 script 正在執行中
 *       500:
 *         description: 伺服器錯誤
 */
app.post('/api/scripts/:name', async (req, res) => {
  const args = req.body?.args ?? [];

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return res.status(400).json({
      error: 'args 必須是字串陣列'
    });
  }

  try {
    const pending = scriptRunner.runScript(req.params.name, args);

    if (!pending) {
      return res.status(404).json({
        error: `找不到 script：${req.params.name}`
      });
    }

    res.json(await pending);
  } catch (error) {
    res.status(error.code === 'BUSY' ? 409 : 500).json({
      error: error.message
    });
  }
});

/**
 * SPA fallback：非 API、非靜態檔案的 GET 請求一律回傳 dist/index.html，
 * 讓 Vue Router（history mode）可以處理前端路由
 */
app.get(/^\/(?!api|api-docs).*/, (req, res, next) => {
  if (!fs.existsSync(DIST_INDEX_FILE)) {
    return next();
  }

  res.sendFile(DIST_INDEX_FILE);
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

if (fs.existsSync(TLS_CERT_FILE) && fs.existsSync(TLS_KEY_FILE)) {
  const tlsOptions = {
    cert: fs.readFileSync(TLS_CERT_FILE),
    key: fs.readFileSync(TLS_KEY_FILE)
  };

  https.createServer(tlsOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS server is running on port ${HTTPS_PORT}`);
  });
} else {
  console.log(`找不到憑證（${TLS_CERT_FILE}），略過 HTTPS`);
}
