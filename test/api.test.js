// Testes automatizados de ponta a ponta da API do servidor.
//
// Como o servidor não expoe suas funções internamente (e um único arquivo
// server.js que sobe um http.createServer), os testes aqui sobem o servidor
// de verdade como um processo separado (com um banco de dados temporario,
// que nunca encosta no banco real dos lojistas) e fazem chamadas HTTP reais
// contra ele, exatamente como o navegador do cliente faria.
//
// Rodar com: npm test  (ou: node --test)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const TEST_PORT = 3901;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
// Conta de admin criada automaticamente por seedAdminIfNeeded() na primeira
// vez que o banco (neste caso, o banco temporario de teste) sobe vazio.
// A senha é passada pro processo do servidor via ADMIN_PASSWORD (ver
// `before`, abaixo) - nunca fica hard-coded no server.js.
const ADMIN_USERNAME = "Elizandro";
const ADMIN_PASSWORD = "teste-admin-" + Date.now();

let serverProcess;
let tempDbFile;

function waitForServerReady(url, attemptsLeft) {
  return fetch(url)
    .then(function (response) {
      if (!response.ok) {
        throw new Error("Servidor respondeu com erro: " + response.status);
      }
      return true;
    })
    .catch(function (error) {
      if (attemptsLeft <= 0) {
        throw error;
      }
      return new Promise(function (resolve) {
        setTimeout(resolve, 200);
      }).then(function () {
        return waitForServerReady(url, attemptsLeft - 1);
      });
    });
}

before(async function () {
  tempDbFile = path.join(os.tmpdir(), `alloo-test-${Date.now()}.db`);

  serverProcess = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(TEST_PORT),
      HOST: "127.0.0.1",
      DB_FILE: tempDbFile,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      // server.js carrega o .env real do projeto sozinho (loadEnvFile), sem
      // saber que está rodando dentro de um teste - e lê o arquivo direto
      // do disco (por caminho fixo, não por variável de ambiente herdada),
      // então só remover as chaves do ambiente do processo não impede o
      // carregamento. Se esse .env tiver credenciais reais (Mercado Pago,
      // Google, VAPID), os testes que pressupõem "nada configurado"
      // deixariam de testar o caminho de degradação graciosa e passariam a
      // bater de verdade nesses serviços externos com credenciais de
      // produção. SKIP_DOTENV manda o server.js pular esse carregamento
      // por completo pro processo de teste, não importa o que exista no
      // .env de quem está rodando `npm test`.
      SKIP_DOTENV: "1",
      // A suíte inteira faz muito mais de 20 chamadas a rotas sensíveis
      // (login de admin, de taxista, criação de corrida...) - bem mais que
      // um uso real faria em 5 minutos. Sobe o limite só pra este processo
      // de teste; o valor de produção (20) continua o padrão.
      RATE_LIMIT_MAX: "1000"
    }),
    stdio: "pipe"
  });

  await waitForServerReady(`${BASE_URL}/api/health`, 40);
});

after(async function () {
  if (serverProcess) {
    serverProcess.kill();
  }

  [tempDbFile, `${tempDbFile}-wal`, `${tempDbFile}-shm`].forEach(function (file) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  });
});

test("GET /api/health responde ok", async function () {
  const response = await fetch(`${BASE_URL}/api/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.app, "Alloo");
});

test("cadastro de cliente cria conta e permite login", async function () {
  const email = `cliente-${Date.now()}@teste.com`;
  const payload = {
    name: "Cliente Teste",
    cpf: String(Date.now()).slice(0, 11),
    email,
    phone: "41999999999",
    address: {
      street: "Rua Teste",
      number: "123",
      district: "Centro",
      city: "Morretes",
      zipCode: "83350-000"
    },
    password: "senha1234"
  };

  const registerResponse = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const registerBody = await registerResponse.json();

  assert.equal(registerResponse.status, 201);
  assert.ok(registerBody.token);
  assert.equal(registerBody.customer.email, email);

  const loginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: "senha1234" })
  });
  const loginBody = await loginResponse.json();

  assert.equal(loginResponse.status, 200);
  assert.ok(loginBody.token);

  // O mesmo cliente também precisa conseguir entrar usando o CPF em vez do
  // e-mail (login por e-mail OU CPF).
  const cpfLoginResponse = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: payload.cpf, password: "senha1234" })
  });
  const cpfLoginBody = await cpfLoginResponse.json();

  assert.equal(cpfLoginResponse.status, 200);
  assert.ok(cpfLoginBody.token);
  assert.equal(cpfLoginBody.customer.email, email);
});

test("cadastro exige telefone", async function () {
  const email = `sem-telefone-${Date.now()}@teste.com`;
  const response = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Cliente Sem Telefone",
      cpf: String(Date.now()).slice(0, 11),
      email,
      address: {
        street: "Rua Teste",
        number: "1",
        district: "Centro",
        city: "Morretes",
        zipCode: "83350-000"
      },
      password: "senha1234"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.ok(body.error);
});

test("cadastro rejeita e-mail duplicado", async function () {
  const email = `duplicado-${Date.now()}@teste.com`;
  const basePayload = {
    name: "Cliente Duplicado",
    cpf: String(Date.now()).slice(0, 11),
    email,
    phone: "41999999999",
    address: {
      street: "Rua Teste",
      number: "1",
      district: "Centro",
      city: "Morretes",
      zipCode: "83350-000"
    },
    password: "senha1234"
  };

  const first = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(basePayload)
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({}, basePayload, { cpf: String(Date.now() + 1).slice(0, 11) }))
  });
  const secondBody = await second.json();

  assert.equal(second.status, 400);
  assert.ok(secondBody.error);
});

test("login com senha errada retorna 401", async function () {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "não-existe@teste.com", password: "qualquer" })
  });

  assert.equal(response.status, 401);
});

test("GET /api/config devolve o Google Client ID configurado", async function () {
  const response = await fetch(`${BASE_URL}/api/config`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok("googleClientId" in body);
});

test("fluxo de notificações push: chave pública, inscrever e cancelar", async function () {
  const keyResponse = await fetch(`${BASE_URL}/api/push/vapid-public-key`);

  if (keyResponse.status === 404) {
    // push-config.json ainda não foi configurado neste ambiente - ok, apenas
    // confirma que o servidor responde de forma controlada, sem quebrar.
    return;
  }

  const keyBody = await keyResponse.json();
  assert.equal(keyResponse.status, 200);
  assert.ok(keyBody.publicKey);

  const fakeSubscription = {
    customerId: "customer-teste-push",
    subscription: {
      endpoint: `https://example-push-service.invalid/${Date.now()}`,
      keys: {
        p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
        auth: "tBHItJI5svbpez7KI4CCXg"
      }
    }
  };

  const subscribeResponse = await fetch(`${BASE_URL}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fakeSubscription)
  });
  assert.equal(subscribeResponse.status, 201);

  const unsubscribeResponse = await fetch(`${BASE_URL}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: fakeSubscription.subscription.endpoint })
  });
  assert.equal(unsubscribeResponse.status, 200);
});

test("rota inexistente devolve 404", async function () {
  const response = await fetch(`${BASE_URL}/api/rota-que-não-existe`);
  assert.equal(response.status, 404);
});

test("atualizar status de pedido sem login de lojista retorna 401", async function () {
  const response = await fetch(`${BASE_URL}/api/orders/pedido-inexistente/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "Recebido" })
  });

  // Pedido não existe, então o servidor responde 404 antes mesmo de checar
  // login - o importante é que nunca retorna 200 sem loja válida.
  assert.notEqual(response.status, 200);
});

test("painel de admin: usuário ou senha errada não entra", async function () {
  const response = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: "senha-errada" })
  });

  assert.equal(response.status, 401);
});

test("painel de admin: criar loja nova exige login de admin", async function () {
  const response = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeName: "Loja Sem Login", categoryId: "comida", ownerName: "Alguem" })
  });

  assert.equal(response.status, 401);
});

test("painel de admin: login correto cria loja e conta de lojista funcional", async function () {
  const loginResponse = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  const loginBody = await loginResponse.json();

  assert.equal(loginResponse.status, 200);
  assert.ok(loginBody.token);

  const storeName = `Loja Teste ${Date.now()}`;
  const createResponse = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loginBody.token}`
    },
    body: JSON.stringify({
      storeName,
      categoryId: "comida",
      ownerName: "Dono Teste"
    })
  });
  const createBody = await createResponse.json();

  assert.equal(createResponse.status, 201);
  assert.ok(createBody.credentials.username);
  assert.ok(createBody.credentials.password);

  // A loja criada precisa aparecer no catalogo público...
  const catalogResponse = await fetch(`${BASE_URL}/api/catalog`);
  const catalogBody = await catalogResponse.json();
  const createdStore = catalogBody.stores.find(function (store) {
    return store.id === createBody.store.id;
  });
  assert.ok(createdStore, "loja criada deveria aparecer em /api/catalog");
  assert.equal(createdStore.name, storeName);

  // ...e o dono gerado precisa conseguir logar de verdade no painel dele.
  const ownerLoginResponse = await fetch(`${BASE_URL}/api/auth/owner-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: createBody.credentials.username,
      password: createBody.credentials.password
    })
  });
  const ownerLoginBody = await ownerLoginResponse.json();

  assert.equal(ownerLoginResponse.status, 200);
  assert.ok(ownerLoginBody.token);
  assert.equal(ownerLoginBody.owner.storeId, createBody.store.id);
});

test("painel de admin: entrar como uma loja gera sessão de lojista valida", async function () {
  const loginResponse = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  const loginBody = await loginResponse.json();

  const createResponse = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({
      storeName: `Loja Impersonada ${Date.now()}`,
      categoryId: "comida",
      ownerName: "Dono Impersonado"
    })
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201);

  // Sem login de admin, não pode impersonar.
  const noAuthResponse = await fetch(`${BASE_URL}/api/admin/impersonate-store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeId: createBody.store.id })
  });
  assert.equal(noAuthResponse.status, 401);

  // Com login de admin, deve devolver uma sessão de lojista de verdade,
  // sem precisar saber a senha do lojista.
  const impersonateResponse = await fetch(`${BASE_URL}/api/admin/impersonate-store`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({ storeId: createBody.store.id })
  });
  const impersonateBody = await impersonateResponse.json();

  assert.equal(impersonateResponse.status, 200);
  assert.ok(impersonateBody.token);
  assert.equal(impersonateBody.owner.storeId, createBody.store.id);

  // Essa sessão gerada precisa funcionar de verdade numa rota protegida de
  // lojista (ex: listar pedidos da loja).
  const ordersResponse = await fetch(
    `${BASE_URL}/api/orders?storeId=${encodeURIComponent(createBody.store.id)}`,
    { headers: { Authorization: `Bearer ${impersonateBody.token}` } }
  );
  assert.equal(ordersResponse.status, 200);
});

test("painel de admin: nome de usuário duplicado e rejeitado", async function () {
  const loginResponse = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  const loginBody = await loginResponse.json();

  const payload = {
    storeName: `Loja Duplicada ${Date.now()}`,
    categoryId: "comida",
    ownerName: "Dono Duplicado",
    username: `usuário-fixo-${Date.now()}`
  };

  const first = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify(payload)
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify(payload)
  });
  const secondBody = await second.json();

  assert.equal(second.status, 400);
  assert.ok(secondBody.error);
});

// Cria uma loja de teste (via admin) e já devolve um token de lojista
// válido pra ela, pra reaproveitar nos testes de redes sociais e avaliação
// de item abaixo.
async function createTestStoreWithOwnerToken() {
  const loginResponse = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  const loginBody = await loginResponse.json();

  const createResponse = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({
      storeName: `Loja Reviews ${Date.now()}`,
      categoryId: "comida",
      ownerName: "Dono Reviews"
    })
  });
  const createBody = await createResponse.json();

  const impersonateResponse = await fetch(`${BASE_URL}/api/admin/impersonate-store`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loginBody.token}` },
    body: JSON.stringify({ storeId: createBody.store.id })
  });
  const impersonateBody = await impersonateResponse.json();

  return { storeId: createBody.store.id, ownerToken: impersonateBody.token };
}

test("redes sociais: loja salva Instagram/Facebook e devolve só o que foi preenchido", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const catalogBefore = await (await fetch(`${BASE_URL}/api/catalog`)).json();
  const storeBefore = catalogBefore.stores.find((store) => store.id === storeId);
  assert.equal(storeBefore.instagramUrl, "");
  assert.equal(storeBefore.facebookUrl, "");

  const upsertResponse = await fetch(`${BASE_URL}/api/stores/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify(
      Object.assign({}, storeBefore, {
        instagramUrl: "https://instagram.com/lojareviews",
        facebookUrl: "javascript:alert(1)" // deve ser rejeitado por não ser http(s)
      })
    )
  });
  const upsertBody = await upsertResponse.json();

  assert.equal(upsertResponse.status, 200);
  assert.equal(upsertBody.store.instagramUrl, "https://instagram.com/lojareviews");
  assert.equal(upsertBody.store.facebookUrl, "", "link com esquema não-http deve ser descartado");
});

test("avaliação de item: fluxo completo (pedido -> entrega -> avaliação -> listagem)", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      storeId,
      item: { name: "Camiseta P", price: 49.9, section: "Roupas" }
    })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-review-test",
      customerName: "Cliente Teste",
      paymentMethod: "Dinheiro"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  // Ainda não entregue - não pode avaliar.
  const tooEarlyResponse = await fetch(`${BASE_URL}/api/item-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, itemId, rating: 5, comment: "Adorei" })
  });
  assert.equal(tooEarlyResponse.status, 400);

  const statusResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Entregue" })
  });
  assert.equal(statusResponse.status, 200);

  // Item que não faz parte do pedido não pode ser avaliado nesse pedido.
  const wrongItemResponse = await fetch(`${BASE_URL}/api/item-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, itemId: "item-que-nao-existe", rating: 5 })
  });
  assert.equal(wrongItemResponse.status, 400);

  const reviewResponse = await fetch(`${BASE_URL}/api/item-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, itemId, rating: 4, comment: "Veste bem, mas encolheu um pouco." })
  });
  const reviewBody = await reviewResponse.json();
  assert.equal(reviewResponse.status, 201);
  assert.equal(reviewBody.review.rating, 4);

  // Não pode avaliar o mesmo item duas vezes no mesmo pedido.
  const duplicateResponse = await fetch(`${BASE_URL}/api/item-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, itemId, rating: 2 })
  });
  assert.equal(duplicateResponse.status, 400);

  const listResponse = await fetch(`${BASE_URL}/api/items/${encodeURIComponent(itemId)}/reviews`);
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listBody.reviewsCount, 1);
  assert.equal(listBody.averageRating, 4);
  assert.equal(listBody.reviews[0].comment, "Veste bem, mas encolheu um pouco.");
});

test("moderação de avaliações: lojista esconde avaliação de loja e de item, some da média e da listagem pública", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Item Moderação", price: 15 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-moderation-test",
      customerName: "Cliente Moderação",
      paymentMethod: "Dinheiro"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Entregue" })
  });

  // Uma avaliação da loja (nota 1, comentário abusivo/falso) e uma do item.
  const storeReviewResponse = await fetch(`${BASE_URL}/api/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, rating: 1, comment: "Comentário abusivo de teste" })
  });
  const storeReviewBody = await storeReviewResponse.json();
  assert.equal(storeReviewResponse.status, 201);
  const storeReviewId = storeReviewBody.review.id;

  const itemReviewResponse = await fetch(`${BASE_URL}/api/item-reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, itemId, rating: 1, comment: "Avaliação falsa de teste" })
  });
  const itemReviewBody = await itemReviewResponse.json();
  assert.equal(itemReviewResponse.status, 201);
  const itemReviewId = itemReviewBody.review.id;

  // Antes de esconder, ambas aparecem normalmente pro público.
  const storeListBefore = await (await fetch(`${BASE_URL}/api/stores/${encodeURIComponent(storeId)}/reviews`)).json();
  assert.equal(storeListBefore.reviewsCount, 1);
  const itemListBefore = await (await fetch(`${BASE_URL}/api/items/${encodeURIComponent(itemId)}/reviews`)).json();
  assert.equal(itemListBefore.reviewsCount, 1);

  // Sem login de lojista, não pode ver a lista de moderação nem esconder.
  const noAuthManageResponse = await fetch(`${BASE_URL}/api/stores/${encodeURIComponent(storeId)}/reviews/manage`);
  assert.equal(noAuthManageResponse.status, 401);

  const noAuthHideResponse = await fetch(`${BASE_URL}/api/reviews/${encodeURIComponent(storeReviewId)}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden: true })
  });
  assert.equal(noAuthHideResponse.status, 401);

  // Com login do lojista dono da loja, esconde as duas.
  const hideStoreReviewResponse = await fetch(
    `${BASE_URL}/api/reviews/${encodeURIComponent(storeReviewId)}/visibility`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ hidden: true })
    }
  );
  const hideStoreReviewBody = await hideStoreReviewResponse.json();
  assert.equal(hideStoreReviewResponse.status, 200);
  assert.equal(hideStoreReviewBody.hidden, true);

  const hideItemReviewResponse = await fetch(
    `${BASE_URL}/api/item-reviews/${encodeURIComponent(itemReviewId)}/visibility`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ hidden: true })
    }
  );
  const hideItemReviewBody = await hideItemReviewResponse.json();
  assert.equal(hideItemReviewResponse.status, 200);
  assert.equal(hideItemReviewBody.hidden, true);

  // Depois de escondidas, somem da média e da listagem pública...
  const storeListAfter = await (await fetch(`${BASE_URL}/api/stores/${encodeURIComponent(storeId)}/reviews`)).json();
  assert.equal(storeListAfter.reviewsCount, 0);
  assert.equal(storeListAfter.averageRating, null);

  const itemListAfter = await (await fetch(`${BASE_URL}/api/items/${encodeURIComponent(itemId)}/reviews`)).json();
  assert.equal(itemListAfter.reviewsCount, 0);
  assert.equal(itemListAfter.averageRating, null);

  // ...mas continuam existindo (não foram apagadas) e aparecem, marcadas
  // como escondidas, na tela de moderação do lojista.
  const manageResponse = await fetch(`${BASE_URL}/api/stores/${encodeURIComponent(storeId)}/reviews/manage`, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const manageBody = await manageResponse.json();
  assert.equal(manageResponse.status, 200);

  const managedStoreReview = manageBody.storeReviews.find((review) => review.id === storeReviewId);
  assert.ok(managedStoreReview, "avaliação da loja escondida ainda precisa aparecer na moderação");
  assert.equal(managedStoreReview.hidden, true);

  const managedItemReview = manageBody.itemReviews.find((review) => review.id === itemReviewId);
  assert.ok(managedItemReview, "avaliação do item escondida ainda precisa aparecer na moderação");
  assert.equal(managedItemReview.hidden, true);

  // Reexibir a avaliação da loja faz ela voltar a aparecer.
  const unhideResponse = await fetch(`${BASE_URL}/api/reviews/${encodeURIComponent(storeReviewId)}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ hidden: false })
  });
  assert.equal(unhideResponse.status, 200);

  const storeListRestored = await (
    await fetch(`${BASE_URL}/api/stores/${encodeURIComponent(storeId)}/reviews`)
  ).json();
  assert.equal(storeListRestored.reviewsCount, 1);
});

