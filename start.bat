@echo off
rem ============================================================
rem  Multi-Website Scraper - Start All - Windows
rem  Opens MySQL via XAMPP, Chrome with remote debugging, and the Server
rem
rem  IMPORTANT: keep this file ASCII-only - no Thai/UTF-8 text,
rem  and no parentheses inside echo lines within if-blocks -
rem  both break cmd parsing. Save with CRLF line endings.
rem ============================================================
cd /d "%~dp0"

echo ============================================================
echo   Multi-Website Scraper - Start All
echo ============================================================

rem --- 1. Check Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org and run again.
    pause
    exit /b 1
)

rem --- 2. Install dependencies if missing ---
if not exist "node_modules" (
    echo Installing dependencies - npm install - first run may take a while...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

rem --- 3. Start MySQL via XAMPP - edit the path below if XAMPP is installed elsewhere ---
set "XAMPP_DIR=C:\xampp"
if exist "%XAMPP_DIR%\mysql_start.bat" (
    echo Starting MySQL via %XAMPP_DIR%\mysql_start.bat ...
    start "" /min cmd /c ""%XAMPP_DIR%\mysql_start.bat""
) else (
    echo MySQL not found at %XAMPP_DIR% - skipping. The system will try to start it itself,
    echo or continue in file-only mode.
)

rem --- 4. Start Chrome with remote debugging if port 9222 is not open ---
rem     If an old Chrome is already using this project profile (.browser-profile),
rem     the new --remote-debugging-port flag gets silently ignored - so kill it first.
echo Checking port 9222 ...
curl.exe -s -o NUL --max-time 2 http://127.0.0.1:9222/json/version
if not errorlevel 1 goto :cdp_already

rem Kill any Chrome instance stuck on this project profile
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*\.browser-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
rem Give the profile lock a moment to release
ping -n 3 127.0.0.1 >nul 2>&1

set "CHROME_EXE="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE goto :no_chrome

echo Starting Chrome with remote debugging on port 9222 - for 403/JS fallback ...
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%~dp0.browser-profile" --no-first-run --no-default-browser-check
rem Wait for Chrome to open the debugging port, then verify it really opened
ping -n 6 127.0.0.1 >nul 2>&1
curl.exe -s -o NUL --max-time 2 http://127.0.0.1:9222/json/version
if errorlevel 1 (
    echo [WARNING] Chrome was started but port 9222 is still closed.
    echo [WARNING] Browser fallback for 403/JS sites will not work.
    echo [WARNING] Close all Chrome windows and run start.bat again.
) else (
    echo Chrome/CDP is now running on port 9222
)
goto :after_cdp

:no_chrome
echo Chrome not found in standard locations - skipping. The system will try to launch it when needed.
goto :after_cdp

:cdp_already
echo Chrome/CDP already running on port 9222
goto :after_cdp

:after_cdp

rem --- 5. Start the server unless port 3000 is already in use ---
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>&1
if errorlevel 1 (
    echo Starting server at http://localhost:3000 ...
    start "scraper-server" cmd /k "node server.js"
    rem wait for the server - ping is used instead of timeout because timeout fails when input is redirected
    ping -n 4 127.0.0.1 >nul 2>&1
) else (
    echo Server is already running at http://localhost:3000 - not starting a second one.
)
start "" http://localhost:3000

echo.
echo Done! Close the "scraper-server" window to stop the server.
echo Check the "Health Check" panel on the web page for system status.
pause
