@echo off
REM career-ops — otomatik ilan taraması (3 saatte bir, Görev Zamanlayıcı çalıştırır).
REM 1) yeni ilanları tarar (ATS + LinkedIn + iş panoları) → data\pipeline.md
REM 2) kapanan ilanları denetler: To-Apply'da Descartada, pipeline'da "Kapandı"ya taşır
REM    → kapanmış ilanlar dashboard'da görünmez.
REM Log: logs\scan-<tarih>.log

cd /d "%~dp0"
if not exist "logs" mkdir "logs"

for /f "tokens=1-3 delims=/-. " %%a in ("%DATE%") do set STAMP=%%c%%b%%a
set LOG=logs\scan-%STAMP%.log

echo ==== tarama %DATE% %TIME% ==== >> "%LOG%"
call node --use-system-ca web-dashboard\scan-jobs.mjs >> "%LOG%" 2>&1

REM Canlılık denetimi her turda sınırlı sayıda kayıt işler; birikmiş liste
REM birkaç tura yayılarak taranır (önbellek 40 saat boyunca "açık" sonucu tekrar denemez).
call node --use-system-ca liveness-sweep.mjs --limit 120 >> "%LOG%" 2>&1

echo ==== bitti %TIME% ==== >> "%LOG%"