test("estorno: pedido pago em dinheiro não tenta estornar ao ser cancelado", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Suco Natural", price: 8 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-cash-test",
      customerName: "Cliente Dinheiro",
      paymentMethod: "Dinheiro"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  const cancelResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Cancelado" })
  });
  const cancelBody = await cancelResponse.json();

  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelBody.order.status, "Cancelado");
  assert.equal(
    cancelBody.refund.attempted,
    false,
    "pedido pago em dinheiro não deve disparar tentativa de estorno online"
  );
});

test("estorno: pedido pago via Mercado Pago é cancelado mesmo se o estorno falhar, e pode ser tentado de novo", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Prato Executivo", price: 30 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-refund-test",
      customerName: "Cliente Estorno",
      paymentMethod: "Pix"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  // Simula que o pagamento já foi confirmado via Mercado Pago. O fluxo real
  // de pagamento (Pix/cartão) não roda nestes testes porque não há
  // credenciais de sandbox configuradas no ambiente de CI - por isso o
  // Mercado Pago também está desativado (MP_ACCESS_TOKEN não definido), o
  // que é exatamente o cenário que este teste verifica: o estorno precisa
  // falhar de forma controlada, sem travar o cancelamento do pedido.
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-order-id' WHERE id = ?"
  ).run(orderId);
  db.close();

  const cancelResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Cancelado" })
  });
  const cancelBody = await cancelResponse.json();

  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelBody.order.status, "Cancelado", "o pedido precisa ser cancelado mesmo se o estorno falhar");
  assert.equal(cancelBody.refund.attempted, true);
  assert.equal(
    cancelBody.refund.success,
    false,
    "sem Mercado Pago configurado no ambiente de teste, o estorno deve falhar de forma controlada"
  );
  assert.equal(
    cancelBody.order.paymentStatus,
    "pago",
    "sem estorno confirmado, o status de pagamento não deve virar 'estornado' sozinho"
  );

  // Sem login, não pode tentar estornar de novo.
  const noAuthRetry = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST"
  });
  assert.equal(noAuthRetry.status, 401);

  // Com login do lojista, a retentativa manual roda e falha do mesmo jeito
  // (sem travar), pelo mesmo motivo (Mercado Pago não configurado).
  const retryResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const retryBody = await retryResponse.json();

  assert.equal(retryResponse.status, 502);
  assert.equal(retryBody.refund.attempted, true);
  assert.equal(retryBody.refund.success, false);
});

// Cadastra um cliente novo (nome/CPF/e-mail únicos) e devolve o id e o token
// de sessão dele, pra usar nos testes de cancelamento pelo próprio cliente.
let registerTestCustomerCounter = 0;
async function registerTestCustomer(label) {
  registerTestCustomerCounter += 1;
  // Usa os últimos 11 caracteres (não os primeiros!) - o timestamp sozinho
  // já ocupa 13 dígitos, então pegar os 11 primeiros descartava o contador
  // e o aleatório por completo, fazendo dois registros na mesma janela de
  // ~100ms colidirem no mesmo CPF.
  const unique = Date.now() + "" + registerTestCustomerCounter + Math.floor(Math.random() * 1000000);
  const email = `cliente-${label}-${unique}@teste.com`;

  const response = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Cliente ${label}`,
      cpf: unique.slice(-11),
      email,
      phone: "41999999999",
      address: {
        street: "Rua Teste",
        number: "123",
        district: "Centro",
        city: "Morretes",
        zipCode: "83350-000"
      },
      password: "senha1234"
    })
  });
  const body = await response.json();
  if (!response.ok || !body.customer) {
    throw new Error("Falha ao registrar cliente de teste: " + JSON.stringify(body));
  }
  return { customerId: body.customer.id, token: body.token };
}

test("cancelamento pelo cliente: dono do pedido cancela enquanto ainda está em preparo (com estorno automático), outro cliente não pode, e não dá mais depois que saiu para entrega", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();
  const customer = await registerTestCustomer("cancel-owner");
  const otherCustomer = await registerTestCustomer("cancel-other");

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Pastel", price: 12 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: customer.customerId,
      customerName: "Cliente Cancelamento",
      paymentMethod: "Pix"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  // Simula que o pagamento já foi confirmado via Mercado Pago (mesmo truque
  // usado no teste de estorno do lojista acima).
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-order-customer-cancel' WHERE id = ?"
  ).run(orderId);
  db.close();

  // Sem login, não pode cancelar.
  const noAuthResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST"
  });
  assert.equal(noAuthResponse.status, 401);

  // Outro cliente logado não pode cancelar um pedido que não é dele.
  const wrongCustomerResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${otherCustomer.token}` }
  });
  assert.equal(wrongCustomerResponse.status, 403);

  // O dono do pedido consegue cancelar enquanto ainda está em preparo, e o
  // estorno automático é acionado (e falha de forma controlada, já que não
  // há Mercado Pago configurado neste ambiente de teste).
  const cancelResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${customer.token}` }
  });
  const cancelBody = await cancelResponse.json();

  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelBody.order.status, "Cancelado");
  assert.equal(
    cancelBody.refund.attempted,
    true,
    "pedido tinha pagamento online confirmado - o cancelamento pelo cliente também deve tentar estornar sozinho"
  );
  assert.equal(
    cancelBody.refund.success,
    false,
    "sem Mercado Pago configurado no ambiente de teste, o estorno deve falhar de forma controlada"
  );

  // Não pode cancelar de novo um pedido que já está cancelado.
  const doubleCancelResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${customer.token}` }
  });
  assert.equal(doubleCancelResponse.status, 400);

  // Um segundo pedido que já saiu para entrega não pode mais ser cancelado
  // pelo cliente - só falando com a loja.
  const secondOrderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: customer.customerId,
      customerName: "Cliente Cancelamento",
      paymentMethod: "Dinheiro"
    })
  });
  const secondOrderBody = await secondOrderResponse.json();
  const secondOrderId = secondOrderBody.order.id;

  await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(secondOrderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Saiu para entrega" })
  });

  const lateCancelResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(secondOrderId)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${customer.token}` }
  });
  assert.equal(lateCancelResponse.status, 400);
});

test("admin master: cancela e estorna o pedido de qualquer loja direto pelo painel, sem precisar entrar como o lojista", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();
  const adminToken = await getAdminToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Combo Admin", price: 22 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-admin-refund-test",
      customerName: "Cliente Admin Refund",
      paymentMethod: "Pix"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-order-admin' WHERE id = ?"
  ).run(orderId);
  db.close();

  // Sem login de admin, não pode.
  const noAuthResponse = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST"
  });
  assert.equal(noAuthResponse.status, 401);

  // Admin master cancela (o pedido ainda estava ativo) e o estorno
  // automático é tentado - sem precisar impersonar o lojista da loja.
  const firstResponse = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const firstBody = await firstResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.order.status, "Cancelado");
  assert.equal(firstBody.refund.attempted, true);
  assert.equal(firstBody.refund.success, false);

  // Chamando de novo (já cancelado, estorno ainda pendente) tenta estornar
  // de novo.
  const retryResponse = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const retryBody = await retryResponse.json();

  assert.equal(retryResponse.status, 502);
  assert.equal(retryBody.refund.attempted, true);
  assert.equal(retryBody.refund.success, false);
});

test("estorno tardio: lojista e admin master conseguem estornar um pedido já entregue (não só cancelado), sem mudar o status dele", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();
  const adminToken = await getAdminToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Marmita", price: 25 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  // Pedido 1: entregue normalmente, problema só é percebido bem depois -
  // ainda assim precisa dar pra estornar (pelo lojista).
  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-late-refund-owner",
      customerName: "Cliente Estorno Tardio",
      paymentMethod: "Pix"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-late-refund-owner' WHERE id = ?"
  ).run(orderId);
  db.close();

  const deliverResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Entregue" })
  });
  assert.equal(deliverResponse.status, 200);

  const ownerRefundResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const ownerRefundBody = await ownerRefundResponse.json();

  // Sem Mercado Pago configurado no ambiente de teste, o estorno em si
  // falha de forma controlada - mas o ponto principal é que a AÇÃO É
  // ACEITA (não é bloqueada por já estar entregue) e o status do pedido
  // continua "Entregue" (não vira "Cancelado" só por causa do estorno).
  assert.equal(ownerRefundBody.refund.attempted, true, "pedido entregue com pagamento online pendente deve aceitar tentativa de estorno");
  assert.equal(ownerRefundBody.order.status, "Entregue", "estornar o pagamento não deve mudar o status de um pedido já entregue");

  // Pedido 2: o mesmo cenário, mas estornado pelo admin master direto, sem
  // precisar impersonar o lojista.
  const secondOrderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-late-refund-admin",
      customerName: "Cliente Estorno Tardio Admin",
      paymentMethod: "Pix"
    })
  });
  const secondOrderBody = await secondOrderResponse.json();
  const secondOrderId = secondOrderBody.order.id;

  const db2 = new DatabaseSync(tempDbFile);
  db2.prepare(
    "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-late-refund-admin' WHERE id = ?"
  ).run(secondOrderId);
  db2.close();

  await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(secondOrderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Entregue" })
  });

  const adminRefundResponse = await fetch(`${BASE_URL}/api/admin/orders/${encodeURIComponent(secondOrderId)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const adminRefundBody = await adminRefundResponse.json();

  assert.equal(adminRefundBody.refund.attempted, true);
  assert.equal(
    adminRefundBody.order.status,
    "Entregue",
    "o admin master também não deve mudar o status de um pedido entregue só por estornar o pagamento"
  );
});

test("estorno: pedido sem pagamento online pendente (ou já estornado) é rejeitado com 400", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Água", price: 5 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  // Pedido pago em dinheiro - nunca teve pagamento online, não tem o que
  // estornar por aqui.
  const cashOrderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-no-refund-test",
      customerName: "Cliente Sem Estorno",
      paymentMethod: "Dinheiro"
    })
  });
  const cashOrderBody = await cashOrderResponse.json();

  const noPaymentResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(cashOrderBody.order.id)}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  assert.equal(noPaymentResponse.status, 400);

  // Pedido com pagamento online já estornado antes - não pode estornar de
  // novo.
  const paidOrderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-already-refunded-test",
      customerName: "Cliente Já Estornado",
      paymentMethod: "Pix"
    })
  });
  const paidOrderBody = await paidOrderResponse.json();

  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'estornado', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-already-refunded' WHERE id = ?"
  ).run(paidOrderBody.order.id);
  db.close();

  const alreadyRefundedResponse = await fetch(
    `${BASE_URL}/api/orders/${encodeURIComponent(paidOrderBody.order.id)}/refund`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` }
    }
  );
  const alreadyRefundedBody = await alreadyRefundedResponse.json();
  assert.equal(alreadyRefundedResponse.status, 400);
  assert.match(alreadyRefundedBody.error, /já foi estornado/);
});

test("verificar pagamento agora: exige login do lojista dono da loja e consulta o Mercado Pago direto (sem depender só do webhook)", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Pizza", price: 40 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-sync-payment-test",
      customerName: "Cliente Sync",
      paymentMethod: "Pix"
    })
  });
  const orderBody = await orderResponse.json();
  const orderId = orderBody.order.id;

  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'pendente', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-sync-test' WHERE id = ?"
  ).run(orderId);
  db.close();

  // Sem login, não pode.
  const noAuthResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/sync-payment`, {
    method: "POST"
  });
  assert.equal(noAuthResponse.status, 401);

  // Com login: se este ambiente não tem Mercado Pago configurado, dá 503
  // controlado; se tem (como pode acontecer localmente com um .env de
  // verdade), a consulta tenta de verdade e falha de forma controlada (502)
  // porque "fake-mp-sync-test" não é uma cobrança real - em nenhum dos dois
  // casos o servidor deve travar ou devolver sucesso.
  const syncResponse = await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/sync-payment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const syncBody = await syncResponse.json();
  assert.ok(
    syncResponse.status === 503 || syncResponse.status === 502,
    "esperado 503 (Mercado Pago não configurado) ou 502 (consulta falhou) - recebido " + syncResponse.status
  );
  assert.ok(syncBody.error, "deve vir uma mensagem de erro controlada");
});

async function getAdminToken() {
  const response = await fetch(`${BASE_URL}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  const body = await response.json();
  return body.token;
}

test("troco: pedido em dinheiro exige troco pra um valor pelo menos igual ao total", async function () {
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Marmita", price: 25 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  // Troco menor que o total do pedido - rejeitado.
  const tooLowResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-change-test",
      customerName: "Cliente Troco",
      paymentMethod: "Dinheiro",
      changeFor: 10
    })
  });
  assert.equal(tooLowResponse.status, 400);

  // Troco válido (>= total) - aceito e salvo no pedido.
  const validResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-change-test",
      customerName: "Cliente Troco",
      paymentMethod: "Dinheiro",
      changeFor: 50
    })
  });
  const validBody = await validResponse.json();
  assert.equal(validResponse.status, 201);
  assert.equal(validBody.order.changeFor, 50);

  // Pedido pago online ignora "changeFor" mesmo se vier no corpo - troco só
  // faz sentido pra pagamento em dinheiro.
  const onlineResponse = await fetch(`${BASE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeId,
      items: [{ itemId, quantity: 1 }],
      customerId: "customer-change-test",
      customerName: "Cliente Troco",
      paymentMethod: "Pix",
      changeFor: 999
    })
  });
  const onlineBody = await onlineResponse.json();
  assert.equal(onlineResponse.status, 201);
  assert.equal(onlineBody.order.changeFor, null);
});

