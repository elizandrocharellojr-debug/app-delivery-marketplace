@echo off
cd /d "C:\Users\jr\Desktop\app delivery"

echo ================================================
echo   Alloo - Deploy no Railway (primeira vez)
echo ================================================
echo.

where railway >nul 2>nul
if %errorlevel% neq 0 (
    echo Instalando a ferramenta do Railway ^(so acontece uma vez^)...
    call npm install -g @railway/cli
    echo.
)

echo Agora vai abrir o navegador para voce entrar (ou criar) sua conta Railway.
echo Pode usar login com GitHub, Google ou e-mail - o que for mais facil.
echo.
pause
call railway login
if %errorlevel% neq 0 (
    echo.
    echo Nao foi possivel fazer login. Rode este arquivo de novo depois de conferir sua internet.
    pause
    exit /b 1
)

echo.
echo Criando o projeto "alloo" no Railway...
call railway init --name alloo
if %errorlevel% neq 0 (
    echo.
    echo Nao foi possivel criar o projeto. Copie a mensagem de erro acima e me avise.
    pause
    exit /b 1
)

echo.
echo Enviando o codigo pela primeira vez (isso cria o servico no Railway)...
call railway up --detach

echo.
echo Configurando as chaves e senhas do app (Mercado Pago, Google, notificacoes)...
call railway variable set "HOST=0.0.0.0" --skip-deploys
call railway variable set "MP_ACCESS_TOKEN=APP_USR-2608450044099575-071409-94eddb412fefa7f4561df7d0ed351d2e-3539346921" --skip-deploys
call railway variable set "MP_PUBLIC_KEY=APP_USR-7afa5890-342b-409f-9fe6-df9ac414c7c0" --skip-deploys
call railway variable set "GOOGLE_CLIENT_ID=202633351239-vi9g9vja13j2j9hm8ksf63gqhgd21phu.apps.googleusercontent.com" --skip-deploys
call railway variable set "VAPID_PUBLIC_KEY=BJfcniEZ7Pl1v9pkD5BWR4ZaG5DrtHaGQai2Waa0WqfHn6arTDAPZej42BfjZMcvRUmL0sJp3Df6ZcUFXE-P4Y0" --skip-deploys
call railway variable set "VAPID_PRIVATE_KEY=CLXbf8GJBMiEtph7EHDI3XKsQlDJ2-VrE1aFYaP3ucI" --skip-deploys
call railway variable set "VAPID_SUBJECT=mailto:juniorelizandro90@gmail.com" --skip-deploys

echo.
echo Criando o disco permanente (para o banco de dados e as fotos dos produtos
echo nao sumirem a cada atualizacao do app)...
call railway volume add --mount-path /data

call railway variable set "DB_FILE=/data/app.db" --skip-deploys
call railway variable set "UPLOADS_DIR=/data/uploads" --skip-deploys

echo.
echo Gerando o endereco publico (https) do app...
call railway domain

echo.
echo Enviando a versao final, ja com tudo configurado...
call railway up

echo.
echo ================================================
echo   Pronto! Confira a URL mostrada acima (algo
echo   como https://alloo-production.up.railway.app)
echo   Copie e me mande essa URL na conversa.
echo ================================================
echo.
pause
