/* 设置页 + 关于页（P1-12 第 1 步）：从 app.js 原样搬出，函数名不变（只移动不重写）。
   依赖的全局：i18n.js 的 t；lib.js 的 $ / h / backText / errText / fmtSize；app.js 的
   invoke / toast / busy / showBar / hideBarLater / uiConfirm，以及状态 CFG / GPU / SELF /
   PROXIES / PROXY / UPD_NOTES（后两个是赋值：本文件里 loadConfig / checkSelfUpdate 会写它们）。
   加载顺序：i18n.js -> lib.js -> settings.js -> app.js */
var OPT_LABELS = [
  [0, t('0 · 原厂内核，不加速')],
  [1, t('1 · 加速，画面与官方逐位一致')],
  [2, t('2 · 更快，图像内核轻微有损（默认）')],
  [3, t('3 · 最快，全部有损')]
];
var FRAME_LABELS = [
  [2, t('3X')],
  [3, t('4X（出厂默认）')],
  [5, t('6X（要游戏自带的插件也支持）')]
];
var PRESET_LABELS = [
  ['A', 'A'],
  ['B', 'B'],
  ['C', t('C · FG Lite：开销更低，画质略低')]
];
function optLabelOf(v) {
  for (var i = 0; i < OPT_LABELS.length; i++) {
    if (String(OPT_LABELS[i][0]) === String(v)) return OPT_LABELS[i][1];
  }
  return String(v);
}
// 0.4.1 的帧生成内核是 CUDA 13 编译的 cubin：驱动低于 R580 会被拒绝，
// 且上游**不再回退 PTX**——部署能成功、游戏里却完全没效果。这里提前拦一道。
function fgDriverMajor() {
  // sidecar 已经给出主版本号（621.01 -> 621），优先用它，避免前端解析各种格式
  if (GPU) {
    if (typeof GPU.driverMajor === 'number') return GPU.driverMajor;
  }
  var d = '';
  if (GPU) { if (GPU.driver) d = String(GPU.driver); }
  var m = d.match(/^(\d{3})\./);
  if (m) return Number(m[1]);
  return null; // 形如 32.0.16.2101 的 WDDM 编号或未知 → 不判断，避免误拦
}
// 三态：ok / blocked（明确低于 R580）/ unknown（读不到版本）
function fgDriverState() {
  var v = fgDriverMajor();
  if (v === null) return 'unknown';
  if (v >= 580) return 'ok';
  return 'blocked';
}
function frmLabelOf(v) { var n = Number(v); if (n >= 5) return '6X'; if (n === 2) return '3X'; return '4X'; }
function presetLabelOf(v) {
  var want = String(v || (CFG && CFG.defaultPreset) || 'A');
  for (var i = 0; i < PRESET_LABELS.length; i++) {
    if (String(PRESET_LABELS[i][0]) === want) return PRESET_LABELS[i][1];
  }
  return want;
}
// 进阶部署开关（超分 / 引擎 / XeSS 附属键）的本地记忆：让部署弹窗和「旧版重部署」
// 的批量路径用同一套值。不进后端配置文件 —— 它们不是常用档位，先放前端。
function rememberDeployLevels(optimized, frames, preset) {
  var p = preset || '';
  if (CFG && CFG.optimized === optimized && CFG.frames === frames && (CFG.preset || '') === p) {
    return Promise.resolve();
  }
  return invoke('set_config', { optimized: optimized, frames: frames, preset: p })
    .then(function (c) { CFG = c; return c; })
    .catch(function (e) {
      console.warn(t('记住部署档位失败'), e);
    });
}
function paintSettings() {
  if (!CFG) return;
  if ($('ver-cur')) $('ver-cur').textContent = 'v' + CFG.version;
  if ($('p-assets')) $('p-assets').textContent = CFG.assetsDir || '-';
  if ($('p-backups')) $('p-backups').textContent = CFG.backupsDir || '-';
  if ($('p-logs')) $('p-logs').textContent = CFG.logsDir || '-';
}
function loadConfig() {
  return invoke('get_config').then(function (c) {
    CFG = c;
    if (c.proxies && c.proxies.length) {
      PROXIES = c.proxies.slice();
      if (PROXIES.indexOf(PROXY) < 0) PROXY = PROXIES[0];
    }
    paintSettings();
    return c;
  });
}
var SPOOF = null;
function loadSpoof() {
  return invoke('gpu_spoof_state').then(function (s) {
    SPOOF = s || null;
    var cur = $('spoof-cur'), drv = $('spoof-drv'), sel = $('spoof-sel');
    var apply = $('btn-spoof-apply'), restore = $('btn-spoof-restore'), note = $('spoof-note');
    if (!s || !s.available) {
      if (cur) cur.textContent = '-';
      if (drv) drv.textContent = '-';
      if (sel) sel.textContent = '';
      if (apply) apply.disabled = true;
      if (restore) restore.disabled = true;
      if (note) note.textContent = backText(s && s.reason) || t('读不到显卡信息。');
      return s;
    }
    if (cur) cur.textContent = s.current || t('(空)');
    if (drv) drv.textContent = s.driver || '-';
    if (sel) {
      sel.textContent = '';
      (s.presets || []).forEach(function (p) {
        sel.appendChild(h('option', { value: p, text: String(p).replace('NVIDIA GeForce ', '') }));
      });
    }
    if (apply) apply.disabled = false;
    if (restore) {
      restore.disabled = !s.spoofed;
      restore.title = s.spoofed ? t('写回驱动记录的名称，等于彻底去掉伪装') : t('当前没有被改过，不需要还原');
    }
    if (note) {
      note.textContent = (s.spoofed ? t('已伪装。') : '') +
        t('只改 HKLM\\') + (s.enumKey || '') + t('\\DeviceDesc 这一个值，改前会把原值备份到 ') +
        (s.backupPath || t('(备份目录)')) + t('。重启后生效，dxdiag / 设备管理器里的名字都会跟着变。');
    }
    return s;
  }).catch(function (e) {
    if ($('spoof-note')) $('spoof-note').textContent = t('读取显卡名称状态失败：') + errText(e);
    throw e;
  });
}
function spoofApply() {
  if (!SPOOF || !SPOOF.available) return;
  var sel = $('spoof-sel');
  var name = sel ? sel.value : '';
  var warns = (SPOOF.warnings || []).map(function (w) { return '· ' + w; }).join('\n');
  uiConfirm({
    title: t('确认修改显卡名称'),
    ok: t('我了解，改'),
    body: t('把显卡名改成：\n') + name +
      t('\n\n（当前显示：') + (SPOOF.current || t('(空)')) + t('，驱动记录：') + SPOOF.driver + t('）') +
      t('\n\n动手前请读完这些副作用：\n') + warns
  }).then(function (yes) {
    if (!yes) return;
    var btn = $('btn-spoof-apply');
    if (btn) btn.disabled = true;
    showBar(t('正在修改显卡名称（没权限时会弹一次 UAC）…'), 0.4);
    invoke('gpu_spoof_apply', { name: name }).then(function (r) {
      toast(((r && r.msg) || t('已修改')) + t('\n\n（重启后生效；不满意随时点「还原为原来的名称」）'), 'ok', 16000);
      return loadSpoof();
    }).catch(function (e) {
      toast(t('修改显卡名称失败：') + errText(e), 'err', 20000);
    }).then(function () {
      if (btn) btn.disabled = false;
      hideBarLater(1500);
    });
  });
}
function spoofRestore() {
  if (!SPOOF || !SPOOF.available) return;
  uiConfirm({
    title: t('确认还原显卡名称'),
    ok: t('开始还原'),
    body: t('把显卡名写回驱动记录的名称：\n') + SPOOF.driver +
      t('\n\n等于彻底去掉伪装，重启后生效。')
  }).then(function (yes) {
    if (!yes) return;
    var btn = $('btn-spoof-restore');
    if (btn) btn.disabled = true;
    showBar(t('正在还原显卡名称（没权限时会弹一次 UAC）…'), 0.4);
    invoke('gpu_spoof_restore', { to: 'driver' }).then(function (r) {
      toast((r && r.msg) || t('已还原'), 'ok', 16000);
      return loadSpoof();
    }).catch(function (e) {
      toast(t('还原显卡名称失败：') + errText(e), 'err', 20000);
    }).then(function () {
      if (btn) btn.disabled = false;
      hideBarLater(1500);
    });
  });
}
function refreshBackups() {
  return invoke('backups_info').then(function (r) {
    var n = (r && r.count) || 0;
    var el = $('bk-info');
    if (el) el.textContent = n ? (n + t(' 项 · ') + fmtSize((r && r.bytes) || 0)) : t('没有备份');
    var btn = $('btn-clean-backups');
    if (btn) btn.disabled = !n;
  }).catch(function () {
    var el = $('bk-info');
    if (el) el.textContent = t('读取失败');
  });
}
function renderLogEnv() {
  if (typeof diagEnv !== 'function') return;
  var e = diagEnv();
  var set = function (id, v) {
    var el = $(id), s = v || '-';
    if (el && el.textContent !== s) el.textContent = s;
  };
  set('log-ver', e.version);
  set('log-os', e.os);
  set('log-gpu', e.gpu);
  set('log-drv', e.drv || t('未知'));
  set('log-games', e.games + t(' 个游戏'));
  set('log-dir', e.logs);
}
function loadLog() {
  var box = $('log-box');
  if (!box) return Promise.resolve();
  // 用户往上翻旧日志时不要把他拽回底部；只在「原本就在底部」时自动跟随。
  var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  var prevTop = box.scrollTop;
  return invoke('log_tail', { lines: 300 }).then(function (text) {
    var next = text ? text : t('（日志是空的 —— 还没有操作过，或者日志目录不可写）');
    // 内容没变就不碰 DOM：空闲时不再每 10 秒重排一遍日志区
    if (box.textContent !== next) {
      box.textContent = next;
      if (atBottom) box.scrollTop = box.scrollHeight; else box.scrollTop = prevTop;
    }
    renderLogEnv();
  }).catch(function (e) {
    var msg = t('读取日志失败：') + errText(e);
    if (box.textContent !== msg) box.textContent = msg;
  });
}
function checkSelfUpdate() {
  busy($('btn-self-update'), t('检查中…'), function () {
    return invoke('check_self_update').then(function (r) {
      SELF = r;
      UPD_NOTES = (r && r.notes) || '';
      var el = $('ver-latest');
      if (el) {
        if (r.hasUpdate) {
          el.textContent = r.latest;
          el.className = 'warn';
        } else if (r.unpublished) {
          el.textContent = r.latest + t('（未发布）');
          el.className = 'ok';
        } else {
          el.textContent = r.latest || t('读不到');
          el.className = 'ok';
        }
      }
      if ($('self-note')) {
        $('self-note').textContent = r.hasUpdate
          ? (t('有新版本 ') + r.latest + t('（当前 v') + r.current + t('）—— 会弹窗问你是否现在下载安装。'))
          : (r.unpublished
              ? (t('已是最新（当前 v') + r.current + t('）。开发中的版本号 ') + r.latest +
                 t(' 已经写进代码，但安装包还没发布，所以不提示更新、也下载不到。'))
              : (t('已是最新（当前 v') + r.current + t('）。')));
      }
      var old = $('self-notes');
      if (old) old.parentNode.removeChild(old);
      if (r && r.hasUpdate && r.notes && $('self-note') && $('self-note').parentNode) {
        var pre = document.createElement('pre');
        pre.className = 'log logslim';
        pre.id = 'self-notes';
        pre.style.maxHeight = '220px';
        pre.textContent = r.notes;
        $('self-note').parentNode.appendChild(pre);
      }
      toast(
        r.hasUpdate
          ? (t('发现新版本：') + r.latest)
          : (r.unpublished
              ? (t('已是最新：v') + r.current + t('（') + r.latest + t(' 尚未发布）'))
              : (t('已是最新：v') + r.current)),
        r.hasUpdate ? 'info' : 'ok',
        9000
      );
    });
  });
}
/* 更新弹窗 + 日志实时刷新（P1-12 第 5 步）：从 app.js 搬到设置/关于这一块（同属「设置页」），
   函数名不变。依赖 app.js 的 invoke / toast / busy / showBar，lib.js 的 `$` / errText / fmtSize，
   以及 UPD_NOTES / SELF 等状态。 */
