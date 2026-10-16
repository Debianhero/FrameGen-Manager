

const { app, BrowserWindow, Menu, ipcMain, shell, dialog, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

const PRODUCT = 'FrameGen Manager';

const DEV = !app.isPackaged || process.env.FGM_DEV === '1';
const USE_GPU = !(process.argv.includes('--fgm-no-gpu') || process.env.FGM_NO_GPU === '1');
function blurAllowed() {
  if (process.env.FGM_NO_BLUR === '1') return false;
  if (process.env.FGM_FORCE_BLUR === '1') return true;
  try {
    const st = app.getGPUFeatureStatus();
    return !!(st && st.gpu_compositing === 'enabled');
  } catch (e) { return false; }
}
if (!USE_GPU) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-direct-composition');
  app.disableHardwareAcceleration();
}


const exeDir = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..', '..', '..', 'test-tauri');

const INSTALLED_MARKER = path.join(exeDir, 'installed.txt');
const isInstalled = fs.existsSync(INSTALLED_MARKER);
const appDataRoot = path.join(app.getPath('appData'), 'FrameGen-Manager');

let dataDir = process.env.FGM_DATA_DIR;
if (!dataDir) dataDir = isInstalled ? appDataRoot : exeDir;

function migrateDataIfNeeded() {
  if (!isInstalled || dataDir === exeDir) return;
  const items = ['framegen-manager.json', 'game_library.json', 'tips.md', 'assets', 'backups', 'logs'];
  const srcHasData = items.some(function (n) { return fs.existsSync(path.join(exeDir, n)); });
  const dstHasData = fs.existsSync(path.join(dataDir, 'framegen-manager.json'));
  if (!srcHasData || dstHasData) return;
  fs.mkdirSync(dataDir, { recursive: true });
  const copied = [];
  for (const n of items) {
    const s = path.join(exeDir, n), t = path.join(dataDir, n);
    if (!fs.existsSync(s) || fs.existsSync(t)) continue;
    try {
      fs.cpSync(s, t, { recursive: true, errorOnExist: false });
      copied.push(n);
    } catch (e) {
      console.error('[migrate] 复制失败 ' + n + ': ' + e.message);
    }
  }
  for (const n of copied) {
    try { fs.rmSync(path.join(exeDir, n), { recursive: true, force: true }); } catch (e) {  }
  }
  if (copied.length) console.log('[migrate] 数据已搬到 ' + dataDir + '：' + copied.join('、'));
}

const SIDECAR = (function () {
  const named = path.join(exeDir, 'FrameGen Manager Sidecar.exe');
  if (fs.existsSync(named)) return named;
  const legacy = path.join(exeDir, 'framegen-sidecar.exe');
  return fs.existsSync(legacy) ? legacy : named;
})();

const SHELL_LOG_MAX = 512 * 1024;
function shellLog(msg) {
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'shell.log');
    try {
      if (fs.statSync(file).size > SHELL_LOG_MAX) fs.renameSync(file, path.join(dir, 'shell.prev.log'));
    } catch (e) {  }
    const t = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(file, '[' + t + '] ' + msg + '\n');
  } catch (e) {  }
}

let sidecar = null;
let sidecarDead = false;
let sidecarStarting = null;
let nextId = 1;
const pending = new Map();
let selfUpdateBusy = false;
let mainWin = null;
let quitting = false;

