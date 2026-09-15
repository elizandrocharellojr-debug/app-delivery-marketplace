@echo off
cd /d "C:\Users\Pietro\Desktop\app delivery\app delivery"

echo ================================================
echo   Alloo - Abrir link publico (tunel Cloudflare)
echo ================================================
echo.
echo IMPORTANTE: antes de continuar aqui, abra o arquivo
echo "iniciar-servidor-central.bat" em OUTRA janela e
echo deixe ele rodando. Este arquivo aqui e o segundo
echo passo, depois do servidor ja estar de pe.
echo.
pause

if not exist cloudflared.exe (
  echo Baixando o cloudflared - so acontece na primeira vez...
  powershell -Command "Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile cloudflared.exe"
)

echo.
echo ================================================
echo   Abrindo o tunel...
echo.
echo   Quando aparecer um endereco assim:
echo   https://alguma-coisa.trycloudflare.com
echo.
echo   Copia esse endereco e me manda aqui no chat -
echo   esse vai ser o link publico novo do site.
echo.
echo   NAO FECHE ESTA JANELA. O site so fica no ar
echo   enquanto ela ficar aberta e o servidor (na outra
echo   janela) continuar rodando.
echo ================================================
echo.

cloudflared.exe tunnel --url http://localhost:3000
