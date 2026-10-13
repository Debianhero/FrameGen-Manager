# Smooth Motion（30 系）—— 事实来源与产品策略

> 本文只记录**事实与出处**，以及我们自己的产品规定。第三方说法一律注明来源，避免把「社区修改」当成「官方支持」。

## 一、产品规定（本项目的决定，不是引述）

1. **驱动版本硬门槛：>= 616.64 才允许部署 Smooth Motion；低于 616.64 一律不允许。**（产品负责人 2026-10-11 决定）
2. 只允许**单卡 30 系 / SM86**；多 GPU 暂不支持。
3. **只写绑定到该游戏 EXE 的驱动 profile**，绝不写全局/基础 profile；写入前备份、写入后复核、可一键还原。
4. 界面上必须**如实标注**当前驱动构建是否被上游验证过；未被验证的构建，部署前二次确认。

## 二、事实与出处（逐条可核对）

| 事实 | 谁说的 | 出处 |
|---|---|---|
| 需要一个支持 Smooth Motion 的 NVIDIA 驱动（**未给版本号**） | pipotoufikxyz-lgtm（修改版作者） | 其发布包 `payload/rtx30/README.txt` |
| 30 系套件 DLL 是「the supplied version (34).dll, unchanged」，SHA256 `4091efe2db3dc8dbb671a187b3904c36a58da18149b309021c5367d1646c21cb`，1,053,696 字节；自称 `RTXMFG Smooth Motion Quality for RTX 3000/4000, version 0.30.3.2`；自标 Community modification; not an NVIDIA product | 同上（并声明该 DLL **非其所作**，仅打包） | 同上 |
| 兼容表：**616.64 = PROJECT_VALIDATED（黄金）**；591.86 的 NvPresent = STATICALLY_VALIDATED（实验）；**未知/未识别的 NvPresent → fail-closed 拒绝**；多 GPU 未实现设备选择 | **xikarioz/Smooth-Motion-RTX30**（另一项目，仓库仅文档与发布元数据） | 其 `COMPATIBILITY.md`；被 pipotoufikxyz 的审阅文档引用：`history/GP9-Fixes1/validation/comparison/UPSTREAM-REPORTS.md` 第 17-18 行（commit `892d5ec892fb2a4add84d642766b2cd02917402e`） |
| 设置项 `Smooth Motion - Enable` 的 HexSettingID = **0xB0D384C0**（0=Off，1=On）；`Enabled APIs` = 0xB0CC0875（bit0 DX12 / bit1 DX11 / bit2 Vulkan）；`Debug Log Level` = 0xB053C379（日志写 C:\NvPresent\）；**MinRequiredDriverVersion = 571.86** | **Orbmu2k/nvidiaProfileInspector**（Profile Inspector 项目） | 其 `nvidiaProfileInspector/CustomSettingNames.xml` |
| 616.64 / 617.14 的驱动兼容档案、41 处/61 字节二进制变换、`617.14 … PASS` | pipotoufikxyz-lgtm 自己的验证数据 | 其包内 `validation/*.json`、`DRIVER-PROFILE-2.8.md`、`driver-61714-gp9.json` |
| 原始项目参考（ItsAdeline/NVSmooth30 remains a public reference for the original project） | — | pipotoufikxyz 的 `UPSTREAM-REPORTS.md` 第 24 行 |
| 驱动版本号不再单独决定；SM 激活 fail-closed，直到安装的 `NvPresent` 二进制被识别并验证 | xikarioz/Smooth-Motion-RTX30 | 其 `COMPATIBILITY.md`「Current policy (v0.5.0-rc.1 and later)」 |

## 三、已识别构建对照表（界面判别用，随上游更新补充）

| 驱动 | 文件 | 字节数 | 备注 |
|---|---|---|---|
| 616.64 | NvPresent64.dll | 8,417,512 | 上游报告的黄金构建（`DRIVER-PROFILE-2.8.md`，hash `f36a5f10458a9b67833df97ea2a4634d8c03b634d8edcbfbd9e49bc47ad8b54e`）**待我方实机核对后启用** |
| 617.14 | NvPresent64.dll | 待补 | pipotoufikxyz 报告 617.14 exact identity … PASS |
| 591.86 | NvPresent64.dll | 待补 | 上游标为 STATICALLY_VALIDATED（实验）；**按本产品规定 <616.64 不允许部署** |

## 四、明确不做的事

- 不自己逆向/修改驱动二进制；不使用与社区包不同的解锁实现。
- 不自动改动用户的显卡驱动；不写全局 profile。
- 不把第三方社区修改描述成「NVIDIA 官方支持」。

## 五、本机现状（2026-10-11 实测）

- 显卡 RTX 3070（30 系 / SM86）；驱动 **617.42**（>= 616.64，按产品规定**允许部署**）。
- `NvPresent64.dll` 位于 `C:\Windows\System32\DriverStore\FileRepository\nv_dispi.inf_amd64_*\NvPresent64.dll`，8.13 MB（与上游 616.64 的 8,417,512 字节**不一致** → 属"未被识别"的构建）。
- 驱动基础 profile 里 `Smooth Motion - Enable` 读取结果为 **未设置（NVAPI rc=-160）**；本工具**不做任何修改**（只读）。
