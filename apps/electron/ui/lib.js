/* 公共层（T8 拆分之第一步）：DOM 小工具 / 后端文本回译 / 尺寸格式化 /
   部署选项记忆 / 复制。全部保持全局函数名不变，app.js 直接使用。
   加载顺序：i18n.js -> lib.js -> app.js */

  function $(id) { return document.getElementById(id); }
  function errText(e) {
    var m = (e && e.message) ? e.message : String(e);
    m = m.replace(/^Error invoking remote method '[^']*':\s*/, '');
    m = m.replace(/^Error:\s*/, '');
    return backText(m);
  }
  // 后端（core / sidecar）交给界面的文本也要跟着界面语言走。
  // 和 t() 是同一套思路：key 就是中文原文，词表里没有就原样返回（安全方向）。
  // 差别在于后端会把一句拼好 ——「扫描完成，共 7 个游戏」这种带数字的没法当字典 key，
  // 所以下面配一张很小的模式表，只覆盖进度条 / 结果里那几句模板。
  // 语言不是英文时**不套模式**：中文下原样显示，绝不让中文被"翻译"成英文。
  var BK_PATTERNS = [
    [/^扫描完成，共 (\d+) 个游戏$/, 'Scan complete, $1 games'],
    [/^正在扫描游戏库…$/, 'Scanning the library...'],
    [/^正在获取封面 (\d+)\/(\d+)（(.+)）…$/, 'Fetching cover $1/$2 ($3)...'],
    [/^正在测速：(.+)$/, 'Testing speed: $1'],
    [/^第 (\d+)\/(\d+) 步 · 下载 (.+) \.\.\.$/, 'Step $1/$2 · downloading $3 ...'],
    [/^第 (\d+)\/(\d+) 步 · 下载 (.+) ([\d.]+) \/ ([\d.]+) · (.+)$/, 'Step $1/$2 · downloading $3 $4 / $5 · $6'],
    [/^第 (\d+)\/(\d+) 步 · (.+) 改用 Releases 接口重试$/, 'Step $1/$2 · retrying $3 via the Releases API'],
    [/^第 (\d+)\/(\d+) 步 · 解压 (.+) \.\.\.$/, 'Step $1/$2 · extracting $3 ...'],
    [/^第 (\d+)\/(\d+) 步 · (.+) 就绪（已校验 NVIDIA 签名，(.+)）$/, 'Step $1/$2 · $3 ready (NVIDIA signature verified, $4)'],
    [/^已删除 (\d+) 项：(.+)$/, 'Deleted $1 item(s): $2'],
    [/^已彻底卸载 (\d+) 项：(.+)$/, 'Fully uninstalled $1 item(s): $2'],
    [/^已还原：恢复 (\d+) 个原始文件$/, 'Restored: $1 original file(s) back in place'],
    [/^部分还原：恢复 (\d+) 个原始文件$/, 'Partly restored: $1 original file(s) back in place'],
    [/^扫描结束：共 (\d+) 个游戏，用时 ([\d.]+) 秒$/, 'Scan finished: $1 games in $2 s'],
    [/^当前显卡「(.+)」不是 20\/30 系 —— 这个解锁只对 20\/30 系有效。$/,
      'The current GPU "$1" is not RTX 20/30 series - this unlock only applies to RTX 20/30 series.'],
    [/^资产缺失（(.+)）—— 资产随安装包内置，请检查安装是否完整（或重新安装本程序）$/,
      'Asset missing ($1) - assets ship inside the installer; check that the installation is complete (or reinstall the app)'],
    [/^缺少运行库 (.+) —— 资产随安装包内置，请检查安装是否完整（或重新安装本程序）$/,
      'Runtime file missing ($1) - assets ship inside the installer; check that the installation is complete (or reinstall the app)'],
    [/^缺少 (.+) —— 资产随安装包内置，请检查安装是否完整（或重新安装本程序）$/,
      'Missing $1 - assets ship inside the installer; check that the installation is complete (or reinstall the app)'],
  ];
  function backText(s) {
    var str = (s === null || s === undefined) ? '' : String(s);
    if (!str) return str;
    var hit = t(str);
    if (hit !== str) return hit;
    if (!(window.getLang && window.getLang() === 'en')) return str;
    for (var i = 0; i < BK_PATTERNS.length; i++) {
      var m = BK_PATTERNS[i][0].exec(str);
      if (m) {
        return BK_PATTERNS[i][1].replace(/\$(\d)/g, function (_, d) { return m[Number(d)] || ''; });
      }
    }
    return str;
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
    return h('span', { class: 'badge' + (cls ? ' ' + cls : ''), text: backText(text) });
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error(t('浏览器拒绝了复制')));
      } catch (e) { reject(e); }
    });
  }

  function deployLsGet(k, d) {
    try { var v = localStorage.getItem('fgm.deploy.' + k); return v === null ? d : v; } catch (e) { return d; }
  }
  function deployLsSet(k, v) {
    try { localStorage.setItem('fgm.deploy.' + k, v); } catch (e) { /* 隐私模式等写入失败，忽略 */ }
  }
