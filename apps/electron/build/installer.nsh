; ============================================================================
; FrameGen Manager - electron-builder NSIS hooks
;
; Two jobs, both about upgrading from the OLD (Inno Setup) builds:
;
;   1. customInit: the old app's self-update runs the installer with Inno Setup
;      flags (/SILENT /NORESTART /SUPPRESSMSGBOXES /DIR=<dir>). NSIS knows /S and
;      /D= only, so translate them - otherwise the upgrade pops the full wizard
;      and installs into the default directory (the user's settings, game library
;      and downloaded assets live in the old directory and would look lost).
;
;   2. customInstall: relaunch the app after a SILENT install. electron-builder
;      only auto-runs the app from the finish page, which silent installs skip.
;
; ASCII only on purpose: NSIS reads scripts with the current code page.
; ============================================================================

; StrFunc/FileFunc are only needed by the installer pass. Declaring them for the
; uninstaller pass too makes makensis warn (6010: install function not referenced)
; and electron-builder treats warnings as errors.
!ifndef BUILD_UNINSTALLER
  !include "FileFunc.nsh"
  !include "StrFunc.nsh"
  ${StrLoc}
!endif

; ---- Page colours: keep the system default (light page, black text) ----
;
; We used to force a dark page here (MUI_BGCOLOR 130E0B + MUI_TEXTCOLOR F5EDE6),
; but the text-colour define does not reach every MUI control in the
; electron-builder template: the page turned dark while the body text stayed
; black, i.e. unreadable ("black text on black background", reported from a
; real install). The branding lives in the sidebar/header bitmaps anyway, so
; just leave both defines alone and let NSIS use its defaults.

; AppId of the old Inno Setup installer (packaging/installer.iss).
!define FGM_OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\{7C4B1E2A-9D53-4A6E-8F1C-5B2D9E4A77C1}_is1"

!macro customInit
  ; ---- 1) translate the old Inno-style command line ----
  ${GetParameters} $R9
  ${StrLoc} $R0 $R9 "/SILENT" ">"
  ${If} $R0 != ""
    SetSilent silent
  ${EndIf}
  ${StrLoc} $R0 $R9 "/DIR=" ">"
  ${If} $R0 != ""
    IntOp $R0 $R0 + 5
    StrCpy $R1 $R9 "" $R0
    StrCpy $R2 $R1 1
    ${If} $R2 == '"'
      StrCpy $R1 $R1 "" 1
    ${EndIf}
    ; stop at the closing quote, or at the first space when unquoted
    ${StrLoc} $R3 $R1 '"' ">"
    ${If} $R3 == ""
      ${StrLoc} $R3 $R1 " " ">"
    ${EndIf}
    ${If} $R3 != ""
      StrCpy $R1 $R1 $R3
    ${EndIf}
    ${If} $R1 != ""
      StrCpy $INSTDIR $R1
      ; ---- 光设 $INSTDIR 不够（实测踩到）----
      ; electron-builder 的多用户宏是在 customInit **之后**才跑的：它用注册表里的
      ; InstallLocation 覆盖 $INSTDIR（multiUser.nsh），最后才让 NSIS 自己的 /D= 覆盖。
      ; 于是旧版传 /DIR=D:\某处，新包装完仍落在 C:\Program Files（实测 exit 0、
      ; 文件确实没进指定目录）—— NSIS 只认自己的 /D=，不认 Inno 的 /DIR=。
      ; 所以把翻译出来的目录**写进那个宏真正会读的键**（Software\<APP_GUID>）；
      ; 两个 hive 都写：提权安装读 HKLM，按用户安装读 HKCU，哪个成功都行。
      !ifdef APP_GUID
        ClearErrors
        WriteRegStr HKCU "Software\${APP_GUID}" "InstallLocation" "$R1"
        ClearErrors
        WriteRegStr HKLM "Software\${APP_GUID}" "InstallLocation" "$R1"
        ClearErrors
      !endif
    ${EndIf}
  ${EndIf}

  ; ---- 2) remove the old Inno Setup installation's program files ----
  ; We do NOT run its uninstaller: the MsgBox in its [Code] section is not
  ; suppressed by /SUPPRESSMSGBOXES and would hang a silent update (seen in
  ; the Tauri build). User data (framegen-manager.json, game_library.json,
  ; assets, backups, logs) is never touched.
  ReadRegStr $R5 HKCU "${FGM_OLD_UNINSTKEY}" "UninstallString"
  ${If} $R5 != ""
    nsExec::Exec 'taskkill /F /IM framegen-manager.exe'
    Pop $R6
    Delete "$INSTDIR\framegen-manager.exe"
    Delete "$INSTDIR\unins000.exe"
    Delete "$INSTDIR\unins000.dat"
    DeleteRegKey HKCU "${FGM_OLD_UNINSTKEY}"
  ${EndIf}

  ; ---- 3) installed copy: move data out before the old uninstaller wipes INSTDIR ----
  IfFileExists "$INSTDIR\installed.txt" 0 fgm_no_data_move
    !insertmacro FGM_MOVE_DATA_OUT
  fgm_no_data_move:
!macroend

!macro customInstall
  ; Mark this copy as INSTALLED. The main process keys on this file to put user data
  ; in %APPDATA%\FrameGen-Manager instead of next to the exe: electron-builder's
  ; uninstaller ends with "RMDir /r $INSTDIR" and the install flow runs the
  ; previous version's uninstaller first, so data kept in the install directory is
  ; wiped on every update (measured: config + game library + 95 MB of assets gone
  ; on the second install). Portable copies have no marker and keep the old layout.
  ClearErrors
  FileOpen $9 "$INSTDIR\installed.txt" w
  IfErrors +3
    FileWrite $9 "installed"
    FileClose $9

  ; 关键代理 version.dll 是部署的唯一入口。杀毒软件把它拦掉时，安装器照样「成功」，
  ; 用户进界面只看到「资产目录里还没有 version.dll」，然后反复卸载重装。
  ; 帧生成代理和 Smooth Motion 组件**都叫 version.dll**，两份都要查。
  ; 装完就当面提醒（静默更新不弹，否则会卡住自动更新）。
  StrCpy $R7 0
  IfFileExists "$INSTDIR\bundled-assets\version.dll" fgm_fg_proxy_ok
    StrCpy $R7 1
  fgm_fg_proxy_ok:
  IfFileExists "$INSTDIR\bundled-sm\rtx30\version.dll" fgm_sm_proxy_ok
    StrCpy $R7 1
  fgm_sm_proxy_ok:
  ${If} $R7 == 1
    ${If} ${Silent}
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "内置的 version.dll 组件没有全部安装成功（多半被杀毒软件拦截了）。$\r$\n$\r$\n请把安装目录和 $APPDATA\FrameGen-Manager 加入杀毒软件白名单，再重新运行安装包；否则部署时会提示「资产目录里还没有 version.dll」/「内置组件不存在」。"
    ${EndIf}
  ${EndIf}

  ; 安装目录里**不再放**「使用说明.txt」（用户要求删除）—— 安装包本身已经不带了，
  ; 新装用户不会有这个文件。
  ; 升级用户那份旧文件由应用自己清（main.js 的 dropLegacyDocs，便携版能删掉；
  ; 装在 Program Files 时应用没有写权限，删不掉就留着，不影响任何功能）。
  ; 这里**故意不做**：试过 nsExec + cmd 通配（单引号/双引号、for 循环、???? 通配都试了），
  ; 命令手工执行能删、在安装器里始终没生效，与其留一条假装在干活的语句，不如不写。

  ; 清掉第 1) 步为"翻译 /DIR="写进去的 InstallLocation。
  ; 它的用途只是让 electron-builder 的多用户宏**这一次**认我们指定的目录；留在注册表里
  ; 会有副作用：以后每次安装（包括程序内自动更新拉起的安装包）都会沿用那个位置 ——
  ; 实测把安装位置永久钉在了 C:\Program Files，普通用户没权限就装不上 / 更新失败。
  !ifdef APP_GUID
    ClearErrors
    DeleteRegValue HKCU "Software\${APP_GUID}" "InstallLocation"
    ClearErrors
    DeleteRegValue HKLM "Software\${APP_GUID}" "InstallLocation"
    ClearErrors
  !endif

  ${If} ${Silent}
    ; silent update: bring the new version up (otherwise the user ends up
    ; with no window at all after the update)
    ; **必须用 ExecShell，不能用 Exec**：NSIS 的 Exec 会等子进程退出才返回，而这里拉起的是
    ; 常驻程序 —— 结果是静默安装/更新时安装器永远不退出（用户看到"卡住没动静"，
    ; 我们脚本里的输出管道也会跟着挂住）。ExecShell 是即发即忘。
    ExecShell "open" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  ${EndIf}
