@echo off
cd /d "%~dp0"
start "" http://localhost:3100
node server.js
pause