function startSidecar() {
  if (sidecar && !sidecarDead) return sidecar;
  if (!fs.existsSync(SIDECAR)) {
    sidecarDead = true;
    shellLog('找不到后台进程：' + SIDECAR);
    dialog.showErrorBox(PRODUCT, '找不到后台进程：' + SIDECAR +
      '\n\n安装包不完整或被安全软件删掉了，请重新安装本程序。');
    return null;
  }
  sidecarDead = false;
  const p = spawn(SIDECAR, [], {
    cwd: exeDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env, { FGM_DATA_DIR: dataDir }),
  });
  shellLog('启动后台进程：' + SIDECAR);

  const rl = readline.createInterface({ input: p.stdout });
  rl.on('line', onSidecarLine);
  p.stderr.on('data', function (d) {
    const text = String(d).replace(/\s+$/, '');
    console.error('[sidecar]', text);
    shellLog('[stderr] ' + text);
  });
  p.on('error', function (e) {
    sidecarDead = true;
    shellLog('后台进程启动失败：' + e.message);
    for (const [, q] of pending) { clearTimeout(q.timer); q.reject(new Error('后台进程启动失败：' + e.message)); }
    pending.clear();
  });
  p.on('exit', function (code, signal) {
    sidecarDead = true;
    shellLog('后台进程退出：code=' + code + ' signal=' + (signal || '-') +
      (quitting ? '（程序正在退出，正常）' : ''));
    if (quitting) {
      for (const [, q] of pending) { clearTimeout(q.timer); q.reject(new Error('程序正在退出')); }
      pending.clear();
      return;
    }
    const waiting = Array.from(pending.values());
    pending.clear();
    if (!waiting.length) return;
    ensureSidecar().then(function () {
      waiting.forEach(function (q) { if (q.retry) q.retry(); else q.reject(new Error('后台进程已退出（code ' + code + '）')); });
    }, function (e) {
      waiting.forEach(function (q) { clearTimeout(q.timer); q.reject(new Error('后台进程已退出（code ' + code + '）：' + e.message)); });
    });
  });
  return p;
}

function ensureSidecar() {
  if (sidecar && !sidecarDead) return Promise.resolve();
  if (sidecarStarting) return sidecarStarting;
  sidecarStarting = new Promise(function (resolve, reject) {
    sidecar = startSidecar();
    if (!sidecar) { reject(new Error('找不到后台进程：' + SIDECAR)); return; }
    const id = nextId++;
    const timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error('后台进程拉起后没有应答（5 秒超时）'));
    }, 5000);
    pending.set(id, { resolve: function () { resolve(); }, reject: function (e) { reject(e); }, timer: timer });
    try {
      sidecar.stdin.write(JSON.stringify({ id: id, cmd: 'ping', args: {} }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  }).then(function (v) { sidecarStarting = null; return v; }, function (e) { sidecarStarting = null; throw e; });
  return sidecarStarting;
}

function onSidecarLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.event === 'progress') {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(selfUpdateBusy ? 'fgm:event:selfupdate' : 'fgm:event:progress', msg.payload || {});
    }
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || '命令失败'));
}

const CALL_TIMEOUT_MS = 30 * 60 * 1000;

// 后台进程崩掉后**只自动重试只读命令**：查询重发一遍没有副作用；
// 部署 / 还原 / 清理这类写命令重放不可控（上次做到一半），让用户自己再点一次才稳妥。
const RETRYABLE = new Set([
  'ping', 'gpu_info', 'covers', 'game_icons', 'fetch_covers', 'assets_status',
  'dlss5_assets', 'dlss5_choices', 'dlss5_detect', 'get_config', 'gpu_spoof_state',
  'backups_info', 'log_tail', 'list_games', 'list_exes', 'sm_info', 'sm_game_states',
  'check_self_update', 'proxy_advice',
]);

function callSidecar(cmd, args, isRetry) {
  return new Promise(function (resolve, reject) {
    if (!sidecar || sidecarDead) {
      ensureSidecar().then(function () {
        callSidecar(cmd, args, true).then(resolve, reject);
      }, function (e) {
        reject(e);
      });
      return;
    }
    const id = nextId++;
    const timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error('命令超时：' + cmd));
    }, CALL_TIMEOUT_MS);
    pending.set(id, {
      resolve: resolve,
      reject: reject,
      timer: timer,
      retry: RETRYABLE.has(cmd) ? function () { callSidecar(cmd, args, true).then(resolve, reject); } : null,
    });
    try {
      sidecar.stdin.write(JSON.stringify({ id: id, cmd: cmd, args: args || {} }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      if (!isRetry) {
        callSidecar(cmd, args, true).then(resolve, reject);
      } else {
        shellLog('写入后台进程失败（' + cmd + '）：' + e.message);
        reject(new Error('后台进程写入失败：' + e.message));
      }
    }
  });
}


