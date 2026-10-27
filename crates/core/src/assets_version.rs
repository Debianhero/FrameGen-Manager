//! 内置资产的**展示用**版本号（不参与"是否有更新"的判定 —— 判定看文件指纹）。
//!
//! 更新内置资产时只需改这里的常量；判定逻辑比较的是"记录里部署的文件指纹"与
//! "当前内置文件指纹"，所以忘记改版本号也不会漏提示，改了但文件没变也不会误报。

/// 帧生成资产（dlssg_sm86 那一套）
pub const FRAMEGEN: &str = "0.4.1";
/// Smooth Motion 解锁组件（单版本号：不区分 20/30 系，判定靠指纹）
pub const SMOOTH_MOTION: &str = "2.8.5 Fix5";
/// DLSS5 核心插件（GITC Uplift）
pub const DLSS5_CORE: &str = "GITC 1.6.2";
/// ReShade（Addon 版）
pub const RESHADE: &str = "6.8.0";
/// 帧生成当前内置运行库版本（改运行库时同步改）
pub const FRAMEGEN_RUNTIME: &str = "310.9.16";
