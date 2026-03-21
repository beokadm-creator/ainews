@echo off
title Chrome Background Scraper

:: ============================================================
::  Chrome Background Mode (scraping)
::  - Starts minimized, no visible window interruption
::  - Use this for normal daily operation
::  - Use start-chrome.bat only when you need to re-login
:: ============================================================

taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [INFO] Starting Chrome in background (minimized)...

start "Chrome-Scraper" /min "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\whhol\chrome-debug-profile" ^
  --start-minimized ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding

echo [INFO] Chrome started in background (port 9222)
echo [INFO] You can now close this window.
echo.
timeout /t 3 /nobreak >nul
