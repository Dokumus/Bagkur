@echo off
REM career-ops — ilan canlılık denetimi (2 günde bir, Görev Zamanlayıcı çalıştırır).
REM 1) ilanların gerçek yayın tarihlerini tazeler  2) To-Apply listesini denetler,
REM kapananları applications.md'de Descartada yapar.
REM Log: logs\liveness-<tarih>.log

cd /d "%~dp0"
if not exist "logs" mkdir "logs"

for /f "tokens=1-3 delims=/-. " %%a in ("%DATE%") do set STAMP=%%c%%b%%a
set LOG=logs\liveness-%STAMP%.log

echo ==== %DATE% %TIME% ==== >> "%LOG%"
call node --use-system-ca web-dashboard\backfill-posted-dates.mjs >> "%LOG%" 2>&1
call node --use-system-ca liveness-sweep.mjs >> "%LOG%" 2>&1
echo ==== bitti %TIME% ==== >> "%LOG%"
