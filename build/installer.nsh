; Installer tweaks, included by electron-builder (nsis.include defaults to build/installer.nsh).

!include "app-files.nsh"

!define MUI_DIRECTORYPAGE_TEXT_TOP "Choose where to install Hojicha Launcher. It gets its own $\"${APP_FILENAME}$\" folder inside the folder you pick.$\r$\n$\r$\nYour instances, accounts and settings are stored separately, so moving the launcher doesn't touch them."

; Runs when the install starts, after the folder page. Whatever folder was picked, install into a
; "Hojicha Launcher" folder inside it, so the launcher never mixes its files with someone else's.
; An install in the folder name used by 0.1.x ("hojicha-launcher") moves next door to
; "Hojicha Launcher"; the old uninstaller then removes the old folder.
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

      StrLen $0 "\${APP_PACKAGE_NAME}"
      StrCpy $1 "$INSTDIR" "" -$0
      StrLen $2 "\${APP_FILENAME}"
      StrCpy $3 "$INSTDIR" "" -$2
      ${If} $1 == "\${APP_PACKAGE_NAME}"
        StrCpy $INSTDIR "$INSTDIR" -$0
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${ElseIf} $3 != "\${APP_FILENAME}"
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
      Call instFilesPre ; a no-op now, but NSIS fails the build on functions that are never called
    ${EndIf}
  FunctionEnd
!macroend

; Uninstall: delete only the files the installer put there, then the folder if it's empty.
; (electron-builder's default deletes the whole install folder, whatever else is in it.)
!macro customRemoveFiles
  SetOutPath $TEMP
  !insertmacro hojichaRemoveAppFiles
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\uninstallerIcon.ico"
  RMDir "$INSTDIR"
!macroend
