/* Smooth Motion 页 + 三类资产的旧版清理弹窗（P1-12 第 4 步）：从 app.js 原样搬出，函数名不变。
   依赖其它脚本里的全局：i18n.js 的 t；lib.js 的 `$` / h / badge / backText / errText / fmtSize；
   settings.js 的 optLabelOf / frmLabelOf / presetLabelOf / rememberDeployLevels；
   app.js 的 invoke / toast / busy / showBar / hideBarLater / uiConfirm / paintLibrary /
   refreshLibrary / paintSettings / refreshBackups / doDeploy，以及 CFG / GPU / GAMES 等状态。
   加载顺序：i18n.js -> lib.js -> settings.js -> deploy.js -> dlss5.js -> sm.js -> app.js */
/* 这里原来还有 checkSmLegacy()：单独弹「Smooth Motion 组件有新版本」。
   现在三类资产（帧生成 / SM / DLSS5）合并成一个弹窗（见下面的 checkAssetsLegacy），
   它没有任何调用点了，已随本轮代码结构审计删除（见 docs/CHANGELOG.md）—— 里面的 sm_legacy_scan 命令
   仍然被 checkAssetsLegacy 用着，别一起删。 */

// 统一弹窗：列出三类资产里需要处理的游戏，【全部清除】串行清理，【暂不处理】按版本记一次。
//
// **两类 DLSS5 必须分开**（踩过一次）：
//   · d5Names    —— 旧版 RenoDX 插件：deploy 会直接拒绝，必须先「彻底卸载」；
//   · d5Outdated —— 已经是 GITC、只是内置资产版本旧了（1.6.2 → 1.7.0 这种）：
//                    **不用卸载**，到 DLSS5 页再点一次部署就会覆盖成新版本。
//                   而「彻底卸载」会连整个 reshade-shaders 一起删掉（用户自备的预设 /
//                   效果包就没了），为一次二进制小升级付这个代价太大 ——
//                    所以它们只做告知，**绝不进清除清单**。
function showAssetsLegacyDialog(fgNames, smNames, d5Names, d5Outdated) {
  var NL = String.fromCharCode(10);
  d5Outdated = d5Outdated || [];
  var mustClear = fgNames.length > 0 || smNames.length > 0 || d5Names.length > 0;
  if (!mustClear && d5Outdated.length === 0) return Promise.resolve();
  var fmt = function (arr) {
    var head = arr.slice(0, 6).join('、');
    if (arr.length <= 6) return head;
    return head + t('…等 ') + arr.length + t(' 个');
  };
  var lines = [];
  if (fgNames.length) lines.push(t('· 帧生成：') + fmt(fgNames));
  if (smNames.length) lines.push(t('· Smooth Motion：') + fmt(smNames));
  if (d5Names.length) lines.push(t('· DLSS5（旧版 RenoDX，必须先卸载）：') + fmt(d5Names));
  if (d5Outdated.length) lines.push(t('· DLSS5（只是资产旧了，重新部署即可）：') + fmt(d5Outdated));

  /* 只有「资产旧了、重部署就行」这一类：单按钮告知，不执行任何清除动作。
     （内置资产换了版本是常事，不该每次都用"卸载"这种重手段拦用户一次。） */
  if (!mustClear) {
    return uiConfirm({
      title: t('DLSS5 资产已更新'),
      ok: t('知道了'),
      single: true,
      body: t('内置的 DLSS5 插件已升级到新版本。下面这些游戏部署的还是旧资产：') + NL + NL +
        lines.join(NL) + NL + NL +
        t('不需要卸载：到「DLSS5」页对它们各点一次「部署 DLSS5」就会换成新版本（你自备的 ReShade 预设和效果包不会被删）。'),
    });
  }

  // 文案里**只写命中的类别**（用户要求：只有帧生成有更新时，不要再提 SM/DLSS5）
  var names = [];
  if (fgNames.length) names.push(t('帧生成'));
  if (smNames.length) names.push(t('Smooth Motion'));
  if (d5Names.length) names.push(t('DLSS5'));
  var body = t('检测到') + names.join('、') +
    t('资产文件有更新，当前还是旧版本资产文件，是否全部清除后再重新部署？');
  body = body + NL + NL + lines.join(NL);
  if (d5Outdated.length) {
    body = body + NL + NL +
      t('另有 {n} 个游戏的 DLSS5 只是资产旧了，不在上面的清除清单里 —— 到「DLSS5」页点一次部署即可。', { n: d5Outdated.length });
  }
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
    /* DLSS5 分成两类（见 showAssetsLegacyDialog 的说明）：
         d5Legacy   = 旧版 RenoDX 插件 → 必须彻底卸载；
         d5Outdated = 已是 GITC、只是内置资产旧了 → 重新部署即可，不清除。 */
    var d5Outdated = (u.dlss5 ? u.dlss5 : []).filter(function (n) {
      return d5Legacy.indexOf(n) < 0;
    });
    if (!fgAll.length && !smAll.length && !d5Legacy.length && !d5Outdated.length) return;
    invoke('assets_legacy_prompt_done').catch(function () { });
    return showAssetsLegacyDialog(fgAll, smAll, d5Legacy, d5Outdated);
  }).catch(function () { });
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
