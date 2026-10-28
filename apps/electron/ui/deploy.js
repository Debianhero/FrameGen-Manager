/* 游戏详情对话框 + 部署 / 还原 / 清理（P1-12 第 2 步）：从 app.js 原样搬出，函数名不变。
   依赖其它脚本里的全局：i18n.js 的 t；lib.js 的 `$` / h / backText / errText / fmtSize /
   copyText / deployLsGet / deployLsSet；settings.js 的档位与预设标签、rememberDeployLevels、
   fgDriverState；app.js 的 invoke / toast / busy / showBar / hideBarLater / uiConfirm /
   paintLibrary / refreshLibrary / refreshBackups，以及 CFG / GPU / GAMES / PROXIES / PROXY /
   DLSS5 / SM_CONFLICT_TEXT 这些状态变量。
   加载顺序：i18n.js -> lib.js -> settings.js -> deploy.js -> app.js */
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
