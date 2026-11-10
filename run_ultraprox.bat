@echo off
title UltraProx
where node >nul 2>nul || (echo Node.js 18 or newer is required. Get it at https://nodejs.org & pause & exit /b)
start "" http://localhost:8080
node server.js
pause
