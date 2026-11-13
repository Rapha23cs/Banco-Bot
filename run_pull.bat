@echo off
chcp 65001 > nul
cd /d "%~dp0"
python sync_prod.py --pull --yes
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERRO] Ocorreu uma falha na sincronizacao PULL.
    pause
)

