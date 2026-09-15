@echo off
echo ================================================
echo   Alloo - Instalar a ferramenta do Fly.io
echo ================================================
echo.

powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

echo.
echo ================================================
echo   Instalado! Feche esta janela e abra o proximo
echo   arquivo: 3-CRIAR-CONTA-E-APP-FLY.bat
echo   (precisa fechar e abrir de novo pro Windows
echo   reconhecer o comando novo "fly")
echo ================================================
echo.
pause
