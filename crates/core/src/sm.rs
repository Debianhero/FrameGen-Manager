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

// ---------------------------------------------------------------- NVAPI（只读）

/// 驱动 profile 里某个设置项的读取结果。
#[derive(Debug, Clone)]
pub struct SettingState {
    /// 未设置 / 已开启 / 已关闭 / 读取失败
    pub state: &'static str,
    pub value: Option<u32>,
    /// 出错时的原始信息（只进日志与诊断，不上界面）
    pub detail: String,
}

/// Smooth Motion 开关这一项在驱动里的设置 ID（来源：Profile Inspector 的
/// CustomSettingNames.xml，0=Off / 1=On）。见工作区里的 SM 事实来源记录。
pub const SM_SETTING_ID: u32 = 0xB0D3_84C0;

/// 读**基础/全局 profile**里的 SM 开关（只读；本工具**绝不写**这一层）。
pub fn base_sm_state() -> SettingState {
    match nv::read_base_setting(SM_SETTING_ID) {
        Ok(1) => SettingState { state: "已开启", value: Some(1), detail: String::new() },
        Ok(0) => SettingState { state: "已关闭", value: Some(0), detail: String::new() },
        Ok(v) => SettingState { state: "未设置", value: Some(v), detail: String::new() },
        Err(e) if e.starts_with("rc=-160") => SettingState { state: "未设置", value: None, detail: e },
        Err(e) => SettingState { state: "读取失败", value: None, detail: e },
    }
}

/// NVAPI 动态调用（只读）。不链接 import 库 —— nvapi64.dll 随 NVIDIA 驱动安装。
#[cfg(windows)]
mod nv {
    use std::ffi::c_void;

    const ID_INIT: u32 = 0x0150_E828;
    const ID_CREATE_SESSION: u32 = 0x0694_D52E;
    const ID_LOAD_SETTINGS: u32 = 0x375D_BD6B;
    const ID_GET_BASE_PROFILE: u32 = 0xDA84_66A0;
    const ID_GET_SETTING: u32 = 0x73BF_8338;

    /// NVDRS_SETTING：56 字节，布局与 Profile Inspector 的声明一致
    /// （version 字段里编码了结构体大小，驱动会校验它）。
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct NvSetting {
        version: u32,
        setting_name: u32,
        setting_type: u32,
        setting_location: u32,
        is_current_predefined: u32,
        is_predefined_valid: u32,
        predefined: [u8; 16],
        current: [u8; 16],
    }

    type FnQuery = unsafe extern "C" fn(u32) -> *mut c_void;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 读基础 profile 里的一个 u32 设置项。
    pub fn read_base_setting(id: u32) -> Result<u32, String> {
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
        unsafe {
            let lib = LoadLibraryW(wide("nvapi64.dll").as_ptr());
            if lib.is_null() {
                return Err("加载 nvapi64.dll 失败（没装 NVIDIA 驱动？）".to_owned());
            }
            let Some(p) = GetProcAddress(lib, c"nvapi_QueryInterface".as_ptr() as *const u8) else {
                return Err("nvapi64.dll 里没有 nvapi_QueryInterface".to_owned());
            };
            let query: FnQuery = std::mem::transmute(p);

            let init: unsafe extern "C" fn() -> i32 = std::mem::transmute(query(ID_INIT));
            let rc = init();
            if rc != 0 {
                return Err(format!("NvAPI_Initialize rc={rc}"));
            }
            let mut sess: *mut c_void = std::ptr::null_mut();
            let create: unsafe extern "C" fn(*mut *mut c_void) -> i32 =
                std::mem::transmute(query(ID_CREATE_SESSION));
            let rc = create(&mut sess);
            if rc != 0 {
                return Err(format!("DRS_CreateSession rc={rc}"));
            }
            let load: unsafe extern "C" fn(*mut c_void) -> i32 =
                std::mem::transmute(query(ID_LOAD_SETTINGS));
            let rc = load(sess);
            if rc != 0 {
                return Err(format!("DRS_LoadSettings rc={rc}"));
            }
            let mut prof: *mut c_void = std::ptr::null_mut();
            let getbase: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32 =
                std::mem::transmute(query(ID_GET_BASE_PROFILE));
            let rc = getbase(sess, &mut prof);
            if rc != 0 {
                return Err(format!("DRS_GetBaseProfile rc={rc}"));
            }
            let mut st = NvSetting::default();
            st.version = ((std::mem::size_of::<NvSetting>() as u32) << 16) | 1;
            let get: unsafe extern "C" fn(*mut c_void, *mut c_void, u32, *mut NvSetting) -> i32 =
                std::mem::transmute(query(ID_GET_SETTING));
            let rc = get(sess, prof, id, &mut st);
            if rc != 0 {
                return Err(format!("rc={rc}"));
            }
            Ok(u32::from_le_bytes([
                st.current[0],
                st.current[1],
                st.current[2],
                st.current[3],
            ]))
        }
    }
}
