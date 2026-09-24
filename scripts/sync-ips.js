/**
 * 定時掃描區網，依 MAC 位址更新 machines.json 內機器的 IP。
 *
 * 用法（在能直接連到這些機器的 Linux／macOS 主機上執行；需與機器在同一個 L2 網段，
 * 因為是靠 ARP 取得 MAC，跨路由器只會看到路由器的 MAC）：
 *   node scripts/sync-ips.js          # 常駐，啟動時掃一次，之後每小時掃一次
 *   node scripts/sync-ips.js --once   # 只掃一次就結束
 *
 * 環境變數：
 *   SYNC_INTERVAL_MINUTES  掃描間隔（分鐘），預設 60
 *   SYNC_SUBNETS           要掃描的網段（CIDR，逗號分隔）。未設定時，
 *                          自動使用本機網卡中，包含 machines.json 內任一 IP 的網段
 *
 * 流程：先驗證 machines.json 記錄的 IP，MAC 都對得上就結束；
 * 有對不上的才掃描整個網段，依 MAC 找出新 IP 並原地更新。
 * 找不到 MAC 的機器（可能關機）不會更動，只印警告。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const MACHINES_FILE = path.join(__dirname, '..', 'machines.json');
const INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_MINUTES) || 60) * 60 * 1000;
// Linux 核心的鄰居表（ARP）預設上限約 1024 筆，並發不能太高，避免 neighbour table overflow
const PROBE_CONCURRENCY = 50;
const SCAN_PROBE_TIMEOUT_MS = 1000;
const VERIFY_PROBE_TIMEOUT_MS = 5000; // 驗證既有 IP 時等久一點，讓過期的 ARP 快取有時間被重新確認
const MAX_HOSTS = 4096; // 網段上限，避免誤設 /8 掃到天荒地老

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// ---------- IP / 網段工具 ----------

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

function cidrRange(cidr) {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const size = 2 ** (32 - bits);
  const network = Math.floor(ipToInt(base) / size) * size;
  return { network, size };
}

function cidrContains(cidr, ip) {
  const { network, size } = cidrRange(cidr);
  const value = ipToInt(ip);
  return value >= network && value < network + size;
}

/** 列出網段內所有可用主機位址（排除網路位址與廣播位址） */
function hostsOf(cidr) {
  const { network, size } = cidrRange(cidr);
  if (size > MAX_HOSTS) {
    throw new Error(`網段 ${cidr} 太大（${size} 個位址，上限 ${MAX_HOSTS}）`);
  }
  const hosts = [];
  for (let i = 1; i < size - 1; i += 1) hosts.push(intToIp(network + i));
  return hosts;
}

function resolveSubnets(machines) {
  if (process.env.SYNC_SUBNETS) {
    return process.env.SYNC_SUBNETS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const subnets = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const addr of addresses) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (machines.some((m) => cidrContains(addr.cidr, m.ip))) {
        const { network } = cidrRange(addr.cidr);
        subnets.add(`${intToIp(network)}/${addr.cidr.split('/')[1]}`);
      }
    }
  }
  return [...subnets];
}

// ---------- 掃描 ----------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      resolve({ error, stdout });
    });
  });
}

/**
 * 對 ip 嘗試 TCP 連線，目的只是讓核心送出 ARP 請求；連得上、被拒絕、逾時都無所謂。
 * 純 Node 實作，不依賴 ping（容器或非 root 環境常沒有權限）。
 */
function probe(ip, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port: 80 });
    const done = () => {
      socket.destroy();
      resolve();
    };
    socket.setTimeout(timeoutMs, done);
    socket.once('connect', done);
    socket.once('error', done);
  });
}

async function probeAll(hosts, timeoutMs) {
  let index = 0;
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, hosts.length) }, async () => {
    while (index < hosts.length) {
      const host = hosts[index];
      index += 1;
      await probe(host, timeoutMs);
    }
  });
  await Promise.all(workers);
}

function normalizeMac(mac) {
  const parts = String(mac).trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, '0')).join(':');
}

function addArpEntry(table, mac, ip) {
  const normalized = normalizeMac(mac);
  if (!normalized || normalized === '00:00:00:00:00:00') return; // 未解析完成的項目
  if (!table.has(normalized)) table.set(normalized, []);
  table.get(normalized).push(ip);
}

