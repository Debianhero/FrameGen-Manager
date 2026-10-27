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

## v1.5.0

- 帧生成资产升级到 **0.4.1**（内核 / 后端 / xefg / sr / INI 全换，代理与 INI 同步）
- DLSS-G 预设改为 A / B / C（`Auto` 删除，默认 A）；新增 3X
- XeSS 引擎支持 2X / 3X / 4X（选 XeSS 时隐藏 6X，后端夹到 4X）
- 超分加速改为五选一预设（Off / M-INT8 / L-INT8 / M-FP16 / L-FP16）
- 移除帧生成页「帧生成Mod及帧生成运行库」卡片

## v1.4.0

- DLSS5 更换为 GITC Uplift 1.6.2（DX9–12 / Vulkan / OpenGL，32 / 64 位）
- 内置 ReShade 效果包（标准 + SweetFX + iMMERSE + lilium，108 个文件）
