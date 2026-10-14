/* FrameGen Manager (Tauri) 前端 —— 整文件维护，禁止打补丁。
   约定：
     - 所有数据都来自 Rust 命令层（framegen-core 的薄包装），前端不做业务判断；
     - 绝不用 window.alert / window.confirm：系统模态在 WebView 里会弹成
       tauri.localhost 的小窗，观感断裂 —— 统一走页面内弹层（toast / confirm）。*/
(function () {
  'use strict';

  var T = (window.__TAURI__ && window.__TAURI__.core) ? window.__TAURI__.core : null;
  var EV = (window.__TAURI__ && window.__TAURI__.event) ? window.__TAURI__.event : null;

  /* ---------------------------------------------------------------- 主题
     由主进程读系统主题（nativeTheme）后用 URL 参数传进来，页面把它挂到 <html data-theme>，
     样式表用 [data-theme="dark"] 选择深色变量。
     为什么不用 @media (prefers-color-scheme: dark)：那一整块 :root 变量会被 CSS 解析器
     整块丢掉（实测：解析后的样式表里只剩浅色 :root），结果深色模式下是"深底深字"。
     属性写法可测可复现，也不依赖浏览器对媒体查询的重算行为。 */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
  }
  (function () {
    var t = 'light';
    try { t = new URLSearchParams(location.search).get('theme') || 'light'; } catch (e) { t = 'light'; }
    applyTheme(t);
  })();
  if (EV) {
    EV.listen('theme', function (e) {
      var p = (e && e.payload) || {};
      applyTheme(p.theme || 'light');
    });
  }

  // ---------------------------------------------------------------- 兜底报错
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
    banner('JS 错误: ' + m + ' @' + l + ':' + c + (e && e.stack ? '\n' + e.stack : ''));
  };
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    banner('Promise 异常: ' + ((r && r.message) ? r.message : String(r)));
  });

  // ---------------------------------------------------------------- 状态
  // 代理入口名单的真相在 core（PROXY_PRIORITY）：先放一个默认值，get_config 回来就覆盖
  var PROXIES = ['version.dll'];
  var PROXY = 'version.dll';
  var GAMES = [];
  var COVERS = {};
  var REMOVED = [];
  var SCANNED_AT = '';
  var LIB_PATH = '';
  var ASSETS_DIR = '';
  var ASSET_FILES = [];
  /* 游戏 exe 图标：dir -> data URL。core 那边给的是 RGBA 原样字节，这里画进 canvas
     再取 PNG data URL —— 这样 core 不需要带 PNG 编码器。 */
  var ICONS = {};
  var CFG = null;
  var GPU = null;
  var SELF = null;
  /* DLSS5 那份的选项与资产状态。**列表来自 core 的常量**（dlss5_choices / dlss5_assets），
     界面不抄第二份 —— 以后加了渲染后端或换了资产文件名，只有 core 要改。 */
  var DLSS5 = { apis: [], backends: [], assets: null };

  function $(id) { return document.getElementById(id); }
  /* sidecar 的报错会被 Electron 包一层壳：
       Error invoking remote method 'fgm:invoke': Error: 真正的原因
     用户不需要看这层壳（而且它会把中文原因顶到很后面）—— 剥掉，留下的就是 core 的说法。 */
  function errText(e) {
    var m = (e && e.message) ? e.message : String(e);
    m = m.replace(/^Error invoking remote method '[^']*':\s*/, '');
    m = m.replace(/^Error:\s*/, '');
    return m;
  }

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = String(v);
        else if (k === 'on') { for (var ev in v) n.addEventListener(ev, v[ev]); }
        else n.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (kids !== null && kids !== undefined) {
      var arr = Array.isArray(kids) ? kids : [kids];
      for (var i = 0; i < arr.length; i++) {
        var c = arr[i];
        if (c === null || c === undefined || c === false) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }

  function badge(text, cls) {
    return h('span', { class: 'badge' + (cls ? ' ' + cls : ''), text: text });
  }

  /* 关掉 WebView2 的默认右键菜单。
     它不是我们的界面元素，而是浏览器内核自带的（刷新 / 后退 / 另存为…）——
     在一个原生外观的工具里冒出来非常突兀（用户反馈）。 */
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function invoke(cmd, args) {
    if (!T) return Promise.reject(new Error('Tauri 桥不可用（window.__TAURI__ 缺失）'));
    try { return Promise.resolve(T.invoke(cmd, args || {})); }
    catch (e) { return Promise.reject(e); }
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  // ---------------------------------------------------------------- 页面内弹层
  var toastWrap = null;

  function layers() { return $('layers'); }

  /** 替代 window.alert：右下角提示，可点掉，错误停留更久。 */
  function toast(msg, kind, ms) {
    var root = layers();
    if (!root) return null;
    if (!toastWrap) { toastWrap = h('div', { class: 'toasts' }); root.appendChild(toastWrap); }
    var t = h('div', { class: 'toast ' + (kind || 'info'), text: String(msg) });
    t.addEventListener('click', function () { if (t.parentNode) t.parentNode.removeChild(t); });
    toastWrap.appendChild(t);
    while (toastWrap.children.length > 4) toastWrap.removeChild(toastWrap.firstChild);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ms || (kind === 'err' ? 12000 : 6000));
    return t;
  }

  /** 把一个节点挂成页面内模态层。返回 { close }；Esc / 点背景都走 onClose。 */
  /* 记住最后一次按下指针的位置：弹层要「从点下去的地方」长出来。
     写在捕获阶段，一次事件一个赋值，开销可忽略。 */
  var LAST_POINT = { x: -1, y: -1 };
  /* 打开的弹层个数：>0 时给 body 挂 ov-open，页面内容就被模糊掉（见 style.css）。
     用计数是为了支持"详情里再弹确认框"这种叠层，关掉一个不会提前解除。 */
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

  /* 叠层焦点的处理：**只让最上面那一层清晰**，下面已经打开的层模糊掉。
     为什么需要：详情框上再弹一个确认框时，两层文字直接叠在一起，上面那层很难读
     （用户反馈「上一层没模糊，可读性差」）。body.ov-open 只负责模糊页面内容。 */
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
      /* 关闭 = 点掉就没：弹层本体**零帧**消失（直接 display:none，不做淡出），
         只剩背景的暗/糊用 60ms 收干净（--ov-dim-out / --ov-blur-out）。
         为什么这样分：用户对"窗口还在"最敏感，对背景那一层几乎无感。 */
      try {
        if (node && node.style) { node.style.display = 'none'; }
      } catch (e) { /* 设不上就直接摘节点，功能不受影响 */ }
      ov.classList.remove('in');
      setOvOpen(false);
      refreshOverlayFocus();
      setTimeout(function () {
        if (gone) return;
        gone = true;
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        // 摘掉之后重新算一次：下面那层要恢复清晰
        refreshOverlayFocus();
      }, 70);
      if (onClose) onClose();
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    ov.querySelector('.ov-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    if (root) root.appendChild(ov);
    refreshOverlayFocus();
    /* 把缩放原点设到刚才点下去的地方，弹层就从那儿长出来；
       原点限制在弹层自己的框内，免得跑框外变成"从屏幕角落飞进来"。 */
    try {
      if (node && node.getBoundingClientRect && LAST_POINT.x >= 0) {
        var box = node.getBoundingClientRect();
        if (box.width && box.height) {
          var ox = Math.max(0, Math.min(box.width, LAST_POINT.x - box.left));
          var oy = Math.max(0, Math.min(box.height, LAST_POINT.y - box.top));
          node.style.transformOrigin = ox + 'px ' + oy + 'px';
        }
      }
    } catch (e) { /* 量不到就保持居中缩放，不影响功能 */ }
    /* 先强制一次样式计算，让浏览器"看到"初始值（透明 + 半径 0），同一帧再加 .in。
       原来用双 requestAnimationFrame 等两帧（约 33ms），用户能感觉到"点下去迟了一下"；
       读一次 offsetWidth 让样式落定，效果一样但不多等。 */
    void ov.offsetWidth;
    ov.classList.add('in');
    setOvOpen(true);
    /* 聚焦「主要动作」那个按钮：确认框里就是「开始部署 / 移除」，详情里就是「部署」。
       这样回车=确认、Esc=取消，键盘能走完整个流程。
       注意**不能**写成 '.btn.primary, .x' 这种并列选择器：querySelector 返回的是
       「文档顺序里第一个匹配任意一个选择器的元素」，而标题栏那个 × 就在正文按钮前面，
       结果回车会去点关闭（实测踩过）。 */
    var first = node.querySelector('.btn.primary') ||
      node.querySelector('.btn.danger') ||
      node.querySelector('.btn') ||
      node.querySelector('.x');
    if (first) first.focus();
    return { close: close, node: node, overlay: ov };
  }

  /** 替代 window.confirm：返回 Promise<boolean>（取消 / Esc / 点背景都是 false）。
   *
   *  两个可选项是为了「关键信息要看得清」（用户反馈：确认框是半透明玻璃 + 灰色小字，
   *  后面模糊层的高亮内容透过来，根本读不清）：
   *    · opts.rows = [[标签, 值, 可选色调], ...] -> 正文最上面渲染一块醒目的摘要
   *      （部署确认就看这三项：图形 API / 部署目标 / 渲染后端）；
   *    · opts.single = true（或 cancel: null）-> 只留一个「知道了」，用于纯提示框。
   *  样式见 style.css 的 .dialog.confirm：背景做实、正文用正常墨色。 */
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
          // kv = [标签, 值, 可选色调, 可选"不换行"]
          return h('div', { class: 'sum-row' + (kv[3] ? ' nowrap' : '') }, [
            h('span', { class: 'sum-k', text: kv[0] }),
            h('b', { class: 'sum-v' + (kv[2] ? ' ' + kv[2] : ''), text: kv[1] })
          ]);
        })));
      }
      if (opts.body) body.push(h('p', { class: 'note', text: opts.body }));
      var foot = [h('div', { class: 'spacer' })];
      if (!single) {
        foot.push(h('button', { class: 'btn', type: 'button', text: opts.cancel || '取消', on: { click: function () { finish(false); } } }));
      }
      foot.push(h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'button', text: opts.ok || '确定', on: { click: function () { finish(true); } } }));
      var box = h('div', { class: 'dialog narrow confirm' + (opts.rows && opts.rows.length ? ' has-rows' : '') }, [
        h('div', { class: 'dialog-head' }, [h('div', { class: 'dt', text: opts.title || '请确认' })]),
        h('div', { class: 'dialog-body' }, body),
        h('div', { class: 'dialog-foot' }, foot)
      ]);
      // 单按钮的提示框：Esc / 点背景 = 知道了（true），不是"取消"
      ov = openOverlay(box, function () { if (!done) { done = true; resolve(single); } });
    });
  }

  // 任何漏网的系统弹窗都拦回页面内；confirm 返回 false 是安全方向（不误触发破坏性操作）。
  // **注意**：它同步返回 false，所以「把返回值的真假当用户选择」的代码会静默走 false 分支 ——
  // 需要用户确认的地方一律用 uiConfirm(...)（返回 Promise），不要再调 window.confirm。
  window.alert = function (m) { toast(String(m), 'info', 9000); };
  window.confirm = function (m) { uiConfirm({ title: '请确认', body: String(m) }); return false; };

  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error('浏览器拒绝了复制'));
      } catch (e) { reject(e); }
    });
  }

  // ---------------------------------------------------------------- 进度条
  function showBar(msg, f) {
    var bar = $('bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    if (typeof f === 'number' && isFinite(f)) {
      var fill = $('bar-fill');
      if (fill) fill.style.width = Math.max(0, Math.min(100, Math.round(f * 100))) + '%';
    }
    var bt = $('bar-text');
    if (bt) bt.textContent = msg || '';
  }
  function hideBarLater(ms) {
    setTimeout(function () { var bar = $('bar'); if (bar) bar.classList.add('hidden'); }, ms || 2500);
  }

  /* 进度事件节流。
     为什么必须有：下载时 core 每收一块就 emit 一次 progress，一秒钟可能上百条；
     每条都改 DOM + 重排 + 重绘，而我们是**软件渲染** —— 渲染线程直接被打爆，
     WebView 会整片变成黑的（实测：下载 60 秒后窗口全黑，进度条也看不见了）。
     进度条本来就不需要 60fps：合并到最多每 100ms 更新一次，文字与百分比都不丢。*/
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
  }

  /** 按钮忙状态：禁用 + 改字，结束后恢复；fn 抛错统一 toast。 */
  function busy(btn, label, fn) {
    if (!btn) return Promise.resolve().then(fn);
    var old = btn.textContent;
    btn.disabled = true;
    if (label) btn.textContent = label;
    return Promise.resolve()
      .then(fn)
      .catch(function (e) { toast('操作失败：' + errText(e), 'err', 15000); })
      .then(function () { btn.disabled = false; btn.textContent = old; });
  }

  // ---------------------------------------------------------------- 封面
  /* 封面查表：<资产目录>\covers\<名字>.jpg（sidecar 把所有文件按「不含扩展名的文件名」发过来）。
     三种命名都认，因为不是每个游戏都有 Steam appid：
       · Steam appid（auto- 下载下来的就是这种）
       · 启动 exe 的文件名（非 Steam 游戏：把 HogwartsLegacy.jpg 丢进去就行）
       · 游戏名（中文名也认）
     一个都查不到就交给调用方回退（图标 / 首字）。 */
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

  /** 拉一次所有游戏的 exe 图标（列表出来之后再拉，不塞进 list_games 撑包） */
  function loadGameIcons() {
    return invoke('game_icons').then(function (r) {
      var list = (r && r.icons) || [];
      var changed = false;
      list.forEach(function (it) {
        if (ICONS[it.dir]) return;
        try { ICONS[it.dir] = rgbaToDataUrl(it.w, it.h, it.rgba); changed = true; }
        catch (e) { /* 画不出来就退回封面/首字，不影响列表 */ }
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

  // ---------------------------------------------------------------- 显卡 / 路由 / 闸门
  /* 开发/验证用：--fgm-fake-gpu "<型号>" 会把型号透到页面 query 上，
     我们把它交给 core 分类（同一套真实规则），这样在没有那块卡的机器上也能走一遍
     「启动时的显卡警告」。正常启动这个值为空，什么都不影响。 */
  var FAKE_GPU = '';
  try { FAKE_GPU = new URLSearchParams(location.search).get('fakeGpu') || ''; } catch (e) { FAKE_GPU = ''; }

  function refreshGpu() {
    return invoke('gpu_info', FAKE_GPU ? { fakeName: FAKE_GPU } : {}).then(function (g) {
      GPU = g;
      var gpuText = (g.name || '未知显卡') + '　驱动 ' + (g.driver || '未知') +
        (g.driverSrc ? '（' + g.driverSrc + '）' : '');
            if ($('drv')) $('drv').textContent = (g.driver || '未知') + (g.driverSrc ? '（' + g.driverSrc + '）' : '');
      if ($('hags')) $('hags').textContent = g.hags || '未知';
      var box = $('gpu-chips');
      if (box) {
        box.textContent = '';
        box.appendChild(h('span', { class: 'chip', text: g.name || '未知显卡' }));
        box.appendChild(h('span', { class: 'chip ' + (g.gate ? 'gray' : ''), text: '路由 ' + (g.route || '未知') }));
      }
      paintGate(g.gate);
    }).catch(function (e) {
            var box = $('gpu-chips');
      if (box) { box.textContent = ''; box.appendChild(h('span', { class: 'chip gray', text: '读取失败' })); }
      paintGate(null);
      throw e;
    });
  }

  /* 启动时的显卡警告：core 给出「这块卡不该装」的理由时（10/16 系、非 NVIDIA、40/50 系），
     在进应用之前先说清楚，让用户选「继续进入应用」还是「退出应用」。
     为什么要弹：这类用户要么装了也不生效、要么根本不需要，不提醒的话会照着流程走完一遍
     才发现白忙（用户要求）。
     说明：Esc / 点背景 = 继续进入应用 —— **绝不自动退出**，那种意外太糟糕。 */
  var GPU_WARNED = false;

  function warnGpuIfNeeded() {
    if (GPU_WARNED) return;
    var reason = (GPU && GPU.gate) || '';
    if (!reason) return;
    GPU_WARNED = true;
    var name = (GPU && GPU.name) || '未知显卡';
    var route = (GPU && GPU.route) || '未知';
    return new Promise(function (resolve) {
      var done = false;
      var ov = null;
      function finish(v) { if (done) return; done = true; if (ov) ov.close(); resolve(v); }
      var box = h('div', { class: 'dialog narrow' }, [
        h('div', { class: 'dialog-head' }, [h('div', { class: 'dt', text: '这张显卡可能用不了本工具' })]),
        h('div', { class: 'dialog-body' }, [
          h('p', { class: 'risk strong', text: '检测到：' + name + '（' + route + '）' }),
          h('p', { class: 'note', text: reason }),
          h('p', { class: 'note', text: '继续进入应用也没问题：扫描游戏库、DLSS5 浏览、资产文件夹、日志和检查更新都能用，只是「部署」会被挡住 —— 免得装了半天不生效。' })
        ]),
        h('div', { class: 'dialog-foot' }, [
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', type: 'button', text: '退出应用', on: { click: function () { finish('quit'); } } }),
          h('button', { class: 'btn primary', type: 'button', text: '继续进入应用', on: { click: function () { finish('continue'); } } })
        ])
      ]);
      ov = openOverlay(box, function () { if (!done) { done = true; resolve('continue'); } });
    }).then(function (v) {
      if (v === 'quit') {
        // 关掉窗口 -> main.js 的 window-all-closed -> app.quit()
        try { window.close(); } catch (e) { }
      }
    });
  }

  /** 显卡闸门：core 判定的「这块卡不该装」理由（null = 放行） */
  function paintGate(reason) {
    var el = $('gpu-gate');
    if (!el) return;
    if (reason) {
      el.textContent = '不能部署：' + reason;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------- 资产
  function assetHas(name) {
    var n = String(name || '').toLowerCase();
    for (var i = 0; i < ASSET_FILES.length; i++) {
      if (String(ASSET_FILES[i]).toLowerCase() === n) return true;
    }
    return false;
  }

  /* 帧生成 Mod 卡片：按「这一类是什么」分组列，缺的标出来。
     分组由 sidecar 给（帧生成配置 / 代理入口 / 帧生成运行库 / 超分运行库，名字都取自 core 常量）。
     为什么分组而不是平铺：平铺时记录文件（update_state.json）和代理 DLL 会混进「运行库」里，
     看起来莫名其妙（用户反馈）。 */
  function paintMods(box, files, groups, missing, emptyText) {
    if (!box) return;
    box.textContent = '';
    var total = 0;
    var missFiles = 0;   // 按**文件个数**算，不按类别（用户要求）
    (groups || []).forEach(function (g) {
      box.appendChild(h('div', { class: 'modgroup', text: g.title }));
      (g.files || []).forEach(function (f) {
        total++;
        /* 三列固定：名字 / 标签 / 体积。缺少的行也放一个空的体积位，
           否则父级 space-between 会把标签推到最右边，和别的行对不齐（用户反馈）。 */
        var isProxyGroup = /代理/.test(g.title || '');
        var isAltProxy = isProxyGroup && !f.present && String(f.name) !== String(PROXY);
        /* 顺序：标签 / 文件名 / 体积。标签在最左，列宽固定 —— 这样每行的标签、
           名字、体积都各占同一列，不会因为状态不同而错位（用户反馈对不齐）。 */
        var row = h('div', { class: 'mod' });
        if (f.present) {
          row.appendChild(h('span', { class: 'yes', text: '已有' }));
        } else if (isAltProxy) {
          /* 备用入口：部署只要一个入口，缺这些不算"缺少"，也不计入底部计数，
             否则会出现"卡片说缺 5 个、检查更新说 2 个待更新"的矛盾（用户反馈）。 */
          row.appendChild(h('span', { class: 'alt', text: '备用' }));
        } else {
          row.appendChild(h('span', { class: 'no', text: '缺少' }));
          missFiles++;
        }
        row.appendChild(h('b', { text: f.name }));
        row.appendChild(h('span', { class: 'size', text: f.present ? fmtSize(f.size || 0) : '' }));
        box.appendChild(row);
        if (f.hint) box.appendChild(h('div', { class: 'sub', text: f.hint }));
      });
    });
    if (!total) {
      box.appendChild(h('div', { class: 'mod' }, [h('span', { class: 'no', text: emptyText })]));
      return;
    }
    box.setAttribute('data-missing', String(missFiles));
    var grouped = 0;
    (groups || []).forEach(function (g) { grouped += (g.files || []).length; });
    if (missFiles > 0) {
      box.appendChild(h('div', { class: 'hint err', text: '缺少 ' + missFiles + ' 个文件 —— 重启程序会自动补回内置的那几个。' }));
    } else if ((files || []).length > grouped) {
      box.appendChild(h('div', { class: 'sub', text: '另有 ' + ((files || []).length - grouped) + ' 个文件（记录 / 缓存）' }));
    }
  }

  function refreshAssets() {
    return invoke('assets_status').then(function (a) {
      ASSETS_DIR = a.dir || '';
      var files = a.files || [];
      ASSET_FILES = files.map(function (f) { return f.name; });
      if ($('assets-dir')) $('assets-dir').textContent = ASSETS_DIR || '-';
      if ($('assets-count')) $('assets-count').textContent = '共 ' + files.length + ' 个文件';
      paintMods($('mod-list'), files, a.groups || [], a.missing || 0, '资产目录为空 —— 点「下载资产」或「导入压缩包…」');
      return a;
    }).catch(function (e) {
      if ($('assets-count')) $('assets-count').textContent = '读取失败';
      var box = $('mod-list');
      if (box) { box.textContent = ''; box.appendChild(h('div', { class: 'mod' }, [h('span', { class: 'no', text: '读取失败：' + errText(e) })])); }
      throw e;
    });
  }

  /* 拉一次 DLSS5 的下拉选项与资产状态。
     失败不报错：对话框里有兜底（后端下拉至少有一项 reshade），资产缺了部署时 core 也会拦。 */
  function loadDlss5Meta() {
    return Promise.all([
      invoke('dlss5_choices').then(function (c) {
        DLSS5.apis = (c && c.apis) || [];
        DLSS5.backends = (c && c.backends) || [];
      }).catch(function () { }),
      invoke('dlss5_assets').then(function (a) { DLSS5.assets = a || null; }).catch(function () { })
    ]);
  }

  // ---------------------------------------------------------------- 设置
  /* 帧生成部署档位的文案表（对话框里两个下拉用；值本身在 core 里校验） */
  var OPT_LABELS = [
    [0, '0 · 原厂内核，不加速'],
    [1, '1 · 加速，画面与官方逐位一致'],
    [2, '2 · 更快，图像内核轻微有损（默认）'],
    [3, '3 · 最快，全部有损']
  ];
  var FRAME_LABELS = [
    [3, '4X（出厂默认）'],
    [5, '6X（要游戏自带的插件也支持）']
  ];
  /* DLSS-G 渲染预设（0.4.0 的 [DLSSG] Preset）。出厂默认由 core 的 DEFAULT_PRESET 决定
   * （当前 = C / FG Lite：每生成帧 GPU 时间约少 32-54%，画质略低，主要在 HUD 与遮挡边缘）。
   * 「跟随游戏/驱动」= 上游出厂值 Auto，交回游戏和驱动配置决定。 */
  var PRESET_LABELS = [
    ['Auto', '跟随游戏/驱动（Auto）'],
    ['A', 'A · 强制关闭 UI 重组'],
    ['B', 'B · 强制开启 UI 重组（多数游戏无效）'],
    ['C', 'C · FG Lite：开销更低，画质略低（默认）']
  ];

  function fillSelect(sel, pairs, value) {
    if (!sel) return;
    sel.textContent = '';
    pairs.forEach(function (p) {
      sel.appendChild(h('option', { value: p[0], text: p[1] }));
    });
    sel.value = String(value);
  }

  function paintProxySelect() {
    var sel = $('sel-proxy');
    if (!sel) return;
    sel.textContent = '';
    PROXIES.forEach(function (p) { sel.appendChild(h('option', { value: p, text: p })); });
    sel.value = PROXY;
  }

  /* 部署档位不再放设置页 —— 它是**每个游戏、每次部署**才做的决定。
     设置页只留路径 / 日志 / 自更新；配置里的那两个值退化成「上次的选择」。*/
  function optLabelOf(v) {
    for (var i = 0; i < OPT_LABELS.length; i++) {
      if (String(OPT_LABELS[i][0]) === String(v)) return OPT_LABELS[i][1];
    }
    return String(v);
  }
  function frmLabelOf(v) { return Number(v) >= 5 ? '6X' : '4X'; }
  function presetLabelOf(v) {
    var want = String(v || (CFG && CFG.defaultPreset) || 'Auto');
    for (var i = 0; i < PRESET_LABELS.length; i++) {
      if (String(PRESET_LABELS[i][0]) === want) return PRESET_LABELS[i][1];
    }
    return want;
  }

  /** 把这次用的档位记下来当默认值（下次打开详情就是上次的选择） */
  function rememberDeployLevels(optimized, frames, preset) {
    var p = preset || '';
    if (CFG && CFG.optimized === optimized && CFG.frames === frames && (CFG.preset || '') === p) {
      return Promise.resolve();
    }
    return invoke('set_config', { optimized: optimized, frames: frames, preset: p })
      .then(function (c) { CFG = c; return c; })
      .catch(function (e) {
        // 记不住不影响这次部署（值已经在 deploy_game 里传过去了）
        console.warn('记住部署档位失败', e);
      });
  }

  function paintSettings() {
    if (!CFG) return;
    if ($('ver-cur')) $('ver-cur').textContent = 'v' + CFG.version;
    if ($('p-assets')) $('p-assets').textContent = CFG.assetsDir || '-';
    if ($('p-backups')) $('p-backups').textContent = CFG.backupsDir || '-';
    if ($('p-library')) $('p-library').textContent = CFG.libraryPath || '-';
    if ($('p-logs')) $('p-logs').textContent = CFG.logsDir || '-';
  }

  function loadConfig() {
    return invoke('get_config').then(function (c) {
      CFG = c;
      if (c.proxies && c.proxies.length) {
        PROXIES = c.proxies.slice();
        if (PROXIES.indexOf(PROXY) < 0) PROXY = PROXIES[0];
      }
      paintProxySelect();
      paintSettings();
      return c;
    });
  }

  // ---------------------------------------------------------------- 显卡名称伪装
  /* 状态、备份、副作用文案全部来自 core（gpu_spoof_state / gpu::SPOOF_WARNINGS）——
     界面只负责显示与确认，判断一律不在这里。 */
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
        if (note) note.textContent = (s && s.reason) || '读不到显卡信息。';
        return s;
      }
      if (cur) cur.textContent = s.current || '(空)';
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
        restore.title = s.spoofed ? '写回驱动记录的名称，等于彻底去掉伪装' : '当前没有被改过，不需要还原';
      }
      if (note) {
        note.textContent = (s.spoofed ? '已伪装。' : '') +
          '只改 HKLM\\' + (s.enumKey || '') + '\\DeviceDesc 这一个值，改前会把原值备份到 ' +
          (s.backupPath || '(备份目录)') + '。重启后生效，dxdiag / 设备管理器里的名字都会跟着变。';
      }
      return s;
    }).catch(function (e) {
      if ($('spoof-note')) $('spoof-note').textContent = '读取显卡名称状态失败：' + errText(e);
      throw e;
    });
  }

  function spoofApply() {
    if (!SPOOF || !SPOOF.available) return;
    var sel = $('spoof-sel');
    var name = sel ? sel.value : '';
    var warns = (SPOOF.warnings || []).map(function (w) { return '· ' + w; }).join('\n');
    uiConfirm({
      title: '确认修改显卡名称',
      ok: '我了解，改',
      body: '把显卡名改成：\n' + name +
        '\n\n（当前显示：' + (SPOOF.current || '(空)') + '，驱动记录：' + SPOOF.driver + '）' +
        '\n\n动手前请读完这些副作用：\n' + warns
    }).then(function (yes) {
      if (!yes) return;
      var btn = $('btn-spoof-apply');
      if (btn) btn.disabled = true;
      showBar('正在修改显卡名称（没权限时会弹一次 UAC）…', 0.4);
      invoke('gpu_spoof_apply', { name: name }).then(function (r) {
        toast(((r && r.msg) || '已修改') + '\n\n（重启后生效；不满意随时点「还原为原来的名称」）', 'ok', 16000);
        return loadSpoof();
      }).catch(function (e) {
        toast('修改显卡名称失败：' + errText(e), 'err', 20000);
      }).then(function () {
        if (btn) btn.disabled = false;
        hideBarLater(1500);
      });
    });
  }

  function spoofRestore() {
    if (!SPOOF || !SPOOF.available) return;
    uiConfirm({
      title: '确认还原显卡名称',
      ok: '开始还原',
      body: '把显卡名写回驱动记录的名称：\n' + SPOOF.driver +
        '\n\n等于彻底去掉伪装，重启后生效。'
    }).then(function (yes) {
      if (!yes) return;
      var btn = $('btn-spoof-restore');
      if (btn) btn.disabled = true;
      showBar('正在还原显卡名称（没权限时会弹一次 UAC）…', 0.4);
      invoke('gpu_spoof_restore', { to: 'driver' }).then(function (r) {
        toast((r && r.msg) || '已还原', 'ok', 16000);
        return loadSpoof();
      }).catch(function (e) {
        toast('还原显卡名称失败：' + errText(e), 'err', 20000);
      }).then(function () {
        if (btn) btn.disabled = false;
        hideBarLater(1500);
      });
    });
  }

  /* 备份占用情况：设置页显示「N 项 · X MB」，并提供"清理旧备份"。
     清理前必须说清代价：备份是游戏原文件，删了就没法还原已部署的模组了。 */
  function refreshBackups() {
    return invoke('backups_info').then(function (r) {
      var n = (r && r.count) || 0;
      var el = $('bk-info');
      if (el) el.textContent = n ? (n + ' 项 · ' + fmtSize((r && r.bytes) || 0)) : '没有备份';
      var btn = $('btn-clean-backups');
      if (btn) btn.disabled = !n;
    }).catch(function () {
      var el = $('bk-info');
      if (el) el.textContent = '读取失败';
    });
  }

  function loadLog() {
    return invoke('log_tail', { lines: 300 }).then(function (t) {
      var box = $('log-box');
      if (!box) return;
      box.textContent = t ? t : '（日志是空的 —— 还没有操作过，或者日志目录不可写）';
      box.scrollTop = box.scrollHeight;
    }).catch(function (e) {
      var box = $('log-box');
      if (box) box.textContent = '读取日志失败：' + errText(e);
    });
  }

  function checkSelfUpdate() {
    busy($('btn-self-update'), '检查中…', function () {
      return invoke('check_self_update').then(function (r) {
        SELF = r;
        var el = $('ver-latest');
        if (el) {
          el.textContent = r.latest || '读不到';
          el.className = r.hasUpdate ? 'warn' : 'ok';
        }
        if ($('self-note')) {
          $('self-note').textContent = r.hasUpdate
            ? ('有新版本 ' + r.latest + '（当前 v' + r.current + '）—— 会弹窗问你是否现在下载安装；也可以点「打开发布页」自己去下。')
            : ('已是最新（当前 v' + r.current + '）。');
        }
        // 有新版本时，把「本次更新内容」显示在卡片里（可滚动；长文由 core 截断）
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
        toast(r.hasUpdate ? ('发现新版本：' + r.latest) : ('已是最新：v' + r.current), r.hasUpdate ? 'info' : 'ok', 9000);
      });
    });
  }

  // ---------------------------------------------------------------- 游戏库
  /* preferCover=true 时优先封面（DLSS5 卡片墙），否则优先 **exe 图标**（游戏库列表，
     那才是「这个游戏」本来的样子）。两边都取不到就退回首字方块。 */
  function gameThumb(g, preferCover) {
    var cov = coverOf(g);
    var ico = iconOf(g);
    var src = preferCover ? (cov || ico) : (ico || cov);
    if (!src) return h('div', { class: 'thumb ph2', text: (g.name || '?').slice(0, 1) });
    var isIcon = (src === ico && src !== cov);
    return h('img', { class: 'thumb' + (isIcon ? ' icon' : ''), src: src, alt: '' });
  }

  function stateCls(label) {
    var s = label || '';
    if (/^已部署/.test(s)) return 'ok';
    if (/占用/.test(s)) return 'err';
    if (/已安装/.test(s)) return 'warn';
    return 'dim';
  }

  /* 游戏库的一张卡片。可选参数 back = { label, onClick } 时，操作行换成"放回"
     （「已被移除的游戏」用）—— 同一个渲染器，其余页面不受影响。 */
  function gameCard(g, idx, back) {
    /* 帧生成资产版本徽章：哪一套资产 + 随包运行库版本。
       为什么给用户看这个：老用户升级上来后，游戏目录里可能还是 0.3.x 那一套 ——
       帧生成照常能用，但拿不到 0.4.0 的新运行库（310.9.16）和新内核，
       而光看"已部署"三个字完全看不出来（用户要求显示出来）。 */
    var fga = g.fgAssets;
    var assetBadge = fga
      ? badge(
          '资产 ' + fga.version +
          (fga.runtime ? ' · 运行库 ' + fga.runtime : '') +
          (fga.manual ? '（手动）' : ''),
          fga.legacy ? 'warn' : (fga.manual ? 'dim' : 'ok')
        )
      : null;
    var dlss = g.streamline
      ? badge('自带 DLSS', 'acc')
      : badge(g.techScanned ? '未检出 DLSS' : '未检测 DLSS', 'dim');
    var acBadge = g.acKernel ? badge('内核级反作弊', 'err') : (g.acAny ? badge(g.ac, 'warn') : null);
    var badges = h('div', { class: 'badges' }, [
      badge(g.source || '未知', g.manual ? 'dim' : null),
      dlss,
      acBadge,
      badge('API：' + (g.api || '未知'), 'dim'),
      badge('引擎：' + (g.engine || '未知'), 'dim'),
      badge(g.deployed || '未部署', stateCls(g.deployed)),
      assetBadge,
      g.exists ? null : badge('目录不存在', 'err')
    ]);
    return h('div', { class: 'gcard', style: 'animation-delay:' + Math.min(idx * 35, 350) + 'ms' }, [
      h('div', { class: 'gtop' }, [
        gameThumb(g, false),
        h('div', { class: 'ginfo' }, [
          h('div', { class: 'gname', text: g.name || '（无名）' }),
          badges
        ])
      ]),
      h('div', { class: 'gpath', text: g.dir || '' }),
      back && back.note ? h('div', { class: 'gpath', text: back.note }) : null,
      h('div', { class: 'gactions' }, back ? [
        h('button', { class: 'btn ' + (back.danger ? 'danger' : 'primary') + ' small', type: 'button', text: back.label, on: { click: back.onClick } }),
        h('button', { class: 'btn small', type: 'button', text: '打开文件夹', on: { click: function () { openPath(g.exists ? (g.target || g.dir) : g.dir); } } })
      ] : [
        h('button', {
          // 已部署/手动安装时按钮是「还原」/「清理」—— 用红色，避免和「部署」看混
          class: 'btn ' + (/^已部署/.test(g.deployed || '') || /^已安装/.test(g.deployed || '') ? 'danger' : 'primary') + ' small',
          type: 'button',
          // 已经部署过 → 按钮直接是「还原」（点开同一个对话框，里面是还原流程）；
          // 手动装的（无本工具记录）→ 「清理」，同样走那个对话框。
          text: /^已部署/.test(g.deployed || '') ? '还原' : (/^已安装/.test(g.deployed || '') ? '清理' : '部署'),
          on: { click: function () { openGameDialog(g); } },
        }),
        h('button', { class: 'btn small', type: 'button', text: '打开文件夹', on: { click: function () { openPath(g.exists ? g.target : g.dir); } } }),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn small danger', type: 'button', text: '从库中移除', on: { click: function () { removeGame(g); } } })
      ])
    ]);
  }

  function paintLibrary() {
    var box = $('lib-list');
    if (box) {
      box.textContent = '';
      if (!GAMES.length) {
        box.appendChild(h('div', { class: 'empty', text: '游戏库是空的 —— 点右上「扫描游戏库」。扫描只读启动器记录，不改动任何游戏文件。' }));
      } else {
        GAMES.forEach(function (g, i) { box.appendChild(gameCard(g, i)); });
      }
    }
    /* 批量按钮只在真的有旧版游戏时出现（平时不占地方） */
    var legacyGames = GAMES.filter(function (g) { return g.fgAssets && g.fgAssets.legacy; });
    var reBtn = $('btn-redeploy-legacy');
    if (reBtn) {
      if (legacyGames.length) {
        reBtn.classList.remove('hidden');
        reBtn.textContent = '重新部署旧版游戏（' + legacyGames.length + '）';
        reBtn.title = '这些游戏还在用旧版（0.3.x）帧生成资产：' +
          legacyGames.map(function (g) { return g.name; }).join('、');
      } else {
        reBtn.classList.add('hidden');
      }
    }
    if ($('lib-sub')) {
      var s = GAMES.length + ' 个游戏';
      if (SCANNED_AT) s += ' · 上次扫描 ' + SCANNED_AT;
      $('lib-sub').textContent = s;
    }
    refreshWall();
  }

  /** 把一批"还在用旧版资产"的游戏统一重做成当前版本。
   *
   *  顺序有讲究：先 clean_legacy 清掉认得出的 0.3.x 遗留文件，再走正常部署 ——
   *  部署本身只清得掉"记录里记过"的旧运行库，手动装过的那份没有记录，
   *  只能靠 clean_legacy 按哈希逐个核对后删除（别人放的文件一律不碰）。
   *  这一步必须由用户点（我们不会背着他删游戏目录里的东西）。 */
  function redeployLegacy(list, optimized, frames, preset) {
    var ok = [], bad = [];
    var chain = Promise.resolve();
    list.forEach(function (g, i) {
      chain = chain.then(function () {
        showBar('正在重新部署：' + g.name + '（' + (i + 1) + '/' + list.length + '）', (i + 1) / list.length);
        var dir = g.target || g.dir;
        // 清理失败不算致命：部署那一步还会清记录里的旧文件
        return invoke('clean_legacy', { dir: dir })
          .catch(function () { return null; })
          .then(function () {
            var proxy = (g.fgAssets && g.fgAssets.proxy) || PROXY;
            return invoke('deploy_game', {
              dir: dir, proxy: proxy, optimized: optimized, frames: frames, preset: preset
            });
          })
          .then(function () { ok.push(g.name); })
          .catch(function (e) { bad.push(g.name + '（' + errText(e) + '）'); });
      });
    });
    return chain.then(function () {
      hideBarLater(1200);
      var msg = '重新部署完成：成功 ' + ok.length + ' 个';
      if (bad.length) msg += '\n失败 ' + bad.length + ' 个：\n· ' + bad.join('\n· ');
      toast(msg, bad.length ? 'warn' : 'ok', bad.length ? 20000 : 8000);
      return refreshLibrary();
    });
  }

  function legacyGamesNow() {
    return GAMES.filter(function (g) { return g.fgAssets && g.fgAssets.legacy; });
  }

  /** 用户点「重新部署旧版游戏」：先确认（列出是哪些游戏），再干。 */
  function redeployLegacyAll() {
    var list = legacyGamesNow();
    if (!list.length) { toast('没有还在用旧版资产的游戏', 'info', 5000); return Promise.resolve(); }
    var optimized = CFG ? CFG.optimized : 2;
    var frames = CFG ? CFG.frames : 3;
    var preset = (CFG && CFG.preset) || (CFG && CFG.defaultPreset) || 'C';
    return uiConfirm({
      title: '重新部署 ' + list.length + ' 个游戏',
      ok: '全部重新部署',
      rows: [
        ['游戏', list.map(function (g) { return g.name; }).join('、')],
        ['优化等级', optLabelOf(optimized)],
        ['倍率上限', frmLabelOf(frames)],
        ['DLSS-G 预设', presetLabelOf(preset)]
      ],
      body: '会先清掉这些游戏目录里认得出的旧版（0.3.x）帧生成文件，再部署当前版本（0.4.0）。\n' +
            '删除前逐个核对内容，不是你那份就不会动；游戏原件有备份的照常保留，之后仍可单独「还原」。\n\n' +
            '请先完全退出这些游戏 —— 文件被占用会失败。'
    }).then(function (yes) {
      if (!yes) return;
      return redeployLegacy(list, optimized, frames, preset);
    });
  }

  /* 本次运行已经弹过提示了。
     为什么需要它：启动时 refreshLibrary 会被调用好几次（初次加载、扫描完、封面下完），
     每次都会排一个延时调用 —— 两个定时器可能在 set_config 的回包回来之前**同时**触发，
     于是用户看到两个一模一样的提示叠在一起（实测复现）。这个标志是同步置位的，挡得住。 */
  var LEGACY_PROMPT_DONE = false;

  /** 升级后第一次打开：库里还有游戏在用旧版资产时问一句（每个程序版本只问一次）。 */
  function maybePromptLegacyUpgrade() {
    if (!CFG || LEGACY_PROMPT_DONE) return Promise.resolve();
    var ver = CFG.version || '';
    if (!ver || CFG.legacyPrompted === ver) return Promise.resolve();
    var list = legacyGamesNow();
    if (!list.length) return Promise.resolve();
    // 同步置位：后面全是异步，不先挡住就会出现重复提示
    LEGACY_PROMPT_DONE = true;
    var optimized = CFG.optimized;
    var frames = CFG.frames;
    var preset = CFG.preset || CFG.defaultPreset || 'C';
    /* 先记下"问过了"再弹：用户点「稍后」也算问过，否则每次启动都弹一次。 */
    return invoke('set_config', {
      optimized: optimized, frames: frames, preset: preset, legacyPrompted: ver
    }).then(function (c) { CFG = c; }).catch(function () { /* 记不住就下次再问，不致命 */ })
      .then(function () {
        return uiConfirm({
          title: '检测到还在用旧版帧生成的游戏',
          ok: '全部清理并重新部署',
          cancel: '稍后再说',
          rows: [
            ['游戏', list.map(function (g) { return g.name; }).join('、')],
            ['当前资产', '0.3.x（代理 28.6 MB，运行库铺在游戏根目录）'],
            ['新版资产', '0.4.0（运行库进 dlssg_sm86\\ 目录，附 310.9.16 运行库）']
          ],
          body: '新版把运行库和后端搬进了 dlssg_sm86\\ 目录，旧版那几份留在游戏目录里可能被游戏优先加载。\n' +
                '点「全部清理并重新部署」会：先按内容核对删掉旧的 0.3.x 文件，再把新版铺上去。\n\n' +
                '想自己逐个处理就点「稍后再说」：在游戏卡片上能看到「资产 0.3.x」徽章，进去单独部署即可。'
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
      LIB_PATH = (data && data.libraryPath) || '';
      paintLibrary();
      /* 升级后第一次打开时问一句（库里还有旧版部署的话）。
         延迟一点：先让用户看到列表，别一进来就被弹窗糊脸。 */
      setTimeout(function () { maybePromptLegacyUpgrade(); }, 1500);
      // 列表先出来，图标随后到（拉不到就保持封面/首字，不挡列表）
      loadGameIcons();
      // 封面也随后补：本地没有的才去网上下，下完自动重画卡片墙
      ensureCovers();
      return GAMES;
    }).catch(function (e) {
      var box = $('lib-list');
      if (box) {
        box.textContent = '';
        box.appendChild(h('div', { class: 'empty', text: '读取游戏库失败：' + errText(e) }));
      }
      throw e;
    });
  }

  /* 「已被移除的游戏」。游戏库页和 DLSS5 页**共用这一个视图**：
     用和游戏库完全一样的卡片（.gcard）展示，而不是一串路径的列表（用户要求）。
        · kind === 'dlss5'   -> 名单来自 localStorage（只影响 DLSS5 卡片墙）
        · kind === 'library' -> 名单来自 core 的 ignored（list_games 的 removed 字段） */
  function openRemovedDialog(kind) {
    var isDlss5 = kind === 'dlss5';
    var gone = isDlss5 ? GAMES.filter(dlss5IsRemoved) : REMOVED;
    var ov = null;
    var cards = gone.map(function (g, i) {
      return gameCard(g, i, {
        label: isDlss5 ? '放回 DLSS5 列表' : '放回游戏库',
        onClick: function () {
          if (isDlss5) {
            dlss5SetRemoved(g, false);
            toast('已放回 DLSS5 列表：' + (g.name || ''), 'ok', 5000);
            if (ov) ov.close();
            return;
          }
          // 游戏库这条：core 里把 key 从忽略名单里删掉，然后重新拉一遍。
          // 老版本移除时会把缓存行一起删掉，这种条目要等下次扫描才会回来 ——
          // 所以拉完再确认一次，没回来就直说该点「扫描游戏库」。
          var want = String(g.dir || '').toLowerCase();
          invoke('restore_removed', { key: g.key || g.dir }).then(function () {
            if (ov) ov.close();
            return refreshLibrary().then(function () {
              var back = GAMES.some(function (x) { return String(x.dir || '').toLowerCase() === want; });
              toast(back ? ('已放回游戏库：' + (g.name || ''))
                : ('已取消移除：' + (g.name || '') + '\n（这条是旧版本移除的，缓存行已经不在，点一次「扫描游戏库」就回来了）'),
                back ? 'ok' : 'info', 8000);
            });
          }).catch(function (e) { toast('放回失败：' + errText(e), 'err'); });
        }
      });
    });
    var body = h('div', { class: 'dialog-body' }, gone.length ? cards : [
      h('p', {
        class: 'note',
        text: isDlss5
          ? '还没有被移除的游戏。把鼠标移到封面上，点右下角的垃圾桶就能移除。'
          : '还没有被移除的游戏。在游戏库的卡片上点「从库中移除」，被移除的会出现在这里。'
      })
    ]);
    ov = openOverlay(h('div', { class: 'dialog removed-dialog' }, [
      h('div', { class: 'dialog-head' }, [h('div', { class: 'dt', text: '已被移除的游戏' })]),
      body
    ]));
  }

  /* 封面补齐：<资产目录>\covers\<Steam appid>.jpg。
     本地没有的就拉一次（Steam 的竖版封面，缓存到磁盘；每台机器只拉一次，失败就算了）。
     拉不到封面时卡片自动回退到 exe 图标，所以这里**不报错**。 */
  var COVERS_TRIED = false;
  /* 确实没有封面的 appid（比如只有试玩版、没上架竖版图）：记下来，一周内不再重试 ——
     否则每次启动都要为它跑一趟 CDN。存 localStorage，和「已被移除」那套一个思路。 */
  function coverFailCache() {
    try { return JSON.parse(localStorage.getItem('fgm.covers.failed') || '{}'); } catch (e) { return {}; }
  }
  function markCoverFailed(ids) {
    var c = coverFailCache();
    var now = Date.now();
    ids.forEach(function (id) { c[id] = now; });
    try { localStorage.setItem('fgm.covers.failed', JSON.stringify(c)); } catch (e) { }
  }
  function ensureCovers() {
    if (COVERS_TRIED) return;
    var failed = coverFailCache();
    var now = Date.now();
    var WEEK = 7 * 24 * 3600 * 1000;
    var ids = [];
    GAMES.forEach(function (g) {
      var id = (g && g.appId) ? String(g.appId) : '';
      if (!id || COVERS[id] || ids.indexOf(id) >= 0) return;
      if (failed[id] && now - failed[id] < WEEK) return;
      ids.push(id);
    });
    if (!ids.length) { COVERS_TRIED = true; return; }
    COVERS_TRIED = true;
    /* 封面抓取也会发 progress 事件 —— 底部进度条会被点亮成「正在获取封面 1/2」。
       结束时**必须收掉**：以前这里没有收，用户就一直看着那句话挂在底部（用户反馈）。
       只在进度条还停在"封面"那句时才收，免得把别人正在跑的进度条关掉。 */
    function hideCoverBarIfMine() {
      var bt = $('bar-text');
      if (bt && /^正在获取封面/.test(bt.textContent || '')) hideBarLater(1200);
    }
    invoke('fetch_covers', { ids: ids }).then(function (r) {
      // 不管成功几张都要重读一次封面表：成功了要显示，失败的要记下来别再试
      return loadCovers().then(function () {
        var miss = ids.filter(function (id) { return !COVERS[id]; });
        if (miss.length) markCoverFailed(miss);
        if (r && r.fetched) toast('已补齐 ' + r.fetched + ' 张游戏封面（拿不到的还是用 exe 图标）', 'ok', 7000);
        paintLibrary();
      });
    }).catch(function () { }).then(hideCoverBarIfMine);
  }

  // ---------------------------------------------------------------- DLSS5 卡片墙
  function wallTile(g, idx) {
    /* 卡片墙是「看封面挑游戏」：封面优先（和游戏库列表相反）。
       拿不到封面就退回 exe 图标 —— 但**绝不拉伸**：图标只有三四十像素，被 cover
       拉满 168×233 只会糊成一片（用户反馈「封面全是模糊的」就是这个原因）。
       图标走 .icon（contain + 像素对齐），清清楚楚一个小图标，比一片糊强。 */
    var cov = coverOf(g);
    var ico = iconOf(g);
    var media = cov
      ? h('img', { src: cov, alt: '' })
      : (ico ? h('img', { class: 'icon', src: ico, alt: '' })
             : h('div', { class: 'ph', text: (g.name || '?').slice(0, 1) }));
    return h('div', { class: 'tile', style: '--i:' + idx, on: { click: function () { openDlss5Dialog(g); } } }, [
      media,
      h('div', { class: 'ribbon' + (g.streamline ? ' acc' : ''), text: g.streamline ? '自带 DLSS' : '其它' }),
      h('div', { class: 'meta' }, [
        h('div', { class: 'name', text: g.name || '（无名）' }),
        h('div', { class: 'tag', text: '图形 API：' + (g.api || '未知') }),
        h('div', { class: 'tag ' + (/^已部署/.test(g.dlss5 || '') ? 'ok' : ''), text: /^已部署/.test(g.dlss5 || '') ? 'DLSS5 已部署' : 'DLSS5 未部署' })
      ])
    ]);
  }

  /* DLSS5 页面「已被移除」名单：**只影响 DLSS5 卡片墙，不动游戏库**（用户确认的语义）。
     存 localStorage —— Electron 渲染进程持久化，重启还在，不用改 core 的数据结构。
     键用 target（渲染 exe 目录）优先，退回 dir / 名字。 */
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
    /* 封面右下角挂一个红色垃圾桶：从 DLSS5 列表移除（游戏库那条还在）。
       直接 append 进 tile（它本身就是 position:relative），不套外层容器 ——
       套了会把网格项从 .tile 变成包装层，尺寸/aspect-ratio 都要重调。 */
    function put(g, i, host) {
      var t = wallTile(g, i);
      if (t && t.appendChild && !dlss5IsRemoved(g)) {
        t.appendChild(h('button', {
          class: 'trash', type: 'button', text: '🗑', title: '从 DLSS5 列表移除（游戏库不受影响）',
          on: { click: function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            dlss5SetRemoved(g, true);
            toast('已从 DLSS5 列表移除：' + (g.name || '') + '\n（游戏库里的这条还在，可在「已被移除的游戏」放回）', 'ok', 7000);
          } }
        }));
      }
      host.appendChild(t);
    }
    d.forEach(function (g, i) { put(g, i, a); });
    o.forEach(function (g, i) { put(g, i, b); });
    if (!d.length) a.appendChild(h('div', { class: 'empty', text: '没有检测到自带 DLSS 的游戏。' }));
  }

  // ---------------------------------------------------------------- 游戏详情弹层
  function openPath(p) {
    if (!p) return;
    invoke('open_path', { path: p }).catch(function (e) { toast('打开失败：' + errText(e), 'err'); });
  }

  /* 游戏库页面的【部署】= **帧生成部署对话框**（原来的那一版，用户要求换回来）：
     代理入口 + 优化等级 + 倍率上限，走 deploy_game。DLSS5 那一套在 DLSS5 页自己的
     对话框里（openDlss5Dialog），两者互不干扰。 */
  function openGameDialog(g) {
  // Smooth Motion 的解锁组件和帧生成用的是同一个 version.dll ——
  // 它占着的话，帧生成这一步必须停下，否则会把它覆盖掉。
  if (/Smooth Motion/.test((g && g.deployed) || '')) {
    toast('这个游戏目录里是 Smooth Motion 的解锁组件（它和帧生成都用 version.dll）。请先到「Smooth Motion」页把这个游戏关闭或还原，再来部署帧生成。', 'warn', 12000);
    return;
  }
    var sel = h('select', { class: 'input' });
    PROXIES.forEach(function (p) { sel.appendChild(h('option', { value: p, text: p })); });
    sel.value = PROXY;

    /* 部署目标：**目录候选下拉**（用户要求：和 DLSS5 那边一样换成列表）。
       候选是同一个游戏的几层可选目录：
         · 渲染 EXE 所在目录 —— 上游要求 mod 铺在 exe 旁边，所以这是推荐项
         · 它的上一层（有的游戏 exe 在 Binaries\Win64，mod 要放 Binaries 或项目根）
         · 游戏安装根目录 —— 和「手动添加目录」时用户指的那一层一致
       最后一项是「手动选择游戏根目录文件夹…」= 老的文件选择框（选目录并入库）。
       注意：部署/还原/入口建议都跟着这个下拉走（不再是固定的 g.target）。 */
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
      /* 用户要求：**只留两项** —— 自动检测出来的 exe 目录，或者自己手动指一个启动 exe。
         （之前的"上一层目录 / 游戏安装根目录"去掉了：帧生成的文件必须铺在渲染 exe 旁边，
        多给那两层只会让人选错。） */
      add(g.target, '自动检测的 exe 目录', true);
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
          text: (c.rec ? '★ ' : '') + c.label + '：…\\' + tail2(c.path)
        }));
      });
      if (targetDir && !seen) {
        targetSel.appendChild(h('option', { value: targetDir, text: '当前：…\\' + tail2(targetDir) }));
      }
      targetSel.appendChild(h('option', { value: TARGET_PICK, text: '手动选择游戏根目录启动exe…' }));
      targetSel.value = targetDir;
    }
    /* 手动那一项选的是**启动 exe**（不是文件夹）：拿到 exe 后取它所在目录当部署目标，
       走 core 的 pick_game_exe（选 exe -> 取目录 -> 入库/更新那一行）。 */
    function pickTargetDir() {
      invoke('pick_game_exe').then(function (r) {
        if (!r || r.canceled) { paintTargets(); return; }
        targetDir = r.dir || targetDir;
        toast((r.updated ? '已更新游戏库条目：' : '已加入游戏库：') + (r.name || '') + '\n' + (r.exe || r.dir || ''), 'ok', 10000);
        paintTargets();
        refreshReady();
        return refreshLibrary();
      }).catch(function (e) {
        toast('选择文件夹失败：' + errText(e), 'err', 15000);
        paintTargets();
      });
    }
    paintTargets();
    targetSel.addEventListener('change', function () {
      if (targetSel.value === TARGET_PICK) { pickTargetDir(); return; }
      targetDir = targetSel.value;
      refreshReady();
    });

    // 部署档位：**在这个游戏的详情里选**（初值 = 上次用过的那组）
    var optSel = h('select', { class: 'input' });
    OPT_LABELS.forEach(function (p) { optSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    var frmSel = h('select', { class: 'input' });
    FRAME_LABELS.forEach(function (p) { frmSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    /* DLSS-G 渲染预设（0.4.0 的 [DLSSG] Preset）：跟随出厂 / C（FG Lite）。
       C 是上游 0.4.0 新给的档：生成帧的开销明显更低、画质略低。 */
    var preSel = h('select', { class: 'input' });
    PRESET_LABELS.forEach(function (p) { preSel.appendChild(h('option', { value: p[0], text: p[1] })); });
    if (CFG) {
      optSel.value = String(CFG.optimized);
      frmSel.value = String(CFG.frames);
      preSel.value = String(CFG.preset || CFG.defaultPreset || 'C');
    }

    var stateLabel = g.deployed || '未部署';
    var stateEl = h('b', { text: stateLabel, class: stateCls(stateLabel) });
    /* 旧版（0.3.x）遗留文件：列出来 + 一个清理按钮。
       为什么要单独一个按钮：那两份 NVIDIA 运行库既不在新清单里、也无法从签名上认出来
       （NVIDIA 自己签的，游戏自带的也是同一份签名），所以「部署」清不掉它们 ——
       只能由用户点一下，我们逐个核对哈希再删（别人放的文件一律不碰）。 */
    var legacyBox = null;
    (function () {
      var fga = g.fgAssets;
      if (!fga || !fga.legacy || !fga.leftovers || !fga.leftovers.length) return;
      var mb = function (x) { return (x / 1048576).toFixed(1) + ' MB'; };
      var total = fga.leftovers.reduce(function (a, x) { return a + x.size; }, 0);
      var names = fga.leftovers.map(function (x) { return x.name; }).join('、');
      var cleanBtn = h('button', { class: 'btn small', type: 'button', text: '清理旧版文件' });
      cleanBtn.addEventListener('click', function () {
        uiConfirm({
          title: '清理旧版（0.3.x）文件',
          ok: '清理',
          rows: [
            ['目录', targetDir],
            ['要删的文件', fga.leftovers.map(function (x) { return x.name + '（' + mb(x.size) + '）'; }).join('、')]
          ],
          body: '这些是本项目 0.3.x 时代铺进游戏目录、新版已经不需要的文件。\n' +
                '删除前会逐个核对内容（哈希）—— 不是你那份就不会动。\n' +
                '删完记得再点一次「部署」，游戏目录才不会缺文件。'
        }).then(function (yes) {
          if (!yes) return;
          cleanBtn.disabled = true;
          invoke('clean_legacy', { dir: targetDir }).then(function (r) {
            cleanBtn.disabled = false;
            toast((r && r.msg) || '已清理', 'ok', 12000);
            return refreshLibrary();
          }).catch(function (e) {
            cleanBtn.disabled = false;
            toast('清理失败：' + errText(e), 'warn', 14000);
          });
        });
      });
      legacyBox = h('div', { class: 'kv kvtop' }, [
        h('span', { text: '旧版文件' }),
        h('div', {}, [
          h('div', { class: 'hint err', text: '还留着 0.3.x 的 ' + fga.leftovers.length + ' 个文件（' + mb(total) + '）：' + names }),
          h('p', { class: 'hint', text: '这些不会被「部署」自动清掉（无法确认是不是游戏自带的），点下面的按钮由你确认后清理。' }),
          h('div', { class: 'row' }, [cleanBtn])
        ])
      ]);
    })();
    var deployBtn = h('button', { class: 'btn primary', type: 'button', text: '部署' });
    var restoreBtn = h('button', { class: 'btn', type: 'button', text: '还原' });
    /* 没部署过就没有东西可还原 —— 灰掉，不要让人点了才发现没意义（用户要求）。
       注意判据是 g.deployed（core 报告的实际状态），不是本地记忆。 */
    /* 还原按钮的可用性：
         · 「已部署」→ 有备份，正常还原；
         · 「已安装，本工具无记录」→ **用户自己手动装的**。用户要求这种情况也要能还原，
           做法是"没有备份可恢复，只把认得出的帧生成文件删掉"（core 的 cleanup_manual，
           按签名认代理入口）。文案上必须说清楚，别让人以为能恢复原件。
         · 其它（未部署 / 入口被占用）→ 灰掉。 */
    var manualInstall = /^已安装/.test(g.deployed || '');
    if (!/^已部署/.test(g.deployed || '') && !manualInstall) {
      restoreBtn.disabled = true;
      restoreBtn.title = '这个游戏还没部署过帧生成';
    } else if (manualInstall) {
      restoreBtn.textContent = '清理手动安装';
      restoreBtn.title = '目录里的帧生成文件不是本工具放的：可以帮你把它们删掉（没有备份，恢复不了原件）';
    }
    var closeBtn = h('button', { class: 'x', type: 'button', text: '×' });
    var readiness = h('p', { class: 'hint' });

    /* 能不能按下去，由两件事决定（和 Rust 命令层的两道闸门一一对应）：
         1. 显卡闸门：core 说这块卡不该装；
         2. 资产里有没有这个代理入口的 DLL —— 下载是按「当前选中的入口」下的，
            选了没下过的入口直接部署只会失败，不如在这里就说清楚。*/
    function refreshReady() {
      var gate = GPU && GPU.gate;
      if (gate) {
        readiness.className = 'risk strong';
        readiness.textContent = '不能部署：' + gate;
        deployBtn.disabled = true;
      } else if (!assetHas(sel.value)) {
        readiness.className = 'hint err';
        readiness.textContent = '资产目录里还没有 ' + sel.value +
          ' —— 先到左侧「上游资产」把代理入口切到它并「下载 / 更新资产」，或者换一个已就绪的入口。';
        deployBtn.disabled = true;
      } else {
        readiness.className = 'hint';
        readiness.textContent = '资产里已就绪：' + sel.value;
        deployBtn.disabled = false;
      }
    }
    refreshReady();
    sel.addEventListener('change', refreshReady);

    /* 入口推荐：core 的 advise_proxy 按**导入表**判（不是按游戏名，也不是按目录里
       有哪些同名文件）。「重新检测入口」就是再调一次它。*/
    var adviceBox = h('div', { class: 'advice' });
    var adviceBtn = h('button', { class: 'btn small', type: 'button', text: '重新检测入口' });
    var adviceBusy = false;

    function paintAdvice(a) {
      adviceBox.textContent = '';
      adviceBox.appendChild(h('div', { class: 'kv2' }, [
        h('span', { text: '推荐入口' }),
        h('b', { text: a.recommended + (a.undetermined ? '（未能自动判定）' : '') })
      ]));
      adviceBox.appendChild(h('div', { class: 'hint', text: '依据：' + (a.reason || '') + '（已分析 ' + a.scanned + ' 个模块）' }));
      (a.ownExisting || []).forEach(function (x) {
        adviceBox.appendChild(h('div', { class: 'hint ok', text: '✓ 目录里已有本项目的 ' + x.name + '（' + fmtSize(x.bytes) + '）— 是本项目文件，可直接覆盖' }));
      });
      (a.occupied || []).forEach(function (x) {
        adviceBox.appendChild(h('div', { class: 'hint warn', text: '! 目录里已有 ' + x.name + '（' + fmtSize(x.bytes) + '，' + x.identity + '）— 不是本项目文件，已跳过' }));
      });
      if (a.undetermined) {
        adviceBox.appendChild(h('div', { class: 'hint', text: '用的是上游默认入口。如果游戏里没生效，换个入口重新部署试试。' }));
      }
    }

    function runAdvice(first) {
      if (adviceBusy) return;
      adviceBusy = true;
      adviceBtn.disabled = true;
      adviceBox.textContent = '';
      adviceBox.appendChild(h('div', { class: 'hint', text: first ? '正在按导入表判断该用哪个入口…' : '正在重新检测…' }));
      invoke('proxy_advice', { dir: targetDir }).then(function (a) {
        if (a && a.recommended && PROXIES.indexOf(a.recommended) >= 0) {
          sel.value = a.recommended;
          refreshReady();
        }
        paintAdvice(a);
        if (!first) {
          toast(a.undetermined
            ? ('已重新检测：未能自动判定，暂用上游默认 ' + a.recommended)
            : ('已重新检测：推荐 ' + a.recommended + '（' + a.reason + '）'), 'ok', 9000);
        }
      }).catch(function (e) {
        adviceBox.textContent = '';
        adviceBox.appendChild(h('div', { class: 'hint err', text: '入口检测失败：' + errText(e) }));
      }).then(function () { adviceBusy = false; adviceBtn.disabled = false; });
    }
    runAdvice(true);
    adviceBtn.addEventListener('click', function () { runAdvice(false); });

    var riskText = '风险提示：本工具会往游戏目录写入文件，所有改动都有备份记录，可一键还原。';
    var riskCls = 'risk';
    if (g.acKernel) {
      riskText = '风险提示：这个游戏检出内核级反作弊。注入式方案有封号风险，强烈建议不要在联机游戏里使用。';
      riskCls = 'risk strong';
    } else if (g.acAny) {
      riskText = '风险提示：这个游戏检出' + g.ac + '，联机模式下有被判定为异常的风险，请自行判断。';
      riskCls = 'risk strong';
    }

    var dialog = h('div', { class: 'dialog' }, [
      h('div', { class: 'dialog-head' }, [
        gameThumb(g, false),
        h('div', { class: 'dt', text: g.name || '（无名）' }),
        closeBtn
      ]),
      h('div', { class: 'dialog-body' }, [
        /* 路径值会折行，这几行要 kvtop（标签贴第一行）—— 见 style.css 里的说明 */
        h('div', { class: 'kv kvtop' }, [h('span', { text: '安装目录' }), h('code', { text: g.dir || '-' })]),
        h('div', { class: 'kv' }, [h('span', { text: '部署目标' }), targetSel]),
        h('div', { class: 'kv' }, [h('span', { text: '图形 API' }), h('b', { text: g.api || '未知' })]),
        h('div', { class: 'kv' }, [h('span', { text: '游戏引擎' }), h('b', { text: g.engine || '未知' })]),
        h('div', { class: 'kv' }, [
          h('span', { text: '是否自带DLSS' }),
          g.streamline
            ? h('b', { class: 'ok', text: '有（本路线适用）' })
            : h('b', { class: 'warn', text: g.techScanned ? '未检测到 —— 本路线不适用' : '还没检测过（点「扫描游戏库」重算）' })
        ]),
        h('div', { class: 'kv' }, [
          h('span', { text: '反作弊' }),
          g.acKernel ? h('b', { class: 'err', text: g.ac }) : (g.acAny ? h('b', { class: 'warn', text: g.ac }) : h('b', { class: 'ok', text: g.ac || '未检出' }))
        ]),
        h('div', { class: 'kv' }, [h('span', { text: '代理入口' }), sel]),
        h('div', { class: 'kv' }, [h('span', { text: '优化等级' }), optSel]),
        h('div', { class: 'kv' }, [h('span', { text: '倍率上限' }), frmSel]),
        h('div', { class: 'kv' }, [h('span', { text: 'DLSS-G 预设' }), preSel]),
        h('div', { class: 'kv' }, [h('span', { text: '部署状态' }), stateEl]),
        legacyBox,
        adviceBox,
        readiness
      ]),
      h('div', { class: 'dialog-foot' }, [
        deployBtn,
        restoreBtn,
        h('div', { class: 'spacer' }),
        adviceBtn,
        h('button', { class: 'btn small', type: 'button', text: '打开文件夹', on: { click: function () { openPath(targetDir || g.dir); } } })
      ]),
      h('p', { class: riskCls, text: riskText })
    ]);

    var ov = openOverlay(dialog);
    closeBtn.addEventListener('click', function () { ov.close(); });
    deployBtn.addEventListener('click', function () {
      doDeploy(g, targetDir, sel.value, stateEl, deployBtn, ov, Number(optSel.value), Number(frmSel.value), String(preSel.value || ''));
    });
    restoreBtn.addEventListener('click', function () { doRestore(g, targetDir, stateEl, ov); });
  }

  function doDeploy(g, targetDir, proxy, stateEl, btn, ov, optimized, frames, preset) {
    var body = '会先备份被覆盖的原件，之后可以一键还原。';
    var dfltPreset = (CFG && CFG.defaultPreset) || 'C';
    if (!(optimized === (CFG ? CFG.defaultOptimized : 2) && frames === (CFG ? CFG.defaultFrames : 3) && preset === dfltPreset)) {
      body += '\n这几个档位会被写进游戏目录那份 dlssg_sm86.ini（资产里的原文件不动）。';
    }
    if (g.fgAssets && g.fgAssets.leftovers && g.fgAssets.leftovers.length) {
      body += '\n\n这个目录里还留着旧版（0.3.x）的 ' + g.fgAssets.leftovers.length +
        ' 个文件，它们不会被自动清理（无法确认是不是游戏自带的）—— 部署完可以用详情里的「清理旧版文件」处理。';
    }
    if (g.acAny) body += '\n\n注意：这个游戏有反作弊（' + g.ac + '）。';
    uiConfirm({
      title: '部署到游戏目录',
      ok: '开始部署',
      rows: [
        ['代理入口', proxy],
        ['优化等级', optLabelOf(optimized)],
        ['倍率上限', frmLabelOf(frames)],
        ['DLSS-G 预设', presetLabelOf(preset)],
        ['部署目标', targetDir || '（未指定）']
      ],
      body: body
    }).then(function (yes) {
      if (!yes) return;
      if (btn) btn.disabled = true;
      stateEl.textContent = '部署中…';
      stateEl.className = '';
      showBar('正在部署…', 0.35);
      invoke('deploy_game', { dir: targetDir, proxy: proxy, optimized: optimized, frames: frames, preset: preset }).then(function (r) {
        rememberDeployLevels(optimized, frames, preset);
        stateEl.textContent = '已部署（' + proxy + '）';
        stateEl.className = 'ok';
        var msg = '部署完成（优化等级 ' + optLabelOf(optimized) + '、倍率上限 ' + frmLabelOf(frames) +
          (preset ? '、DLSS-G 预设 ' + presetLabelOf(preset) : '') + '）';
        if (r && r.msg) msg += '\n' + r.msg;
        if (r && r.notes && r.notes.length) msg += '\n\n' + r.notes.join('\n');
        toast(msg, 'ok', 15000);
        if (ov) ov.close();
        refreshLibrary();
      }).catch(function (e) {
        stateEl.textContent = '部署失败';
        stateEl.className = 'err';
        toast('部署失败：' + errText(e), 'err', 18000);
      }).then(function () {
        if (btn) btn.disabled = false;
        hideBarLater(1800);
      });
    });
  }

  function doRestore(g, targetDir, stateEl, ov) {
    /* 两种情况分开说（用户要求手动部署过的也能用还原清理）：
         · 有记录：按备份恢复原件 + 删掉我们写的文件；
         · 无记录（用户手动装的）：**没有备份可恢复**，只把认得出的帧生成文件删掉。 */
    var manual = /^已安装/.test(g.deployed || '');
    var body = manual
      ? '目录：\n' + (targetDir || '') +
        '\n\n这个目录里的帧生成文件不是本工具放的，所以没有备份记录：' +
        '\n确认后会把它们直接删除（不进回收站）—— 代理入口（按本项目的签名认）、' +
        'nvngx_dlssg.dll、nvngx_dlss.dll、dlssg_sm86.ini，以及插件运行时在旁边建的 ' +
        'dlssg_sm86 目录（日志 / 缓存）。' +
        '\n\n注意：游戏原件恢复不了（那些文件本来就是你自己放进去的），但目录会回到「没有帧生成的干净状态」。'
      : '目录：\n' + (targetDir || '') + '\n\n按备份记录把文件恢复原样，并删掉本工具写入的文件，' +
        '以及插件运行时留下的 dlssg_sm86 目录（日志 / 缓存）。' +
        '\n\n注意：本工具写入的文件会被「直接删除」（不进回收站）；如果那个位置原本就有文件，会用备份原样放回去。';
    uiConfirm({
      title: manual ? '清理手动安装的帧生成' : '还原到部署前',
      ok: manual ? '清理' : '开始还原',
      danger: manual,
      body: body
    }).then(function (yes) {
      if (!yes) return;
      stateEl.textContent = '还原中…';
      stateEl.className = '';
      showBar('正在还原…', 0.4);
      invoke('restore', { dir: targetDir }).then(function (r) {
        stateEl.textContent = '未部署';
        stateEl.className = '';
        // core 会如实说明这次是"按记录还原"还是"没有记录、只清理了本工具的文件"
        toast(String(r || '已完成还原'), 'ok', 14000);
        if (ov) ov.close();
        refreshLibrary();
      }).catch(function (e) {
        stateEl.textContent = '还原失败';
        stateEl.className = 'err';
        toast('还原失败：' + errText(e), 'err', 18000);
      }).then(function () { hideBarLater(1800); });
    });
  }

  /* ⚠️ 下面这个才是 DLSS5 那一套：DLSS5 页的卡片点开它
     ⚠️ 游戏库那一页的【部署】用的是上面那个 openGameDialog（帧生成的老对话框）——
     用户要求两者分开：帧生成页面换回原来的样子。
     按用户要求改过：
       · 部署目标：目录 -> 可执行 exe 的**下拉列表**（候选来自 core，最后一项是手动选择）；
       · 安装目录右侧直接给【打开文件夹】；
       · 图形 API：只读文字 -> 下拉（默认「自动：当前 API：xxx」+ DX9/DX10/DX11/DX12/Vulkan/OpenGL）；
       · 新增「渲染后端」下拉（选项来自 core 的常量，目前只有 reshade）。
     代理入口 / 优化等级 / 倍率上限三行按要求去掉 —— 这一次不部署帧生成（core 与 sidecar
     里的帧生成命令原样保留，随时可以再接回来）。 */
  function openDlss5Dialog(g) {
    var targetDir = g.target || g.dir || '';
    var exePath = g.targetExe || '';

    /* 部署目标：候选 exe 的**下拉列表**（用户要求：路径改成列表形式）。
       候选与排序来自 core 的 scan::candidate_exes —— 和「自动认渲染 exe」是同一份打分，
       所以第一项就是他原本会选中的那个（标了「← 推荐」）。
       最后一项「手动选择其他 exe…」= 老的文件对话框，候选里没有的 exe 仍能自己指。 */
    var exeSel = h('select', { class: 'input' });
    var EXE_PICK = '__pick__';
    var lastExes = [];
    function exeLabel(e) {
      var size = e.size ? '（' + fmtSize(e.size) + '）' : '';
      return e.name + size + (e.isBest ? '  ← 推荐' : '');
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
        // 库里记着、但候选里没有（用户之前手动指到别处）：补一项，别让它显示成「没选」
        exeSel.appendChild(h('option', { value: keep, text: shortName(keep) }));
      }
      exeSel.appendChild(h('option', { value: EXE_PICK, text: '手动选择其他 exe…' }));
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

    /* 安装目录那一行右侧的【打开文件夹】（用户要求从底部挪到这里） */
    var openFolderBtn = h('button', {
      class: 'btn small', type: 'button', text: '打开文件夹',
      on: { click: function () { openPath(g.exists ? targetDir : g.dir); } }
    });

    var apiSel = h('select', { class: 'input' });
    apiSel.appendChild(h('option', { value: 'auto', text: '自动：当前 API：' + (g.api || '未知') }));
    (DLSS5.apis || []).forEach(function (a) {
      apiSel.appendChild(h('option', { value: a.key, text: a.label }));
    });

    var beSel = h('select', { class: 'input' });
    (DLSS5.backends || []).forEach(function (b) {
      beSel.appendChild(h('option', { value: b.key, text: b.label }));
    });
    if (!beSel.options.length) beSel.appendChild(h('option', { value: 'reshade', text: 'ReShade（Addon）' }));

    var stateLabel = g.dlss5 || '未部署';
    var stateEl = h('b', { text: stateLabel, class: stateCls(stateLabel) });
    var deployBtn = h('button', { class: 'btn primary', type: 'button', text: '部署 DLSS5' });
    var restoreBtn = h('button', { class: 'btn', type: 'button', text: '还原' });
    /* 没部署过就没有东西可还原 —— 灰掉，不要让人点了才发现没意义。
       判据是 core 报的状态（list_games 里的 dlss5 字段），不是本地记忆。 */
    if (!/^已部署/.test(g.dlss5 || '')) {
      restoreBtn.disabled = true;
      restoreBtn.title = '这个游戏还没有 DLSS5 的部署记录，没有可还原的东西';
    }
    var closeBtn = h('button', { class: 'x', type: 'button', text: '×' });
    var readiness = h('p', { class: 'hint' });

    /* 能不能按下去，由三件事决定（和 core 里的闸门一一对应）：
         1. 显卡：DLSS5 的神经网络模型只内置了 20/30 系；
         2. 启动 exe：ReShade 与 DLSS5 的文件全铺在 exe 旁边，指不出 exe 就没法装；
         3. 资产：ReShade 安装器 + 插件 + 模型三件套要齐。 */
    function refreshReady() {
      var rk = (GPU && GPU.routeKey) || '';
      var gate = '';
      if (rk && rk !== 'sm86' && rk !== 'sm75') {
        gate = 'DLSS5 的神经网络模型只做了 20/30 系（当前：' + ((GPU && GPU.route) || rk) + '）';
      } else if (GPU && GPU.gate) {
        gate = GPU.gate;
      }
      /* 自动档 = 让 core 去认这个游戏的图形 API。认不出来时**不替用户猜**：
         core 会直接拒绝部署（dlss5.rs 里的硬闸门），这里先提醒一句，
         但按钮**保持可点** —— 用户要求的是「点了要提醒」，不是点不动。 */
      var apiUnknown = apiSel.value === 'auto' && (!g.api || g.api === '未知' || g.api === 'Unknown');
      var missing = (DLSS5.assets && DLSS5.assets.missing) || [];
      if (gate) {
        readiness.className = 'risk strong';
        readiness.textContent = '不能部署：' + gate;
        deployBtn.disabled = true;
      } else if (apiUnknown) {
        readiness.className = 'hint warn';
        readiness.textContent = '图形 API 是「自动」，但这个游戏认不出用哪个 API —— 部署前请在下面手动选一个（DX9/DX10/DX11/DX12/Vulkan/OpenGL）。';
        deployBtn.disabled = false;
      } else if (!exePath) {
        readiness.className = 'hint err';
        readiness.textContent = '还没认出这个游戏的启动 exe —— 点「手动选择」自己指一个（文件都铺在 exe 所在目录）。';
        deployBtn.disabled = true;
      } else if (missing.length) {
        readiness.className = 'hint err';
        readiness.textContent = 'DLSS5 资产缺 ' + missing.join('、') + ' —— 重启程序会自动补回内置的那几个。';
        deployBtn.disabled = true;
      } else {
        var names = ((DLSS5.assets && DLSS5.assets.items) || []).map(function (i) { return i.name; });
        readiness.className = 'hint';
        readiness.textContent = names.length ? ('就绪：' + names.join('、')) : '资产已就位';
        deployBtn.disabled = false;
      }
    }
    refreshReady();
    // 手动改过图形 API 之后，「认不出来」那句提醒要立刻消失
    apiSel.addEventListener('change', refreshReady);
    /* 打开对话框时再拉一次资产状态：外部改动（用户在资源管理器里删了资产）不会发事件，
       不重拉的话这里会一直显示「就绪」。 */
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

    /* 「手动选择其他 exe…」走 core 的入库逻辑：选 exe -> 取所在目录 -> 入库 / 更新那一行。
       回来之后把这一行的目录也换掉 —— 用户指的 exe 在哪儿，部署就落在哪儿。 */
    function pickExe() {
      invoke('pick_game_exe').then(function (r) {
        if (!r || r.canceled) { paintExes(lastExes); return; }
        exePath = r.exe || '';
        if (r.dir) targetDir = r.dir;
        toast((r.updated ? '已更新游戏库条目：' : '已加入游戏库：') + (r.name || '') + '\n' + exePath, 'ok', 10000);
        reloadExes();
        return refreshLibrary();
      }).catch(function (e) {
        toast('选择启动 exe 失败：' + errText(e), 'err', 15000);
        paintExes(lastExes);
      });
    }

    /* 探测这块目录里到底有没有 ReShade / DLSS5 —— **不看我们的记录也认**：
       用户自己手动装过的同样查得出来，并且给一个「彻底卸载」的出口（用户要求）。
       字段名是 serde 的蛇形命名（reshade_module / shaders_dir…），不是驼峰。 */
    var foundEl = h('b', { text: '检测中…' });
    // 尺寸/内边距和旁边「部署 DLSS5 / 还原」完全一致（就是 .btn 的默认值），
    // 只靠 .danger 换颜色 —— 之前带了 .small，三个按钮高低不齐，看着不协调（用户反馈）。
    var uninstallBtn = h('button', { class: 'btn danger', type: 'button', text: '卸载 ReShade / DLSS5（彻底删除）' });
    uninstallBtn.disabled = true;
    var FOUND = null;

    function refreshFound() {
      return invoke('dlss5_detect', { dir: targetDir }).then(function (f) {
        FOUND = f || null;
        var any = !!(f && f.anything);
        var ours = !!(f && f.ours);
        /* 用户要求：**本工具部署的只给「还原」** —— 「彻底卸载」按钮直接隐藏。
           理由：那些文件是我们放进去的，「还原」能把原件放回来；而彻底卸载是永久删除，
           顺手点错就救不回来了。只有「检测到 ReShade/DLSS5 文件、但没有本工具记录」
           （用户自己装的，或者记录被清理过）才给一个清理出口。 */
        uninstallBtn.classList.toggle('hidden', ours);
        uninstallBtn.disabled = !any || ours;
        uninstallBtn.title = '永久删除（不进回收站），执行前会再让你确认一次';
        if (ours) {
          foundEl.textContent = f.label;
          foundEl.className = 'ok';
        } else if (any) {
          foundEl.textContent = f.label + '　（没有本工具的部署记录 —— 无法自动还原原件，只能清理）';
          foundEl.className = 'warn';
        } else {
          foundEl.textContent = '未检测到 ReShade / DLSS5';
          foundEl.className = '';
        }
        return f;
      }).catch(function (e) {
        foundEl.textContent = '检测失败：' + errText(e);
        foundEl.className = 'err';
      });
    }
    refreshFound();

    uninstallBtn.addEventListener('click', function () {
      if (!FOUND || !FOUND.anything) return;
      var items = [];
      if (FOUND.reshade_module) items.push('ReShade 本体：' + FOUND.reshade_module);
      if (FOUND.reshade_ini) items.push('ReShade.ini');
      if (FOUND.reshade_log) items.push('ReShade.log');
      if (FOUND.preset) items.push('ReShadePreset.ini');
      if (FOUND.shaders_dir) items.push('reshade-shaders\\（效果包整个目录）');
      if (FOUND.addon) items.push('DLSS5 插件：' + FOUND.addon);
      if (FOUND.model) items.push('神经网络模型：nvngx_dlssnr.dll');
      if (FOUND.leftovers && FOUND.leftovers.length) items.push('插件运行时残留 ' + FOUND.leftovers.length + ' 个');
      uiConfirm({
        title: '确认彻底卸载 ReShade / DLSS5',
        ok: '我确认，永久删除',
        danger: true,
        body: '目录：\n' + targetDir +
          '\n\n将被删除的文件：\n· ' + items.join('\n· ') +
          (FOUND.ours
            ? '\n\n（这套是本工具部署的：「还原」能恢复原件。）'
            : '\n\n（没有本工具的部署记录：删掉之后没法自动恢复原件。' +
              '如果你以前用本工具装过、只是记录被清理了，原件可能在：' +
              (FOUND.backupsDir || '设置页显示的「备份目录」') + '）') +
          '\n\n警告：上述文件将被永久删除！确认后立即执行！'
      }).then(function (yes) {
        if (!yes) return;
        var btn2 = uninstallBtn;
        if (btn2) btn2.disabled = true;
        stateEl.textContent = '卸载中…';
        stateEl.className = '';
        showBar('正在彻底卸载…', 0.2);
        invoke('dlss5_uninstall', { dir: targetDir, exe: exePath || null }).then(function (r) {
          stateEl.textContent = '未部署';
          stateEl.className = '';
          toast(((r && r.msg) || '已卸载'), 'ok', 20000);
          refreshFound();
          refreshLibrary();
        }).catch(function (e) {
          stateEl.textContent = '卸载失败';
          stateEl.className = 'err';
          toast('彻底卸载失败：' + errText(e), 'err', 20000);
        }).then(function () {
          if (btn2) btn2.disabled = false;
          hideBarLater(2000);
        });
      });
    });

    var riskText = '风险提示：本工具会往游戏目录写入文件，所有改动都有备份记录，可一键还原。';
    var riskCls = 'risk';
    if (g.acKernel) {
      riskText = '风险提示：这个游戏检出内核级反作弊。注入式方案有封号风险，强烈建议不要在联机游戏里使用。';
      riskCls = 'risk strong';
    } else if (g.acAny) {
      riskText = '风险提示：这个游戏检出' + g.ac + '，联机模式下有被判定为异常的风险，请自行判断。';
      riskCls = 'risk strong';
    }

    var dialog = h('div', { class: 'dialog' }, [
      h('div', { class: 'dialog-head' }, [
        gameThumb(g, false),
        h('div', { class: 'dt', text: g.name || '（无名）' }),
        closeBtn
      ]),
      h('div', { class: 'dialog-body' }, [
        h('div', { class: 'kv kvtop' }, [
          h('span', { text: '安装目录' }),
          h('div', { class: 'exerow' }, [h('code', { text: g.dir || '-' }), openFolderBtn])
        ]),
        h('div', { class: 'kv' }, [h('span', { text: '部署目标' }), exeSel]),
        h('div', { class: 'kv' }, [h('span', { text: '图形 API' }), apiSel]),
        h('div', { class: 'kv' }, [h('span', { text: '渲染后端' }), beSel]),
        h('div', { class: 'kv' }, [
          h('span', { text: '是否自带DLSS' }),
          g.streamline
            ? h('b', { class: 'ok', text: '有（本路线适用）' })
            : h('b', { class: 'warn', text: g.techScanned ? '未检测到 —— 本路线不适用' : '还没检测过（点「扫描游戏库」重算）' })
        ]),
        h('div', { class: 'kv' }, [
          h('span', { text: '反作弊' }),
          g.acKernel ? h('b', { class: 'err', text: g.ac }) : (g.acAny ? h('b', { class: 'warn', text: g.ac }) : h('b', { class: 'ok', text: g.ac || '未检出' }))
        ]),
        h('div', { class: 'kv' }, [h('span', { text: '部署状态' }), stateEl]),
        h('div', { class: 'kv kvtop' }, [h('span', { text: '已安装的文件' }), foundEl]),
        readiness,
        h('p', { class: 'hint', text: '装好后进游戏：按 Home 键打开 / 关闭 ReShade 控制面板；键盘上没有 Home 键的话，按 Win+R 输入 osk 回车，用屏幕键盘点。' })
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
      var body = 'ReShade 会装到上面的目录，DLSS5 插件与神经网络模型铺在同一个目录；' +
        '被覆盖的原件都会先备份，可以一键还原。';
      if (g.acAny) body += '\n\n注意：这个游戏有反作弊（' + g.ac + '）。';
      /* 关键三项做成醒目摘要（用户反馈：原来写成灰色小字，根本注意不到）；
         「自动」档顺带把 core 认出来的 API 写出来，免得用户以为自动就万事大吉。 */
      var apiText = apiLabel + (apiSel.value === 'auto' ? '（core 按 EXE 判断：' + (g.api || '未知') + '）' : '');
      uiConfirm({
        title: '部署 DLSS5 到游戏目录',
        ok: '开始部署',
        rows: [
          ['图形 API', apiText, apiSel.value === 'auto' ? 'warn' : 'ok'],
          ['渲染后端', beLabel],
          ['部署目标', exePath || targetDir || '（未指定）']
        ],
        body: body
      }).then(function (yes) {
        if (!yes) return;
        deployBtn.disabled = true;
        stateEl.textContent = '部署中…';
        stateEl.className = '';
        /* 安装器要跑几秒到几十秒（要写文件、要核对），底部进度条同时收 core 的 progress 事件 */
        showBar('正在部署 DLSS5…', 0.15);
        invoke('dlss5_deploy', {
          dir: targetDir,
          exe: exePath || null,
          api: apiSel.value,
          backend: beSel.value
        }).then(function (r) {
          stateEl.textContent = '已部署 DLSS5';
          stateEl.className = 'ok';
          var detail = '';
          if (r && r.msg) detail += r.msg;
          if (r && r.notes && r.notes.length) detail += (detail ? '\n\n' : '') + r.notes.join('\n');
          toast('DLSS5 部署完成', 'ok', 12000);
          ov.close();
          refreshLibrary();
          /* 用户要求：部署完成后**弹一个提示框**提醒进游戏按 Home 开控制面板 ——
             第一次用的人最需要知道的就是这个（不然会以为没装成功）。 */
          uiConfirm({
            title: 'DLSS5 部署完成',
            ok: '知道了',
            single: true,
            rows: [
              // 第四项 = 这一行**不换行**（用户要求：「没有 Home 键」那句别折行）
              ['打开面板', '进游戏后按 Home 键', null, true],
              ['没有 Home 键', 'Win+R 输入 osk 回车，用屏幕键盘点', null, true]
            ],
            body: '进游戏后按 Home 键可以打开 / 关闭 DLSS5（ReShade）控制面板，' +
              '插件与参数都在里面。' + (detail ? '\n\n' + detail : '')
          });
        }).catch(function (e) {
          stateEl.textContent = '部署失败';
          stateEl.className = 'err';
          toast('DLSS5 部署失败：' + errText(e), 'err', 24000);
        }).then(function () {
          deployBtn.disabled = false;
          hideBarLater(1800);
        });
      });
    });

    restoreBtn.addEventListener('click', function () {
      uiConfirm({
        title: '还原 DLSS5 部署',
        ok: '开始还原',
        body: '目录：\n' + targetDir +
          '\n\n按备份记录把 ReShade 本体 / 配置 / 插件 / 模型恢复成部署前的样子；' +
          '不是本工具放的文件一律不碰。' +
          '\n\n注意：本工具当初放进去的那些文件会被「直接删除」（不进回收站）；' +
          '如果那个位置原本就有文件，会用备份原样放回去。'
      }).then(function (yes) {
        if (!yes) return;
        restoreBtn.disabled = true;
        stateEl.textContent = '还原中…';
        stateEl.className = '';
        showBar('正在还原…', 0.4);
        invoke('dlss5_restore', { dir: targetDir }).then(function (r) {
          stateEl.textContent = '未部署';
          stateEl.className = '';
          toast(String((r && r.msg) || '已完成还原'), 'ok', 16000);
          ov.close();
          refreshLibrary();
        }).catch(function (e) {
          stateEl.textContent = '还原失败';
          stateEl.className = 'err';
          toast('DLSS5 还原失败：' + errText(e), 'err', 20000);
        }).then(function () {
          restoreBtn.disabled = false;
          hideBarLater(1800);
        });
      });
    });
  }

  /* DLSS5 页的【手动选择游戏根目录exe启动文件】：有些游戏扫不出来（或扫出来的目录不对），
     直接把它的启动 exe 指出来，目录就取 exe 所在那一层。入库逻辑和「添加目录」是同一份
     （core 的 add_library_dir），所以两种加法的结果不会有第二套行为。 */
  function pickGameExeNow(btn, andThen) {
    busy(btn, '选择中…', function () {
      return invoke('pick_game_exe').then(function (r) {
        if (!r || r.canceled) return;
        toast((r.updated ? '已更新游戏库条目：' : '已加入游戏库：') + (r.name || '') + '\n' + (r.exe || r.dir || ''), 'ok', 10000);
        return refreshLibrary().then(function () { return andThen ? andThen() : null; });
      });
    });
  }

  function removeGame(g) {
    uiConfirm({
      title: '从游戏库移除',
      ok: '移除',
      danger: true,
      body: '只从列表里移除，游戏目录里的文件一律不碰。\n\n' + (g.name || '') + '\n' + (g.dir || '')
    }).then(function (yes) {
      if (!yes) return;
      invoke('remove_game', { dir: g.dir }).then(function () {
        toast('已从游戏库移除：' + (g.name || ''), 'info', 8000);
        return refreshLibrary();
      }).catch(function (e) { toast('移除失败：' + errText(e), 'err', 12000); });
    });
  }

  // ---------------------------------------------------------------- 扫描 / 下载 / 导入

  /* 启动时自动扫描一次游戏库（用户要求）。
     为什么要：装完新游戏、或卸掉游戏之后，用户不该还得记得点一下「扫描游戏库」。
     安静策略：进度条照常走；**结果没变化就不弹任何提示**，只有真的新增/移除才说一句 ——
     否则每次开机都糊一个 toast，反而烦人。
     代价：扫描本身只读 launcher manifest + 几个目录，本机 7 个游戏实测 0.0 秒。 */
  function autoScanLibrary() {
    var before = (GAMES || []).map(function (g) { return g.dir; });
    showBar('正在扫描游戏库…', 0.05);
    return invoke('scan_library').then(function (r) {
      showBar('扫描完成，共 ' + r.count + ' 个游戏', 1);
      hideBarLater(2000);
      // 新扫出来的游戏要补封面：refreshLibrary 里的 ensureCovers 只跑一次，
      // 不重置这个开关的话这次启动就永远是 exe 图标了。
      COVERS_TRIED = false;
      return refreshLibrary().then(function () {
        var after = (GAMES || []).map(function (g) { return g.dir; });
        var beforeSet = {}, afterSet = {};
        before.forEach(function (d) { beforeSet[d] = 1; });
        after.forEach(function (d) { afterSet[d] = 1; });
        var added = after.filter(function (d) { return !beforeSet[d]; }).length;
        var removed = before.filter(function (d) { return !afterSet[d]; }).length;
        if (!added && !removed) return;   // 没变化 = 不打扰
        var bits = [];
        if (added) bits.push('新增 ' + added + ' 个');
        if (removed) bits.push('移除 ' + removed + ' 个');
        toast('启动时已更新游戏库：' + bits.join('、'), 'ok', 7000);
      });
    }).catch(function (e) {
      // 进度条只在还停在"扫描"那句话时才收，免得把别人的进度条关掉
      var bt = $('bar-text');
      if (bt && /^正在扫描游戏库/.test(bt.textContent || '')) hideBarLater(600);
      toast('启动时扫描游戏库失败：' + errText(e), 'err', 12000);
    });
  }

  function scanLibrary() {
    busy($('btn-scan'), '扫描中…', function () {
      showBar('正在扫描游戏库…', 0.05);
      return invoke('scan_library').then(function (r) {
        showBar('扫描完成，共 ' + r.count + ' 个游戏', 1);
        hideBarLater(2500);
        var notes = r.notes || [];
        /* 提示要短：以前最多堆 12 条扫描说明，弹出来一大片（用户反馈太大） */
        var msg = '扫描完成：找到 ' + r.count + ' 个游戏';
        if (r.saved === false) msg += '\n（缓存写入失败，下次启动不会自动显示）';
        if (notes.length) {
          msg += '\n' + notes.slice(0, 2).join('\n');
          if (notes.length > 2) msg += '\n…还有 ' + (notes.length - 2) + ' 条说明，见日志';
        }
        toast(msg, 'ok', 8000);
        return refreshLibrary();
      });
    });
  }

  /* ---------------------------------------------------------------- Smooth Motion（30 系实验性）
     **只读**：显示适用性（显卡 / 驱动 / 门槛判定）与驱动里全局那一项的现状。
     每个游戏的状态来自我们自己的记录；写入路径（单 EXE 的驱动配置）在下一步接入，
     所以卡片上的按钮暂时只说明现状。布局与帧生成页共用 gameCard，观感完全一致。 */
  function setSmText(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  function renderSm() {
    if (!document.getElementById('page-sm')) return Promise.resolve();
    var chips = document.getElementById('sm-chips');
    if (chips) chips.innerHTML = '<span class="chip gray">检测中…</span>';
    setSmText('sm-note', '正在读取显卡与驱动…');
    return invoke('sm_info').then(function (r) {
      var allowed = !!(r && r.allowed);
      if (chips) {
        chips.innerHTML = allowed
          ? '<span class="chip">可以部署</span>'
          : '<span class="chip gray">当前不适用</span>';
      }
      setSmText('sm-gpu', (r && r.gpu) || '读不到（需要 NVIDIA 显卡）');
      setSmText('sm-drv', (r && r.driver) || '读不到');
      setSmText('sm-min', (r && r.minDriver) || '616.64');
      var gate = document.getElementById('sm-gate');
      if (gate) {
        if (allowed) {
          gate.className = 'gate hidden';
          gate.textContent = '';
        } else {
          gate.className = 'gate';
          gate.textContent = (r && r.reason) || '当前不适用';
        }
      }
      setSmText('sm-note', allowed
        ? '驱动满足本工具要求（>=' + ((r && r.minDriver) || '616.64') + '）。'
        : '不满足要求时无法部署；原因见上面的提示。');
      var sub = document.getElementById('sm-sub');
      if (sub) sub.textContent = GAMES.length + ' 个游戏 · 一个游戏只能启用一个引擎（帧生成 / DLSS5 / Smooth Motion）';
      return paintSmList();
    }).catch(function (e) {
      setSmText('sm-note', '检测失败：' + errText(e));
      if (chips) chips.innerHTML = '<span class="chip gray">检测失败</span>';
    });
  }

  // Smooth Motion 列表：状态来自**游戏真正归属的那个驱动配置**（NVIDIA 预置的也算），
  // 不是"我们自建的 profile 里有没有值"。写入目标与状态显示用的是同一个 profile。
  function paintSmList() {
    var box = document.getElementById('sm-list');
    if (!box) return Promise.resolve();
    if (!GAMES.length) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'empty', text: '游戏库是空的 —— 点右上「扫描游戏库」。扫描只读启动器记录，不改动任何游戏文件。' }));
      return Promise.resolve();
    }
    // 先把状态取回来，再一次性替换内容；否则列表会先空一下再出现（看起来就是闪一下）
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
        // 有归属配置就把名字写在卡片上：用户能直接和 NVIDIA 控制面板 / Profile Inspector 对上
        var prof = st.profile
          ? '驱动配置：' + st.profile + (st.value === null || st.value === undefined ? '（未设置，跟随全局）' : '（Smooth Motion = ' + (on ? '开' : '关') + '）')
          : '驱动里还没有这个游戏的配置';
        frag.appendChild(gameCard(g, i, {
          label: on ? '关闭 Smooth Motion' : '开启 Smooth Motion',
          danger: on,
          note: prof,
          onClick: function () { toggleSm(g, !on); },
        }));
      });
      box.textContent = '';
      box.appendChild(frag);
    }).catch(function (e) {
      box.textContent = '';
      box.appendChild(h('div', { class: 'empty', text: '读取 Smooth Motion 状态失败：' + errText(e) }));
    });
  }
  // 开启 / 关闭某个游戏的 Smooth Motion（只写我们自己的单游戏 profile，绝不写全局）。
  // 引擎互斥：同一个游戏只能启用一个引擎。已部署帧生成时，先引导还原成原版再开 SM。
  function toggleSm(g, on) {
    if (!g || !g.name) return;
    // 写进驱动配置的必须是**游戏真正运行的那个 EXE**（targetExe），不是目录。
    var exe = g.targetExe || '';
    if (!exe) {
      toast('这个游戏没有识别到启动用的 EXE，先到「帧生成」页确认游戏路径。', 'warn', 12000);
      return;
    }
    var deployedFg = /^已部署/.test(g.deployed || '');
    var manualFg = /^已安装/.test(g.deployed || '');
    // 引擎互斥（硬性）：帧生成和 Smooth Motion 用的是同一个 version.dll，
    // 所以不许我们替他做决定 —— 让用户自己去帧生成页还原，再回来开 SM。
    if (on && (deployedFg || manualFg)) {
      toast('这个游戏已经装了帧生成（' + g.deployed + '），而帧生成和 Smooth Motion 用的是同一个 version.dll，不能同时开。\n\n请先到「帧生成」页找到这个游戏，点『还原』把它还原成原版，再回来开启 Smooth Motion。', 'warn', 14000);
      return;
    }
    // 目录里如果立着『不是本工具放』的入口（别人的 Mod），也先说清楚再动
    if (on && /入口被占用/.test(g.deployed || '')) {
      uiConfirm({
        title: '这个入口文件不是本工具放的',
        body: '这个游戏目录里已经有一个不是本工具放的入口文件（' + g.deployed + '）。\n\n继续会先把它原样备份，再放入 Smooth Motion 的解锁组件；之后可以用关闭或还原取回。\n\n要继续吗？',
      }).then(function (yes) {
        if (yes) doSmWrite(g, exe, on);
      });
      return;
    }
    doSmWrite(g, exe, on);
  }
  // 真正落地：开启时「先放解锁组件 → 再写驱动配置」；关闭时「先关驱动 → 再取回组件」。
  // 任一步失败都会明确报出来，不留半成品状态。
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
      var extra = on ? ((o.asset && o.asset.message) || '') : '';
      // 关闭 = ①把驱动里那一项关掉（写 0）②取回游戏目录里的解锁组件。
      // 两步各自报结果；**哪一步失败都要说出来** —— 尤其是组件没取回：
      // 那种情况下驱动已经关了，但徽章还写着「已被 Smooth Motion 占用」，
      // 不告诉用户原因的话，看起来就像"关闭没生效"。
      var tail = !on
        ? invoke('sm_turn_off_game', { name: g.name, dir: dir, exe: exe })
            .then(function (m) { return (m && m.message) || '已关闭'; },
                  function (e) { return { text: '驱动设置关闭失败：' + errText(e), bad: true }; })
            .then(function (off) {
              // 带上 exe：同一个游戏可能以"根目录"和"exe 所在子目录"两条存在，
              // 组件放在哪一条都能被找到并取回（否则徽章会一直显示已被占用）。
              return invoke('sm_asset_restore', { dir: dir, exe: exe }).then(function (a) {
                var offText = typeof off === 'string' ? off : off.text;
                var offBad = typeof off === 'string' ? false : !!off.bad;
                return { text: [offText, a && a.message].filter(Boolean).join('；'), bad: offBad };
              }, function (e) {
                var offText = typeof off === 'string' ? off : off.text;
                var offBad = typeof off === 'string' ? false : !!off.bad;
                return { text: [offText, '解锁组件没取回：' + errText(e)].filter(Boolean).join('；'), bad: true };
              });
            })
        : Promise.resolve({ text: extra, bad: false });
      return tail.then(function (t) {
        hideBarLater(1200);
        var tailText = (t && t.text) || '';
        var tailBad = !!(t && t.bad);
        var ok = r && r.ok && !tailBad;
        var msg = ((r && r.message) || (on ? '已开启' : '已关闭')) + (tailText ? '；' + tailText : '');
        toast((ok ? '' : '未生效：') + msg, ok ? 'ok' : 'warn', ok ? 9000 : 14000);
        /* 重画顺序**不能反**（这里踩过两次，徽章显示慢一步）：
           paintSmList 渲染的是 GAMES 里的 deployed —— 那是游戏库的扫描结果。
           徽章（未部署 / 已被 Smooth Motion 占用）取决于游戏目录里 version.dll 的状态，
           而改这个文件的正是刚才那两个命令。所以必须**先把游戏库拉新的**、再画列表；
           反过来先画就会拿到改动前的 deployed，看起来就是徽章慢一步：
           刚开好显示"未部署"、关掉之后反而显示"已被占用"。 */
        var done = ok ? refreshLibrary().catch(function () { }) : Promise.resolve();
        done.then(function () { return paintSmList(); }).catch(function () { });
        return r;
      });
    }).catch(function (e) {
      hideBarLater(1200);
      toast('Smooth Motion 操作中止：' + errText(e), 'err', 10000);
    });
  }
  // ---------------------------------------------------------------- 页面切换与绑定
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
        // 进设置页顺手刷一次日志：用户点进来基本就是想看它
        /* 日志已移到主页左栏：进程序实时刷新，切页不再需要读日志。
           进设置页则刷一次备份情况（用户点进来基本就是想知道"有没有东西可以清"）。 */
        if (want === 'settings') refreshBackups().catch(function () { });
        // 进 Smooth Motion 页就重新检测一次（显卡/驱动/门槛/驱动里的全局现状，全部只读）；
        // renderSm 结束时会自己重画卡片列表，所以这里不用再调一次 paintSmList。
        if (want === 'sm') renderSm().catch(function () { });
        // 进帧生成页也刷新一次：状态可能被 Smooth Motion 页改过（同一个 version.dll）
        if (want === 'lib') refreshLibrary().catch(function () { });
      });
    });
  }

  /* 日志是实时产生的：进程序就每 2.5 秒拉一次尾部，没有刷新按钮（用户要求去掉）。
     窗口在后台时跳过 —— 省电，也没有意义的 IPC。 */
  function startLogLive() {
    var tick = function () { if (!document.hidden) loadLog().catch(function () { }); };
    tick();
    setInterval(tick, 2500);
  }

  /* 更新弹窗：自更新进度画在这里（不走底部进度条）。停止按钮转发 cancel_self_update，
     sidecar 收到后置取消标志，core 退出下载并由 sidecar 清掉半截文件。 */
  function bindUpdateDialog() {
    var box = $('upd'), stop = $('upd-stop');
    if (!box) return;
    if (stop) stop.addEventListener('click', function () {
      busy(stop, '正在停止…', function () {
        return invoke('cancel_self_update').then(function () {
          toast('已请求停止，临时文件会一并清理', 'info', 5000);
        });
      });
    });
    EV.listen('selfupdate', function (e) {
      /* 注意：preload 的回调给的是 Tauri 形状 { event, payload } —— 直接读 e.phase 永远是 undefined，
         这就是「模拟更新时弹窗不出现」的根因（白排查了两轮）。 */
      var p = (e && e.payload) || {};
      var phase = p.phase || '';
      if (phase === 'start') {
        box.classList.remove('hidden');
        if ($('upd-fill')) $('upd-fill').style.width = '0%';
        if ($('upd-msg')) $('upd-msg').textContent = '正在获取版本信息…';
        return;
      }
      if (phase) {
        if ($('upd-msg')) $('upd-msg').textContent = phase === 'done' ? '下载完成，正在启动安装程序…' : (phase === 'canceled' ? '已停止，临时文件已清理' : '下载失败');
        if ($('upd-stop')) $('upd-stop').disabled = true;
        setTimeout(function () { box.classList.add('hidden'); if ($('upd-stop')) $('upd-stop').disabled = false; }, phase === 'done' ? 600 : 1200);
        return;
      }
      if ($('upd-fill')) $('upd-fill').style.width = Math.round(Math.max(0, Math.min(1, p.fraction || 0)) * 100) + '%';
      if ($('upd-msg')) $('upd-msg').textContent = p.msg || '';
    });
  }

  function bind() {
    /* 外部改动（用户在资源管理器里删文件、手动拷文件）不会触发任何事件，
       所以窗口重新获得焦点时主动刷一次资产状态 —— 否则卡片会一直显示旧数据。 */
    window.addEventListener('focus', function () { if (ASSETS_DIR !== null) refreshAssets().catch(function () { }); });
    if ($('btn-scan')) $('btn-scan').addEventListener('click', scanLibrary);
    if ($('btn-redeploy-legacy')) {
      $('btn-redeploy-legacy').addEventListener('click', function () { redeployLegacyAll(); });
    }
    /* 右上角那个「检查更新」是**软件版本**检查（用户要求）；上游资产检查在左侧「检查更新」。 */
    if ($('btn-check')) $('btn-check').addEventListener('click', function () { busy(this, '检查中…', function () { return checkSelfUpdate(); }); });

    /* 侧栏的代理入口选择器已移除（用户要求卡片只留路径）：部署对话框里仍可选入口，
       PROXY 作为默认值保留。 */
if ($('sel-proxy')) {
      $('sel-proxy').addEventListener('change', function () {
        PROXY = this.value;
        toast('代理入口改成 ' + PROXY + '（下载 / 更新资产会用这个入口）', 'info', 6000);
      });
    }
    if ($('btn-hags')) $('btn-hags').addEventListener('click', function () {
      invoke('open_hags_settings').then(function (r) {
        toast('已打开系统设置里的「硬件加速 GPU 计划」\n' + (r && r.uri ? r.uri : '') +
          '\nDLSS 帧生成需要它是「开」；改完可能要重启。', 'info', 9000);
      }).catch(function (e) { toast('打开系统设置失败：' + errText(e), 'err'); });
    });
    if ($('btn-add-game')) $('btn-add-game').addEventListener('click', function () {
      busy(this, '选择中…', function () {
        return invoke('add_game').then(function (r) {
          if (r.canceled) return;
          if (r.added === false) { toast(r.reason || '没有加进去。', 'info', 8000); return; }
          toast('已加入游戏库：' + (r.name || '') + '\n' + (r.dir || ''), 'ok', 10000);
          return refreshLibrary();
        });
      });
    });
    if ($('btn-open-assets')) $('btn-open-assets').addEventListener('click', function () { openPath(ASSETS_DIR); });
    if ($('btn-spoof-apply')) $('btn-spoof-apply').addEventListener('click', spoofApply);
    if ($('btn-spoof-restore')) $('btn-spoof-restore').addEventListener('click', spoofRestore);

    if ($('btn-dlss5-scan')) $('btn-dlss5-scan').addEventListener('click', function () { scanLibrary(); });
    if ($('btn-dlss5-pick')) $('btn-dlss5-pick').addEventListener('click', function () { pickGameExeNow(this); });
    // 两页共用同一个视图（卡片式，见 openRemovedDialog）
    if ($('btn-dlss5-removed')) $('btn-dlss5-removed').addEventListener('click', function () { openRemovedDialog('dlss5'); });
    if ($('btn-removed-games')) $('btn-removed-games').addEventListener('click', function () { openRemovedDialog('library'); });

    // ---- 设置页
    if ($('btn-self-update')) $('btn-self-update').addEventListener('click', checkSelfUpdate);
    if ($('btn-releases')) $('btn-releases').addEventListener('click', function () {
      var url = (CFG && CFG.releasesUrl) || (SELF && SELF.releasesUrl);
      if (!url) { toast('还读不到发布页地址。', 'info', 5000); return; }
      invoke('open_url', { url: url }).catch(function (e) { toast('打开失败：' + errText(e), 'err'); });
    });
    // Smooth Motion 页的两个按钮：重新检测（只读）与扫描游戏库（复用同一个动作）
    if ($('btn-sm-refresh')) $('btn-sm-refresh').addEventListener('click', function () { renderSm().catch(function () { }); });
    if ($('btn-sm-scan') && $('btn-scan')) $('btn-sm-scan').addEventListener('click', function () { $('btn-scan').click(); });
    // 手动指定启动 exe：入库用的是和 DLSS5 页/主页同一份逻辑（add_library_dir）。
    // 入库后帧生成页与 SM 页都要重画，否则 SM 列表里看不到这个新加的游戏。
    if ($('btn-sm-pick')) $('btn-sm-pick').addEventListener('click', function () {
      pickGameExeNow(this, function () { return paintSmList(); });
    });
    /* 这里原来还有一个「清理残留配置」按钮（清掉旧版自建、没挂游戏的驱动配置）。
       用户要求去掉。core/sidecar 的 sm_clean_orphans 命令**保留**着：发行版里没有入口，
       真要排查时用命令行调它即可，不必为了一个按钮把逻辑删掉。 */
    if ($('btn-clean-backups')) $('btn-clean-backups').addEventListener('click', function () {
      var me = this;
      invoke('backups_info').then(function (info) {
        /* 清理前**必须把要删的东西列出来**：备份记录就是「这个游戏是本工具部署的」的唯一凭据，
           删掉之后游戏会重新显示成「未部署」、DLSS5 也会认不出是本工具装的（用户就踩过这个坑）。
           所以这里逐条列出种类 + 游戏目录，并把这些后果写在确认框里。 */
        var all = (info && info.entries) || [];
        var del = all.filter(function (en) { return en.kind !== 'gpu-name'; });
        var freed = 0, rows = [];
        del.forEach(function (en) { freed += en.bytes || 0; });
        if (!del.length) { toast('没有需要清理的备份（显卡名称的备份会保留）', 'info', 5000); return; }
        var kindName = { dlss5: 'DLSS5', framegen: '帧生成' };
        del.slice(0, 8).forEach(function (en) {
          rows.push([(kindName[en.kind] || en.kind) + ' · ' + fmtSize(en.bytes || 0),
                     en.target || (en.name.slice(0, 8) + '…'), 'warn']);
        });
        if (del.length > 8) rows.push(['……还有 ' + (del.length - 8) + ' 项', '', 'warn']);
        rows.unshift(['将删除', del.length + ' 份部署记录', 'warn']);
        rows.push(['可释放', fmtSize(freed)]);
        uiConfirm({
          title: '清理旧备份',
          ok: '删除备份',
          danger: true,
          rows: rows,
          body: '备份记录是「这个游戏由本工具部署过」的唯一凭据，备份文件本身是游戏的原文件。\n\n' +
            '删除之后会有两个后果：\n' +
            '· 已经部署的模组**无法再「还原」**成原版；\n' +
            '· 这些游戏会重新显示为「未部署」，DLSS5 也不再认得是本工具装的（无法自动还原）。\n\n' +
            '请先把还想恢复原样的游戏逐个「还原」，再来清理。\n\n（显卡名称的备份会保留。）',
        }).then(function (yes) {
          if (!yes) return;
          busy(me, '清理中…', function () {
            return invoke('clean_backups').then(function (r) {
              toast('已清理 ' + (r.removed || 0) + ' 份备份，释放 ' + fmtSize(r.freed || 0), 'ok', 8000);
              return refreshBackups();
            });
          });
        });
      }).catch(function (e) { toast('读取备份情况失败：' + errText(e), 'err', 8000); });
    });

    if ($('btn-log-copy')) $('btn-log-copy').addEventListener('click', function () {
      var box = $('log-box');
      var t = box ? box.textContent : '';
      if (!t) { toast('日志是空的。', 'info', 5000); return; }
      /* 复制出来要能直接定位问题：先写环境信息（版本/显卡/驱动/路径），再贴日志尾部。
         用户丢到群里时我们不用再追问一轮环境（用户要求"对后续开发有帮助"）。 */
      var g = (GPU && (GPU.name || GPU.gpu || GPU.model)) || '';
      var drv = (GPU && (GPU.driver || GPU.driverVersion || GPU.version)) || '';
      var head = [
        '=== FrameGen Manager 反馈信息 ===',
        '版本：' + ((SELF && SELF.version) || (CFG && CFG.version) || '未知'),
        '时间：' + new Date().toLocaleString(),
        '显卡：' + (g || '未知') + (drv ? '（驱动 ' + drv + '）' : ''),
        '资产目录：' + ((CFG && CFG.assetsDir) || '-'),
        '备份目录：' + ((CFG && CFG.backupsDir) || '-'),
        '日志目录：' + ((CFG && CFG.logsDir) || '-'),
        '',
        '=== 日志尾部 ===',
      ].join('\n');
      copyText(head + t).then(function () { toast('已复制：环境信息 + 日志', 'ok', 5000); })
        .catch(function (e) { toast('复制失败：' + errText(e), 'err'); });
    });
    var pOpen = [
      ['btn-open-p-assets', function () { return CFG && CFG.assetsDir; }],
      ['btn-open-p-backups', function () { return CFG && CFG.backupsDir; }],
      ['btn-open-p-library', function () { return CFG && CFG.libraryPath; }],
      ['btn-open-p-logs', function () { return CFG && CFG.logsDir; }],
      ['btn-open-p-config', function () { return CFG && CFG.configPath; }],
      ];
    pOpen.forEach(function (pair) {
      if (!$(pair[0])) return;
      $(pair[0]).addEventListener('click', function () {
        var p = pair[1]();
        if (p) openPath(p); else toast('还读不到这个路径。', 'info', 5000);
      });
    });
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    setupTabs();
    bind();
    bindUpdateDialog();
    startLogLive();
    // 显卡信息拿到之后（且只在这一处）做一次启动警告
    refreshGpu().then(function () { warnGpuIfNeeded(); }).catch(function () { });
    loadConfig().then(function () { return refreshAssets(); }).catch(function () { });
    loadDlss5Meta().catch(function () { });
    loadSpoof().catch(function () { });
    loadCovers()
      .then(function () { return refreshLibrary(); })
      // 列表先画出来，再做启动扫描（扫完自动刷新 + 有变化才提示）——
      // 这样用户一进来就有东西看，而不是对着空列表等扫描。
      .then(function () { return autoScanLibrary(); })
      .catch(function () { });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();