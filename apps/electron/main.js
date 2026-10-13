/* FrameGen Manager —— Electron 主进程

   结构（和 Tauri 版一一对应）：
     - 渲染进程 = 原样的 ui/（HTML/CSS/JS），通过 preload 里的 window.__TAURI__ 桥发命令；
     - 命令真正执行在 **Rust sidecar 进程** 里（framegen-sidecar.exe），走 stdio 一行一个 JSON；
     - 本文件只负责：建窗口、把命令转发给 sidecar、把 progress 事件回推给界面。
   业务逻辑一行都不在这里 —— 全在 framegen-core。

   渲染默认走 GPU（Electron 的常规路径），`--fgm-no-gpu` 是给异常机器的退路：
   Tauri/WebView2 时代曾因 GPU 合成把客户区画黑而强制软件渲染，Electron 的合成器没有那个问题。
   玻璃观感见 style.css 末尾的 body.glass 一节。 */
const { app, BrowserWindow, Menu, ipcMain, shell, dialog, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

const PRODUCT = 'FrameGen Manager';

/* 开发/验证开关的总闸门。
   **发货版里必须关掉**：其中 --fgm-update-from 能跳过版本检查与哈希校验、直接启动任意
   安装包（配合 --fgm-update-yes 还是静默的）—— 等于一个"免校验安装任意程序"的后门，
   只要有人诱导用户用特殊参数启动就能装东西。开发模式（未打包）或显式设了 FGM_DEV=1 才认。
   两个例外保留给用户自救/验收：--fgm-no-gpu（驱动有问题时退回软件渲染）、
   --fgm-dark / --fgm-light（强制主题，用于排查深色模式问题）。 */
const DEV = !app.isPackaged || process.env.FGM_DEV === '1';
// 默认走 GPU 渲染（Electron 的常规路径）：合成本身更省（同机实测 43.4% vs 软件 46.6%），
// 而且只有 GPU 合成时才会开真玻璃。机器/驱动有问题的用户可以用 --fgm-no-gpu
//（或 FGM_NO_GPU=1）退回软件渲染 —— 那时玻璃自动关掉，外观退化成近似玻璃但不会坏。
const USE_GPU = !(process.argv.includes('--fgm-no-gpu') || process.env.FGM_NO_GPU === '1');
// 真·毛玻璃的开关：以「合成器是不是真的跑在 GPU 上」为准，而不是看命令行开关 ——
// 我们自己关掉 GPU 时，getGPUFeatureStatus().gpu_compositing 会是 disabled_software。
// 两个环境变量可以覆盖（A/B 实测、以及用户自救）：FGM_FORCE_BLUR=1 强开、FGM_NO_BLUR=1 强关。
function blurAllowed() {
  if (process.env.FGM_NO_BLUR === '1') return false;
  if (process.env.FGM_FORCE_BLUR === '1') return true;
  try {
    const st = app.getGPUFeatureStatus();
    return !!(st && st.gpu_compositing === 'enabled');
  } catch (e) { return false; }
}
if (!USE_GPU) {
  // 和 Tauri 版同一套取舍：软件渲染，避免 GPU 合成把客户区画黑
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-direct-composition');
  app.disableHardwareAcceleration();
}

/* ---------------------------------------------------------------- sidecar */

// 程序所在目录：打包后 = 安装目录；开发时 = 仓库根的 test-tauri（那里有真数据）
const exeDir = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.join(__dirname, '..', '..', '..', 'test-tauri');

// 数据放哪儿 —— 便携版和安装版**必须分开**：
//   * 便携版（zip 解压即用，没有 installed.txt 标记）→ 数据就在程序目录里，和以前一样；
//   * 安装版（安装器写了 installed.txt）→ %APPDATA%\FrameGen-Manager。
// 为什么：electron-builder 的卸载器最后一句是 RMDir /r $INSTDIR，而它的安装流程会
// **先跑旧版卸载器**（installSection.nsh 无条件调用 uninstallOldVersion）。数据留在
// 安装目录里的话，同一个安装包连装两次就会被删光（实测：配置+游戏库+95MB 资产全没）。
const INSTALLED_MARKER = path.join(exeDir, 'installed.txt');
const isInstalled = fs.existsSync(INSTALLED_MARKER);
const appDataRoot = path.join(app.getPath('appData'), 'FrameGen-Manager');

let dataDir = process.env.FGM_DATA_DIR;
if (!dataDir) dataDir = isInstalled ? appDataRoot : exeDir;

/** 安装版第一次启动：把老位置（程序目录）里的数据搬到 %APPDATA%。
    老用户在旧版里攒的设置/游戏库/资产都在程序目录，不能让他们"打开发现空了"。 */
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
  // 复制成功了才删旧的；失败的留着下次再试（新位置已经有数据，不会重复搬）
  for (const n of copied) {
    try { fs.rmSync(path.join(exeDir, n), { recursive: true, force: true }); } catch (e) { /* 留着无害 */ }
  }
  if (copied.length) console.log('[migrate] 数据已搬到 ' + dataDir + '：' + copied.join('、'));
}

