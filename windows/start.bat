@echo off
cd /d "%~dp0"
if not exist data mkdir data
echo Menjalankan asisten dokumen. Jangan tutup jendela ini selama dipakai.
node\node.exe --disable-warning=ExperimentalWarning --env-file=config.env dist\server.js
echo.
echo Asisten berhenti. Jika ada pesan kesalahan di atas, foto layarnya.
pause
