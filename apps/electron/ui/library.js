/* 库页：封面 / 图标 / 卡片 / 瓦片墙 / 分批渲染 / 扫描（P1-12 第 5 步）：从 app.js 原样搬出，函数名不变。
   依赖其它脚本里的全局：i18n.js 的 t；lib.js 的 `$` / h / badge / backText / errText / fmtSize；
   deploy.js 的 openGameDialog / redeployLegacyAll 等；dlss5.js 的 dlss5IsRemoved；
   app.js 的 invoke / toast / busy / showBar / hideBarLater / uiConfirm / paintGate / assetHas /
   coverOf 等，以及 GAMES / COVERS / ICONS / REMOVED / CFG / DLSS5 / ASSETS_DIR 这些状态变量。
   加载顺序：i18n.js -> lib.js -> settings.js -> deploy.js -> dlss5.js -> sm.js -> library.js -> app.js */
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
  var badges = h('div', { class: 'badges' }, [
    badge(g.source || t('未知'), g.manual ? 'dim' : null),
    badge(t('API：') + (backText(g.api) || t('未知')), 'dim'),
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
    h('div', { class: 'meta' }, [
      h('div', { class: 'name', text: g.name || t('（无名）') }),
      h('div', { class: 'tag', text: t('图形 API：') + (backText(g.api) || t('未知')) }),
      h('div', { class: 'tag ' + (/^已部署/.test(g.dlss5 || '') ? 'ok' : ''), text: /^已部署/.test(g.dlss5 || '') ? t('DLSS5 已部署') : t('DLSS5 未部署') })
    ])
  ]);
}
function refreshWall() {
  var b = $('wall-other');
  if (!b) return;
  b.textContent = '';
  // 不再按「是否自带 DLSS」分组（该检测已移除）：所有游戏一个列表
  var all = GAMES.filter(function (g) { return !dlss5IsRemoved(g); });
  if ($('c-other')) $('c-other').textContent = all.length;
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
  all.forEach(function (g, i) { put(g, i, b); });
}
function openPath(p) {
  if (!p) return;
  invoke('open_path', { path: p }).catch(function (e) { toast(t('打开失败：') + errText(e), 'err'); });
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