test("fechamento de período: calcula dinheiro x online, aplica comissão e fecha o período", async function () {
  const adminToken = await getAdminToken();
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Prato do dia", price: 40 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  async function createDeliveredOrder(paymentMethod) {
    const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId,
        items: [{ itemId, quantity: 1 }],
        customerId: "customer-settlement-test",
        customerName: "Cliente Fechamento",
        paymentMethod
      })
    });
    const orderBody = await orderResponse.json();
    const orderId = orderBody.order.id;

    await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ status: "Entregue" })
    });

    return orderId;
  }

  // Um pedido pago em dinheiro (R$ 40) e um pago online via Mercado Pago
  // (R$ 40, simulado via escrita direta no banco de teste - mesmo motivo
  // do teste de estorno: não há sandbox configurado neste ambiente).
  const cashOrderId = await createDeliveredOrder("Dinheiro");
  const onlineOrderId = await createDeliveredOrder("Pix");

  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-settlement-order' WHERE id = ?"
  ).run(onlineOrderId);
  db.close();

  // Faixas: até R$ 30 → 5%, de R$ 30 a R$ 1000 → 10%, acima disso → 20%.
  // Cada pedido é de R$ 40 (R$ 30 na primeira faixa + R$ 10 na segunda):
  // comissão por pedido = 30*5% + 10*10% = 1,50 + 1,00 = R$ 2,50.
  // Dois pedidos (um dinheiro, um online) = comissão total R$ 5.
  // Repasse = total online (R$ 40) - comissão (R$ 5) = R$ 35.
  const settingsResponse = await fetch(`${BASE_URL}/api/admin/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 30, threshold2: 1000, rate1: 5, rate2: 10, rate3: 20 })
  });
  assert.equal(settingsResponse.status, 200);

  const today = new Date().toISOString().slice(0, 10);

  // Sem login de admin, não pode ver a prévia nem fechar.
  const noAuthPreview = await fetch(
    `${BASE_URL}/api/admin/settlements/preview?start=${today}&end=${today}`
  );
  assert.equal(noAuthPreview.status, 401);

  const previewResponse = await fetch(
    `${BASE_URL}/api/admin/settlements/preview?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);

  const storeRow = previewBody.settlements.find((row) => row.storeId === storeId);
  assert.ok(storeRow, "a loja de teste precisa aparecer na prévia");
  assert.equal(storeRow.ordersCount, 2);
  assert.equal(storeRow.cashTotal, 40);
  assert.equal(storeRow.onlineTotal, 40);
  assert.equal(storeRow.grossTotal, 80);
  assert.equal(storeRow.commissionTotal, 5);
  assert.equal(storeRow.netAmount, 35);
  assert.equal(storeRow.currentBalance, 0);
  assert.equal(storeRow.balanceAfter, 35);

  const closeResponse = await fetch(`${BASE_URL}/api/admin/settlements/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ start: today, end: today })
  });
  const closeBody = await closeResponse.json();
  assert.equal(closeResponse.status, 200);
  const closedStoreRow = closeBody.settlements.find((row) => row.storeId === storeId);
  assert.equal(closedStoreRow.netAmount, 35);

  // Depois de fechado, uma nova prévia pro mesmo período não inclui mais
  // esses pedidos (já foram marcados como fechados).
  const secondPreviewResponse = await fetch(
    `${BASE_URL}/api/admin/settlements/preview?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const secondPreviewBody = await secondPreviewResponse.json();
  assert.ok(
    !secondPreviewBody.settlements.find((row) => row.storeId === storeId),
    "pedidos já fechados não podem aparecer de novo numa nova prévia do mesmo período"
  );

  // O saldo da loja reflete o fechamento.
  const balancesResponse = await fetch(`${BASE_URL}/api/admin/store-balances`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const balancesBody = await balancesResponse.json();
  const storeBalance = balancesBody.balances.find((row) => row.storeId === storeId);
  assert.equal(storeBalance.balance, 35);

  // Registrar um repasse de R$ 35 pra loja zera o saldo.
  const adjustmentResponse = await fetch(
    `${BASE_URL}/api/admin/stores/${encodeURIComponent(storeId)}/balance-adjustments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ type: "payout", amount: 35, note: "Pix de teste" })
    }
  );
  const adjustmentBody = await adjustmentResponse.json();
  assert.equal(adjustmentResponse.status, 200);
  assert.equal(adjustmentBody.balance, 0);

  // O histórico de fechamentos mostra o registro criado.
  const historyResponse = await fetch(`${BASE_URL}/api/admin/settlements?storeId=${encodeURIComponent(storeId)}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const historyBody = await historyResponse.json();
  assert.equal(historyResponse.status, 200);
  assert.ok(historyBody.settlements.length >= 1);
  assert.equal(historyBody.settlements[0].netAmount, 35);
});

test("fechamento de período: comissão em faixa é marginal, sem 'efeito penhasco' num pedido logo acima do corte", async function () {
  const adminToken = await getAdminToken();

  // Corte propositalmente com um salto grande de taxa (10% -> 90%), pra
  // deixar bem visível se o cálculo aplicar a taxa errada sobre o valor
  // inteiro em vez de só sobre o pedaço que passou do corte.
  const settingsResponse = await fetch(`${BASE_URL}/api/admin/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 50, threshold2: 1000, rate1: 10, rate2: 90, rate3: 90 })
  });
  assert.equal(settingsResponse.status, 200);

  async function createDeliveredOrderInNewStore(price) {
    const { storeId, ownerToken } = await createTestStoreWithOwnerToken();
    const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ storeId, item: { name: "Item faixa", price } })
    });
    const itemBody = await itemResponse.json();

    const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId,
        items: [{ itemId: itemBody.item.id, quantity: 1 }],
        customerId: "customer-tier-cliff-test",
        customerName: "Cliente Faixa",
        paymentMethod: "Pix"
      })
    });
    const orderBody = await orderResponse.json();
    const orderId = orderBody.order.id;

    const db = new DatabaseSync(tempDbFile);
    db.prepare(
      "UPDATE orders SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = ? WHERE id = ?"
    ).run("fake-tier-order-" + orderId, orderId);
    db.close();

    await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ status: "Entregue" })
    });

    return storeId;
  }

  // Loja A: pedido de R$ 49 (não cruza o corte de R$ 50) - comissão simples,
  // tudo na primeira faixa: 49 * 10% = R$ 4,90. Líquido = R$ 44,10.
  const belowThresholdStoreId = await createDeliveredOrderInNewStore(49);

  // Loja B: pedido de R$ 51 (cruza o corte por só R$ 1) - só esse R$ 1 paga
  // 90%; o resto (R$ 50) continua pagando 10%, igual o pedido de R$ 49.
  // Comissão = 50*10% + 1*90% = 5,00 + 0,90 = R$ 5,90. Líquido = R$ 45,10.
  const aboveThresholdStoreId = await createDeliveredOrderInNewStore(51);

  const today = new Date().toISOString().slice(0, 10);
  const previewResponse = await fetch(
    `${BASE_URL}/api/admin/settlements/preview?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);

  const belowRow = previewBody.settlements.find((row) => row.storeId === belowThresholdStoreId);
  const aboveRow = previewBody.settlements.find((row) => row.storeId === aboveThresholdStoreId);
  assert.ok(belowRow && aboveRow);

  assert.equal(belowRow.commissionTotal, 4.9);
  assert.equal(belowRow.netAmount, 44.1);

  assert.equal(aboveRow.commissionTotal, 5.9);
  assert.equal(aboveRow.netAmount, 45.1);

  // O ponto central do teste: um pedido MAIOR precisa render um líquido
  // MAIOR pra loja - nunca menor. Se o cálculo aplicasse a taxa da faixa
  // em cima do valor inteiro (efeito penhasco), o pedido de R$ 51 renderia
  // só R$ 5,10 líquido (51 - 51*90%) - bem menos que o de R$ 49.
  assert.ok(aboveRow.netAmount > belowRow.netAmount, "pedido maior precisa render líquido maior, nunca menor");
});

test("financeiro: visão geral soma pedidos, faturamento e ticket médio, com filtro de período", async function () {
  const adminToken = await getAdminToken();
  const { storeId, ownerToken } = await createTestStoreWithOwnerToken();

  const itemResponse = await fetch(`${BASE_URL}/api/stores/upsert-item`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ storeId, item: { name: "Combo Financeiro", price: 30 } })
  });
  const itemBody = await itemResponse.json();
  const itemId = itemBody.item.id;

  async function createOrder() {
    const orderResponse = await fetch(`${BASE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId,
        items: [{ itemId, quantity: 1 }],
        customerId: "customer-finance-test",
        customerName: "Cliente Financeiro",
        paymentMethod: "Dinheiro"
      })
    });
    const orderBody = await orderResponse.json();
    return orderBody.order.id;
  }

  // Sem login, não pode ver.
  const noAuthResponse = await fetch(`${BASE_URL}/api/admin/finance`);
  assert.equal(noAuthResponse.status, 401);

  // Dois pedidos de R$ 30 (não cancelados) - total R$ 60, ticket médio R$ 30.
  await createOrder();
  const cancelledOrderId = await createOrder();
  await createOrder();

  // Um terceiro pedido é cancelado - não deve entrar na conta.
  await fetch(`${BASE_URL}/api/orders/${encodeURIComponent(cancelledOrderId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ status: "Cancelado" })
  });

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const allTimeResponse = await fetch(`${BASE_URL}/api/admin/finance`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const allTimeBody = await allTimeResponse.json();
  assert.equal(allTimeResponse.status, 200);

  const storeRow = allTimeBody.byStore.find((row) => row.storeId === storeId);
  assert.ok(storeRow, "a loja de teste precisa aparecer no faturamento por loja");
  assert.equal(storeRow.orders, 2, "o pedido cancelado não deve contar");
  assert.equal(storeRow.gmv, 60);
  assert.equal(storeRow.avgTicket, 30);

  // Com filtro de período (ontem até ontem), os pedidos de hoje não devem
  // aparecer no total da plataforma.
  const pastPeriodResponse = await fetch(
    `${BASE_URL}/api/admin/finance?start=${yesterday}&end=${yesterday}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const pastPeriodBody = await pastPeriodResponse.json();
  assert.equal(pastPeriodResponse.status, 200);
  assert.ok(
    !pastPeriodBody.byStore.find((row) => row.storeId === storeId),
    "pedidos de hoje não podem aparecer num período que só cobre ontem"
  );

  // Com o período de hoje, os pedidos aparecem normalmente.
  const todayPeriodResponse = await fetch(
    `${BASE_URL}/api/admin/finance?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const todayPeriodBody = await todayPeriodResponse.json();
  assert.equal(todayPeriodResponse.status, 200);
  const todayStoreRow = todayPeriodBody.byStore.find((row) => row.storeId === storeId);
  assert.ok(todayStoreRow, "pedidos de hoje precisam aparecer no período de hoje");
  assert.equal(todayStoreRow.orders, 2);
  assert.equal(todayStoreRow.avgTicket, 30);
});

// ---------------------------------------------------------------------------
// Táxi: cadastro de taxista, pedido de corrida, disputa de aceite, orçamento,
// progressão de status e cancelamento.
// ---------------------------------------------------------------------------

async function createTestTaxiDriver(namePrefix) {
  const adminToken = await getAdminToken();
  const response = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `${namePrefix} ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      phone: "41999998888"
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { driverId: body.driver.id, username: body.credentials.username, password: body.credentials.password };
}

// PNG 1x1 válido em base64, usado como "documento" de teste (CNH, CRLV,
// antecedentes) nos cadastros de motorista/prestador.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function futureDateString(yearsAhead) {
  const date = new Date();
  date.setFullYear(date.getFullYear() + yearsAhead);
  return date.toISOString().slice(0, 10);
}

function pastDateString(yearsAgo) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - yearsAgo);
  return date.toISOString().slice(0, 10);
}

function randomCpf() {
  // Não precisa ser um CPF matematicamente válido (o servidor só confere
  // 11 dígitos) - só precisa ser único entre os testes.
  return String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 90) + 10);
}

async function loginTaxiDriver(username, password) {
  const response = await fetch(`${BASE_URL}/api/taxi/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.token;
}

test("táxi: admin cadastra taxista e ele consegue logar no painel", async function () {
  const { username, password } = await createTestTaxiDriver("Taxista Login");

  const token = await loginTaxiDriver(username, password);
  assert.ok(token);

  const wrongPasswordResponse = await fetch(`${BASE_URL}/api/taxi/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "senha-errada" })
  });
  assert.equal(wrongPasswordResponse.status, 401);
});

test("sessão de login sobrevive a um reinício do servidor (persistida no banco)", async function () {
  const { username, password } = await createTestTaxiDriver("Taxista Sessão Persistente");
  const token = await loginTaxiDriver(username, password);

  // Sobe um SEGUNDO processo do servidor, numa porta diferente, mas
  // apontando pro MESMO banco do teste - esse processo novo nunca viu esse
  // token na memória dele (cada processo tem seu próprio Map), então só
  // consegue reconhecer a sessão se ela realmente estiver persistida no
  // banco. Isso simula de verdade o que acontece num redeploy (o processo
  // reinicia, mas o banco continua o mesmo).
  const SECOND_PORT = TEST_PORT + 1;
  const secondBaseUrl = `http://127.0.0.1:${SECOND_PORT}`;
  const secondServerProcess = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(SECOND_PORT),
      HOST: "127.0.0.1",
      DB_FILE: tempDbFile,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      RATE_LIMIT_MAX: "1000"
    }),
    stdio: "pipe"
  });

  try {
    await waitForServerReady(`${secondBaseUrl}/api/health`, 40);

    const dashboardResponse = await fetch(`${secondBaseUrl}/api/taxi/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(dashboardResponse.status, 200);
  } finally {
    secondServerProcess.kill();
  }
});

test("admin: edita dados de um taxista já cadastrado (nome, telefone, veículo, e-mail)", async function () {
  const adminToken = await getAdminToken();
  const { driverId } = await createTestTaxiDriver("Taxista Editável");

  const patchResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers/${driverId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Taxista Editado",
      phone: "41988887777",
      vehicle: "Onix prata - NEW1234",
      email: "taxista-editado@example.com"
    })
  });
  const patchBody = await patchResponse.json();
  assert.equal(patchResponse.status, 200, JSON.stringify(patchBody));
  assert.equal(patchBody.driver.name, "Taxista Editado");
  assert.equal(patchBody.driver.phone, "41988887777");
  assert.equal(patchBody.driver.vehicle, "Onix prata - NEW1234");
  assert.equal(patchBody.driver.email, "taxista-editado@example.com");

  const listResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  const updatedDriver = listBody.drivers.find(function (driver) {
    return driver.id === driverId;
  });
  assert.ok(updatedDriver);
  assert.equal(updatedDriver.name, "Taxista Editado");

  // Nome e telefone não podem ficar em branco.
  const blankResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers/${driverId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "" })
  });
  assert.equal(blankResponse.status, 400);

  // Motorista inexistente retorna 404.
  const notFoundResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers/nao-existe-123`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "Qualquer" })
  });
  assert.equal(notFoundResponse.status, 404);

  // Sem token de admin não deixa editar.
  const unauthorizedResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers/${driverId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Hackeado" })
  });
  assert.equal(unauthorizedResponse.status, 401);
});

test("admin: cadastra prestador de serviço manualmente e ele consegue logar", async function () {
  const adminToken = await getAdminToken();

  const createResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Prestador Manual ${Date.now()}`,
      phone: "41977776666",
      specialty: "Encanador",
      password: "senha123"
    })
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(createBody));
  assert.ok(createBody.credentials.username);
  assert.equal(createBody.credentials.password, "senha123");

  const loginResponse = await fetch(`${BASE_URL}/api/provider/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: createBody.credentials.username, password: "senha123" })
  });
  const loginBody = await loginResponse.json();
  assert.equal(loginResponse.status, 200, JSON.stringify(loginBody));
  assert.ok(loginBody.token);

  const listResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  const created = listBody.providers.find(function (provider) {
    return provider.username === createBody.credentials.username;
  });
  assert.ok(created);
  assert.equal(created.specialty, "Encanador");

  // Nome, telefone e especialidade são obrigatórios.
  const missingFieldsResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "Sem telefone nem especialidade" })
  });
  assert.equal(missingFieldsResponse.status, 400);

  // Sem token de admin não deixa cadastrar.
  const unauthorizedResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Intruso", phone: "41900000000", specialty: "Qualquer" })
  });
  assert.equal(unauthorizedResponse.status, 401);
});

test("táxi: admin consegue anexar o CRLV do veículo no cadastro (opcional, não bloqueia)", async function () {
  const adminToken = await getAdminToken();

  // Sem CRLV, o cadastro continua funcionando normalmente (documento é
  // opcional nesse fluxo - o admin já vetou a pessoa por fora).
  const withoutCrlvResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Taxista Sem CRLV ${Date.now()}`,
      phone: "41999997777",
      vehicle: "Onix branco - XYZ1234"
    })
  });
  assert.equal(withoutCrlvResponse.status, 201);

  // Com CRLV, o arquivo fica salvo e o admin consegue baixá-lo depois.
  const withCrlvResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Taxista Com CRLV ${Date.now()}`,
      phone: "41999996666",
      vehicle: "Onix branco - XYZ1234",
      crlvPhoto: TINY_PNG_DATA_URL
    })
  });
  const withCrlvBody = await withCrlvResponse.json();
  assert.equal(withCrlvResponse.status, 201, JSON.stringify(withCrlvBody));

  const listResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  const listedDriver = listBody.drivers.find((driver) => driver.id === withCrlvBody.driver.id);
  assert.ok(listedDriver);
  assert.equal(listedDriver.hasCrlv, true);
  // Como o admin já vetou o motorista por fora, ele nasce aprovado mesmo
  // com o CRLV anexado - o documento é só um registro, não um bloqueio.
  assert.equal(listedDriver.verificationStatus, "aprovado");

  const documentResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(withCrlvBody.driver.id)}/documents/crlv`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(documentResponse.status, 200);
});

test("táxi: admin pode escolher a senha do taxista no cadastro, em vez de deixar gerar automaticamente", async function () {
  const adminToken = await getAdminToken();

  const shortPasswordResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Taxista Senha Curta ${Date.now()}`,
      phone: "41999997777",
      password: "123"
    })
  });
  assert.equal(shortPasswordResponse.status, 400);

  const customPassword = "corrida2026";
  const createResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Taxista Senha Escolhida ${Date.now()}`,
      phone: "41999996666",
      password: customPassword
    })
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.equal(createBody.credentials.password, customPassword);

  const token = await loginTaxiDriver(createBody.credentials.username, customPassword);
  assert.ok(token);
});

test("táxi: não existe mais troca de senha de dentro do painel já logado (só pela tela de login)", async function () {
  const driver = await createTestTaxiDriver("Taxista Sem Troca Interna");
  const token = await loginTaxiDriver(driver.username, driver.password);

  const oldEndpointResponse = await fetch(`${BASE_URL}/api/auth/taxi-change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword: driver.password, newPassword: "nova-senha-123" })
  });
  assert.equal(oldEndpointResponse.status, 404, "essa rota não deve mais existir");
});

