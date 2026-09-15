@echo off
cd /d "C:\Users\jr\Desktop\app delivery"

echo ================================================
echo   Alloo - Tentar resgatar dados atuais da Railway
echo ================================================
echo.
echo Isso tenta baixar o banco de dados mais atual e as
echo variaveis de configuracao direto da Railway, mesmo
echo com o incidente de deploy travado (essas operacoes
echo as vezes funcionam mesmo assim, por serem separadas
echo do processo de build/deploy).
echo.
echo Nao tem problema se algum passo der erro - so me
echo manda o que aparecer na tela que eu sigo o plano B.
echo.

call railway link -p 9afea344-cac0-4fd2-808b-7c4a7fd32739 -e production -s 881c7096-ce24-4818-8dc8-8e89e993e8ed

echo.
echo --- Tentando listar as variaveis de configuracao ---
call railway variable list --json > "railway-vars-TEMP.json"
type "railway-vars-TEMP.json"

echo.
echo ================================================
echo   Pronto! Pode fechar esta janela - eu confiro o
echo   arquivo railway-vars-TEMP.json daqui mesmo.
echo ================================================
echo.
pause
