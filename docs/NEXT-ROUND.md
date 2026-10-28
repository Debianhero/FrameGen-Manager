# 下一轮交接单（新会话先读这一页）

> 用途：结构性重构（P1-7 抽 `backup_restore`、P1-12 拆 `app.js`）建议在**新会话**做，
> 上下文更短、出错更少。新会话读完这一页即可开工，不必回溯历史。

## 1. 项目速览

| 项 | 值 |
|---|---|
| 仓库根 | `D:\AI Work\FrameGen Manager\dlssg-manager`（**本地 git 仓库已存在**，别再 `git init`） |
| 技术栈 | Rust core + sidecar（stdin/stdout JSON 行协议）+ Electron（`main.js` / `ui/*.js`） |
| 版本 | **1.5.1**（4 处：根 `Cargo.toml`、`crates/core`、`apps/sidecar`、`apps/electron/package.json`） |
| 数据目录 | 安装版 `%APPDATA%\FrameGen-Manager`；便携版 = exe 同目录 |
| 架构 | 见 `docs/ARCH.md`；变更见 `docs/CHANGELOG.md` |

## 2. 必跑的命令

```powershell
# 提交前自检（双 CR / JS 语法 / 词表 / core+sidecar 测试）
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\preflight.ps1

# UI 端到端（jsdom，不启 Electron）
cd ..\dev-only\ui-e2e
$env:NODE_PATH="C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"
& "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" run.js

# 升版本（改 4 处 + 自校验）
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\bump-version.ps1 -Version 1.5.2

# 性能基线
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\bench.ps1
```

## 3. 踩过的坑（**务必遵守**）

1. **不要用 shell heredoc 写含 `&&` / `||` 的代码**：会被吞成 `;`，Rust/JS 直接语法错。
   写 Rust 时用嵌套 `if`；必要时用 `chr(124)*2` 拼 `||`。
2. **写文件用 `Path.write_bytes(...encode('utf-8'))`**，不要 `write_text(text.replace('\n','\r\n'))`
   —— Python 会再翻译一次换行，产出 `\r\r\n`（曾把 `app.js` 行数翻倍）。
3. **i18n 词表**：`dev-only/en-dict.json` 是**四段结构**（`app.js` / `html` / `html_text` / `core`），
   缩进 `indent=1`；改完跑 `dev-only/i18n-gen.py` 生成 `ui/i18n.js`，再跑 `i18n-coverage.py` 必须 0 缺。
   `i18n-coverage.py` 已覆盖 `app.js` + `lib.js`。
4. **代理/资产哈希表**：`deploy::PROXY_ASSET_SHA256`（6 个代理）与 `ASSET_INVENTORY`（核心 6+2）
   各管一摊；换资产必须同步，否则单测 `proxy_table_matches_bundled_assets` 会挂（它读真实 `bundled-assets/`）。
5. 前端脚本顺序：`i18n.js` → `lib.js` → `app.js`；e2e 里是手工 eval，改顺序要同步改 `dev-only/ui-e2e/run.js`。

## 4. 下一轮目标（按顺序）

### P1-7 抽 `backup_restore`

- 现状：`deploy.rs` / `sm.rs` / `dlss5.rs` 各有一套「读记录 → 备原件 → 写新文件 → 校验 → 失败回滚」。
- 目标：新建 `crates/core/src/backup_restore.rs`，暴露
  `BackupPlan { entries: Vec<(rel, existed_before, bytes)> }` + `apply(dir, plan)` + `rollback(dir, plan)`；
  三个业务只负责“清单与策略”。
- DoD：三处调用点行为不变；新增 3 条单测（覆盖：原件恢复、回滚、无记录时直接写）；
  `cargo test` 全绿；沙箱“部署→还原”文件级对照一致。
- 风险：回滚路径写错会让用户**丢原件**。分两次提交：先抽只读部分，再替换写入部分。

### P1-12 拆 `app.js`（当前 2596 行）

- 现状：`ui/lib.js`（111 行，纯工具）已抽出；`app.js` 仍含库页/部署弹窗/SM/DLSS5/设置全部逻辑。
- 目标顺序（每次只做一步，跑完 e2e 再提交）：
  1. `ui/settings.js`（设置页 + 关于页）
  2. `ui/deploy.js`（游戏详情对话框 + 部署/还原/清理）
  3. `ui/sm.js` / `ui/dlss5.js`
  4. 剩下 `app.js` 只留启动、tab、库列表
- DoD：`app.js` ≤600 行；每个新文件 ≤600 行；e2e 全过；`preflight` 全绿。
- 风险：函数被多处引用 → 拆分时**只移动不重写**，全局函数名保持不变。

## 5. 明确不做（已决策）

- 代码签名（SmartScreen 拦截保留）；
- 硬链接部署（游戏/反作弊回写会污染资产）；
- 卸载时删除游戏目录里的部署文件（用户资产，不动）；
- NSIS 内页深色（受 electron-builder 布局限制）。

## 6. 已知限制（别再当 bug 查）

- 驱动闸门在 `nvidia-smi` 缺失时是 `unknown`：**提示但不拦截**。
- ReShade 识别 = PE 版本串含 `ReShade`；无版本资源的构建退回已知哈希（当前 6.8.0）。
- core 仍返回中文错误串，英文界面靠 `backText` 词表映射（P1-15 未做）。
