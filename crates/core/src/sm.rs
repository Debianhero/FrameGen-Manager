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
    let sess = match nv::Session::open() {
        Ok(s) => s,
        Err(e) => return SettingState { state: "读取失败", value: None, detail: e },
    };
    let prof = match sess.base() {
        Ok(p) => p,
        Err(e) => return SettingState { state: "读取失败", value: None, detail: e },
    };
    state_from_read(sess.read(prof, SM_SETTING_ID))
}

fn state_from_read(r: Result<u32, String>) -> SettingState {
    match r {
        Ok(1) => SettingState { state: "已开启", value: Some(1), detail: String::new() },
        Ok(0) => SettingState { state: "已关闭", value: Some(0), detail: String::new() },
        Ok(v) => SettingState { state: "未设置", value: Some(v), detail: String::new() },
        Err(e) if e.starts_with("rc=-160") => SettingState { state: "未设置", value: None, detail: e },
        Err(e) => SettingState { state: "读取失败", value: None, detail: e },
    }
}

/// 某个游戏 EXE 在驱动里对应的 SM 状态（只读）。
#[derive(Debug, Clone)]
pub struct ExeProfileState {
    /// 驱动里有没有挂这个 EXE 的 profile
    pub found: bool,
    /// 命中的 profile 里登记的应用名（诊断用）
    pub matched: Vec<String>,
    pub state: SettingState,
    pub detail: String,
    /// 诊断：枚举到多少个 profile、第一个 profile 的应用名样例、各步返回码
    pub profile_count: usize,
    pub sample_apps: Vec<String>,
    pub diag: Vec<String>,
}

/// 按 EXE 读 SM 开关。匹配规则：profile 登记的应用名与 EXE 的**文件名**一致
/// （忽略大小写）—— NVIDIA 的 profile 里有的存完整路径、有的只存文件名。
pub fn exe_sm_state(exe: &std::path::Path) -> ExeProfileState {
    let want = exe
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut out = ExeProfileState {
        found: false,
        matched: Vec::new(),
        state: SettingState { state: "未设置", value: None, detail: String::new() },
        detail: String::new(),
        profile_count: 0,
        sample_apps: Vec::new(),
        diag: Vec::new(),
    };
    if want.is_empty() {
        out.state = SettingState { state: "读取失败", value: None, detail: "没有给 EXE 路径".to_owned() };
        out.detail = "没有给 EXE 路径".to_owned();
        return out;
    }
    let sess = match nv::Session::open() {
        Ok(s) => s,
        Err(e) => {
            out.state = SettingState { state: "读取失败", value: None, detail: e.clone() };
            out.detail = e;
            return out;
        }
    };
    let profs = sess.profiles();
    out.profile_count = profs.len();
    out.diag.push(format!("profiles={}", profs.len()));
    for (idx, prof) in profs.into_iter().enumerate() {
        let apps = sess.apps(prof);
        if idx == 0 {
            out.sample_apps = apps.clone();
            out.diag.push(format!("apps(first profile)={}", apps.len()));
            // 当前驱动/接口版本上 EnumApplications 被拒（rc=-9 INVALID_POINTER）：
            // 拿不到应用列表就没法按 EXE 匹配，直接停，不白跑几百次调用。
            if apps.is_empty() {
                out.diag.push("读取应用列表被拒，按 EXE 的匹配暂不可用".to_owned());
                break;
            }
        }
        let hit = apps.iter().any(|a| {
            std::path::Path::new(a)
                .file_name()
                .map(|f| f.to_string_lossy().to_ascii_lowercase() == want)
                .unwrap_or(false)
        });
        if !hit {
            continue;
        }
        out.found = true;
        out.matched = apps;
        out.state = state_from_read(sess.read(prof, SM_SETTING_ID));
        break;
    }
    if !out.found {
        out.detail = "驱动里没有挂这个 EXE 的 profile（还没为它建过驱动配置）".to_owned();
        out.diag.push(format!("scanned={} profiles, exe={}", out.profile_count, want));
    }
    out
}

/// NVAPI 动态调用（只读）。不链接 import 库 —— nvapi64.dll 随 NVIDIA 驱动安装。
#[cfg(windows)]
mod nv {
    use std::ffi::c_void;

