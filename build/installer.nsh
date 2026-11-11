; LiteBrowser 安装向导自定义页面与文件关联处理。
; 协议页由 electron-builder 的 nsis.license 生成；这里增加默认勾选的文件关联选项。

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; 让安装/卸载页显示进度条和详细信息，而不是一个没有反馈的黑盒。
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

!macro customInit
  StrCpy $HtmlAssocState "1"
  SetDetailsPrint both
!macroend

!macro customUnInit
  SetDetailsPrint both
!macroend

!macro customUnInstall
  SetDetailsPrint both
  DetailPrint "准备删除以下文件："
  nsExec::ExecToLog 'cmd /c dir /s /b "$INSTDIR"'
  Pop $0

  IfSilent LiteBrowserKeepData
  ${If} ${isUpdated}
    Goto LiteBrowserKeepData
  ${EndIf}

  IfFileExists "$APPDATA\LiteBrowser\data\litebrowser-store.json" LiteBrowserAskData
  IfFileExists "$APPDATA\LiteBrowser\browser-data\*.*" LiteBrowserAskData
  IfFileExists "$LOCALAPPDATA\LiteBrowser\*.*" LiteBrowserAskData
  Goto LiteBrowserKeepData

  LiteBrowserAskData:
    MessageBox MB_YESNO|MB_ICONQUESTION "是否保留个人数据（书签、历史记录）？$\r$\n$\r$\n选择“是”：保留书签、历史记录、Cookie 和缓存。$\r$\n选择“否”：清理 AppData 中的个人数据。" IDYES LiteBrowserKeepData IDNO LiteBrowserRemoveData

  LiteBrowserRemoveData:
    DetailPrint "正在清理 LiteBrowser 个人数据..."
    RMDir /r "$APPDATA\LiteBrowser"
    RMDir /r "$LOCALAPPDATA\LiteBrowser"
    Goto LiteBrowserKeepData

  LiteBrowserKeepData:
!macroend

!ifdef BUILD_UNINSTALLER
Function un.LiteBrowserUninstallPageShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 != 0
    GetDlgItem $1 $0 1016
    System::Call 'user32::IsWindowVisible(p r1) i .r2'
    ${If} $1 != 0
      ${If} $2 == 0
        GetDlgItem $1 $0 1027
        SendMessage $1 ${BM_CLICK} 0 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER

Var HtmlAssocCheckbox
Var HtmlAssocState
Var PrevHtmlClass
Var PrevHtmClass

!macro customPageAfterChangeDir
  Page custom HtmlAssocPageCreate HtmlAssocPageLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW LiteBrowserInstallPageShow
!macroend

Function LiteBrowserInstallPageShow
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 != 0
    GetDlgItem $1 $0 1016
    System::Call 'user32::IsWindowVisible(p r1) i .r2'
    ${If} $1 != 0
      ${If} $2 == 0
        GetDlgItem $1 $0 1027
        SendMessage $1 ${BM_CLICK} 0 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function HtmlAssocPageCreate
  ReadRegStr $PrevHtmlClass SHELL_CONTEXT "Software\Classes\.html" ""
  ReadRegStr $PrevHtmClass SHELL_CONTEXT "Software\Classes\.htm" ""

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 30u "安装完成后，双击 .html / .htm 文件可以直接使用 LiteBrowser 打开。取消勾选则保留系统原有的文件关联。"
  Pop $0

  ${NSD_CreateCheckbox} 0 38u 100% 14u "将 .html / .htm 文件关联到 LiteBrowser（推荐）"
  Pop $HtmlAssocCheckbox
  ${NSD_Check} $HtmlAssocCheckbox
  StrCpy $HtmlAssocState "1"

  nsDialogs::Show
FunctionEnd

Function HtmlAssocPageLeave
  ${NSD_GetState} $HtmlAssocCheckbox $HtmlAssocState
FunctionEnd

!macro customInstall
  ; 文件关联已由 electron-builder 的 fileAssociations 自动注册；
  ; 如果用户取消勾选，则撤销这次注册并恢复安装前的 .html/.htm 默认处理程序。
  ${If} $HtmlAssocState == "0"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "LiteBrowserHTML"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "LiteBrowserHTML"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\LiteBrowserHTML"

    ${If} $PrevHtmlClass != ""
      WriteRegStr SHELL_CONTEXT "Software\Classes\.html" "" "$PrevHtmlClass"
    ${Else}
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.html" ""
    ${EndIf}

    ${If} $PrevHtmClass != ""
      WriteRegStr SHELL_CONTEXT "Software\Classes\.htm" "" "$PrevHtmClass"
    ${Else}
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm" ""
    ${EndIf}
  ${EndIf}

  DetailPrint "已安装以下文件："
  nsExec::ExecToLog 'cmd /c dir /s /b "$INSTDIR"'
  Pop $0
!macroend

!endif

