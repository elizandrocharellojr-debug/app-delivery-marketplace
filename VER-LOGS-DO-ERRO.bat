@echo off
cd /d "C:\Users\Pietro\Desktop\app delivery\app delivery"

echo ================================================
echo   Alloo - Ver por que o deploy falhou
echo ================================================
echo.

call railway link -p 9afea344-cac0-4fd2-808b-7c4a7fd32739 -e production -s 881c7096-ce24-4818-8dc8-8e89e993e8ed

echo.
echo Copie TODO o texto que aparecer abaixo e me mande:
echo ================================================
call railway logs
echo ================================================
echo.
pause
