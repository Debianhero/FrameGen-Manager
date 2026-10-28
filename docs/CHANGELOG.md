# 变更记录

## v1.6.3

**修复**

- 启动清理时底部进度条会永远停在「正在删除插件 / 模型与运行时残留…」：DLSS5 卸载发出的进度事件不带「相位」，把进度条上记着的相位（`legacy`）覆盖成了空，收条逻辑按相位比对就对不上了。现在进度条会记住最近一次的相位，事件只更新文字与百分比；条收掉时相位一并清空

## v1.6.2

**改进**

- 资产更新的自动清理，对 DLSS5 改为**彻底卸载**（官方卸载器 + 插件 / 模型 / 残留一起走）：1.6.1 只做「还原」，游戏目录里会留下 ReShade 本体与效果包，用户还得再手动点一次「卸载」才算干净。代价：用户自备的 `reshade-shaders`（fx / 预设）会被一并删除，重新部署时由官方安装器重新铺
- 「彻底卸载」现在会把 ReShade 给 DX12 游戏铺的 `D3D12\D3D12Core.dll` 也收走（官方卸载器不管这个目录）。只在「`D3D12\` 里仅此一个文件、且版本资源写着 Microsoft」时才删，避免误删游戏自带的 Agility SDK

## v1.6.1

**修复**

- 启动清理其实一直没跑：`checkAssetsLegacy` 里的 `var fg` 写进了第一个 `then`，第二个 `then` 读不到 → `ReferenceError` 被末尾的 `catch` 静默吞掉。1.6.0 实测表现为「没清理、也没弹新告知窗」。现在 `fg` 提到函数作用域，并加 e2e 断言钉住（调用 `checkAssetsLegacy` 不许抛异常）
- **删掉两条重复的旧提示**（它们比统一清理先跑，用户看到的是最旧那条）：`boot` 里的 `framegen_cleanup_outdated` 自查（帧生成专用、弹「旧版帧生成已清除」）与 `deploy.js` 的 `maybePromptLegacyUpgrade`（弹「是否重新部署新版本文件」确认框）。1.6.0 实测：升级后提示的是「帧生成」并清了霍格沃茨，而真正要更新的 DLSS5（Nomad Drive Demo）一个文件都没动，就是被这两条抢先了
- `dlss5::is_outdated` 认不出 **64 位插件**变了：它拿前缀 `gitc-uplift` 去 `asset_dir` 里拼路径（实际文件名是 `gitc-uplift.addon64`），永远 `continue` 掉。只换 addon64 的那种更新会完全漏报；现在直接问 `find_addon()` 要真实路径
- 安装器底色：去掉 `MUI_BGCOLOR` / `MUI_TEXTCOLOR` 的自定义（electron-builder 的模板里文字色没覆盖到所有控件，结果黑底黑字看不见），回到系统默认浅色页面；品牌靠侧栏 / 顶栏位图

## v1.6.0

**新增**

- 安装器 / 卸载器品牌化：真实应用图标、深色完成页、中文侧栏、顶栏绿线（NSIS 位图）

**改进**

- P1：删除 0 引用常量；新增 `assets_audit` 统一判定入口；错误响应带稳定错误码（`DRV-001` 等）；`bump-version.ps1` 一键升版
- P2：卸载时清理数据目录 / `%LOCALAPPDATA%` / 自更新暂存；**不动游戏目录里已部署的文件**
- 安全：清单路径走 `safe_join`（拒绝 `..` / 绝对路径 / UNC / 保留名）；sidecar 写目录命令统一校验目标
- 体验：驱动低于 R580 时部署弹窗直接拦截并说明；旧版帧生成被自动清理后改为**弹窗**告知（不再只发 15 秒 toast）
- 工程：本地 git 仓库 + 源码 `.gitignore`；新增 `docs/ARCH.md`

- 超分：部署弹窗的「超分加速」改为**超分预设五选一**（`Off` / `M-INT8` / `L-INT8` / `M-FP16` / `L-FP16`），标签同步改名；批量重新部署不再丢预设；老的 `0/1` 选择自动迁移
- 驱动：部署前检测 **R580** 门槛（sidecar 直接给主版本号），低于则拦截并说明「部署成功但游戏里没效果」；读不到版本时只提示不误拦
- 兼容：修「代理文件已被覆盖或丢失」——0.4.1 代理换了签名，改为**按内容哈希**认归属；ReShade 的 `dxgi.dll` 不再被误判为帧生成占用（改为读 PE 版本串 + 已知哈希兜底）
- 诊断：日志面板新增【诊断】按钮，一键复制「版本 / 驱动 / 语言 / 日志尾」
- 工程：`packaging/preflight.ps1`（双 CR / 语法 / 词表 / 单测一键自检）；代理表与真实资产的一致性单测；`safe_join` 去掉不安全回退

- 工程（本轮补齐）：前端公共层拆到 `ui/lib.js`（DOM 工具/回译/格式化/复制/部署选项记忆），`app.js` 2700 → 2596 行；词表检查同步覆盖 `lib.js`
- 升级策略（产品决定）：**任何一类资产（帧生成 / Smooth Motion / DLSS5）有更新，启动后直接清干净已部署的旧版本，不再先问**；清完弹一个**只有【我知道了】**的告知窗，写清「哪类资产更新了（只写真的更新的那几类）/ 清了哪些游戏 / 哪些没能清除 + 下一步怎么办」。每类都走「把我们的部署收回去」的命令：帧生成 `restore` + `clean_legacy`；SM `sm_set_game(on:false)` + `sm_asset_restore`；DLSS5（GITC）`dlss5_restore`（只收我们的文件，**不动用户自备的 reshade-shaders**）；DLSS5（旧版 RenoDX）`dlss5_uninstall`（布局不兼容，必须彻底卸载）。清不掉的不阻断其余游戏，逐条列进弹窗；按程序版本只做一次
- 修复：内置资产铺设不再因为缺 `bundled-assets` 就整段跳过 `bundled-dlss5`（两个目录各自判断），并给 `copyTree` 补存在性保护（否则 `readdirSync` 抛异常会中断启动链，窗口都不出来）
- 资产：DLSS5 插件升级到 **GITC Uplift 1.7.0**（上游 2026-10-27 发布）：`gitc-uplift.addon64` / `gitc-uplift.addon32` / `gitc-uplift-helper64.exe` 三个二进制换新，`Uplift.fx` / `UpliftMask.fx` 与神经网络模型（310.9.16）**未变**；文件名与目录布局不变，`dlss5.rs` 里的常量无需改动。SHA-256 与发布包 `SHA256SUMS.txt` 逐条一致（zip 本体也核过），`THIRD_PARTY_NOTICES.txt` 同步更正 —— 那一节原来还写着 RenoDX v8.5 插件与 310.8 模型，和实际内置的 GITC 1.7.0 / 310.9.16 对不上
- 工程（代码结构审计）：死代码清理（Rust `sm::orphan_profiles` / `recorded_profile_names`、`BackupPlan::created/summary`；前端 `checkSmLegacy` / `checkDlss5Legacy` —— 两类资产合并成一个清理弹窗后就没有调用点了）；**原子写 JSON 收口**到 `util::write_json_atomic` / `write_text_atomic`，配置 / 游戏库缓存 / GPU 名称备份 / SM 记录 / 测速记忆从"直接 fs::write"改成原子写（写一半崩溃会让下次启动读不出来，游戏库那份甚至会按空库处理）；core 的 `windows-sys` 去掉 4 个已无代码可用的 feature（Crypto/WinTrust/Security/Memory，都是 egui 版字体映射与 WinVerifyTrust 的遗留）；`cargo clippy --all-targets -- -D warnings` 在 core 与 sidecar **双双回到 0 告警**（原来 13 处：过时文档注释、可合并 if、过多参数、多余借用、bool 断言等），CI 那道门禁终于真的能过
- 工程（P1-15 折中版）：错误码成为归类**唯一来源**（`crates/core/src/err.rs`，17 个编号；sidecar 不再自己维护一份 `err_code`，补齐了 SM / DLSS5 / 备份 / 扫描 / 配置 / 文件 IO / 系统目录拒绝七类此前一律落到 `GEN-999` 的错误）；英文界面先按中文原文查表，整句没译文时**按编号兜底**（`ui/lib.js` 的 `backText`），编号始终留在消息末尾供报障；`i18n-coverage.py` 新增门禁「core 的每个错误码必须有英文」，preflight 打印 `ERR-CODE` 行
- 修复：`main.js` 拼在错误末尾的 `[CODE]` 会让原文永远匹配不到词表（键是纯中文原文），等于把译文憋掉 —— 现在翻译前先切掉编号，译完再接回
- 工程（P1-12）：前端按页拆文件 —— `app.js` 2596 → 594 行，新增 `ui/settings.js`（设置/关于/更新弹窗/日志）、`ui/deploy.js`（详情对话框 + 部署/还原/清理）、`ui/dlss5.js`、`ui/sm.js`、`ui/library.js`（库页 + 封面/瓦片墙/扫描）；函数名与函数体一律不变（只移动不重写），脚本顺序改为 `i18n → lib → settings → deploy → dlss5 → sm → library → app`，e2e 与词表检查改为从 `index.html` 读脚本清单，`preflight` 的语法门禁覆盖整个 `ui/`
- 工程（P1-7）：备份/还原的公共层抽到 `crates/core/src/backup_restore.rs`（`BackupPlan` + `capture` / `snapshot_one` / `load_originals` / `apply` / `rollback`），帧生成、解锁组件、DLSS5 三处不再各写一份；所有清单路径统一 `safe_join`，备份名统一扁平化，失败回滚如实报告成败（不谎报「已回滚」）
- 工程：新增 `packaging/push-release.ps1`（从**本地仓库**推 main + tag 并校验远端 SHA）与 `packaging/bench.ps1`（启动/扫描/部署基线：54 ms / 49 ms / 524 ms）
- 修复：日志时间戳改用本地时间（`GetLocalTime`）；移除与既有【复制】重复的【诊断】按钮

## v1.5.0

- 帧生成资产升级到 **0.4.1**（内核 / 后端 / xefg / sr / INI 全换，代理与 INI 同步）
- DLSS-G 预设改为 A / B / C（`Auto` 删除，默认 A）；新增 3X
- XeSS 引擎支持 2X / 3X / 4X（选 XeSS 时隐藏 6X，后端夹到 4X）
- 超分加速改为五选一预设（Off / M-INT8 / L-INT8 / M-FP16 / L-FP16）
- 移除帧生成页「帧生成Mod及帧生成运行库」卡片

## v1.4.0

- DLSS5 更换为 GITC Uplift 1.6.2（DX9–12 / Vulkan / OpenGL，32 / 64 位）
- 内置 ReShade 效果包（标准 + SweetFX + iMMERSE + lilium，108 个文件）
