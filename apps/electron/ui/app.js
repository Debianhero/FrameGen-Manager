(function () {
  'use strict';
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
    // 仅预览（DEV + --fgm-sim-assets）：伪造三类旧资产，弹统一提示
    EV.listen('sim-assets-legacy', function (e) {
      var md = (e && e.payload && e.payload.mode) ? e.payload.mode : 'fg';
      if (md === 'sm') return showAssetsLegacyDialog([], ['霍格沃茨之遗'], []);
      if (md === 'dlss5') return showAssetsLegacyDialog([], [], ['霍格沃茨之遗']);
      showAssetsLegacyDialog(['示例游戏 A（帧生成 0.4.1）', '示例游戏 B（帧生成 0.3.x）'], [], []);
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
  function coverKeys(g) {
    if (!g) return [];
    var keys = [];
    if (g.appId) keys.push(String(g.appId));
    var exe = g.targetExe || '';
    if (exe) {
      var base = String(exe).split('\\').pop() || '';
      base = base.replace(/\.exe$/i, '');
      if (base) keys.push(base);
    }
    if (g.name) keys.push(String(g.name));
    return keys;
  }
  function coverOf(g) {
    var keys = coverKeys(g);
    for (var i = 0; i < keys.length; i++) {
      if (COVERS[keys[i]]) return COVERS[keys[i]];
    }
    return null;
  }
  function iconOf(g) {
    if (!g || !g.dir) return null;
    return ICONS[g.dir] || null;
  }
  function rgbaToDataUrl(w, h, b64) {
    var bin = atob(b64);
    var arr = new Uint8ClampedArray(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    cv.getContext('2d').putImageData(new ImageData(arr, w, h), 0, 0);
    return cv.toDataURL('image/png');
  }
  function loadGameIcons() {
    return invoke('game_icons').then(function (r) {
      var list = (r && r.icons) || [];
      var changed = false;
      list.forEach(function (it) {
        if (ICONS[it.dir]) return;
        try { ICONS[it.dir] = rgbaToDataUrl(it.w, it.h, it.rgba); changed = true; }
        catch (e) {  }
      });
      if (changed) paintLibrary();
    }).catch(function () { });
  }
  function loadCovers() {
    return invoke('covers').then(function (list) {
      COVERS = {};
      (list || []).forEach(function (c) { COVERS[String(c.id)] = c.data; });
    }).catch(function () { COVERS = {}; });
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
  function gameThumb(g, preferCover) {
    var cov = coverOf(g);
    var ico = iconOf(g);
    var src = preferCover ? (cov || ico) : (ico || cov);
    var id = (g && g.appId) ? String(g.appId) : '';
    if (!src) {
      var ph = h('div', { class: 'thumb ph2', text: (g.name || '?').slice(0, 1) });
      if (id) { ph.setAttribute('data-cover-id', id); lazyCoverFor(id); }
      return ph;
    }
    var isIcon = (src === ico && src !== cov);
    var im = h('img', { class: 'thumb' + (isIcon ? ' icon' : ''), src: src, alt: '' });
    if (id && !cov) { im.setAttribute('data-cover-id', id); lazyCoverFor(id); }
    return im;
  }
  /// 分批渲染（配合滚动哨兵）：几百个游戏时不一次性建全部卡片。
  function appendLibChunk(box) {
    var end = Math.min(LIB_RENDERED + LIB_CHUNK, GAMES.length);
    for (var i = LIB_RENDERED; i < end; i++) box.appendChild(gameCard(GAMES[i], i));
    LIB_RENDERED = end;
    if (LIB_RENDERED >= GAMES.length) return;
    var sent = $('lib-sentinel');
    if (!sent) {
      sent = h('div', { id: 'lib-sentinel', style: 'grid-column:1/-1;height:1px' });
    }
    box.appendChild(sent);   // 每次把哨兵挪到末尾
    if (typeof IntersectionObserver !== 'function') {
      for (var j = LIB_RENDERED; j < GAMES.length; j++) box.appendChild(gameCard(GAMES[j], j));
      LIB_RENDERED = GAMES.length;
      return;
    }
    if (LIB_OBSERVER) { try { LIB_OBSERVER.disconnect(); } catch (e) {  } }
    LIB_OBSERVER = new IntersectionObserver(function (ents) {
      for (var k = 0; k < ents.length; k++) {
        if (ents[k].isIntersecting) { appendLibChunk(box); return; }
      }
    }, { rootMargin: '800px' });
    LIB_OBSERVER.observe(sent);
  }
  function deployKind(label) {
    var s = label || '';
    if (/^已部署/.test(s)) return 'deployed';
    if (/^已安装，本工具无记录/.test(s)) return 'manual';
    if (/^已有同名单文件/.test(s)) return 'occupied';
    if (/Smooth Motion/.test(s)) return 'sm';
    return 'none';
  }
  function stateCls(label) {
    switch (deployKind(label)) {
      case 'deployed': return 'ok';
      case 'sm': return 'err';
      // 同名单文件大多是**游戏自带的**（dxgi.dll / 微软签名的 dbghelp.dll）：
      // 用中性灰，别再像错误一样标红（用户反馈这是措辞误报）。
      case 'occupied': return 'dim';
      case 'manual': return 'warn';
      default: return 'dim';
    }
  }
  function deployLabel(label) {
    var s = label || '';
    var m;
    switch (deployKind(s)) {
      case 'deployed':
        m = /^已部署 \(([^)]*)\)( · 旧版资产，建议重新部署| · 代理文件已被覆盖或丢失（帧生成暂时失效）| · 上次安装未完成（建议重新部署或还原）)?/.exec(s);
        if (!m) return s;
        if (/代理文件已被覆盖或丢失/.test(m[2] || '')) {
          return t('已部署 ({proxy}) · 代理文件已被覆盖或丢失（帧生成暂时失效）', { proxy: m[1] });
        }
        if (/上次安装未完成/.test(m[2] || '')) {
          return t('已部署 ({proxy}) · 上次安装未完成（建议重新部署或还原）', { proxy: m[1] });
        }
        return m[2]
          ? t('已部署 ({proxy}) · 旧版资产，建议重新部署', { proxy: m[1] })
          : t('已部署 ({proxy})', { proxy: m[1] });
      case 'manual':
        m = /^已安装，本工具无记录（([\s\S]*)）$/.exec(s);
        return m ? t('已安装，本工具无记录（{files}）', { files: m[1] }) : s;
      case 'occupied':
        m = /^已有同名单文件: ([\s\S]*)$/.exec(s);
        return m ? t('已有同名单文件: {files}', { files: m[1] }) : s;
      case 'sm':
        return t('已被 Smooth Motion 占用');
      default:
        return t('未部署');
    }
  }
  function dlss5Label(s) {
    var v = s || '';
    var m = /^已部署 DLSS5（([\s\S]*)）$/.exec(v);
    return m ? t('已部署 DLSS5（{detail}）', { detail: backText(m[1]) }) : t('未部署');
  }
    function gameCard(g, idx, back) {
    var fga = g.fgAssets;
    var assetBadge = fga
      ? badge(
          t('资产 ') + fga.version +
          (fga.runtime ? t(' · 运行库 ') + fga.runtime : '') +
          (fga.manual ? t('（手动）') : ''),
          fga.legacy ? 'warn' : (fga.manual ? 'dim' : 'ok')
        )
      : null;
    var dlss = g.streamline
      ? badge(t('自带 DLSS'), 'acc')
      : badge(g.techScanned ? t('未检出 DLSS') : t('未检测 DLSS'), 'dim');
    var acBadge = g.acKernel ? badge(t('内核级反作弊'), 'err') : (g.acAny ? badge(g.ac, 'warn') : null);
    var badges = h('div', { class: 'badges' }, [
      badge(g.source || t('未知'), g.manual ? 'dim' : null),
      dlss,
      acBadge,
      badge(t('API：') + (backText(g.api) || t('未知')), 'dim'),
      badge(t('引擎：') + (backText(g.engine) || t('未知')), 'dim'),
      badge(deployLabel(g.deployed), stateCls(g.deployed)),
      assetBadge,
      g.exists ? null : badge(t('目录不存在'), 'err')
    ]);
    return h('div', { class: 'gcard', style: 'animation-delay:' + Math.min(idx * 35, 350) + 'ms' }, [
      h('div', { class: 'gtop' }, [
        // 缩略图**封面优先**（封面是启动时就加载好的，图标是延后 2.5 秒才补齐的）——
        // 反过来会让卡片先显示封面、图标到位后又整体变回图标（用户反馈"图标样式来回跳"）。
        gameThumb(g, true),
        h('div', { class: 'ginfo' }, [
          h('div', { class: 'gname', text: g.name || t('（无名）') }),
          badges
        ])
      ]),
      h('div', { class: 'gpath', text: g.dir || '' }),
      back && back.note ? h('div', { class: 'gpath', text: back.note }) : null,
      h('div', { class: 'gactions' }, back ? [
        h('button', { class: 'btn ' + (back.danger ? 'danger' : 'primary') + ' small', type: 'button', text: back.label, on: { click: back.onClick } }),
        h('button', { class: 'btn small', type: 'button', text: t('打开文件夹'), on: { click: function () { openPath(g.exists ? (g.target || g.dir) : g.dir); } } })
      ] : [
        h('button', {
          class: 'btn ' + (deployKind(g.deployed) === 'deployed' || deployKind(g.deployed) === 'manual' ? 'danger' : 'primary') + ' small',
          type: 'button',
          text: deployKind(g.deployed) === 'deployed' ? t('还原')
            : (deployKind(g.deployed) === 'manual' ? t('清理') : t('部署')),
          on: { click: function () { openGameDialog(g); } },
        }),
        h('button', { class: 'btn small', type: 'button', text: t('打开文件夹'), on: { click: function () { openPath(g.exists ? g.target : g.dir); } } }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small danger', type: 'button', text: t('从库中移除'), on: { click: function () { removeGame(g); } } })
      ])
    ]);
  }
  var LIB_RENDERED = 0;
  var LIB_OBSERVER = null;
  var LIB_CHUNK = 24;
  function paintLibrary() {
    var box = $('lib-list');
    if (box) {
      box.textContent = '';
      LIB_RENDERED = 0;
      if (LIB_OBSERVER) { try { LIB_OBSERVER.disconnect(); } catch (e) {  } LIB_OBSERVER = null; }
      if (!GAMES.length) {
        box.appendChild(h('div', { class: 'empty', text: t('游戏库是空的 —— 点右上「扫描游戏库」。扫描只读启动器记录，不改动任何游戏文件。') }));
      } else {
        appendLibChunk(box);
      }
    }
    var legacyGames = GAMES.filter(function (g) { return g.fgAssets && g.fgAssets.legacy; });
    var reBtn = $('btn-redeploy-legacy');
    if (reBtn) {
      if (legacyGames.length) {
        reBtn.classList.remove('hidden');
        reBtn.textContent = t('重新部署旧版游戏（') + legacyGames.length + t('）');
        reBtn.title = t('这些游戏还在用旧版（0.3.x）帧生成资产：') +
          legacyGames.map(function (g) { return g.name; }).join(t('、'));
      } else {
        reBtn.classList.add('hidden');
      }
    }
    if ($('lib-sub')) {
      var s = GAMES.length + t(' 个游戏');
      if (SCANNED_AT) s += t(' · 上次扫描 ') + SCANNED_AT;
      $('lib-sub').textContent = s;
    }
    refreshWall();
  }
  function redeployLegacy(list, optimized, frames, preset) {
    var ok = [], bad = [];
    var chain = Promise.resolve();
    list.forEach(function (g, i) {
      chain = chain.then(function () {
        showBar(t('正在重新部署：') + g.name + t('（') + (i + 1) + '/' + list.length + t('）'), (i + 1) / list.length);
        var dir = g.target || g.dir;
        return invoke('clean_legacy', { dir: dir })
          .catch(function () { return null; })
          .then(function () {
            var proxy = (g.fgAssets && g.fgAssets.proxy) || PROXY;
            return invoke('deploy_game', {
              dir: dir, proxy: proxy, optimized: optimized, frames: frames, preset: preset,
              sr: srModeSaved() !== 'Off',
              srMode: srModeSaved(),
              engine: deployLsGet('engine', 'DLSS'),
              flow: deployLsGet('flow', 'Middle'),
              hudless: deployLsGet('hudless', 'Auto')
            });
          })
          .then(function () { ok.push(g.name); })
          .catch(function (e) { bad.push(g.name + t('（') + errText(e) + t('）')); });
      });
    });
    return chain.then(function () {
      hideBarLater(1200);
      var msg = t('重新部署完成：成功 ') + ok.length + t(' 个');
      if (bad.length) msg += t('\n失败 ') + bad.length + t(' 个：\n· ') + bad.join('\n· ');
      toast(msg, bad.length ? 'warn' : 'ok', bad.length ? 20000 : 8000);
      return refreshLibrary();
    });
  }
  function legacyGamesNow() {
    return GAMES.filter(function (g) { return g.fgAssets && g.fgAssets.legacy; });
  }
  function redeployLegacyAll() {
    var list = legacyGamesNow();
    if (!list.length) { toast(t('没有还在用旧版资产的游戏'), 'info', 5000); return Promise.resolve(); }
    var optimized = CFG ? CFG.optimized : 2;
    var frames = CFG ? CFG.frames : 3;
    var preset = (CFG && CFG.preset) || (CFG && CFG.defaultPreset) || 'C';
    return uiConfirm({
      title: t('重新部署 ') + list.length + t(' 个游戏'),
      ok: t('全部重新部署'),
      rows: [
        [t('游戏'), list.map(function (g) { return g.name; }).join(t('、'))],
        [t('优化等级'), optLabelOf(optimized)],
        [t('倍率上限'), frmLabelOf(frames)],
        [t('DLSS-G 预设'), presetLabelOf(preset)]
      ],
      body: t('会先清掉这些游戏目录里认得出的旧版（0.3.x）帧生成文件，再部署当前版本（0.4.0）。\n') +
            t('删除前逐个核对内容，不是你那份就不会动；游戏原件有备份的照常保留，之后仍可单独「还原」。\n\n') +
            t('请先完全退出这些游戏 —— 文件被占用会失败。')
    }).then(function (yes) {
      if (!yes) return;
      return redeployLegacy(list, optimized, frames, preset);
    });
  }
  var LEGACY_PROMPT_DONE = false;
  // forceList 仅用于开发预览（--fgm-sim-legacy）：跳过配置判断，直接弹同一个提示
  function maybePromptLegacyUpgrade(forceList) {
    if (!forceList && (!CFG || LEGACY_PROMPT_DONE)) return Promise.resolve();
    var ver = CFG && CFG.version ? CFG.version : '';
    if (!forceList && (!ver || CFG.legacyPrompted === ver)) return Promise.resolve();
    var list = forceList || legacyGamesNow();
    if (!list.length) return Promise.resolve();
    LEGACY_PROMPT_DONE = true;
    var optimized = CFG.optimized;
    var frames = CFG.frames;
    var preset = CFG.preset || CFG.defaultPreset || 'C';
    return invoke('set_config', {
      optimized: optimized, frames: frames, preset: preset, legacyPrompted: ver
    }).then(function (c) { CFG = c; }).catch(function () {  })
      .then(function () {
        return uiConfirm({
          title: t('检测到还在使用旧版本帧生成的游戏，是否重新部署新版本文件？'),
          ok: t('全部清理并重新部署'),
          cancel: t('稍后再说'),
          rows: [
            [t('游戏'), list.map(function (g) { return g.name; }).join(t('、'))],
            [t('当前资产'), t('0.3.x（代理 28.6 MB，运行库铺在游戏根目录）')],
            [t('新版资产'), t('0.4.0（运行库进 dlssg_sm86\\ 目录，附 310.9.16 运行库）')]
          ],
          body: t('新版把运行库和后端搬进了 dlssg_sm86\\ 目录，旧版那几份留在游戏目录里可能被游戏优先加载。\n') +
                t('点「全部清理并重新部署」会：先按内容核对删掉旧的 0.3.x 文件，再把新版铺上去。\n\n') +
                t('想自己逐个处理就点「稍后再说」：在游戏卡片上能看到「资产 0.3.x」徽章，进去单独部署即可。')
        }).then(function (yes) {
          if (yes) return redeployLegacy(list, optimized, frames, preset);
        });
      });
  }
  function refreshLibrary() {
    return invoke('list_games').then(function (data) {
      GAMES = (data && data.games) || [];
      REMOVED = (data && data.removed) || [];
      SCANNED_AT = (data && data.scannedAt) || '';
      paintLibrary();
      // 帧生成 + SM + DLSS5 的旧资产提示已合并到 checkAssetsLegacy（启动后 3.5 秒统一弹一次）
      // 图标是逐个 exe 从 Shell 读的（每个几十~几百毫秒）：延后一点，别抢首屏
      setTimeout(function () { loadGameIcons(); }, 2500);
      return GAMES;
    }).catch(function (e) {
      var box = $('lib-list');
      if (box) {
        box.textContent = '';
        box.appendChild(h('div', { class: 'empty', text: t('读取游戏库失败：') + errText(e) }));
      }
      throw e;
    });
  }
  function openRemovedDialog(kind) {
    var isDlss5 = kind === 'dlss5';
    var gone = isDlss5 ? GAMES.filter(dlss5IsRemoved) : REMOVED;
    var ov = null;
    var cards = gone.map(function (g, i) {
      return gameCard(g, i, {
        label: isDlss5 ? t('放回 DLSS5 列表') : t('放回游戏库'),
        onClick: function () {
          if (isDlss5) {
            dlss5SetRemoved(g, false);
            toast(t('已放回 DLSS5 列表：') + (g.name || ''), 'ok', 5000);
            if (ov) ov.close();
            return;
          }
          var want = String(g.dir || '').toLowerCase();
          invoke('restore_removed', { key: g.key || g.dir }).then(function () {
            if (ov) ov.close();
            return refreshLibrary().then(function () {
              var back = GAMES.some(function (x) { return String(x.dir || '').toLowerCase() === want; });
              toast(back ? (t('已放回游戏库：') + (g.name || ''))
                : (t('已取消移除：') + (g.name || '') + t('\n（这条是旧版本移除的，缓存行已经不在，点一次「扫描游戏库」就回来了）')),
                back ? 'ok' : 'info', 8000);
            });
          }).catch(function (e) { toast(t('放回失败：') + errText(e), 'err'); });
        }
      });
    });
    var body = h('div', { class: 'dialog-body' }, gone.length ? cards : [
      h('p', {
        class: 'note',
        text: isDlss5
          ? t('还没有被移除的游戏。把鼠标移到封面上，点右下角的垃圾桶就能移除。')
          : t('还没有被移除的游戏。在游戏库的卡片上点「从库中移除」，被移除的会出现在这里。')
      })
    ]);
    ov = openOverlay(h('div', { class: 'dialog removed-dialog' }, [
      h('div', { class: 'dialog-head' }, [h('div', { class: 'dt', text: t('已被移除的游戏') })]),
      body
    ]));
  }
  function coverFailCache() {
    try { return JSON.parse(localStorage.getItem('fgm.covers.failed') || '{}'); } catch (e) { return {}; }
  }
  function markCoverFailed(ids) {
    var c = coverFailCache();
    var now = Date.now();
    ids.forEach(function (id) { c[id] = now; });
    try { localStorage.setItem('fgm.covers.failed', JSON.stringify(c)); } catch (e) { }
  }
  // 封面改为**按需加载**：只请求真正渲染出来的那几张；最多 2 个请求并发、每批 8 个。
  // 以前是一次性把全库几百个 appId 都丢给后端下载 —— 启动瞬间几百个网络请求。
  var COVER_Q = [];
  var COVER_INFLIGHT = 0;
  var COVER_PENDING = {};
  var COVER_FAILED = null;
  function lazyCoverFor(id) {
    if (!id || COVERS[id] || COVER_PENDING[id]) return;
    if (!COVER_FAILED) COVER_FAILED = coverFailCache() || {};
    var at = COVER_FAILED[id];
    if (at && Date.now() - at < 7 * 24 * 3600 * 1000) return;
    COVER_PENDING[id] = 1;
    COVER_Q.push(id);
    pumpCovers();
  }
  function pumpCovers() {
    while (COVER_INFLIGHT < 2 && COVER_Q.length) {
      var batch = COVER_Q.splice(0, 8);
      COVER_INFLIGHT++;
      BAR_PHASE = 'cover';
      invoke('fetch_covers', { ids: batch }).then(function () {
        return loadCovers();
      }).then(function () {
        var miss = [];
        batch.forEach(function (id) {
          delete COVER_PENDING[id];
          if (!COVERS[id]) { miss.push(id); return; }
          // 就地换图，不重绘列表（重绘会打乱滚动加载）
          var els = document.querySelectorAll('[data-cover-id="' + id + '"]');
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.tagName === 'IMG') {
              el.src = COVERS[id];
              el.classList.remove('icon');
            } else if (el.parentNode) {
              var img = document.createElement('img');
              img.className = 'thumb';
              img.src = COVERS[id];
              img.alt = '';
              el.parentNode.replaceChild(img, el);
            }
          }
        });
        if (miss.length) markCoverFailed(miss);
      }).catch(function () {
        batch.forEach(function (id) { delete COVER_PENDING[id]; });
      }).then(function () {
        COVER_INFLIGHT--;
        if (!COVER_Q.length && !COVER_INFLIGHT) hideBarIfPhase('cover', 900);
        pumpCovers();
      });
    }
  }
  function wallTile(g, idx) {
    var cov = coverOf(g);
    var ico = iconOf(g);
    var media = cov
      ? h('img', { src: cov, alt: '' })
      : (ico ? h('img', { class: 'icon', src: ico, alt: '' })
             : h('div', { class: 'ph', text: (g.name || '?').slice(0, 1) }));
    return h('div', { class: 'tile', style: '--i:' + idx, on: { click: function () { openDlss5Dialog(g); } } }, [
      media,
      h('div', { class: 'ribbon' + (g.streamline ? ' acc' : ''), text: g.streamline ? t('自带 DLSS') : t('其它') }),
      h('div', { class: 'meta' }, [
        h('div', { class: 'name', text: g.name || t('（无名）') }),
        h('div', { class: 'tag', text: t('图形 API：') + (backText(g.api) || t('未知')) }),
        h('div', { class: 'tag ' + (/^已部署/.test(g.dlss5 || '') ? 'ok' : ''), text: /^已部署/.test(g.dlss5 || '') ? t('DLSS5 已部署') : t('DLSS5 未部署') })
      ])
    ]);
  }
  var DLSS5_REMOVED = (function () {
    try { return JSON.parse(localStorage.getItem('fgm.dlss5.removed') || '[]'); } catch (e) { return []; }
  })();
  function dlss5Key(g) { return String((g && (g.target || g.dir || g.name)) || ''); }
  function dlss5IsRemoved(g) { return DLSS5_REMOVED.indexOf(dlss5Key(g)) >= 0; }
  function dlss5SetRemoved(g, on) {
    var k = dlss5Key(g);
    var i = DLSS5_REMOVED.indexOf(k);
    if (on && i < 0) DLSS5_REMOVED.push(k);
    if (!on && i >= 0) DLSS5_REMOVED.splice(i, 1);
    try { localStorage.setItem('fgm.dlss5.removed', JSON.stringify(DLSS5_REMOVED)); } catch (e) { }
    refreshWall();
  }
  function refreshWall() {
    var a = $('wall-dlss');
    var b = $('wall-other');
    if (!a || !b) return;
    a.textContent = '';
    b.textContent = '';
    var d = GAMES.filter(function (g) { return !!g.streamline && !dlss5IsRemoved(g); });
    var o = GAMES.filter(function (g) { return !g.streamline && !dlss5IsRemoved(g); });
    if ($('c-dlss')) $('c-dlss').textContent = d.length;
    if ($('c-other')) $('c-other').textContent = o.length;
    function put(g, i, host) {
      var tile = wallTile(g, i);
      if (tile && tile.appendChild && !dlss5IsRemoved(g)) {
        tile.appendChild(h('button', {
          class: 'trash', type: 'button', text: '🗑', title: t('从 DLSS5 列表移除（游戏库不受影响）'),
          on: { click: function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            dlss5SetRemoved(g, true);
            toast(t('已从 DLSS5 列表移除：') + (g.name || '') + t('\n（游戏库里的这条还在，可在「已被移除的游戏」放回）'), 'ok', 7000);
          } }
        }));
      }
      host.appendChild(tile);
    }
    d.forEach(function (g, i) { put(g, i, a); });
    o.forEach(function (g, i) { put(g, i, b); });
    if (!d.length) a.appendChild(h('div', { class: 'empty', text: t('没有检测到自带 DLSS 的游戏。') }));
  }
  function openPath(p) {
    if (!p) return;
    invoke('open_path', { path: p }).catch(function (e) { toast(t('打开失败：') + errText(e), 'err'); });
  }
  function openGameDialog(g) {
  // 游戏目录里是 Smooth Motion 的解锁组件（用户先开了 SM）时**不再拦**：按用户定的规则，
  // 这种情况本来就该能部署帧生成 —— 前提是入口避开 version.dll（否则会把解锁组件顶掉）。
  // 所以这里把默认入口自动切到第一个不是 version.dll 的代理，并在入口建议区说明原因。
  var smOwnsDir = /Smooth Motion/.test((g && g.deployed) || '');
    var sel = h('select', { class: 'input' });
    PROXIES.forEach(function (p) { sel.appendChild(h('option', { value: p, text: p })); });
    sel.value = PROXY;
    // SM 占着 version.dll 时：**把这个选项从下拉里直接拿掉**（用户要求：不能让用户继续选
    // version.dll —— 选中就会把解锁组件顶掉）。记忆值恰好是 version.dll 时自动落到第一个其它入口。
    function applyProxyLock() {
      if (!smOwnsDir) return;
      var opt = sel.querySelector('option[value="version.dll"]');
      if (opt) opt.remove();
      if (sel.value === 'version.dll') {
        sel.value = PROXIES.filter(function (p) { return p !== 'version.dll'; })[0] || sel.value;
      }
    }
    applyProxyLock();
    var targetDir = g.target || g.dir || '';
    var targetSel = h('select', { class: 'input' });
    var TARGET_PICK = '__pickdir__';
    function targetCandidates() {
      var out = [];
      function add(p, label, rec) {
        var path = String(p || '');
        if (!path) return;
        var key = path.toLowerCase().replace(/[\\/]+$/, '');
        if (out.some(function (x) { return x.key === key; })) return;
        out.push({ key: key, path: path, label: label, rec: rec });
      }
      add(g.target, t('自动检测的 exe 目录'), true);
      return out;
    }
    function tail2(p) {
      var parts = String(p || '').split('\\').filter(function (x) { return x !== ''; });
      return parts.slice(-2).join('\\');
    }
    function paintTargets() {
      var list = targetCandidates();
      var keepKey = String(targetDir).toLowerCase().replace(/[\\/]+$/, '');
      targetSel.textContent = '';
      var seen = false;
      list.forEach(function (c) {
        if (c.key === keepKey) seen = true;
        targetSel.appendChild(h('option', {
          value: c.path,
          text: (c.rec ? '★ ' : '') + c.label + t('：…\\') + tail2(c.path)
        }));
      });
      if (targetDir && !seen) {
        targetSel.appendChild(h('option', { value: targetDir, text: t('当前：…\\') + tail2(targetDir) }));
      }
      targetSel.appendChild(h('option', { value: TARGET_PICK, text: t('手动选择游戏根目录启动exe…') }));
      targetSel.value = targetDir;
    }
    function pickTargetDir() {
      invoke('pick_game_exe').then(function (r) {
        if (!r || r.canceled) { paintTargets(); return; }
        targetDir = r.dir || targetDir;
        toast((r.updated ? t('已更新游戏库条目：') : t('已加入游戏库：')) + (r.name || '') + '\n' + (r.exe || r.dir || ''), 'ok', 10000);
        paintTargets();
        refreshReady();
        return refreshLibrary();
      }).catch(function (e) {
        toast(t('选择文件夹失败：') + errText(e), 'err', 15000);
        paintTargets();
      });
    }
    paintTargets();
    targetSel.addEventListener('change', function () {
      if (targetSel.value === TARGET_PICK) { pickTargetDir(); return; }
      targetDir = targetSel.value;
      refreshReady();
    });
    var optSel = h('select', { class: 'input' });
    OPT_LABELS.forEach(function (p) { optSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    var frmSel = h('select', { class: 'input' });
    FRAME_LABELS.forEach(function (p) { frmSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    frmSel.value = '3';   // 默认仍选 4X（3X 只是新增选项，别抢默认）
    var preSel = h('select', { class: 'input' });
    PRESET_LABELS.forEach(function (p) { preSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    if (CFG) {
      optSel.value = String(CFG.optimized);
      frmSel.value = String(CFG.frames);
      preSel.value = String(CFG.preset || CFG.defaultPreset || 'C');
    }
    // 进阶开关：超分加速 / 帧生成引擎（XeSS 的两个附属键只在选了 XeSS 时显示）
    var srSel = h('select', { class: 'input' });
    [['Off', t('关（默认）')], ['M-INT8', 'M-INT8'], ['L-INT8', 'L-INT8'], ['M-FP16', 'M-FP16'], ['L-FP16', 'L-FP16']].forEach(function (p) { srSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    srSel.value = srModeSaved();
    var engSel = h('select', { class: 'input' });
    [['DLSS', t('DLSS（默认）')], ['XeSS', t('XeSS（实验）')]].forEach(function (p) { engSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    engSel.value = deployLsGet('engine', 'DLSS');
    var flowSel = h('select', { class: 'input' });
    [['Coarse', t('粗糙（最快）')], ['Middle', t('中等（默认）')], ['Fine', t('精细（最慢）')], ['CoarseAt4K', 'CoarseAt4K']].forEach(function (p) { flowSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    flowSel.value = deployLsGet('flow', 'Middle');
    var hudSel = h('select', { class: 'input' });
    [['Auto', t('自动（默认）')], ['1', t('强制使用')], ['0', t('不用 HUD-less')]].forEach(function (p) { hudSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    hudSel.value = deployLsGet('hudless', 'Auto');
    var flowRow = h('div', { class: 'kv hidden' }, [h('span', { text: t('光流分辨率') }), flowSel]);
    var hudRow = h('div', { class: 'kv hidden' }, [h('span', { text: t('无 HUD 合成') }), hudSel]);
    function syncXessRows() {
      var on = engSel.value === 'XeSS';
      flowRow.classList.toggle('hidden', !on);
      hudRow.classList.toggle('hidden', !on);
    }
    // 倍率上限随引擎联动：XeSS 在 0.4.1 里最多 3（=4X），6X 会导致帧生成不启用
    function syncFrameOptions() {
      var xess = engSel.value === 'XeSS';
      var cur = frmSel.value || '3';
      frmSel.innerHTML = '';
      FRAME_LABELS.forEach(function (p) {
        if (xess) { if (Number(p[0]) > 3) return; }
        frmSel.appendChild(h('option', { value: p[0], text: p[1] }));
      });
      var has = false;
      for (var i = 0; i < frmSel.options.length; i++) {
        if (frmSel.options[i].value === cur) has = true;
      }
      frmSel.value = has ? cur : '3';
      frmSel.title = xess ? t('XeSS 最多 4X（6X 不支持）') : '';
    }
    engSel.addEventListener('change', syncXessRows);
    engSel.addEventListener('change', syncFrameOptions);
    syncXessRows();
    syncFrameOptions();
    var stateLabel = deployLabel(g.deployed);
    var stateEl = h('b', { text: stateLabel, class: stateCls(stateLabel) });
    var legacyBox = null;
    (function () {
      var fga = g.fgAssets;
      if (!fga || !fga.legacy || !fga.leftovers || !fga.leftovers.length) return;
      var mb = function (x) { return (x / 1048576).toFixed(1) + ' MB'; };
      var total = fga.leftovers.reduce(function (a, x) { return a + x.size; }, 0);
      var names = fga.leftovers.map(function (x) { return x.name; }).join(t('、'));
      var cleanBtn = h('button', { class: 'btn small', type: 'button', text: t('清理旧版文件') });
      cleanBtn.addEventListener('click', function () {
        uiConfirm({
          title: t('清理旧版（0.3.x）文件'),
          ok: t('清理'),
          rows: [
            [t('目录'), targetDir],
            [t('要删的文件'), fga.leftovers.map(function (x) { return x.name + t('（') + mb(x.size) + t('）'); }).join(t('、'))]
          ],
          body: t('这些是本项目 0.3.x 时代铺进游戏目录、新版已经不需要的文件。\n') +
                t('删除前会逐个核对内容（哈希）—— 不是你那份就不会动。\n') +
                t('删完记得再点一次「部署」，游戏目录才不会缺文件。')
        }).then(function (yes) {
          if (!yes) return;
          cleanBtn.disabled = true;
          invoke('clean_legacy', { dir: targetDir }).then(function (r) {
            cleanBtn.disabled = false;
            toast((r && r.msg) || t('已清理'), 'ok', 12000);
            return refreshLibrary();
          }).catch(function (e) {
            cleanBtn.disabled = false;
            toast(t('清理失败：') + errText(e), 'warn', 14000);
          });
        });
      });
      legacyBox = h('div', { class: 'kv kvtop' }, [
        h('span', { text: t('旧版文件') }),
        h('div', {}, [
          h('div', { class: 'hint err', text: t('还留着 0.3.x 的 ') + fga.leftovers.length + t(' 个文件（') + mb(total) + t('）：') + names }),
          h('p', { class: 'hint', text: t('这些不会被「部署」自动清掉（无法确认是不是游戏自带的），点下面的按钮由你确认后清理。') }),
          h('div', { class: 'row' }, [cleanBtn])
        ])
      ]);
    })();
    var deployBtn = h('button', { class: 'btn primary', type: 'button', text: t('部署') });
    var restoreBtn = h('button', { class: 'btn', type: 'button', text: t('还原') });
    var manualInstall = deployKind(g.deployed) === 'manual';
    if (deployKind(g.deployed) === 'none') {
      restoreBtn.disabled = true;
      restoreBtn.title = t('这个游戏还没部署过帧生成');
    } else if (manualInstall) {
      // 用户定的规则：无法判定归属时**不许直接部署** —— 按钮锁定，先点红色【清理】。
      restoreBtn.textContent = t('清理');
      restoreBtn.className = 'btn danger';
      restoreBtn.title = t('目录里的帧生成文件无法判定是否为本工具部署：先清理，再部署。');
      deployBtn.disabled = true;
      deployBtn.title = t('检测到无法判定归属的帧生成文件：先点【清理】，清理完再部署。');
    }
    var closeBtn = h('button', { class: 'x', type: 'button', text: '×' });
    var readiness = h('p', { class: 'hint' });
    function refreshReady() {
      var gate = GPU && GPU.gate;
      var drv = fgDriverState();
      if (drv === 'blocked') {
        var drvText = t('未知');
        if (GPU) { if (GPU.driver) drvText = GPU.driver; }
        readiness.className = 'risk strong';
        readiness.textContent = t('帧生成需要 NVIDIA 580.0（R580）以上驱动，当前为 ') + drvText +
          t(' —— 低于该版本时帧生成会被驱动拒绝（表现为“部署成功但游戏里没效果”）。请先更新显卡驱动。');
        deployBtn.disabled = true;
        return;
      }
      if (gate) {
        readiness.className = 'risk strong';
        readiness.textContent = t('不能部署：') + backText(gate);
        deployBtn.disabled = true;
      } else if (!assetHas(sel.value)) {
        readiness.className = 'hint err';
        readiness.textContent = t('资产目录里还没有 ') + sel.value +
          t(' —— 资产目录里还没有它：换一个已就绪的入口，或检查安装是否完整（资产随安装包内置）。');
        deployBtn.disabled = true;
      } else if (manualInstall) {
        readiness.className = 'hint warn';
        readiness.textContent = t('检测到无法判定是否为本工具部署的帧生成文件 —— 部署已锁定：先点【清理】，清理完再部署。');
        deployBtn.disabled = true;
      } else {
        readiness.className = 'hint';
        readiness.textContent = t('资产里已就绪：') + sel.value;
        deployBtn.disabled = false;
      }
      // 读不到驱动版本：不拦，但把风险说清楚（fail-open 但不再静默）
      if (drv === 'unknown') {
        if (!deployBtn.disabled) {
          readiness.className = 'hint warn';
          readiness.textContent = t('无法确认 NVIDIA 驱动版本：若游戏里帧生成不生效，请先把显卡驱动更新到 580.0（R580）以上。');
        }
      }
    }
    refreshReady();
    sel.addEventListener('change', refreshReady);
    var adviceBox = h('div', { class: 'advice' });
    if (smOwnsDir) adviceBox.appendChild(h('div', { class: 'hint warn', text: t('目录里现在是 Smooth Motion 的解锁组件：入口已自动避开 version.dll —— 保持这个选择，Smooth Motion 和帧生成就能共存。') }));
    var adviceBusy = false;
    var smOn = false;
    function paintAdvice(a) {
      adviceBox.textContent = '';
      adviceBox.appendChild(h('div', { class: 'kv2' }, [
        h('span', { text: t('推荐入口') }),
        h('b', { text: a.recommended + (a.undetermined ? t('（未能自动判定）') : '') })
      ]));
      adviceBox.appendChild(h('div', { class: 'hint', text: t('依据：') + (backText(a.reason) || '') + t('（已分析 ') + a.scanned + t(' 个模块）') }));
      (a.ownExisting || []).forEach(function (x) {
        adviceBox.appendChild(h('div', { class: 'hint ok', text: t('✓ 目录里已有本项目的 ') + x.name + t('（') + fmtSize(x.bytes) + t('）— 是本项目文件，可直接覆盖') }));
      });
      (a.occupied || []).forEach(function (x) {
        adviceBox.appendChild(h('div', { class: 'hint warn', text: t('! 目录里已有 ') + x.name + t('（') + fmtSize(x.bytes) + t('，') + backText(x.identity) + t('）— 不是本项目文件，已跳过') }));
      });
      if (a.smLikelyOn) {
        smOn = true;
        // 后端探测到目标目录里是 SM（或驱动疑似开着）：锁死 version.dll 选项
        if (!smOwnsDir) { smOwnsDir = true; applyProxyLock(); }
        adviceBox.appendChild(h('div', { class: 'hint warn', text: '! ' + SM_CONFLICT_TEXT }));
      }
      if (a.undetermined) {
        adviceBox.appendChild(h('div', { class: 'hint', text: t('用的是上游默认入口。如果游戏里没生效，换个入口重新部署试试。') }));
      }
    }
    function runAdvice(first) {
      if (adviceBusy) return;
      adviceBusy = true;
      adviceBox.textContent = '';
      adviceBox.appendChild(h('div', { class: 'hint', text: first ? t('正在按导入表判断该用哪个入口…') : t('正在重新检测…') }));
      invoke('proxy_advice', { dir: targetDir }).then(function (a) {
        if (a && a.recommended && PROXIES.indexOf(a.recommended) >= 0) {
          sel.value = a.recommended;
          refreshReady();
        }
        paintAdvice(a);
        if (!first) {
          toast(a.undetermined
            ? (t('已重新检测：未能自动判定，暂用上游默认 ') + a.recommended)
            : (t('已重新检测：推荐 ') + a.recommended + t('（') + backText(a.reason) + t('）')), 'ok', 9000);
        }
      }).catch(function (e) {
        adviceBox.textContent = '';
        adviceBox.appendChild(h('div', { class: 'hint err', text: t('入口检测失败：') + errText(e) }));
      }).then(function () { adviceBusy = false; });
    }
    runAdvice(true);
    var riskText = t('风险提示：本工具会往游戏目录写入文件，所有改动都有备份记录，可一键还原。');
    var riskCls = 'risk';
    if (g.acKernel) {
      riskText = t('风险提示：这个游戏检出内核级反作弊。注入式方案有封号风险，强烈建议不要在联机游戏里使用。');
      riskCls = 'risk strong';
    } else if (g.acAny) {
      riskText = t('风险提示：这个游戏检出') + g.ac + t('，联机模式下有被判定为异常的风险，请自行判断。');
      riskCls = 'risk strong';
    }
    var dialog = h('div', { class: 'dialog' }, [
      h('div', { class: 'dialog-head' }, [
        gameThumb(g, false),
        h('div', { class: 'dt', text: g.name || t('（无名）') }),
        closeBtn
      ]),
      h('div', { class: 'dialog-body' }, [
        h('div', { class: 'kv kvtop' }, [h('span', { text: t('安装目录') }), h('code', { text: g.dir || '-' })]),
        h('div', { class: 'kv' }, [h('span', { text: t('部署目标') }), targetSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('图形 API') }), h('b', { text: backText(g.api) || t('未知') })]),
        h('div', { class: 'kv' }, [h('span', { text: t('游戏引擎') }), h('b', { text: backText(g.engine) || t('未知') })]),
        h('div', { class: 'kv' }, [
          h('span', { text: t('是否自带DLSS') }),
          g.streamline
            ? h('b', { class: 'ok', text: t('是') })
            : h('b', { class: 'warn', text: t('否——软件检测可能不准确') })
        ]),
        h('div', { class: 'kv' }, [
          h('span', { text: t('反作弊') }),
          g.acKernel ? h('b', { class: 'err', text: g.ac }) : (g.acAny ? h('b', { class: 'warn', text: g.ac }) : h('b', { class: 'ok', text: g.ac || t('未检出') }))
        ]),
        h('div', { class: 'kv' }, [h('span', { text: t('代理入口') }), sel]),
        h('div', { class: 'kv' }, [h('span', { text: t('优化等级') }), optSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('倍率上限') }), frmSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('DLSS-G 预设') }), preSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('超分预设') }), srSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('帧生成引擎') }), engSel]),
        flowRow,
        hudRow,
        h('div', { class: 'kv' }, [h('span', { text: t('部署状态') }), stateEl]),
        legacyBox,
        adviceBox,
        readiness
      ]),
      h('div', { class: 'dialog-foot' }, [
        deployBtn,
        restoreBtn,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', text: t('打开文件夹'), on: { click: function () { openPath(targetDir || g.dir); } } })
      ]),
      h('p', { class: riskCls, text: riskText })
    ]);
    var ov = openOverlay(dialog);
    closeBtn.addEventListener('click', function () { ov.close(); });
    deployBtn.addEventListener('click', function () {
      doDeploy(g, targetDir, sel.value, stateEl, deployBtn, ov, Number(optSel.value), Number(frmSel.value), String(preSel.value || ''), smOn,
        srSel.value, engSel.value, flowSel.value, hudSel.value === '1');
    });
    restoreBtn.addEventListener('click', function () { doRestore(g, targetDir, stateEl, ov); });
  }
  // 上次选择的超分预设（兼容 0.4.0 时代的开关值 0/1）
  function srModeSaved() {
    var v = String(deployLsGet('sr', 'Off'));
    if (v === '1') return 'L-INT8';
    if (v === '0') return 'Off';
    var ok = ['Off', 'M-INT8', 'L-INT8', 'M-FP16', 'L-FP16'];
    return ok.indexOf(v) >= 0 ? v : 'Off';
  }

  function doDeploy(g, targetDir, proxy, stateEl, btn, ov, optimized, frames, preset, smOn, srMode, engine, flow, hudless) {
    var body = t('会先备份被覆盖的原件，之后可以一键还原。');
    if (smOn) body += '\n\n' + SM_CONFLICT_TEXT;
    var dfltPreset = (CFG && CFG.defaultPreset) || 'C';
    if (!(optimized === (CFG ? CFG.defaultOptimized : 2) && frames === (CFG ? CFG.defaultFrames : 3) && preset === dfltPreset)) {
      body += t('\n这几个档位会被写进游戏目录那份 dlssg_sm86.ini（资产里的原文件不动）。');
    }
    if (g.fgAssets && g.fgAssets.leftovers && g.fgAssets.leftovers.length) {
      body += t('\n\n这个目录里还留着旧版（0.3.x）的 ') + g.fgAssets.leftovers.length +
        t(' 个文件，它们不会被自动清理（无法确认是不是游戏自带的）—— 部署完可以用详情里的「清理旧版文件」处理。');
    }
    if (g.acAny) body += t('\n\n注意：这个游戏有反作弊（') + g.ac + t('）。');
    uiConfirm({
      title: t('部署到游戏目录'),
      ok: smOn ? t('仍然部署') : t('开始部署'),
      rows: [
        [t('代理入口'), proxy],
        [t('优化等级'), optLabelOf(optimized)],
        [t('倍率上限'), frmLabelOf(frames)],
        [t('DLSS-G 预设'), presetLabelOf(preset)],
        [t('超分预设'), srMode === 'Off' ? t('关（默认）') : srMode],
        [t('帧生成引擎'), engine],
        [t('部署目标'), targetDir || t('（未指定）')]
      ],
      body: body
    }).then(function (yes) {
      if (!yes) return;
      if (btn) btn.disabled = true;
      stateEl.textContent = t('部署中…');
      stateEl.className = '';
      showBar(t('正在安装…'), 0.35);
      invoke('deploy_game', {
        dir: targetDir, proxy: proxy, optimized: optimized, frames: frames, preset: preset,
        sr: srMode !== 'Off', srMode: srMode, engine: engine, flow: flow, hudless: hudless
      }).then(function (r) {
        rememberDeployLevels(optimized, frames, preset);
        deployLsSet('sr', srMode); deployLsSet('engine', engine);
        deployLsSet('flow', flow); deployLsSet('hudless', hudless ? '1' : '0');
        stateEl.textContent = t('已部署（') + proxy + t('）');
        stateEl.className = 'ok';
        var msg = t('安装完成（优化等级 ') + optLabelOf(optimized) + t('、倍率上限 ') + frmLabelOf(frames) +
          (srMode === 'Off' ? '' : t('、超分预设 ') + srMode) +
          (engine === 'XeSS' ? t('、引擎 XeSS') : '') +
          (preset ? t('、DLSS-G 预设 ') + presetLabelOf(preset) : '') + t('）');
        if (r && r.msg) msg += '\n' + r.msg;
        if (r && r.notes && r.notes.length) msg += '\n\n' + r.notes.join('\n');
        toast(t('已完成'), 'ok', 5000, msg);
        if (ov) ov.close();
        refreshLibrary();
      }).catch(function (e) {
        stateEl.textContent = t('部署失败');
        stateEl.className = 'err';
        toast(t('部署失败：') + errText(e), 'err', 18000);
      }).then(function () {
        if (btn) btn.disabled = false;
        hideBarLater(1800);
      });
    });
  }
  function doRestore(g, targetDir, stateEl, ov) {
    var manual = deployKind(g.deployed) === 'manual';
    var body = manual
      ? t('目录：\n') + (targetDir || '') +
        t('\n\n该目录下的帧生成文件无法判定是否为本工具部署，故没有备份记录。确认清理后会直接删除！')
      : t('目录：\n') + (targetDir || '') + t('\n\n按备份记录把文件恢复原样，并删掉本工具写入的文件，') +
        t('以及插件运行时留下的 dlssg_sm86 目录（日志 / 缓存）。') +
        t('\n\n注意：本工具写入的文件会被「直接删除」（不进回收站）；如果那个位置原本就有文件，会用备份原样放回去。');
    uiConfirm({
      title: manual ? t('清理手动安装的帧生成') : t('还原到部署前'),
      ok: manual ? t('清理') : t('开始还原'),
      danger: manual,
      body: body
    }).then(function (yes) {
      if (!yes) return;
      stateEl.textContent = t('还原中…');
      stateEl.className = '';
      showBar(t('正在还原…'), 0.4);
      invoke('restore', { dir: targetDir }).then(function (r) {
        stateEl.textContent = t('未部署');
        stateEl.className = '';
        toast(t('已还原'), 'ok', 5000, String(r || ''));
        if (ov) ov.close();
        refreshLibrary();
      }).catch(function (e) {
        stateEl.textContent = t('还原失败');
        stateEl.className = 'err';
        toast(t('还原失败：') + errText(e), 'err', 18000);
      }).then(function () { hideBarLater(1800); });
    });
  }
  function openDlss5Dialog(g) {
    var targetDir = g.target || g.dir || '';
    var exePath = g.targetExe || '';
    var exeSel = h('select', { class: 'input' });
    var EXE_PICK = '__pick__';
    var lastExes = [];
    function exeLabel(e) {
      var size = e.size ? t('（') + fmtSize(e.size) + t('）') : '';
      return e.name + size + (e.isBest ? t('  ← 推荐') : '');
    }
    function shortName(p) {
      var parts = String(p || '').split(String.fromCharCode(92));
      return parts[parts.length - 1] || p;
    }
    function paintExes(list) {
      lastExes = list || [];
      var keep = exePath;
      exeSel.textContent = '';
      var seen = false;
      lastExes.forEach(function (e) {
        if (!e || !e.path) return;
        if (e.path === keep) seen = true;
        exeSel.appendChild(h('option', { value: e.path, text: exeLabel(e) }));
      });
      if (keep && !seen) {
        exeSel.appendChild(h('option', { value: keep, text: shortName(keep) }));
      }
      exeSel.appendChild(h('option', { value: EXE_PICK, text: t('手动选择其他 exe…') }));
      if (keep) exeSel.value = keep;
      else if (lastExes.length) exeSel.value = lastExes[0].path;
      else exeSel.value = EXE_PICK;
      if (exeSel.value !== EXE_PICK) exePath = exeSel.value;
    }
    paintExes([]);
    function reloadExes() {
      return invoke('list_exes', { dir: targetDir }).then(function (r) {
        paintExes((r && r.exes) || []);
        refreshReady();
      }).catch(function () { });
    }
    var openFolderBtn = h('button', {
      class: 'btn small', type: 'button', text: t('打开文件夹'),
      on: { click: function () { openPath(g.exists ? targetDir : g.dir); } }
    });
    var apiSel = h('select', { class: 'input' });
    apiSel.appendChild(h('option', { value: 'auto', text: t('自动：当前 API：') + (backText(g.api) || t('未知')) }));
    (DLSS5.apis || []).forEach(function (a) {
      apiSel.appendChild(h('option', { value: a.key, text: backText(a.label) }));
    });
    if (g.dlss5Api && (DLSS5.apis || []).some(function (a) { return a.key === g.dlss5Api; })) {
      apiSel.value = g.dlss5Api;
    }
    var beSel = h('select', { class: 'input' });
    (DLSS5.backends || []).forEach(function (b) {
      beSel.appendChild(h('option', { value: b.key, text: backText(b.label) }));
    });
    if (!beSel.options.length) beSel.appendChild(h('option', { value: 'reshade', text: t('ReShade（Addon）') }));
    var stateLabel = dlss5Label(g.dlss5);
    var stateEl = h('b', { text: stateLabel, class: stateCls(stateLabel) });
    var deployBtn = h('button', { class: 'btn primary', type: 'button', text: t('部署 DLSS5') });
    var restoreBtn = h('button', { class: 'btn', type: 'button', text: t('还原') });
    if (!/^已部署/.test(g.dlss5 || '')) {
      restoreBtn.disabled = true;
      restoreBtn.title = t('这个游戏还没有 DLSS5 的部署记录，没有可还原的东西');
    }
    var closeBtn = h('button', { class: 'x', type: 'button', text: '×' });
    var readiness = h('p', { class: 'hint' });
    function refreshReady() {
      var rk = (GPU && GPU.routeKey) || '';
      var gate = '';
      if (rk && rk !== 'sm86' && rk !== 'sm75') {
        gate = t('DLSS5 的神经网络模型只做了 20/30 系（当前：') + ((GPU && GPU.route) || rk) + t('）');
      } else if (GPU && GPU.gate) {
        gate = GPU.gate;
      }
      var apiUnknown = apiSel.value === 'auto'
        && (!g.api || g.api === '未知' || g.api === t('未知') || g.api === 'Unknown')
        && !g.dlss5Api;
      var missing = (DLSS5.assets && DLSS5.assets.missing) || [];
      if (gate) {
        readiness.className = 'risk strong';
        readiness.textContent = t('不能部署：') + backText(gate);
        deployBtn.disabled = true;
      } else if (FOUND && FOUND.legacy) {
        // 旧版 RenoDX（我们以前的 DLSS5）：用户定的过渡口径 —— 必须先彻底卸载再部署 GITC
        readiness.className = 'hint warn';
        readiness.textContent = t('内置的DLSS5版本已更换至GITC版，插件原生支持DX9/10/11/12、Vulkan、OpenGL，32位/64位游戏。请先删除/卸载DLSS5后重新部署新版本。');
        deployBtn.disabled = true;
      } else if (FOUND && FOUND.anything && !FOUND.ours) {
        // 目录里有 DLSS5 相关文件、但不是本工具部署的 —— 不许直接部署，先卸载清空
        readiness.className = 'hint warn';
        readiness.textContent = t('检测到已装文件但无法判定是否为本工具部署 —— 部署已锁定：先点【卸载 ReShade / DLSS5】清空，再部署。');
        deployBtn.disabled = true;
      } else if (apiUnknown) {
        readiness.className = 'hint warn';
        readiness.textContent = t('图形 API 是「自动」，但这个游戏认不出用哪个 API —— 部署前请在下面手动选一个（DX9/DX10/DX11/DX12/Vulkan/OpenGL）。');
        deployBtn.disabled = false;
      } else if (!exePath) {
        readiness.className = 'hint err';
        readiness.textContent = t('还没认出这个游戏的启动 exe —— 点「手动选择」自己指一个（文件都铺在 exe 所在目录）。');
        deployBtn.disabled = true;
      } else if (missing.length) {
        readiness.className = 'hint err';
        readiness.textContent = t('DLSS5 资产缺 ') + missing.join(t('、')) + t(' —— 重启程序会自动补回内置的那几个。');
        deployBtn.disabled = true;
      } else {
        var names = ((DLSS5.assets && DLSS5.assets.items) || []).map(function (i) { return i.name; });
        readiness.className = 'hint';
        readiness.textContent = names.length ? (t('就绪：') + names.join(t('、'))) : t('资产已就位');
        deployBtn.disabled = false;
      }
    }
    refreshReady();
    apiSel.addEventListener('change', refreshReady);
    invoke('dlss5_assets').then(function (a) {
      DLSS5.assets = a || null;
      refreshReady();
    }).catch(function () { });
    reloadExes();
    exeSel.addEventListener('change', function () {
      if (exeSel.value === EXE_PICK) { pickExe(); return; }
      exePath = exeSel.value;
      refreshReady();
    });
    function pickExe() {
      invoke('pick_game_exe').then(function (r) {
        if (!r || r.canceled) { paintExes(lastExes); return; }
        exePath = r.exe || '';
        if (r.dir) targetDir = r.dir;
        toast((r.updated ? t('已更新游戏库条目：') : t('已加入游戏库：')) + (r.name || '') + '\n' + exePath, 'ok', 10000);
        reloadExes();
        return refreshLibrary();
      }).catch(function (e) {
        toast(t('选择启动 exe 失败：') + errText(e), 'err', 15000);
        paintExes(lastExes);
      });
    }
    var foundEl = h('b', { text: t('检测中…') });
    var uninstallBtn = h('button', { class: 'btn danger', type: 'button', text: t('卸载 ReShade / DLSS5') });
    uninstallBtn.disabled = true;
    var FOUND = null;
    function refreshFound() {
      return invoke('dlss5_detect', { dir: targetDir }).then(function (f) {
        FOUND = f || null;
        var any = !!(f && f.anything);
        var ours = !!(f && f.ours);
        uninstallBtn.classList.toggle('hidden', ours);
        uninstallBtn.disabled = !any || ours;
        uninstallBtn.title = t('永久删除（不进回收站），执行前会再让你确认一次');
        if (ours) {
          foundEl.textContent = backText(f.label);
          foundEl.className = 'ok';
        } else if (any) {
          foundEl.textContent = backText(f.label) + t('　（没有本工具的部署记录 —— 无法自动还原原件，只能清理）');
          foundEl.className = 'warn';
        } else {
          foundEl.textContent = t('未检测到 ReShade / DLSS5');
          foundEl.className = '';
        }
        refreshReady();   // 检测结果变了，部署按钮的锁定状态要跟着重算
        return f;
      }).catch(function (e) {
        foundEl.textContent = t('检测失败：') + errText(e);
        foundEl.className = 'err';
      });
    }
    refreshFound();
    uninstallBtn.addEventListener('click', function () {
      if (!FOUND || !FOUND.anything) return;
      var items = [];
      if (FOUND.reshade_module) items.push(t('ReShade 本体：') + FOUND.reshade_module);
      if (FOUND.reshade_ini) items.push('ReShade.ini');
      if (FOUND.reshade_log) items.push('ReShade.log');
      if (FOUND.preset) items.push('ReShadePreset.ini');
      if (FOUND.shaders_dir) items.push(t('reshade-shaders\\（效果包整个目录）'));
      if (FOUND.addon) items.push(t('DLSS5 插件：') + FOUND.addon);
      if (FOUND.model) items.push(t('神经网络模型：nvngx_dlssnr.dll'));
      if (FOUND.leftovers && FOUND.leftovers.length) items.push(t('插件运行时残留 ') + FOUND.leftovers.length + t(' 个'));
      uiConfirm({
        title: t('确认彻底卸载 ReShade / DLSS5'),
        ok: t('确认'),
        danger: true,
        body: t('目录：\n') + targetDir +
          t('\n\n将被删除的文件：\n· ') + items.join('\n· ') +
          (FOUND.ours
            ? t('\n\n（这套是本工具部署的：「还原」能恢复原件。）')
            : t('\n\n（没有本工具的部署记录：删掉之后没法自动恢复原件。') +
              t('如果你以前用本工具装过、只是记录被清理了，原件可能在：') +
              (FOUND.backupsDir || t('「关于」页显示的「备份目录」')) + t('）')) +
          t('\n\n警告：上述文件将被永久删除！确认后立即执行！')
      }).then(function (yes) {
        if (!yes) return;
        var btn2 = uninstallBtn;
        if (btn2) btn2.disabled = true;
        stateEl.textContent = t('卸载中…');
        stateEl.className = '';
        showBar(t('正在彻底卸载…'), 0.2);
        invoke('dlss5_uninstall', { dir: targetDir, exe: exePath || null }).then(function (r) {
          stateEl.textContent = t('未部署');
          stateEl.className = '';
          // 成功只说一句，细节放复制按钮（用户反馈：长串提示看不过来）
          toast(t('已卸载'), 'ok', 6000, String((r && r.msg) || ''));
          refreshFound();
          refreshLibrary();
        }).catch(function (e) {
          stateEl.textContent = t('卸载失败');
          stateEl.className = 'err';
          toast(t('彻底卸载失败：') + errText(e), 'err', 20000);
        }).then(function () {
          if (btn2) btn2.disabled = false;
          hideBarLater(2000);
        });
      });
    });
    var riskText = t('风险提示：本工具会往游戏目录写入文件，所有改动都有备份记录，可一键还原。');
    var riskCls = 'risk';
    if (g.acKernel) {
      riskText = t('风险提示：这个游戏检出内核级反作弊。注入式方案有封号风险，强烈建议不要在联机游戏里使用。');
      riskCls = 'risk strong';
    } else if (g.acAny) {
      riskText = t('风险提示：这个游戏检出') + g.ac + t('，联机模式下有被判定为异常的风险，请自行判断。');
      riskCls = 'risk strong';
    }
    var dialog = h('div', { class: 'dialog' }, [
      h('div', { class: 'dialog-head' }, [
        gameThumb(g, false),
        h('div', { class: 'dt', text: g.name || t('（无名）') }),
        closeBtn
      ]),
      h('div', { class: 'dialog-body' }, [
        h('div', { class: 'kv kvtop' }, [
          h('span', { text: t('安装目录') }),
          h('div', { class: 'exerow' }, [h('code', { text: g.dir || '-' }), openFolderBtn])
        ]),
        h('div', { class: 'kv' }, [h('span', { text: t('部署目标') }), exeSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('图形 API') }), apiSel]),
        h('div', { class: 'kv' }, [h('span', { text: t('渲染后端') }), beSel]),
        h('div', { class: 'kv' }, [
          h('span', { text: t('是否自带DLSS') }),
          g.streamline
            ? h('b', { class: 'ok', text: t('是') })
            : h('b', { class: 'warn', text: t('否——软件检测可能不准确') })
        ]),
        h('div', { class: 'kv' }, [
          h('span', { text: t('反作弊') }),
          g.acKernel ? h('b', { class: 'err', text: g.ac }) : (g.acAny ? h('b', { class: 'warn', text: g.ac }) : h('b', { class: 'ok', text: g.ac || t('未检出') }))
        ]),
        h('div', { class: 'kv' }, [h('span', { text: t('部署状态') }), stateEl]),
        h('div', { class: 'kv kvtop' }, [h('span', { text: t('已安装的文件') }), foundEl]),
        readiness,
        h('p', { class: 'hint', text: t('装好后进游戏：按 Home 键打开 / 关闭 ReShade 控制面板；键盘上没有 Home 键的话，按 Win+R 输入 osk 回车，用屏幕键盘点。') })
      ]),
      h('div', { class: 'dialog-foot' }, [
        deployBtn,
        restoreBtn,
        uninstallBtn
      ]),
      h('p', { class: riskCls, text: riskText })
    ]);
    var ov = openOverlay(dialog);
    closeBtn.addEventListener('click', function () { ov.close(); });
    deployBtn.addEventListener('click', function () {
      var apiLabel = apiSel.options[apiSel.selectedIndex] ? apiSel.options[apiSel.selectedIndex].text : apiSel.value;
      var beLabel = beSel.options[beSel.selectedIndex] ? beSel.options[beSel.selectedIndex].text : beSel.value;
      var body = t('ReShade 会装到上面的目录，DLSS5 插件与神经网络模型铺在同一个目录；') +
        t('被覆盖的原件都会先备份，可以一键还原。');
      if (g.acAny) body += t('\n\n注意：这个游戏有反作弊（') + g.ac + t('）。');
      var apiText = apiLabel + (apiSel.value === 'auto' ? t('（core 按 EXE 判断：') + (g.api || t('未知')) + t('）') : '');
      uiConfirm({
        title: t('部署 DLSS5 到游戏目录'),
        ok: t('开始部署'),
        rows: [
          [t('图形 API'), apiText, apiSel.value === 'auto' ? 'warn' : 'ok'],
          [t('渲染后端'), beLabel],
          [t('部署目标'), exePath || targetDir || t('（未指定）')]
        ],
        body: body
      }).then(function (yes) {
        if (!yes) return;
        deployBtn.disabled = true;
        stateEl.textContent = t('部署中…');
        stateEl.className = '';
        showBar(t('正在部署 DLSS5…'), 0.15);
        invoke('dlss5_deploy', {
          dir: targetDir,
          exe: exePath || null,
          api: apiSel.value,
          backend: beSel.value
        }).then(function (r) {
          stateEl.textContent = t('已部署 DLSS5');
          stateEl.className = 'ok';
          var detail = '';
          if (r && r.msg) detail += r.msg;
          if (r && r.notes && r.notes.length) detail += (detail ? '\n\n' : '') + r.notes.join('\n');
          toast(t('DLSS5 部署完成'), 'ok', 12000);
          ov.close();
          refreshLibrary();
          uiConfirm({
            title: t('DLSS5 部署完成'),
            ok: t('知道了'),
            single: true,
            rows: [
              [t('打开面板'), t('进游戏后按 Home 键'), null, true],
              [t('没有 Home 键'), t('Win+R 输入 osk 回车，用屏幕键盘点'), null, true]
            ],
            body: t('进游戏后按 Home 键可以打开 / 关闭 DLSS5（ReShade）控制面板，') +
              t('插件与参数都在里面。') + (detail ? '\n\n' + detail : '')
          });
        }).catch(function (e) {
          stateEl.textContent = t('部署失败');
          stateEl.className = 'err';
          toast(t('DLSS5 部署失败：') + errText(e), 'err', 24000);
        }).then(function () {
          deployBtn.disabled = false;
          hideBarLater(1800);
        });
      });
    });
    restoreBtn.addEventListener('click', function () {
      uiConfirm({
        title: t('还原 DLSS5 部署'),
        ok: t('开始还原'),
        body: t('目录：\n') + targetDir +
          t('\n\n按备份记录把 ReShade 本体 / 配置 / 插件 / 模型恢复成部署前的样子；') +
          t('不是本工具放的文件一律不碰。') +
          t('\n\n注意：本工具当初放进去的那些文件会被「直接删除」（不进回收站）；') +
          t('如果那个位置原本就有文件，会用备份原样放回去。')
      }).then(function (yes) {
        if (!yes) return;
        restoreBtn.disabled = true;
        stateEl.textContent = t('还原中…');
        stateEl.className = '';
        showBar(t('正在还原…'), 0.4);
        invoke('dlss5_restore', { dir: targetDir }).then(function (r) {
          stateEl.textContent = t('未部署');
          stateEl.className = '';
          toast(t('已还原'), 'ok', 6000, String((r && r.msg) || ''));
          ov.close();
          refreshLibrary();
          refreshFound();
        }).catch(function (e) {
          stateEl.textContent = t('还原失败');
          stateEl.className = 'err';
          toast(t('DLSS5 还原失败：') + errText(e), 'err', 20000);
        }).then(function () {
          restoreBtn.disabled = false;
          hideBarLater(1800);
        });
      });
    });
  }
  function pickGameExeNow(btn, andThen) {
    busy(btn, t('选择中…'), function () {
      return invoke('pick_game_exe').then(function (r) {
        if (!r || r.canceled) return;
        toast((r.updated ? t('已更新游戏库条目：') : t('已加入游戏库：')) + (r.name || '') + '\n' + (r.exe || r.dir || ''), 'ok', 10000);
        return refreshLibrary().then(function () { return andThen ? andThen() : null; });
      });
    });
  }
  function removeGame(g) {
    uiConfirm({
      title: t('从游戏库移除'),
      ok: t('移除'),
      danger: true,
      body: t('只从列表里移除，游戏目录里的文件一律不碰。\n\n') + (g.name || '') + '\n' + (g.dir || '')
    }).then(function (yes) {
      if (!yes) return;
      invoke('remove_game', { dir: g.dir }).then(function () {
        toast(t('已从游戏库移除：') + (g.name || ''), 'info', 8000);
        return refreshLibrary();
      }).catch(function (e) { toast(t('移除失败：') + errText(e), 'err', 12000); });
    });
  }
  // 检测游戏目录里还是**旧版 DLSS5（RenoDX）**的游戏：提醒先卸载再重装 GITC 版（按版本记一次）。
  function checkDlss5Legacy() {
    return invoke('dlss5_legacy_scan').then(function (r) {
      if (!r || !r.prompt || !(r.games || []).length) return;
      var names = r.games.slice(0, 6).join('\n· ');
      var more = r.games.length > 6 ? t('\n…还有 ') + (r.games.length - 6) + t(' 个') : '';
      uiConfirm({
        title: t('DLSS5 已更换为 GITC 版'),
        ok: t('我知道了'),
        single: true,
        body: t('内置的DLSS5版本已更换至GITC版，插件原生支持DX9/10/11/12、Vulkan、OpenGL，32位/64位游戏。请先删除/卸载DLSS5后重新部署新版本。') +
          '\n\n' + t('以下游戏目录里还是旧版：') + '\n· ' + names + more,
      });
      invoke('dlss5_legacy_prompt_done').catch(function () {  });
    }).catch(function () {  });
  }
  // 检测游戏目录里还是**旧版** Smooth Motion 组件的游戏，提醒一次「先还原后重新部署」。
  // 按程序版本记一次（用户忽略后不反复烦，发新版再提醒）。
  function checkSmLegacy() {
    return invoke('sm_legacy_scan').then(function (r) {
      if (!r || !r.prompt || !(r.games || []).length) return;
      var names = r.games.slice(0, 6).join('\n· ');
      var more = r.games.length > 6 ? t('\n…还有 ') + (r.games.length - 6) + t(' 个') : '';
      uiConfirm({
        title: t('Smooth Motion 组件有新版本'),
        ok: t('我知道了'),
        single: true,
        body: t('Smooth Motion 组件有新版本，建议先还原后重新部署。\n\n以下游戏目录里还是旧版组件：\n· ') + names + more +
          t('\n\n操作：进入「Smooth Motion」页，先对该游戏点「关闭」，再点「开启」即可换上新组件。'),
      });
      invoke('sm_legacy_prompt_done').catch(function () {  });
    }).catch(function () {  });
  }
  // 统一弹窗：列出命中的类别与游戏，【全部清除】串行清理，【暂不处理】按版本记一次。
  function showAssetsLegacyDialog(fgNames, smNames, d5Names) {
    var NL = String.fromCharCode(10);
    var any = fgNames.length > 0;
    if (smNames.length > 0) any = true;
    if (d5Names.length > 0) any = true;
    if (!any) return Promise.resolve();
    var fmt = function (arr) {
      var head = arr.slice(0, 6).join('、');
      if (arr.length <= 6) return head;
      return head + t('…等 ') + arr.length + t(' 个');
    };
    var lines = [];
    if (fgNames.length) lines.push(t('· 帧生成：') + fmt(fgNames));
    if (smNames.length) lines.push(t('· Smooth Motion：') + fmt(smNames));
    if (d5Names.length) lines.push(t('· DLSS5：') + fmt(d5Names));
    // 文案里**只写命中的类别**（用户要求：只有帧生成有更新时，不要再提 SM/DLSS5）
    var names = [];
    if (fgNames.length) names.push(t('帧生成'));
    if (smNames.length) names.push(t('Smooth Motion'));
    if (d5Names.length) names.push(t('DLSS5'));
    var body = t('检测到') + names.join('、') +
      t('资产文件有更新，当前还是旧版本资产文件，是否全部清除后再重新部署？');
    body = body + NL + NL + lines.join(NL);
    return uiConfirm({
      title: t('资产文件有更新'),
      ok: t('全部清除'),
      cancel: t('暂不处理'),
      body: body,
    }).then(function (yes) {
      if (!yes) return;
      var todo = [];
      var byName = function (n) {
        return GAMES.filter(function (x) { return x.name === n; })[0];
      };
      var exeOf = function (g) {
        return g.exe ? g.exe : null;
      };
      fgNames.forEach(function (n) {
        var g = byName(n);
        if (!g) return;
        // 帧生成：先按部署记录**还原**（放回原件/删掉我们铺的文件），再清旧版遗留文件
        todo.push({ cmd: 'restore', args: { dir: g.dir } });
        todo.push({ cmd: 'clean_legacy', args: { dir: g.dir } });
      });
      smNames.forEach(function (n) {
        var g = byName(n);
        if (!g) return;
        // SM：必须走「关闭」这条命令 —— 它会先重置 NVIDIA 驱动 profile，再取回组件文件
        // （只调 sm_asset_restore 会留一个"驱动里还开着"的假状态）
        todo.push({ cmd: 'sm_set_game', args: { name: g.name, exe: exeOf(g) || '', on: false, dir: g.dir } });
        // 再取回组件文件（sm_set_game 只动驱动配置；sandbox 实测文件仍在）
        todo.push({ cmd: 'sm_asset_restore', args: { dir: g.dir, exe: exeOf(g) } });
      });
      d5Names.forEach(function (n) {
        var g = byName(n);
        if (g) todo.push({ cmd: 'dlss5_uninstall', args: { dir: g.dir, exe: exeOf(g) } });
      });
      var done = 0;
      var runNext = function () {
        if (done >= todo.length) {
          // 清完再**复检一次**：还有残留就如实回报，不留"看起来成功其实没清掉"
          return refreshLibrary().catch(function () { }).then(function () {
            var fgLeft = legacyGamesNow().length;
            return Promise.all([
              invoke('sm_legacy_scan').catch(function () { return { games: [] }; }),
              invoke('dlss5_legacy_scan').catch(function () { return { games: [] }; }),
            ]).then(function (arr) {
              var smLeft = (arr[0] && arr[0].games) ? arr[0].games.length : 0;
              var d5Left = (arr[1] && arr[1].games) ? arr[1].games.length : 0;
              var left = fgLeft + smLeft + d5Left;
              if (left > 0) {
                toast(t('仍有旧资产未清除（{n} 处），请到对应页面手动处理', { n: left }), 'warn', 15000);
              } else {
                toast(t('已清除旧资产，请到对应页面重新部署'), 'ok', 12000);
              }
            });
          });
        }
        var job = todo[done++];
        showBar(t('正在清除旧资产…') + ' (' + done + '/' + todo.length + ')', done / todo.length, 'legacy');
        return invoke(job.cmd, job.args).catch(function () { }).then(runNext);
      };
      return runNext().then(function () { hideBarIfPhase('legacy', 1200); });
    });
  }
  // 启动后的统一检查：三类资产任意一类是旧版就弹同一个弹窗（按程序版本只弹一次）。
  function checkAssetsLegacy() {
    if (!CFG) return Promise.resolve();
    var ver = CFG.version ? CFG.version : '';
    if (ver.length > 0) {
      if (CFG.assetsLegacyPrompted === ver) return Promise.resolve();
    }
    var uniq = function (arr) {
      var out = [];
      arr.forEach(function (n) { if (!n) return; if (out.indexOf(n) < 0) out.push(n); });
      return out;
    };
    var fg = legacyGamesNow().map(function (g) { return g.name; });
    return Promise.all([
      invoke('assets_update_scan').catch(function () { return { fg: [], sm: [], dlss5: [] }; }),
      invoke('sm_legacy_scan').catch(function () { return { games: [] }; }),
      invoke('dlss5_legacy_scan').catch(function () { return { games: [] }; }),
    ]).then(function (arr) {
      var u = arr[0] ? arr[0] : {};
      // 指纹判定（新）+ 旧布局判定（老记录没有哈希时兜底）
      var fgAll = uniq(fg.concat(u.fg ? u.fg : []));
      var smLegacy = [];
      if (arr[1]) { if (arr[1].games) smLegacy = arr[1].games; }
      var d5Legacy = [];
      if (arr[2]) { if (arr[2].games) d5Legacy = arr[2].games; }
      var smAll = uniq(smLegacy.concat(u.sm ? u.sm : []));
      var d5All = uniq(d5Legacy.concat(u.dlss5 ? u.dlss5 : []));
      if (!fgAll.length) { if (!smAll.length) { if (!d5All.length) return; } }
      invoke('assets_legacy_prompt_done').catch(function () { });
      return showAssetsLegacyDialog(fgAll, smAll, d5All);
    }).catch(function () { });
  }
  function autoScanLibrary() {
    var before = (GAMES || []).map(function (g) { return g.dir; });
    showBar(t('正在扫描游戏库…'), 0.05, 'scan');
    // 启动时的刷新走轻量模式：只读启动器清单 + 复用缓存，不再逐个游戏重新探测
    // （用户反馈：游戏装得多时每次启动要等 20 分钟）
    return invoke('scan_library', { mode: 'startup' }).then(function (r) {
      if (r && r.stale) {
        // 缓存 schema 过期（探测逻辑升级过）：先秒开显示旧数据，后台静默重探测一次
        setTimeout(function () {
          invoke('scan_library', { mode: 'reprobe' }).then(function () {
            return refreshLibrary();
          }).then(function () {
            toast(t('游戏库已在后台更新'), 'ok', 6000);
          }).catch(function () { });
        }, 1200);
        hideBarIfPhase('scan', 600);
        return refreshLibrary();
      }
      showBar(t('扫描完成，共 ') + r.count + t(' 个游戏'), 1, 'scan');
      hideBarLater(2000);
      return refreshLibrary().then(function () {
        var after = (GAMES || []).map(function (g) { return g.dir; });
        var beforeSet = {}, afterSet = {};
        before.forEach(function (d) { beforeSet[d] = 1; });
        after.forEach(function (d) { afterSet[d] = 1; });
        var added = after.filter(function (d) { return !beforeSet[d]; }).length;
        var removed = before.filter(function (d) { return !afterSet[d]; }).length;
        if (!added && !removed) return;
        var bits = [];
        if (added) bits.push(t('新增 ') + added + t(' 个'));
        if (removed) bits.push(t('移除 ') + removed + t(' 个'));
        toast(t('启动时已更新游戏库：') + bits.join(t('、')), 'ok', 7000);
      });
    }).catch(function (e) {
      hideBarIfPhase('scan', 600);
      toast(t('启动时扫描游戏库失败：') + errText(e), 'err', 12000);
    });
  }
  function scanLibrary() {
    busy($('btn-scan'), t('扫描中…'), function () {
      // 散装目录（D:\Game 这类手放的游戏）的枚举明显更慢：让用户自己选要不要扫
      return uiConfirm({
        title: t('扫描游戏库'),
        ok: t('连同散装目录'),
        body: t('是否同时扫描非启动器目录（例如 D:\\Game 这类手放的游戏）？\n\n· 仅启动器：更快，但扫不到手放的游戏\n· 连同散装目录：更全，但更慢'),
      }).then(function (withLoose) {
        showBar(t('正在扫描游戏库…'), 0.05, 'scan');
        return invoke('scan_library', { mode: withLoose ? 'manual' : 'manual_fast' }).then(function (r) {
          showBar(t('扫描完成，共 ') + r.count + t(' 个游戏'), 1, 'scan');
          hideBarLater(2500);
          var notes = r.notes || [];
          var msg = t('扫描完成：找到 ') + r.count + t(' 个游戏');
          if (r.saved === false) msg += t('\n（缓存写入失败，下次启动不会自动显示）');
          if (notes.length) {
            msg += '\n' + notes.slice(0, 2).join('\n');
            if (notes.length > 2) msg += t('\n…还有 ') + (notes.length - 2) + t(' 条说明，见日志');
          }
          toast(msg, 'ok', 8000);
          return refreshLibrary();
        });
      });
    });
  }
  function setSmText(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }
  function setChips(host, textKey, gray) {
    if (!host) return;
    host.textContent = '';
    host.appendChild(h('span', { class: 'chip' + (gray ? ' gray' : ''), text: t(textKey) }));
  }
  function renderSm() {
    if (!document.getElementById('page-sm')) return Promise.resolve();
    var chips = document.getElementById('sm-chips');
    setChips(chips, '检测中…', true);
    setSmText('sm-note', t('正在读取显卡与驱动…'));
    return invoke('sm_info').then(function (r) {
      var allowed = !!(r && r.allowed);
      if (chips) {
        setChips(chips, allowed ? '可以部署' : '当前不适用', !allowed);
      }
      setSmText('sm-gpu', (r && r.gpu) || t('读不到（需要 NVIDIA 显卡）'));
      setSmText('sm-drv', (r && r.driver) || t('读不到'));
      setSmText('sm-min', (r && r.minDriver) || '616.64');
      var gate = document.getElementById('sm-gate');
      if (gate) {
        if (allowed) {
          gate.className = 'gate hidden';
          gate.textContent = '';
        } else {
          gate.className = 'gate';
          gate.textContent = backText(r && r.reason) || t('当前不适用');
        }
      }
      setSmText('sm-note', allowed
        ? t('驱动满足本工具要求（>=') + ((r && r.minDriver) || '616.64') + t('）。')
        : t('不满足要求时无法部署；原因见上面的提示。'));
      var sub = document.getElementById('sm-sub');
      if (sub) sub.textContent = GAMES.length + t(' 个游戏 · 一个游戏只能启用一个引擎（帧生成 / DLSS5 / Smooth Motion）');
      return paintSmList();
    }).catch(function (e) {
      setSmText('sm-note', t('检测失败：') + errText(e));
      setChips(chips, '检测失败', true);
    });
  }
  function paintSmList() {
    var box = document.getElementById('sm-list');
    if (!box) return Promise.resolve();
    if (!GAMES.length) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'empty', text: t('游戏库是空的 —— 点右上「扫描游戏库」。扫描只读启动器记录，不改动任何游戏文件。') }));
      return Promise.resolve();
    }
    return invoke('sm_game_states', {
      names: GAMES.map(function (g) { return g.name || ''; }),
      exes: GAMES.map(function (g) { return g.targetExe || g.target || ''; }),
    }).then(function (d) {
      var map = {};
      ((d && d.states) || []).forEach(function (s) { map[s.name] = s; });
      var frag = document.createDocumentFragment();
      GAMES.forEach(function (g, i) {
        var st = map[g.name] || {};
        var on = st.value === 1;
        var prof = st.profile
          ? t('驱动配置：') + st.profile + (st.value === null || st.value === undefined ? t('（未设置，跟随全局）') : t('（Smooth Motion = ') + (on ? t('开') : t('关')) + t('）'))
          : t('驱动里还没有这个游戏的配置');
        frag.appendChild(gameCard(g, i, {
          label: on ? t('关闭 Smooth Motion') : t('开启 Smooth Motion'),
          danger: on,
          note: prof,
          onClick: function () { toggleSm(g, !on); },
        }));
      });
      box.textContent = '';
      box.appendChild(frag);
    }).catch(function (e) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'empty', text: t('读取 Smooth Motion 状态失败：') + errText(e) }));
    });
  }
  function toggleSm(g, on) {
    if (!g || !g.name) return;
    var exe = g.targetExe || '';
    if (!exe) {
      toast(t('这个游戏没有识别到启动用的 EXE，先到「帧生成」页确认游戏路径。'), 'warn', 12000);
      return;
    }
    var deployedFg = deployKind(g.deployed) === 'deployed';
    var manualFg = deployKind(g.deployed) === 'manual';
    if (on && (deployedFg || manualFg)) {
      // 帧生成占着 version.dll 时，解锁组件会把它顶掉 —— 这种情况**直接挡住，不让开**：
      // 两个都想用的话，得先开 Smooth Motion、再去帧生成页换一个别的入口（用户定的规则）。
      var fgProxy = (g.fgAssets && g.fgAssets.proxy) || '';
      if (fgProxy === 'version.dll') {
        uiConfirm({
          title: t('这个游戏已经装了帧生成'),
          ok: t('我知道了'),
          single: true,
          danger: true,
          body: t('帧生成DLSS-FG已部署！请勿再开启Smooth Motion！以免导致DLSS-FG失效！若想尝试两个都开启，请先开启Smooth Motion再去帧生成页面部署'),
        });
        return;
      }
      uiConfirm({
        title: t('这个游戏已经装了帧生成'),
        ok: t('仍然开启'),
        body: t('该游戏疑似已经部署了帧生成！不建议继续开启SM！但你可以忽略这条提示继续开启'),
      }).then(function (yes) {
        if (yes) doSmWrite(g, exe, on);
      });
      return;
    }
    if (on && deployKind(g.deployed) === 'occupied') {
      uiConfirm({
        title: t('这个入口文件不是本工具放的'),
        body: t('这个游戏目录里已经有一个不是本工具放的入口文件（') + g.deployed + t('）。\n\n继续会先把它原样备份，再放入 Smooth Motion 的解锁组件；之后可以用关闭或还原取回。\n\n要继续吗？'),
      }).then(function (yes) {
        if (yes) doSmWrite(g, exe, on);
      });
      return;
    }
    if (on && GPU && GPU.routeKey === 'sm75') {
      // RTX 20 支持是本轮新增：上游清单标注「未经实机验证」，部署前如实说明并让用户确认
      uiConfirm({
        title: t('开启 Smooth Motion（RTX 20）'),
        ok: t('仍然开启'),
        body: t('RTX 20 的 Smooth Motion 支持是实验性的：上游标注该运行库未经实机验证。确定继续吗？'),
      }).then(function (yes) {
        if (yes) doSmWrite(g, exe, on);
      });
      return;
    }
    doSmWrite(g, exe, on);
  }
  function doSmWrite(g, exe, on) {
    var dir = g.target || g.dir || '';
    var first = on
      ? invoke('sm_asset_deploy', { dir: dir })
      : Promise.resolve(null);
    return first.then(function (a) {
      return invoke('sm_set_game', { name: g.name, dir: dir, exe: exe, on: !!on }).then(function (r) {
        return { r: r, asset: a };
      });
    }).then(function (o) {
      var r = o.r;
      var extra = on ? backText((o.asset && o.asset.message) || '') : '';
      var tail = !on
        ? invoke('sm_turn_off_game', { name: g.name, dir: dir, exe: exe })
            .then(function (m) { return backText(m && m.message) || t('已关闭'); },
                  function (e) { return { text: t('驱动设置关闭失败：') + errText(e), bad: true }; })
            .then(function (off) {
              return invoke('sm_asset_restore', { dir: dir, exe: exe }).then(function (a) {
                var offText = typeof off === 'string' ? off : off.text;
                var offBad = typeof off === 'string' ? false : !!off.bad;
                return { text: [offText, a && a.message].filter(Boolean).join(t('；')), bad: offBad };
              }, function (e) {
                var offText = typeof off === 'string' ? off : off.text;
                var offBad = typeof off === 'string' ? false : !!off.bad;
                return { text: [offText, t('解锁组件没取回：') + errText(e)].filter(Boolean).join(t('；')), bad: true };
              });
            })
        : Promise.resolve({ text: extra, bad: false });
      return tail.then(function (res) {
        hideBarLater(1200);
        var tailText = (res && res.text) || '';
        var tailBad = !!(res && res.bad);
        var ok = r && r.ok && !tailBad;
        // 用户定的口径：成功只说【已开启】/【已关闭】，长说明一律进日志（core 侧已记录）；
        // 但失败的部分（驱动没写成 / 组件没取回）必须照说，不然没法排障。
        var msg = on ? t('已开启') : t('已关闭');
        if (!ok || tailBad) msg += (tailText ? t('；') + tailText : '');
        toast(msg, ok ? 'ok' : 'warn', ok ? 9000 : 14000);
        // 开关成功后重绘列表（按钮文案/驱动配置行都跟着变）。
        // 驱动侧状态生效偶尔有延迟：800ms 后再兜底重绘一次，避免按钮停在旧状态（用户反馈）。
        var refresh = function () { return paintSmList(); };
        refreshLibrary().catch(function () { }).then(refresh).catch(function () { });
        setTimeout(refresh, 800);
        return r;
      });
    }).catch(function (e) {
      hideBarLater(1200);
      toast(t('Smooth Motion 操作中止：') + errText(e), 'err', 10000);
    });
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
  function startLogLive() {
    var tick = function () { if (!document.hidden) loadLog().catch(function () { }); };
    tick();
    setInterval(tick, 2500);
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
})();