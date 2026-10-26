FrameGen Manager —— Smooth Motion 内置组件说明（20/30 系）

本目录按显卡系列分两套解锁组件，部署时按用户显卡自动选择：

rtx30\version.dll —— RTX 30 系（SmoothMotion-next，上游 sm8792 起）
  · 在 30 系（SM86）显卡上解锁 NVIDIA 驱动自带的 Smooth Motion（平滑运动）。
  · 组件自称：RTXMFG-SmoothMotion-next（无版本资源、无签名）。
    与旧版 version (34).dll 相比：默认帧率上限由 60 改为不限制（仅 3 字节差异）。
  · SHA256  0a9684288be14cdfa44a042c6e2f4c490f0114dca1729aef925be95490b74a50
  · 大小    1064448 字节
  · **依赖 VC++ 2015-2022 运行时（msvcp140.dll 14.40+）**：游戏目录里的 msvcp140.dll
    太旧或系统缺运行库时游戏会启动即崩 —— 本工具部署前会检查并拒绝。
  · 首次运行会为每个游戏创建 NVIDIA 驱动配置，可能自动重启游戏一次（上游行为）。
  · 旧版（0.30.3.2 / version (34).dll）的安装会被原地覆盖升级；本工具两版指纹都认。
  · 上一版 SHA256（历史）：4091efe2db3dc8dbb671a187b3904c36a58da18149b309021c5367d1646c21cb（1053696 字节）

rtx20\ —— RTX 20 系（实验性）
  · version.dll        Ultimate-ASI-Loader 9.7.4（通用 ASI 加载器）
    SHA256  7b6fd97e626c2d55ad0597a68e4f6fb84a76eeee3ee42405b032acbb588dce0f
    大小    1441280 字节
  · normal.asi         RTX 20 运行库本体（QUA2 v14 管线，上游 Fix37）
    SHA256  e6fe728f7a97caea87d594aa4bf18b239c1aadb9b245ee92f0390ecaba915016
    大小    1434624 字节
  · runtime-manifest.json  运行库清单（版本号与哈希，上游自带的升级协议）
    SHA256  92e16f20b372d2897fa7d64c85aef572cdf4b6038db70e1a9c19b13d42be630d
  · 注意：上游清单标注 GPU_tested=false / Windows_executed=false —— 未经上游实机验证，
    本工具按「实验性」对待，部署前会让用户确认。

来源与归属：
  · 打包来源：https://github.com/pipotoufikxyz-lgtm/dlssg_for_sm86-MFG-version
    （社区修改版；该仓库自身声明其中的 DLL 并非其所作，仅做打包）
  · 上游参考实现：https://github.com/ItsAdeline/NVSmooth30
  · 驱动兼容性资料：https://github.com/xikarioz/Smooth-Motion-RTX30
  · 相关设置项名称数据库：https://github.com/Orbmu2k/nvidiaProfileInspector

声明：
  · 这是社区修改版组件，不是 NVIDIA 官方产品，也不受 NVIDIA 支持；
  · 本工具只做"放进游戏目录 / 取出还原"这两件事，不修改这些文件本身；
  · 所有文件未作任何二进制改动，随包原样分发。