function startLogLive() {
  var tick = function () {
    if (document.hidden) return;
    // 只有日志页可见时才轮询：既省 I/O，也不会在别的页面后台改 DOM 造成滚动跳动
    var page = $('page-logs');
    if (page && page.classList.contains('hidden')) return;
    renderLogEnv();
    loadLog().catch(function () { });
  };
  tick();
  // 日志页才刷新，而且 10 秒一次：read 300 行本身很便宜，但没必要 2.5 秒打扰一次。
  setInterval(tick, 10000);
}
function bindUpdateDialog() {
  var box = $('upd'), stop = $('upd-stop');
  if (!box) return;
  // 下载窗口不在 .ov 那套弹层里，以前忘了 setOvOpen —— 它盖在界面上时背景一点没糊，
  // 和别的对话框（那种是糊的）明显不一致。这里补上；带计数保护，重复的 start 不会累加。
  var updOpen = false;
  function setUpdBlur(on) {
    if (on === updOpen) return;
    updOpen = on;
    setOvOpen(on);
  }
  var netdiskBtn = $('upd-netdisk');
  if (netdiskBtn) netdiskBtn.addEventListener('click', function () {
    invoke('open_netdisk').catch(function () {  });
  });
  var stopAck = false;   // 点了停止之后，等后台确认（canceled/done 事件）就置位
  if (stop) stop.addEventListener('click', function () {
    if (stop.disabled) return;
    // 用户反馈：点了停止要立刻有反馈，而不是干等后台确认
    stop.disabled = true;
    if ($('upd-msg')) $('upd-msg').textContent = t('正在停止…');
    stopAck = false;
    invoke('cancel_self_update').then(function () {
      toast(t('已请求停止，临时文件会一并清理'), 'info', 5000);
      // 5 秒内没等到后台确认 = 连接卡住了：如实说明，别让用户以为没点上
      setTimeout(function () {
        if (stopAck || box.classList.contains('hidden')) return;
        toast(t('当前网络暂时卡住，停止将在连接恢复响应后自动完成（不会继续下载内容）'), 'info', 8000);
      }, 5000);
    }).catch(function (e) {
      toast(t('停止失败：') + errText(e), 'err', 8000);
      stop.disabled = false;
    });
  });
  EV.listen('selfupdate', function (e) {
    var p = (e && e.payload) || {};
    var phase = p.phase || '';
    if (phase) stopAck = true;
    if (phase === 'start') {
      box.classList.remove('hidden');
      setUpdBlur(true);
      // 更新内容：检查更新时从发布页取回来的日志，下载前让用户看得见
      var nEl = $('upd-notes');
      if (nEl) {
        nEl.textContent = UPD_NOTES || '';
        nEl.classList.toggle('hidden', !UPD_NOTES);
      }
      if ($('upd-fill')) $('upd-fill').style.width = '0%';
      if ($('upd-msg')) $('upd-msg').textContent = t('正在获取版本信息…');
      return;
    }
    if (phase) {
      if ($('upd-msg')) $('upd-msg').textContent = phase === 'done' ? t('下载完成，正在启动安装程序…') : (phase === 'canceled' ? t('已停止，临时文件已清理') : t('下载失败'));
      if ($('upd-stop')) $('upd-stop').disabled = true;
      setTimeout(function () { box.classList.add('hidden'); setUpdBlur(false); if ($('upd-stop')) $('upd-stop').disabled = false; }, phase === 'done' ? 600 : 1200);
      return;
    }
    if ($('upd-fill')) $('upd-fill').style.width = Math.round(Math.max(0, Math.min(1, p.fraction || 0)) * 100) + '%';
    if ($('upd-msg')) $('upd-msg').textContent = p.msg || '';
  });
}