    const ID_INIT: u32 = 0x0150_E828;
    const ID_CREATE_SESSION: u32 = 0x0694_D52E;
    const ID_LOAD_SETTINGS: u32 = 0x375D_BD6B;
    const ID_GET_BASE_PROFILE: u32 = 0xDA84_66A0;
    const ID_FIND_PROFILE: u32 = 0x7E4A_9A0B;
    const ID_CREATE_PROFILE: u32 = 0xCC17_6068;
    const ID_CREATE_APPLICATION: u32 = 0x4347_A9DE;
    /// 写设置：**必须用首选 ID**。实测回退 ID 0x577DD202 对 Smooth Motion 返回 -160，
    /// 而首选 ID 返回 0 —— 这就是之前那个误导性 -160 的真凶。
    const ID_SET_SETTING: u32 = 0x8A2C_F5F5;
    const ID_SAVE_SETTINGS: u32 = 0xFCBC_7E14;
    const ID_DELETE_PROFILE: u32 = 0x1709_3206;
    /// 删掉某个 profile 里的单项设置（PI 的"恢复默认"就是用它，而不是写 0）。
    /// 和写设置一样，用首选 ID（与 PI 的 GetDelegate 调用顺序一致）。
    const ID_DELETE_PROFILE_SETTING: u32 = 0xD20D_29DF;
    /// 读设置：优先用 PI 的首选 ID（它和回退 ID 的参数个数不同，这里必须用首选）
    const ID_GET_SETTING: u32 = 0xEA99_498D;

