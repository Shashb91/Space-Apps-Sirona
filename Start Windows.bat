@echo off
rem Sirona - Lunar Landing Site Navigator: double-click to start the app (Windows).
rem All the work is in launcher.py: the maps, the Python packages, the server and the browser.
setlocal EnableExtensions DisableDelayedExpansion
title Sirona - Lunar Landing Site Navigator
pushd "%~dp0"
if not exist "launcher.py" (
  echo.
  echo  Extract the zip first ^(right-click it ^> Extract All^), then double-click
  echo  "Start Windows.bat" in the extracted folder.
  echo.
  pause
  exit /b 1
)

rem A 64-bit Python 3.10 or newer: the py launcher first, then python on the PATH
set "PY="
for %%v in (3.14 3.13 3.12 3.15 3.11 3.10 3) do if not defined PY call :check py -%%v
if not defined PY call :check python
if not defined PY call :install
if not defined PY exit /b 1

%PY% launcher.py %*
if errorlevel 1 pause
exit /b

:check
%* -c "import sys, struct; sys.exit(sys.version_info < (3, 10) or struct.calcsize('P') != 8)" >nul 2>&1 && set "PY=%*"
exit /b

:install
echo.
echo  This app needs Python ^(3.10 or newer, 64-bit^), and it is not installed.
where winget >nul 2>&1 || goto :by_hand
choice /c YN /m " Install Python 3.14 now (about 30 MB)"
if errorlevel 2 goto :by_hand
winget install --id Python.Python.3.14 --exact --source winget --scope user --silent --accept-package-agreements --accept-source-agreements
call :check "%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
if defined PY exit /b
:by_hand
echo.
echo  Install it from https://www.python.org/downloads/ then double-click this file again.
start "" "https://www.python.org/downloads/"
pause
exit /b