!macroend

; Move user data out of the install directory and into %APPDATA%\FrameGen-Manager.
;
; MUST run in customInit (.onInit): right after this, electron-builder's install
; flow runs the PREVIOUS version's uninstaller, whose last statement is
; 'RMDir /r $INSTDIR'. Anything still sitting in the install directory at that
; moment is destroyed (measured: config + game library + 95 MB of assets gone
; when installing the same package twice).
;
; Only for INSTALLED copies (installed.txt marker); portable copies keep their
; data next to the exe and never run this path.
!macro FGM_MOVE_DATA_OUT
  StrCpy $R8 "$APPDATA\FrameGen-Manager"
  ; already migrated once? then AppData is authoritative
  IfFileExists "$R8\framegen-manager.json" fgm_move_done
  CreateDirectory "$R8"
  IfFileExists "$INSTDIR\framegen-manager.json" 0 +2
    CopyFiles /SILENT "$INSTDIR\framegen-manager.json" "$R8"
  IfFileExists "$INSTDIR\game_library.json" 0 +2
    CopyFiles /SILENT "$INSTDIR\game_library.json" "$R8"
  IfFileExists "$INSTDIR\tips.md" 0 +2
    CopyFiles /SILENT "$INSTDIR\tips.md" "$R8"
  IfFileExists "$INSTDIR\assets\*.*" 0 +3
    nsExec::Exec 'xcopy /E /I /Y /Q "$INSTDIR\assets" "$R8\assets\"'
    Pop $0
  IfFileExists "$INSTDIR\backups\*.*" 0 +3
    nsExec::Exec 'xcopy /E /I /Y /Q "$INSTDIR\backups" "$R8\backups\"'
    Pop $0
  IfFileExists "$INSTDIR\logs\*.*" 0 +3
    nsExec::Exec 'xcopy /E /I /Y /Q "$INSTDIR\logs" "$R8\logs\"'
    Pop $0
  fgm_move_done:
!macroend

; ---------------------------------------------------------------- 卸载
; 显卡名称伪装必须在**卸载开始前**提示：customUnInstall 已经在删文件了，那时再弹
; 用户就没法取消。customUnInit 在 un.onInit 里跑，可以 Quit 退出卸载。
!macro customUnInit
  ; IfFileExists 第三参数才是「不存在时跳哪」—— 两个分支都写清楚，
  ; 免得没伪装过的用户也被弹一次（第一版就写反了：文件不存在反而走进提示）。
  IfFileExists "$APPDATA\FrameGen-Manager\backups\gpu-name\manifest.json" fgm_un_gpu_warn fgm_un_gpu_ok
  fgm_un_gpu_warn:
    ${If} ${Silent}
    ${Else}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "检测到本工具修改过显卡名称（备份在 $APPDATA\FrameGen-Manager\backups\gpu-name）。$\r$\n$\r$\n卸载会删除这份备份，注册表里的显卡名称不会被自动恢复。$\r$\n如果还需要恢复，请点【取消】退出卸载，打开程序 →「设置 → 显卡名称伪装」→「还原为原来的名称」，然后再卸载。$\r$\n（已经还原过可以点【确定】继续。）" IDOK fgm_un_gpu_go
      Quit
      fgm_un_gpu_go:
    ${EndIf}
  fgm_un_gpu_ok:
!macroend

; 用户主动卸载时把数据一起清干净（%APPDATA%\FrameGen-Manager：设置、游戏库、资产、备份、日志）。
; 关键：**静默卸载要保留数据** —— 装新版时会先跑旧版的卸载器（静默），那一步清了数据，
; 就等于每次更新都把用户的设置和资产清空（我们踩过这个坑，见 installSection.nsh 的注释）。
; electron-builder 自己的卸载器负责装目录、开始菜单项和它自己的注册表键；这里只补数据目录。
!macro customUnInstall
  ; 先把还开着的程序 / 后台进程结束掉。不结束的话，安装目录里的 exe / dll 被占用，
  ; electron-builder 收尾的 RMDir /r $INSTDIR 会删不干净（留下整个安装目录）。
  ; 四个名字都覆盖：当前主程序 / 当前后台 / 老版后台名 / 老版主程序名。
  nsExec::Exec 'taskkill /F /T /IM "FrameGen Manager.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "FrameGen Manager Sidecar.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "framegen-sidecar.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "framegen-manager.exe"'
  Pop $0

  ; 自更新暂存目录：里面可能是上次下载的安装包（最大几百 MB），静默卸载也一并清掉
  RMDir /r "$TEMP\fgm-selfupdate"

  IfSilent fgm_uninst_keep
    ; 用户数据（游戏库 / 备份 / 内置资产 ~213MB）：只在**手动卸载**时删除。
    ; 自动更新走静默卸载，这里必须保留，否则每次升级用户的库和备份都会被清空。

    ; 本工具的数据目录
    RMDir /r "$APPDATA\FrameGen-Manager"
    RMDir /r "$LOCALAPPDATA\FrameGen-Manager"
    ; Electron 的 userData（语言 / localStorage / 缓存）。以前漏了，卸载后会留下 %APPDATA%\FrameGen Manager
    RMDir /r "$APPDATA\FrameGen Manager"
    RMDir /r "$LOCALAPPDATA\FrameGen Manager"
    ; 老版本（Tauri / WebView2）留下的数据目录
    RMDir /r "$LOCALAPPDATA\com.framegen.manager"
    ; 老版 electron-updater 的下载缓存（里面可能躺着一个 300+ MB 的安装包）
    RMDir /r "$LOCALAPPDATA\framegen-manager-updater"
    ; 帧生成运行时第一次进游戏时解出来的 bundle 缓存（删掉后游戏会重新解）
    RMDir /r "$LOCALAPPDATA\DlssgSm86"
    ; 更老一代（程序还叫 DLSSG-Manager / egui 版）的数据目录
    RMDir /r "$APPDATA\DLSSG-Manager"

    ; 注册表：安装器翻译 /DIR= 时写过的 InstallLocation（正常安装完会删，
    ; 但安装中途失败过、或更老的版本可能残留）
    !ifdef APP_GUID
      DeleteRegKey HKCU "Software\${APP_GUID}"
      DeleteRegKey HKLM "Software\${APP_GUID}"
      DeleteRegKey HKLM "Software\WOW6432Node\${APP_GUID}"
    !endif
    ; 老 Inno Setup 版的卸载键（HKCU / HKLM / WOW6432Node 都清）
    DeleteRegKey HKCU "${FGM_OLD_UNINSTKEY}"
    DeleteRegKey HKLM "${FGM_OLD_UNINSTKEY}"
    DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{7C4B1E2A-9D53-4A6E-8F1C-5B2D9E4A77C1}_is1"

    ; 卸载器自己还把 $INSTDIR 当工作目录，electron-builder 收尾的
    ; RMDir /r $INSTDIR 删不掉这个目录（实测会剩一个空文件夹）。
    ; 先把工作目录挪走，再删一次；还被占用就交给系统重启时删除（NSIS 标准做法）。
    ; **只在手动卸载时做**：静默卸载是升级，新版本马上要写同一个目录。
    SetOutPath "$TEMP"
    RMDir /REBOOTOK "$INSTDIR"

  fgm_uninst_keep:
!macroend
