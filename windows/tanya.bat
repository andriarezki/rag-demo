@echo off
cd /d "%~dp0"
set /p Q=Pertanyaan: 
node\node.exe --disable-warning=ExperimentalWarning --env-file=config.env dist\cli.js ask %Q%
pause
