# Guia rápido: como pedir alterações e atualizar o "Alloo"

Este guia explica, em linguagem simples, como funciona o dia a dia de mexer no app e como colocar uma alteração no ar (deploy). Guarde este arquivo na pasta do projeto — ele fica junto dos outros dois guias que já existem (`SERVIDOR_CENTRAL.md` e `COMO_ADICIONAR_FOTOS_NOS_ITENS.md`).

## 1. Como o projeto está organizado, em resumo

Existem dois lugares diferentes onde o app "existe":

- **A pasta no seu computador** (`C:\Users\jr\Desktop\app delivery`) — é onde as alterações são feitas e testadas. Nada que acontece aqui afeta quem já está usando o site de verdade.
- **O Railway** (`https://alloo-production.up.railway.app`) — é a versão publicada, que qualquer cliente acessa pela internet. Só passa a valer depois que você "sobe o deploy" (explicado no item 4).

Ou seja: uma alteração feita na pasta do computador **não aparece pro cliente sozinha**. Sempre tem uma etapa de publicar depois.

## 2. Como pedir uma alteração

1. Abra o Cowork (ou o Claude) com a pasta do projeto conectada.
2. Descreva o que você quer da forma mais concreta possível. Alguns exemplos de como pedir:
   - "Quero mudar o texto do botão de finalizar pedido para 'Confirmar pedido'."
   - "Quero adicionar um campo de CNPJ no cadastro de loja."
   - "O card de pedido não está mostrando o telefone do cliente, corrige isso."
3. Se o pedido for grande ou tiver mais de um jeito de fazer (por exemplo, "coloca desconto por cupom"), espere as perguntas de esclarecimento antes de qualquer coisa ser construída — isso evita retrabalho.
4. Depois que a alteração for feita, peça para **rodar os testes automáticos** (comando `npm test`, já configurado no projeto) antes de considerar pronto. Isso confere se a mudança não quebrou nada que já funcionava.
5. Só depois dos testes passando é que faz sentido seguir para o deploy (item 4).

Não é necessário saber programar para pedir alterações — só descrever o que você quer que aconteça, do jeito que você explicaria para uma pessoa.

## 3. Testar localmente antes de subir (recomendado para mudanças grandes)

Para mudanças pequenas (texto, cor, um campo a mais), normalmente basta confiar nos testes automáticos. Para mudanças grandes (uma tela nova, um fluxo de pagamento, etc.), vale a pena ver funcionando no seu computador antes de publicar:

1. Dê duplo clique em `iniciar-servidor-central.bat` (ou rode `npm run start:central` no terminal, dentro da pasta do projeto).
2. Acesse `http://localhost:3000` no navegador do próprio computador, ou `http://192.168.3.13:3000` em outro aparelho na mesma rede Wi-Fi.
3. Use o app normalmente, como se fosse um cliente ou lojista de teste.
4. Feche a janela do terminal quando terminar de conferir.

## 4. Como subir a alteração pro site no ar (deploy)

Esse é o passo que faz a mudança aparecer de verdade para os clientes. No dia a dia, você só vai precisar de **um arquivo**: `1-ATUALIZAR-SITE.bat`.

### Passo a passo

1. Dê duplo clique em `1-ATUALIZAR-SITE.bat` (dentro da pasta do projeto).
2. Uma janela preta (terminal) vai abrir e pedir para você apertar uma tecla para continuar — pode apertar.
3. Ele vai enviar a versão mais nova do código para o Railway (comando `railway up`).
4. Espere a mensagem de "Pronto!" aparecer. Isso costuma levar de 1 a 3 minutos.
5. Espere mais 1 ou 2 minutos depois disso (o Railway ainda processa a nova versão do outro lado) e recarregue o site: `https://alloo-production.up.railway.app`.

### Como confirmar que funcionou

- Abra `https://alloo-production.up.railway.app/api/health` no navegador. Se aparecer algo como `"status":"ok"`, o servidor novo está no ar.
- Abra o site normal e confira a alteração que você pediu.

