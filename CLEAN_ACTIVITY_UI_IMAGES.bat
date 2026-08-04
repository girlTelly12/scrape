@echo off
setlocal
set "ROOT=%~dp0downloads"
if not exist "%ROOT%" (
  echo Downloads folder not found: %ROOT%
  pause
  exit /b 1
)
echo Scanning activity folders under:
echo %ROOT%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = [IO.Path]::GetFullPath('%ROOT%');" ^
  "$rx = '^(closelabel|close|prevlabel|nextlabel|loading|loader|spinner|blank|spacer|pixel|transparent|arrowleft|arrowright|left|right|prev|next|bg\d*|head\d*|header\d*|foot\d*|footer\d*|bt\d*|btn\d*|button\d*|menu\d*|nav\d*|name|tem|template|vv\d*|icon\d*|logo\d*|banner\d*)\.(gif|png|jpe?g|webp|bmp)$';" ^
  "$files = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'activity_pictures_file' -and $_.Name -match $rx };" ^
  "$count = @($files).Count;" ^
  "$files | ForEach-Object { Write-Host ('Delete: ' + $_.FullName); Remove-Item -LiteralPath $_.FullName -Force };" ^
  "Write-Host ('Deleted UI images: ' + $count)"
echo.
pause
endlocal
