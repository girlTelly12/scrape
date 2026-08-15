@echo off
setlocal EnableExtensions DisableDelayedExpansion

title Clear downloads folder

rem This BAT file must be placed beside the downloads folder.
set "BASE=%~dp0downloads"

echo ============================================================
echo Clear all files and folders inside downloads
echo ============================================================
echo.
echo Target folder:
echo %BASE%
echo.

if not exist "%BASE%\" (
    echo ERROR: downloads folder was not found.
    echo.
    echo Place this BAT file in the project folder that contains:
    echo downloads
    echo.
    pause
    exit /b 1
)

echo Items that will be deleted:
echo ------------------------------------------------------------
dir /b /a "%BASE%" 2>nul
echo ------------------------------------------------------------
echo.
echo WARNING: Everything inside downloads will be permanently deleted.
echo The downloads folder itself will be recreated.
echo.

choice /C YN /N /M "Continue? (Y/N): "
if errorlevel 2 (
    echo.
    echo Operation cancelled.
    pause
    exit /b 0
)

echo.
echo Stopping Node.js processes...
taskkill /F /IM node.exe >nul 2>&1

echo Deleting downloads folder...

rem Delete the entire folder using Windows long-path support.
cmd.exe /d /c rd /s /q "\\?\%BASE%" >nul 2>&1

rem Recreate an empty downloads folder.
if not exist "%BASE%\" (
    md "%BASE%" >nul 2>&1
)

echo.
echo ============================================================
echo Result
echo ============================================================
echo.

if not exist "%BASE%\" (
    echo ERROR: Unable to recreate the downloads folder.
    echo Try running this BAT file as Administrator.
) else (
    dir /b /a "%BASE%" >nul 2>&1

    if errorlevel 1 (
        echo SUCCESS: downloads is now empty.
    ) else (
        echo ERROR: Some files or folders could not be deleted.
        echo.
        echo Remaining items:
        dir /b /a "%BASE%" 2>nul
        echo.
        echo Close programs using these files and run as Administrator.
    )
)

echo.
pause
exit /b 0
