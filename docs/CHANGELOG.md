# 变更记录

## v1.5.1（未发布）

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
- 升级体验：内置资产换版本后，「资产有更新」弹窗**不再对已经是 GITC 的 DLSS5 部署执行「彻底卸载」**（那条路会连整个 `reshade-shaders` 一起删掉，用户自备的预设 / 效果包就没了）。现在分成两类：旧版 RenoDX 插件才需要卸载（保留【全部清除】）；只是资产旧了的，改为单按钮告知「到 DLSS5 页点一次部署即可」，**不提供清除动作**。同时：内置资产铺设不再因为缺 `bundled-assets` 就整段跳过 `bundled-dlss5`
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
