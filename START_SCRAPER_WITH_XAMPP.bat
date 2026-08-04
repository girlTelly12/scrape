@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo   Public Site Migration - Start MySQL and Scraper
echo ============================================================
echo.

netstat -ano | findstr /R /C:":3306 .*LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [1/3] MySQL port 3306 is not running.
    if exist "C:\xampp\mysql_start.bat" (
        echo       Starting MySQL from C:\xampp\mysql_start.bat ...
        start "XAMPP MySQL" /min cmd /c "C:\xampp\mysql_start.bat"
        timeout /t 5 /nobreak >nul
    ) else (
        echo       XAMPP MySQL start script was not found.
        echo       The scraper will continue in file-only mode if MySQL is unavailable.
    )
) else (
    echo [1/3] MySQL is already listening on port 3306.
)

echo [2/3] Checking package.json ...
if not exist package.json (
    echo ERROR: package.json was not found in %CD%
    pause
    exit /b 1
)

echo [3/3] Starting scraper server ...
echo       Open http://localhost:3000
npm.cmd start

pause
endlocal
