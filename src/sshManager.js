const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTunnel } = require('tunnel-ssh');

/**
 * 管理經由跳板機（jump host）的 SSH tunnel
 *
 * 等同於 ssh -L 127.0.0.1:<隨機port>:<dstAddr>:<dstPort> <jump>
 * 同一個 jump + 目的地只會建立一條 tunnel，之後重複使用；
 * SSH 斷線時會從快取移除，下次呼叫再重新建立
 */

// key: `${jumpName}|${dstAddr}:${dstPort}`，value: Promise<{ server, client, localPort }>
const tunnels = new Map();

/**
 * 展開 ~ 開頭的路徑
 */
function expandHome(filePath) {
  if (!filePath) {
    return filePath;
  }

  return filePath.startsWith('~')
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
}

/**
 * 把 machines.json 裡的 jump_hosts 設定轉成 ssh2 的連線參數
 */
function toSshOptions(jumpConfig) {
  const options = {
    host: jumpConfig.host,
    port: jumpConfig.port || 22,
    username: jumpConfig.username,
    readyTimeout: 10000,
    keepaliveInterval: 15000
  };

  // Docker 內私鑰路徑與本機不同，可用 SSH_IDENTITY_FILE 覆蓋 machines.json 的設定
  const identityFile = process.env.SSH_IDENTITY_FILE || jumpConfig.identity_file;

  if (identityFile) {
    options.privateKey = fs.readFileSync(expandHome(identityFile));
  }

  if (jumpConfig.passphrase) {
    options.passphrase = jumpConfig.passphrase;
  }

  if (jumpConfig.password) {
    options.password = jumpConfig.password;
  }

  return options;
}

async function openTunnel(key, jumpConfig, dstAddr, dstPort) {
  const [server, client] = await createTunnel(
    { autoClose: false, reconnectOnError: false },
    // port 0：由系統分配本機可用的 port
    { host: '127.0.0.1', port: 0 },
    toSshOptions(jumpConfig),
    { dstAddr, dstPort }
  );

  const localPort = server.address().port;

  const cleanup = () => {
    tunnels.delete(key);
    server.close();
    client.end();
  };

  client.on('close', cleanup);
  client.on('error', (error) => {
    console.error(`[ssh ${key}] 連線錯誤：`, error.message);
    cleanup();
  });
  server.on('error', (error) => {
    console.error(`[ssh ${key}] tunnel server 錯誤：`, error.message);
    cleanup();
  });

  console.log(`[ssh ${key}] tunnel 建立：127.0.0.1:${localPort}`);

  return { server, client, localPort };
}

/**
 * 取得透過跳板機連到 dstAddr:dstPort 的本機 port
 *
 * @param {string} jumpName - jump_hosts 裡的名稱（例如 factory-jump）
 * @param {object} jumpConfig - jump_hosts[jumpName] 的設定
 * @returns {Promise<number>} 本機 127.0.0.1 上可連線的 port
 */
async function getTunnelPort(jumpName, jumpConfig, dstAddr, dstPort) {
  const key = `${jumpName}|${dstAddr}:${dstPort}`;

  if (!tunnels.has(key)) {
    const pending = openTunnel(key, jumpConfig, dstAddr, dstPort);
    tunnels.set(key, pending);

    // 建立失敗就移除，下次輪詢再重試
    pending.catch(() => tunnels.delete(key));
  }

  const { localPort } = await tunnels.get(key);
  return localPort;
}

/**
 * 關閉所有 tunnel（程式結束時呼叫）
 */
async function closeAll() {
  const entries = await Promise.allSettled(tunnels.values());

  for (const entry of entries) {
    if (entry.status === 'fulfilled') {
      entry.value.server.close();
      entry.value.client.end();
    }
  }

  tunnels.clear();
}

module.exports = {
  getTunnelPort,
  closeAll
};
