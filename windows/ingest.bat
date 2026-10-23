@echo off
cd /d "%~dp0"
if not exist data mkdir data
echo Membaca semua dokumen di folder DOCS_DIR (lihat config.env). Ini bisa memakan waktu untuk banyak PDF.
node\node.exe --disable-warning=ExperimentalWarning --env-file=config.env dist\cli.js ingest
echo.
echo Selesai. Jalankan ulang start.bat supaya dokumen baru dipakai.
pause
