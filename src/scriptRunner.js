const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * 執行 scripts/ 資料夾內的 script（白名單）
 *
 * 只有放在 scripts/ 底下的檔案可以被執行，API 只能指定檔名與參數，
 * 不經過 shell（execFile），參數不會被當成指令解析
 */

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const SCRIPT_TIMEOUT = (Number(process.env.SCRIPT_TIMEOUT_SECONDS) || 60) * 1000;
const MAX_OUTPUT = 10 * 1024 * 1024;

// 依副檔名決定用哪個直譯器執行；其他副檔名直接執行（需有執行權限）
const INTERPRETERS = {
  '.sh': 'sh',
  '.js': process.execPath,
  '.py': 'python3'
};

// 同一支 script 同時間只允許執行一次
const running = new Set();

/**
 * 列出 scripts/ 內可執行的 script 名稱
 */
function listScripts() {
  try {
    return fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * 執行 script，等執行結束後回傳 exit code、stdout、stderr
 *
 * 找不到 script 回傳 null；同一支 script 正在執行時丟出 code 為 BUSY 的錯誤
 */
function runScript(name, args = []) {
  // 只接受 listScripts() 列出的檔名，避免 ../ 之類的路徑穿越
  if (!listScripts().includes(name)) {
    return null;
  }

  if (running.has(name)) {
    const error = new Error(`${name} 正在執行中`);
    error.code = 'BUSY';
    throw error;
  }

  const scriptPath = path.join(SCRIPTS_DIR, name);
  const interpreter = INTERPRETERS[path.extname(name).toLowerCase()];
  const file = interpreter || scriptPath;
  const fileArgs = interpreter ? [scriptPath, ...args] : args;

  running.add(name);
  const startedAt = Date.now();

  console.log(`[script ${name}] 開始執行，參數：${JSON.stringify(args)}`);

  return new Promise((resolve) => {
    execFile(file, fileArgs, {
      cwd: process.cwd(),
      timeout: SCRIPT_TIMEOUT,
      maxBuffer: MAX_OUTPUT
    }, (error, stdout, stderr) => {
      running.delete(name);

      const result = {
        script: name,
        args,
        exit_code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        timed_out: Boolean(error && error.killed && error.signal === 'SIGTERM'),
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr
      };

      // 非 exit code 造成的錯誤（例如找不到直譯器、沒有執行權限）
      if (error && result.exit_code === null && !result.timed_out) {
        result.error = error.message;
      }

      console.log(`[script ${name}] 結束，exit code：${result.exit_code}${result.timed_out ? '（逾時）' : ''}`);

      resolve(result);
    });
  });
}

module.exports = {
  listScripts,
  runScript
};