### Quando usar o outro arquivo (`2-NAO-USAR-so-para-criar-do-zero.bat`)

Esse é só para a primeira vez que um projeto é publicado do zero (criação de um projeto novo no Railway, variáveis de ambiente, disco de dados, endereço público). Você já passou por isso uma vez, pro projeto que já está no ar — **não precisa (nem deve) rodar ele de novo no uso normal**. Rodá-lo por engano com o site já publicado dá erro (o Railway recusa criar outro projeto pelo limite do plano gratuito), mas não afeta o site que já existe. Os dois arquivos foram renomeados com números (`1-` e `2-`) e o aviso "NAO USAR" bem no nome, exatamente pra evitar clicar no errado.

## 5. Onde ficam as senhas e configurações importantes

- **No seu computador:** o arquivo `.env` (na pasta do projeto) guarda as chaves usadas localmente — senha do admin, chaves do Mercado Pago, Google, notificações. Esse arquivo nunca deve ser compartilhado nem enviado para lugar nenhum (ele já está protegido em `.gitignore`, caso o projeto um dia entre para o Git).
- **No Railway:** as mesmas chaves (e outras, como `DB_FILE` e `UPLOADS_DIR`, que apontam pro disco permanente) ficam nas *Variáveis de ambiente* do projeto, dentro do painel do Railway (railway.app, depois de fazer login). Alterações nessas variáveis não acontecem pelo `1-ATUALIZAR-SITE.bat` — precisam ser feitas direto no painel do Railway ou pela CLI (`railway variable set`).
- **Trocar a senha do admin:** rode `npm run set-admin-password` (localmente, com `ADMIN_PASSWORD` definido no `.env`) para a conta local, ou peça para rodar o mesmo comando via `railway run` para trocar a senha da conta em produção.

## 6. Backup antes de mudanças grandes

Antes de qualquer alteração maior (mexer em pagamento, em pedidos, em estrutura de dados), é uma boa prática garantir uma cópia de segurança:

- Localmente: rode `npm run backup` — ele salva uma cópia do banco de dados em `data/backups/`.
- Em produção (Railway): o banco fica num disco separado (Volume) que sobrevive a cada deploy novo — ou seja, atualizar o código **não apaga dados** (lojas, pedidos, clientes). Ainda assim, para mudanças de risco mais alto, vale pedir para conferir com mais cuidado antes de publicar.

## 7. Se algo der errado depois do deploy

1. Confira `https://alloo-production.up.railway.app/api/health` — se não responder "ok", o servidor pode estar reiniciando ou com erro; espere um minuto e tente de novo.
2. O próprio painel do Railway guarda um histórico das versões já publicadas (aba de implantações/deployments do projeto). Se uma atualização causou um problema visível pro cliente, dá para voltar para a versão anterior por lá enquanto o problema é corrigido — vale abrir o painel do Railway e conferir as opções disponíveis nessa tela, já que a interface pode mudar com o tempo.
3. Se preferir corrigir pelo código: descreva o problema, peça a correção, confirme que os testes automáticos (`npm test`) continuam passando, e rode `1-ATUALIZAR-SITE.bat` de novo — isso publica a correção por cima da versão com problema.

Este projeto não usa Git (controle de versão) hoje — ou seja, o histórico de "quem mudou o quê e quando" só existe nesta conversa e no `AUDITORIA_TECNICA.md`, não num repositório separado. Isso é importante saber: a única forma de reverter uma mudança de código é pedir a alteração contrária e publicar de novo, ou usar o histórico de deployments do próprio Railway (item 2 acima) para o site voltar a responder com uma versão anterior enquanto isso.

## 8. Checklist rápido

- [ ] Descrevi a alteração de forma clara.
- [ ] A alteração foi feita e os testes automáticos (`npm test`) passaram.
- [ ] (Mudança grande) Testei localmente em `http://localhost:3000` antes de publicar.
- [ ] Rodei `1-ATUALIZAR-SITE.bat` e esperei a mensagem de "Pronto!".
- [ ] Conferi `/api/health` e o site publicado depois de 1–2 minutos.