const SIDECAR = path.join(exeDir, 'framegen-sidecar.exe');

/* ---------------------------------------------------------------- 诊断日志
   侧车（后台进程）出问题时，以前只有 console.error —— 用户看不到，我们也没法查
   （"后台进程没有起来"那条反馈就是这么卡住的）。现在把关键事件写进
   <数据目录>\logs\shell.log：启动、退出码、stderr 尾巴、重启、自更新动作。 */
const SHELL_LOG_MAX = 512 * 1024;
function shellLog(msg) {
  try {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'shell.log');
    try {
      if (fs.statSync(file).size > SHELL_LOG_MAX) fs.renameSync(file, path.join(dir, 'shell.prev.log'));
    } catch (e) { /* 文件不存在或换不动，继续往下写 */ }
    const t = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(file, '[' + t + '] ' + msg + '\n');
  } catch (e) { /* 日志写不进去不能让程序崩 */ }
}

let sidecar = null;
let sidecarDead = false;
let sidecarStarting = null;   // 正在拉起时的 Promise（并发调用共用同一次）
let nextId = 1;
const pending = new Map();      // id -> { resolve, reject, timer, retry }
let selfUpdateBusy = false;     // 自更新下载进行中（决定 progress 事件往哪条通道走）
let mainWin = null;
let quitting = false;           // 主动退出中：不再重启侧车

