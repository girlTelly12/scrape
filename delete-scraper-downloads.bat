@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion

title Delete all scraper downloads

rem วางไฟล์ BAT นี้ไว้ในโฟลเดอร์โปรเจกต์เดียวกับโฟลเดอร์ downloads
set "BASE=%~dp0downloads"
set "EMPTY=%TEMP%\scraper-empty-%RANDOM%-%RANDOM%"

echo ============================================================
echo  ลบข้อมูลทั้งหมดในโฟลเดอร์ downloads
echo ============================================================
echo.
echo ตำแหน่ง:
echo %BASE%
echo.

if not exist "%BASE%\" (
    echo ไม่พบโฟลเดอร์ downloads:
    echo %BASE%
    echo.
    echo ให้วางไฟล์ BAT ไว้ในโฟลเดอร์โปรเจกต์ เช่น:
    echo C:\web-scraper\scrape-masterv1\
    echo.
    pause
    exit /b 1
)

echo ข้อมูลทั้งหมดที่จะถูกลบ:
echo ------------------------------------------------------------

dir /b /a "%BASE%" 2>nul

if errorlevel 1 (
    echo [โฟลเดอร์ว่าง ไม่มีข้อมูลให้ลบ]
    echo.
    pause
    exit /b 0
)

echo ------------------------------------------------------------
echo.
echo คำเตือน:
echo ไฟล์และโฟลเดอร์ทั้งหมดภายใน downloads จะถูกลบถาวร
echo แต่โฟลเดอร์ downloads จะยังคงอยู่
echo.

choice /C YN /N /M "ยืนยันการลบหรือไม่? (Y/N): "

if errorlevel 2 (
    echo.
    echo ยกเลิกการลบแล้ว
    pause
    exit /b 0
)

echo.
echo กำลังหยุด Node.js ที่อาจใช้งานไฟล์อยู่...
taskkill /F /IM node.exe >nul 2>&1

echo กำลังลบข้อมูลทั้งหมดใน downloads...

rem สร้างโฟลเดอร์ว่างชั่วคราว
md "%EMPTY%" >nul 2>&1

rem ทำให้ downloads เหมือนกับโฟลเดอร์ว่าง
rem ช่วยลบโฟลเดอร์ลึก ชื่อไฟล์ยาว และไฟล์ซ่อน
robocopy "%EMPTY%" "%BASE%" /MIR /R:0 /W:0 /XJ /NFL /NDL /NJH /NJS /NP >nul

rem ลบไฟล์ที่อาจยังตกค้าง
del /F /Q /A "\\?\%BASE%\*" >nul 2>&1

rem ลบโฟลเดอร์ที่อาจยังตกค้าง
for /D %%D in ("%BASE%\*") do (
    cmd.exe /d /c rd /s /q "\\?\%%~fD" >nul 2>&1
)

rem ลบโฟลเดอร์ว่างชั่วคราว
rd /s /q "%EMPTY%" >nul 2>&1

echo.
echo ============================================================
echo  ตรวจสอบผลการลบ
echo ============================================================
echo.

dir /b /a "%BASE%" >nul 2>&1

if errorlevel 1 (
    echo [สำเร็จ] ลบข้อมูลทั้งหมดใน downloads แล้ว
) else (
    echo [ไม่สำเร็จ] ยังมีไฟล์หรือโฟลเดอร์บางส่วนเหลืออยู่:
    echo.
    dir /b /a "%BASE%" 2>nul
    echo.
    echo สาเหตุที่เป็นไปได้:
    echo - ไฟล์กำลังถูกใช้งานโดยโปรแกรมอื่น
    echo - สิทธิ์ของผู้ใช้ไม่เพียงพอ
    echo - Windows Defender หรือ Antivirus กำลังตรวจสอบไฟล์
    echo.
    echo กรุณาปิดโปรแกรมที่เกี่ยวข้อง แล้วคลิกขวาไฟล์ BAT
    echo เลือก Run as administrator
)

echo.
pause
exit /b 0