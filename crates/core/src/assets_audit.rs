//! 三类内置资产「本机部署是否旧于当前内置」的**唯一入口**。
//!
//! 各模块自己的判定实现保持不变（判定口径不同：帧生成看布局/运行库，SM 看部署记录
//! 里的文件哈希，DLSS5 看关键文件指纹），但对外只暴露这一个函数，避免上层各写一套、
//! 说着不同的话（之前 sidecar / UI 各自拼装，出过“弹窗说没更新但卡片显示旧版”）。

/// 三类资产里哪些有更新（true = 需要重新部署）。
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct Outdated {
    pub fg: bool,
    pub sm: bool,
    pub dlss5: bool,
}

impl Outdated {
    pub fn any(self) -> bool {
        if self.fg {
            return true;
        }
        if self.sm {
            return true;
        }
        self.dlss5
    }
}

/// 扫一个目录（= 部署目标目录，通常是 exe 所在目录）。
pub fn scan(dir: &std::path::Path) -> Outdated {
    Outdated {
        fg: crate::deploy::is_outdated(dir),
        sm: crate::sm::is_outdated(dir),
        dlss5: crate::dlss5::is_outdated(dir),
    }
}
