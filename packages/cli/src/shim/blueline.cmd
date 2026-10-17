@echo off
rem blueline-shim: the `blueline` command on Windows (Blueline, SPEC 6.1 The command line tool).
rem Runs blueline.cjs, next to this file, with Node.js 22 or later. The app's own Electron cannot run it: its
rem runAsNode fuse stays off (SPEC 9.9). Node.js is looked for in BLUELINE_NODE (when set, it must be one), on
rem PATH, in Program Files\nodejs, nvm-windows (NVM_SYMLINK), Volta and fnm; the first that is 22 or later runs
rem the command. Without one, this says how to get Node.js and exits 1.
setlocal EnableExtensions EnableDelayedExpansion
set "BL_MAIN=%~dp0blueline.cjs"
if not exist "%BL_MAIN%" (
  echo blueline: cannot find "%BL_MAIN%". Reinstall the command from Blueline: Help ^> Install Command Line Tool. 1>&2
  exit /b 1
)
set "BL_NODE="
set "BL_TRIED="
if defined BLUELINE_NODE (
  call :try "%BLUELINE_NODE%"
  if not defined BL_NODE (
    echo blueline: BLUELINE_NODE is set to "%BLUELINE_NODE%", which is not Node.js 22 or later. 1>&2
    exit /b 1
  )
)
if not defined BL_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined BL_NODE call :try "%%N"
if not defined BL_NODE call :try "%ProgramFiles%\nodejs\node.exe"
if not defined BL_NODE if defined NVM_SYMLINK call :try "%NVM_SYMLINK%\node.exe"
if not defined BL_NODE if defined VOLTA_HOME call :try "%VOLTA_HOME%\bin\node.exe"
if not defined BL_NODE call :try "%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined BL_NODE if defined FNM_DIR call :trydir "%FNM_DIR%"
if not defined BL_NODE call :trydir "%APPDATA%\fnm"
if not defined BL_NODE (
  >&2 echo blueline needs Node.js 22 or later to run, and did not find it.
  if defined BL_TRIED >&2 echo Found, but too old or not working:!BL_TRIED!
  >&2 echo Install the current Node.js from https://nodejs.org, or run: winget install OpenJS.NodeJS.LTS
  >&2 echo Then run blueline again. To use a particular Node.js, set BLUELINE_NODE to its path.
  exit /b 1
)
rem Delayed expansion off for the arguments, so a "!" in a file name reaches the command as it was typed.
setlocal DisableDelayedExpansion
"%BL_NODE%" "%BL_MAIN%" %*
exit /b %ERRORLEVEL%

:try
rem Takes %1 when it is Node.js 22 or later (node --version prints v22.11.0).
if not exist "%~1" exit /b 1
set "BL_V="
for /f "delims=" %%V in ('call "%~1" --version 2^>nul') do if not defined BL_V set "BL_V=%%V"
if not defined BL_V (
  set "BL_TRIED=!BL_TRIED! %~1 (did not run);"
  exit /b 1
)
set "BL_V=!BL_V:v=!"
set "BL_MAJOR="
for /f "tokens=1 delims=." %%M in ("!BL_V!") do set "BL_MAJOR=%%M"
set /a BL_MAJOR=BL_MAJOR+0 >nul 2>&1
if !BL_MAJOR! GEQ 22 (
  set "BL_NODE=%~1"
  exit /b 0
)
set "BL_TRIED=!BL_TRIED! %~1 (Node.js !BL_MAJOR!);"
exit /b 1

:trydir
rem fnm: the default alias, then an installed version (node-versions\vX.Y.Z\installation\node.exe).
if not exist "%~1" exit /b 1
call :try "%~1\aliases\default\node.exe"
if defined BL_NODE exit /b 0
for /f "delims=" %%D in ('dir /b /ad /o-n "%~1\node-versions\v*" 2^>nul') do if not defined BL_NODE call :try "%~1\node-versions\%%D\installation\node.exe"
exit /b 0