function lowerProcessPriority() {
  try {
    const os = require('node:os');
    const pids = [process.pid];
    try {
      for (const m of app.getAppMetrics()) { if (m.pid && pids.indexOf(m.pid) < 0) pids.push(m.pid); }
    } catch (e) {  }
    let ok = 0;
    for (const pid of pids) {
      try { os.setPriority(pid, os.constants.priority.PRIORITY_NORMAL); ok++; } catch (e) {}
    }
    console.log('[prio] 已把 ' + ok + '/' + pids.length + ' 个进程设为低优先级');
    callSidecar('set_efficiency', { pids: pids }).then(function (r) {
      console.log('[eco] 效率模式已设置 ' + ((r && r.ok) || 0) + '/' + ((r && r.total) || 0));
    }).catch(function (e) { console.error('[eco] 设置失败：' + e.message); });
    return ok;
  } catch (e) { return 0; }
}

function dropLegacySidecarName() {
  try {
    const old = path.join(exeDir, 'framegen-sidecar.exe');
    if (fs.existsSync(old) && old !== SIDECAR) {
      fs.rmSync(old, { force: true });
      console.log('[cleanup] 已删除旧版后台进程名 framegen-sidecar.exe');
    }
  } catch (e) {  }
}

function dropLegacyDocs() {
  for (const n of ['使用说明.txt']) {
    try {
      const p = path.join(exeDir, n);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        fs.rmSync(p, { force: true });
        console.log('[cleanup] 已删除旧版遗留的 ' + n);
      }
    } catch (e) {  }
  }
}

