@echo off
cd /d "C:\Users\jr\Desktop\app delivery"

echo ================================================
echo   Alloo - Criar conta e preparar o app no Fly.io
echo ================================================
echo.
echo Vai abrir o navegador pra voce criar sua conta (ou
echo entrar, se ja tiver uma) no Fly.io. O Fly costuma pedir
echo um cartao de credito pra verificar a conta, mesmo no
echo plano gratuito/baixo custo - e' voce mesmo que preenche
echo na pagina, eu nao mexo nisso.
echo.
pause

fly auth signup

echo.
echo --- Criando o app "alloo-brasil" no Fly ---
fly apps create alloo-brasil

echo.
echo --- Criando o disco persistente (3 GB, regiao Sao Paulo - gru) ---
fly volumes create alloo_data --region gru --size 3 -a alloo-brasil -y

echo.
echo ================================================
echo   Pronto! Me manda o que apareceu acima.
echo   Se "alloo-brasil" ja estiver em uso por outra
echo   pessoa, me avisa que a gente escolhe outro nome.
echo ================================================
echo.
pause
