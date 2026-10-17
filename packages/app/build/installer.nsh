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
; Macro names and variables are electron-builder 26's (app-builder-lib/templates/nsis): customInstall runs at
; the end of the install section (installSection.nsh), customUnInstall at the start of the uninstall section
; (uninstaller.nsh); $appExe is the installed executable; ${isUpdated} is set for an update's uninstall.
;
; NOT RUN HERE: the dev container is Linux. test/unit/app/settings.test.ts checks statically that every key
; and value written below is removed on uninstall. Check on Windows (per-user and per-machine): install,
; `reg query HKCU\Software\RegisteredApplications /v Blueline` (HKLM for per-machine), Settings › Apps ›
; Default apps lists Blueline, choose it for .html, update over it (the choice stays), uninstall (the keys go).

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

  ; Open With lists the ProgID for each extension. The extensions' own default value is never touched.
  WriteRegNone SHELL_CONTEXT "Software\Classes\.html\OpenWithProgids" "${BLUELINE_PROGID}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.htm\OpenWithProgids" "${BLUELINE_PROGID}"

  ; Capabilities, and the RegisteredApplications value Default Apps settings reads (6.1).
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}" "ApplicationDescription" "Reads, reviews and edits HTML decks and documents."
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}" "ApplicationIcon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}\FileAssociations" ".html" "${BLUELINE_PROGID}"
  WriteRegStr SHELL_CONTEXT "${BLUELINE_CAPABILITIES_KEY}\FileAssociations" ".htm" "${BLUELINE_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${BLUELINE_REGISTERED_APP}" "${BLUELINE_CAPABILITIES_KEY}"

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

    ; electron-builder's own fileAssociations (electron-builder.config.cjs) set the extensions' default value to
    ; its class "HTML Document" and delete that class on uninstall, leaving the default pointing at nothing.
    ; Clear the default only while it is still that class.
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.html" ""
    ${if} $0 == "HTML Document"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.html" ""
    ${endIf}
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.htm" ""
    ${if} $0 == "HTML Document"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.htm" ""
    ${endIf}

    System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0x1000, 0, 0)'
  ${endIf}
!macroend
