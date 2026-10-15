@echo off
REM GODS EYE #60 — Unduh bobot YOLO26n (.onnx resmi Ultralytics).
REM Jalankan SEKALI dari folder dashboard\:  scripts\unduh-model.bat
REM File TIDAK di-commit (lihat .gitignore: *.onnx) — tiap mesin unduh sendiri.
REM Sumber: https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx

setlocal
set URL=https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx
set DEST=%~dp0..\public\models\yolo26n.onnx

if not exist "%~dp0..\public\models" mkdir "%~dp0..\public\models"

echo [gods-eye] Mengunduh YOLO26n (~9,5 MB)...
curl -L --fail -o "%DEST%" "%URL%"
if errorlevel 1 (
  echo [gods-eye] GAGAL mengunduh. Periksa koneksi internet lalu ulangi.
  exit /b 1
)

for %%F in ("%DEST%") do set SIZE=%%~zF
echo [gods-eye] Selesai: %DEST% (%SIZE% byte, ekspektasi ~9941957)
echo [gods-eye] Lanjut: npm run build  ^&^&  cd ..\backend  ^&^&  npm start
endlocal
