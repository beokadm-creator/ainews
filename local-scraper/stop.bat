@echo off
title AI News Local Scraper - Stop

pm2 stop ainews-local-scraper
pm2 delete ainews-local-scraper

echo.
echo [INFO] Scraper server stopped.
echo.
pause
