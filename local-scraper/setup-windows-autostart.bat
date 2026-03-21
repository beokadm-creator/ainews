@echo off
title Setup AI News Local Scraper AutoStart
echo ========================================
echo   Windows AutoStart Setup
echo ========================================
echo.

cd /d C:\Users\whhol\ainews\ainews\local-scraper

if not exist logs mkdir logs
echo [OK] logs folder created

echo.
echo [1/4] Installing npm dependencies...
npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)
echo [OK] npm install completed

echo.
echo [2/4] Building TypeScript...
npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)
echo [OK] Build completed

echo.
echo [3/4] Setting up PM2...
npm install -g pm2
npm install -g pm2-windows-startup

pm2 stop ainews-local-scraper >nul 2>&1
pm2 delete ainews-local-scraper >nul 2>&1
pm2 start ecosystem.config.js

pm2 save
echo [OK] PM2 setup completed

echo.
echo [4/4] Registering Windows AutoStart...

set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

copy /Y start-chrome-background.bat "%STARTUP_FOLDER%\chrome-remote-debug.bat" >nul 2>&1

if %ERRORLEVEL% EQU 0 (
    echo [OK] Chrome AutoStart registered
) else (
    echo [WARNING] Failed to register Chrome AutoStart
)

echo.
echo ========================================
echo   Setup Completed!
echo ========================================
echo.
echo Next Steps:
echo  1. Restart your PC
echo  2. Chrome will start automatically (port 9222)
echo  3. Local scraper will start (port 3001)
echo  4. Visit: http://localhost:3001/health
echo.
echo Paths:
echo  - Local Scraper: C:\Users\whhol\ainews\ainews\local-scraper
echo  - Logs: C:\Users\whhol\ainews\ainews\local-scraper\logs
echo  - AutoStart: %STARTUP_FOLDER%\chrome-remote-debug.bat
echo.
echo Commands:
echo  - Status: pm2 status
echo  - Logs: pm2 logs ainews-local-scraper
echo  - Stop: pm2 stop ainews-local-scraper
echo.
pause