function ensureBundledAssets() {
  const src = path.join(exeDir, 'bundled-assets');
  if (!fs.existsSync(src)) return Promise.resolve({ copied: 0, reason: 'no-bundle' });
  const marker = path.join(dataDir, 'bundled-assets.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) {  }
  return callSidecar('assets_status').then(function (st) {
    const dst = (st && st.dir) || path.join(dataDir, 'assets');
    try { fs.mkdirSync(dst, { recursive: true }); } catch (e) {}
    let copied = 0;
    const names = [];
    const removedLegacy = [];
    const skipMarker = prev && prev.version === app.getVersion();
    const copyTree = (srcDir, dstDir, relPrefix) => {
      try { fs.mkdirSync(dstDir, { recursive: true }); } catch (e) {}
      for (const f of fs.readdirSync(srcDir)) {
        const s = path.join(srcDir, f);
        const t = path.join(dstDir, f);
        const rel = relPrefix ? relPrefix + '/' + f : f;
        try {
          const st = fs.statSync(s);
          if (st.isDirectory()) {
            copyTree(s, t, rel);
            continue;
          }
          if (!st.isFile()) continue;
          if (skipMarker) {
            let ok = false;
            try { ok = fs.statSync(t).size === st.size; } catch (e) { ok = false; }
            if (ok) continue;
          }
          fs.copyFileSync(s, t);
          copied++; names.push(rel);
        } catch (e) { console.error('[bundled] 复制失败', rel, e.message); }
      }
    };
    copyTree(src, dst, '');

    for (const legacy of ['nvngx_dlssg.dll', 'nvngx_dlss.dll']) {
      try {
        const old = path.join(dst, legacy);
        if (fs.existsSync(old) && fs.statSync(old).isFile()) {
          fs.rmSync(old, { force: true });
          removedLegacy.push(legacy);
        }
      } catch (e) {  }
    }
    const smsrc = path.join(exeDir, 'bundled-sm');
    if (fs.existsSync(smsrc)) {
      const smdst = path.join(dst, 'bundled-sm');
      try { fs.mkdirSync(smdst, { recursive: true }); } catch (e) {}
      for (const f of fs.readdirSync(smsrc)) {
        const s = path.join(smsrc, f);
        const t = path.join(smdst, f);
        try {
          const st = fs.statSync(s);
          if (!st.isFile()) continue;
          if (skipMarker) {
            let ok = false;
            try { ok = fs.statSync(t).size === st.size; } catch (e) { ok = false; }
            if (ok) continue;
          }
          fs.copyFileSync(s, t);
          copied++; names.push('bundled-sm/' + f);
        } catch (e) { console.error('[bundled] 复制失败', f, e.message); }
      }
    }

    const d5src = path.join(exeDir, 'bundled-dlss5');
    if (fs.existsSync(d5src)) {
      const d5dst = path.join(dst, 'DLSS5');
      try { fs.mkdirSync(d5dst, { recursive: true }); } catch (e) {}
      for (const f of fs.readdirSync(d5src)) {
        const s = path.join(d5src, f);
        const t = path.join(d5dst, f);
        try {
          const st = fs.statSync(s);
          if (!st.isFile()) continue;
          if (skipMarker) {
            let ok = false;
            try { ok = fs.statSync(t).size === st.size; } catch (e) { ok = false; }
            if (ok) continue;
          }
          fs.copyFileSync(s, t);
          copied++; names.push('DLSS5/' + f);
        } catch (e) { console.error('[bundled] DLSS5 复制失败', f, e.message); }
      }
    }
    try {
      fs.writeFileSync(marker, JSON.stringify({ version: app.getVersion(), copied: copied, files: names, at: Date.now() }, null, 2), 'utf8');
    } catch (e) {}
    console.log('[bundled] 铺了 ' + copied + ' 个内置文件 -> ' + dst);
    if (removedLegacy.length) {
      console.log('[bundled] 已清掉资产目录里的旧运行库：' + removedLegacy.join('、'));
    }
    return { copied: copied, files: names, dir: dst, removedLegacy: removedLegacy };
  }).catch(function (e) {
    console.error('[bundled] 跳过：', e.message);
    return { copied: 0, reason: e.message };
  });
}


const UPDATE_FROM = (function () {
  if (!DEV) return null;
  const i = process.argv.indexOf('--fgm-update-from');
  if (i < 0 || !process.argv[i + 1]) return null;
  return process.argv[i + 1].replace(/^"|"$/g, '');
})();
const UPDATE_YES = DEV && process.argv.includes('--fgm-update-yes');
const SIMULATE_UPDATE = DEV && process.argv.includes('--fgm-simulate-update');
const THEME = (function () {
  if (process.argv.includes('--fgm-dark')) return 'dark';
  if (process.argv.includes('--fgm-light')) return 'light';
  return null;
})();
if (THEME) nativeTheme.themeSource = THEME;
function currentTheme() {
  return THEME || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

const FAKE_GPU = (function () {
  if (!DEV) return '';
  const i = process.argv.indexOf('--fgm-fake-gpu');
  if (i < 0 || !process.argv[i + 1]) return '';
  return process.argv[i + 1].replace(/^"|"$/g, '');
})();

function runInstaller(installer) {
  let child;
  try {
    child = spawn(installer, [], { detached: true, stdio: 'ignore' });
  } catch (e) {
    dialog.showErrorBox(PRODUCT, '启动安装程序失败：' + e.message + '\n\n可以到发布页手动下载。');
    return;
  }
  child.on('error', function (e) {
    dialog.showErrorBox(PRODUCT, '启动安装程序失败：' + e.message + '\n\n可以到发布页手动下载。');
  });
  child.unref();
  console.log('[self-update] 已启动安装程序：' + installer);
  shellLog('自更新：启动安装程序 ' + installer);
  setTimeout(function () { app.quit(); }, 1500);
}

async function offerSelfUpdate(info) {
  const version = info.latest;
  let proceed = UPDATE_YES || SIMULATE_UPDATE || !!(info && info.simulate);
  if (!proceed && !UPDATE_FROM) {
    const r = await dialog.showMessageBox(mainWin, {
      type: 'question',
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: '发现新版本 v' + version + '（当前 v' + info.current + '）。',
      detail: '现在下载并安装吗？\n\n安装过程会关闭本程序，装完会自动重新打开。',
      noLink: true,
    });
    proceed = r.response === 0;
  }
  if (!proceed) return;

  if (SIMULATE_UPDATE) {
    const send = function (payload) { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('fgm:event:selfupdate', payload); };
    send({ phase: 'start' });
    let f = 0;
    const timer = setInterval(function () {
      f += 0.02;
      send({ fraction: Math.min(f, 1), msg: '（模拟）正在下载新版本… ' + Math.round(Math.min(f, 1) * 100) + '%' });
      if (f >= 1) { clearInterval(timer); send({ phase: 'done' }); }
    }, 250);
    return;
  }
  let installer = UPDATE_FROM;
  if (!installer) {
    selfUpdateBusy = true;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('fgm:event:selfupdate', { phase: 'start' });
    try {
      const r = await callSidecar('self_update_download', { version: version });
      if (r && r.canceled) {
        if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('fgm:event:selfupdate', { phase: 'canceled' });
        return;
      }
      installer = r && r.installer;
    } catch (e) {
      selfUpdateBusy = false;
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('fgm:event:selfupdate', { phase: 'error' });
      dialog.showErrorBox(PRODUCT, '下载新版本失败：' + e.message +
        '\n\n可以到发布页手动下载安装包。');
      return;
    }
    selfUpdateBusy = false;
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('fgm:event:selfupdate', { phase: 'done' });
  }
  if (!installer) {
    dialog.showErrorBox(PRODUCT, '没有拿到安装包路径，已取消。');
    return;
  }
  runInstaller(installer);
}

const PICKERS = {
  add_game: {
    title: '选择游戏目录（渲染 EXE 所在的那一层，或它的上层）',
    properties: ['openDirectory'],
    next: 'add_game_at', key: 'dir',
  },
  pick_game_exe: {
    title: '选择游戏的启动 exe（渲染 EXE 本体）',
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }],
    next: 'pick_game_exe_at', key: 'exe',
  },
  pick_assets_dir: {
    title: '选择资产目录（存放代理 DLL 与配置）',
    properties: ['openDirectory'],
    next: 'pick_assets_dir_at', key: 'dir',
  },
};

