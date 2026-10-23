@echo off
cd /d "%~dp0"
if not exist data mkdir data
echo Reading all documents in the DOCS_DIR folder (see config.env). Many PDFs can take a while.
node\node.exe --disable-warning=ExperimentalWarning --env-file=config.env dist\cli.js ingest
echo.
echo Done. Restart start.bat so that the new documents are used.
pause
