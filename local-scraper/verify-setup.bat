@echo off
title AI News Local Scraper - Verify Setup
echo ========================================
echo   Verification
echo ========================================
echo.

echo [1] Checking Chrome remote debugging port 9222...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -TimeoutSec 2; if ($r.StatusCode -eq 200) { Write-Host '[OK] Chrome port 9222 working' -ForegroundColor Green } else { Write-Host '[ERROR] Chrome port 9222 issue' -ForegroundColor Red } } catch { Write-Host '[NOT RUNNING] Chrome not running (start Chrome first)' -ForegroundColor Yellow }"

echo.
echo [2] Checking local scraper health...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3001/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { Write-Host '[OK] Local scraper working' -ForegroundColor Green } else { Write-Host '[ERROR] Local scraper issue' -ForegroundColor Red } } catch { Write-Host '[NOT RUNNING] Local scraper not running (start server first)' -ForegroundColor Yellow }"

echo.
echo [3] Checking PM2 status...
pm2 status

echo.
echo [4] Checking logs folder...
if exist "logs" (
    echo [OK] logs folder exists
    dir logs /B
) else (
    echo [NOT FOUND] logs folder missing
)

echo.
echo [5] Checking Windows AutoStart...
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\chrome-remote-debug.bat" (
    echo [OK] Chrome AutoStart registered
) else (
    echo [NOT FOUND] Chrome AutoStart not registered
)

echo.
echo ========================================
pause
