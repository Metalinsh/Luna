@echo off
rem ===================================================================
rem  Luna launcher (dev mode, v1.1)
rem
rem  Double-click this file to open the Luna desktop window.
rem    - data dir : .\data  (portable mode, next to the source)
rem    - close the window to quit; no leftover processes
rem
rem  NOTE: ELECTRON_RUN_AS_NODE is cleared below on purpose.
rem  When that variable is set to 1 (some Electron-based host
rem  environments set it), Electron degrades to plain Node and
rem  fails at startup with:
rem    Cannot read properties of undefined (reading 'isPackaged')
rem
rem  This file is intentionally ASCII-only: cmd.exe reads .bat
rem  files using the system ANSI codepage, so non-ASCII comments
rem  would be garbled.
rem ===================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="

set "ELECTRON=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo   [ERROR] Electron not found: %ELECTRON%
  echo.
  echo   Please install dependencies first, in this folder:
  echo       pnpm install
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Luna v1.1 ^(dev mode^) ...
echo   Data dir: %~dp0data
echo.
echo   Close the window to quit.
echo.

"%ELECTRON%" .

if errorlevel 1 (
  echo.
  echo   [NOTE] Electron exited with code %errorlevel%.
  echo   If it failed to start, please send the output above.
  echo.
  pause
)

endlocal
