@echo off
setlocal

set "APP_DIR=%~dp0"
set "DATA_DIR=%APP_DIR%data"
set "LOG_DIR=%APP_DIR%logs"
set "PID_FILE=%DATA_DIR%\qlink.pid"

if "%~1"=="" goto usage
if /I "%~1"=="start" goto start
if /I "%~1"=="stop" goto stop
if /I "%~1"=="restart" goto restart
if /I "%~1"=="status" goto status
goto usage

:start
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%PID_FILE%') { $pidValue = [int](Get-Content '%PID_FILE%' -Raw); if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { Write-Host 'Q-Link already running. PID=' $pidValue; exit 0 } }; Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'qlink.js' -WorkingDirectory '%APP_DIR%' -RedirectStandardOutput '%LOG_DIR%\qlink.out.log' -RedirectStandardError '%LOG_DIR%\qlink.err.log'"
timeout /t 2 /nobreak >nul
call "%~f0" status
exit /b 0

:stop
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (!(Test-Path '%PID_FILE%')) { Write-Host 'Q-Link is not running.'; exit 0 }; $pidValue = [int](Get-Content '%PID_FILE%' -Raw); $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue; if ($process) { Stop-Process -Id $pidValue -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Write-Host 'Q-Link stopped. PID=' $pidValue } else { Write-Host 'Q-Link pid file existed, but process was not running.' }; Remove-Item -LiteralPath '%PID_FILE%' -ErrorAction SilentlyContinue"
exit /b 0

:restart
call "%~f0" stop
call "%~f0" start
exit /b 0

:status
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (!(Test-Path '%PID_FILE%')) { Write-Host 'Q-Link not running.'; exit 1 }; $pidValue = [int](Get-Content '%PID_FILE%' -Raw); $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue; if ($process) { Write-Host ('Q-Link OK. PID=' + $pidValue); Write-Host ('Logs=%LOG_DIR%\qlink.out.log') } else { Write-Host 'Q-Link not running, stale pid file.'; exit 1 }"
exit /b %ERRORLEVEL%

:usage
echo Usage: qlink.bat start ^| stop ^| restart ^| status
exit /b 1