    /// NVDRS_SETTING：**12320 字节**，与 Profile Inspector 的声明逐字段对齐
    /// （version 低位放结构体大小、高位放版本号：size | (1 << 16)）。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NvSetting {
        version: u32,
        /// 设置名（2048 个 wchar，内联；这里用不到但必须占位，否则偏移全错）
        setting_name: [u16; 2048],
        setting_id: u32,
        setting_type: u32,
        setting_location: u32,
        is_current_predefined: u32,
        is_predefined_valid: u32,
        predefined: [u8; 4100],
        current: [u8; 4100],
    }

    impl NvSetting {
        fn new(id: u32) -> NvSetting {
            let mut st: NvSetting = unsafe { std::mem::zeroed() };
            st.version = (std::mem::size_of::<NvSetting>() as u32) | (1 << 16);
            st.setting_id = id;
            // 名字必须填。Profile Inspector 写进驱动的就是这串固定占位串
            // （从 PI 写好的 CS2 profile 里读出来的原文正是 PLACEHOLDER）。
            for (i, c) in "PLACEHOLDER".encode_utf16().enumerate() {
                st.setting_name[i] = c;
            }
            st
        }

        fn value(&self) -> u32 {
            u32::from_le_bytes([
                self.current[0], self.current[1], self.current[2], self.current[3],
            ])
        }
    }

    type FnQuery = unsafe extern "C" fn(u32) -> *mut c_void;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }


    // ---- 按 EXE 定位 profile（只读）----

    const ID_ENUM_PROFILES: u32 = 0xBC37_1EE0;
    const ID_ENUM_APPLICATIONS: u32 = 0x7FA2_173A;

    fn wide_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// 一次 NVAPI 会话（只读使用）。
    pub struct Session {
        sess: *mut c_void,
        query: FnQuery,
    }

    impl Session {
        pub fn open() -> Result<Session, String> {
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
                Ok(Session { sess, query })
            }
        }

        pub(crate) fn base(&self) -> Result<*mut c_void, String> {
            unsafe {
                let mut prof: *mut c_void = std::ptr::null_mut();
                let f: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> i32 =
                    std::mem::transmute((self.query)(ID_GET_BASE_PROFILE));
                let rc = f(self.sess, &mut prof);
                if rc != 0 {
                    return Err(format!("DRS_GetBaseProfile rc={rc}"));
                }
                Ok(prof)
            }
        }

        /// 枚举所有 profile 的句柄（最多 5000 个，防死循环）。
        pub fn profiles(&self) -> Vec<*mut c_void> {
            let mut out = Vec::new();
            unsafe {
                let raw = (self.query)(ID_ENUM_PROFILES);
                if raw.is_null() {
                    crate::log::line("[sm] nvapi_QueryInterface(EnumProfiles) 返回空");
                    return out;
                }
                let f: unsafe extern "C" fn(*mut c_void, u32, *mut *mut c_void) -> i32 =
                    std::mem::transmute(raw);
                let mut seen: std::collections::HashSet<usize> = std::collections::HashSet::new();
                for i in 0..512u32 {
                    let mut prof: *mut c_void = std::ptr::null_mut();
                    let rc = f(self.sess, i, &mut prof);
                    if rc != 0 || prof.is_null() {
                        if i == 0 {
                            crate::log::line(&format!("[sm] EnumProfiles(0) rc={rc}"));
                        }
                        break;
                    }
                    // 有的驱动/接口版本不会返回 END_ENUMERATION，而是把同一个句柄一直吐出来：
                    // 句柄重复即视为枚举结束（否则会白跑几千次 API 调用）。
                    if !seen.insert(prof as usize) {
                        break;
                    }
                    out.push(prof);
                }
            }
            out
        }

        /// 取某个 profile 下挂的所有应用程序名（通常是 exe 的完整路径）。
        ///
        /// 注意签名：NVAPI 的 DRS_EnumApplications 是**5 个参数**
        /// （hSession, hProfile, startIndex, **ref appCount**, pApps）——
        /// 少传那个 count 会读进垃圾参数并让本进程崩溃（我们踩过）。
        /// 结构体用 NVDRS_APPLICATION_V4 的布局（version=0x500C0004 即 size<<16|4），
        /// 并用一整块足够大的缓冲区，避免驱动写越界。
        pub fn apps(&self, prof: *mut c_void) -> Vec<String> {
            const SLOTS: usize = 32;
            const APP_SIZE: usize = 20492; // V4: 4+4+5*4096+4
            let mut buf = vec![0u8; SLOTS * APP_SIZE];
            let ver: u32 = ((APP_SIZE as u32) << 16) | 4;
            for i in 0..SLOTS {
                let off = i * APP_SIZE;
                buf[off..off + 4].copy_from_slice(&ver.to_le_bytes());
            }
            let mut count: u32 = SLOTS as u32;
            unsafe {
                let raw = (self.query)(ID_ENUM_APPLICATIONS);
                if raw.is_null() {
                    return Vec::new();
                }
                let f: unsafe extern "C" fn(
                    *mut c_void,
                    *mut c_void,
                    u32,
                    *mut u32,
                    *mut c_void,
                ) -> i32 = std::mem::transmute(raw);
                let rc = f(self.sess, prof, 0, &mut count, buf.as_mut_ptr() as *mut c_void);
                if rc != 0 {
                    crate::log::line(&format!("[sm] EnumApplications rc={rc} count={count}"));
                    return Vec::new();
                }
            }
            let n = (count as usize).min(SLOTS);
            let mut out: Vec<String> = Vec::new();
            // 一个应用条目里 4 个名字字段都可能用来标识游戏：
            //   appName(偏移 8) / userFriendlyName(4104) / launcher(8200) / fileInFolder(12296)
            // NVIDIA 的预置 profile 有时只填 launcher 或 fileInFolder，所以四个都要看。
            const NAME_OFFSETS: [usize; 4] = [8, 4104, 8200, 12296];
            for i in 0..n {
                let base = i * APP_SIZE;
                for off in NAME_OFFSETS {
                    let start = base + off;
                    let mut name_buf = [0u16; 2048];
                    for (k, slot) in name_buf.iter_mut().enumerate() {
                        let p = start + k * 2;
                        if p + 1 >= buf.len() {
                            break;
                        }
                        *slot = u16::from_le_bytes([buf[p], buf[p + 1]]);
                    }
                    let name = wide_to_string(&name_buf);
                    if !name.is_empty() {
                        out.push(name);
                    }
                }
            }
            out
        }

        /// 读任意 profile 里的一个 u32 设置项。
        pub fn read(&self, prof: *mut c_void, id: u32) -> Result<u32, String> {
            unsafe {
                let mut st = NvSetting::new(id);
                let raw = (self.query)(ID_GET_SETTING);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_GetSetting".to_owned());
                }
                // 注意：DRS_GetSetting 实际是【5 个参数】（最后还有一个 ref uint）。
                // 少传会让被调函数读到垃圾参数，表现为「什么都读不到」——我们踩过。
                let f: unsafe extern "C" fn(
                    *mut c_void,
                    *mut c_void,
                    u32,
                    *mut NvSetting,
                    *mut u32,
                ) -> i32 = std::mem::transmute(raw);
                let mut extra: u32 = 0;
                let rc = f(self.sess, prof, id, &mut st, &mut extra);
                if rc != 0 {
                    return Err(format!("rc={rc}"));
                }
                Ok(st.value())
            }
        }

        /// 按名字找 profile。返回 Ok(None) 表示"没有这个 profile"（rc = -163）。
        pub fn find(&self, name: &str) -> Result<Option<*mut c_void>, String> {
            unsafe {
                let raw = (self.query)(ID_FIND_PROFILE);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_FindProfileByName".to_owned());
                }
                let f: unsafe extern "C" fn(*mut c_void, *const u16, *mut *mut c_void) -> i32 =
                    std::mem::transmute(raw);
                let w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
                let mut prof: *mut c_void = std::ptr::null_mut();
                let rc = f(self.sess, w.as_ptr(), &mut prof);
                if rc == 0 {
                    Ok(Some(prof))
                } else if rc == -163 {
                    Ok(None)
                } else {
                    Err(format!("DRS_FindProfileByName rc={rc}"))
                }
            }
        }

        /// 建一个**我们自己的** profile（NVDRS_PROFILE = 4116 字节）。
        pub fn create_profile(&self, name: &str) -> Result<*mut c_void, String> {
            unsafe {
                let raw = (self.query)(ID_CREATE_PROFILE);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_CreateProfile".to_owned());
                }
                let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> i32 =
                    std::mem::transmute(raw);
                let mut buf = vec![0u8; 4116];
                buf[0..4].copy_from_slice(&(4116u32 | (1u32 << 16)).to_le_bytes());
                let w: Vec<u16> = name.encode_utf16().collect();
                for (i, c) in w.iter().enumerate() {
                    let o = 4 + i * 2;
                    if o + 2 > buf.len() {
                        break;
                    }
                    buf[o..o + 2].copy_from_slice(&c.to_le_bytes());
                }
                let mut prof: *mut c_void = std::ptr::null_mut();
                let rc = f(self.sess, buf.as_mut_ptr() as *mut c_void, &mut prof);
                if rc != 0 {
                    return Err(format!("DRS_CreateProfile rc={rc}"));
                }
                Ok(prof)
            }
        }

        /// 把某个 exe 挂到我们的 profile 上（NVDRS_APPLICATION_V4 = 20492 字节）。
        /// rc = -167 表示这个 exe 已经被别的 profile 占了。
        pub fn create_application(
            &self,
            prof: *mut c_void,
            exe: &std::path::Path,
        ) -> Result<(), String> {
            unsafe {
                let raw = (self.query)(ID_CREATE_APPLICATION);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_CreateApplication".to_owned());
                }
                let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32 =
                    std::mem::transmute(raw);
                let mut buf = vec![0u8; 20492];
                buf[0..4].copy_from_slice(&(20492u32 | (4u32 << 16)).to_le_bytes());
                let text = exe.display().to_string();
                let w: Vec<u16> = text.encode_utf16().collect();
                for (i, c) in w.iter().enumerate() {
                    let o = 8 + i * 2;
                    if o + 2 > buf.len() {
                        break;
                    }
                    buf[o..o + 2].copy_from_slice(&c.to_le_bytes());
                }
                let rc = f(self.sess, prof, buf.as_mut_ptr() as *mut c_void);
                if rc != 0 {
                    return Err(format!("DRS_CreateApplication rc={rc}（-167 = 该 exe 已被别的配置占用）"));
                }
                Ok(())
            }
        }

        /// 写一个 DWORD 设置。返回驱动的原始返回码 —— **它不可信**
        /// （实测：SM 这一项返回 -160 但值其实写进去了），判成败必须靠读回复核。
        pub fn set_dword(&self, prof: *mut c_void, id: u32, value: u32) -> Result<i32, String> {
            unsafe {
                let raw = (self.query)(ID_SET_SETTING);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_SetSetting".to_owned());
                }
                // 同样是 5 个参数（结构体 + 两个 uint）
                let f: unsafe extern "C" fn(
                    *mut c_void,
                    *mut c_void,
                    *mut NvSetting,
                    u32,
                    u32,
                ) -> i32 = std::mem::transmute(raw);
                let mut st = NvSetting::new(id);
                st.current[0..4].copy_from_slice(&value.to_le_bytes());
                Ok(f(self.sess, prof, &mut st, 0, 0))
            }
        }

        pub fn save(&self) -> Result<(), String> {
            unsafe {
                let raw = (self.query)(ID_SAVE_SETTINGS);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_SaveSettings".to_owned());
                }
                let f: unsafe extern "C" fn(*mut c_void) -> i32 = std::mem::transmute(raw);
                let rc = f(self.sess);
                if rc != 0 {
                    return Err(format!("DRS_SaveSettings rc={rc}"));
                }
                Ok(())
            }
        }

        pub fn delete_profile(&self, prof: *mut c_void) -> Result<(), String> {
            unsafe {
                let raw = (self.query)(ID_DELETE_PROFILE);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_DeleteProfile".to_owned());
                }
                let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32 =
                    std::mem::transmute(raw);
                let rc = f(self.sess, prof);
                if rc != 0 {
                    return Err(format!("DRS_DeleteProfile rc={rc}"));
                }
                Ok(())
            }
        }

        /// 删掉某个 profile 里的一个设置项（= 恢复成"没有覆盖、跟随全局"）。
        pub fn delete_setting(&self, prof: *mut c_void, id: u32) -> Result<i32, String> {
            unsafe {
                let raw = (self.query)(ID_DELETE_PROFILE_SETTING);
                if raw.is_null() {
                    return Err("驱动没有提供 DRS_DeleteProfileSetting".to_owned());
                }
                let f: unsafe extern "C" fn(*mut c_void, *mut c_void, u32) -> i32 =
                    std::mem::transmute(raw);
                Ok(f(self.sess, prof, id))
            }
        }

        /// 这个句柄是不是**全局/基础 profile**？是的话一律拒绝写入（硬护栏）。
        pub fn is_base_profile(&self, prof: *mut c_void) -> bool {
            self.base().is_ok_and(|b| b == prof)
        }
    }
}


