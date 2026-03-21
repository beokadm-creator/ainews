@echo off
title Chrome - Remote Debugging Mode
echo ========================================
echo   Chrome Remote Debugging Mode
echo   Port: 9222
echo ========================================
echo.
echo Note: All existing Chrome windows must be closed.
echo.
pause

taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [INFO] Starting Chrome with remote debugging...
echo [INFO] Chrome window will open now...
echo.

"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\Users\whhol\chrome-debug-profile"

echo.
echo [INFO] Chrome closed
echo.
