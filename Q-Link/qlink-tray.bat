@echo off
setlocal EnableExtensions

set "APP_DIR=%~dp0"
set "DATA_DIR=%APP_DIR%data"
set "TRAY_PID_FILE=%DATA_DIR%\qlink-tray.pid"
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"

if /I "%ACTION%"=="start" goto start
if /I "%ACTION%"=="stop" goto stop
if /I "%ACTION%"=="restart" goto restart
if /I "%ACTION%"=="status" goto status
goto usage

:start
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%TRAY_PID_FILE%') { try { $pidValue=[int](Get-Content '%TRAY_PID_FILE%' -Raw); if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { Write-Host ('Q-Link tray already running. PID=' + $pidValue); exit 0 } } catch {} }; Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-STA','-ExecutionPolicy','Bypass','-File','%APP_DIR%scripts\q-link-tray.ps1','-AppDir','%APP_DIR%') -WorkingDirectory '%APP_DIR%'; Start-Sleep -Milliseconds 800; if (Test-Path '%TRAY_PID_FILE%') { Write-Host ('Q-Link tray started. PID=' + (Get-Content '%TRAY_PID_FILE%' -Raw).Trim()) } else { Write-Host 'Q-Link tray starting.' }"
exit /b %ERRORLEVEL%

:stop
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%TRAY_PID_FILE%') { try { $pidValue=[int](Get-Content '%TRAY_PID_FILE%' -Raw); $p=Get-Process -Id $pidValue -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue; Write-Host ('Q-Link tray stopped. PID=' + $pidValue) } } catch {}; Remove-Item -LiteralPath '%TRAY_PID_FILE%' -Force -ErrorAction SilentlyContinue } else { Write-Host 'Q-Link tray is not running.' }; & '%APP_DIR%qlink.bat' stop"
exit /b %ERRORLEVEL%

:restart
call "%~f0" stop
call "%~f0" start
exit /b %ERRORLEVEL%

:status
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '%TRAY_PID_FILE%') { try { $pidValue=[int](Get-Content '%TRAY_PID_FILE%' -Raw); if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { Write-Host ('Q-Link tray OK. PID=' + $pidValue); exit 0 } } catch {} }; Write-Host 'Q-Link tray not running.'; exit 1"
exit /b %ERRORLEVEL%

:usage
echo Usage: qlink-tray.bat ^<start^|stop^|restart^|status^>
exit /b 1