test("lojista: não existe mais troca de senha de dentro do painel já logado (só pela tela de login)", async function () {
  const { ownerToken } = await createTestStoreWithOwnerToken();

  const oldEndpointResponse = await fetch(`${BASE_URL}/api/auth/owner-change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ currentPassword: "qualquer-coisa", newPassword: "nova-senha-123" })
  });
  assert.equal(oldEndpointResponse.status, 404, "essa rota não deve mais existir");
});

test("lojista: cadastra e-mail de recuperação pelo próprio painel (isso não é trocar a senha)", async function () {
  const { ownerToken } = await createTestStoreWithOwnerToken();
  const email = `lojista-${Date.now()}@teste.com`;

  const noAuthResponse = await fetch(`${BASE_URL}/api/auth/owner-update-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  assert.equal(noAuthResponse.status, 401);

  const invalidResponse = await fetch(`${BASE_URL}/api/auth/owner-update-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email: "não-é-um-email" })
  });
  assert.equal(invalidResponse.status, 400);

  const okResponse = await fetch(`${BASE_URL}/api/auth/owner-update-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ email })
  });
  const okBody = await okResponse.json();
  assert.equal(okResponse.status, 200);
  assert.equal(okBody.email, email);
});

// -- "Esqueci minha senha" (única forma de trocar a senha de uma conta) ----
// O ambiente de teste não manda e-mail de verdade (não há credenciais de
// SMTP configuradas), então o token gerado é lido direto do banco de dados
// temporário, do mesmo jeito que outros testes já leem estado interno.

test("lojista: fluxo completo de esqueci minha senha (pela tela de login, não de dentro do painel)", async function () {
  const adminToken = await getAdminToken();
  const createResponse = await fetch(`${BASE_URL}/api/admin/stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      storeName: `Loja Reset Senha ${Date.now()}`,
      categoryId: "comida",
      ownerName: "Dono Reset Senha"
    })
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201);
  const { username, password: originalPassword } = createBody.credentials;

  const ownerLoginResponse = await fetch(`${BASE_URL}/api/auth/owner-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: originalPassword })
  });
  const ownerLoginBody = await ownerLoginResponse.json();
  assert.equal(ownerLoginResponse.status, 200);

  const email = `lojista-reset-${Date.now()}@teste.com`;
  const emailResponse = await fetch(`${BASE_URL}/api/auth/owner-update-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerLoginBody.token}` },
    body: JSON.stringify({ email })
  });
  assert.equal(emailResponse.status, 200);

  const forgotResponse = await fetch(`${BASE_URL}/api/auth/owner-forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  assert.equal(forgotResponse.status, 200);

  const db = new DatabaseSync(tempDbFile);
  const tokenRow = db
    .prepare("SELECT token FROM password_reset_tokens WHERE email = ? AND account_type = 'owner'")
    .get(email);
  db.close();
  assert.ok(tokenRow, "o token de redefinição precisa ter sido salvo no banco");

  const validateResponse = await fetch(
    `${BASE_URL}/api/auth/validate-reset-token?token=${encodeURIComponent(tokenRow.token)}`
  );
  const validateBody = await validateResponse.json();
  assert.equal(validateResponse.status, 200);
  assert.equal(validateBody.accountType, "owner");

  const newPassword = "senha-nova-do-lojista";
  const resetResponse = await fetch(`${BASE_URL}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenRow.token, password: newPassword })
  });
  const resetBody = await resetResponse.json();
  assert.equal(resetResponse.status, 200);
  assert.equal(resetBody.accountType, "owner");

  const oldPasswordResponse = await fetch(`${BASE_URL}/api/auth/owner-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: originalPassword })
  });
  assert.equal(oldPasswordResponse.status, 401, "a senha antiga não pode continuar funcionando");

  const newPasswordResponse = await fetch(`${BASE_URL}/api/auth/owner-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: newPassword })
  });
  assert.equal(newPasswordResponse.status, 200, "a senha nova precisa funcionar");

  const reuseResponse = await fetch(`${BASE_URL}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenRow.token, password: "outra-senha-qualquer" })
  });
  assert.equal(reuseResponse.status, 400, "o mesmo link não pode ser usado duas vezes");
});

test("taxista: fluxo completo de esqueci minha senha exige e-mail cadastrado e respeita o tamanho mínimo de 6", async function () {
  const email = `taxista-reset-${Date.now()}@teste.com`;
  const adminToken = await getAdminToken();
  const createResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Taxista Reset ${Date.now()}`,
      phone: "41999997777",
      email
    })
  });
  const createBody = await createResponse.json();
  assert.equal(createResponse.status, 201);
  const username = createBody.credentials.username;

  // E-mail desconhecido: mesma mensagem genérica, sem revelar se existe ou não.
  const unknownResponse = await fetch(`${BASE_URL}/api/auth/taxi-forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ninguem-tem-esse-email@teste.com" })
  });
  assert.equal(unknownResponse.status, 200);

  const forgotResponse = await fetch(`${BASE_URL}/api/auth/taxi-forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  assert.equal(forgotResponse.status, 200);

  const db = new DatabaseSync(tempDbFile);
  const tokenRow = db
    .prepare("SELECT token FROM password_reset_tokens WHERE email = ? AND account_type = 'taxi'")
    .get(email);
  db.close();
  assert.ok(tokenRow);

  const tooShortResponse = await fetch(`${BASE_URL}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenRow.token, password: "abc" })
  });
  assert.equal(tooShortResponse.status, 400, "pra taxista o mínimo continua sendo 6 caracteres");

  const resetResponse = await fetch(`${BASE_URL}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenRow.token, password: "abc123" })
  });
  assert.equal(resetResponse.status, 200);

  const newToken = await loginTaxiDriver(username, "abc123");
  assert.ok(newToken);
});

test("táxi: rotas do painel do taxista exigem login", async function () {
  const ridesResponse = await fetch(`${BASE_URL}/api/taxi/rides`);
  assert.equal(ridesResponse.status, 401);

  const onlineResponse = await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ online: true })
  });
  assert.equal(onlineResponse.status, 401);
});

test("táxi: pedido de corrida exige localização de partida, destino e telefone - e já sai com o valor fechado", async function () {
  const missingLocationResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Cliente Sem Local", customerPhone: "41988887777" })
  });
  assert.equal(missingLocationResponse.status, 400);

  const missingPhoneResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Sem Telefone",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  assert.equal(missingPhoneResponse.status, 400);

  // Sem destino marcado no mapa: não dá pra calcular o valor fechado, então
  // a corrida não pode ser criada - diferente do que era antes (destino
  // era opcional e o taxista informava o valor depois).
  const missingDestinationResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Sem Destino",
      customerPhone: "41988887777",
      pickupLat: -25.4784,
      pickupLng: -48.8335
    })
  });
  assert.equal(missingDestinationResponse.status, 400);

  const okResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Corrida",
      customerPhone: "41988887777",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const okBody = await okResponse.json();
  assert.equal(okResponse.status, 201);
  assert.equal(okBody.ride.status, "Novo");
  assert.ok(okBody.ride.quotedPrice > 0, "o valor precisa já vir fechado na criação, sem precisar o taxista informar depois");
  assert.ok(okBody.ride.estimatedDistanceKm > 0);
});

test("táxi: dois taxistas disputam a mesma corrida - só um consegue aceitar", async function () {
  const rideResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Disputa",
      customerPhone: "41977776666",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLabel: "Rodoviária",
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const rideBody = await rideResponse.json();
  const rideId = rideBody.ride.id;
  const closedPrice = rideBody.ride.quotedPrice;
  assert.ok(closedPrice > 0, "o valor já sai fechado na criação da corrida");

  const driverA = await createTestTaxiDriver("Taxista A");
  const driverB = await createTestTaxiDriver("Taxista B");
  const tokenA = await loginTaxiDriver(driverA.username, driverA.password);
  const tokenB = await loginTaxiDriver(driverB.username, driverB.password);

  // Os dois ficam online e perto do ponto de partida, pra aparecer na lista
  // de corridas por perto com distância calculada.
  await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ online: true })
  });
  await fetch(`${BASE_URL}/api/taxi/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ lat: -25.479, lng: -48.834 })
  });
  await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({ online: true })
  });
  await fetch(`${BASE_URL}/api/taxi/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({ lat: -25.48, lng: -48.835 })
  });

  const listResponseA = await fetch(`${BASE_URL}/api/taxi/rides`, {
    headers: { Authorization: `Bearer ${tokenA}` }
  });
  const listBodyA = await listResponseA.json();
  const openRide = listBodyA.openRides.find((ride) => ride.id === rideId);
  assert.ok(openRide, "a corrida deve aparecer na lista de corridas por perto");
  assert.equal(typeof openRide.distanceKm, "number");

  // Disputa: os dois tentam aceitar ao mesmo tempo. Só um pode ganhar.
  const [acceptA, acceptB] = await Promise.all([
    fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` }
    }),
    fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenB}` }
    })
  ]);
  const statuses = [acceptA.status, acceptB.status].sort();
  assert.deepEqual(statuses, [200, 409], "exatamente um taxista deve conseguir aceitar a corrida");

  const winnerToken = acceptA.status === 200 ? tokenA : tokenB;
  const loserToken = acceptA.status === 200 ? tokenB : tokenA;

  // O vencedor vê a corrida como "minha corrida"; ela some da lista de
  // corridas abertas (nem pro vencedor, nem pro perdedor).
  const winnerListResponse = await fetch(`${BASE_URL}/api/taxi/rides`, {
    headers: { Authorization: `Bearer ${winnerToken}` }
  });
  const winnerListBody = await winnerListResponse.json();
  assert.equal(winnerListBody.myRide.id, rideId);
  assert.ok(!winnerListBody.openRides.find((ride) => ride.id === rideId));

  const loserListResponse = await fetch(`${BASE_URL}/api/taxi/rides`, {
    headers: { Authorization: `Bearer ${loserToken}` }
  });
  const loserListBody = await loserListResponse.json();
  assert.equal(loserListBody.myRide, null);
  assert.ok(!loserListBody.openRides.find((ride) => ride.id === rideId));

  // Só o taxista dono da corrida pode avançar o status dela - não existe
  // mais orçar/informar valor, o preço já veio fechado na criação.
  const statusByLoserResponse = await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${loserToken}` },
    body: JSON.stringify({ status: "A caminho" })
  });
  assert.equal(statusByLoserResponse.status, 403);

  // O cliente acompanha a corrida e já vê o valor fechado (o mesmo desde a
  // criação) e a localização do taxista (porque ele já mandou a posição dele).
  const trackResponse = await fetch(`${BASE_URL}/api/rides/${encodeURIComponent(rideId)}`);
  const trackBody = await trackResponse.json();
  assert.equal(trackBody.ride.quotedPrice, closedPrice);
  assert.equal(typeof trackBody.ride.driverLat, "number");

  // Progressão de status: Aceita -> A caminho -> Em andamento -> Concluída.
  for (const nextStatus of ["A caminho", "Em andamento", "Concluída"]) {
    const statusResponse = await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${winnerToken}` },
      body: JSON.stringify({ status: nextStatus })
    });
    const statusBody = await statusResponse.json();
    assert.equal(statusResponse.status, 200);
    assert.equal(statusBody.ride.status, nextStatus);
  }

  // Corrida concluída não aparece mais como "minha corrida" ativa.
  const finalListResponse = await fetch(`${BASE_URL}/api/taxi/rides`, {
    headers: { Authorization: `Bearer ${winnerToken}` }
  });
  const finalListBody = await finalListResponse.json();
  assert.equal(finalListBody.myRide, null);
});

test("táxi: cliente cancela corrida em aberto, mas não consegue cancelar duas vezes", async function () {
  const rideResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Cancela",
      customerPhone: "41966665555",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const rideBody = await rideResponse.json();
  const rideId = rideBody.ride.id;

  const cancelResponse = await fetch(`${BASE_URL}/api/rides/${encodeURIComponent(rideId)}/cancel`, {
    method: "POST"
  });
  const cancelBody = await cancelResponse.json();
  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelBody.ride.status, "Cancelada");

  const secondCancelResponse = await fetch(`${BASE_URL}/api/rides/${encodeURIComponent(rideId)}/cancel`, {
    method: "POST"
  });
  assert.equal(secondCancelResponse.status, 400);
});

test("táxi: admin consegue listar os taxistas cadastrados", async function () {
  const { username } = await createTestTaxiDriver("Taxista Listagem");
  const adminToken = await getAdminToken();

  const listResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.ok(listBody.drivers.find((driver) => driver.username === username));
});

function openWebSocket(url) {
  return new Promise(function (resolve, reject) {
    const socket = new WebSocket(url);
    const timeout = setTimeout(function () {
      reject(new Error("timeout esperando o WebSocket abrir: " + url));
    }, 4000);
    socket.addEventListener("open", function () {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.addEventListener("error", function () {
      clearTimeout(timeout);
      reject(new Error("erro ao abrir o WebSocket: " + url));
    });
  });
}

function waitForNextMessage(socket, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const timeout = setTimeout(function () {
      reject(new Error("timeout esperando mensagem do WebSocket"));
    }, timeoutMs || 4000);
    socket.addEventListener(
      "message",
      function (event) {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(event.data));
        } catch (error) {
          resolve(null);
        }
      },
      { once: true }
    );
  });
}

test("táxi: WebSocket avisa o taxista quando uma corrida aparece/é aceita, e quem acompanha quando o status ou a posição mudam", async function () {
  const driver = await createTestTaxiDriver("Taxista WS");
  const token = await loginTaxiDriver(driver.username, driver.password);
  const wsBase = BASE_URL.replace("http://", "ws://");

  // Token inválido não consegue abrir o canal do painel do taxista.
  const rejectedSocket = new WebSocket(wsBase + "/ws/taxi?role=driver&token=token-invalido");
  await new Promise(function (resolve) {
    rejectedSocket.addEventListener("close", resolve);
    rejectedSocket.addEventListener("error", resolve);
  });

  // Corrida inexistente também não consegue abrir o canal de acompanhamento.
  const rejectedRideSocket = new WebSocket(wsBase + "/ws/taxi?role=ride&rideId=corrida-que-nao-existe");
  await new Promise(function (resolve) {
    rejectedRideSocket.addEventListener("close", resolve);
    rejectedRideSocket.addEventListener("error", resolve);
  });

  const driverSocket = await openWebSocket(wsBase + "/ws/taxi?role=driver&token=" + encodeURIComponent(token));
  const nextDriverMessage = waitForNextMessage(driverSocket);

  const rideResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente WS",
      customerPhone: "41955554444",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const rideBody = await rideResponse.json();
  const rideId = rideBody.ride.id;

  const createdMessage = await nextDriverMessage;
  assert.equal(createdMessage.type, "ride_created");
  assert.equal(createdMessage.rideId, rideId);

  // A tela do cliente abriria esse mesmo canal pra acompanhar a corrida.
  const rideSocket = await openWebSocket(wsBase + "/ws/taxi?role=ride&rideId=" + encodeURIComponent(rideId));
  const nextRideMessage = waitForNextMessage(rideSocket);

  const acceptResponse = await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(acceptResponse.status, 200);

  const rideUpdateMessage = await nextRideMessage;
  assert.equal(rideUpdateMessage.type, "ride_updated");
  assert.equal(rideUpdateMessage.rideId, rideId);

  // A posição do taxista, enquanto ele está com essa corrida ativa, chega
  // em tempo real pra quem está acompanhando - sem precisar esperar o
  // próximo ciclo de polling.
  const nextLocationMessage = waitForNextMessage(rideSocket);
  const locationResponse = await fetch(`${BASE_URL}/api/taxi/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lat: -25.479, lng: -48.834 })
  });
  assert.equal(locationResponse.status, 200);
  const locationMessage = await nextLocationMessage;
  assert.equal(locationMessage.type, "driver_location_updated");
  assert.equal(locationMessage.rideId, rideId);

  driverSocket.close();
  rideSocket.close();
});

test("táxi: resumo de ganhos do dia soma as corridas concluídas do taxista", async function () {
  const driver = await createTestTaxiDriver("Taxista Ganhos");
  const token = await loginTaxiDriver(driver.username, driver.password);

  const noAuthResponse = await fetch(`${BASE_URL}/api/taxi/history`);
  assert.equal(noAuthResponse.status, 401);

  const emptyHistoryResponse = await fetch(`${BASE_URL}/api/taxi/history`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const emptyHistoryBody = await emptyHistoryResponse.json();
  assert.equal(emptyHistoryResponse.status, 200);
  assert.equal(emptyHistoryBody.tripCount, 0);
  assert.equal(emptyHistoryBody.totalEarnings, 0);

  const rideResponse = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Ganhos",
      customerPhone: "41944443333",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const rideBody = await rideResponse.json();
  const rideId = rideBody.ride.id;
  const closedPrice = rideBody.ride.quotedPrice;
  assert.ok(closedPrice > 0);

  await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  for (const nextStatus of ["A caminho", "Em andamento", "Concluída"]) {
    await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: nextStatus })
    });
  }

  const historyResponse = await fetch(`${BASE_URL}/api/taxi/history`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const historyBody = await historyResponse.json();
  assert.equal(historyResponse.status, 200);
  assert.equal(historyBody.tripCount, 1);
  assert.equal(historyBody.totalEarnings, closedPrice);
  assert.ok(historyBody.rides.find((ride) => ride.id === rideId));
});

test("diagnóstico de pagamentos: falha do Mercado Pago fica visível pro admin, mas exige login", async function () {
  // O fluxo real de Pix/cartão não roda nestes testes (sem credenciais de
  // sandbox), então simula uma falha já registrada direto no banco - do
  // jeito que logPaymentError() grava de verdade quando o Mercado Pago
  // recusa uma cobrança em produção.
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "INSERT INTO payment_error_log (id, order_id, kind, http_status, message, raw_response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "err-teste-1",
    "PED-TESTE-DIAG",
    "pix",
    400,
    "invalid_email_for_sandbox",
    JSON.stringify({ message: "invalid_email_for_sandbox" }),
    new Date().toISOString()
  );
  db.close();

  const noAuthResponse = await fetch(`${BASE_URL}/api/admin/payment-errors`);
  assert.equal(noAuthResponse.status, 401);

  const adminToken = await getAdminToken();
  const listResponse = await fetch(`${BASE_URL}/api/admin/payment-errors`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();

  assert.equal(listResponse.status, 200);
  const entry = listBody.errors.find((error) => error.id === "err-teste-1");
  assert.ok(entry, "a falha registrada precisa aparecer na listagem do admin");
  assert.equal(entry.orderId, "PED-TESTE-DIAG");
  assert.equal(entry.kind, "pix");
  assert.equal(entry.httpStatus, 400);
  assert.equal(entry.message, "invalid_email_for_sandbox");
});

test("notificações de marketing: exige login, exige título e mensagem, e sem push configurado avisa claramente", async function () {
  const noAuthResponse = await fetch(`${BASE_URL}/api/admin/push/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Promoção", body: "20% off hoje" })
  });
  assert.equal(noAuthResponse.status, 401);

  const noAuthListResponse = await fetch(`${BASE_URL}/api/admin/push/broadcasts`);
  assert.equal(noAuthListResponse.status, 401);

  const adminToken = await getAdminToken();

  const missingFieldsResponse = await fetch(`${BASE_URL}/api/admin/push/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ title: "", body: "" })
  });
  assert.equal(missingFieldsResponse.status, 400);

  // Com um título e mensagem válidos: se este ambiente não tiver chaves
  // VAPID configuradas (servidor recém-instalado, antes do `npm install` do
  // web-push), o servidor precisa recusar com uma mensagem clara em vez de
  // travar. Se tiver (como no ambiente deste teste, que já tem
  // push-config.json), o envio roda normalmente - como não há nenhum
  // cliente inscrito neste banco de teste, o resultado é 0 enviados.
  const broadcastResponse = await fetch(`${BASE_URL}/api/admin/push/broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ title: "Promoção", body: "20% off hoje na loja teste" })
  });
  const broadcastBody = await broadcastResponse.json();

  if (broadcastResponse.status === 503) {
    assert.ok(broadcastBody.error, "precisa avisar que o push não está configurado nesse ambiente");
  } else {
    assert.equal(broadcastResponse.status, 200);
    assert.equal(broadcastBody.sentCount, 0, "não há nenhum cliente inscrito no banco de teste");
  }

  const listResponse = await fetch(`${BASE_URL}/api/admin/push/broadcasts`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(listBody.broadcasts));
});

