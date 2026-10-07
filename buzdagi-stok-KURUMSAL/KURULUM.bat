@echo off
cd /d "%~dp0"
node --version >nul 2>&1
if errorlevel 1 (
 echo Node.js bulunamadi. Once Node.js kurulmalidir.
 pause
 exit /b 1
)
echo Kurulum tamam. BASLAT.bat dosyasina cift tiklayin.
pause
