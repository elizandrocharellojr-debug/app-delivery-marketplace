# Servidor Central - Alloo

## Objetivo

Este projeto foi preparado para rodar como servidor central na rede da empresa.

Isso significa que:

- o servidor deve ficar ligado em um computador principal
- todos os clientes e estabelecimentos devem acessar o mesmo IP
- o catalogo centralizado passa a ser compartilhado entre os dispositivos

## Arquivos de configuracao

- [server.js](C:\Users\jr\Desktop\app%20delivery\server.js)
- [.env](C:\Users\jr\Desktop\app%20delivery\.env)
- [.env.example](C:\Users\jr\Desktop\app%20delivery\.env.example)
- [iniciar-servidor-central.bat](C:\Users\jr\Desktop\app%20delivery\iniciar-servidor-central.bat)

## Configuracao atual

```env
HOST=0.0.0.0
PUBLIC_HOST=192.168.3.13
PORT=3000
PUBLIC_APP_URL=http://192.168.3.13:3000
```

## Requisito de versao do Node.js

O servidor usa o banco de dados embutido do Node (`node:sqlite`), disponivel a
partir da versao **22.5** do Node.js. Nao precisa instalar nada extra (sem
`npm install`) - so confira a versao instalada:

```cmd
node -v
```

Se aparecer uma versao menor que 22.5, baixe a versao mais recente em
https://nodejs.org antes de iniciar o servidor.

## Como iniciar

### Opcao 1

Abra o arquivo:

- [iniciar-servidor-central.bat](C:\Users\jr\Desktop\app%20delivery\iniciar-servidor-central.bat)

### Opcao 2

No `cmd`:

```cmd
cd /d "C:\Users\jr\Desktop\app delivery"
npm run start:central
```

## Como acessar

### No computador servidor

```text
http://localhost:3000
```

### Nos outros computadores e celulares da rede

```text
http://192.168.3.13:3000
```

## Teste de funcionamento

Rota de saude:

```text
http://192.168.3.13:3000/api/health
```

Se estiver certo, o servidor responde com status `ok`.

## Importante

Para funcionar como servidor central:

- o computador servidor precisa ficar ligado
- todos precisam estar na mesma rede
- o Firewall do Windows pode precisar liberar a porta `3000`

## Observacao tecnica

Catalogo, contas (cliente e lojista) e pedidos agora ficam num banco SQLite
unico no servidor.

Arquivo:

- `data/app.db`

Entao as alteracoes de loja, itens e pedidos sao compartilhadas na hora entre
todos os aparelhos que acessam esse mesmo servidor - inclusive o painel do
lojista recebe pedidos novos e mudancas de status em tempo real (WebSocket),
sem precisar recarregar a pagina.

## Trocar a senha padrao das lojas de teste

As lojas de demonstracao comecam todas com a senha `123456`. Antes de usar o
app com clientes de verdade, entre no painel de cada loja (aba **Conta**) e
troque a senha.

## Backup

Para fazer backup dos dados, basta copiar o arquivo `data/app.db` com o
servidor desligado.
