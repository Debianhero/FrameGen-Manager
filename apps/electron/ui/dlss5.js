/* DLSS5 页：检测 / 部署 / 卸载 / 还原（P1-12 第 3 步）：从 app.js 原样搬出，函数名不变。
   依赖其它脚本里的全局：i18n.js 的 t；lib.js 的 `$` / h / badge / backText / errText / fmtSize；
   app.js 的 invoke / toast / busy / showBar / hideBarLater / uiConfirm / refreshWall /
   refreshLibrary / paintLibrary，以及 CFG / GPU / GAMES / DLSS5 / REMOVED 这些状态变量。
   加载顺序：i18n.js -> lib.js -> settings.js -> deploy.js -> dlss5.js -> app.js */
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

/* 这里原来还有 checkDlss5Legacy()：单独弹「DLSS5 已更换为 GITC 版」。
   现在三类资产合并成一个弹窗（见 sm.js 的 checkAssetsLegacy），它没有调用点了，
   已随本轮代码结构审计删除（见 docs/CHANGELOG.md）—— 里面的 dlss5_legacy_scan 命令
   仍被那个统一检查用着。 */