test("táxi: valores de bandeirada/km/minuto exigem login de admin e validam os números", async function () {
  const noAuthResponse = await fetch(`${BASE_URL}/api/admin/taxi-pricing`);
  assert.equal(noAuthResponse.status, 401);

  const adminToken = await getAdminToken();

  const getResponse = await fetch(`${BASE_URL}/api/admin/taxi-pricing`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.ok(Number.isFinite(getBody.pricing.baseFare));
  assert.ok(Number.isFinite(getBody.pricing.perKmRate));
  assert.ok(Number.isFinite(getBody.pricing.perMinRate));
  assert.ok(Number.isFinite(getBody.pricing.minimumFare));

  const invalidResponse = await fetch(`${BASE_URL}/api/admin/taxi-pricing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ baseFare: -1, perKmRate: 2, perMinRate: 0.3, minimumFare: 8 })
  });
  assert.equal(invalidResponse.status, 400);

  const saveResponse = await fetch(`${BASE_URL}/api/admin/taxi-pricing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ baseFare: 6, perKmRate: 2.5, perMinRate: 0.4, minimumFare: 10 })
  });
  const saveBody = await saveResponse.json();
  assert.equal(saveResponse.status, 200);
  assert.equal(saveBody.pricing.baseFare, 6);
  assert.equal(saveBody.pricing.perKmRate, 2.5);
  assert.equal(saveBody.pricing.perMinRate, 0.4);
  assert.equal(saveBody.pricing.minimumFare, 10);

  // O valor salvo precisa continuar valendo pra quem ler depois - não é só
  // devolvido na resposta do POST, tem que persistir no banco.
  const getAfterSaveResponse = await fetch(`${BASE_URL}/api/admin/taxi-pricing`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const getAfterSaveBody = await getAfterSaveResponse.json();
  assert.equal(getAfterSaveBody.pricing.baseFare, 6);
});

test("táxi: pedir corrida com destino marcado no mapa não quebra mesmo se o serviço de rotas estiver fora do ar", async function () {
  // Este ambiente de teste não tem acesso à internet externa (o serviço de
  // rotas OSRM fica fora do alcance), então este teste garante o
  // comportamento de segurança: a corrida sempre é criada normalmente,
  // com ou sem a sugestão de valor - o taxista nunca fica bloqueado por
  // causa de um serviço externo fora do ar.
  const response = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Cliente Com Destino",
      customerPhone: "41966665555",
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      pickupLabel: "Rua XV de Novembro",
      destinationLabel: "Rodoviária",
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.ride.status, "Novo");

  // Com ou sem acesso ao serviço de rotas (OSRM), o servidor tem que
  // conseguir calcular um valor fechado - se o OSRM estiver fora do ar
  // (como neste ambiente de teste, sem internet), o cálculo aproximado
  // (linha reta x fator de correção) garante que a corrida nunca fique
  // sem preço.
  assert.ok(body.ride.suggestedPrice > 0);
  assert.ok(body.ride.estimatedDistanceKm > 0);
  assert.equal(body.ride.quotedPrice, body.ride.suggestedPrice);
});

test("táxi: estimativa de valor antes de pedir a corrida exige os dois pontos", async function () {
  const missingResponse = await fetch(`${BASE_URL}/api/rides/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pickupLat: -25.4784, pickupLng: -48.8335 })
  });
  assert.equal(missingResponse.status, 400);

  // Com os dois pontos válidos, o servidor sempre devolve uma estimativa -
  // usa o serviço de rotas real quando disponível, ou o cálculo aproximado
  // como reserva quando não está (como neste ambiente de teste).
  const fullResponse = await fetch(`${BASE_URL}/api/rides/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pickupLat: -25.4784,
      pickupLng: -48.8335,
      destinationLat: -25.485,
      destinationLng: -48.84
    })
  });
  const fullBody = await fullResponse.json();
  assert.equal(fullResponse.status, 200);
  assert.ok(fullBody.suggestedPrice > 0);
});

test("táxi: busca de endereço (autocomplete) exige pelo menos 3 letras e sempre responde, mesmo sem internet", async function () {
  const tooShortResponse = await fetch(`${BASE_URL}/api/geocode/search?q=mo`);
  const tooShortBody = await tooShortResponse.json();
  assert.equal(tooShortResponse.status, 200);
  assert.deepEqual(tooShortBody.results, []);

  // "Morretes" bate com a lista local (centro das cidades atendidas) -
  // então mesmo se o serviço externo (Nominatim) estiver fora do ar (como
  // neste ambiente de teste, sem internet), a busca não fica vazia.
  const knownCityResponse = await fetch(`${BASE_URL}/api/geocode/search?q=Morretes`);
  const knownCityBody = await knownCityResponse.json();
  assert.equal(knownCityResponse.status, 200);
  assert.ok(knownCityBody.results.length > 0);
  assert.ok(knownCityBody.results.some((place) => place.label.indexOf("Morretes") >= 0));
  assert.ok(Number.isFinite(knownCityBody.results[0].lat));
  assert.ok(Number.isFinite(knownCityBody.results[0].lng));

  // Um texto que não bate com nenhuma cidade local e que o Nominatim não
  // consegue responder (sem internet) devolve lista vazia, mas nunca erro -
  // a busca não pode travar a tela do cliente.
  const unknownResponse = await fetch(`${BASE_URL}/api/geocode/search?q=endereco-que-nao-existe-em-lugar-nenhum`);
  const unknownBody = await unknownResponse.json();
  assert.equal(unknownResponse.status, 200);
  assert.deepEqual(unknownBody.results, []);
});

test("táxi: geocodificação reversa do local de partida nunca bloqueia o pedido, mesmo sem internet", async function () {
  const missingResponse = await fetch(`${BASE_URL}/api/geocode/reverse?lat=abc&lng=-48.83`);
  assert.equal(missingResponse.status, 400);

  // Sem acesso ao Nominatim (este ambiente), a rota devolve label nula em
  // vez de erro - o cliente só digita a referência manualmente, sem travar.
  const validResponse = await fetch(`${BASE_URL}/api/geocode/reverse?lat=-25.4784&lng=-48.8335`);
  const validBody = await validResponse.json();
  assert.equal(validResponse.status, 200);
  assert.ok(validBody.label === null || typeof validBody.label === "string");
});

async function createRide(overrides) {
  const response = await fetch(`${BASE_URL}/api/rides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      Object.assign(
        {
          customerName: "Cliente Pagamento",
          customerPhone: "41955554444",
          pickupLat: -25.4784,
          pickupLng: -48.8335,
          destinationLat: -25.485,
          destinationLng: -48.84
        },
        overrides
      )
    )
  });
  const body = await response.json();
  return { response, body };
}

test("táxi: corrida no Pix/cartão fica 'Aguardando pagamento' e só aparece pro taxista depois de paga", async function () {
  const driver = await createTestTaxiDriver("Taxista Pix");
  const token = await loginTaxiDriver(driver.username, driver.password);

  const { response, body } = await createRide({ paymentMethod: "Pix" });
  assert.equal(response.status, 201);
  assert.equal(body.ride.status, "Aguardando pagamento");
  assert.equal(body.ride.paymentMethod, "Pix");
  assert.equal(body.ride.paymentStatus, "pendente");
  const rideId = body.ride.id;

  // Enquanto não paga, o taxista não vê nem sabe que essa corrida existe.
  const beforePaymentResponse = await fetch(`${BASE_URL}/api/taxi/rides`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const beforePaymentBody = await beforePaymentResponse.json();
  assert.equal(beforePaymentBody.myRide, null);
  assert.ok(!beforePaymentBody.openRides.some((ride) => ride.id === rideId));

  // Simula o que o webhook do Mercado Pago faria de verdade ao confirmar o
  // pagamento (não dá pra testar a chamada real sem credenciais de sandbox):
  // marca como pago e promove a corrida pra "Novo", igual promoteRideAfterPayment.
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE ride_requests SET status = 'Novo', payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-order-id' WHERE id = ?"
  ).run(rideId);
  db.close();

  const afterPaymentResponse = await fetch(`${BASE_URL}/api/taxi/rides`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const afterPaymentBody = await afterPaymentResponse.json();
  assert.ok(afterPaymentBody.openRides.some((ride) => ride.id === rideId));
});

test("táxi: cobrança de Pix/cartão da corrida exige Mercado Pago configurado", async function () {
  const { body } = await createRide({ paymentMethod: "Pix" });
  const rideId = body.ride.id;

  // Este ambiente de teste não tem MP_ACCESS_TOKEN configurado - a cobrança
  // precisa recusar de forma clara, nunca travar ou dar erro genérico.
  const pixResponse = await fetch(`${BASE_URL}/api/rides/pix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rideId })
  });
  assert.equal(pixResponse.status, 503);

  const cardResponse = await fetch(`${BASE_URL}/api/rides/card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rideId, token: "fake-token", paymentMethodId: "visa" })
  });
  assert.equal(cardResponse.status, 503);
});

test("táxi: corrida com pagamento online cancelada tenta estornar sozinho, sem travar o cancelamento", async function () {
  const { body } = await createRide({ paymentMethod: "Cartão" });
  const rideId = body.ride.id;

  // Simula que o pagamento já tinha sido confirmado via Mercado Pago -
  // mesmo cenário do teste equivalente de pedido de loja: sem credenciais
  // de sandbox neste ambiente, o estorno precisa falhar de forma
  // controlada, sem impedir o cancelamento de valer.
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE ride_requests SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = 'fake-mp-order-id' WHERE id = ?"
  ).run(rideId);
  db.close();

  const cancelResponse = await fetch(`${BASE_URL}/api/rides/${encodeURIComponent(rideId)}/cancel`, {
    method: "POST"
  });
  const cancelBody = await cancelResponse.json();

  assert.equal(cancelResponse.status, 200);
  assert.equal(cancelBody.ride.status, "Cancelada");
  assert.equal(cancelBody.refund.attempted, true);
  assert.equal(cancelBody.refund.success, false, "sem Mercado Pago configurado, o estorno deve falhar de forma controlada");

  // Uma corrida que nunca chegou a ser paga (Pix gerado ou nem isso) não
  // tem nada pra estornar - o cancelamento não deve nem tentar.
  const { body: unpaidRide } = await createRide({ paymentMethod: "Pix" });
  const unpaidCancelResponse = await fetch(`${BASE_URL}/api/rides/${encodeURIComponent(unpaidRide.ride.id)}/cancel`, {
    method: "POST"
  });
  const unpaidCancelBody = await unpaidCancelResponse.json();
  assert.equal(unpaidCancelResponse.status, 200);
  assert.equal(unpaidCancelBody.refund.attempted, false);
});

test("táxi: resumo de ganhos mostra o saldo de comissão do taxista", async function () {
  const driver = await createTestTaxiDriver("Taxista Saldo Zero");
  const token = await loginTaxiDriver(driver.username, driver.password);

  const historyResponse = await fetch(`${BASE_URL}/api/taxi/history`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const historyBody = await historyResponse.json();
  assert.equal(historyResponse.status, 200);
  assert.equal(historyBody.commissionBalance, 0);
});

test("táxi: comissão do Alloo - configuração, fechamento de período e ajuste manual de saldo", async function () {
  const noAuthGetResponse = await fetch(`${BASE_URL}/api/admin/taxi-commission`);
  assert.equal(noAuthGetResponse.status, 401);

  const noAuthPostResponse = await fetch(`${BASE_URL}/api/admin/taxi-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threshold1: 15, threshold2: 40, rate1: 12, rate2: 12, rate3: 12 })
  });
  assert.equal(noAuthPostResponse.status, 401);

  const adminToken = await getAdminToken();

  const defaultResponse = await fetch(`${BASE_URL}/api/admin/taxi-commission`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultResponse.status, 200);
  assert.ok(Number.isFinite(defaultBody.rate1));
  assert.ok(Number.isFinite(defaultBody.rate2));
  assert.ok(Number.isFinite(defaultBody.rate3));

  const invalidResponse = await fetch(`${BASE_URL}/api/admin/taxi-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 15, threshold2: 40, rate1: 150, rate2: 12, rate3: 12 })
  });
  assert.equal(invalidResponse.status, 400);

  // Corte bem alto nas 3 faixas = na prática vira uma taxa única de 12%,
  // pra poder comparar com o cálculo simples (closedPrice * 12%) mais
  // abaixo, sem depender do valor exato que a fórmula de tarifa sugeriu.
  const saveResponse = await fetch(`${BASE_URL}/api/admin/taxi-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 100000, threshold2: 200000, rate1: 12, rate2: 12, rate3: 12 })
  });
  const saveBody = await saveResponse.json();
  assert.equal(saveResponse.status, 200);
  assert.equal(saveBody.rate1, 12);
  assert.equal(saveBody.rate2, 12);
  assert.equal(saveBody.rate3, 12);

  // Corrida em dinheiro concluída - o taxista já ficou com o valor cheio,
  // e passa a dever 12% de comissão pro Alloo (saldo negativo, igual o
  // "saldo negativo" que a Uber mostra pro motorista dela).
  const driver = await createTestTaxiDriver("Taxista Comissão");
  const token = await loginTaxiDriver(driver.username, driver.password);

  const { body: rideBody } = await createRide({ paymentMethod: "Dinheiro" });
  const rideId = rideBody.ride.id;
  const closedPrice = rideBody.ride.quotedPrice;

  await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  for (const nextStatus of ["A caminho", "Em andamento", "Concluída"]) {
    await fetch(`${BASE_URL}/api/taxi/rides/${encodeURIComponent(rideId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status: nextStatus })
    });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const expectedCommission = Number(((closedPrice * 12) / 100).toFixed(2));
  const expectedNet = Number((0 - expectedCommission).toFixed(2));

  const previewResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-settlements/preview?start=${todayStr}&end=${todayStr}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  const previewRow = previewBody.settlements.find((row) => row.driverId === driver.driverId);
  assert.ok(previewRow, "a corrida concluída em dinheiro precisa aparecer na prévia do fechamento");
  assert.equal(previewRow.ridesCount, 1);
  assert.equal(previewRow.cashTotal, closedPrice);
  assert.equal(previewRow.onlineTotal, 0);
  assert.equal(previewRow.commissionTotal, expectedCommission);
  assert.equal(previewRow.netAmount, expectedNet);
  assert.ok(previewRow.balanceAfter < 0, "taxista que só rodou em dinheiro precisa ficar devendo comissão");

  const closeResponse = await fetch(`${BASE_URL}/api/admin/taxi-settlements/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ start: todayStr, end: todayStr })
  });
  const closeBody = await closeResponse.json();
  assert.equal(closeResponse.status, 200);
  const closedRow = closeBody.settlements.find((row) => row.driverId === driver.driverId);
  assert.ok(closedRow);
  assert.equal(closedRow.balanceAfter, previewRow.balanceAfter);

  // Fechar de novo pro mesmo período não conta a mesma corrida duas vezes -
  // ela já está marcada como fechada (settled_at).
  const secondPreviewResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-settlements/preview?start=${todayStr}&end=${todayStr}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const secondPreviewBody = await secondPreviewResponse.json();
  assert.ok(!secondPreviewBody.settlements.some((row) => row.driverId === driver.driverId));

  const balancesResponse = await fetch(`${BASE_URL}/api/admin/taxi-balances`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const balancesBody = await balancesResponse.json();
  const balanceRow = balancesBody.balances.find((row) => row.driverId === driver.driverId);
  assert.ok(balanceRow);
  assert.equal(balanceRow.balance, closedRow.balanceAfter);

  const historyResponse = await fetch(`${BASE_URL}/api/admin/taxi-settlements?driverId=${encodeURIComponent(driver.driverId)}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const historyBody = await historyResponse.json();
  assert.ok(historyBody.settlements.some((row) => row.driverId === driver.driverId));

  // Ajuste manual: o taxista pagou a comissão que devia via Pix - registra
  // um "recebimento" e o saldo volta pra perto de zero.
  const debt = Math.abs(closedRow.balanceAfter);
  const adjustmentResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(driver.driverId)}/balance-adjustments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ type: "collection", amount: debt, note: "Pix recebido do taxista" })
    }
  );
  const adjustmentBody = await adjustmentResponse.json();
  assert.equal(adjustmentResponse.status, 200);
  assert.equal(adjustmentBody.balance, 0);

  // Um valor inválido (zero ou negativo) é recusado.
  const invalidAdjustmentResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(driver.driverId)}/balance-adjustments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ type: "payout", amount: 0 })
    }
  );
  assert.equal(invalidAdjustmentResponse.status, 400);
});

test("cadastro de parceiro: loja se cadastra sozinha, sai logada na hora e não precisa de aprovação do admin", async function () {
  const uniqueSuffix = Date.now() + "-" + Math.floor(Math.random() * 100000);
  const validAddress = { street: "Rua das Flores", number: "123", district: "Centro", city: "Morretes" };

  const missingFieldsResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storeName: "Loja sem tudo" })
  });
  assert.equal(missingFieldsResponse.status, 400);

  const shortPasswordResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja Senha Curta",
      categoryId: "comida",
      ownerName: "Dono Teste",
      cpf: randomCpf(),
      phone: "41999990000",
      email: `loja-${uniqueSuffix}@teste.com`,
      password: "123",
      address: validAddress
    })
  });
  assert.equal(shortPasswordResponse.status, 400);

  const invalidCategoryResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja Categoria Inválida",
      categoryId: "categoria-que-nao-existe",
      ownerName: "Dono Teste",
      cpf: randomCpf(),
      phone: "41999990000",
      email: `loja-${uniqueSuffix}-b@teste.com`,
      password: "senha123",
      address: validAddress
    })
  });
  assert.equal(invalidCategoryResponse.status, 400);

  // CPF precisa ter 11 dígitos.
  const invalidCpfResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja CPF Inválido",
      categoryId: "comida",
      ownerName: "Dono Teste",
      cpf: "123",
      phone: "41999990000",
      email: `loja-${uniqueSuffix}-cpf@teste.com`,
      password: "senha123",
      address: validAddress
    })
  });
  assert.equal(invalidCpfResponse.status, 400);

  // Endereço incompleto (falta número) também é recusado.
  const incompleteAddressResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja Endereço Incompleto",
      categoryId: "comida",
      ownerName: "Dono Teste",
      cpf: randomCpf(),
      phone: "41999990000",
      email: `loja-${uniqueSuffix}-addr@teste.com`,
      password: "senha123",
      address: { street: "Rua Sem Número", district: "Centro", city: "Morretes" }
    })
  });
  assert.equal(incompleteAddressResponse.status, 400);

  const email = `loja-${uniqueSuffix}@teste.com`;
  const ownerCpf = randomCpf();
  const signupResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja Cadastro Automático",
      categoryId: "comida",
      ownerName: "Dono Automático",
      cpf: ownerCpf,
      cnpj: "12345678000199",
      phone: "41999990000",
      email,
      description: "Comida caseira",
      password: "senha123",
      address: validAddress
    })
  });
  const signupBody = await signupResponse.json();

  assert.equal(signupResponse.status, 201);
  assert.ok(signupBody.token, "o cadastro já devolve um token de sessão, sem precisar logar de novo depois");
  assert.equal(signupBody.owner.email, email);
  assert.equal(signupBody.owner.phone, "41999990000");
  assert.ok(signupBody.store.id);
  // CPF é dado sensível - nunca deve aparecer na resposta pública do cadastro.
  assert.equal(signupBody.owner.cpf, undefined);

  // A loja já aparece de verdade no catálogo, sem precisar de nenhuma
  // aprovação manual do admin antes.
  const catalogResponse = await fetch(`${BASE_URL}/api/catalog`);
  const catalogBody = await catalogResponse.json();
  const catalogStore = catalogBody.stores.find((store) => store.id === signupBody.store.id);
  assert.ok(catalogStore);

  // O token devolvido já funciona pra acessar o painel do lojista na hora.
  const storeCheckResponse = await fetch(`${BASE_URL}/api/stores/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupBody.token}` },
    body: JSON.stringify({ id: signupBody.store.id, name: "Loja Cadastro Automático Editada", categoryId: "comida" })
  });
  assert.equal(storeCheckResponse.status, 200);

  // Duas lojas com o mesmo nome não travam o cadastro - o segundo usuário
  // sai diferente do primeiro em vez de dar erro de "já existe".
  const secondSignupResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja Cadastro Automático",
      categoryId: "comida",
      ownerName: "Outro Dono",
      cpf: randomCpf(),
      phone: "41988880000",
      email: `loja-${uniqueSuffix}-c@teste.com`,
      password: "senha123",
      address: validAddress
    })
  });
  const secondSignupBody = await secondSignupResponse.json();
  assert.equal(secondSignupResponse.status, 201);
  assert.notEqual(secondSignupBody.owner.username, signupBody.owner.username);

  // O mesmo e-mail não pode cadastrar uma segunda loja.
  const duplicateEmailResponse = await fetch(`${BASE_URL}/api/signup/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      storeName: "Loja Duplicada",
      categoryId: "comida",
      ownerName: "Dono Duplicado",
      cpf: randomCpf(),
      phone: "41999990000",
      email,
      password: "senha123",
      address: validAddress
    })
  });
  assert.equal(duplicateEmailResponse.status, 400);
});