/** 讀 ARP 表，回傳 Map<mac, ip[]> */
async function readArpTable() {
  const table = new Map();

  if (process.platform === 'linux') {
    // /proc/net/arp 欄位：IP address, HW type, Flags, HW address, Mask, Device
    // Flags 0x0 代表解析失敗（incomplete / failed），要排除
    const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const [ip, , flags, mac] = line.trim().split(/\s+/);
      if (!ip || !mac || Number.parseInt(flags, 16) === 0) continue;
      addArpEntry(table, mac, ip);
    }
    return table;
  }

  // macOS:  ? (10.33.33.6) at d4:d8:53:80:b5:a6 on en5 ...  （前導 0 會被省略）
  const { error, stdout } = await run('arp', ['-a', '-n']);
  if (error) throw new Error(`執行 arp -a 失敗：${error.message}`);
  for (const match of stdout.matchAll(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]+)/g)) {
    addArpEntry(table, match[2], match[1]);
  }
  return table;
}

// ---------- 更新 machines.json ----------

function loadMachinesFile() {
  const parsed = JSON.parse(fs.readFileSync(MACHINES_FILE, 'utf8'));
  if (!Array.isArray(parsed.machines)) throw new Error('machines.json 缺少 machines 陣列');
  return parsed;
}

async function syncOnce() {
  const data = loadMachinesFile();
  const targets = data.machines.filter((m) => m.mac);
  if (targets.length === 0) {
    log('machines.json 沒有任何機器設定 mac，略過');
    return;
  }

  const macOf = (machine) => normalizeMac(machine.mac);
  const isSettled = (arp, machine) => (arp.get(macOf(machine)) || []).includes(machine.ip);

  // 第一階段：只探測目前記錄的 IP，全部對得上就不用掃整個網段
  await probeAll(targets.map((m) => m.ip), VERIFY_PROBE_TIMEOUT_MS);
  let arp = await readArpTable();
  const valid = targets.filter((m) => macOf(m));
  for (const machine of targets) {
    if (!macOf(machine)) log(`[警告] ${machine.name}：mac「${machine.mac}」格式不正確，略過`);
  }

  if (!valid.every((m) => isSettled(arp, m))) {
    // 第二階段：掃描整個網段
    const subnets = resolveSubnets(data.machines);
    if (subnets.length === 0) {
      log('有機器 IP 對不上，但找不到包含機器 IP 的本機網段，請用 SYNC_SUBNETS 指定，略過');
    } else {
      const hosts = subnets.flatMap(hostsOf);
      log(`有機器 IP 對不上，掃描 ${subnets.join(', ')}（${hosts.length} 個位址）...`);
      await probeAll(hosts, SCAN_PROBE_TIMEOUT_MS);
      arp = await readArpTable();
    }
  }

  let changed = 0;
  for (const machine of valid) {
    const mac = macOf(machine);
    const ips = arp.get(mac) || [];
    if (ips.length === 0) {
      log(`[找不到] ${machine.name}（${mac}）：不更新，維持 ${machine.ip}`);
    } else if (ips.includes(machine.ip)) {
      log(`[未變動] ${machine.name}：${machine.ip}`);
    } else if (ips.length === 1) {
      log(`[更新] ${machine.name}：${machine.ip} -> ${ips[0]}`);
      machine.ip = ips[0];
      changed += 1;
    } else {
      log(`[警告] ${machine.name}：MAC 對到多個 IP（${ips.join(', ')}），無法判斷，不更新`);
    }
  }

  if (changed === 0) return;

  // 先確認序列化成功再寫檔。必須「原地覆寫」而不是 tmp + rename：
  // docker-compose 是把單一檔案 bind mount 進容器，rename 會換 inode，容器會一直讀到舊內容。
  const output = `${JSON.stringify(data, null, 4)}\n`;
  fs.writeFileSync(MACHINES_FILE, output);
  log(`已寫入 machines.json（${changed} 台 IP 變動）`);
}

async function safeSync() {
  try {
    await syncOnce();
  } catch (error) {
    log(`[錯誤] ${error.message}`);
  }
}

async function main() {
  await safeSync();
  if (process.argv.includes('--once')) return;

  log(`每 ${INTERVAL_MS / 60000} 分鐘掃描一次，Ctrl+C 結束`);
  setInterval(safeSync, INTERVAL_MS);
}

main();
