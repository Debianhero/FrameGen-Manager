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
function loadLog() {
  return invoke('log_tail', { lines: 300 }).then(function (text) {
    var box = $('log-box');
    if (!box) return;
    box.textContent = text ? text : t('（日志是空的 —— 还没有操作过，或者日志目录不可写）');
    box.scrollTop = box.scrollHeight;
  }).catch(function (e) {
    var box = $('log-box');
    if (box) box.textContent = t('读取日志失败：') + errText(e);
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
