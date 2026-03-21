@echo off
title AI News Local Scraper - Auto Start Setup
echo ========================================
echo   Setting up Windows Auto Start...
echo ========================================

cd /d C:\Users\whhol\ainews\ainews\local-scraper

:: logs 폴더 생성
if not exist logs mkdir logs

:: PM2 및 pm2-windows-startup 설치
echo [INFO] Installing PM2...
npm install -g pm2
npm install -g pm2-windows-startup

:: 빌드
echo [INFO] Building project...
npm run build

:: PM2로 서버 시작
echo [INFO] Starting server with PM2...
pm2 start ecosystem.config.js

:: Windows 부팅 시 자동 시작 등록
echo [INFO] Registering Windows auto-start...
pm2-startup install

:: 현재 PM2 프로세스 목록 저장
pm2 save

echo.
echo ========================================
echo   Setup complete!
echo   The scraper will now start automatically on Windows boot.
echo.
echo   Manual commands:
echo     Start : pm2 start ainews-local-scraper
echo     Stop  : pm2 stop ainews-local-scraper
echo     Logs  : pm2 logs ainews-local-scraper
echo     Status: pm2 status
echo ========================================
echo.
pause
