@echo off
echo.
echo  Compilando FinkoImprimir.exe...
echo.
cd /d "%~dp0"
npm install
npx pkg server.js --target node18-win-x64 --output dist/FinkoImprimir.exe
echo.
echo  Listo! El archivo esta en la carpeta dist\FinkoImprimir.exe
echo  Ese archivo puedes distribuirlo a los clientes.
echo.
pause
