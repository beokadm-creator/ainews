@echo off
REM Start the Local Scraper Server

echo ========================================
echo Starting EUM News Local Scraper...
echo ========================================
echo.

cd /d "%~dp0"

REM Check if node_modules exists
if not exist "node_modules" (
    echo Dependencies not installed. Running setup...
    call npm install
)

REM Check if lib directory exists (compiled JS)
if not exist "lib" (
    echo Building TypeScript...
    call npm run build
)

echo.
echo Server starting on http://localhost:3001
echo Press Ctrl+C to stop the server
echo.

npm start
pause
