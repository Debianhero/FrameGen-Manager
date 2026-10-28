/* 桌面端启动 / 页签 / 弹窗 / 库列表。库页渲染在 library.js，设置与关于页在 settings.js。
   **不要在这里加 'use strict'**：端到端脚本（dev-only/ui-e2e/run.js）是用 win.eval 逐个
   加载脚本的，而严格模式下的 eval 里 var / function 声明不会挂到全局 —— 一加这句，
   settings.js 等文件就看不到这里的 invoke / CFG（浏览器里脚本级严格模式没这个问题，
   但两条路径必须表现一致，否则 e2e 测不出真问题）。lib.js 同理。 */
var T = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
var EV = (window.__TAURI__ && window.__TAURI__.event) ? window.__TAURI__.event : null;
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}
(function () {
  var theme = 'light';
  try { theme = new URLSearchParams(location.search).get('theme') || 'light'; } catch (e) { theme = 'light'; }
  applyTheme(theme);
})();
if (EV) {
  EV.listen('theme', function (e) {
    var p = (e && e.payload) || {};
    applyTheme(p.theme || 'light');
  });
}
function banner(msg) {
  var b = document.getElementById('errbar');
  if (!b) {
    b = document.createElement('div');
    b.id = 'errbar';
    document.body.appendChild(b);
  }
  b.textContent += (b.textContent ? '\n' : '') + msg;
}
window.onerror = function (m, s, l, c, e) {
  banner(t('JS 错误: ') + m + ' @' + l + ':' + c + (e && e.stack ? '\n' + e.stack : ''));
};
window.addEventListener('unhandledrejection', function (ev) {
  var r = ev.reason;
  banner(t('Promise 异常: ') + ((r && r.message) ? r.message : String(r)));
});
var PROXIES = ['version.dll'];
var PROXY = 'version.dll';
var GAMES = [];
var COVERS = {};
var REMOVED = [];
var SCANNED_AT = '';
var ASSETS_DIR = '';
var ASSET_FILES = [];
var ICONS = {};
var CFG = null;
var GPU = null;
var SELF = null;
// 最近一次「检查更新」取回来的更新日志（后端从仓库 docs/release-notes.md 拉），给更新窗口显示
var UPD_NOTES = '';
var DLSS5 = { apis: [], backends: [], assets: null };
var SM_CONFLICT_TEXT = t('该游戏疑似已开启Smooth Motion。不建议同时开启Smooth Motion和DLSS-FG。但你可以忽略这条提示继续部署。');
document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
function invoke(cmd, args) {
  if (!T) return Promise.reject(new Error(t('Tauri 桥不可用（window.__TAURI__ 缺失）')));
  try { return Promise.resolve(T.invoke(cmd, args || {})); }
  catch (e) { return Promise.reject(e); }
}
var toastWrap = null;
function layers() { return $('layers'); }
function toast(msg, kind, ms, copyText) {
  var root = layers();
  if (!root) return null;
  if (!toastWrap) { toastWrap = h('div', { class: 'toasts' }); root.appendChild(toastWrap); }
  var node = h('div', { class: 'toast ' + (kind || 'info'), text: backText(msg) });
  if (copyText) {
    // 一键把这条提示的全文复制出去（用户报障时直接贴到 Issues）。
    // 按钮单独占一行、靠右 —— 挤在文字后面会顶着最后一个字，不好看（用户反馈）。
    var cp = h('button', { class: 'btn small', type: 'button', text: t('复制') });
    cp.addEventListener('click', function (ev) {
      ev.stopPropagation();   // 别触发 toast 本身"点了就消失"
      var ta = document.createElement('textarea');
      ta.value = copyText;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var okCopy = false;
      try { okCopy = document.execCommand('copy'); } catch (e) { okCopy = false; }
      document.body.removeChild(ta);
      if (okCopy) { cp.textContent = t('已复制'); setTimeout(function () { cp.textContent = t('复制'); }, 1600); }
    });
    node.appendChild(h('div', { class: 'toast-actions' }, [cp]));
  }
  node.addEventListener('click', function () { if (node.parentNode) node.parentNode.removeChild(node); });
  toastWrap.appendChild(node);
  while (toastWrap.children.length > 4) toastWrap.removeChild(toastWrap.firstChild);
  setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, ms || (kind === 'err' ? 12000 : 6000));
  return node;
}
var LAST_POINT = { x: -1, y: -1 };
var OV_COUNT = 0;
function setOvOpen(on) {
  OV_COUNT += on ? 1 : -1;
  if (OV_COUNT < 0) OV_COUNT = 0;
  if (OV_COUNT > 0) document.body.classList.add('ov-open');
  else document.body.classList.remove('ov-open');
}
document.addEventListener('pointerdown', function (e) {
  LAST_POINT.x = e.clientX; LAST_POINT.y = e.clientY;
}, true);
function refreshOverlayFocus() {
  var root = layers();
  if (!root) return;
  var ovs = root.querySelectorAll('.ov');
  for (var i = 0; i < ovs.length; i++) {
    ovs[i].classList.toggle('ov-behind', i < ovs.length - 1);
  }
}
function openOverlay(node, onClose) {
  var root = layers();
  var ov = h('div', { class: 'ov' }, [h('div', { class: 'ov-backdrop' }), node]);
  var closed = false;
  var gone = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    try {
      if (node && node.style) { node.style.display = 'none'; }
    } catch (e) {  }
    ov.classList.remove('in');
    setOvOpen(false);
    refreshOverlayFocus();
    setTimeout(function () {
      if (gone) return;
      gone = true;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      refreshOverlayFocus();
    }, 70);
    if (onClose) onClose();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
  ov.querySelector('.ov-backdrop').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  if (root) root.appendChild(ov);
  refreshOverlayFocus();
  try {
    if (node && node.getBoundingClientRect && LAST_POINT.x >= 0) {
      var box = node.getBoundingClientRect();
      if (box.width && box.height) {
        var ox = Math.max(0, Math.min(box.width, LAST_POINT.x - box.left));
        var oy = Math.max(0, Math.min(box.height, LAST_POINT.y - box.top));
        node.style.transformOrigin = ox + 'px ' + oy + 'px';
      }
    }
  } catch (e) {  }
  void ov.offsetWidth;
  ov.classList.add('in');
  setOvOpen(true);
  var first = node.querySelector('.btn.primary') ||
    node.querySelector('.btn.danger') ||
    node.querySelector('.btn') ||
    node.querySelector('.x');
  if (first) first.focus();
  return { close: close, node: node, overlay: ov };
}
function uiConfirm(opts) {
  opts = opts || {};
  var single = opts.single === true || opts.cancel === null;
  return new Promise(function (resolve) {
    var done = false;
    var ov = null;
    function finish(v) {
      if (done) return;
      done = true;
      if (ov) ov.close();
      resolve(v);
    }
    var body = [];
    if (opts.rows && opts.rows.length) {
      body.push(h('div', { class: 'summary' }, opts.rows.map(function (kv) {
        return h('div', { class: 'sum-row' + (kv[3] ? ' nowrap' : '') }, [
          h('span', { class: 'sum-k', text: kv[0] }),
          h('b', { class: 'sum-v' + (kv[2] ? ' ' + kv[2] : ''), text: kv[1] })
        ]);
      })));
    }
    if (opts.body) body.push(h('p', { class: 'note', text: opts.body }));
// 长文本（如更新日志）：独立的可滚动区域，完整展示不截断
if (opts.scrollBody) body.push(h('div', { class: 'ov-scroll', text: opts.scrollBody }));
    var foot = [h('div', { class: 'spacer' })];
    if (!single) {
      foot.push(h('button', { class: 'btn', type: 'button', text: opts.cancel || t('取消'), on: { click: function () { finish(false); } } }));
    }
    foot.push(h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'button', text: opts.ok || t('确定'), on: { click: function () { finish(true); } } }));
    var box = h('div', { class: 'dialog narrow confirm' + (opts.rows && opts.rows.length ? ' has-rows' : '') }, [
      h('div', { class: 'dialog-head' }, [h('div', { class: 'dt', text: opts.title || t('请确认') })]),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-foot' }, foot)
    ]);
    ov = openOverlay(box, function () { if (!done) { done = true; resolve(single); } });
  });
}
window.alert = function (m) { toast(String(m), 'info', 9000); };
window.confirm = function (m) { uiConfirm({ title: t('请确认'), body: String(m) }); return false; };
var BAR_PHASE = '';
function showBar(msg, f, phase) {
  var bar = $('bar');
  if (!bar) return;
  bar.classList.remove('hidden');
  if (typeof f === 'number' && isFinite(f)) {
    var fill = $('bar-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(f * 100))) + '%';
  }
  var bt = $('bar-text');
  if (bt) {
    bt.textContent = backText(msg || '');
    bt.setAttribute('data-phase', phase || BAR_PHASE || '');
  }
}
function hideBarIfPhase(want, ms) {
  var bt = $('bar-text');
  if (bt && bt.getAttribute('data-phase') === want) hideBarLater(ms);
}
function hideBarLater(ms) {
  setTimeout(function () { var bar = $('bar'); if (bar) bar.classList.add('hidden'); }, ms || 2500);
}
var barPending = null;
var barTimer = null;
var barAt = 0;
function flushBar() {
  barTimer = null;
  barAt = Date.now();
  if (barPending) {
    showBar(barPending.msg, barPending.f);
    barPending = null;
  }
}
function queueBar(msg, f) {
  barPending = { msg: msg, f: f };
  var now = Date.now();
  if (now - barAt >= 100) flushBar();
  else if (!barTimer) barTimer = setTimeout(flushBar, 100 - (now - barAt));
}
if (EV) {
  EV.listen('progress', function (e) {
    var p = (e && e.payload) || {};
    queueBar(p.msg, p.fraction);
  });
  // 仅预览（DEV + --fgm-sim-assets）：伪造旧资产，弹统一提示
  //   fg       = 帧生成（要清除）
  //   sm       = Smooth Motion（要清除）
  //   dlss5old = 旧版 RenoDX 插件（要彻底卸载）
  //   dlss5    = GITC 资产旧了（只告知、重新部署即可）
  EV.listen('sim-assets-legacy', function (e) {
    var md = (e && e.payload && e.payload.mode) ? e.payload.mode : 'fg';
    if (md === 'sm') return showAssetsLegacyDialog([], ['霍格沃茨之遗'], [], []);
    if (md === 'dlss5old') return showAssetsLegacyDialog([], [], ['霍格沃茨之遗'], []);
    if (md === 'dlss5') return showAssetsLegacyDialog([], [], [], ['霍格沃茨之遗']);
    showAssetsLegacyDialog(['示例游戏 A（帧生成 0.4.1）', '示例游戏 B（帧生成 0.3.x）'], [], [], []);
  });
  // 仅预览（DEV + --fgm-sim-download）：把下载框摆成"下载中"的样子（数字是示例值）
  EV.listen('sim-download', function () {
    var box = $('upd');
    if (!box) return;
    box.classList.remove('hidden');
    setUpdBlur(true);
    if ($('upd-fill')) $('upd-fill').style.width = '62%';
    if ($('upd-stop')) $('upd-stop').disabled = false;
    // 稍等一拍再写文案（下载框自己的初始化会覆盖一次）
    var write = function () {
      if ($('upd-msg')) $('upd-msg').textContent = t('正在下载安装包') + ' 62% · 6.2 MB/s';
    };
    write();
    setTimeout(write, 400);
    setTimeout(write, 1200);
  });
  // 仅预览（DEV + --fgm-sim-legacy）：伪造两条旧版游戏，弹「旧版帧生成」提示看样式
  EV.listen('sim-legacy-fg', function () {
    maybePromptLegacyUpgrade([{ name: '示例游戏 A（旧版资产）' }, { name: '示例游戏 B（旧版资产）' }]);
  });
  // 「发现新版本」：主进程不再用原生 MessageBox（风格不符、长日志被截断），改由界面自绘
  EV.listen('selfupdate-offer', function (e) {
    var p = (e && e.payload) || {};
    if (!p.latest) return;
    UPD_NOTES = p.notes || '';
    uiConfirm({
      title: t('发现新版本'),
      ok: t('下载并安装'),
      cancel: t('稍后'),
      rows: [
        [t('新版本'), 'v' + p.latest, 'ok'],
        [t('当前版本'), 'v' + (p.current || '')],
      ],
      scrollBody: p.notes ? String(p.notes) : '',
      body: t('安装过程会关闭本程序，装完会自动重新打开。'),
    }).then(function (yes) {
      if (!yes) return;
      invoke('self_update_download').catch(function (err) {
        toast(t('下载失败：') + errText(err), 'err', 12000);
      });
    });
  });
}
function busy(btn, label, fn) {
  if (!btn) return Promise.resolve().then(fn);
  var old = btn.textContent;
  btn.disabled = true;
  if (label) btn.textContent = label;
  return Promise.resolve()
    .then(fn)
    .catch(function (e) { toast(t('操作失败：') + errText(e), 'err', 15000); })
    .then(function () { btn.disabled = false; btn.textContent = old; });
}
var FAKE_GPU = '';
try { FAKE_GPU = new URLSearchParams(location.search).get('fakeGpu') || ''; } catch (e) { FAKE_GPU = ''; }
function refreshGpu() {
  return invoke('gpu_info', FAKE_GPU ? { fakeName: FAKE_GPU } : {}).then(function (g) {
    GPU = g;
    var gpuText = (g.name || t('未知显卡')) + t('　驱动 ') + (g.driver || t('未知')) +
      (g.driverSrc ? t('（') + g.driverSrc + t('）') : '');
          if ($('drv')) $('drv').textContent = (g.driver || t('未知')) + (g.driverSrc ? t('（') + g.driverSrc + t('）') : '');
    if ($('hags')) $('hags').textContent = backText(g.hags) || t('未知');
    var box = $('gpu-chips');
    if (box) {
      box.textContent = '';
      box.appendChild(h('span', { class: 'chip', text: g.name || t('未知显卡') }));
      box.appendChild(h('span', { class: 'chip ' + (g.gate ? 'gray' : ''), text: t('路由 ') + (backText(g.route) || t('未知')) }));
    }
    paintGate(g.gate);
  }).catch(function (e) {
          var box = $('gpu-chips');
    if (box) { box.textContent = ''; box.appendChild(h('span', { class: 'chip gray', text: t('读取失败') })); }
    paintGate(null);
    throw e;
  });
}
var GPU_WARNED = false;
function warnGpuIfNeeded() {
  if (GPU_WARNED) return;
  var reason = backText((GPU && GPU.gate) || '');
  if (!reason) return;
  GPU_WARNED = true;
  var name = (GPU && GPU.name) || t('未知显卡');
  var route = backText((GPU && GPU.route) || t('未知'));
  return new Promise(function (resolve) {
    var done = false;
    var ov = null;
    function finish(v) { if (done) return; done = true; if (ov) ov.close(); resolve(v); }
    var box = h('div', { class: 'dialog narrow' }, [
      h('div', { class: 'dialog-head' }, [h('div', { class: 'dt', text: t('这张显卡可能用不了本工具') })]),
      h('div', { class: 'dialog-body' }, [
        h('p', { class: 'risk strong', text: t('检测到：') + name + t('（') + route + t('）') }),
        h('p', { class: 'note', text: reason }),
        h('p', { class: 'note', text: t('继续进入应用也没问题：扫描游戏库、DLSS5 浏览、资产文件夹、日志和检查更新都能用，只是「部署」会被挡住 —— 免得装了半天不生效。') })
      ]),
      h('div', { class: 'dialog-foot' }, [
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', text: t('退出应用'), on: { click: function () { finish('quit'); } } }),
        h('button', { class: 'btn primary', type: 'button', text: t('继续进入应用'), on: { click: function () { finish('continue'); } } })
      ])
    ]);
    ov = openOverlay(box, function () { if (!done) { done = true; resolve('continue'); } });
  }).then(function (v) {
    if (v === 'quit') {
      try { window.close(); } catch (e) { }
    }
  });
}
function paintGate(reason) {
  var el = $('gpu-gate');
  if (!el) return;
  if (reason) {
    el.textContent = t('不能部署：') + backText(reason);
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}
function assetHas(name) {
  var n = String(name || '').toLowerCase();
  for (var i = 0; i < ASSET_FILES.length; i++) {
    if (String(ASSET_FILES[i]).toLowerCase() === n) return true;
  }
  return false;
}
  function refreshAssets() {
  return invoke('assets_status').then(function (a) {
    ASSETS_DIR = a.dir || '';
    var files = a.files || [];
    ASSET_FILES = files.map(function (f) { return f.name; });
    if ($('assets-dir')) $('assets-dir').textContent = ASSETS_DIR || '-';
    return a;
  }).catch(function (e) {
    var box = $('mod-list');
    if (box) { box.textContent = ''; box.appendChild(h('div', { class: 'mod' }, [h('span', { class: 'no', text: t('读取失败：') + errText(e) })])); }
    throw e;
  });
}
function loadDlss5Meta() {
  return Promise.all([
    invoke('dlss5_choices').then(function (c) {
      DLSS5.apis = (c && c.apis) || [];
      DLSS5.backends = (c && c.backends) || [];
    }).catch(function () { }),
    invoke('dlss5_assets').then(function (a) { DLSS5.assets = a || null; }).catch(function () { })
  ]);
}
var PAGES = { lib: 'page-lib', sm: 'page-sm', dlss5: 'page-dlss5', settings: 'page-settings', help: 'page-help' };
function setupTabs() {
  var tabs = document.querySelectorAll('.tab');
  Array.prototype.forEach.call(tabs, function (b) {
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.toggle('active', x === b); });
      var want = b.getAttribute('data-page');
      for (var k in PAGES) {
        if (!Object.prototype.hasOwnProperty.call(PAGES, k)) continue;
        var el = $(PAGES[k]);
        if (el) el.classList.toggle('hidden', k !== want);
      }
      if (want === 'settings') refreshBackups().catch(function () { });
      if (want === 'sm') renderSm().catch(function () { });
      if (want === 'lib') refreshLibrary().catch(function () { });
    });
  });
}
function bind() {
  window.addEventListener('focus', function () { if (ASSETS_DIR !== null) refreshAssets().catch(function () { }); });
  if ($('btn-scan')) $('btn-scan').addEventListener('click', scanLibrary);
  if ($('btn-redeploy-legacy')) {
    $('btn-redeploy-legacy').addEventListener('click', function () { redeployLegacyAll(); });
  }
  if ($('btn-check')) $('btn-check').addEventListener('click', function () { busy(this, t('检查中…'), function () { return checkSelfUpdate(); }); });
  if ($('btn-netdisk')) $('btn-netdisk').addEventListener('click', function () {
    invoke('open_netdisk').catch(function () {  });
  });
  if ($('auto-scan-tgl')) {
    $('auto-scan-tgl').addEventListener('change', function () {
      var on = this.checked;
      invoke('set_auto_scan', { on: on }).then(function () {
        if (CFG) CFG.autoScanOnStart = on;
      }).catch(function (e) { toast(t('保存失败：') + errText(e), 'err'); });
    });
  }
  if ($('btn-hags')) $('btn-hags').addEventListener('click', function () {
    invoke('open_hags_settings').then(function (r) {
      toast(t('已打开系统设置里的「硬件加速 GPU 计划」\n') + (r && r.uri ? r.uri : '') +
        t('\nDLSS 帧生成需要它是「开」；改完可能要重启。'), 'info', 9000);
    }).catch(function (e) { toast(t('打开系统设置失败：') + errText(e), 'err'); });
  });
  if ($('btn-add-game')) $('btn-add-game').addEventListener('click', function () {
    busy(this, t('选择中…'), function () {
      return invoke('add_game').then(function (r) {
        if (r.canceled) return;
        if (r.added === false && r.updated !== true) {
          toast(r.reason || t('没有加进去。'), 'info', 8000);
          return;
        }
        toast((r.updated ? t('已更新游戏库条目：') : t('已加入游戏库：')) + (r.name || '') + '\n' + (r.dir || ''), 'ok', 10000);
        return refreshLibrary();
      });
    });
  });
  if ($('btn-open-assets')) $('btn-open-assets').addEventListener('click', function () { openPath(ASSETS_DIR); });
  if ($('btn-spoof-apply')) $('btn-spoof-apply').addEventListener('click', spoofApply);
  if ($('btn-spoof-restore')) $('btn-spoof-restore').addEventListener('click', spoofRestore);
  if ($('btn-dlss5-scan')) $('btn-dlss5-scan').addEventListener('click', function () { scanLibrary(); });
  if ($('btn-dlss5-pick')) $('btn-dlss5-pick').addEventListener('click', function () { pickGameExeNow(this); });
  if ($('btn-dlss5-removed')) $('btn-dlss5-removed').addEventListener('click', function () { openRemovedDialog('dlss5'); });
  if ($('btn-removed-games')) $('btn-removed-games').addEventListener('click', function () { openRemovedDialog('library'); });
  if ($('btn-self-update')) $('btn-self-update').addEventListener('click', checkSelfUpdate);
  if ($('btn-sm-refresh')) $('btn-sm-refresh').addEventListener('click', function () { renderSm().catch(function () { }); });
  if ($('btn-sm-scan') && $('btn-scan')) $('btn-sm-scan').addEventListener('click', function () { $('btn-scan').click(); });
  if ($('btn-sm-pick')) $('btn-sm-pick').addEventListener('click', function () {
    pickGameExeNow(this, function () { return paintSmList(); });
  });
  if ($('btn-clean-backups')) $('btn-clean-backups').addEventListener('click', function () {
    var me = this;
    invoke('backups_info').then(function (info) {
      var all = (info && info.entries) || [];
      var del = all.filter(function (en) { return en.kind !== 'gpu-name'; });
      var freed = 0, rows = [];
      del.forEach(function (en) { freed += en.bytes || 0; });
      if (!del.length) { toast(t('没有需要清理的备份（显卡名称的备份会保留）'), 'info', 5000); return; }
      var kindName = { dlss5: 'DLSS5', framegen: t('帧生成') };
      del.slice(0, 8).forEach(function (en) {
        rows.push([(kindName[en.kind] || en.kind) + ' · ' + fmtSize(en.bytes || 0),
                   en.target || (en.name.slice(0, 8) + '…'), 'warn']);
      });
      if (del.length > 8) rows.push([t('……还有 ') + (del.length - 8) + t(' 项'), '', 'warn']);
      rows.unshift([t('将删除'), del.length + t(' 份部署记录'), 'warn']);
      rows.push([t('可释放'), fmtSize(freed)]);
      uiConfirm({
        title: t('清理旧备份'),
        ok: t('删除备份'),
        danger: true,
        rows: rows,
        body: t('备份记录是「这个游戏由本工具部署过」的唯一凭据，备份文件本身是游戏的原文件。\n\n') +
          t('删除之后会有两个后果：\n') +
          t('· 已经部署的模组**无法再「还原」**成原版；\n') +
          t('· 这些游戏会重新显示为「未部署」，DLSS5 也不再认得是本工具装的（无法自动还原）。\n\n') +
          t('请先把还想恢复原样的游戏逐个「还原」，再来清理。\n\n（显卡名称的备份会保留。）'),
      }).then(function (yes) {
        if (!yes) return;
        busy(me, t('清理中…'), function () {
          return invoke('clean_backups').then(function (r) {
            toast(t('已清理 ') + (r.removed || 0) + t(' 份备份，释放 ') + fmtSize(r.freed || 0), 'ok', 8000);
            return refreshBackups();
          });
        });
      });
    }).catch(function (e) { toast(t('读取备份情况失败：') + errText(e), 'err', 8000); });
  });
  if ($('btn-log-copy')) $('btn-log-copy').addEventListener('click', function () {
    var box = $('log-box');
    var logText = box ? box.textContent : '';
    if (!logText) { toast(t('日志是空的。'), 'info', 5000); return; }
    var g = (GPU && (GPU.name || GPU.gpu || GPU.model)) || '';
    var drv = (GPU && (GPU.driver || GPU.driverVersion || GPU.version)) || '';
    var head = [
      t('=== FrameGen Manager 反馈信息 ==='),
      t('版本：') + ((SELF && SELF.version) || (CFG && CFG.version) || t('未知')),
      t('时间：') + new Date().toLocaleString(),
      t('显卡：') + (g || t('未知')) + (drv ? t('（驱动 ') + drv + t('）') : ''),
      t('资产目录：') + ((CFG && CFG.assetsDir) || '-'),
      t('备份目录：') + ((CFG && CFG.backupsDir) || '-'),
      t('日志目录：') + ((CFG && CFG.logsDir) || '-'),
      '',
      t('=== 日志尾部 ==='),
    ].join('\n');
    copyText(head + logText).then(function () { toast(t('已复制：环境信息 + 日志'), 'ok', 5000); })
      .catch(function (e) { toast(t('复制失败：') + errText(e), 'err'); });
  });
  var pOpen = [
    ['btn-open-p-assets', function () { return CFG && CFG.assetsDir; }],
    ['btn-open-p-backups', function () { return CFG && CFG.backupsDir; }],
    ['btn-open-p-logs', function () { return CFG && CFG.logsDir; }],
    ];
  pOpen.forEach(function (pair) {
    if (!$(pair[0])) return;
    $(pair[0]).addEventListener('click', function () {
      var p = pair[1]();
      if (p) openPath(p); else toast(t('还读不到这个路径。'), 'info', 5000);
    });
  });
  if ($('lang-sel')) {
    var langSel = $('lang-sel');
    langSel.value = window.getLang ? window.getLang() : 'zh';
    langSel.addEventListener('change', function () {
      if (window.setLang) window.setLang(this.value);
    });
  }
}
window.onLangChange = function () {
  try { location.reload(); } catch (e) {  }
};
function boot() {
  if (window.applyI18n) window.applyI18n();
  setupTabs();
  bind();
  bindUpdateDialog();
  startLogLive();
  refreshGpu().then(function () { warnGpuIfNeeded(); }).catch(function () { });
  loadConfig().then(function () {
    if ($('auto-scan-tgl')) $('auto-scan-tgl').checked = !!(CFG && CFG.autoScanOnStart);
    return refreshAssets();
  }).catch(function () { });
  loadDlss5Meta().catch(function () { });
  loadSpoof().catch(function () { });
  loadCovers()
    .then(function () { return refreshLibrary(); })
    .then(function () {
      // 升级后**自动清除**旧版帧生成部署（0.3.x 布局 / 0.4.0 资产）：只清不装，
      // 清完由用户重新部署 0.4.1（按程序版本只做一次）。
      return invoke('framegen_cleanup_outdated').catch(function () { return null; }).then(function (r) {
        if (!r) return null;
        var n = 0;
        if (r.cleaned) n = r.cleaned.length;
        if (!n) return null;
        var bad = false;
        if (r.failed) { if (r.failed.length) bad = true; }
        var lines = r.cleaned.join(t('、'));
        var body = t('已自动清除 {n} 个游戏的旧版帧生成部署，原件已还原：', { n: n }) + '\n' + lines +
          '\n\n' + t('请到「帧生成」页重新部署新版本（0.4.1）。');
        if (bad) body += '\n\n' + t('部分未清除：') + r.failed.join('；');
        return refreshLibrary().catch(function () { }).then(function () {
          return uiConfirm({
            title: bad ? t('旧版帧生成已清除（部分失败）') : t('旧版帧生成已清除'),
            ok: t('知道了'),
            body: body,
          });
        });
      });
    })
    .then(function () {
      // 旧版扫描放到首屏之后（3.5 秒）再做，别挡窗口出现；三类资产合并成**一个**提示
      setTimeout(function () { checkAssetsLegacy(); }, 3500);
    })
    .then(function () {
      // 默认不自动扫描（用户要求，开关在「关于」页，默认关）；
      // 第一次使用（库是空的）扫一次，避免新用户一进来看到空列表。
      var firstRun = !(GAMES && GAMES.length);
      if (firstRun || (CFG && CFG.autoScanOnStart)) return autoScanLibrary();
    })
    .catch(function () { });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
