//! FrameGen Manager 的业务核心（无 UI 依赖）。
//!
//! 迁移进度见 `dev-only/MIGRATION-TAURI.md`：B1.2 已完成 util 的搬入。

pub mod assets_audit;
pub mod assets_version;
pub mod util;
/// 错误码归类（P1-15 折中版）：core 仍返回中文串，这里给每类错误一个稳定编号
pub mod err;
pub mod log;
pub mod gpu;
pub mod update;
pub mod scan;
/// 部署 / 还原共用的「原件计划」（P1-7；当前只有只读的一半，尚未接进三处业务）
pub mod backup_restore;
pub mod deploy;
pub mod dlss5;
pub mod sm;
pub mod icon;
