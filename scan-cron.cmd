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

REM 2) Yeni ilanların detay metinlerini çek (batch\jd-cache.json)
call node --use-system-ca web-dashboard\fetch-jds.mjs >> "%LOG%" 2>&1

REM 3) İlanları CV ve sıkı kurallarla değerlendir (Telegram bildirimi >= 3.7)
call node --use-system-ca eval-and-notify.mjs >> "%LOG%" 2>&1

REM 4) Değerlendirme sonuçlarını applications.md'ye birleştir ve pipeline'ı temizle
call node --use-system-ca merge-tracker.mjs >> "%LOG%" 2>&1

REM 5) Canlılık denetimi
call node --use-system-ca liveness-sweep.mjs --limit 120 >> "%LOG%" 2>&1

echo ==== bitti %TIME% ==== >> "%LOG%"
