; Installer tweaks, included by electron-builder (nsis.include defaults to build/installer.nsh).
;
; Layout of an install (the "launcher folder" is the one picked on the folder page):
;   Hojicha Launcher\                launcher folder
;     app\                           Electron and the launcher itself  <- electron-builder's $INSTDIR
;     instances\ synced\ meta\ config\   data, created by the launcher (src/core/storage.js)
;     uninstall.exe                  copy of app\uninstall.exe
;     Hojicha Launcher.lnk           shortcut to app\Hojicha Launcher.exe
; Updating replaces app\ only. Uninstalling deletes the whole launcher folder, after asking.

!include "app-files.nsh"

!macro customHeader
  ; Plain "uninstall.exe" (default: "Uninstall Hojicha Launcher.exe").
  !undef UNINSTALL_FILENAME
  !define UNINSTALL_FILENAME "uninstall.exe"

  ; The real default folder is set at runtime; this only gives Browse its auto-append, so picking
  ; T:\ fills in T:\Hojicha Launcher.
  InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"
!macroend

!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose where to install Hojicha Launcher. It gets its own $\"${APP_FILENAME}$\" folder inside the folder you pick, which also holds your instances and settings.$\r$\n$\r$\nUninstalling deletes that whole folder, instances included."

; A previous install remembers its app\ folder; show the launcher folder on the folder page instead.
!macro customInit
  ${IfNot} ${Silent}
    StrCpy $0 "$INSTDIR" "" -4
    ${If} $0 == "\app"
      StrCpy $INSTDIR "$INSTDIR" -4
    ${EndIf}
  ${EndIf}
!macroend

; Runs when the install starts, after the folder page. Whatever folder was picked, install into a
; "Hojicha Launcher" folder inside it (so the launcher never mixes with someone else's files), with the
; app itself in its app\ sub-folder.
; This replaces electron-builder's own check (instFilesPre), which skips the sub-folder whenever
; the path merely contains the app name, e.g. "T:\Hojicha launcher code".
!macro customPageAfterChangeDir
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE hojichaOwnFolder

  Function hojichaOwnFolder
    ${IfNot} ${isUpdated}
      StrCpy $0 "$INSTDIR" "" -1
      ${If} $0 == "\"
        StrCpy $INSTDIR "$INSTDIR" -1
      ${EndIf}
      StrCpy $0 "$INSTDIR" "" -4
      ${If} $0 == "\app"
        StrCpy $INSTDIR "$INSTDIR" -4
      ${EndIf}

      StrLen $0 "\${APP_FILENAME}"
      StrCpy $1 "$INSTDIR" "" -$0
      ${If} $1 != "\${APP_FILENAME}"
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
      Call instFilesPre ; a no-op now, but NSIS fails the build on functions that are never called
      StrCpy $INSTDIR "$INSTDIR\app"
    ${EndIf}
  FunctionEnd
!macroend

; Sets $R8 to the launcher folder and $R9 to "1" when $INSTDIR is <...>\Hojicha Launcher\app, our layout.
; Anything else (say a silent install with /D=) is treated with care: only the app's own files are touched.
!macro hojichaLayout
  StrCpy $R9 "0"
  StrCpy $R8 "$INSTDIR" -4
  StrCpy $0 "$INSTDIR" "" -4
  StrLen $1 "\${APP_FILENAME}"
  StrCpy $2 "$R8" "" -$1
  ${If} $0 == "\app"
  ${AndIf} $2 == "\${APP_FILENAME}"
    StrCpy $R9 "1"
  ${EndIf}
!macroend

; After installing: put the uninstaller and a shortcut in the launcher folder, next to the data folders.
!macro customInstall
  !insertmacro hojichaLayout
  ${If} $R9 == "1"
    CopyFiles /SILENT "$INSTDIR\${UNINSTALL_FILENAME}" "$R8\${UNINSTALL_FILENAME}"
    CreateShortCut "$R8\${PRODUCT_FILENAME}.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$R8\${PRODUCT_FILENAME}.lnk" "${APP_ID}"
  ${EndIf}
!macroend

!macro customUnInit
  ; Started from the launcher folder's uninstall.exe without a registry entry to go on.
  ${If} ${FileExists} "$INSTDIR\app\${APP_EXECUTABLE_FILENAME}"
    StrCpy $INSTDIR "$INSTDIR\app"
  ${EndIf}
  ; Uninstalling deletes worlds too, so make sure that's meant (not asked when updating or silent).
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    !insertmacro hojichaLayout
    ${If} $R9 == "1"
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "This removes Hojicha Launcher and deletes the folder$\r$\n$R8$\r$\nincluding your instances, worlds, screenshots and settings.$\r$\n$\r$\nCopy any worlds you want to keep somewhere else first. Uninstall now?" IDYES +2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  !insertmacro hojichaLayout
  ${If} $R9 == "1"
    ${If} ${isUpdated}
      RMDir /r "$INSTDIR" ; updating: replace the app, keep the instances
    ${Else}
      RMDir /r "$R8"      ; uninstalling: the whole launcher folder
    ${EndIf}
  ${Else}
    ; Not our layout: delete only the files the installer put there, then the folder if it's empty.
    !insertmacro hojichaRemoveAppFiles
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    Delete "$INSTDIR\uninstallerIcon.ico"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
