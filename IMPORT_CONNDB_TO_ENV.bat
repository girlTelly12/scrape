@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo ===============================================
echo Import PHP MySQL connection to Scraper .env
echo ===============================================
echo.
set /p "PHPFILE=Drag conndb.php here, or type full path: "
set "PHPFILE=%PHPFILE:"=%"
if not exist "%PHPFILE%" (
  echo File not found: %PHPFILE%
  pause
  exit /b 1
)

echo.
echo [1] Local XAMPP on this computer
echo [2] Same hosting/server as the PHP website
choice /c 12 /n /m "Select mode [1/2]: "
if errorlevel 2 (
  set "MODE=same-server"
) else (
  set "MODE=local-xampp"
)

node "%~dp0scripts\import-php-db-config.js" "%PHPFILE%" "%MODE%"
if errorlevel 1 (
  echo Import failed.
  pause
  exit /b 1
)

echo.
echo Completed. Review .env before starting the scraper.
pause