function startSidecar() {
  // 已经活着就别再拉一个（启动时的调用与早期命令的 ensureSidecar 可能撞车）
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
    // cwd 给安装目录（sidecar 自己在那儿）；数据目录用环境变量显式告诉它
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
  // spawn 失败是**异步**报的（路径不存在、被安全软件拦住……）。以前没接这个事件，
  // 结果是主进程抛未捕获异常、或者命令一直挂到 30 分钟超时。
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
    /* 还挂着的命令：先试着把侧车拉起来、把命令重发一次 —— 用户不该因为后台崩一下就
       看到满屏「读取失败」。重发也失败才报错。 */
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

/** 保证侧车可用：死了就重新拉起，并用一次 ping 确认它真的能应答。 */
function ensureSidecar() {
  if (sidecar && !sidecarDead) return Promise.resolve();
  if (sidecarStarting) return sidecarStarting;
  sidecarStarting = new Promise(function (resolve, reject) {
    sidecar = startSidecar();
    if (!sidecar) { reject(new Error('找不到后台进程：' + SIDECAR)); return; }
    // ping 确认（5 秒）
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
  try { msg = JSON.parse(line); } catch (e) { return; }   // 垃圾行直接忽略，不能崩
  if (msg.event === 'progress') {
    if (mainWin && !mainWin.isDestroyed()) {
      // 自更新下载期间走**独立**事件：界面把它画在更新弹窗里，而不是底部那条进度条
      // （用户要求：更新进度要在小弹窗里）。
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

// 下载/扫描这类命令可能要跑很久，超时给得宽松些（30 分钟）
const CALL_TIMEOUT_MS = 30 * 60 * 1000;

function callSidecar(cmd, args, isRetry) {
  return new Promise(function (resolve, reject) {
    if (!sidecar || sidecarDead) {
      // 就地重启一次再发（用户无感）。重启失败才把原因报出去。
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
      // 侧车中途死掉时用它重发一次（见 exit 处理）
      retry: function () { callSidecar(cmd, args, true).then(resolve, reject); },
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


/* ---------------------------------------------------------------- 进程优先级
   把这个软件的进程优先级压到「低」（任务管理器里就显示"低"）：它是后台辅助工具，
   不该和游戏抢 CPU。Electron 的主进程、渲染进程、GPU 进程、工具进程是分开的，
   所以从 app.getAppMetrics() 拿到全部 PID 逐个设。
   注意 Node 的 setPriority 在 Windows 上映射到进程优先级类，19（PRIORITY_LOW）= IDLE = 任务管理器的「低」。 */
function lowerProcessPriority() {
  try {
    const os = require('node:os');
    const pids = [process.pid];
    try {
      for (const m of app.getAppMetrics()) { if (m.pid && pids.indexOf(m.pid) < 0) pids.push(m.pid); }
    } catch (e) { /* 拿不到就只设自己 */ }
    let ok = 0;
    for (const pid of pids) {
      try { os.setPriority(pid, os.constants.priority.PRIORITY_LOW); ok++; } catch (e) {}
    }
    console.log('[prio] 已把 ' + ok + '/' + pids.length + ' 个进程设为低优先级');
    // 再让 sidecar 给这些进程打开 Windows「效率模式」（EcoQoS，一直开、不分前后台）
    callSidecar('set_efficiency', { pids: pids }).then(function (r) {
      console.log('[eco] 效率模式已设置 ' + ((r && r.ok) || 0) + '/' + ((r && r.total) || 0));
    }).catch(function (e) { console.error('[eco] 设置失败：' + e.message); });
    return ok;
  } catch (e) { return 0; }
}

/* ---------------------------------------------------------------- 清理旧版留下的说明文件
   安装目录里**不再放**「使用说明.txt」（用户要求删除）。但升级安装不会自动删掉旧版本的
   文件，所以每次启动顺手清一次 —— 放在主进程做是因为它是 UTF-8，文件名不会像 NSIS 脚本
   那样受当前代码页影响。使用说明以界面里的「使用说明」页 + README.md 为准。 */
function dropLegacyDocs() {
  for (const n of ['使用说明.txt']) {
    try {
      const p = path.join(exeDir, n);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        fs.rmSync(p, { force: true });
        console.log('[cleanup] 已删除旧版遗留的 ' + n);
      }
    } catch (e) { /* 删不掉就算了，不影响功能 */ }
  }
}

/* ---------------------------------------------------------------- 内置资产
   安装包里带了一份（INI + 默认代理 + 两个 DLSS 运行库，见 package.json 的 extraFiles）。
   规则：**装了/升级了就覆盖用户那份**，不管他的是不是最新 —— 这样装完就能直接部署，
   也不会因为残留的旧文件出怪问题。只覆盖我们内置的那几个文件名，用户导入的其它文件不动。
   每个版本只铺一次（bundled-assets.json 里记版本号），日常启动零开销。 */
function ensureBundledAssets() {
  const src = path.join(exeDir, 'bundled-assets');
  if (!fs.existsSync(src)) return Promise.resolve({ copied: 0, reason: 'no-bundle' });
  const marker = path.join(dataDir, 'bundled-assets.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { /* 第一次跑，没有正常 */ }
  // 想过就跳过是不够的：资产可能被清掉（实测遇到过 AppData\assets 变空）、被用户删、
  // 或者安装器搬数据时没搬全。所以每个版本除了看标记，还要**逐个校验文件是否真的在**，
  // 缺了就补回来 —— 这一条让"资产丢失"变成自愈，而不是要用户手动点下载。
  // 资产目录可能被用户改到别处，得问 sidecar（core 才知道）
  return callSidecar('assets_status').then(function (st) {
    const dst = (st && st.dir) || path.join(dataDir, 'assets');
    try { fs.mkdirSync(dst, { recursive: true }); } catch (e) {}
    let copied = 0;
    const names = [];
    const skipMarker = prev && prev.version === app.getVersion();
    for (const f of fs.readdirSync(src)) {
      const s = path.join(src, f);
      const t = path.join(dst, f);
      try {
        const st = fs.statSync(s);
        if (!st.isFile()) continue;
        if (skipMarker) {
          // 这个版本已经铺过：只在文件缺失或大小不符时才重铺（自愈）
          let ok = false;
          try { ok = fs.statSync(t).size === st.size; } catch (e) { ok = false; }
          if (ok) continue;
        }
        fs.copyFileSync(s, t);
        copied++; names.push(f);
      } catch (e) { console.error('[bundled] 复制失败', f, e.message); }
    }
    // Smooth Motion 的解锁组件（30 系）：放到 <资产目录>\bundled-sm\，
    // core 里按 assets_dir()/bundled-sm/version.dll 取用。
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

    // DLSS5 的文件（ReShade addon 插件 + ReShade 安装包 + 对应显卡系列的模型）
    // 单独放到 <资产目录>\DLSS5\（用户要求）：不和帧生成资产混在同一层，
    // 资产卡片只读资产目录这一层，所以也不会在卡片里冒出一个 158MB 的 dll。
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
    return { copied: copied, dir: dst };
  }).catch(function (e) {
    console.error('[bundled] 跳过：', e.message);
    return { copied: 0, reason: e.message };
  });
}

/* ---------------------------------------------------------------- 自更新 */

// 开发/验证用开关（正常用户用不到）：
//   --fgm-update-from <安装包路径>  跳过"检查+下载"，直接拿这个安装包走安装流程
//   --fgm-update-yes                跳过确认框（自动化验证用）
const UPDATE_FROM = (function () {
  if (!DEV) return null;                       // 发货版一律忽略（见上面 DEV 的说明）
  const i = process.argv.indexOf('--fgm-update-from');
  if (i < 0 || !process.argv[i + 1]) return null;
  // 命令行里带空格的路径常常连引号一起传进来，去掉两头引号再用
  return process.argv[i + 1].replace(/^"|"$/g, '');
})();
const UPDATE_YES = DEV && process.argv.includes('--fgm-update-yes');
// 模拟一次更新（验证界面用；不联网、不下载）：--fgm-simulate-update
const SIMULATE_UPDATE = DEV && process.argv.includes('--fgm-simulate-update');
/* 强制主题，用来验证深色模式：--fgm-dark / --fgm-light（不写就跟随系统）。
   为什么要这个开关：Windows 深色模式下才会暴露的问题（原生控件跟着系统走、个别颜色
   写死成深色）平时在浅色桌面上根本复现不出来，靠改系统主题来测太笨重。 */
const THEME = (function () {
  if (process.argv.includes('--fgm-dark')) return 'dark';
  if (process.argv.includes('--fgm-light')) return 'light';
  return null;
})();
if (THEME) nativeTheme.themeSource = THEME;
// 当前到底该用哪套皮肤：命令行强制 > 系统主题
function currentTheme() {
  return THEME || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

// 验证「启动时的显卡警告」用：--fgm-fake-gpu "Intel(R) UHD Graphics 630"
// 只把型号字符串透给页面（走 core 真实的分类逻辑），不碰任何真实检测。
const FAKE_GPU = (function () {
  if (!DEV) return '';                         // 只在开发模式下生效
  const i = process.argv.indexOf('--fgm-fake-gpu');
  if (i < 0 || !process.argv[i + 1]) return '';
  return process.argv[i + 1].replace(/^"|"$/g, '');
})();

/** 下载好的安装包 -> 交给系统安装 -> 退出自己。
    安装完由安装程序负责把新版拉起来（安装包里 runAfterFinish + customInstall 都做了）。 */
function runInstaller(installer) {
  let child;
  try {
    child = spawn(installer, [], { detached: true, stdio: 'ignore' });
  } catch (e) {
    dialog.showErrorBox(PRODUCT, '启动安装程序失败：' + e.message + '\n\n可以到发布页手动下载。');
    return;
  }
  // spawn 失败是**异步**报的（比如路径不存在），不接住的话会变成未捕获异常把主进程带走
  child.on('error', function (e) {
    dialog.showErrorBox(PRODUCT, '启动安装程序失败：' + e.message + '\n\n可以到发布页手动下载。');
  });
  child.unref();
  console.log('[self-update] 已启动安装程序：' + installer);
  shellLog('自更新：启动安装程序 ' + installer);
  // 安装程序会尝试关闭我们（electron-builder 的 CHECK_APP_RUNNING），我们主动退出更干净
  setTimeout(function () { app.quit(); }, 1500);
}

/** 检查更新发现新版之后的动作：原生确认 -> 下载（带进度）-> 安装 -> 退出。 */
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

  /* 模拟更新（验证界面用）：不发网络请求、不下载，只把「开始 → 进度 → 完成」这套事件跑一遍，
     让用户能看到弹窗和进度条长什么样。 --fgm-simulate-update */
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

/* ---------------------------------------------------------------- 文件选择框
   为什么不让 sidecar 自己弹（rfd）：sidecar 是**独立进程**、没有窗口，它弹出来的框
   没有 owner 窗口 —— Windows 会把这个框放到应用窗口**后面**，用户点了「手动添加游戏」
   只看到窗口没变化，以为点了没反应。
   主进程的 dialog.showOpenDialog(mainWin, …) 带父窗口：一定是模态、一定压在最上层。
   选完把路径交给 sidecar 里对应的 *_at 命令（业务逻辑仍在 core，界面调用名不变）。 */
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

/* ---------------------------------------------------------------- 窗口 */

function createWindow() {
  // Tauri 版**没有菜单栏**；Electron 默认会加 File/Edit/View… 不去掉的话观感立刻不一样
  Menu.setApplicationMenu(null);

  mainWin = new BrowserWindow({
    // useContentSize：宽高按**客户区**算，和 Tauri 的 window.width/height 语义一致。
    // 这样两条路的可视区域严格是 1220×820，截图可以逐像素对比。
    useContentSize: true,
    width: 1220,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: PRODUCT + ' v' + app.getVersion(),
    // 和页面底色一致：避免启动瞬间闪一下白（视觉上和 Tauri 版对齐）
    backgroundColor: '#eef3fb',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 软件渲染时关掉后台节流没意义，保持默认即可
    },
  });

  // 页面里的 <title>FrameGen Manager</title> 会覆盖窗口标题 —— 挡住它，
  // 让标题保持「FrameGen Manager v<版本>」（版本取自 package.json，见上面的 title）。
  mainWin.on('page-title-updated', function (e) { e.preventDefault(); });

  mainWin.once('ready-to-show', function () { mainWin.show(); });
  // 页面加载完再挂类：CSS 里的 body.glass 规则负责真模糊
  mainWin.webContents.on('did-finish-load', function () {
    // 模拟更新：等窗口真的加载完再触发，否则事件发给了一个还不存在的窗口
    if (SIMULATE_UPDATE) { setTimeout(function () { offerSelfUpdate({ latest: '9.9.9', current: app.getVersion(), simulate: true }); }, 1500); }
    if (blurAllowed()) {
      mainWin.webContents.executeJavaScript("document.body.classList.add('glass')").catch(function () {});
    }
  });
  // 主题跟着系统走：页面拿到参数后挂 <html data-theme>（样式表按属性选择深色变量）
  const loadQuery = { theme: currentTheme() };
  if (FAKE_GPU) loadQuery.fakeGpu = FAKE_GPU;
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: loadQuery });

  // 页面里的外链一律交给系统浏览器
  mainWin.webContents.setWindowOpenHandler(function (info) {
    shell.openExternal(info.url);
    return { action: 'deny' };
  });

  mainWin.on('closed', function () { mainWin = null; });
}

/* ---------------------------------------------------------------- 生命周期 */

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
      // 文件选择框交给主进程弹（见 PICKERS 的说明）
      if (PICKERS[cmd]) return pickFileThenCall(PICKERS[cmd]);
      return callSidecar(cmd, args).then(function (result) {
        // 自更新的「安装」这一半必须由外壳做（下载+校验在 sidecar 里，走 core）。
        // 界面保持不变：用原生确认框问一句，而不是在网页里加按钮。
        if (cmd === 'check_self_update' && result && result.hasUpdate) {
          offerSelfUpdate(result);
        }
        return result;
      });
    });
    migrateDataIfNeeded();
    // 幂等：万一前面已经因为别的调用拉起过，这里不会再开第二个
    ensureSidecar().catch(function (e) { shellLog('启动后台进程失败：' + e.message); });
    // 先把内置资产铺好再开窗口：首启要拷 ~92MB（1~2 秒），之后每个版本只做一次
    dropLegacyDocs();
ensureBundledAssets().then(function () {
      createWindow();
      // 窗口起来后（渲染/GPU 进程已存在）再压优先级；稍后再补一次，覆盖后起的进程
      lowerProcessPriority();
      setTimeout(lowerProcessPriority, 4000);
      /* 每次启动自动检查一次更新（用户要求）：延迟几秒让界面先起来，
         失败就静默忽略 —— 启动路径上不该因为网络问题弹任何东西。 */
      setTimeout(function () {
        callSidecar('check_self_update').then(function (r) {
          if (r && r.hasUpdate) offerSelfUpdate(r);
        }).catch(function (e) { console.log('[self-update] 启动检查失败（忽略）：' + e.message); });
      }, 6000);
    });
    if (UPDATE_FROM) {
      // 验证用：跳过检查与下载，直接走"安装并通过安装程序重启"这一段
      // 这里的版本号只是占位（UPDATE_FROM 会跳过检查与下载，走不到拼 URL 那一步），
      // 用一个明显不是真实版本的串，免得以后升级版本号时忘了改这里。
      setTimeout(function () { offerSelfUpdate({ latest: '0.0.0-dev', current: app.getVersion() }); }, 3000);
    }
  });

  // 用户在系统设置里切浅色/深色（或到点自动切换）时，实时告诉页面换皮肤
  nativeTheme.on('updated', function () {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('fgm:event:theme', { theme: currentTheme() });
    }
  });

  app.on('window-all-closed', function () { app.quit(); });
  app.on('before-quit', function () {
    quitting = true;                 // 主动退出：侧车退出不再触发"重启 + 重发"
    if (sidecar && !sidecarDead) {
      try { sidecar.stdin.end(); } catch (e) { /* 忽略 */ }
      try { sidecar.kill(); } catch (e) { /* 忽略 */ }
    }
  });
}