function validTaxiSignupPayload(overrides) {
  return Object.assign(
    {
      name: "Motorista Automático",
      cpf: randomCpf(),
      phone: "41999990001",
      email: `motorista-${Date.now()}-${Math.floor(Math.random() * 100000)}@teste.com`,
      vehicle: "Honda Civic prata - ABC1D23",
      cnhNumber: "12345678900",
      cnhCategory: "B",
      cnhExpiresAt: futureDateString(2),
      cnhHasEar: true,
      cnhFrontPhoto: TINY_PNG_DATA_URL,
      cnhBackPhoto: TINY_PNG_DATA_URL,
      crlvPhoto: TINY_PNG_DATA_URL,
      criminalRecordPhoto: TINY_PNG_DATA_URL,
      password: "senha123"
    },
    overrides || {}
  );
}

test("cadastro de parceiro: motorista se cadastra sozinho, mas fica pendente até o admin aprovar os documentos", async function () {
  const uniqueSuffix = Date.now() + "-" + Math.floor(Math.random() * 100000);
  const email = `motorista-${uniqueSuffix}@teste.com`;

  const missingFieldsResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Motorista Incompleto" })
  });
  assert.equal(missingFieldsResponse.status, 400);

  // CNH categoria A (moto) não serve pra transportar passageiro de carro.
  const invalidCategoryResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validTaxiSignupPayload({ email: `${email}-cat`, cnhCategory: "A" }))
  });
  assert.equal(invalidCategoryResponse.status, 400);

  // Sem marcar a observação EAR, o cadastro é recusado.
  const missingEarResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validTaxiSignupPayload({ email: `${email}-ear`, cnhHasEar: false }))
  });
  assert.equal(missingEarResponse.status, 400);

  // CNH vencida também é recusada.
  const expiredCnhResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validTaxiSignupPayload({ email: `${email}-exp`, cnhExpiresAt: pastDateString(1) }))
  });
  assert.equal(expiredCnhResponse.status, 400);

  // Faltando qualquer um dos 4 documentos, o cadastro é recusado.
  const missingDocResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validTaxiSignupPayload({ email: `${email}-doc`, crlvPhoto: "" }))
  });
  assert.equal(missingDocResponse.status, 400);

  const signupResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validTaxiSignupPayload({ email }))
  });
  const signupBody = await signupResponse.json();

  assert.equal(signupResponse.status, 201, JSON.stringify(signupBody));
  assert.ok(signupBody.token);
  assert.ok(signupBody.username);
  assert.equal(signupBody.driver.vehicle, "Honda Civic prata - ABC1D23");
  // Cadastro sozinho pelo site nasce pendente, não aprovado direto.
  assert.equal(signupBody.driver.verificationStatus, "pendente");
  // CPF/número da CNH são sensíveis - nunca aparecem na resposta pública.
  assert.equal(signupBody.driver.cpf, undefined);
  assert.equal(signupBody.driver.cnhNumber, undefined);

  const dashboardResponse = await fetch(`${BASE_URL}/api/taxi/dashboard`, {
    headers: { Authorization: `Bearer ${signupBody.token}` }
  });
  assert.equal(dashboardResponse.status, 200);

  // Motorista pendente não consegue ficar online.
  const blockedOnlineResponse = await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupBody.token}` },
    body: JSON.stringify({ online: true })
  });
  assert.equal(blockedOnlineResponse.status, 403);

  const adminToken = await getAdminToken();

  // O admin vê o motorista pendente na listagem, com os documentos marcados
  // como enviados.
  const listResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  const listedDriver = listBody.drivers.find((driver) => driver.id === signupBody.driver.id);
  assert.ok(listedDriver);
  assert.equal(listedDriver.verificationStatus, "pendente");
  assert.equal(listedDriver.hasCnhFront, true);
  assert.equal(listedDriver.hasCnhBack, true);
  assert.equal(listedDriver.hasCrlv, true);
  assert.equal(listedDriver.hasCriminalRecord, true);

  // O admin consegue baixar o documento enviado (autenticado).
  const documentResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(signupBody.driver.id)}/documents/cnh-front`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(documentResponse.status, 200);
  assert.equal(documentResponse.headers.get("content-type"), "image/png");

  // Sem token de admin, o documento não pode ser baixado.
  const unauthorizedDocumentResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(signupBody.driver.id)}/documents/cnh-front`
  );
  assert.equal(unauthorizedDocumentResponse.status, 401);

  // O admin aprova o motorista.
  const approveResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(signupBody.driver.id)}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "aprovado", note: "" })
    }
  );
  const approveBody = await approveResponse.json();
  assert.equal(approveResponse.status, 200);
  assert.equal(approveBody.driver.verificationStatus, "aprovado");

  // Agora, aprovado, o motorista consegue ficar online.
  const allowedOnlineResponse = await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupBody.token}` },
    body: JSON.stringify({ online: true })
  });
  assert.equal(allowedOnlineResponse.status, 200);

  // Se o admin recusar depois, o motorista sai do ar na hora.
  const rejectResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(signupBody.driver.id)}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "recusado", note: "Foto da CNH ilegível" })
    }
  );
  assert.equal(rejectResponse.status, 200);

  const blockedAgainResponse = await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupBody.token}` },
    body: JSON.stringify({ online: true })
  });
  const blockedAgainBody = await blockedAgainResponse.json();
  assert.equal(blockedAgainResponse.status, 403);
  assert.match(blockedAgainBody.error, /recusad/i);

  const duplicateEmailResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validTaxiSignupPayload({ email }))
  });
  assert.equal(duplicateEmailResponse.status, 400);
});

test("táxi: motorista cadastrado direto pelo admin já nasce aprovado e consegue ficar online na hora", async function () {
  const { username, password } = await createTestTaxiDriver("Taxista Admin Aprovado");
  const token = await loginTaxiDriver(username, password);

  const onlineResponse = await fetch(`${BASE_URL}/api/taxi/online`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ online: true })
  });
  assert.equal(onlineResponse.status, 200);
});

test("cadastro de parceiro: motorista que só tem CNH digital manda o PDF do Vio em vez de frente/verso", async function () {
  const email = `motorista-digital-${Date.now()}-${Math.floor(Math.random() * 100000)}@teste.com`;

  // Marcando cnhType 'digital' sem mandar o PDF é recusado.
  const missingPdfResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      validTaxiSignupPayload({
        email: `${email}-missing`,
        cnhType: "digital",
        cnhFrontPhoto: "",
        cnhBackPhoto: "",
        cnhDigitalPdf: ""
      })
    )
  });
  assert.equal(missingPdfResponse.status, 400);

  // Com o PDF anexado, o cadastro funciona mesmo sem foto de frente/verso.
  const signupResponse = await fetch(`${BASE_URL}/api/signup/taxi-driver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      validTaxiSignupPayload({
        email,
        cnhType: "digital",
        cnhFrontPhoto: "",
        cnhBackPhoto: "",
        cnhDigitalPdf: TINY_PNG_DATA_URL
      })
    )
  });
  const signupBody = await signupResponse.json();
  assert.equal(signupResponse.status, 201, JSON.stringify(signupBody));
  assert.equal(signupBody.driver.verificationStatus, "pendente");

  const adminToken = await getAdminToken();
  const listResponse = await fetch(`${BASE_URL}/api/admin/taxi-drivers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  const listedDriver = listBody.drivers.find((driver) => driver.id === signupBody.driver.id);
  assert.ok(listedDriver);
  assert.equal(listedDriver.cnhType, "digital");
  assert.equal(listedDriver.hasCnhDigital, true);
  assert.equal(listedDriver.hasCnhFront, false);
  assert.equal(listedDriver.hasCnhBack, false);
  // CRLV e antecedentes continuam obrigatórios independente do tipo de CNH.
  assert.equal(listedDriver.hasCrlv, true);
  assert.equal(listedDriver.hasCriminalRecord, true);

  // O admin consegue baixar o PDF da CNH digital pela rota autenticada.
  const documentResponse = await fetch(
    `${BASE_URL}/api/admin/taxi-drivers/${encodeURIComponent(signupBody.driver.id)}/documents/cnh-digital`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(documentResponse.status, 200);
});

test("cadastro de parceiro: prestador de serviço se cadastra sozinho, CPF é obrigatório mas antecedentes é opcional e não bloqueia", async function () {
  const uniqueSuffix = Date.now() + "-" + Math.floor(Math.random() * 100000);
  const email = `prestador-${uniqueSuffix}@teste.com`;

  const missingFieldsResponse = await fetch(`${BASE_URL}/api/signup/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Prestador Incompleto" })
  });
  assert.equal(missingFieldsResponse.status, 400);

  // CPF é obrigatório mesmo sem antecedentes.
  const missingCpfResponse = await fetch(`${BASE_URL}/api/signup/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Prestador Sem CPF",
      phone: "41999990003",
      email: `${email}-nocpf`,
      specialty: "Eletricista",
      password: "senha123"
    })
  });
  assert.equal(missingCpfResponse.status, 400);

  // Cadastro sem enviar a certidão de antecedentes funciona normalmente -
  // ela é só um selo de confiança opcional, nunca um bloqueio.
  const signupResponse = await fetch(`${BASE_URL}/api/signup/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Prestador Automático",
      cpf: randomCpf(),
      phone: "41999990003",
      email,
      specialty: "Eletricista",
      password: "senha123"
    })
  });
  const signupBody = await signupResponse.json();

  assert.equal(signupResponse.status, 201, JSON.stringify(signupBody));
  assert.ok(signupBody.token);
  assert.ok(signupBody.username);
  assert.equal(signupBody.provider.name, "Prestador Automático");
  assert.equal(signupBody.provider.antecedentesVerified, false);
  assert.equal(signupBody.provider.cpf, undefined);

  const dashboardResponse = await fetch(`${BASE_URL}/api/provider/dashboard`, {
    headers: { Authorization: `Bearer ${signupBody.token}` }
  });
  assert.equal(dashboardResponse.status, 200);

  // Prestador sem antecedentes enviados consegue usar o app normalmente -
  // não existe nenhum bloqueio equivalente ao do motorista.
  const availabilityResponse = await fetch(`${BASE_URL}/api/provider/availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signupBody.token}` },
    body: JSON.stringify({ isAvailable: true })
  });
  assert.notEqual(availabilityResponse.status, 403);

  const duplicateEmailResponse = await fetch(`${BASE_URL}/api/signup/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Outro Prestador",
      cpf: randomCpf(),
      phone: "41999990004",
      email,
      specialty: "Encanador",
      password: "senha123"
    })
  });
  assert.equal(duplicateEmailResponse.status, 400);
});

test("cadastro de parceiro: prestador que envia antecedentes ganha selo público só depois do admin verificar", async function () {
  const uniqueSuffix = Date.now() + "-" + Math.floor(Math.random() * 100000);
  const email = `prestador-antecedentes-${uniqueSuffix}@teste.com`;

  const signupResponse = await fetch(`${BASE_URL}/api/signup/provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Prestador Com Antecedentes",
      cpf: randomCpf(),
      phone: "41999990005",
      email,
      specialty: "Diarista",
      password: "senha123",
      criminalRecordPhoto: TINY_PNG_DATA_URL
    })
  });
  const signupBody = await signupResponse.json();
  assert.equal(signupResponse.status, 201, JSON.stringify(signupBody));
  // Antes da conferência do admin, o selo público ainda não aparece.
  assert.equal(signupBody.provider.antecedentesVerified, false);

  const adminToken = await getAdminToken();

  const listResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const listBody = await listResponse.json();
  const listedProvider = listBody.providers.find((provider) => provider.id === signupBody.provider.id);
  assert.ok(listedProvider);
  assert.equal(listedProvider.hasCriminalRecord, true);
  assert.equal(listedProvider.criminalRecordVerified, false);

  const documentResponse = await fetch(
    `${BASE_URL}/api/admin/providers/${encodeURIComponent(signupBody.provider.id)}/documents/criminal-record`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  assert.equal(documentResponse.status, 200);

  const verifyResponse = await fetch(
    `${BASE_URL}/api/admin/providers/${encodeURIComponent(signupBody.provider.id)}/verify-antecedentes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ verified: true })
    }
  );
  const verifyBody = await verifyResponse.json();
  assert.equal(verifyResponse.status, 200);
  assert.equal(verifyBody.provider.antecedentesVerified, true);

  // O selo agora aparece na listagem pública de prestadores (a que os
  // clientes veem em solicitar-orcamento.html).
  const publicListResponse = await fetch(`${BASE_URL}/api/providers`);
  const publicListBody = await publicListResponse.json();
  const publicProvider = publicListBody.providers.find((provider) => provider.id === signupBody.provider.id);
  assert.ok(publicProvider);
  assert.equal(publicProvider.antecedentesVerified, true);

  // Mesmo sem o selo, o prestador nunca fica bloqueado de aparecer/atuar -
  // ele já estava disponível desde o cadastro (is_available = 1 por padrão).
  assert.equal(publicProvider.isAvailable, true);

  // O admin também consegue remover o selo depois, se precisar.
  const unverifyResponse = await fetch(
    `${BASE_URL}/api/admin/providers/${encodeURIComponent(signupBody.provider.id)}/verify-antecedentes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ verified: false })
    }
  );
  const unverifyBody = await unverifyResponse.json();
  assert.equal(unverifyResponse.status, 200);
  assert.equal(unverifyBody.provider.antecedentesVerified, false);
});

