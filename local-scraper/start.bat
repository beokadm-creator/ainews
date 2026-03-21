@echo off
title AI News Local Scraper
echo ========================================
echo   Local Scraper - Starting...
echo ========================================

cd /d C:\Users\whhol\ainews\ainews\local-scraper

if not exist logs mkdir logs

where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [INFO] PM2 not found. Installing...
    npm install -g pm2
    npm install -g pm2-windows-startup
)

pm2 stop ainews-local-scraper >nul 2>&1
pm2 delete ainews-local-scraper >nul 2>&1

echo [INFO] Starting scraper server...
pm2 start ecosystem.config.js

pm2 status

echo.
echo ========================================
echo   Server running at http://localhost:3001
echo   Health: http://localhost:3001/health
echo ========================================
echo.
pause