// ---------------------------------------------------------------- 写入路径（单游戏 profile）

/// 我们自己创建的 profile 名前缀 —— 用来区分「我们的」与 NVIDIA 预置的配置。
pub const PROFILE_PREFIX: &str = "FrameGen Manager - ";

pub fn game_profile_name(game: &str) -> String {
    format!("{}{}", PROFILE_PREFIX, game)
}

/// 一次写入的结果。注意 ok 只取决于**读回复核**，不取决于驱动返回码。
#[derive(Debug, Clone)]
pub struct SmWriteResult {
    pub ok: bool,
    pub readback: Option<u32>,
    pub rc_set: i32,
    pub message: String,
}

/// 读某个游戏（我们自己的 profile）里的 SM 值。None = 我们还没为它建过配置。
pub fn game_sm_value(game: &str) -> Result<Option<u32>, String> {
    let sess = nv::Session::open()?;
    let name = game_profile_name(game);
    match sess.find(&name)? {
        None => Ok(None),
        Some(prof) => {
            if sess.is_base_profile(prof) {
                return Err("拒绝：按名字找到的竟然是全局 profile".to_owned());
            }
            match sess.read(prof, SM_SETTING_ID) {
                Ok(v) => Ok(Some(v)),
                Err(e) if e.starts_with("rc=-160") => Ok(None),
                Err(e) => Err(e),
            }
        }
    }
}

