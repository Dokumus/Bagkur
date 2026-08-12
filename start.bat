@echo off
setlocal
title career-ops dashboard
REM ============================================================
REM  career-ops - Is arama panosu baslatici
REM  Bu dosyaya cift tiklayarak panoyu ayaga kaldirabilirsiniz.
REM ============================================================

REM Bu .bat dosyasinin bulundugu klasore gec (bosluk/ozel karakter guvenli).
cd /d "%~dp0"

REM Node.js kurulu mu?
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [HATA] Node.js bulunamadi.
  echo Lutfen once https://nodejs.org adresinden Node.js kurun, sonra tekrar deneyin.
  echo.
  pause
  exit /b 1
)

if not defined PORT set "PORT=4317"

echo.
echo   career-ops dashboard baslatiliyor...
echo   Adres: http://localhost:%PORT%
echo   (Durdurmak icin: bu pencerede Ctrl+C, ya da pencereyi kapatin)
echo.

REM Sunucu ayaga kalkinca tarayiciyi ac (2 sn gecikme). Test icin CO_NO_OPEN=1.
if not defined CO_NO_OPEN start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"

REM Sunucuyu on planda calistir (loglar bu pencerede gorunur).
node "web-dashboard\server.mjs"

echo.
echo Sunucu durdu.
if not defined CO_NO_PAUSE pause
endlocal
