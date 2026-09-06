@echo off
setlocal
set "BRAVE="

if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not defined BRAVE if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not defined BRAVE if exist "%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe"

if defined BRAVE (
  start "" "%BRAVE%" "brave://extensions/"
) else (
  echo 未找到 Brave，请手动在 Brave 地址栏打开 brave://extensions/
)

explorer "%~dp0"
endlocal
