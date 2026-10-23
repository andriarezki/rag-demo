@echo off
cd /d "%~dp0"
if not exist data mkdir data
echo Menjalankan Pagewise. Jangan tutup jendela ini selama dipakai.
node\node.exe --disable-warning=ExperimentalWarning --env-file=config.env dist\server.js
echo.
echo Pagewise berhenti. Jika ada pesan kesalahan di atas, foto layarnya.
pause
