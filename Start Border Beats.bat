@echo off
rem Starts the Border Beats TikTok helper and opens Border Beats in your browser.
rem Keep this window open while you use Border Beats. Close it (or press Ctrl+C) to stop.
title Border Beats
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed to run the helper. Get it from https://nodejs.org ^(the LTS version^), then try again.
  pause
  exit /b 1
)
node tiktok-helper.js
pause