/// 开启 / 关闭某个游戏的 Smooth Motion。
///
/// **只写我们自己的 profile（名字见 PROFILE_PREFIX），绝不碰全局/基础 profile**
/// （句柄若等于全局 profile 直接拒绝）。成功判据是**读回复核** —— 实测
/// DRS_SetSetting 对 SM 会返回 -160 但值其实已经写进去，所以返回码不可信。
pub fn set_game_sm(
    game: &str,
    exe: &std::path::Path,
    on: bool,
) -> Result<SmWriteResult, String> {
    let sess = nv::Session::open()?;
    let name = game_profile_name(game);
    let prof = match sess.find(&name)? {
        Some(p) => {
            if sess.is_base_profile(p) {
                return Err("拒绝：不允许写全局/基础 profile。".to_owned());
            }
            p
        }
        None => sess.create_profile(&name)?,
    };
    if let Err(e) = sess.create_application(prof, exe) {
        crate::log::line(&format!("[sm] CreateApplication 提示：{e}"));
    }
    // 开启 = 写 1；关闭 = 写显式 0（本游戏强制关闭）。
    // 极端情况下驱动不接受 0，则退化为删掉这一项（= 跟随全局）。
    let mut rc_set;
    let mut deleted = false;
    if on {
        rc_set = sess.set_dword(prof, SM_SETTING_ID, 1)?;
    } else {
        rc_set = sess.set_dword(prof, SM_SETTING_ID, 0)?;
        if sess.read(prof, SM_SETTING_ID).ok() != Some(0) {
            rc_set = sess.delete_setting(prof, SM_SETTING_ID)?;
            deleted = true;
        }
    }
    sess.save()?;
    let readback = sess.read(prof, SM_SETTING_ID).ok();
    let ok = if on { readback == Some(1) } else if deleted { rc_set == 0 } else { readback == Some(0) };
    Ok(SmWriteResult {
        ok,
        readback,
        rc_set,
        message: if ok {
            if on {
                format!("已开启（本游戏强制开启；已读回复核确认，驱动返回码 {rc_set}）")
            } else if deleted {
                format!("已取消本游戏的设置，改为跟随全局（删除返回 {rc_set}）")
            } else {
                format!("已关闭本游戏的 Smooth Motion（读回复核 = 0；驱动返回码 {rc_set}）")
            }
        } else if on {
            format!("写入后复核不符：期望 1，实际读到 {readback:?}")
        } else {
            format!("删除本游戏的设置失败（返回 {rc_set}）")
        },
    })
}

