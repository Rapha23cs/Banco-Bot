@echo off
chcp 65001 > nul
echo ==================================================================
echo  SGA 360 - Verificacao de Conectividade dos Bancos
echo ==================================================================
cd /d "%~dp0"
python sync_prod.py --check
echo.
pause

