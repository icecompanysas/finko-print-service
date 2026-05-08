@echo off
echo.
echo  =========================================
echo   Instalando Finko Print Service
echo  =========================================
echo.

:: Copiar el exe a una carpeta fija en AppData
set DEST=%APPDATA%\FinkoPrint
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%~dp0dist\FinkoImprimir.exe" "%DEST%\FinkoImprimir.exe" >nul

:: Crear lanzador invisible (sin ventana de consola)
echo Set oShell = CreateObject("WScript.Shell") > "%DEST%\iniciar.vbs"
echo oShell.Run """" ^& "%DEST%\FinkoImprimir.exe" ^& """", 0, False >> "%DEST%\iniciar.vbs"

:: Agregar al inicio de Windows
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
copy /y "%DEST%\iniciar.vbs" "%STARTUP%\FinkoPrintService.vbs" >nul

:: Iniciar ahora mismo
echo  Iniciando el servicio...
wscript.exe "%DEST%\iniciar.vbs"

echo.
echo  LISTO. Finko Print Service esta instalado.
echo  Se iniciara automaticamente cada vez que encienda el PC.
echo.
pause
