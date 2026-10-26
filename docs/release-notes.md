**本次更新前强烈建议先把已部署DLSS5的游戏还原/卸载Reshade！！！从该版本起DLSS5插件更换为 GITC Uplift 1.6.2：原生支持 DX9/10/11/12、Vulkan、OpenGL，32 位/64 位游戏；不自带DLSS的游戏也能部署**

【更新】
1.DLSS5的插件更换为GITC版（https://github.com/ghostinthecamera/GITC-Uplift） 这一版本起对原生不支持DLSS的游戏也可以部署DLSS5。该插件原生支持DX9/10/11/12、Vulkan、OpenGL，32 位/64 位游戏。
2.内置 ReShade 效果包（无需联网下载）：标准效果 + SweetFX + iMMERSE 免费套件（MXAO/SMAA/Sharpen/FilmGrain/Solaris/Launchpad）+ lilium HDR 三件（含 lilium__rcas_hdr.fx），共 108 个文件

【改进】
1.部署/还原/卸载提示简化：成功只显示【已完成】/【已还原】/【已卸载】，完整明细在“复制”按钮里

【优化】
1.清理屎山代码
2.优化了一些已知的问题

【升级提醒】
1.已部署旧版 DLSS5（RenoDX）的用户：启动会提示「DLSS5 已更换至 GITC 版」，且部署按钮锁定——请先点【卸载 ReShade / DLSS5】，再重新部署；旧部署在卸载前仍可正常使用
2.「彻底卸载」会删除整个 reshade-shaders 目录：用户自备的 fx/预设请先备份
3.用户如有自备的fx预设应该放在**<游戏目录>\reshade-shaders\Shaders\<自建子目录>\**

**Before this update, it is strongly recommended to restore/uninstall Reshade for games with DLSS5 installed!! From this version onward, the DLSS5 plugin will be replaced with GITC Uplift 1.6.2: Native support for DX9/10/11/12, Vulkan, OpenGL, 32-bit/64-bit games; Games without built-in DLSS can also be deployed** 

[Update]
1. DLSS5 plugin replaced with the GITC version (https://github.com/ghostinthecamera/GITC-Uplift) From this version onward, games that do not natively support DLSS can also deploy DLSS5. This plugin natively supports DX9/10/11/12, Vulkan, OpenGL, and 32-bit/64-bit games. 
2. Built-in ReShade Effects Pack (no online download required): Standard Effects + SweetFX + iMMERSE free kit (MXAO/SMAA/Sharpen/FilmGrain/Solaris/Launchpad) + lilium HDR (including lilium__rcas_hdr.fx), totaling 108 files

[Improvements]
1. Simplified deployment/restore/uninstall prompts: Success only shows [Completed]/[Restored]/[Uninstalled], with full details in the "Copy" button

[Optimization]
1. Clean up the Shishan code
2. Optimized some known issues

[Upgrade Reminder]
1. Users who have deployed the old version of DLSS5 (RenoDX): The startup will prompt "DLSS5 has been replaced to GITC version" and the deployment button is locked—please click [Uninstall ReShade / DLSS5] before redeploying; The old deployment can still work normally before uninstalling
2. "Thorough Uninstallation" will delete the entire reshaders directory: Please back up your user-provided fx/presets first
3. If users have their own FX presets, they should be placed in **<游戏目录>reshade-shadersShaders<自建子目录>**
