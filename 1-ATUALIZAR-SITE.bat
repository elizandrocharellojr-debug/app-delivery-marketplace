@echo off
cd /d "C:\Users\Pietro\Desktop\app delivery\app delivery"

echo ================================================
echo   Alloo - Atualizar o site no Railway
echo ================================================
echo.
echo Isso vai enviar a versao mais nova do app (com a
echo interface nova e as ultimas correcoes) para o
echo endereco que ja esta no ar.
echo.

rem Forca a ligacao com o projeto/servico corretos ANTES de cada envio -
rem ja existiu um projeto duplicado com o mesmo nome (criado por engano
rem numa tentativa antiga, ja excluido) e, sem isso, o envio pode ir parar
rem no lugar errado em vez de ir pro site que os clientes realmente usam.
rem Rodar isso toda vez custa 1 segundo e evita esse erro se repetir.
call railway link -p 9afea344-cac0-4fd2-808b-7c4a7fd32739 -e production -s 881c7096-ce24-4818-8dc8-8e89e993e8ed

echo.
echo Projeto/servico ligado nesta pasta agora:
call railway status
echo.
pause

call railway up

if errorlevel 1 (
  echo.
  echo ================================================
  echo   ERRO: o Railway recusou o envio. Veja a mensagem
  echo   acima - NADA foi publicado. Tente de novo ou peça
  echo   ajuda antes de considerar isso pronto.
  echo ================================================
  echo.
  pause
  exit /b 1
)

echo.
echo ================================================
echo   Pronto! Espera 1 ou 2 minutos e recarrega o site
echo   (alloo-production.up.railway.app) para ver
echo   a versao nova no ar.
echo ================================================
echo.
pause
