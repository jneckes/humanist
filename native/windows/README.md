# Windows: no helper process

SPEC 9.6 reserves `native/windows/` for a helper that reads `Zone.Identifier` and opens Default Apps settings.
Neither needs native code, so Windows ships no helper binary:

- **Internet markers** (6.10, 9.9). A file from the internet carries an NTFS alternate data stream,
  `<path>:Zone.Identifier`, an INI text with `[ZoneTransfer]` and `ZoneId=3` (Internet) or more. Node's `fs`
  opens stream paths directly, so main reads it (`readInternetMarker`), copies it to the atomic write's temp file
  before the rename (`copyMarkerToTemp`, 9.9 Write protocol addition), copies it to derived files (`copyMarker`,
  `markDerivedFile`) and writes one for a deck's downloads (`writeDownloadMarker`), all in
  `packages/app/src/main/markers.ts`. The whole stream text is the marker trust.json remembers decisions against.
- **Becoming the default app** (6.1). Windows does not let an app set itself as the default. "Make Blueline your
  HTML app" (first run, Settings › General) opens Default Apps settings on Blueline's own page
  (`packages/app/src/main/native-helper.ts`, `defaultAppsUri`):
  - `ms-settings:defaultapps?registeredAppUser=Blueline` for a per-user install, or
    `ms-settings:defaultapps?registeredAppMachine=Blueline` for a per-machine install. Main tells them apart by
    the hive that holds the installer's `RegisteredApplications\Blueline` value (`reg.exe query`, HKCU first).
  - That link needs Windows 11 21H2 with the 2023-04 cumulative update (KB5025224, OS build 22000.1817) or later;
    on 22H2 the 2023-04 preview update (KB5025305, 22621.1635) or later; every later feature update (23H2 22631,
    24H2 26100, …) has it. `os.release()` gives the build number only, so on builds 22000 and 22621 main also
    reads the update revision (`UBR` under `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`); when it cannot,
    or on Windows 10 and older, it opens the plain `ms-settings:defaultapps`, which always works.
  - Settings › General shows whether Blueline is the default: main reads the user's choice for `.html`
    (`HKCU\…\Explorer\FileExts\.html\UserChoiceLatest` or `UserChoice`, value `ProgId`), read only.
- **Registry entries.** The link above finds Blueline only if the installer registered it:
  `packages/app/build/installer.nsh` (electron-builder's `nsis.include`) writes the `Blueline.HTML` ProgID,
  `OpenWithProgids` for `.html` and `.htm`, the `Capabilities` key and the `RegisteredApplications` value, in HKCU
  for a per-user install and HKLM for a per-machine one, and removes them on uninstall.

Not run here: the dev container is Linux. The Windows code paths are unit-tested with injected platform, file
reads and `reg.exe` output (`test/unit/app/markers.test.ts`, `native-helper.test.ts`, `settings.test.ts`); the
installer has a static check that everything it writes is removed on uninstall. Check on Windows 11 (per-user and
per-machine installs): install; `reg query HKCU\Software\RegisteredApplications /v Blueline`; Settings › General ›
"Make Blueline your HTML app" opens Default Apps on Blueline's page; choose it for `.html`; download a deck with
Edge and open it (Protected, "Came from the internet"); save notes into it and check
`Get-Content deck.html -Stream Zone.Identifier` still shows `ZoneId=3`; update over the install (the choice stays);
uninstall (the keys are gone).
