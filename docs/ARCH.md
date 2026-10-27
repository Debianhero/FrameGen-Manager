# 架构速览

## 进程模型

- **Electron 主进程** `apps/electron/main.js`：窗口、更新弹窗、自更新下载、把 IPC 转发给 sidecar。
- **Sidecar** `apps/sidecar`（Rust，长驻 stdin/stdout JSON 行协议）：所有"真活"——扫描、部署、还原、卸载、SM、DLSS5、自更新下载。
- **渲染进程** `apps/electron/ui`：纯 UI，通过 `invoke(cmd, args)` 调 sidecar。

协议：

```
请求  {"id":1,"cmd":"x","args":{}}
成功  {"id":1,"ok":true,"result":{}}
失败  {"id":1,"ok":false,"error":"...","code":"DRV-001"}
进度  {"id":1,"event":"progress","payload":{"msg":"...","fraction":0.42}}
```

错误码见 `apps/sidecar/src/main.rs::err_code`；UI 把 code 拼在消息尾部，方便用户截图报障。

## 数据目录

| 场景 | 位置 |
|---|---|
| 安装版 | `%APPDATA%\FrameGen-Manager`（由 exe 旁的 `installed.txt` 标记决定） |
| 便携版 | exe 同目录 |

内容：`config.json`、`game_library.json`、`assets\`（内置资产落盘）、`backups\`（部署记录 + 原件备份）、`logs\`。

## 资产与"是否有更新"

- 判定**只看文件指纹**（大小 + SHA256；大文件比首尾块），不看版本号。
- 版本号常量 `core/src/assets_version.rs` 仅用于展示。
- 统一入口：`core/src/assets_audit.rs::scan(dir) -> {fg, sm, dlss5}`。sidecar 与 UI 都只能走它。
- 三类实现：`deploy::is_outdated`（布局 / 运行库版本）、`sm::is_outdated`（部署记录里的哈希）、`dlss5::is_outdated`（关键文件指纹）。

## 写入安全

- 清单（manifest）里的 `rel_path` 一律走 `util::safe_join`：拒绝绝对路径、`..`、盘符 / UNC、Windows 保留名。
- sidecar 所有会写目录的命令先过 `checked_dir` / `checked_exe`：存在、绝对路径、非系统目录。

## 约定

- 版本号在 4 个文件里，用 `packaging/bump-version.ps1 -Version x.y.z` 一键改并自校验。
- 发版前必须全绿：`cargo test`、`i18n-coverage.py`、`ui-e2e/run.js`、`packaging/build-release.ps1` 门禁。
