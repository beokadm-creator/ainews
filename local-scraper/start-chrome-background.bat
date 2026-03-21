@echo off
REM Chrome background execution with remote debugging port 9222
REM Auto-run from Windows startup programs

taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 1 /nobreak >nul

start "" /B "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\whhol\AppData\Local\Google\Chrome\User Data" ^
  --profile-directory="Default" ^
  --no-first-run ^
  --no-default-browser-check ^
  https://www.thebell.co.kr/

timeout /t 5 /nobreak >nul

exit /b
