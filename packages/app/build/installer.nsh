; Blueline's NSIS include (electron-builder `nsis.include`; SPEC 6.1 Becoming the default app, 9.10).
;
; Windows lets an app appear in Default Apps settings, and be chosen there for .html and .htm, only when it is
; registered: a ProgID with its open command, the ProgID in each extension's OpenWithProgids, a Capabilities
; key whose FileAssociations list .html and .htm, and a value in RegisteredApplications that points to that
; key. electron-builder writes none of the last two, so this include writes all four, and the Default Apps
; link the app opens (`ms-settings:defaultapps?registeredAppUser=Blueline`, or `registeredAppMachine=` for a
; per-machine install; packages/app/src/main/native-helper.ts) finds them. An app cannot set the default
; itself: the user chooses in Settings (6.1).
;
; Every key goes into SHELL_CONTEXT, the hive of the install mode electron-builder chose (multiUser.nsh:
; SetShellVarContext current for a per-user install, so HKCU; all for a per-machine install, so HKLM), and
; the uninstaller removes exactly what was written, from the same hive. An update runs the old uninstaller
; with --updated before the new installer: the registration is kept then, because deleting the ProgID would
; make Windows reset the user's choice of Blueline for .html.
;
; A per-machine install over a per-user one also runs the per-user uninstaller with --updated
; (installSection.nsh: uninstallOldVersion HKEY_CURRENT_USER), which deletes the per-user Blueline.exe but keeps
; its registration. HKCU wins over HKLM in HKEY_CLASSES_ROOT, so that copy would shadow the new one with a
; command naming the deleted exe, and nothing would ever remove it: a per-machine install therefore removes the
; per-user copy itself, with the uninstaller's own lines, in the current user's hive (review finding 23). Only
; the user who runs the installer is reached; another account's per-user copy stays with that account.
;
; electron-builder writes no association of its own on Windows: fileAssociations are macOS's only
; (electron-builder.config.cjs), so its NSIS template never sets the extensions' default value (review finding
; 22), and nothing here reads or clears it.
;
; Macro names and variables are electron-builder 26's (app-builder-lib/templates/nsis): customInstall runs at
; the end of the install section (installSection.nsh), customUnInstall at the start of the uninstall section
; (uninstaller.nsh); $appExe is the installed executable; ${isUpdated} is set for an update's uninstall.
;
; NOT RUN ON WINDOWS: the dev container is Linux. test/unit/app/settings.test.ts and packaging.test.ts check
; statically that uninstall removes exactly the keys and values written below, and that a per-machine install
; removes the same set from the current user's hive. Check on Windows (per-user and per-machine): install,
; `reg query HKCU\Software\RegisteredApplications /v Blueline` (HKLM for per-machine), Settings › Apps ›
; Default apps lists Blueline, choose it for .html, update over it (the choice stays), install per machine over a
; per-user install (the HKCU keys go), uninstall (the keys go). Under Wine 9 that sequence (per user, then per
; machine, then uninstall) left no Blueline key in either hive, and .html's own default value untouched.

!ifndef BLUELINE_PROGID
  ; The names are also in native-helper.ts (WINDOWS_PROG_ID, REGISTERED_APP_NAME): keep them equal.
  !define BLUELINE_PROGID "Blueline.HTML"
  !define BLUELINE_REGISTERED_APP "Blueline"
  !define BLUELINE_VENDOR_KEY "Software\Blueline"
  !define BLUELINE_CAPABILITIES_KEY "Software\Blueline\Capabilities"
!endif

!macro customInstall
  ; The ProgID: what .html and .htm files open with when Blueline is chosen.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}" "" "HTML Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}\shell\open" "" "Open with Blueline"
  ; Both paths quoted: an install folder under Program Files has spaces.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}\shell\open\command" "" '"$appExe" "%1"'

  ; Open With lists the ProgID for each extension. The extensions' own default value is never touched (6.1: an
  ; app does not set the default; the user chooses it in Default Apps).
  WriteRegNone SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${BLUELINE_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${BLUELINE_PROGID}"

  ; Capabilities, and the RegisteredApplications value Default Apps settings reads (6.1).
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}" "ApplicationDescription" "Reads, reviews and edits HTML decks and documents."
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}" "ApplicationIcon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}\FileAssociations" ".html" "${BLUELINE_PROGID}"
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}\FileAssociations" ".htm" "${BLUELINE_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${BLUELINE_REGISTERED_APP}" "${BLUELINE_CAPABILITIES_KEY}"

  ; A per-machine install: the per-user copy goes (see the header). The same lines as customUnInstall, with
  ; SHELL_CONTEXT set to the current user's hive, then back to the machine's for the rest of the install (as
  ; electron-builder's own templates switch it).
  ${if} $installMode == "all"
    SetShellVarContext current
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${BLUELINE_REGISTERED_APP}"
    DeleteRegKey SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}"
    DeleteRegKey /ifempty SHELL_CONTEXT "${BLUELINE_VENDOR_KEY}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${BLUELINE_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${BLUELINE_PROGID}"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}"
    SetShellVarContext all
  ${endIf}

  ; SHCNE_ASSOCCHANGED, SHCNF_FLUSH: Explorer and Settings re-read the associations now.
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${BLUELINE_REGISTERED_APP}"
    DeleteRegKey SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}"
    DeleteRegKey /ifempty SHELL_CONTEXT "${BLUELINE_VENDOR_KEY}"

    DeleteRegValue SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${BLUELINE_PROGID}"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${BLUELINE_PROGID}"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids"

    DeleteRegKey SHELL_CONTEXT "Software\Classes\${BLUELINE_PROGID}"

    System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
  ${endIf}
!macroend