async function pickFileThenCall(spec) {
  const opt = { title: spec.title, properties: spec.properties };
  if (spec.filters) opt.filters = spec.filters;
  if (mainWin && !mainWin.isDestroyed()) opt.defaultPath = app.getPath('home');
  const r = await dialog.showOpenDialog(mainWin, opt);
  if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
  const payload = {};
  payload[spec.key] = r.filePaths[0];
  return callSidecar(spec.next, payload);
}


function createWindow() {
  Menu.setApplicationMenu(null);

  mainWin = new BrowserWindow({
    useContentSize: true,
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: PRODUCT + ' v' + app.getVersion(),
    backgroundColor: '#eef3fb',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWin.on('page-title-updated', function (e) { e.preventDefault(); });

  mainWin.once('ready-to-show', function () { mainWin.show(); });
  mainWin.webContents.on('did-finish-load', function () {
    if (SIMULATE_UPDATE) { setTimeout(function () { offerSelfUpdate({ latest: '9.9.9', current: app.getVersion(), simulate: true }); }, 1500); }
    if (blurAllowed()) {
      mainWin.webContents.executeJavaScript("document.body.classList.add('glass')").catch(function () {});
    }
  });
  const loadQuery = { theme: currentTheme() };
  if (FAKE_GPU) loadQuery.fakeGpu = FAKE_GPU;
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: loadQuery });

  mainWin.webContents.setWindowOpenHandler(function (info) {
    shell.openExternal(info.url);
    return { action: 'deny' };
  });

  mainWin.on('closed', function () { mainWin = null; });
}


if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.setAppUserModelId('com.framegen.manager');

  app.whenReady().then(function () {
    ipcMain.handle('fgm:invoke', function (_e, cmd, args) {
      if (PICKERS[cmd]) return pickFileThenCall(PICKERS[cmd]);
      return callSidecar(cmd, args).then(function (result) {
        if (cmd === 'check_self_update' && result && result.hasUpdate) {
          offerSelfUpdate(result);
        }
        return result;
      });
    });
    migrateDataIfNeeded();
    ensureSidecar().catch(function (e) { shellLog('启动后台进程失败：' + e.message); });
    dropLegacyDocs();
    dropLegacySidecarName();
ensureBundledAssets().then(function () {
      createWindow();
      lowerProcessPriority();
      [1000, 3000, 6000, 10000, 20000].forEach(function (ms) { setTimeout(lowerProcessPriority, ms); });
      setInterval(lowerProcessPriority, 30000);
      setTimeout(function () {
        callSidecar('check_self_update').then(function (r) {
          if (r && r.hasUpdate) offerSelfUpdate(r);
        }).catch(function (e) { console.log('[self-update] 启动检查失败（忽略）：' + e.message); });
      }, 6000);
    });
    if (UPDATE_FROM) {
      setTimeout(function () { offerSelfUpdate({ latest: '0.0.0-dev', current: app.getVersion() }); }, 3000);
    }
  });

  nativeTheme.on('updated', function () {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('fgm:event:theme', { theme: currentTheme() });
    }
  });

  app.on('window-all-closed', function () { app.quit(); });
  app.on('before-quit', function () {
    quitting = true;
    if (sidecar && !sidecarDead) {
      try { sidecar.stdin.end(); } catch (e) {  }
      try { sidecar.kill(); } catch (e) {  }
    }
  });
}