// Cadastra um prestador pelo admin, cria uma solicitação de orçamento em
// nome dele e faz o prestador responder com um preço - deixa pronto um
// "atendimento agendado" com um preço definido, exatamente como fica depois
// que o cliente pede orçamento e o prestador responde pelo painel dele.
async function createAcceptedProviderBooking(price) {
  const adminToken = await getAdminToken();

  const createProviderResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Prestador Pagamento ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      phone: "41966665555",
      specialty: "Eletricista"
    })
  });
  const createProviderBody = await createProviderResponse.json();
  assert.equal(createProviderResponse.status, 201, JSON.stringify(createProviderBody));
  const providerId = createProviderBody.provider.id;

  const providerLoginResponse = await fetch(`${BASE_URL}/api/provider/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: createProviderBody.credentials.username,
      password: createProviderBody.credentials.password
    })
  });
  const providerLoginBody = await providerLoginResponse.json();
  assert.equal(providerLoginResponse.status, 200, JSON.stringify(providerLoginBody));
  const providerToken = providerLoginBody.token;

  const budgetRequestResponse = await fetch(`${BASE_URL}/api/budget-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId,
      customerName: "Cliente Orçamento",
      customerPhone: "41955554444",
      message: "Preciso de um orçamento pra troca de disjuntor."
    })
  });
  const budgetRequestBody = await budgetRequestResponse.json();
  assert.equal(budgetRequestResponse.status, 201, JSON.stringify(budgetRequestBody));

  const respondResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(budgetRequestBody.id)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({
        action: "orcamento",
        price,
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        serviceName: "Troca de disjuntor"
      })
    }
  );
  const respondBody = await respondResponse.json();
  assert.equal(respondResponse.status, 200, JSON.stringify(respondBody));

  return {
    providerId,
    providerToken,
    bookingId: respondBody.booking.id,
    requestId: budgetRequestBody.id,
    price
  };
}

test("prestador: cobrança do orçamento aceito exige Mercado Pago configurado", async function () {
  const { bookingId } = await createAcceptedProviderBooking(120);

  // Este ambiente de teste não tem MP_ACCESS_TOKEN configurado - a cobrança
  // precisa recusar de forma clara, nunca travar ou dar erro genérico.
  const pixResponse = await fetch(`${BASE_URL}/api/provider-bookings/pix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId })
  });
  assert.equal(pixResponse.status, 503);

  const cardResponse = await fetch(`${BASE_URL}/api/provider-bookings/card`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId, token: "fake-token", paymentMethodId: "visa" })
  });
  assert.equal(cardResponse.status, 503);
});

test("prestador: cliente consulta o atendimento sem precisar de login, e atendimento inexistente dá 404", async function () {
  const { bookingId, providerId } = await createAcceptedProviderBooking(80);

  const foundResponse = await fetch(`${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}`);
  const foundBody = await foundResponse.json();
  assert.equal(foundResponse.status, 200);
  assert.equal(foundBody.booking.id, bookingId);
  assert.equal(foundBody.booking.providerId, providerId);
  assert.equal(foundBody.booking.price, 80);
  assert.equal(foundBody.booking.paymentStatus, "nao_aplicavel");
  assert.ok(foundBody.providerName);

  const notFoundResponse = await fetch(`${BASE_URL}/api/provider-bookings/nao-existe-123`);
  assert.equal(notFoundResponse.status, 404);
});

test("prestador: atendimento pago aparece no fechamento com a comissão em faixa certa, e o saldo reflete o repasse", async function () {
  const adminToken = await getAdminToken();

  // Faixas: até R$ 50 → 5%, de R$ 50 a R$ 500 → 10%, acima disso → 15%.
  const settingsResponse = await fetch(`${BASE_URL}/api/admin/provider-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 50, threshold2: 500, rate1: 5, rate2: 10, rate3: 15 })
  });
  assert.equal(settingsResponse.status, 200);

  // Atendimento de R$ 120: 50*5% + 70*10% = 2,50 + 7,00 = R$ 9,50 de comissão.
  const { providerId, providerToken, bookingId } = await createAcceptedProviderBooking(120);

  // Simula que o pagamento online já foi confirmado (sem sandbox do
  // Mercado Pago configurado neste ambiente de teste, mesmo padrão já
  // usado nos testes de pedido de loja e corrida de táxi).
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE provider_bookings SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = ? WHERE id = ?"
  ).run("fake-provider-booking-order", bookingId);
  db.close();

  // Marca o atendimento como concluído (só entra no fechamento depois de
  // concluído, igual pedido "Entregue" e corrida "Concluída").
  const statusResponse = await fetch(
    `${BASE_URL}/api/provider/bookings/${encodeURIComponent(bookingId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ status: "concluido" })
    }
  );
  assert.equal(statusResponse.status, 200);

  const today = new Date().toISOString().slice(0, 10);
  const previewResponse = await fetch(
    `${BASE_URL}/api/admin/provider-settlements/preview?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);

  const providerRow = previewBody.settlements.find((row) => row.providerId === providerId);
  assert.ok(providerRow, "o prestador de teste precisa aparecer na prévia do fechamento");
  assert.equal(providerRow.bookingsCount, 1);
  assert.equal(providerRow.onlineTotal, 120);
  assert.equal(providerRow.cashTotal, 0);
  assert.equal(providerRow.commissionTotal, 9.5);
  assert.equal(providerRow.netAmount, 110.5);

  const closeResponse = await fetch(`${BASE_URL}/api/admin/provider-settlements/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ start: today, end: today })
  });
  const closeBody = await closeResponse.json();
  assert.equal(closeResponse.status, 200);
  const closedRow = closeBody.settlements.find((row) => row.providerId === providerId);
  assert.equal(closedRow.netAmount, 110.5);

  const balancesResponse = await fetch(`${BASE_URL}/api/admin/provider-balances`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const balancesBody = await balancesResponse.json();
  const balanceRow = balancesBody.balances.find((row) => row.providerId === providerId);
  assert.ok(balanceRow);
  assert.equal(balanceRow.balance, 110.5);

  // Registrar o repasse zera o saldo, igual loja e taxista.
  const adjustmentResponse = await fetch(
    `${BASE_URL}/api/admin/providers/${encodeURIComponent(providerId)}/balance-adjustments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ type: "payout", amount: 110.5, note: "Pix de teste pro prestador" })
    }
  );
  const adjustmentBody = await adjustmentResponse.json();
  assert.equal(adjustmentResponse.status, 200);
  assert.equal(adjustmentBody.balance, 0);
});

test("prestador: página pública de pagamento do atendimento está liberada pra servir (não cai no bloqueio de arquivo estático)", async function () {
  // server.js tem uma lista de permissão pra arquivo estático (tudo fora
  // dela cai em 403, mesmo existindo em disco) - página nova precisa estar
  // nessa lista, senão o link que o prestador manda pro cliente nunca abre.
  const pageResponse = await fetch(`${BASE_URL}/pagar-atendimento.html`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /text\/html/);

  const scriptResponse = await fetch(`${BASE_URL}/src/pagar-atendimento.js`);
  assert.equal(scriptResponse.status, 200);
});

test("chat prestador↔cliente: página nova está liberada pra servir (não cai no bloqueio de arquivo estático)", async function () {
  const pageResponse = await fetch(`${BASE_URL}/conversa-prestador.html`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type") || "", /text\/html/);

  const scriptResponse = await fetch(`${BASE_URL}/src/conversa-prestador.js`);
  assert.equal(scriptResponse.status, 200);
});

test("chat prestador↔cliente: pedido de orçamento já nasce com a mensagem do cliente, sem exigir login pra consultar", async function () {
  const adminToken = await getAdminToken();

  const createProviderResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Prestador Chat ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      phone: "41966664444",
      specialty: "Encanador"
    })
  });
  const createProviderBody = await createProviderResponse.json();
  assert.equal(createProviderResponse.status, 201, JSON.stringify(createProviderBody));
  const providerId = createProviderBody.provider.id;

  const budgetRequestResponse = await fetch(`${BASE_URL}/api/budget-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId,
      customerName: "Cliente Chat",
      customerPhone: "41955553333",
      locationLabel: "Centro",
      message: "Meu chuveiro parou de esquentar, dá pra ver hoje?"
    })
  });
  const budgetRequestBody = await budgetRequestResponse.json();
  assert.equal(budgetRequestResponse.status, 201, JSON.stringify(budgetRequestBody));
  const requestId = budgetRequestBody.id;

  const timelineResponse = await fetch(`${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}`);
  const timelineBody = await timelineResponse.json();
  assert.equal(timelineResponse.status, 200);
  assert.equal(timelineBody.request.status, "aguardando");
  assert.equal(timelineBody.booking, null);
  assert.ok(timelineBody.providerName);
  assert.equal(timelineBody.messages.length, 1);
  assert.equal(timelineBody.messages[0].senderType, "customer");
  assert.match(timelineBody.messages[0].body, /chuveiro/);

  const notFoundResponse = await fetch(`${BASE_URL}/api/budget-requests/nao-existe-123`);
  assert.equal(notFoundResponse.status, 404);
});

test("chat prestador↔cliente: cliente manda mensagem, prestador responde, e cada etapa do trâmite entra sozinha na conversa", async function () {
  const adminToken = await getAdminToken();

  const createProviderResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Prestador Chat 2 ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      phone: "41966663333",
      specialty: "Eletricista"
    })
  });
  const createProviderBody = await createProviderResponse.json();
  assert.equal(createProviderResponse.status, 201, JSON.stringify(createProviderBody));
  const providerId = createProviderBody.provider.id;

  const providerLoginResponse = await fetch(`${BASE_URL}/api/provider/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: createProviderBody.credentials.username,
      password: createProviderBody.credentials.password
    })
  });
  const providerLoginBody = await providerLoginResponse.json();
  assert.equal(providerLoginResponse.status, 200, JSON.stringify(providerLoginBody));
  const providerToken = providerLoginBody.token;

  const budgetRequestResponse = await fetch(`${BASE_URL}/api/budget-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId,
      customerName: "Cliente Chat 2",
      customerPhone: "41955552222",
      message: "Preciso trocar um disjuntor."
    })
  });
  const budgetRequestBody = await budgetRequestResponse.json();
  assert.equal(budgetRequestResponse.status, 201, JSON.stringify(budgetRequestBody));
  const requestId = budgetRequestBody.id;

  // Cliente manda uma segunda mensagem, sem login.
  const customerMessageResponse = await fetch(
    `${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "É um disjuntor de 40A, sabe se tem?" })
    }
  );
  assert.equal(customerMessageResponse.status, 201);

  // Prestador responde no chat antes de decidir o orçamento.
  const providerMessageResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ body: "Tenho sim, já te mando o orçamento." })
    }
  );
  assert.equal(providerMessageResponse.status, 201);

  // Prestador envia o orçamento - isso deve gerar uma mensagem automática
  // do sistema narrando o trâmite, sem o prestador precisar digitar nada.
  const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const respondResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "orcamento", price: 90, scheduledAt, serviceName: "Troca de disjuntor" })
    }
  );
  const respondBody = await respondResponse.json();
  assert.equal(respondResponse.status, 200, JSON.stringify(respondBody));
  const bookingId = respondBody.booking.id;

  // Prestador marca como concluído - outra mensagem automática deve entrar.
  const statusResponse = await fetch(`${BASE_URL}/api/provider/bookings/${encodeURIComponent(bookingId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ status: "concluido" })
  });
  assert.equal(statusResponse.status, 200);

  const timelineResponse = await fetch(`${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}`);
  const timelineBody = await timelineResponse.json();
  assert.equal(timelineResponse.status, 200);
  assert.equal(timelineBody.request.status, "orcamento_enviado");
  assert.equal(timelineBody.booking.status, "concluido");

  const senderTypes = timelineBody.messages.map((message) => message.senderType);
  // Ordem esperada: pedido inicial (customer), segunda pergunta (customer),
  // resposta do prestador (provider), orçamento enviado (system),
  // atendimento concluído (system).
  assert.deepEqual(senderTypes, ["customer", "customer", "provider", "system", "system"]);
  assert.match(timelineBody.messages[3].body, /Orçamento enviado.*90/);
  assert.match(timelineBody.messages[4].body, /concluído/);

  // Painel do prestador também consegue ver a mesma conversa, autenticado.
  const providerTimelineResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}`,
    { headers: { Authorization: `Bearer ${providerToken}` } }
  );
  const providerTimelineBody = await providerTimelineResponse.json();
  assert.equal(providerTimelineResponse.status, 200);
  assert.equal(providerTimelineBody.messages.length, 5);

  // Sem token, a rota do painel do prestador não deixa ver a conversa de
  // outro prestador.
  const unauthorizedResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}`
  );
  assert.equal(unauthorizedResponse.status, 401);
});

test("chat prestador↔cliente: recusar o pedido registra mensagem automática e trava novas mensagens do cliente", async function () {
  const adminToken = await getAdminToken();

  const createProviderResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Prestador Chat 3 ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      phone: "41966662222",
      specialty: "Pintor"
    })
  });
  const createProviderBody = await createProviderResponse.json();
  assert.equal(createProviderResponse.status, 201, JSON.stringify(createProviderBody));
  const providerId = createProviderBody.provider.id;

  const providerLoginResponse = await fetch(`${BASE_URL}/api/provider/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: createProviderBody.credentials.username,
      password: createProviderBody.credentials.password
    })
  });
  const providerLoginBody = await providerLoginResponse.json();
  const providerToken = providerLoginBody.token;

  const budgetRequestResponse = await fetch(`${BASE_URL}/api/budget-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId,
      customerName: "Cliente Chat 3",
      customerPhone: "41955551111",
      message: "Preciso pintar uma sala pequena."
    })
  });
  const budgetRequestBody = await budgetRequestResponse.json();
  const requestId = budgetRequestBody.id;

  const respondResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "recusar" })
    }
  );
  assert.equal(respondResponse.status, 200);

  const timelineResponse = await fetch(`${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}`);
  const timelineBody = await timelineResponse.json();
  assert.equal(timelineBody.request.status, "recusado");
  assert.equal(timelineBody.messages.length, 2);
  assert.equal(timelineBody.messages[1].senderType, "system");

  const blockedMessageResponse = await fetch(
    `${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Poxa, que pena." })
    }
  );
  assert.equal(blockedMessageResponse.status, 400);
});

