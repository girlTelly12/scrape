@echo off
setlocal EnableExtensions
chcp 65001 >nul
title XAMPP Process Stopper

:: Request Administrator permission
net session >nul 2>&1
if not "%errorlevel%"=="0" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:MENU
cls
color 0B
echo.
echo  ============================================================
echo.
echo                 XAMPP PROCESS STOPPER
echo.
echo        Stop Apache (httpd.exe) and MySQL (mysqld.exe)
echo.
echo  ============================================================
echo.
echo        [1] Stop Apache and MySQL
echo        [2] Check current status
echo        [Q] Exit
echo.
echo  ------------------------------------------------------------
echo.

choice /C 12Q /N /M "  Select an option: "

if errorlevel 3 goto EXIT
if errorlevel 2 goto STATUS
if errorlevel 1 goto STOP_ALL

:STOP_ALL
cls
color 0E
echo.
echo  ============================================================
echo                 STOPPING XAMPP SERVICES
echo  ============================================================
echo.

call :STOP_PROCESS "httpd.exe" "Apache"
call :STOP_PROCESS "mysqld.exe" "MySQL"

echo.
echo  ------------------------------------------------------------
echo.
color 0A
echo        Finished. Apache and MySQL have been stopped.
echo.
echo  ------------------------------------------------------------
echo.
pause
goto MENU

:STATUS
cls
color 0D
echo.
echo  ============================================================
echo                    CURRENT STATUS
echo  ============================================================
echo.

call :CHECK_PROCESS "httpd.exe" "Apache"
call :CHECK_PROCESS "mysqld.exe" "MySQL"

echo.
echo  ------------------------------------------------------------
echo.
pause
goto MENU

:STOP_PROCESS
set "PROCESS_NAME=%~1"
set "DISPLAY_NAME=%~2"

tasklist /FI "IMAGENAME eq %PROCESS_NAME%" 2>nul | find /I "%PROCESS_NAME%" >nul
if "%errorlevel%"=="0" (
    echo        [RUNNING] %DISPLAY_NAME%
    taskkill /F /IM "%PROCESS_NAME%" >nul 2>&1

    tasklist /FI "IMAGENAME eq %PROCESS_NAME%" 2>nul | find /I "%PROCESS_NAME%" >nul
    if "%errorlevel%"=="0" (
        echo        [FAILED ] Could not stop %DISPLAY_NAME%
    ) else (
        echo        [STOPPED] %DISPLAY_NAME%
    )
) else (
    echo        [OFF    ] %DISPLAY_NAME% is not running
)
echo.
exit /b

:CHECK_PROCESS
set "PROCESS_NAME=%~1"
set "DISPLAY_NAME=%~2"

tasklist /FI "IMAGENAME eq %PROCESS_NAME%" 2>nul | find /I "%PROCESS_NAME%" >nul
if "%errorlevel%"=="0" (
    echo        [RUNNING] %DISPLAY_NAME%
) else (
    echo        [OFF    ] %DISPLAY_NAME%
)
echo.
exit /b

:EXIT
cls
color 07
echo.
echo        XAMPP Process Stopper closed.
echo.
timeout /t 1 /nobreak >nul
exit /b
