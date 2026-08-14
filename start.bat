@echo off
rem ============================================================
rem  Multi-Website Scraper - Start All (Windows)
rem  เปิด MySQL (XAMPP) + Chrome (remote debugging) + Server
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo   Multi-Website Scraper - เริ่มระบบทั้งหมด
echo ============================================================

rem --- 1. ตรวจ Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] ไม่พบ Node.js กรุณาติดตั้งจาก https://nodejs.org แล้วรันใหม่อีกครั้ง
    pause
    exit /b 1
)

rem --- 2. ติดตั้ง dependencies ถ้ายังไม่มี ---
if not exist "node_modules" (
    echo กำลังติดตั้ง dependencies (npm install) - ครั้งแรกอาจใช้เวลาสักครู่...
    call npm.cmd install
    if errorlevel 1 (
        echo [ERROR] npm install ล้มเหลว ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่
        pause
        exit /b 1
    )
)

rem --- 3. เปิด MySQL ผ่าน XAMPP (ถ้ามี) ---
set "XAMPP_DIR=%XAMPP_DIR%"
if "%XAMPP_DIR%"=="" set "XAMPP_DIR=C:\xampp"
if exist "%XAMPP_DIR%\mysql_start.bat" (
    echo กำลังเปิด MySQL ผ่าน %XAMPP_DIR%\mysql_start.bat ...
    start "" /min cmd /c ""%XAMPP_DIR%\mysql_start.bat""
) else (
    echo MySQL ไม่พบที่ %XAMPP_DIR% - ข้ามไป (ระบบจะพยายามเปิดเอง หรือทำงานแบบเก็บไฟล์อย่างเดียว)
)

rem --- 4. เปิด Chrome แบบ visible พร้อม remote debugging (ถ้ายังไม่มีที่ port 9222) ---
echo ตรวจ port 9222 ...
curl.exe -s -o NUL --max-time 2 http://127.0.0.1:9222/json/version
if errorlevel 1 (
    set "CHROME_EXE="
    if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
    if "%CHROME_EXE%"=="" if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
    if "%CHROME_EXE%"=="" if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
    if defined CHROME_EXE (
        echo กำลังเปิด Chrome พร้อม remote debugging port 9222 (สำหรับ fallback เว็บที่ตอบ 403) ...
        start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%~dp0.browser-profile" --no-first-run --no-default-browser-check
    ) else (
        echo ไม่พบ Chrome ในตำแหน่งมาตรฐาน - ข้ามไป (ระบบจะพยายามเปิดเองเมื่อจำเป็น)
    )
) else (
    echo Chrome/CDP เปิดอยู่แล้วที่ port 9222
)

rem --- 5. เริ่ม Server และเปิดหน้าเว็บ ---
echo กำลังเริ่ม Server ที่ http://localhost:3000 ...
start "scraper-server" cmd /k "node server.js"
timeout /t 3 >nul
start "" http://localhost:3000

echo.
echo เสร็จแล้ว! ปิดหน้าต่าง "scraper-server" เพื่อหยุด Server
echo (ตรวจสอบสถานะระบบได้จากหน้าเว็บ กล่อง "ตรวจสอบระบบก่อนเริ่มงาน")
pause