/// 删掉我们为某个游戏建的 profile（等于「驱动里从没为它配过」）。返回是否真的删了。
pub fn remove_game_sm(game: &str) -> Result<bool, String> {
    let sess = nv::Session::open()?;
    let name = game_profile_name(game);
    match sess.find(&name)? {
        None => Ok(false),
        Some(prof) => {
            if sess.is_base_profile(prof) {
                return Err("拒绝：不允许删除全局/基础 profile。".to_owned());
            }
            sess.delete_profile(prof)?;
            sess.save()?;
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------- 内置解锁组件的部署 / 还原

pub const SM_ASSET_DIR: &str = "bundled-sm";
pub const SM_ASSET_FILE: &str = "version.dll";

/// 内置解锁组件的 SHA256（固定值；用它就能在任意游戏目录里认出"这是 SM 放的"）。
pub const SM_ASSET_SHA256: &str =
    "4091efe2db3dc8dbb671a187b3904c36a58da18149b309021c5367d1646c21cb";

/// 这个目录里的 version.dll 是不是我们的解锁组件？
pub fn has_our_asset(dir: &std::path::Path) -> bool {
    let p = dir.join(SM_ASSET_FILE);
    p.is_file()
        && crate::util::sha256_file(&p)
            .map(|h| h.eq_ignore_ascii_case(SM_ASSET_SHA256))
            .unwrap_or(false)
}

/// 内置组件在磁盘上的位置（随包分发，位于 assets 目录下的 bundled-sm）。
pub fn asset_path() -> Result<std::path::PathBuf, String> {
    let d = crate::util::assets_dir().map_err(|e| format!("找不到内置资产目录：{e:#}"))?;
    Ok(d.join(SM_ASSET_DIR).join(SM_ASSET_FILE))
}

fn asset_record_path(game_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = crate::util::backups_dir().map_err(|e| format!("{e:#}"))?.join("sm-assets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录 {} 失败：{e}", dir.display()))?;
    let key: String = game_dir
        .display()
        .to_string()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    Ok(dir.join(format!("{}.json", key)))
}

/// 把内置解锁组件放进这个游戏目录（备份同名原文件，写入后逐字节复核）。
/// 返回给用户看的一句话说明。
pub fn asset_deploy(game_dir: &std::path::Path) -> Result<String, String> {
    let src = asset_path()?;
    if !src.is_file() {
        return Err(format!("内置组件不存在：{}", src.display()));
    }
    if !game_dir.is_dir() {
        return Err(format!("游戏目录不存在：{}", game_dir.display()));
    }
    if !crate::util::is_writable(game_dir) {
        return Err(format!("没有权限写入 {}", game_dir.display()));
    }
    let want = crate::util::sha256_file(&src).map_err(|e| format!("{e:#}"))?;
    let dst = game_dir.join(SM_ASSET_FILE);
    let mut had_original = false;
    let mut backup: Option<std::path::PathBuf> = None;
    if dst.is_file() {
        let rec = asset_record_path(game_dir)?;
        let bdir = rec.parent().unwrap_or(std::path::Path::new(".")).join("originals");
        std::fs::create_dir_all(&bdir).map_err(|e| format!("{e}"))?;
        let bp = bdir.join(format!("{}.bak", dst.file_name().unwrap_or_default().to_string_lossy()));
        std::fs::copy(&dst, &bp).map_err(|e| format!("备份原文件失败：{e}"))?;
        had_original = true;
        backup = Some(bp);
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("复制到 {} 失败：{e}", dst.display()))?;
    let got = crate::util::sha256_file(&dst).map_err(|e| format!("{e:#}"))?;
    if got != want {
        let _ = std::fs::remove_file(&dst);
        return Err("复制后校验不一致，已撤掉写入的文件".to_owned());
    }
    let rec = asset_record_path(game_dir)?;
    let body = format!(
        "{{\"dir\":\"{}\",\"hadOriginal\":{},\"backup\":{},\"sha\":\"{}\"}}",
        game_dir.display().to_string().replace(std::path::MAIN_SEPARATOR, "/"),
        had_original,
        match &backup { Some(p) => format!("\"{}\"", p.display().to_string().replace(std::path::MAIN_SEPARATOR, "/")), None => "null".to_owned() },
        got
    );
    std::fs::write(&rec, body).map_err(|e| format!("写部署记录失败：{e}"))?;
    crate::log::line(&format!("[sm] 已部署解锁组件到 {}", game_dir.display()));
    Ok(format!(
        "已放入解锁组件（{}，{:.1} MB）{}",
        SM_ASSET_FILE,
        std::fs::metadata(&src).map(|m| m.len() as f64 / 1048576.0).unwrap_or(0.0),
        if had_original { "，原文件已备份" } else { "" }
    ))
}

/// 取回内置解锁组件：有备份就还原原文件，没有就删掉我们放的那份。
pub fn asset_restore(game_dir: &std::path::Path) -> Result<String, String> {
    let rec = asset_record_path(game_dir)?;
    let dst = game_dir.join(SM_ASSET_FILE);
    if !rec.is_file() {
        // 没有记录：如果这个文件正好是我们的组件，就把它清掉；否则不动
        let mine = dst.is_file()
            && asset_path()
                .ok()
                .and_then(|p| crate::util::sha256_file(&p).ok())
                .zip(crate::util::sha256_file(&dst).ok())
                .map(|(a, b)| a == b)
                .unwrap_or(false);
        if mine {
            std::fs::remove_file(&dst).map_err(|e| format!("删除失败：{e}"))?;
            return Ok("已取回解锁组件（没有部署记录，按文件指纹确认后清理）".to_owned());
        }
        return Err("没有本工具的部署记录，未做任何改动".to_owned());
    }
    let text = std::fs::read_to_string(&rec).map_err(|e| format!("{e}"))?;
    let backup = {
        let k = "\"backup\":";
        match text.find(k) {
            Some(i) => {
                let rest = &text[i + k.len()..];
                let end = rest.find(',').unwrap_or(rest.len());
                let v = rest[..end].trim().trim_matches('"');
                if v == "null" || v.is_empty() { None } else { Some(std::path::PathBuf::from(v)) }
            }
            None => None,
        }
    };
    if let Some(bp) = backup {
        if bp.is_file() {
            std::fs::copy(&bp, &dst).map_err(|e| format!("还原原文件失败：{e}"))?;
            let _ = std::fs::remove_file(&bp);
            let _ = std::fs::remove_file(&rec);
            crate::log::line(&format!("[sm] 已还原 {} 的原文件", game_dir.display()));
            return Ok("已还原成原来的 version.dll".to_owned());
        }
    }
    if dst.is_file() {
        std::fs::remove_file(&dst).map_err(|e| format!("删除失败：{e}"))?;
    }
    let _ = std::fs::remove_file(&rec);
    Ok("已取回解锁组件（原本没有同名文件，直接删除）".to_owned())
}
