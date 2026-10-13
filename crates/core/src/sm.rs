//! Smooth Motion（30 系，实验性）—— 适用性判定与只读探测。
//!
//! 产品规定：**驱动 >= 616.64 才允许部署**，低于该版本一律不允许
//! （见 docs/SM-事实来源与策略.md；该门槛是本项目的决定，不是上游/NVIDIA 的要求）。
//!
//! 本模块**只读**：不写驱动 profile、不动任何文件。写入逻辑在后续步骤里单独实现，
//! 且只允许写"绑定到某个游戏 EXE"的 profile，绝不写全局/基础 profile。

use crate::gpu;

/// 允许部署 SM 的最低驱动版本（硬门槛，产品规定）。
pub const MIN_SM_DRIVER: (u32, u32) = (616, 64);
pub const MIN_SM_DRIVER_TEXT: &str = "616.64";

/// 适用性判定结果（界面直接显示 reason）。
#[derive(Debug, Clone)]
pub struct Gate {
    /// 30 系 / SM86？
    pub is_sm86: bool,
    pub gpu_name: String,
    /// 市场版本号，如 "617.42"；读不到则空串
    pub driver: String,
    pub version: Option<(u32, u32)>,
    /// 版本号是从哪读来的
    pub source: &'static str,
    /// 是否允许部署
    pub allowed: bool,
    /// 不允许的原因（允许时为空）
    pub reason: String,
}

/// 按产品规定判定能不能部署 SM（读本机实际信息）。
pub fn gate() -> Gate {
    let gpu_name = crate::scan::detect_gpu().unwrap_or_default();
    let is_sm86 = matches!(crate::scan::classify_gpu(&gpu_name), crate::scan::GpuRoute::Sm86);
    let raw = gpu::nvidia_smi_version();
    gate_for(raw.as_deref(), is_sm86, &gpu_name)
}

/// 纯判定版本（不碰系统），自测与界面预览都用它。
pub fn gate_for(driver_raw: Option<&str>, is_sm86: bool, gpu_name: &str) -> Gate {
    let (driver, version) = match driver_raw {
        Some(s) => (s.trim().to_owned(), gpu::parse_marketing_version(s)),
        None => (String::new(), None),
    };
    let mut allowed = true;
    let mut reason = String::new();
    if !is_sm86 {
        allowed = false;
        reason = format!(
            "当前显卡「{}」不是 30 系（SM86）—— 这个解锁只对 30 系有效。",
            if gpu_name.is_empty() { "未知" } else { gpu_name }
        );
    } else if version.is_none() {
        allowed = false;
        reason = "读不到 NVIDIA 驱动版本（需要已安装的 NVIDIA 驱动与 nvidia-smi）。".to_owned();
    } else if version.unwrap() < MIN_SM_DRIVER {
        allowed = false;
        reason = format!(
            "驱动 {} 低于本工具要求的最低版本 {} —— 按产品规定不允许部署。",
            driver, MIN_SM_DRIVER_TEXT
        );
    }
    Gate {
        is_sm86,
        gpu_name: gpu_name.to_owned(),
        driver,
        version,
        source: "nvidia-smi --query-gpu=driver_version",
        allowed,
        reason,
    }
}

/// 一个 NvPresent 文件（驱动里真正实现呈现层插帧的组件；解锁是否生效由它的构建决定）。
#[derive(Debug, Clone)]
pub struct NvPresent {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    /// 是否在本工具的"已识别构建"表里
    pub recognized: bool,
    pub note: String,
}

/// 上游报告的"已识别构建"：(驱动版本, 字节数, sha256, 说明)。
///
/// 只有列在这里的构建才会被标成"已验证/实验"；其余标为"未被识别"。
/// **注意**：这张表**不拦部署** —— 是否允许部署由上面的驱动门槛决定；
/// 这里只影响界面的如实标注与"未被识别 → 二次确认"。
pub const KNOWN_BUILDS: &[(&str, u64, &str, &str)] = &[(
    "616.64",
    8_417_512,
    "f36a5f10458a9b67833df97ea2a4634d8c03b634d8edcbfbd9e49bc47ad8b54e",
    "上游报告的黄金构建（PROJECT_VALIDATED；我方尚未实机核对）",
)];

/// 探测本机所有 NvPresent 构建（只读；按字节数倒序，最大的通常是当前驱动那份）。
pub fn nvpresent_all() -> Vec<NvPresent> {
    let mut out: Vec<NvPresent> = Vec::new();
    let Some(root) = std::env::var_os("SystemRoot") else {
        return out;
    };
    let store = std::path::Path::new(&root)
        .join("System32")
        .join("DriverStore")
        .join("FileRepository");
    let Ok(rd) = std::fs::read_dir(&store) else {
        return out;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.starts_with("nv_dispi.inf_") {
            continue;
        }
        for file in ["NvPresent64.dll", "NvPresent.dll"] {
            let p = e.path().join(file);
            if !p.is_file() {
                continue;
            }
            let bytes = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let sha256 = crate::util::sha256_file(&p).unwrap_or_default();
            let hit = KNOWN_BUILDS
                .iter()
                .find(|(_, b, h, _)| *b == bytes && h.eq_ignore_ascii_case(&sha256));
            out.push(NvPresent {
                path: p.display().to_string(),
                bytes,
                sha256,
                recognized: hit.is_some(),
                note: hit.map(|(d, _, _, n)| format!("对应驱动 {d}：{n}")).unwrap_or_else(|| {
                    "这个构建不在本工具的已识别清单里（上游可能尚未适配该驱动）".to_owned()
                }),
            });
        }
    }
    out.sort_by_key(|x| std::cmp::Reverse(x.bytes));
    out
}
