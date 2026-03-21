@echo off
REM Local Scraper Server Setup Script for Windows

echo ========================================
echo EUM News Local Scraper Setup
echo ========================================
echo.

REM Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed!
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js version:
node --version
echo.

REM Install dependencies
echo Installing dependencies...
call npm install

if errorlevel 1 (
    echo ERROR: Failed to install dependencies
    pause
    exit /b 1
)

REM Build TypeScript
echo.
echo Building TypeScript...
call npm run build

if errorlevel 1 (
    echo ERROR: Failed to build TypeScript
    pause
    exit /b 1
)

echo.
echo ========================================
echo Setup completed successfully!
echo ========================================
echo.
echo To start the server, run:
echo   npm start
echo.
echo Server will run on http://localhost:3001
echo.
pause
