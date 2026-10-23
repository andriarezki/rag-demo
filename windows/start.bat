@echo off
cd /d "%~dp0"
if not exist data mkdir data
echo Starting Pagewise. Keep this window open while people are using it.
node\node.exe --disable-warning=ExperimentalWarning --env-file=config.env dist\server.js
echo.
echo Pagewise has stopped. If there is an error message above, take a screenshot of it.
pause
