@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title XAMPP Quick Launcher

:: ==============================================================
:: XAMPP QUICK LAUNCHER
:: - Finds XAMPP automatically
:: - Opens XAMPP Control Panel
:: - Starts Apache and MySQL
:: - Shows clear service status
:: ==============================================================

:: Request Administrator permission
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: You can manually set your XAMPP path here if needed:
set "XAMPP_DIR="

:: Detect XAMPP in common locations
if not defined XAMPP_DIR if exist "C:\xampp\xampp-control.exe" set "XAMPP_DIR=C:\xampp"
if not defined XAMPP_DIR if exist "D:\xampp\xampp-control.exe" set "XAMPP_DIR=D:\xampp"
if not defined XAMPP_DIR if exist "E:\xampp\xampp-control.exe" set "XAMPP_DIR=E:\xampp"
if not defined XAMPP_DIR if exist "F:\xampp\xampp-control.exe" set "XAMPP_DIR=F:\xampp"
if not defined XAMPP_DIR if exist "%~dp0xampp-control.exe" set "XAMPP_DIR=%~dp0"

if not defined XAMPP_DIR goto XAMPP_NOT_FOUND

:START_SCREEN
cls
color 0B
echo.
echo  ================================================================
echo.
echo                     XAMPP QUICK LAUNCHER
echo.
echo             Apache + MySQL startup and status checker
echo.
echo  ================================================================
echo.
echo        XAMPP Path : %XAMPP_DIR%
echo.
echo        Starting required components...
echo.
echo  ----------------------------------------------------------------
echo.

:: Open XAMPP Control Panel if it is not already open
tasklist /FI "IMAGENAME eq xampp-control.exe" 2>nul | find /I "xampp-control.exe" >nul
if errorlevel 1 (
    echo        [OPENING ] XAMPP Control Panel
    start "" "%XAMPP_DIR%\xampp-control.exe"
) else (
    echo        [OPEN    ] XAMPP Control Panel
)

echo.
call :START_APACHE
call :START_MYSQL

echo.
echo        Waiting for services to initialize...
timeout /t 5 /nobreak >nul

goto DASHBOARD

:START_APACHE
tasklist /FI "IMAGENAME eq httpd.exe" 2>nul | find /I "httpd.exe" >nul
if not errorlevel 1 (
    echo        [RUNNING ] Apache
    exit /b
)

if exist "%XAMPP_DIR%\apache_start.bat" (
    echo        [STARTING] Apache
    start "XAMPP Apache" /min cmd /c "cd /d "%XAMPP_DIR%" && call apache_start.bat"
) else (
    echo        [MISSING ] apache_start.bat
)
exit /b

:START_MYSQL
tasklist /FI "IMAGENAME eq mysqld.exe" 2>nul | find /I "mysqld.exe" >nul
if not errorlevel 1 (
    echo        [RUNNING ] MySQL
    exit /b
)

if exist "%XAMPP_DIR%\mysql_start.bat" (
    echo        [STARTING] MySQL
    start "XAMPP MySQL" /min cmd /c "cd /d "%XAMPP_DIR%" && call mysql_start.bat"
) else (
    echo        [MISSING ] mysql_start.bat
)
exit /b

:DASHBOARD
cls
color 0A
echo.
echo  ================================================================
echo.
echo                     XAMPP SERVICE STATUS
echo.
echo  ================================================================
echo.

call :SHOW_APACHE_STATUS
call :SHOW_MYSQL_STATUS

echo.
echo  ----------------------------------------------------------------
echo.
echo        [R] Retry startup
echo        [C] Open XAMPP Control Panel
echo        [H] Open http://localhost
echo        [Q] Close this launcher
echo.
echo  ----------------------------------------------------------------
echo.

choice /C RCHQ /N /M "        Select an option: "

if errorlevel 4 goto EXIT
if errorlevel 3 goto OPEN_LOCALHOST
if errorlevel 2 goto OPEN_CONTROL
if errorlevel 1 goto RETRY_START

:SHOW_APACHE_STATUS
tasklist /FI "IMAGENAME eq httpd.exe" 2>nul | find /I "httpd.exe" >nul
if errorlevel 1 (
    echo        [ OFF    ] Apache
) else (
    echo        [ RUNNING] Apache      http://localhost
)
exit /b

:SHOW_MYSQL_STATUS
tasklist /FI "IMAGENAME eq mysqld.exe" 2>nul | find /I "mysqld.exe" >nul
if errorlevel 1 (
    echo        [ OFF    ] MySQL
) else (
    echo        [ RUNNING] MySQL       Port 3306
)
exit /b

:RETRY_START
cls
color 0E
echo.
echo        Retrying Apache and MySQL startup...
echo.
call :START_APACHE
call :START_MYSQL
timeout /t 5 /nobreak >nul
goto DASHBOARD

:OPEN_CONTROL
start "" "%XAMPP_DIR%\xampp-control.exe"
goto DASHBOARD

:OPEN_LOCALHOST
start "" "http://localhost/"
goto DASHBOARD

:XAMPP_NOT_FOUND
cls
color 0C
echo.
echo  ================================================================
echo.
echo                       XAMPP NOT FOUND
echo.
echo  ================================================================
echo.
echo        XAMPP could not be found in these locations:
echo.
echo        C:\xampp
echo        D:\xampp
echo        E:\xampp
echo        F:\xampp
echo.
echo        Open this BAT file with Notepad and set:
echo.
echo        set "XAMPP_DIR=C:\your-xampp-folder"
echo.
echo  ----------------------------------------------------------------
echo.
pause
exit /b 1

:EXIT
cls
color 07
echo.
echo        XAMPP will continue running in the background.
echo        This launcher is now closed.
echo.
timeout /t 2 /nobreak >nul
exit /b
