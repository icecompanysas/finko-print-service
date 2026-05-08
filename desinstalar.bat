@echo off
echo.
echo  Desinstalando Finko Print Service...
echo.

:: Detener el proceso si esta corriendo
taskkill /f /im FinkoImprimir.exe >nul 2>&1

:: Quitar del inicio de Windows
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
if exist "%STARTUP%\FinkoPrintService.vbs" del "%STARTUP%\FinkoPrintService.vbs"

echo  Eliminado del inicio de Windows.
echo.
pause
