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

### ~~P1-7 抽 `backup_restore`~~（已完成，见 `docs/CHANGELOG.md` 的 v1.5.1「工程（P1-7）」）

- `crates/core/src/backup_restore.rs`：`BackupPlan { entries: Vec<(rel, existed_before, bytes)> }`
  + `capture` / `snapshot_one` / `load_originals` / `apply` / `rollback`（含 7 条单测）。
- 三处调用点已接入：`deploy.rs`（部署备份 + `restore_with`）、`sm.rs`（`asset_deploy`，旧的
  `rollback_asset_files` 已删）、`dlss5.rs`（部署备份 + `rollback_entries`）。
- 遗留：`sm::asset_restore`（关闭组件）仍按记录里的绝对路径逐个 copy，未接入公共层；
  它的「备份是本项目组件就直接删」属于特例策略，等下次动它时再抽。

### ~~P1-12 拆 `app.js`~~（已完成，见 `docs/CHANGELOG.md` 的 v1.5.1「工程（P1-12）」）

- 现状：`app.js` **594 行**，只剩启动 / 页签 / 弹窗与进度条公共件 / GPU 闸门 / 事件绑定；
  其余按页拆到 `ui/settings.js`（315）、`ui/deploy.js`（553）、`ui/dlss5.js`（385）、
  `ui/sm.js`（323）、`ui/library.js`（469），加上原有的 `ui/lib.js`（107）。
- 加载顺序（`index.html` 是唯一来源，e2e 与 `i18n-coverage.py` 都从它读）：
  `i18n.js → lib.js → settings.js → deploy.js → dlss5.js → sm.js → library.js → app.js`
- **踩过的坑（后续拆分别再踩）**：
  1. `app.js` 原来是整文件一个 IIFE，块搬不走（函数/状态对外不可见）→ 第 0 步先去 IIFE。
  2. **脚本顶层不能写 `'use strict'`**：e2e 用 `win.eval` 加载，严格模式 eval 里的
     `var`/`function` 不会挂到全局，`settings.js` 就看不到 `app.js` 的 `invoke`/`CFG`
     （浏览器脚本级严格模式没这问题，但两条路径必须一致）。已写进 `app.js` 顶部注释。
  3. 搬运时保持函数体原样（只移动不重写），搬完跑一次跨文件同名声明检查，
     再跑 `node --check` + `ui-e2e`；`preflight` 的语法门禁已覆盖整个 `ui/`。

## 5. 明确不做（已决策）

- 代码签名（SmartScreen 拦截保留）；
- 硬链接部署（游戏/反作弊回写会污染资产）；
- 卸载时删除游戏目录里的部署文件（用户资产，不动）；
- NSIS 内页深色（受 electron-builder 布局限制）。

## 6. 已知限制（别再当 bug 查）

- 驱动闸门在 `nvidia-smi` 缺失时是 `unknown`：**提示但不拦截**。
- ReShade 识别 = PE 版本串含 `ReShade`；无版本资源的构建退回已知哈希（当前 6.8.0）。
- core 仍返回**中文**错误串（P1-15 只做了「折中版」）：每类错误带一个稳定编号
  （`crates/core/src/err.rs` 是唯一来源，sidecar 直接转发），英文界面在「整句没有译文」时
  按编号出英文（`ui/lib.js` 的 `backText`），编号词表在 `dev-only/en-dict.json` 的 `core` 段。
  **加新错误码时忘了加英文 → `i18n-coverage.py` 直接失败**（preflight 打印 `ERR-CODE` 行）。
  若要把报错正文也改成「code + 参数」（完整版 P1-15），那是另一轮的事。