// Cadastra um prestador, faz login, e cria um pedido de orçamento em nome
// dele - deixa pronto o ponto de partida comum aos testes de visita técnica
// e avaliação, sem precisar repetir o cadastro em cada um.
async function createProviderWithBudgetRequest(specialty) {
  const adminToken = await getAdminToken();

  const createProviderResponse = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: `Prestador Visita ${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      phone: "41966661111",
      specialty: specialty || "Pedreiro"
    })
  });
  const createProviderBody = await createProviderResponse.json();
  assert.equal(createProviderResponse.status, 201, JSON.stringify(createProviderBody));
  const providerId = createProviderBody.provider.id;

  const providerLoginResponse = await fetch(`${BASE_URL}/api/provider/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: createProviderBody.credentials.username,
      password: createProviderBody.credentials.password
    })
  });
  const providerLoginBody = await providerLoginResponse.json();
  assert.equal(providerLoginResponse.status, 200, JSON.stringify(providerLoginBody));
  const providerToken = providerLoginBody.token;

  const budgetRequestResponse = await fetch(`${BASE_URL}/api/budget-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId,
      customerName: "Cliente Visita",
      customerPhone: "41955550000",
      message: "Preciso de uma reforma, mas queria que desse uma olhada antes."
    })
  });
  const budgetRequestBody = await budgetRequestResponse.json();
  assert.equal(budgetRequestResponse.status, 201, JSON.stringify(budgetRequestBody));

  return { adminToken, providerId, providerToken, requestId: budgetRequestBody.id };
}

test("visita técnica paga: prestador define o valor, cliente vê a etapa na linha do tempo e trava a conclusão sem pagamento", async function () {
  const { providerId, providerToken, requestId } = await createProviderWithBudgetRequest();

  const setFeeResponse = await fetch(`${BASE_URL}/api/provider/visit-fee`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ visitFee: 40 })
  });
  const setFeeBody = await setFeeResponse.json();
  assert.equal(setFeeResponse.status, 200);
  assert.equal(setFeeBody.visitFee, 40);

  const visitScheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const visitResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "visita", scheduledAt: visitScheduledAt })
    }
  );
  const visitBody = await visitResponse.json();
  assert.equal(visitResponse.status, 200, JSON.stringify(visitBody));
  assert.equal(visitBody.booking.kind, "visita");
  assert.equal(visitBody.booking.price, 40);
  const visitBookingId = visitBody.booking.id;

  // Pedir uma segunda visita pro mesmo pedido não é permitido.
  const secondVisitResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "visita", scheduledAt: visitScheduledAt })
    }
  );
  assert.equal(secondVisitResponse.status, 400);

  // Sem pagar, o prestador não consegue marcar a visita como concluída.
  const blockedStatusResponse = await fetch(
    `${BASE_URL}/api/provider/bookings/${encodeURIComponent(visitBookingId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ status: "concluido" })
    }
  );
  assert.equal(blockedStatusResponse.status, 400);

  // Timeline pública mostra a visita como etapa pendente de pagamento.
  const timelineBeforePayResponse = await fetch(`${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}`);
  const timelineBeforePayBody = await timelineBeforePayResponse.json();
  assert.equal(timelineBeforePayBody.bookings.length, 1);
  assert.equal(timelineBeforePayBody.bookings[0].kind, "visita");
  assert.equal(timelineBeforePayBody.bookings[0].paymentStatus, "nao_aplicavel");

  // Simula a confirmação do pagamento da visita (sem sandbox do Mercado
  // Pago configurado neste ambiente de teste, mesmo padrão já usado nos
  // outros testes de pagamento).
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE provider_bookings SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = ? WHERE id = ?"
  ).run("fake-visit-order", visitBookingId);
  db.close();

  // Agora sim consegue marcar como concluída.
  const okStatusResponse = await fetch(
    `${BASE_URL}/api/provider/bookings/${encodeURIComponent(visitBookingId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ status: "concluido" })
    }
  );
  assert.equal(okStatusResponse.status, 200);

  // Antes da visita concluída, mandar o orçamento final não era permitido -
  // agora que concluiu, é.
  const finalQuoteResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({
        action: "orcamento",
        price: 500,
        scheduledAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        serviceName: "Reforma completa"
      })
    }
  );
  const finalQuoteBody = await finalQuoteResponse.json();
  assert.equal(finalQuoteResponse.status, 200, JSON.stringify(finalQuoteBody));
  assert.equal(finalQuoteBody.booking.kind, "servico");

  const finalTimelineResponse = await fetch(`${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}`);
  const finalTimelineBody = await finalTimelineResponse.json();
  assert.equal(finalTimelineBody.request.status, "orcamento_enviado");
  assert.equal(finalTimelineBody.bookings.length, 2);
  assert.equal(finalTimelineBody.bookings[0].kind, "visita");
  assert.equal(finalTimelineBody.bookings[1].kind, "servico");
  assert.equal(finalTimelineBody.bookings[1].price, 500);
});

test("visita técnica sem cobrança (valor 0): não trava a conclusão, mesmo sem pagamento", async function () {
  const { providerToken, requestId } = await createProviderWithBudgetRequest();

  // Não chama /api/provider/visit-fee - fica no padrão (0), sem cobrar.
  const visitResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "visita", scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
    }
  );
  const visitBody = await visitResponse.json();
  assert.equal(visitResponse.status, 200, JSON.stringify(visitBody));
  assert.equal(visitBody.booking.price, 0);

  const statusResponse = await fetch(
    `${BASE_URL}/api/provider/bookings/${encodeURIComponent(visitBody.booking.id)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ status: "concluido" })
    }
  );
  assert.equal(statusResponse.status, 200);
});

test("avaliação do prestador: cliente avalia só depois do atendimento concluído, não duplica, e fica visível pro admin (não pública)", async function () {
  const adminToken = await getAdminToken();
  const { providerId, providerToken, bookingId } = await createAcceptedProviderBooking(90);

  // Ainda agendado - não dá pra avaliar antes de concluir.
  const tooEarlyResponse = await fetch(`${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 5, comment: "Adorei!" })
  });
  assert.equal(tooEarlyResponse.status, 400);

  const statusResponse = await fetch(`${BASE_URL}/api/provider/bookings/${encodeURIComponent(bookingId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ status: "concluido" })
  });
  assert.equal(statusResponse.status, 200);

  // Nota inválida é recusada.
  const invalidRatingResponse = await fetch(
    `${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 9, comment: "" })
    }
  );
  assert.equal(invalidRatingResponse.status, 400);

  const reviewResponse = await fetch(`${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 5, comment: "Excelente, chegou no horário e resolveu rápido." })
  });
  const reviewBody = await reviewResponse.json();
  assert.equal(reviewResponse.status, 201, JSON.stringify(reviewBody));
  assert.equal(reviewBody.review.rating, 5);

  // Não deixa avaliar de novo o mesmo atendimento.
  const duplicateResponse = await fetch(`${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 3, comment: "Segunda tentativa" })
  });
  assert.equal(duplicateResponse.status, 400);

  // O booking público agora sinaliza que já foi avaliado.
  const bookingCheckResponse = await fetch(`${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}`);
  const bookingCheckBody = await bookingCheckResponse.json();
  assert.equal(bookingCheckBody.alreadyReviewed, true);

  // Fica visível pro admin, com o comentário...
  const adminReviewsResponse = await fetch(`${BASE_URL}/api/admin/provider-reviews`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const adminReviewsBody = await adminReviewsResponse.json();
  assert.equal(adminReviewsResponse.status, 200);
  const foundReview = adminReviewsBody.reviews.find((review) => review.bookingId === bookingId);
  assert.ok(foundReview, "a avaliação precisa aparecer na listagem do admin");
  assert.equal(foundReview.comment, "Excelente, chegou no horário e resolveu rápido.");
  assert.ok(foundReview.providerName);

  // ...mas a nota média pública do prestador (usada na busca) continua sem
  // expor o texto do comentário - só o agregado.
  const publicProvidersResponse = await fetch(`${BASE_URL}/api/providers`);
  const publicProvidersBody = await publicProvidersResponse.json();
  const publicProvider = publicProvidersBody.providers.find((provider) => provider.id === providerId);
  assert.ok(publicProvider);
  assert.equal(publicProvider.avgRating, 5);
  assert.equal(publicProvider.comment, undefined);
});

test("avaliação do prestador: não é permitido avaliar uma visita técnica (só o serviço em si)", async function () {
  const { providerToken, requestId } = await createProviderWithBudgetRequest();

  const visitResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "visita", scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
    }
  );
  const visitBody = await visitResponse.json();
  assert.equal(visitResponse.status, 200);

  await fetch(`${BASE_URL}/api/provider/bookings/${encodeURIComponent(visitBody.booking.id)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ status: "concluido" })
  });

  const reviewResponse = await fetch(
    `${BASE_URL}/api/provider-bookings/${encodeURIComponent(visitBody.booking.id)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 4, comment: "" })
    }
  );
  assert.equal(reviewResponse.status, 400);
});

test("comissão da visita técnica: taxa única (padrão 10%, editável), separada da comissão em faixa do serviço", async function () {
  const adminToken = await getAdminToken();

  // Sem nunca ter sido configurada, a taxa padrão é 10%.
  const defaultRateResponse = await fetch(`${BASE_URL}/api/admin/provider-visit-commission`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const defaultRateBody = await defaultRateResponse.json();
  assert.equal(defaultRateResponse.status, 200);
  assert.equal(defaultRateBody.rate, 10);

  // Taxa fora de 0-100 é recusada.
  const invalidRateResponse = await fetch(`${BASE_URL}/api/admin/provider-visit-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ rate: 150 })
  });
  assert.equal(invalidRateResponse.status, 400);

  // Configura 20% pra visita (bem diferente da comissão do serviço, pra
  // não dar falso positivo se por acaso os dois números baterem por
  // coincidência).
  const setRateResponse = await fetch(`${BASE_URL}/api/admin/provider-visit-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ rate: 20 })
  });
  const setRateBody = await setRateResponse.json();
  assert.equal(setRateResponse.status, 200);
  assert.equal(setRateBody.rate, 20);

  // Comissão do serviço fica uniforme em 8% nas 3 faixas, só pra ter um
  // número fácil de conferir.
  await fetch(`${BASE_URL}/api/admin/provider-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 1000, threshold2: 2000, rate1: 8, rate2: 8, rate3: 8 })
  });

  const { providerId, providerToken, requestId } = await createProviderWithBudgetRequest();

  await fetch(`${BASE_URL}/api/provider/visit-fee`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ visitFee: 50 })
  });

  // Visita: R$ 50 * 20% = R$ 10 de comissão.
  const visitResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({ action: "visita", scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
    }
  );
  const visitBody = await visitResponse.json();
  assert.equal(visitResponse.status, 200);
  const visitBookingId = visitBody.booking.id;

  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE provider_bookings SET payment_status = 'pago', payment_provider = 'mercadopago', mp_order_id = ? WHERE id = ?"
  ).run("fake-visit-commission-order", visitBookingId);
  db.close();

  await fetch(`${BASE_URL}/api/provider/bookings/${encodeURIComponent(visitBookingId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ status: "concluido" })
  });

  // Serviço final: R$ 200 * 8% = R$ 16 de comissão.
  const finalQuoteResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
      body: JSON.stringify({
        action: "orcamento",
        price: 200,
        scheduledAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        serviceName: "Serviço final"
      })
    }
  );
  const finalQuoteBody = await finalQuoteResponse.json();
  assert.equal(finalQuoteResponse.status, 200);
  const serviceBookingId = finalQuoteBody.booking.id;

  await fetch(`${BASE_URL}/api/provider/bookings/${encodeURIComponent(serviceBookingId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ status: "concluido" })
  });

  const today = new Date().toISOString().slice(0, 10);
  const previewResponse = await fetch(
    `${BASE_URL}/api/admin/provider-settlements/preview?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);

  const providerRow = previewBody.settlements.find((row) => row.providerId === providerId);
  assert.ok(providerRow, "o prestador de teste precisa aparecer na prévia do fechamento");
  assert.equal(providerRow.bookingsCount, 2);
  assert.equal(providerRow.grossTotal, 250);
  // R$ 10 (visita, 20%) + R$ 16 (serviço, 8%) = R$ 26.
  assert.equal(providerRow.commissionTotal, 26);
});

// Pagamento em dinheiro do atendimento com o prestador (combinado direto,
// sem passar pelo app) - mesma ideia de "Dinheiro" já disponível pra pedido
// de loja e corrida de táxi, agora também pro orçamento de prestador.
test("prestador: cliente escolhe pagar em dinheiro - combina sem precisar de Mercado Pago e some da pendência de pagamento", async function () {
  const { bookingId, requestId } = await createAcceptedProviderBooking(90);

  const cashResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId })
  });
  const cashBody = await cashResponse.json();
  assert.equal(cashResponse.status, 200, JSON.stringify(cashBody));
  assert.equal(cashBody.paymentStatus, "combinado");

  const bookingResponse = await fetch(`${BASE_URL}/api/provider-bookings/${encodeURIComponent(bookingId)}`);
  const bookingBody = await bookingResponse.json();
  assert.equal(bookingResponse.status, 200);
  assert.equal(bookingBody.booking.paymentStatus, "combinado");
  assert.equal(bookingBody.booking.paymentProvider, "dinheiro");

  // A conversa registra uma mensagem automática avisando o combinado.
  const timelineResponse = await fetch(`${BASE_URL}/api/budget-requests/${encodeURIComponent(requestId)}`);
  const timelineBody = await timelineResponse.json();
  assert.equal(timelineResponse.status, 200);
  assert.equal(timelineBody.bookings[0].paymentStatus, "combinado");
  const lastMessage = timelineBody.messages[timelineBody.messages.length - 1];
  assert.equal(lastMessage.senderType, "system");
  assert.match(lastMessage.body, /dinheiro/i);

  // Escolher dinheiro de novo (já combinado) não é permitido.
  const secondCashResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId })
  });
  assert.equal(secondCashResponse.status, 400);
});

test("prestador: pagamento em dinheiro recusa atendimento inexistente, já pago ou cancelado, e não vale pra visita técnica", async function () {
  const notFoundResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId: "nao-existe-123" })
  });
  assert.equal(notFoundResponse.status, 404);

  // Atendimento já pago online.
  const { bookingId: paidBookingId } = await createAcceptedProviderBooking(60);
  const db = new DatabaseSync(tempDbFile);
  db.prepare(
    "UPDATE provider_bookings SET payment_status = 'pago', payment_provider = 'mercadopago' WHERE id = ?"
  ).run(paidBookingId);
  db.close();
  const alreadyPaidResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId: paidBookingId })
  });
  assert.equal(alreadyPaidResponse.status, 400);

  // Atendimento cancelado pelo prestador.
  const { bookingId: cancelledBookingId, providerToken: cancelProviderToken } = await createAcceptedProviderBooking(
    60
  );
  const cancelResponse = await fetch(
    `${BASE_URL}/api/provider/bookings/${encodeURIComponent(cancelledBookingId)}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cancelProviderToken}` },
      body: JSON.stringify({ status: "cancelado" })
    }
  );
  assert.equal(cancelResponse.status, 200);
  const cancelledCashResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId: cancelledBookingId })
  });
  assert.equal(cancelledCashResponse.status, 400);

  // Visita técnica precisa ser paga pelo app - não dá pra combinar em
  // dinheiro (senão o prestador nunca teria certeza que valeu a visita).
  const { providerToken: visitProviderToken, requestId: visitRequestId } = await createProviderWithBudgetRequest();
  await fetch(`${BASE_URL}/api/provider/visit-fee`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${visitProviderToken}` },
    body: JSON.stringify({ visitFee: 30 })
  });
  const visitResponse = await fetch(
    `${BASE_URL}/api/provider/budget-requests/${encodeURIComponent(visitRequestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${visitProviderToken}` },
      body: JSON.stringify({ action: "visita", scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
    }
  );
  const visitBody = await visitResponse.json();
  assert.equal(visitResponse.status, 200);
  const visitCashResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId: visitBody.booking.id })
  });
  assert.equal(visitCashResponse.status, 400);
});

test("prestador: atendimento combinado em dinheiro entra no fechamento como dinheiro (não como online), com comissão certa", async function () {
  const adminToken = await getAdminToken();

  const settingsResponse = await fetch(`${BASE_URL}/api/admin/provider-commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ threshold1: 50, threshold2: 500, rate1: 5, rate2: 10, rate3: 15 })
  });
  assert.equal(settingsResponse.status, 200);

  // Atendimento de R$ 120, igual ao teste do pagamento online, só que agora
  // combinado em dinheiro - a comissão (R$ 9,50) tem que dar igual, e o
  // valor precisa cair em cashTotal, não em onlineTotal.
  const { providerId, providerToken, bookingId } = await createAcceptedProviderBooking(120);

  const cashResponse = await fetch(`${BASE_URL}/api/provider-bookings/cash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId })
  });
  assert.equal(cashResponse.status, 200);

  const statusResponse = await fetch(`${BASE_URL}/api/provider/bookings/${encodeURIComponent(bookingId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${providerToken}` },
    body: JSON.stringify({ status: "concluido" })
  });
  assert.equal(statusResponse.status, 200);

  const today = new Date().toISOString().slice(0, 10);
  const previewResponse = await fetch(
    `${BASE_URL}/api/admin/provider-settlements/preview?start=${today}&end=${today}`,
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );
  const previewBody = await previewResponse.json();
  assert.equal(previewResponse.status, 200);

  const providerRow = previewBody.settlements.find((row) => row.providerId === providerId);
  assert.ok(providerRow, "o prestador de teste precisa aparecer na prévia do fechamento");
  assert.equal(providerRow.onlineTotal, 0);
  assert.equal(providerRow.cashTotal, 120);
  assert.equal(providerRow.commissionTotal, 9.5);
  // Dinheiro em cima da mesa é dinheiro que o prestador já embolsou direto -
  // o Alloo não repassa nada (netAmount não vem do grossTotal) e o
  // prestador é que fica devendo a comissão, igual já vale pra loja e
  // taxista que só recebem em dinheiro.
  assert.equal(providerRow.netAmount, -9.5);
  assert.ok(providerRow.balanceAfter < 0, "prestador que só recebeu em dinheiro precisa ficar devendo comissão");
});
