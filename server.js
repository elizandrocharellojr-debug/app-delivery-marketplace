const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
let DatabaseSync;

try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  console.error(
    "Este servidor precisa do módulo nativo node:sqlite, disponível a partir do Node.js 22.5.\n" +
      "Verifique sua versão com 'node -v' e atualize o Node.js em https://nodejs.org caso necessário."
  );
  process.exit(1);
}

// Notificações push são opcionais: se o pacote "web-push" ainda não foi
// instalado (falta rodar "npm install"), o servidor continua funcionando
// normalmente, só sem esse recurso até a instalação ser feita.
let webpush = null;
try {
  webpush = require("web-push");
} catch (error) {
  webpush = null;
}

const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "192.168.3.13";
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
// DB_FILE pode ser sobrescrito por variável de ambiente (usado pelos testes
// automatizados em test/, para não mexer no banco de dados real).
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "app.db");
const OWNER_SEED_FILE = path.join(DATA_DIR, "owner-seed.json");
const GOOGLE_CONFIG_FILE = path.join(ROOT, "google-config.json");
const PUSH_CONFIG_FILE = path.join(ROOT, "push-config.json");
const SEED_FILE = path.join(ROOT, "src", "data", "seed.js");
// UPLOADS_DIR pode ser sobrescrito por variável de ambiente, para apontar
// pra um disco persistente (ex.: Railway Volume) em hospedagens onde o
// sistema de arquivos padrão é apagado a cada novo deploy.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT, "assets", "items");

// Documentos pessoais (CNH, CRLV, certidão de antecedentes) NUNCA ficam
// numa pasta servida como arquivo estático público (diferente de
// assets/items, que é público de propósito pra mostrar fotos de produto).
// Só saem daqui através de uma rota autenticada de admin que lê o arquivo
// e devolve o conteúdo (ver handleGetPartnerDocument).
const PARTNER_DOCS_DIR = process.env.PARTNER_DOCS_DIR || path.join(ROOT, "data", "partner-documents");

// Pastas que podem ser servidas como arquivo estático. Qualquer coisa fora
// disso (em especial "data/", que guarda senha, CPF e pedidos) é bloqueada.
const PUBLIC_STATIC_DIRS = ["assets", "src"];
const PUBLIC_STATIC_FILES = new Set([
  "index.html",
  "home.html",
  "admin.html",
  "admin-order.html",
  "admin-pedidos.html",
  "cart.html",
  "category.html",
  "favorites.html",
  "forgot-password.html",
  "item.html",
  "orders.html",
  "owner-login.html",
  "partner-interest.html",
  "profile.html",
  "reset-password.html",
  "store.html",
  "styles.css",
  "favicon.ico",
  "manifest.json",
  "manifest-lojista.json",
  "service-worker.js",
  "super-admin.html",
  "provider.html",
  "solicitar-orcamento.html",
  "manifest-prestador.json",
  "buscar.html",
  "enderecos.html",
  "ajuda.html",
  "cupons.html",
  "meus-dados.html",
  "taxi.html",
  "pedir-corrida.html",
  "pagar-atendimento.html",
  "conversa-prestador.html"
]);

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias
const RATE_LIMIT_WINDOW_MS = 1000 * 60 * 5;
// Configurável por variável de ambiente só pra permitir que a suíte de
// testes automatizados (que faz bem mais de 20 chamadas a rotas sensíveis
// num teste só) rode sem esbarrar no limite pensado pra uso real.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 20;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_UPLOAD_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};
// Documentos (CNH, CRLV, certidão) aceitam também PDF, já que a certidão de
// antecedentes criminais normalmente sai em PDF direto do site do governo.
const ALLOWED_DOCUMENT_TYPES = Object.assign({}, ALLOWED_UPLOAD_TYPES, {
  "application/pdf": "pdf"
});

// A suíte automatizada (test/api.test.js) define SKIP_DOTENV pra garantir
// que o servidor de teste nunca carregue o .env real do projeto - sem essa
// trava, um .env com credenciais reais (Mercado Pago, Google, VAPID) faria
// os testes que pressupõem "nada configurado" bater de verdade em serviços
// externos de produção, em vez de testar o caminho de degradação graciosa.
if (!process.env.SKIP_DOTENV) {
  loadEnvFile(path.join(ROOT, ".env"));
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

// Sessões em memória. Reiniciar o servidor derruba as sessões ativas
// (dono/cliente precisam logar de novo) - aceitável para este app local.
const ownerSessions = new Map();
const customerSessions = new Map();
const adminSessions = new Map();
const providerSessions = new Map();
const taxiSessions = new Map();
const rateLimitBuckets = new Map();
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 horas - sessão de admin expira mais rápido

// Conexões WebSocket abertas por loja, para avisar o painel do lojista na
// hora quando chega um pedido novo ou o status de um pedido muda.
const storeSockets = new Map(); // storeId -> Set<net.Socket>

// Conexões WebSocket dos taxistas (painel) e de quem está acompanhando uma
// corrida (cliente). taxiDashboardSockets é um canal único: qualquer taxista
// conectado recebe o aviso quando uma corrida nova aparece, é aceita ou muda
// de status - o painel então busca a lista atualizada. rideSockets é por
// corrida - usado pra levar a posição do taxista (que muda a cada poucos
// segundos) só pra quem está acompanhando aquela corrida específica, sem
// avisar todo mundo a cada movimento de GPS.
const taxiDashboardSockets = new Set(); // Set<net.Socket>
const rideSockets = new Map(); // rideId -> Set<net.Socket>

// -------------------------------------------------------------------------
// Utilitários básicos
// -------------------------------------------------------------------------

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// -------------------------------------------------------------------------
// Banco de dados (SQLite, via node:sqlite - não precisa instalar nada)
// -------------------------------------------------------------------------

let db;

function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const dbDir = path.dirname(DB_FILE);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cpf TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      address_json TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      to_address TEXT,
      subject TEXT,
      html TEXT,
      text TEXT,
      created_at TEXT NOT NULL,
      provider TEXT
    );

    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      owner_name TEXT,
      store_name TEXT,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Configurações simples da plataforma (ex.: percentual de comissão),
    -- editáveis pelo super-admin sem precisar redeploy.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Um registro por loja a cada vez que uma quinzena (ou qualquer período
    -- escolhido) é fechada. Guarda o retrato daquele fechamento - não muda
    -- depois, mesmo que a comissão padrão mude no futuro.
    CREATE TABLE IF NOT EXISTS store_settlements (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      orders_count INTEGER NOT NULL DEFAULT 0,
      cash_total REAL NOT NULL DEFAULT 0,
      online_total REAL NOT NULL DEFAULT 0,
      gross_total REAL NOT NULL DEFAULT 0,
      commission_percent REAL NOT NULL DEFAULT 0,
      commission_total REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      balance_after REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_store_settlements_store ON store_settlements(store_id);

    -- Ajuste manual de saldo (ex.: "paguei R$200 no Pix pro dono da loja"),
    -- pra zerar/corrigir o saldo acumulado sem precisar fechar um período.
    CREATE TABLE IF NOT EXISTS store_balance_adjustments (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      balance_after REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_store_balance_adjustments_store ON store_balance_adjustments(store_id);

    -- Mesma ideia do fechamento de lojas (store_settlements), só que pra
    -- comissão de taxista: um registro por taxista a cada vez que um
    -- período é fechado, com a foto de quanto ele rodou (dinheiro x
    -- pago no app) e quanto deve de comissão pro Alloo naquele período.
    CREATE TABLE IF NOT EXISTS taxi_settlements (
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      rides_count INTEGER NOT NULL DEFAULT 0,
      cash_total REAL NOT NULL DEFAULT 0,
      online_total REAL NOT NULL DEFAULT 0,
      gross_total REAL NOT NULL DEFAULT 0,
      commission_percent REAL NOT NULL DEFAULT 0,
      commission_total REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      balance_after REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_taxi_settlements_driver ON taxi_settlements(driver_id);

    -- Ajuste manual de saldo do taxista (ex.: "o taxista me pagou R$40 de
    -- comissão no Pix"), pra zerar/corrigir o saldo sem precisar fechar um
    -- período inteiro.
    CREATE TABLE IF NOT EXISTS taxi_balance_adjustments (
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      balance_after REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_taxi_balance_adjustments_driver ON taxi_balance_adjustments(driver_id);

    -- Mesma ideia do fechamento de lojas/taxistas, pro prestador de serviço:
    -- um registro por prestador a cada vez que um período é fechado.
    CREATE TABLE IF NOT EXISTS provider_settlements (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      bookings_count INTEGER NOT NULL DEFAULT 0,
      cash_total REAL NOT NULL DEFAULT 0,
      online_total REAL NOT NULL DEFAULT 0,
      gross_total REAL NOT NULL DEFAULT 0,
      commission_percent REAL NOT NULL DEFAULT 0,
      commission_total REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      balance_after REAL NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_settlements_provider ON provider_settlements(provider_id);

    -- Ajuste manual de saldo do prestador (ex.: "o prestador me pagou a
    -- comissão que devia no Pix"), pra zerar/corrigir o saldo sem precisar
    -- fechar um período inteiro.
    CREATE TABLE IF NOT EXISTS provider_balance_adjustments (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      balance_after REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_balance_adjustments_provider ON provider_balance_adjustments(provider_id);

    -- Guarda a resposta bruta de qualquer falha do Mercado Pago (Pix, cartão,
    -- estorno, consulta de status via webhook). Existe porque o painel de
    -- logs do Railway às vezes não mostra a saída do servidor depois da
    -- inicialização - com isso, o motivo real de uma falha de pagamento
    -- fica visível direto no super-admin, sem depender do Railway.
    CREATE TABLE IF NOT EXISTS payment_error_log (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      kind TEXT NOT NULL,
      http_status INTEGER,
      message TEXT,
      raw_response TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_error_log_created ON payment_error_log(created_at);

    CREATE TABLE IF NOT EXISTS marketing_push_log (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      url TEXT,
      recipients_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      admin_username TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_marketing_push_log_created ON marketing_push_log(created_at);

    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      category_id TEXT,
      name TEXT,
      icon TEXT,
      logo_url TEXT,
      cover_label TEXT,
      description TEXT,
      rating REAL,
      delivery_time TEXT,
      delivery_fee TEXT,
      delivery_fees_by_district_json TEXT,
      min_order REAL,
      opening_hours TEXT,
      opening_hours_by_day_json TEXT,
      is_active INTEGER,
      price_range TEXT,
      tags_json TEXT
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      name TEXT,
      price REAL,
      promo_price REAL,
      section TEXT,
      description TEXT,
      available INTEGER,
      photo_url TEXT,
      sort_order INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_items_store ON items(store_id);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      status_history_json TEXT NOT NULL,
      prep_estimate TEXT,
      payment_method TEXT,
      notes TEXT,
      customer_id TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      store_id TEXT NOT NULL,
      store_name TEXT,
      store_icon TEXT,
      items_json TEXT NOT NULL,
      subtotal REAL,
      delivery_fee REAL,
      total REAL,
      district TEXT,
      address TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE,
      store_id TEXT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_store ON reviews(store_id);

    -- Avaliação de um item específico dentro de um pedido (ex.: "a peça veste
    -- pequeno"), separada da avaliação geral da loja. Só quem comprou o item
    -- (pedido já entregue) pode avaliar, uma vez por item por pedido.
    CREATE TABLE IF NOT EXISTS item_reviews (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT,
      store_id TEXT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(order_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_item_reviews_item ON item_reviews(item_id);

    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT NOT NULL,
      store_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value REAL NOT NULL,
      min_order REAL NOT NULL DEFAULT 0,
      max_uses INTEGER,
      uses_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      PRIMARY KEY (code, store_id)
    );
    CREATE INDEX IF NOT EXISTS idx_coupons_store ON coupons(store_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_customer ON push_subscriptions(customer_id);

    CREATE TABLE IF NOT EXISTS partner_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'estabelecimento',
      status TEXT NOT NULL DEFAULT 'pendente',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_partner_leads_status ON partner_leads(status);

    -- Ícones da tela inicial (Home) do cliente. parent_id vazio = ícone
    -- principal (aparece direto na Home); parent_id preenchido = ícone
    -- que só aparece dentro do grupo pai, quando ele é expandido (ex: os
    -- ícones de Lanches/Pizza/Marmita dentro de "Comida"). kind = "group"
    -- expande em vez de navegar; kind = "link" leva pra category.html.
    CREATE TABLE IF NOT EXISTS home_chips (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      label TEXT NOT NULL,
      icon TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'link',
      category_id TEXT,
      sub_category TEXT,
      search_term TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_home_chips_parent ON home_chips(parent_id);

    CREATE TABLE IF NOT EXISTS service_providers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      specialty TEXT,
      phone TEXT,
      is_available INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_services (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_services_provider ON provider_services(provider_id);

    CREATE TABLE IF NOT EXISTS budget_requests (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      location_label TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'aguardando',
      quoted_price REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_budget_requests_provider ON budget_requests(provider_id);
    CREATE INDEX IF NOT EXISTS idx_budget_requests_status ON budget_requests(status);

    -- Chat entre cliente e prestador, dentro da mesma solicitação de
    -- orçamento. "sender_type" pode ser 'customer', 'provider' ou 'system'
    -- (mensagem automática marcando o trâmite: orçamento enviado, recusado,
    -- atendimento concluído etc.) - assim o cliente e o prestador veem tudo
    -- narrado numa única conversa, sem precisar sair procurando o status em
    -- outro lugar.
    CREATE TABLE IF NOT EXISTS provider_messages (
      id TEXT PRIMARY KEY,
      budget_request_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_messages_request ON provider_messages(budget_request_id);

    CREATE TABLE IF NOT EXISTS provider_bookings (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      budget_request_id TEXT,
      customer_name TEXT NOT NULL,
      service_name TEXT,
      location_label TEXT,
      scheduled_at TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'agendado',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_bookings_provider ON provider_bookings(provider_id);
    CREATE INDEX IF NOT EXISTS idx_provider_bookings_scheduled ON provider_bookings(scheduled_at);

    CREATE TABLE IF NOT EXISTS provider_reviews (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      booking_id TEXT,
      customer_name TEXT,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_reviews_provider ON provider_reviews(provider_id);

    -- Taxistas: conta própria (separada de service_providers porque precisa
    -- de localização em tempo real, que os outros prestadores não usam).
    CREATE TABLE IF NOT EXISTS taxi_drivers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      vehicle TEXT,
      is_online INTEGER NOT NULL DEFAULT 0,
      lat REAL,
      lng REAL,
      location_updated_at TEXT,
      created_at TEXT NOT NULL
    );

    -- Pedido de corrida. Preço é "sob consulta" (o taxista informa depois de
    -- aceitar, igual já acontece com orçamento de serviço) - não calculamos
    -- tarifa automática por distância/rota.
    CREATE TABLE IF NOT EXISTS ride_requests (
      id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      pickup_label TEXT,
      pickup_lat REAL NOT NULL,
      pickup_lng REAL NOT NULL,
      destination_label TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'Novo',
      status_history_json TEXT NOT NULL,
      driver_id TEXT,
      driver_name TEXT,
      quoted_price REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON ride_requests(status);
    CREATE INDEX IF NOT EXISTS idx_ride_requests_driver ON ride_requests(driver_id);

    -- Sessões de login persistidas no banco, além de ficarem em memória (Map)
    -- pra leitura rápida. Sem isso, todo redeploy derrubava todo mundo
    -- logado (lojista, cliente, taxista, prestador, admin) - o processo do
    -- Railway reinicia a cada publicação, e um Map em memória não sobrevive
    -- a isso. Guardar aqui também deixa a sessão voltar sozinha na próxima
    -- requisição depois de um redeploy, sem precisar logar de novo.
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);

  ensureOrderColumns();
  ensureCustomerColumns();
  ensureStoreColumns();
  ensureReviewColumns();
  ensureRideRequestColumns();
  ensurePasswordRecoveryColumns();
  ensurePartnerVerificationColumns();
  ensureProviderBookingColumns();
  seedCatalogIfNeeded();
  seedOwnerAccountsIfNeeded();
  seedAdminIfNeeded();
  seedProviderIfNeeded();
  fixAccentedDemoText();
  seedHomeChipsIfNeeded();
  restoreSessionsFromDb();
}

// Cria os ícones padrão da Home (Comida com sub-ícones, Lojas, Mercados,
// Farmácias) só na primeira vez, quando a tabela está vazia - depois disso
// tudo é editável pelo painel admin, então não mexemos mais aqui.
function seedHomeChipsIfNeeded() {
  const count = db.prepare("SELECT COUNT(*) AS total FROM home_chips").get().total;
  if (count > 0) {
    return;
  }

  const now = new Date().toISOString();
  const insertChip = db.prepare(`
    INSERT INTO home_chips (
      id, parent_id, label, icon, kind, category_id, sub_category, search_term, sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const defaults = [
    { id: "comida", parentId: null, label: "Comida", icon: "fa-utensils", kind: "group", categoryId: "comida", subCategory: "", searchTerm: "", sortOrder: 0 },
    { id: "lojas", parentId: null, label: "Lojas", icon: "fa-bag-shopping", kind: "link", categoryId: "lojas", subCategory: "", searchTerm: "", sortOrder: 1 },
    { id: "mercados", parentId: null, label: "Mercados", icon: "fa-cart-shopping", kind: "link", categoryId: "mercados-farmacias", subCategory: "mercado", searchTerm: "", sortOrder: 2 },
    { id: "farmacias", parentId: null, label: "Farmácias", icon: "fa-briefcase-medical", kind: "link", categoryId: "mercados-farmacias", subCategory: "farmacia", searchTerm: "", sortOrder: 3 },
    { id: "lanches", parentId: "comida", label: "Lanches", icon: "fa-burger", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Lanches", sortOrder: 0 },
    { id: "pizza", parentId: "comida", label: "Pizza", icon: "fa-pizza-slice", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Pizza", sortOrder: 1 },
    { id: "marmita", parentId: "comida", label: "Marmita", icon: "fa-bowl-food", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Marmita", sortOrder: 2 },
    { id: "doces", parentId: "comida", label: "Doces", icon: "fa-cake-candles", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Doces", sortOrder: 3 },
    { id: "bebidas", parentId: "comida", label: "Bebidas", icon: "fa-mug-saucer", kind: "link", categoryId: "comida", subCategory: "", searchTerm: "Bebidas", sortOrder: 4 }
  ];

  defaults.forEach(function (chip) {
    insertChip.run(
      chip.id,
      chip.parentId,
      chip.label,
      chip.icon,
      chip.kind,
      chip.categoryId,
      chip.subCategory,
      chip.searchTerm,
      chip.sortOrder,
      now
    );
  });
}

function rowToHomeChip(row) {
  return {
    id: row.id,
    parentId: row.parent_id || "",
    label: row.label,
    icon: row.icon,
    kind: row.kind,
    categoryId: row.category_id || "",
    subCategory: row.sub_category || "",
    searchTerm: row.search_term || "",
    sortOrder: row.sort_order
  };
}

function getHomeChips() {
  return db
    .prepare("SELECT * FROM home_chips ORDER BY parent_id IS NOT NULL, sort_order, label")
    .all()
    .map(rowToHomeChip);
}

async function handleGetHomeChips(req, res) {
  sendJson(res, 200, { chips: getHomeChips() });
}

function nextHomeChipSortOrder(parentId) {
  const row = db
    .prepare("SELECT MAX(sort_order) AS maxOrder FROM home_chips WHERE parent_id IS ?")
    .get(parentId || null);
  return (row && typeof row.maxOrder === "number" ? row.maxOrder : -1) + 1;
}

function slugify(value) {
  return sanitizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function handleAdminCreateHomeChip(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const label = sanitizeText(payload.label);
  const icon = sanitizeText(payload.icon);
  const parentId = sanitizeText(payload.parentId) || null;
  const kind = parentId ? "link" : payload.kind === "group" ? "group" : "link";
  let categoryId = sanitizeText(payload.categoryId);
  const subCategory = sanitizeText(payload.subCategory);
  const searchTerm = sanitizeText(payload.searchTerm);

  if (!label || !icon) {
    sendJson(res, 400, { error: "Preencha o nome e o ícone." });
    return;
  }

  if (parentId) {
    const parentChip = db.prepare("SELECT * FROM home_chips WHERE id = ?").get(parentId);
    if (!parentChip || parentChip.kind !== "group") {
      sendJson(res, 400, { error: "Escolha um grupo válido em \"Onde aparece\"." });
      return;
    }
    // Sub-ícones sem categoria própria herdam a categoria do grupo pai
    // (ex: todos os filhos de "Comida" caem na categoria "comida").
    if (!categoryId) {
      categoryId = parentChip.category_id;
    }
  }

  if (kind === "link" && !categoryId) {
    sendJson(res, 400, { error: "Escolha a categoria pra onde esse ícone leva." });
    return;
  }

  let id = slugify(label) || "icone-" + Date.now();
  if (db.prepare("SELECT 1 FROM home_chips WHERE id = ?").get(id)) {
    id = id + "-" + Date.now();
  }

  db.prepare(`
    INSERT INTO home_chips (
      id, parent_id, label, icon, kind, category_id, sub_category, search_term, sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parentId,
    label,
    icon,
    kind,
    categoryId,
    subCategory,
    searchTerm,
    nextHomeChipSortOrder(parentId),
    new Date().toISOString()
  );

  sendJson(res, 201, { chips: getHomeChips() });
}

async function handleAdminUpdateHomeChip(req, res, chipId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const existing = db.prepare("SELECT * FROM home_chips WHERE id = ?").get(chipId);
  if (!existing) {
    sendJson(res, 404, { error: "Ícone não encontrado." });
    return;
  }

  const payload = await readRequestBody(req);
  const label = sanitizeText(payload.label) || existing.label;
  const icon = sanitizeText(payload.icon) || existing.icon;
  const parentId = payload.parentId !== undefined ? sanitizeText(payload.parentId) || null : existing.parent_id;
  const kind = parentId ? "link" : payload.kind === "group" ? "group" : payload.kind === "link" ? "link" : existing.kind;
  const categoryId = payload.categoryId !== undefined ? sanitizeText(payload.categoryId) : existing.category_id;
  const subCategory = payload.subCategory !== undefined ? sanitizeText(payload.subCategory) : existing.sub_category;
  const searchTerm = payload.searchTerm !== undefined ? sanitizeText(payload.searchTerm) : existing.search_term;

  if (parentId === chipId) {
    sendJson(res, 400, { error: "Um ícone não pode ser grupo dele mesmo." });
    return;
  }

  if (parentId) {
    const parentChip = db.prepare("SELECT * FROM home_chips WHERE id = ?").get(parentId);
    if (!parentChip || parentChip.kind !== "group") {
      sendJson(res, 400, { error: "Escolha um grupo válido em \"Onde aparece\"." });
      return;
    }
  }

  // Se esse ícone virou um grupo, os filhos dele (se um dia existirem)
  // precisam continuar existindo - só bloqueamos um grupo com filhos de
  // virar sub-ícone de outro grupo, pra não perder esses filhos "soltos".
  if (parentId && existing.kind === "group") {
    const childCount = db.prepare("SELECT COUNT(*) AS total FROM home_chips WHERE parent_id = ?").get(chipId).total;
    if (childCount > 0) {
      sendJson(res, 400, { error: "Esse ícone tem sub-ícones dentro dele. Mova ou exclua os sub-ícones antes de torná-lo um sub-ícone de outro grupo." });
      return;
    }
  }

  if (kind === "link" && !categoryId) {
    sendJson(res, 400, { error: "Escolha a categoria pra onde esse ícone leva." });
    return;
  }

  db.prepare(`
    UPDATE home_chips SET label = ?, icon = ?, parent_id = ?, kind = ?, category_id = ?, sub_category = ?, search_term = ?
    WHERE id = ?
  `).run(label, icon, parentId, kind, categoryId, subCategory, searchTerm, chipId);

  sendJson(res, 200, { chips: getHomeChips() });
}

async function handleAdminDeleteHomeChip(req, res, chipId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const existing = db.prepare("SELECT * FROM home_chips WHERE id = ?").get(chipId);
  if (!existing) {
    sendJson(res, 404, { error: "Ícone não encontrado." });
    return;
  }

  // Apaga junto os ícones filhos, se for um grupo (senão eles ficariam
  // orfãos, sem como aparecer em lugar nenhum da Home).
  db.prepare("DELETE FROM home_chips WHERE parent_id = ?").run(chipId);
  db.prepare("DELETE FROM home_chips WHERE id = ?").run(chipId);

  sendJson(res, 200, { chips: getHomeChips() });
}

// Sincroniza o texto das lojas de demonstração com src/data/seed.js.
// seedCatalogIfNeeded/seedOwnerAccountsIfNeeded só inserem esses dados uma
// vez, quando o banco está vazio - então um banco que já tinha sido
// semeado antes de alguma correção de acentuação em src/data/seed.js fica
// com o texto antigo parado no banco pra sempre, mesmo depois de arrumar o
// arquivo fonte. Esta função roda a cada início do servidor e substitui, só
// para as lojas de demonstração (a lista fixa de IDs abaixo - nunca uma
// loja real cadastrada depois), qualquer nome/descrição/tag/item que
// esteja diferente do que está em seed.js hoje. Assim, uma correção de
// texto no seed.js sempre "gruda" no banco no próximo restart, sem precisar
// apagar o banco inteiro.
function fixAccentedDemoText() {
  const seed = loadSeedData();
  const demoStoreIds = {};
  seed.stores.forEach(function (store) {
    demoStoreIds[store.id] = true;
  });

  const updateStoreText = db.prepare(
    "UPDATE stores SET name = ?, cover_label = ?, description = ?, tags_json = ? WHERE id = ?"
  );
  const getStoreText = db.prepare(
    "SELECT name, cover_label, description, tags_json FROM stores WHERE id = ?"
  );
  const updateOwnerNames = db.prepare(
    "UPDATE owners SET store_name = ?, owner_name = ? WHERE store_id = ?"
  );
  const getOwnerNames = db.prepare(
    "SELECT store_name, owner_name FROM owners WHERE store_id = ?"
  );
  const updateItemText = db.prepare(
    "UPDATE items SET name = ?, section = ? WHERE id = ? AND store_id = ?"
  );
  const getItemText = db.prepare(
    "SELECT name, section FROM items WHERE id = ? AND store_id = ?"
  );

  seed.stores.forEach(function (store) {
    const current = getStoreText.get(store.id);
    if (!current) {
      return;
    }

    const newTagsJson = JSON.stringify(store.tags || []);
    if (
      current.name !== store.name ||
      current.cover_label !== store.coverLabel ||
      current.description !== store.description ||
      current.tags_json !== newTagsJson
    ) {
      updateStoreText.run(store.name, store.coverLabel, store.description, newTagsJson, store.id);
    }

    (store.items || []).forEach(function (item) {
      const currentItem = getItemText.get(item.id, store.id);
      if (!currentItem) {
        return;
      }
      if (currentItem.name !== item.name || currentItem.section !== item.section) {
        updateItemText.run(item.name, item.section, item.id, store.id);
      }
    });
  });

  seed.owners.forEach(function (owner) {
    if (!demoStoreIds[owner.storeId]) {
      return;
    }
    const current = getOwnerNames.get(owner.storeId);
    if (!current) {
      return;
    }
    if (current.store_name !== owner.storeName || current.owner_name !== owner.ownerName) {
      updateOwnerNames.run(owner.storeName, owner.ownerName, owner.storeId);
    }
  });
}

// Adiciona a coluna que liga uma conta de cliente a um login do Google,
// sem mexer em nada que já existia (cpf, endereço e senha continuam
// funcionando normalmente para quem não usa o Google).
// Adiciona a coluna que permite ao lojista (ou ao admin, entrando como a
// loja) esconder uma avaliação abusiva ou falsa - a avaliação continua
// existindo no banco (nada é apagado), só some da média e da listagem
// pública. Some das duas tabelas de avaliação (loja e item), já que as duas
// seguem o mesmo modelo.
function ensureReviewColumns() {
  const reviewColumns = db.prepare("PRAGMA table_info(reviews)").all().map(function (column) {
    return column.name;
  });
  if (reviewColumns.indexOf("hidden") < 0) {
    db.exec("ALTER TABLE reviews ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }

  const itemReviewColumns = db.prepare("PRAGMA table_info(item_reviews)").all().map(function (column) {
    return column.name;
  });
  if (itemReviewColumns.indexOf("hidden") < 0) {
    db.exec("ALTER TABLE item_reviews ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
}

// Coordenadas do destino (pra calcular a rota real e sugerir o valor da
// corrida, do jeito que a Uber faz) + o resultado desse cálculo, guardado
// junto com a corrida pra não precisar recalcular toda hora.
function ensureRideRequestColumns() {
  const columns = db.prepare("PRAGMA table_info(ride_requests)").all().map(function (column) {
    return column.name;
  });

  if (columns.indexOf("destination_lat") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN destination_lat REAL");
  }
  if (columns.indexOf("destination_lng") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN destination_lng REAL");
  }
  if (columns.indexOf("estimated_distance_km") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN estimated_distance_km REAL");
  }
  if (columns.indexOf("estimated_duration_min") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN estimated_duration_min REAL");
  }
  if (columns.indexOf("suggested_price") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN suggested_price REAL");
  }
  // Pagamento da corrida (dinheiro, Pix ou cartão) - mesma ideia dos pedidos
  // das lojas: pagamento online (Pix/cartão) vai pra conta do Mercado Pago
  // da plataforma, dinheiro fica com o taxista na hora. "settled_at" marca
  // quando a corrida entrou num fechamento de comissão do taxista (pra não
  // contar duas vezes).
  if (columns.indexOf("payment_method") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'Dinheiro'");
  }
  if (columns.indexOf("payment_status") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'nao_aplicavel'");
  }
  if (columns.indexOf("payment_provider") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN payment_provider TEXT");
  }
  if (columns.indexOf("payment_detail") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN payment_detail TEXT");
  }
  if (columns.indexOf("mp_order_id") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN mp_order_id TEXT");
  }
  if (columns.indexOf("pix_qr_code") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN pix_qr_code TEXT");
  }
  if (columns.indexOf("pix_qr_code_base64") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN pix_qr_code_base64 TEXT");
  }
  if (columns.indexOf("pix_ticket_url") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN pix_ticket_url TEXT");
  }
  if (columns.indexOf("settled_at") < 0) {
    db.exec("ALTER TABLE ride_requests ADD COLUMN settled_at TEXT");
  }

  const taxiDriverColumns = db.prepare("PRAGMA table_info(taxi_drivers)").all().map(function (column) {
    return column.name;
  });
  // Saldo entre o taxista e a plataforma - igual ao "saldo negativo" da
  // Uber: toda corrida concluída soma a comissão devida aqui; quando o
  // taxista paga (fechamento de período ou ajuste manual), o saldo abaixa.
  if (taxiDriverColumns.indexOf("balance") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN balance REAL NOT NULL DEFAULT 0");
  }
}

// Pagamento do orçamento aceito (dinheiro, Pix ou cartão) - mesma ideia da
// corrida e do pedido de loja: pagamento online cai na conta do Mercado
// Pago da plataforma, dinheiro fica com o prestador na hora. "settled_at"
// marca quando o atendimento entrou num fechamento de comissão (pra não
// contar duas vezes).
function ensureProviderBookingColumns() {
  const columns = db.prepare("PRAGMA table_info(provider_bookings)").all().map(function (column) {
    return column.name;
  });

  if (columns.indexOf("payment_status") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'nao_aplicavel'");
  }
  if (columns.indexOf("payment_provider") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN payment_provider TEXT");
  }
  if (columns.indexOf("payment_detail") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN payment_detail TEXT");
  }
  if (columns.indexOf("mp_order_id") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN mp_order_id TEXT");
  }
  if (columns.indexOf("pix_qr_code") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN pix_qr_code TEXT");
  }
  if (columns.indexOf("pix_qr_code_base64") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN pix_qr_code_base64 TEXT");
  }
  if (columns.indexOf("pix_ticket_url") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN pix_ticket_url TEXT");
  }
  if (columns.indexOf("settled_at") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN settled_at TEXT");
  }
  // "kind" distingue a visita técnica paga (opcional, antes do orçamento
  // final) do atendimento do serviço em si - as duas usam a mesma tabela e
  // toda a infra de pagamento (Pix/cartão/webhook/fechamento) já pronta,
  // só muda o rótulo e a trava de conclusão sem pagamento.
  if (columns.indexOf("kind") < 0) {
    db.exec("ALTER TABLE provider_bookings ADD COLUMN kind TEXT NOT NULL DEFAULT 'servico'");
  }

  const providerColumns = db.prepare("PRAGMA table_info(service_providers)").all().map(function (column) {
    return column.name;
  });
  // Saldo entre o prestador e a plataforma - mesmo modelo da loja e do
  // taxista: atendimento concluído soma a comissão devida aqui; quando o
  // prestador paga (fechamento de período ou ajuste manual), o saldo abaixa.
  if (providerColumns.indexOf("balance") < 0) {
    db.exec("ALTER TABLE service_providers ADD COLUMN balance REAL NOT NULL DEFAULT 0");
  }
  // Valor fixo que o prestador cobra pra ir até o local avaliar o serviço
  // antes de fechar o orçamento final. Zero (padrão) = não cobra visita,
  // já manda o orçamento direto como sempre funcionou.
  if (providerColumns.indexOf("visit_fee") < 0) {
    db.exec("ALTER TABLE service_providers ADD COLUMN visit_fee REAL NOT NULL DEFAULT 0");
  }
}

// E-mail de recuperação pra lojista, taxista e prestador (opcional, pra dar
// pra eles um "esqueci minha senha" na tela de login, do mesmo jeito que o
// cliente já tem - sem isso, só um e-mail cadastrado consegue receber o
// link de redefinição). E "account_type" no token de redefinição, pra saber
// de qual tabela (cliente/lojista/taxista/prestador) a senha deve ser
// trocada quando o link for usado.
function ensurePasswordRecoveryColumns() {
  const ownerColumns = db.prepare("PRAGMA table_info(owners)").all().map(function (column) {
    return column.name;
  });
  if (ownerColumns.indexOf("email") < 0) {
    db.exec("ALTER TABLE owners ADD COLUMN email TEXT");
  }
  if (ownerColumns.indexOf("phone") < 0) {
    db.exec("ALTER TABLE owners ADD COLUMN phone TEXT");
  }

  const taxiColumns = db.prepare("PRAGMA table_info(taxi_drivers)").all().map(function (column) {
    return column.name;
  });
  if (taxiColumns.indexOf("email") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN email TEXT");
  }

  const providerColumns = db.prepare("PRAGMA table_info(service_providers)").all().map(function (column) {
    return column.name;
  });
  if (providerColumns.indexOf("email") < 0) {
    db.exec("ALTER TABLE service_providers ADD COLUMN email TEXT");
  }

  const tokenColumns = db.prepare("PRAGMA table_info(password_reset_tokens)").all().map(function (column) {
    return column.name;
  });
  if (tokenColumns.indexOf("account_type") < 0) {
    db.exec("ALTER TABLE password_reset_tokens ADD COLUMN account_type TEXT NOT NULL DEFAULT 'customer'");
  }
}

// CPF (documento pessoal) pra lojista, taxista e prestador, e os documentos
// exigidos por lei pra transporte remunerado de passageiros (Lei do Uber,
// 13.640/2018): CNH categoria B ou superior com a observação EAR ("Exerce
// Atividade Remunerada"), CRLV do veículo e certidão de antecedentes
// criminais. O motorista se cadastra na hora (self-service), mas só pode
// ativar o modo online depois que um admin conferir essas fotos e aprovar -
// por isso o campo verification_status. Pro prestador de serviço, a
// certidão é opcional e não bloqueia nada - é só um selo de confiança.
function ensurePartnerVerificationColumns() {
  const ownerColumns = db.prepare("PRAGMA table_info(owners)").all().map(function (column) {
    return column.name;
  });
  if (ownerColumns.indexOf("cpf") < 0) {
    db.exec("ALTER TABLE owners ADD COLUMN cpf TEXT");
  }

  const taxiColumns = db.prepare("PRAGMA table_info(taxi_drivers)").all().map(function (column) {
    return column.name;
  });
  if (taxiColumns.indexOf("cpf") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cpf TEXT");
  }
  if (taxiColumns.indexOf("cnh_number") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_number TEXT");
  }
  if (taxiColumns.indexOf("cnh_category") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_category TEXT");
  }
  if (taxiColumns.indexOf("cnh_expires_at") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_expires_at TEXT");
  }
  if (taxiColumns.indexOf("cnh_has_ear") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_has_ear INTEGER NOT NULL DEFAULT 0");
  }
  if (taxiColumns.indexOf("cnh_type") < 0) {
    // 'fisica' (padrão) = envia foto da frente e do verso do cartão físico.
    // 'digital' = quem só tem a CNH digital (app Vio) envia um único PDF
    // exportado de lá, que já tem todos os dados e o QR Code de validação.
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_type TEXT NOT NULL DEFAULT 'fisica'");
  }
  if (taxiColumns.indexOf("cnh_front_file") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_front_file TEXT");
  }
  if (taxiColumns.indexOf("cnh_back_file") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_back_file TEXT");
  }
  if (taxiColumns.indexOf("cnh_digital_file") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN cnh_digital_file TEXT");
  }
  if (taxiColumns.indexOf("crlv_file") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN crlv_file TEXT");
  }
  if (taxiColumns.indexOf("criminal_record_file") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN criminal_record_file TEXT");
  }
  if (taxiColumns.indexOf("verification_status") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pendente'");
  }
  if (taxiColumns.indexOf("verification_note") < 0) {
    db.exec("ALTER TABLE taxi_drivers ADD COLUMN verification_note TEXT");
  }

  const providerColumns = db.prepare("PRAGMA table_info(service_providers)").all().map(function (column) {
    return column.name;
  });
  if (providerColumns.indexOf("cpf") < 0) {
    db.exec("ALTER TABLE service_providers ADD COLUMN cpf TEXT");
  }
  if (providerColumns.indexOf("criminal_record_file") < 0) {
    db.exec("ALTER TABLE service_providers ADD COLUMN criminal_record_file TEXT");
  }
  if (providerColumns.indexOf("criminal_record_verified") < 0) {
    db.exec("ALTER TABLE service_providers ADD COLUMN criminal_record_verified INTEGER NOT NULL DEFAULT 0");
  }
}

function ensureCustomerColumns() {
  const columns = db.prepare("PRAGMA table_info(customers)").all().map(function (column) {
    return column.name;
  });

  if (columns.indexOf("google_sub") < 0) {
    db.exec("ALTER TABLE customers ADD COLUMN google_sub TEXT");
  }
}

// Adiciona a subcategoria da loja (usada só para separar "Mercados" de
// "Farmácias" dentro da categoria combinada "mercados-farmacias" na Home).
// Depois de criar a coluna, classifica as lojas de demonstração que já
// existiam no banco antes dessa coluna existir, sem mexer no restante dos
// dados da loja.
function ensureStoreColumns() {
  const columns = db.prepare("PRAGMA table_info(stores)").all().map(function (column) {
    return column.name;
  });

  if (columns.indexOf("sub_category") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN sub_category TEXT");
  }
  if (columns.indexOf("instagram_url") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN instagram_url TEXT");
  }
  if (columns.indexOf("facebook_url") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN facebook_url TEXT");
  }
  if (columns.indexOf("balance") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN balance REAL NOT NULL DEFAULT 0");
  }
  if (columns.indexOf("cnpj") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN cnpj TEXT");
  }
  if (columns.indexOf("address_street") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN address_street TEXT");
  }
  if (columns.indexOf("address_number") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN address_number TEXT");
  }
  if (columns.indexOf("address_district") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN address_district TEXT");
  }
  if (columns.indexOf("address_city") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN address_city TEXT");
  }
  if (columns.indexOf("address_zip_code") < 0) {
    db.exec("ALTER TABLE stores ADD COLUMN address_zip_code TEXT");
  }

  const farmaciaIds = ["pharma-1", "pharma-2", "pharma-3"];
  const mercadoIds = ["market-1", "market-2", "market-3"];

  const setSubCategory = db.prepare(
    "UPDATE stores SET sub_category = ? WHERE id = ? AND (sub_category IS NULL OR sub_category = '')"
  );

  farmaciaIds.forEach(function (id) {
    setSubCategory.run("farmacia", id);
  });
  mercadoIds.forEach(function (id) {
    setSubCategory.run("mercado", id);
  });
}

// Lê o Client ID do Google direto do arquivo google-config.json a cada
// chamada (arquivo pequeno, sem custo real) - assim quem estiver
// configurando o login com Google não precisa reiniciar o servidor
// depois de colar o Client ID no arquivo.
function getGoogleClientId() {
  try {
    const raw = fs.readFileSync(GOOGLE_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const fromFile = sanitizeText(parsed.googleClientId);
    if (fromFile) {
      return fromFile;
    }
  } catch (error) {
    // arquivo ausente ou inválido - cai para a variável de ambiente abaixo
  }

  // Em hospedagens como Railway costuma ser mais prático configurar por
  // variável de ambiente do que subir um arquivo junto do código.
  return sanitizeText(process.env.GOOGLE_CLIENT_ID);
}

// Lê a configuração de notificações push (chaves VAPID) do arquivo
// push-config.json. Se o arquivo não existir ou o pacote web-push não
// tiver sido instalado ainda, retorna null e o recurso fica desativado
// sem derrubar o servidor.
let pushConfigCache = null;
let pushConfigConfigured = false;

function getPushConfig() {
  let publicKey = "";
  let privateKey = "";
  let subject = "";

  try {
    const raw = fs.readFileSync(PUSH_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    publicKey = sanitizeText(parsed.vapidPublicKey);
    privateKey = sanitizeText(parsed.vapidPrivateKey);
    subject = sanitizeText(parsed.vapidSubject);
  } catch (error) {
    // arquivo ausente ou inválido - cai para as variáveis de ambiente abaixo
  }

  // Em hospedagens como Railway costuma ser mais prático configurar por
  // variável de ambiente do que subir um arquivo junto do código.
  if (!publicKey) {
    publicKey = sanitizeText(process.env.VAPID_PUBLIC_KEY);
  }
  if (!privateKey) {
    privateKey = sanitizeText(process.env.VAPID_PRIVATE_KEY);
  }
  if (!subject) {
    subject = sanitizeText(process.env.VAPID_SUBJECT) || "mailto:contato@alloo.com";
  }

  if (!publicKey || !privateKey) {
    return null;
  }

  if (!pushConfigConfigured && webpush) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    pushConfigConfigured = true;
  }

  pushConfigCache = { publicKey, privateKey, subject };
  return pushConfigCache;
}

function isPushEnabled() {
  return !!(webpush && getPushConfig());
}

// -------------------------------------------------------------------------
// Pagamento online (Mercado Pago) - Pix e cartão de crédito/débito
// -------------------------------------------------------------------------

const MERCADO_PAGO_API_URL = "https://api.mercadopago.com";

// Igual ao padrão já usado pro Google/push: se as credenciais não estiverem
// configuradas no .env, o recurso fica desativado e o resto do app continua
// funcionando normalmente (métodos de pagamento offline não são afetados).
function getMercadoPagoAccessToken() {
  return sanitizeText(process.env.MP_ACCESS_TOKEN);
}

function getMercadoPagoPublicKey() {
  return sanitizeText(process.env.MP_PUBLIC_KEY);
}

function isMercadoPagoEnabled() {
  return !!(getMercadoPagoAccessToken() && getMercadoPagoPublicKey());
}

// Chama a API de Orders do Mercado Pago (Checkout Transparente). Usada
// tanto para criar uma cobrança (Pix ou cartão) quanto para consultar o
// status de uma cobrança já criada (usado pelo webhook).
async function callMercadoPago(method, urlPath, body) {
  const accessToken = getMercadoPagoAccessToken();

  if (!accessToken) {
    throw new Error("Mercado Pago não configurado (falta MP_ACCESS_TOKEN no .env).");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + accessToken
  };

  if (method === "POST") {
    headers["X-Idempotency-Key"] = crypto.randomUUID();
  }

  const response = await fetch(MERCADO_PAGO_API_URL + urlPath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(function () {
    return {};
  });

  return { ok: response.ok, status: response.status, data };
}

// Registra (console + banco) qualquer falha vinda do Mercado Pago. Guardar
// no banco existe porque o painel de logs do Railway nem sempre mostra a
// saída do servidor depois que ele já está no ar há um tempo - com isso, o
// super-admin consegue ver o motivo real de uma falha sem depender disso.
// Nunca lança erro - registrar o problema não pode virar um problema novo.
function logPaymentError(kind, orderId, httpStatus, data) {
  try {
    console.error(
      "Mercado Pago (" + kind + ") falhou (pedido " + (orderId || "-") + "):",
      httpStatus,
      JSON.stringify(data)
    );

    db.prepare(
      "INSERT INTO payment_error_log (id, order_id, kind, http_status, message, raw_response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      crypto.randomUUID(),
      orderId || null,
      kind,
      httpStatus || null,
      (data && (data.message || data.error)) || "",
      JSON.stringify(data || {}),
      new Date().toISOString()
    );

    // Mantém só os 50 mais recentes - isso aqui é um painel de diagnóstico,
    // não um histórico permanente.
    db.prepare(
      "DELETE FROM payment_error_log WHERE id NOT IN (SELECT id FROM payment_error_log ORDER BY created_at DESC LIMIT 50)"
    ).run();
  } catch (logError) {
    console.error("Falha ao registrar erro de pagamento no log:", logError && logError.message);
  }
}

// Traduz o status que o Mercado Pago devolve pro status que a gente guarda
// no pedido. "action_required" acontece com Pix até o cliente pagar.
function mapMercadoPagoStatusToPaymentStatus(order, transaction) {
  const status = (order && order.status) || "";
  const statusDetail = (transaction && transaction.status_detail) || (order && order.status_detail) || "";

  if (status === "processed" || statusDetail === "accredited") {
    return "pago";
  }
  if (status === "cancelled" || status === "rejected" || statusDetail === "rejected") {
    return "recusado";
  }
  return "pendente";
}

// Confere o token que o Google Identity Services devolveu no navegador.
// Usa o endpoint público tokeninfo do Google (sem precisar de nenhuma
// biblioteca extra) e confirma que o token foi emitido para o nosso
// Client ID e que o e-mail já foi verificado pelo Google.
function verifyGoogleToken(idToken, clientId) {
  return new Promise(function (resolve, reject) {
    const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);

    https
      .get(url, function (googleRes) {
        let body = "";
        googleRes.on("data", function (chunk) {
          body += chunk;
        });
        googleRes.on("end", function () {
          let claims;
          try {
            claims = JSON.parse(body);
          } catch (error) {
            reject(new Error("Resposta inválida do Google."));
            return;
          }

          if (googleRes.statusCode !== 200 || !claims || claims.error) {
            reject(new Error("Token do Google inválido ou expirado."));
            return;
          }

          if (claims.aud !== clientId) {
            reject(new Error("Token do Google não pertence a este app."));
            return;
          }

          if (claims.email_verified !== "true" && claims.email_verified !== true) {
            reject(new Error("O e-mail da conta Google ainda não foi verificado."));
            return;
          }

          resolve(claims);
        });
      })
      .on("error", function () {
        reject(new Error("Não foi possível validar o login do Google agora."));
      });
  });
}

// Adiciona colunas novas em bancos já existentes (criados antes desta
// versão) sem apagar nenhum dado - assim quem já tem o app rodando não
// perde pedidos antigos ao atualizar o servidor.
function ensureOrderColumns() {
  const columns = db.prepare("PRAGMA table_info(orders)").all().map(function (column) {
    return column.name;
  });

  if (columns.indexOf("coupon_code") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN coupon_code TEXT");
  }
  if (columns.indexOf("discount") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN discount REAL NOT NULL DEFAULT 0");
  }
  if (columns.indexOf("payment_status") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'nao_aplicavel'");
  }
  if (columns.indexOf("payment_provider") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_provider TEXT");
  }
  if (columns.indexOf("payment_detail") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN payment_detail TEXT");
  }
  if (columns.indexOf("mp_order_id") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN mp_order_id TEXT");
  }
  if (columns.indexOf("pix_qr_code") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN pix_qr_code TEXT");
  }
  if (columns.indexOf("pix_qr_code_base64") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN pix_qr_code_base64 TEXT");
  }
  if (columns.indexOf("pix_ticket_url") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN pix_ticket_url TEXT");
  }
  if (columns.indexOf("change_for") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN change_for REAL");
  }
  if (columns.indexOf("settled_at") < 0) {
    db.exec("ALTER TABLE orders ADD COLUMN settled_at TEXT");
  }
}

// Métodos de pagamento que são cobrados de verdade dentro do app (via
// Mercado Pago). Os demais ("Cartão na entrega", "Dinheiro") continuam
// sendo só uma informação pro lojista, sem cobrança online.
const ONLINE_PAYMENT_METHODS = ["Pix", "Cartão (crédito ou débito)"];

function isOnlinePaymentMethod(method) {
  return ONLINE_PAYMENT_METHODS.indexOf(method) >= 0;
}

function loadSeedData() {
  const source = fs.readFileSync(SEED_FILE, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  const seed = sandbox.window.MORRETES_SEED || {};

  return {
    version: seed.version || 1,
    city: seed.city || "",
    state: seed.state || "",
    categories: Array.isArray(seed.categories) ? seed.categories : [],
    owners: Array.isArray(seed.owners) ? seed.owners : [],
    stores: Array.isArray(seed.stores) ? seed.stores : []
  };
}

function seedCatalogIfNeeded() {
  const count = db.prepare("SELECT COUNT(*) AS total FROM stores").get().total;
  if (count > 0) {
    return;
  }

  const seed = loadSeedData();
  const insertStore = db.prepare(`
    INSERT INTO stores (
      id, category_id, name, icon, logo_url, cover_label, description, rating,
      delivery_time, delivery_fee, delivery_fees_by_district_json, min_order,
      opening_hours, opening_hours_by_day_json, is_active, price_range, tags_json, sub_category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO items (id, store_id, name, price, promo_price, section, description, available, photo_url, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  seed.stores.forEach(function (store) {
    insertStore.run(
      store.id,
      store.categoryId || "",
      store.name || "",
      store.icon || "",
      store.logoUrl || "",
      store.coverLabel || "",
      store.description || "",
      Number(store.rating || 0),
      store.deliveryTime || "",
      store.deliveryFee || "",
      JSON.stringify(store.deliveryFeesByDistrict || {}),
      Number(store.minOrder || 0),
      store.openingHours || "",
      JSON.stringify(store.openingHoursByDay || {}),
      store.isActive === false ? 0 : 1,
      store.priceRange || "",
      JSON.stringify(store.tags || []),
      store.subCategory || ""
    );

    (store.items || []).forEach(function (item, index) {
      insertItem.run(
        item.id,
        store.id,
        item.name || "",
        Number(item.price || 0),
        item.promoPrice != null ? Number(item.promoPrice) : null,
        item.section || "Geral",
        item.description || "",
        item.available === false ? 0 : 1,
        item.photoUrl || "",
        index
      );
    });
  });

  console.log(`Catalogo inicial criado no banco (${seed.stores.length} lojas).`);
}

function seedOwnerAccountsIfNeeded() {
  const count = db.prepare("SELECT COUNT(*) AS total FROM owners").get().total;
  if (count > 0 || !fs.existsSync(OWNER_SEED_FILE)) {
    return;
  }

  const rawSeed = JSON.parse(fs.readFileSync(OWNER_SEED_FILE, "utf8") || "[]");
  const seed = loadSeedData();
  const publicOwnerInfo = {};
  (seed.owners || []).forEach(function (owner) {
    publicOwnerInfo[owner.storeId] = owner;
  });

  const insertOwner = db.prepare(`
    INSERT INTO owners (id, store_id, username, owner_name, store_name, password_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  rawSeed.forEach(function (entry) {
    const info = publicOwnerInfo[entry.storeId] || {};
    insertOwner.run(
      info.id || "owner-" + entry.storeId,
      entry.storeId,
      entry.username,
      info.ownerName || entry.username,
      info.storeName || "",
      hashPassword(entry.password)
    );
  });

  console.log(
    `Contas de lojista criadas (${rawSeed.length}). Senha inicial padrão: troque assim que possível.`
  );
}

// Cria a conta de administrador da plataforma na primeira vez que o banco
// sobe (tabela admins vazia). Só roda uma vez - depois disso, mesmo
// reiniciando o servidor, a conta e a senha continuam as mesmas até serem
// trocadas (rode "npm run set-admin-password" a qualquer momento, com
// ADMIN_PASSWORD definido, pra trocar a senha da conta já existente).
//
// A senha inicial vem da variável de ambiente ADMIN_PASSWORD (definida no
// .env local, ou nas variáveis de ambiente da hospedagem). Nunca fica
// escrita aqui no código - se ADMIN_PASSWORD não estiver definida, uma
// senha aleatória é gerada só para essa vez e mostrada uma única vez no
// console, pra nunca existir uma senha "padrão" fixa no código-fonte.
function seedAdminIfNeeded() {
  const count = db.prepare("SELECT COUNT(*) AS total FROM admins").get().total;
  if (count > 0) {
    return;
  }

  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");

  db.prepare(`
    INSERT INTO admins (id, username, password_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run("admin-1", "Elizandro", hashPassword(password), new Date().toISOString());

  if (process.env.ADMIN_PASSWORD) {
    console.log("Conta de administrador criada (Elizandro), com a senha definida em ADMIN_PASSWORD.");
  } else {
    console.log(
      "Conta de administrador criada (Elizandro). ADMIN_PASSWORD não estava definida, então " +
        `uma senha aleatória foi gerada só para agora: ${password}\n` +
        "Anote agora - ela não aparece de novo. Recomendado: defina ADMIN_PASSWORD no .env (ou na " +
        "hospedagem) e rode 'npm run set-admin-password' pra usar uma senha escolhida por você."
    );
  }
}

// Cria um prestador de serviço de teste (usado pra ter dados reais no
// painel do prestador logo de cara, sem precisar cadastrar na mão).
function seedProviderIfNeeded() {
  const count = db.prepare("SELECT COUNT(*) AS total FROM service_providers").get().total;
  if (count > 0) {
    return;
  }

  const now = new Date().toISOString();
  const providerId = "provider-1";

  db.prepare(`
    INSERT INTO service_providers (id, username, password_hash, name, specialty, phone, is_available, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(providerId, "zemecanico", hashPassword("123456"), "Seu Zé Mecânico", "Mecânico", "41988887777", now);

  const insertService = db.prepare(`
    INSERT INTO provider_services (id, provider_id, name, price, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  [
    { name: "Diagnóstico em casa", price: 60 },
    { name: "Troca de bateria", price: 80 },
    { name: "Troca de óleo e filtro", price: 70 },
    { name: "Revisão de freios", price: 150 }
  ].forEach(function (service, index) {
    insertService.run("provider-service-" + (index + 1), providerId, service.name, service.price, now);
  });

  console.log("Prestador de teste criado (Seu Zé Mecânico / zemecanico).");
}

// -- Clientes ---------------------------------------------------------------

function rowToCustomer(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    cpf: row.cpf,
    email: row.email,
    phone: row.phone || "",
    address: JSON.parse(row.address_json || "{}"),
    passwordHash: row.password_hash,
    googleSub: row.google_sub || "",
    createdAt: row.created_at
  };
}

function findCustomerByEmail(email) {
  return rowToCustomer(db.prepare("SELECT * FROM customers WHERE email = ?").get(email));
}

function findCustomerByCpf(cpf) {
  return rowToCustomer(db.prepare("SELECT * FROM customers WHERE cpf = ?").get(cpf));
}

function findCustomerByGoogleSub(googleSub) {
  return rowToCustomer(db.prepare("SELECT * FROM customers WHERE google_sub = ?").get(googleSub));
}

function linkCustomerGoogleSub(customerId, googleSub) {
  db.prepare("UPDATE customers SET google_sub = ? WHERE id = ?").run(googleSub, customerId);
}

function insertCustomer(customer) {
  db.prepare(`
    INSERT INTO customers (id, name, cpf, email, phone, address_json, password_hash, google_sub, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customer.id,
    customer.name,
    customer.cpf,
    customer.email,
    customer.phone || "",
    JSON.stringify(customer.address || {}),
    customer.passwordHash,
    customer.googleSub || null,
    customer.createdAt
  );
}

function updateCustomerPasswordHash(email, passwordHash) {
  db.prepare("UPDATE customers SET password_hash = ? WHERE email = ?").run(passwordHash, email);
}

// -- Tokens de redefinicao de senha -----------------------------------------

function insertPasswordResetToken(record) {
  const accountType = record.accountType || "customer";
  db.prepare("DELETE FROM password_reset_tokens WHERE email = ? AND account_type = ?").run(record.email, accountType);
  db.prepare(`
    INSERT INTO password_reset_tokens (token, email, account_type, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(record.token, record.email, accountType, record.expiresAt, record.createdAt);
}

function findPasswordResetToken(token) {
  return db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get(token) || null;
}

function deletePasswordResetToken(token) {
  db.prepare("DELETE FROM password_reset_tokens WHERE token = ?").run(token);
}

// -- Inscrições de notificação push (Web Push) ------------------------------

function insertPushSubscription(subscription) {
  db.prepare(`
    INSERT INTO push_subscriptions (id, customer_id, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      customer_id = excluded.customer_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth
  `).run(
    subscription.id,
    subscription.customerId,
    subscription.endpoint,
    subscription.p256dh,
    subscription.auth,
    subscription.createdAt
  );
}

function deletePushSubscriptionByEndpoint(endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

function listPushSubscriptionsByCustomer(customerId) {
  return db.prepare("SELECT * FROM push_subscriptions WHERE customer_id = ?").all(customerId);
}

function listAllPushSubscriptions() {
  return db.prepare("SELECT * FROM push_subscriptions").all();
}

// -- E-mails (modo preview, quando não há RESEND_API_KEY) -------------------

function insertEmailRecord(record) {
  db.prepare(`
    INSERT INTO emails (id, to_address, subject, html, text, created_at, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(record.id, record.to, record.subject, record.html, record.text, record.createdAt, record.provider);
}

// -- Lojistas -----------------------------------------------------------

function rowToOwner(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    storeId: row.store_id,
    username: row.username,
    ownerName: row.owner_name,
    storeName: row.store_name,
    passwordHash: row.password_hash,
    email: row.email || "",
    phone: row.phone || ""
  };
}

function findOwnerByUsername(username) {
  return rowToOwner(db.prepare("SELECT * FROM owners WHERE username = ?").get(username));
}

function findOwnerById(id) {
  return rowToOwner(db.prepare("SELECT * FROM owners WHERE id = ?").get(id));
}

function findOwnerByStoreId(storeId) {
  return rowToOwner(db.prepare("SELECT * FROM owners WHERE store_id = ?").get(storeId));
}

function findOwnerByEmail(email) {
  if (!email) {
    return null;
  }
  return rowToOwner(db.prepare("SELECT * FROM owners WHERE email = ?").get(email));
}

function updateOwnerEmail(ownerId, email) {
  db.prepare("UPDATE owners SET email = ? WHERE id = ?").run(email, ownerId);
}

function updateOwnerPhone(ownerId, phone) {
  db.prepare("UPDATE owners SET phone = ? WHERE id = ?").run(phone, ownerId);
}

// -- Administrador da plataforma ---------------------------------------

function findAdminByUsername(username) {
  return db.prepare("SELECT * FROM admins WHERE username = ?").get(username) || null;
}

function updateOwnerPasswordHash(ownerId, passwordHash) {
  db.prepare("UPDATE owners SET password_hash = ? WHERE id = ?").run(passwordHash, ownerId);
}

function updateTaxiDriverPasswordHash(driverId, passwordHash) {
  db.prepare("UPDATE taxi_drivers SET password_hash = ? WHERE id = ?").run(passwordHash, driverId);
}

function getPublicOwner(owner) {
  return {
    id: owner.id,
    storeId: owner.storeId,
    storeName: owner.storeName,
    ownerName: owner.ownerName,
    username: owner.username,
    email: owner.email || "",
    phone: owner.phone || ""
  };
}

// Cria uma conta de lojista nova em tempo real (usado pelo painel de admin
// quando uma loja nova entra na plataforma - diferente da carga inicial em
// seedOwnerAccountsIfNeeded, que só roda uma vez com o banco vazio).
function insertOwnerRow(owner) {
  db.prepare(`
    INSERT INTO owners (id, store_id, username, owner_name, store_name, password_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(owner.id, owner.storeId, owner.username, owner.ownerName, owner.storeName, owner.passwordHash);
}

// -- Catálogo (lojas + itens) -------------------------------------------

function rowToItem(row) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    promoPrice: row.promo_price,
    section: row.section || "Geral",
    description: row.description || "",
    available: row.available !== 0,
    photoUrl: row.photo_url || ""
  };
}

function rowToStore(row, items) {
  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name,
    icon: row.icon,
    logoUrl: row.logo_url,
    coverLabel: row.cover_label,
    description: row.description,
    rating: row.rating,
    deliveryTime: row.delivery_time,
    deliveryFee: row.delivery_fee,
    deliveryFeesByDistrict: JSON.parse(row.delivery_fees_by_district_json || "{}"),
    minOrder: row.min_order,
    openingHours: row.opening_hours,
    openingHoursByDay: JSON.parse(row.opening_hours_by_day_json || "{}"),
    isActive: row.is_active !== 0,
    priceRange: row.price_range,
    tags: JSON.parse(row.tags_json || "[]"),
    subCategory: row.sub_category || "",
    instagramUrl: row.instagram_url || "",
    facebookUrl: row.facebook_url || "",
    cnpj: row.cnpj || "",
    address: {
      street: row.address_street || "",
      number: row.address_number || "",
      district: row.address_district || "",
      city: row.address_city || "",
      zipCode: row.address_zip_code || ""
    },
    items: items
  };
}

// A nota mostrada pro cliente passa a ser a média das avaliações reais
// (quando existir pelo menos uma). Sem avaliação nenhuma ainda, cai para a
// nota base cadastrada pelo lojista.
function getStoreRatingSummary(storeId) {
  const row = db
    .prepare("SELECT COUNT(*) AS count, AVG(rating) AS avg FROM reviews WHERE store_id = ? AND hidden = 0")
    .get(storeId);
  return {
    avgRating: row.count ? Number(row.avg.toFixed(2)) : null,
    reviewsCount: row.count
  };
}

// Média/quantidade de avaliações de um item específico (não entra no
// catálogo padrão - calculada só quando a tela do item pede, pra não
// multiplicar consultas a cada sincronização do catálogo).
function getItemRatingSummary(itemId) {
  const row = db
    .prepare("SELECT COUNT(*) AS count, AVG(rating) AS avg FROM item_reviews WHERE item_id = ? AND hidden = 0")
    .get(itemId);
  return {
    avgRating: row.count ? Number(row.avg.toFixed(2)) : null,
    reviewsCount: row.count
  };
}

function getStoreWithItems(storeId) {
  const storeRow = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);
  if (!storeRow) {
    return null;
  }
  const itemRows = db
    .prepare("SELECT * FROM items WHERE store_id = ? ORDER BY sort_order ASC, rowid ASC")
    .all(storeId);
  const store = rowToStore(storeRow, itemRows.map(rowToItem));
  const ratingSummary = getStoreRatingSummary(storeId);
  store.avgRating = ratingSummary.avgRating;
  store.reviewsCount = ratingSummary.reviewsCount;
  return store;
}

function getAllStoresWithItems() {
  const storeRows = db.prepare("SELECT * FROM stores").all();
  return storeRows.map(function (storeRow) {
    const itemRows = db
      .prepare("SELECT * FROM items WHERE store_id = ? ORDER BY sort_order ASC, rowid ASC")
      .all(storeRow.id);
    const store = rowToStore(storeRow, itemRows.map(rowToItem));
    const ratingSummary = getStoreRatingSummary(storeRow.id);
    store.avgRating = ratingSummary.avgRating;
    store.reviewsCount = ratingSummary.reviewsCount;
    return store;
  });
}

function getPublicCatalog() {
  const seed = loadSeedData();
  const publicOwners = db
    .prepare("SELECT id, store_id, owner_name, store_name FROM owners")
    .all()
    .map(function (row) {
      return { id: row.id, storeId: row.store_id, storeName: row.store_name, ownerName: row.owner_name };
    });

  return {
    version: seed.version,
    city: seed.city,
    state: seed.state,
    categories: seed.categories,
    owners: publicOwners,
    stores: getAllStoresWithItems()
  };
}

function storeExists(storeId) {
  return !!db.prepare("SELECT 1 FROM stores WHERE id = ?").get(storeId);
}

// Cria uma loja nova em tempo real (usado pelo painel de admin). Diferente
// de seedCatalogIfNeeded, que só roda uma vez com o banco vazio, esta
// função pode ser chamada a qualquer momento com o app já em uso.
function insertStoreRow(store) {
  db.prepare(`
    INSERT INTO stores (
      id, category_id, name, icon, logo_url, cover_label, description, rating,
      delivery_time, delivery_fee, delivery_fees_by_district_json, min_order,
      opening_hours, opening_hours_by_day_json, is_active, price_range, tags_json, sub_category,
      instagram_url, facebook_url, cnpj, address_street, address_number, address_district,
      address_city, address_zip_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    store.id,
    store.categoryId,
    store.name,
    store.icon,
    store.logoUrl,
    store.coverLabel,
    store.description,
    store.rating,
    store.deliveryTime,
    store.deliveryFee,
    JSON.stringify(store.deliveryFeesByDistrict || {}),
    store.minOrder,
    store.openingHours,
    JSON.stringify(store.openingHoursByDay || {}),
    store.isActive === false ? 0 : 1,
    store.priceRange,
    JSON.stringify(store.tags || []),
    store.subCategory || "",
    store.instagramUrl || "",
    store.facebookUrl || "",
    store.cnpj || "",
    (store.address && store.address.street) || "",
    (store.address && store.address.number) || "",
    (store.address && store.address.district) || "",
    (store.address && store.address.city) || "",
    (store.address && store.address.zipCode) || ""
  );
}

function saveStore(storeId, normalizedStore) {
  db.prepare(`
    UPDATE stores SET
      category_id = ?, name = ?, icon = ?, logo_url = ?, cover_label = ?, description = ?,
      rating = ?, delivery_time = ?, delivery_fee = ?, delivery_fees_by_district_json = ?,
      min_order = ?, opening_hours = ?, opening_hours_by_day_json = ?, is_active = ?,
      price_range = ?, tags_json = ?, sub_category = ?, instagram_url = ?, facebook_url = ?
    WHERE id = ?
  `).run(
    normalizedStore.categoryId,
    normalizedStore.name,
    normalizedStore.icon,
    normalizedStore.logoUrl,
    normalizedStore.coverLabel,
    normalizedStore.description,
    normalizedStore.rating,
    normalizedStore.deliveryTime,
    normalizedStore.deliveryFee,
    JSON.stringify(normalizedStore.deliveryFeesByDistrict || {}),
    normalizedStore.minOrder,
    normalizedStore.openingHours,
    JSON.stringify(normalizedStore.openingHoursByDay || {}),
    normalizedStore.isActive ? 1 : 0,
    normalizedStore.priceRange,
    JSON.stringify(normalizedStore.tags || []),
    normalizedStore.subCategory || "",
    normalizedStore.instagramUrl || "",
    normalizedStore.facebookUrl || "",
    storeId
  );
}

function saveItem(storeId, normalizedItem, sortOrder) {
  const existing = db.prepare("SELECT id FROM items WHERE id = ? AND store_id = ?").get(normalizedItem.id, storeId);

  if (existing) {
    db.prepare(`
      UPDATE items SET name = ?, price = ?, promo_price = ?, section = ?, description = ?, available = ?, photo_url = ?
      WHERE id = ? AND store_id = ?
    `).run(
      normalizedItem.name,
      normalizedItem.price,
      normalizedItem.promoPrice,
      normalizedItem.section,
      normalizedItem.description,
      normalizedItem.available ? 1 : 0,
      normalizedItem.photoUrl,
      normalizedItem.id,
      storeId
    );
  } else {
    const nextOrder =
      sortOrder != null
        ? sortOrder
        : (db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE store_id = ?").get(storeId).m + 1);

    db.prepare(`
      INSERT INTO items (id, store_id, name, price, promo_price, section, description, available, photo_url, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedItem.id,
      storeId,
      normalizedItem.name,
      normalizedItem.price,
      normalizedItem.promoPrice,
      normalizedItem.section,
      normalizedItem.description,
      normalizedItem.available ? 1 : 0,
      normalizedItem.photoUrl,
      nextOrder
    );
  }
}

// -- Pedidos --------------------------------------------------------------

function rowToOrder(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    statusHistory: JSON.parse(row.status_history_json || "[]"),
    prepEstimate: row.prep_estimate || "",
    paymentMethod: row.payment_method || "",
    notes: row.notes || "",
    customerId: row.customer_id || "",
    customerName: row.customer_name || "",
    customerPhone: row.customer_phone || "",
    storeId: row.store_id,
    storeName: row.store_name,
    storeIcon: row.store_icon,
    items: JSON.parse(row.items_json || "[]"),
    subtotal: row.subtotal,
    deliveryFee: row.delivery_fee,
    couponCode: row.coupon_code || "",
    discount: row.discount || 0,
    total: row.total,
    district: row.district || "",
    address: row.address || "",
    paymentStatus: row.payment_status || "nao_aplicavel",
    paymentProvider: row.payment_provider || "",
    paymentDetail: row.payment_detail || "",
    mpOrderId: row.mp_order_id || "",
    pixQrCode: row.pix_qr_code || "",
    pixQrCodeBase64: row.pix_qr_code_base64 || "",
    pixTicketUrl: row.pix_ticket_url || "",
    changeFor: row.change_for != null ? Number(row.change_for) : null,
    settledAt: row.settled_at || ""
  };
}

function insertOrder(order) {
  db.prepare(`
    INSERT INTO orders (
      id, created_at, updated_at, status, status_history_json, prep_estimate, payment_method,
      notes, customer_id, customer_name, customer_phone, store_id, store_name, store_icon,
      items_json, subtotal, delivery_fee, coupon_code, discount, total, district, address,
      payment_status, change_for
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id,
    order.createdAt,
    order.updatedAt,
    order.status,
    JSON.stringify(order.statusHistory),
    order.prepEstimate,
    order.paymentMethod,
    order.notes,
    order.customerId,
    order.customerName,
    order.customerPhone,
    order.storeId,
    order.storeName,
    order.storeIcon,
    JSON.stringify(order.items),
    order.subtotal,
    order.deliveryFee,
    order.couponCode || "",
    order.discount || 0,
    order.total,
    order.district,
    order.address,
    isOnlinePaymentMethod(order.paymentMethod) ? "pendente" : "nao_aplicavel",
    order.changeFor != null ? order.changeFor : null
  );
}

function findOrderById(orderId) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  return row ? rowToOrder(row) : null;
}

function findOrderByMpOrderId(mpOrderId) {
  const row = db.prepare("SELECT * FROM orders WHERE mp_order_id = ?").get(mpOrderId);
  return row ? rowToOrder(row) : null;
}

function updateOrderPaymentRow(orderId, fields) {
  const sets = [];
  const values = [];

  ["paymentStatus", "paymentProvider", "paymentDetail", "mpOrderId", "pixQrCode", "pixQrCodeBase64", "pixTicketUrl"].forEach(
    function (key) {
      if (!(key in fields)) {
        return;
      }
      const column = {
        paymentStatus: "payment_status",
        paymentProvider: "payment_provider",
        paymentDetail: "payment_detail",
        mpOrderId: "mp_order_id",
        pixQrCode: "pix_qr_code",
        pixQrCodeBase64: "pix_qr_code_base64",
        pixTicketUrl: "pix_ticket_url"
      }[key];
      sets.push(column + " = ?");
      values.push(fields[key]);
    }
  );

  if (!sets.length) {
    return;
  }

  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(orderId);

  db.prepare("UPDATE orders SET " + sets.join(", ") + " WHERE id = ?").run(...values);
}

function listOrdersByStore(storeId) {
  const rows = db.prepare("SELECT * FROM orders WHERE store_id = ? ORDER BY created_at DESC").all(storeId);
  return rows.map(rowToOrder);
}

function updateOrderStatusRow(orderId, status, statusHistory) {
  db.prepare("UPDATE orders SET status = ?, status_history_json = ?, updated_at = ? WHERE id = ?").run(
    status,
    JSON.stringify(statusHistory),
    new Date().toISOString(),
    orderId
  );
}

function updateOrderPrepRow(orderId, prepEstimate) {
  db.prepare("UPDATE orders SET prep_estimate = ?, updated_at = ? WHERE id = ?").run(
    prepEstimate,
    new Date().toISOString(),
    orderId
  );
}

function deleteOrdersByStore(storeId) {
  db.prepare("DELETE FROM orders WHERE store_id = ?").run(storeId);
}

// -------------------------------------------------------------------------
// Sessões / autenticação
// -------------------------------------------------------------------------

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

// -------------------------------------------------------------------------
// Persistência de sessão no banco - cada tipo de conta (lojista, cliente,
// admin, prestador, taxista) guarda sua sessão num Map em memória, pra
// leitura rápida a cada requisição. O problema: o processo do servidor
// reinicia a cada redeploy (normal em hospedagens como o Railway), e um Map
// em memória não sobrevive a isso - todo mundo logado caía e precisava
// entrar de novo. Agora toda sessão criada também é gravada aqui; se o Map
// não tiver o token (ex.: logo depois de um redeploy), a gente busca no
// banco antes de desistir e devolve a sessão pro Map de novo, sem o usuário
// perceber nada.
// -------------------------------------------------------------------------

const SESSION_MAPS_BY_ROLE = {
  owner: ownerSessions,
  customer: customerSessions,
  admin: adminSessions,
  provider: providerSessions,
  taxi: taxiSessions
};

function persistSession(token, role, session) {
  try {
    db.prepare(
      `INSERT INTO sessions (token, role, payload_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET payload_json = excluded.payload_json, expires_at = excluded.expires_at`
    ).run(token, role, JSON.stringify(session), session.expiresAt, new Date().toISOString());
  } catch (error) {
    console.error("Não foi possível salvar a sessão no banco:", error.message);
  }
}

function deleteSessionFromDb(token) {
  try {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  } catch (error) {
    console.error("Não foi possível remover a sessão do banco:", error.message);
  }
}

// Busca uma sessão que não estava no Map (provavelmente porque o processo
// acabou de reiniciar) - se achar e ainda estiver válida, já devolve pro
// Map correspondente pra não precisar consultar o banco de novo da próxima
// vez. Se estiver expirada, aproveita e já limpa do banco.
function loadSessionFromDbIntoMap(token, role) {
  const map = SESSION_MAPS_BY_ROLE[role];
  if (!map) {
    return null;
  }

  let row;
  try {
    row = db.prepare("SELECT * FROM sessions WHERE token = ? AND role = ?").get(token, role);
  } catch (error) {
    return null;
  }

  if (!row) {
    return null;
  }

  if (row.expires_at < Date.now()) {
    deleteSessionFromDb(token);
    return null;
  }

  let session;
  try {
    session = JSON.parse(row.payload_json);
  } catch (error) {
    deleteSessionFromDb(token);
    return null;
  }

  map.set(token, session);
  return session;
}

// Chamado uma vez na inicialização do servidor - pré-carrega no Map todas
// as sessões ainda válidas que sobraram no banco de uma execução anterior,
// pra quem já estava logado antes do redeploy nem perceber uma consulta
// extra ao banco na primeira requisição depois de o servidor voltar.
function restoreSessionsFromDb() {
  let rows;
  try {
    rows = db.prepare("SELECT * FROM sessions WHERE expires_at >= ?").all(Date.now());
  } catch (error) {
    return;
  }

  let restored = 0;
  rows.forEach(function (row) {
    const map = SESSION_MAPS_BY_ROLE[row.role];
    if (!map) {
      return;
    }
    try {
      map.set(row.token, JSON.parse(row.payload_json));
      restored += 1;
    } catch (error) {
      // Payload corrompido - ignora essa linha, não derruba o resto.
    }
  });

  try {
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  } catch (error) {
    // Limpeza de sessões vencidas é só manutenção - não é crítico.
  }

  if (restored > 0) {
    console.log(`${restored} sessão(ões) restaurada(s) do banco depois do reinício.`);
  }
}

// Transforma "Pizzaria do Zé" em "pizzaria-do-ze", pra usar como parte do id
// da loja e sugestão de nome de usuário do lojista.
function removeDiacritics(text) {
  return text
    .normalize("NFD")
    .split("")
    .filter(function (char) {
      const code = char.charCodeAt(0);
      // Faixa Unicode das marcas de acento combinadas (ex: o acento
      // separado do "e" depois do normalize("NFD") em "e" + acento agudo).
      return code < 768 || code > 879;
    })
    .join("");
}

function slugify(text) {
  return removeDiacritics(String(text || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

// Gera um id único de loja a partir do nome (evita colisão com um sufixo
// aleatório curto no final).
function generateStoreId(storeName) {
  const base = slugify(storeName) || "loja";
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

// Senha inicial gerada pro lojista novo. Usa só letras/números sem
// caracteres ambíguos (sem 0/O, 1/l/I) pra ficar fácil de repassar por
// WhatsApp ou por telefone sem confusão.
function generateReadablePassword() {
  const charset = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  let password = "";
  for (let i = 0; i < bytes.length; i += 1) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

function createOwnerSession(owner) {
  const token = createToken();
  const session = {
    ownerId: owner.id,
    storeId: owner.storeId,
    username: owner.username,
    ownerName: owner.ownerName,
    storeName: owner.storeName,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  ownerSessions.set(token, session);
  persistSession(token, "owner", session);
  return token;
}

function createCustomerSession(customer) {
  const token = createToken();
  const session = {
    customerId: customer.id,
    email: customer.email,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  customerSessions.set(token, session);
  persistSession(token, "customer", session);
  return token;
}

function getBearerToken(req) {
  const header = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

function getOwnerSessionByToken(token) {
  if (!token) {
    return null;
  }

  const session = ownerSessions.get(token) || loadSessionFromDbIntoMap(token, "owner");
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    ownerSessions.delete(token);
    deleteSessionFromDb(token);
    return null;
  }

  return session;
}

function getOwnerSession(req) {
  return getOwnerSessionByToken(getBearerToken(req));
}

function getCustomerSessionByToken(token) {
  if (!token) {
    return null;
  }

  const session = customerSessions.get(token) || loadSessionFromDbIntoMap(token, "customer");
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    customerSessions.delete(token);
    deleteSessionFromDb(token);
    return null;
  }

  return session;
}

function getCustomerSession(req) {
  return getCustomerSessionByToken(getBearerToken(req));
}

function requireOwnerForStore(req, res, storeId) {
  const session = getOwnerSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login como lojista para continuar." });
    return null;
  }

  if (session.storeId !== storeId) {
    sendJson(res, 403, { error: "Você não tem permissão para alterar esta loja." });
    return null;
  }

  return session;
}

// -------------------------------------------------------------------------
// Sessão do administrador da plataforma (você) - separada da sessão de
// lojista. Só serve para criar lojas novas quando alguém entra em contato
// pedindo pra virar parceiro. Protegida por uma senha única (ADMIN_PASSWORD
// no arquivo .env), não por usuário/senha individual.
// -------------------------------------------------------------------------

function createAdminSession() {
  const token = createToken();
  const session = { expiresAt: Date.now() + ADMIN_SESSION_TTL_MS };
  adminSessions.set(token, session);
  persistSession(token, "admin", session);
  return token;
}

function getAdminSession(req) {
  const token = getBearerToken(req);
  if (!token) {
    return null;
  }

  const session = adminSessions.get(token) || loadSessionFromDbIntoMap(token, "admin");
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    deleteSessionFromDb(token);
    return null;
  }

  return session;
}

function requireAdmin(req, res) {
  const session = getAdminSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login como administrador para continuar." });
    return null;
  }

  return session;
}

// -------------------------------------------------------------------------
// Sessão do prestador de serviço - mesmo padrão da sessão de lojista, mas
// separada porque um prestador não tem loja/cardápio, e sim serviços,
// agenda e solicitações de orçamento.
// -------------------------------------------------------------------------

function createProviderSession(provider) {
  const token = createToken();
  const session = {
    providerId: provider.id,
    username: provider.username,
    name: provider.name,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  providerSessions.set(token, session);
  persistSession(token, "provider", session);
  return token;
}

function getProviderSessionByToken(token) {
  if (!token) {
    return null;
  }

  const session = providerSessions.get(token) || loadSessionFromDbIntoMap(token, "provider");
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    providerSessions.delete(token);
    deleteSessionFromDb(token);
    return null;
  }

  return session;
}

function getProviderSession(req) {
  return getProviderSessionByToken(getBearerToken(req));
}

function requireProvider(req, res) {
  const session = getProviderSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login como prestador para continuar." });
    return null;
  }

  return session;
}

function getTaxiSessionByToken(token) {
  if (!token) {
    return null;
  }

  const session = taxiSessions.get(token) || loadSessionFromDbIntoMap(token, "taxi");
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    taxiSessions.delete(token);
    deleteSessionFromDb(token);
    return null;
  }

  return session;
}

function getTaxiSession(req) {
  return getTaxiSessionByToken(getBearerToken(req));
}

function requireTaxiDriver(req, res) {
  const session = getTaxiSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login como taxista para continuar." });
    return null;
  }

  return session;
}

// -------------------------------------------------------------------------
// Limite de tentativas nas rotas sensíveis (login/cadastro/recuperação)
// -------------------------------------------------------------------------

function isRateLimited(req) {
  const ip = (req.socket && req.socket.remoteAddress) || "desconhecido";
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip) || { count: 0, windowStart: now };

  if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket.count = 0;
    bucket.windowStart = now;
  }

  bucket.count += 1;
  rateLimitBuckets.set(ip, bucket);

  return bucket.count > RATE_LIMIT_MAX;
}

// -------------------------------------------------------------------------
// Helpers HTTP
// -------------------------------------------------------------------------

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

function getFilePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const requestedPath = cleanPath === "/" ? "/index.html" : cleanPath;
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[\\/])+/, "");
  return path.join(ROOT, normalizedPath);
}

// Só deixa passar arquivos HTML/CSS da raiz que fazem parte da UI, além de
// tudo dentro de assets/ e src/. Bloqueia a pasta data/ (banco, pedidos,
// hash de senha), .env, .git etc.
function isPubliclyServable(filePath) {
  const relative = path.relative(ROOT, filePath);

  if (!relative || relative.startsWith("..")) {
    return false;
  }

  const segments = relative.split(path.sep);

  if (segments[0].startsWith(".")) {
    return false;
  }

  if (segments.length === 1) {
    return PUBLIC_STATIC_FILES.has(segments[0]);
  }

  return PUBLIC_STATIC_DIRS.indexOf(segments[0]) >= 0;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
      // O cadastro de motorista manda até 4 documentos (CNH frente/verso,
      // CRLV e antecedentes) em base64 no mesmo POST - base64 é ~37% maior
      // que o arquivo original, então o limite aqui precisa sobrar espaço
      // pra isso (cada arquivo já é limitado a 5 MB antes de virar base64,
      // ver MAX_UPLOAD_BYTES).
      if (body.length > 30 * 1024 * 1024) {
        reject(new Error("Payload muito grande."));
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("JSON inválido."));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeText(value) {
  return String(value || "").trim();
}

// Só aceita link http/https (ex.: Instagram, Facebook). Qualquer outra
// coisa (esquema "javascript:", texto solto, etc.) vira string vazia, pra
// nunca guardar um link que não é um link de verdade.
function sanitizeHttpUrl(value) {
  const url = sanitizeText(value);
  if (!url) {
    return "";
  }
  return /^https?:\/\//i.test(url) ? url : "";
}

function normalizeEmail(email) {
  return sanitizeText(email).toLowerCase();
}

function normalizeCpf(cpf) {
  return sanitizeText(cpf).replace(/\D/g, "");
}

function normalizeAddress(address) {
  return {
    street: sanitizeText(address && address.street),
    number: sanitizeText(address && address.number),
    district: sanitizeText(address && address.district),
    city: sanitizeText(address && address.city),
    zipCode: sanitizeText(address && address.zipCode),
    complement: sanitizeText(address && address.complement),
    reference: sanitizeText(address && address.reference)
  };
}

function formatAddress(address) {
  const parts = [];

  if (address.street || address.number) {
    parts.push([address.street, address.number].filter(Boolean).join(", "));
  }

  if (address.district) {
    parts.push(address.district);
  }

  if (address.city) {
    parts.push(address.city);
  }

  if (address.zipCode) {
    parts.push(`CEP ${address.zipCode}`);
  }

  if (address.complement) {
    parts.push(address.complement);
  }

  if (address.reference) {
    parts.push(address.reference);
  }

  return parts.join(" - ");
}

// Cidades do litoral do Paraná - únicas aceitas no cadastro do cliente,
// já que é onde o app atende hoje.
const COASTAL_PARANA_CITIES = [
  "Antonina",
  "Guaraqueçaba",
  "Guaratuba",
  "Matinhos",
  "Morretes",
  "Paranaguá",
  "Pontal do Paraná"
];

function isValidRegisterPayload(payload) {
  const address = normalizeAddress(payload.address || {});

  if (
    !sanitizeText(payload.name) ||
    !normalizeCpf(payload.cpf) ||
    !normalizeEmail(payload.email) ||
    !sanitizeText(payload.password) ||
    !sanitizeText(payload.phone)
  ) {
    return "Preencha nome completo, CPF, telefone, e-mail e senha.";
  }

  if (normalizeCpf(payload.cpf).length !== 11) {
    return "Digite um CPF válido com 11 números.";
  }

  if (sanitizeText(payload.password).length < 8) {
    return "A senha deve ter pelo menos 8 caracteres.";
  }

  if (
    !address.street ||
    !address.number ||
    !address.district ||
    !address.city ||
    !address.zipCode
  ) {
    return "Preencha o endereço completo.";
  }

  if (COASTAL_PARANA_CITIES.indexOf(address.city) < 0) {
    return "Por enquanto o Alloo só atende cidades do litoral do Paraná.";
  }

  return "";
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedValue) {
  if (!storedValue || storedValue.indexOf(":") < 0) {
    return false;
  }

  const [salt, originalHash] = storedValue.split(":");
  const currentHash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(currentHash, "hex"));
}

function getPublicCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    cpf: customer.cpf,
    email: customer.email,
    phone: customer.phone || "",
    address: customer.address,
    createdAt: customer.createdAt
  };
}

async function sendEmail({ to, subject, html, text }) {
  const emailRecord = {
    id: "email-" + Date.now(),
    to,
    subject,
    html,
    text,
    createdAt: new Date().toISOString(),
    provider: process.env.RESEND_API_KEY ? "resend" : "preview"
  };

  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    insertEmailRecord(emailRecord);
    console.log(`Email em modo preview para ${to}: ${subject}`);
    return { delivered: false, preview: true };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Não foi possível enviar o e-mail.");
  }

  insertEmailRecord(emailRecord);
  return { delivered: true, preview: false };
}

function getBaseUrl(req) {
  const publicBaseUrl = sanitizeText(process.env.PUBLIC_APP_URL);
  if (publicBaseUrl) {
    return publicBaseUrl.replace(/\/$/, "");
  }

  const protocol = "http";
  return `${protocol}://${PUBLIC_HOST}:${PORT}`;
}

// A gente já tinha um botão manual ("Verificar pagamento agora") pra quando
// o aviso automático do Mercado Pago não chega, mas nunca tinha ficado
// confirmado se a URL de notificação configurada no PAINEL do Mercado Pago
// apontava pro domínio certo - e trocar de domínio (como já aconteceu no
// rebranding) exigiria lembrar de ir lá atualizar na mão. Em vez de depender
// só da configuração manual do painel, cada cobrança criada já manda pro
// Mercado Pago, direto no pedido, pra onde ele deve avisar - assim o
// endereço certo é sempre usado, mesmo que o domínio mude de novo no
// futuro (só depende da variável PUBLIC_APP_URL estar certa).
function getPaymentWebhookUrl(req) {
  return getBaseUrl(req) + "/api/payments/webhook";
}

function normalizeStoreItem(item, existingItem) {
  return {
    id:
      sanitizeText(item.id) ||
      sanitizeText(existingItem && existingItem.id) ||
      "item-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    name: sanitizeText(item.name),
    price: Number(item.price || 0),
    promoPrice:
      item.promoPrice != null && item.promoPrice !== ""
        ? Number(item.promoPrice)
        : null,
    section: sanitizeText(item.section) || "Geral",
    description: sanitizeText(item.description),
    available: item.available !== false,
    photoUrl: sanitizeText(item.photoUrl || (existingItem && existingItem.photoUrl))
  };
}

function normalizeStorePayload(payload, existingStore) {
  return {
    id: sanitizeText(payload.id || (existingStore && existingStore.id)),
    categoryId: sanitizeText(payload.categoryId || (existingStore && existingStore.categoryId)),
    name: sanitizeText(payload.name),
    icon: sanitizeText(payload.icon || (existingStore && existingStore.icon)),
    logoUrl: sanitizeText(payload.logoUrl || (existingStore && existingStore.logoUrl)),
    coverLabel: sanitizeText(payload.coverLabel || (existingStore && existingStore.coverLabel)),
    description: sanitizeText(payload.description),
    rating: Number(payload.rating != null ? payload.rating : existingStore && existingStore.rating) || 0,
    deliveryTime: sanitizeText(payload.deliveryTime || (existingStore && existingStore.deliveryTime)),
    deliveryFee: sanitizeText(payload.deliveryFee || (existingStore && existingStore.deliveryFee)),
    deliveryFeesByDistrict: payload.deliveryFeesByDistrict || (existingStore && existingStore.deliveryFeesByDistrict) || {},
    minOrder: Number(payload.minOrder != null ? payload.minOrder : existingStore && existingStore.minOrder) || 0,
    openingHours: sanitizeText(payload.openingHours || (existingStore && existingStore.openingHours)),
    openingHoursByDay: payload.openingHoursByDay || (existingStore && existingStore.openingHoursByDay) || {},
    isActive: payload.isActive !== false,
    priceRange: sanitizeText(payload.priceRange || (existingStore && existingStore.priceRange)),
    tags: Array.isArray(payload.tags) ? payload.tags : (existingStore && existingStore.tags) || [],
    subCategory: sanitizeText(payload.subCategory || (existingStore && existingStore.subCategory)),
    instagramUrl: sanitizeHttpUrl(
      payload.instagramUrl !== undefined ? payload.instagramUrl : (existingStore && existingStore.instagramUrl)
    ),
    facebookUrl: sanitizeHttpUrl(
      payload.facebookUrl !== undefined ? payload.facebookUrl : (existingStore && existingStore.facebookUrl)
    ),
    items: Array.isArray(payload.items)
      ? payload.items.map(function (item) {
          var existingItem = existingStore && Array.isArray(existingStore.items)
            ? existingStore.items.find(function (current) { return current.id === item.id; })
            : null;
          return normalizeStoreItem(item, existingItem);
        })
      : (existingStore && existingStore.items) || []
  };
}

// -------------------------------------------------------------------------
// Autenticacao de cliente
// -------------------------------------------------------------------------

async function handleRegister(req, res) {
  const payload = await readRequestBody(req);
  const validationError = isValidRegisterPayload(payload);
  const email = normalizeEmail(payload.email);
  const cpf = normalizeCpf(payload.cpf);

  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  if (findCustomerByEmail(email)) {
    sendJson(res, 400, { error: "Já existe uma conta com esse e-mail." });
    return;
  }

  if (findCustomerByCpf(cpf)) {
    sendJson(res, 400, { error: "Já existe uma conta com esse CPF." });
    return;
  }

  const customer = {
    id: "customer-" + Date.now(),
    name: sanitizeText(payload.name),
    cpf,
    email,
    phone: sanitizeText(payload.phone),
    address: normalizeAddress(payload.address),
    passwordHash: hashPassword(sanitizeText(payload.password)),
    googleSub: sanitizeText(payload.googleSub),
    createdAt: new Date().toISOString()
  };

  insertCustomer(customer);

  const addressText = formatAddress(customer.address);
  const safeName = escapeHtml(customer.name);
  await sendEmail({
    to: customer.email,
    subject: "Conta criada com sucesso",
    html: `
      <h1>Conta criada com sucesso</h1>
      <p>Olá, ${safeName}.</p>
      <p>Sua conta no Alloo foi criada com sucesso.</p>
      <p><strong>E-mail:</strong> ${escapeHtml(customer.email)}</p>
      <p><strong>Endereço:</strong> ${escapeHtml(addressText)}</p>
      <p>Agora você já pode entrar no app com o e-mail e a senha cadastrados.</p>
    `,
    text:
      `Conta criada com sucesso.\n\n` +
      `Olá, ${customer.name}.\n` +
      `Sua conta no Alloo foi criada com sucesso.\n` +
      `E-mail: ${customer.email}\n` +
      `Endereço: ${addressText}\n`
  });

  const token = createCustomerSession(customer);

  sendJson(res, 201, {
    message: "Cadastro criado com sucesso.",
    customer: getPublicCustomer(customer),
    token
  });
}

// Aceita tanto e-mail quanto CPF como identificador de login do cliente.
// Se o texto digitado tiver "@", trata como e-mail; caso contrario, trata
// como CPF (ignorando pontos/traco que o cliente eventualmente digite).
async function handleLogin(req, res) {
  const payload = await readRequestBody(req);
  const identifier = sanitizeText(payload.identifier || payload.email);
  const password = sanitizeText(payload.password);
  const customer =
    identifier.indexOf("@") >= 0
      ? findCustomerByEmail(normalizeEmail(identifier))
      : findCustomerByCpf(normalizeCpf(identifier));

  if (!customer || !verifyPassword(password, customer.passwordHash)) {
    sendJson(res, 401, { error: "E-mail/CPF ou senha inválidos." });
    return;
  }

  const token = createCustomerSession(customer);

  sendJson(res, 200, {
    customer: getPublicCustomer(customer),
    token
  });
}

async function handleGoogleAuth(req, res) {
  const clientId = getGoogleClientId();

  if (!clientId) {
    sendJson(res, 400, {
      error: "O login com Google ainda não foi configurado neste servidor."
    });
    return;
  }

  const payload = await readRequestBody(req);
  const credential = sanitizeText(payload.credential);

  if (!credential) {
    sendJson(res, 400, { error: "Credencial do Google ausente." });
    return;
  }

  let claims;
  try {
    claims = await verifyGoogleToken(credential, clientId);
  } catch (error) {
    sendJson(res, 401, { error: error.message || "Não foi possível validar o login do Google." });
    return;
  }

  const googleSub = sanitizeText(claims.sub);
  const email = normalizeEmail(claims.email);
  const name = sanitizeText(claims.name || claims.given_name || "");

  let customer = findCustomerByGoogleSub(googleSub);

  if (!customer) {
    customer = findCustomerByEmail(email);
    if (customer) {
      linkCustomerGoogleSub(customer.id, googleSub);
      customer.googleSub = googleSub;
    }
  }

  if (!customer) {
    sendJson(res, 200, {
      needsRegistration: true,
      prefill: { name, email, googleSub }
    });
    return;
  }

  const token = createCustomerSession(customer);

  sendJson(res, 200, {
    customer: getPublicCustomer(customer),
    token
  });
}

async function handleOwnerLogin(req, res) {
  const payload = await readRequestBody(req);
  const username = sanitizeText(payload.username);
  const password = sanitizeText(payload.password);
  const owner = findOwnerByUsername(username);

  if (!owner || !verifyPassword(password, owner.passwordHash)) {
    sendJson(res, 401, { error: "Usuário ou senha inválidos." });
    return;
  }

  const token = createOwnerSession(owner);

  sendJson(res, 200, {
    owner: getPublicOwner(owner),
    token
  });
}

function handleOwnerLogout(req, res) {
  const token = getBearerToken(req);
  if (token) {
    ownerSessions.delete(token);
    deleteSessionFromDb(token);
  }
  sendJson(res, 200, { message: "Sessão encerrada." });
}

// A senha só pode ser trocada pela tela de login (via "Esqueci minha
// senha" + link por e-mail) - não existe mais troca de senha de dentro do
// painel já logado, pra nenhum tipo de conta. Isso aqui só deixa o próprio
// lojista cadastrar/atualizar o e-mail de recuperação da conta dele (sem
// isso, o "esqueci minha senha" não tem pra onde mandar o link) - não mexe
// na senha.
async function handleOwnerUpdateEmail(req, res) {
  const session = getOwnerSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login como lojista para continuar." });
    return;
  }

  const payload = await readRequestBody(req);
  const email = normalizeEmail(payload.email);

  if (!email || !email.includes("@")) {
    sendJson(res, 400, { error: "Informe um e-mail válido." });
    return;
  }

  const existing = findOwnerByEmail(email);
  if (existing && existing.id !== session.ownerId) {
    sendJson(res, 400, { error: "Esse e-mail já está em uso por outra conta." });
    return;
  }

  updateOwnerEmail(session.ownerId, email);
  sendJson(res, 200, { email });
}

// -------------------------------------------------------------------------
// "Esqueci minha senha" - mesmo fluxo (link por e-mail, válido por 1 hora)
// pra qualquer tipo de conta: cliente, lojista, taxista e prestador. É a
// ÚNICA forma de trocar a senha de uma conta que já existe - de propósito,
// não existe troca de senha de dentro do painel já logado (pra evitar que
// alguém com acesso momentâneo ao aparelho de outra pessoa troque a senha
// dela sem precisar confirmar por e-mail).
// -------------------------------------------------------------------------

const ACCOUNT_TYPES = {
  customer: {
    findByEmail: findCustomerByEmail,
    getName: function (account) {
      return account.name;
    }
  },
  owner: {
    findByEmail: findOwnerByEmail,
    getName: function (account) {
      return account.ownerName;
    }
  },
  taxi: {
    findByEmail: findTaxiDriverByEmail,
    getName: function (account) {
      return account.name;
    }
  },
  provider: {
    findByEmail: findProviderByEmail,
    getName: function (account) {
      return account.name;
    }
  }
};

const GENERIC_FORGOT_PASSWORD_MESSAGE = "Se o e-mail existir, enviaremos um link para redefinir a senha.";

async function handleForgotPasswordFor(req, res, accountType) {
  const config = ACCOUNT_TYPES[accountType];
  const payload = await readRequestBody(req);
  const email = normalizeEmail(payload.email);
  const account = email ? config.findByEmail(email) : null;

  if (!account) {
    // Sempre a mesma mensagem, exista ou não a conta - pra não deixar
    // ninguém descobrir se um e-mail está cadastrado só tentando aqui.
    sendJson(res, 200, { message: GENERIC_FORGOT_PASSWORD_MESSAGE });
    return;
  }

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  const baseUrl = getBaseUrl(req);
  const resetUrl = `${baseUrl}/reset-password.html?token=${token}&type=${accountType}`;

  insertPasswordResetToken({
    token,
    email,
    accountType,
    expiresAt,
    createdAt: new Date().toISOString()
  });

  const name = config.getName(account) || "";
  const safeName = escapeHtml(name);
  await sendEmail({
    to: email,
    subject: "Redefina sua senha",
    html: `
      <h1>Redefinição de senha</h1>
      <p>Olá, ${safeName}.</p>
      <p>Recebemos um pedido para redefinir sua senha.</p>
      <p><a href="${escapeHtml(resetUrl)}">Clique aqui para criar uma nova senha</a></p>
      <p>Esse link expira em 1 hora. Se você não pediu isso, pode ignorar este e-mail.</p>
    `,
    text:
      `Olá, ${name}.\n` +
      `Use este link para redefinir sua senha: ${resetUrl}\n` +
      `Esse link expira em 1 hora. Se você não pediu isso, pode ignorar este e-mail.\n`
  });

  sendJson(res, 200, { message: GENERIC_FORGOT_PASSWORD_MESSAGE });
}

async function handleForgotPassword(req, res) {
  await handleForgotPasswordFor(req, res, "customer");
}

async function handleOwnerForgotPassword(req, res) {
  await handleForgotPasswordFor(req, res, "owner");
}

async function handleTaxiForgotPassword(req, res) {
  await handleForgotPasswordFor(req, res, "taxi");
}

async function handleProviderForgotPassword(req, res) {
  await handleForgotPasswordFor(req, res, "provider");
}

function getResetTokenRecord(token) {
  const record = findPasswordResetToken(token);

  if (!record) {
    return null;
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    deletePasswordResetToken(token);
    return null;
  }

  return record;
}

async function handleResetPassword(req, res) {
  const payload = await readRequestBody(req);
  const token = sanitizeText(payload.token);
  const password = sanitizeText(payload.password);
  const tokenRecord = getResetTokenRecord(token);

  if (!tokenRecord) {
    sendJson(res, 400, { error: "Esse link de redefinição é inválido ou expirou." });
    return;
  }

  const minLength = tokenRecord.account_type === "taxi" ? 6 : 8;
  if (password.length < minLength) {
    sendJson(res, 400, { error: `A senha deve ter pelo menos ${minLength} caracteres.` });
    return;
  }

  const config = ACCOUNT_TYPES[tokenRecord.account_type] || ACCOUNT_TYPES.customer;
  const account = config.findByEmail(tokenRecord.email);
  if (!account) {
    sendJson(res, 400, { error: "Conta não encontrada." });
    return;
  }

  const passwordHash = hashPassword(password);
  if (tokenRecord.account_type === "owner") {
    updateOwnerPasswordHash(account.id, passwordHash);
  } else if (tokenRecord.account_type === "taxi") {
    updateTaxiDriverPasswordHash(account.id, passwordHash);
  } else if (tokenRecord.account_type === "provider") {
    updateProviderPasswordHash(account.id, passwordHash);
  } else {
    updateCustomerPasswordHash(account.email, passwordHash);
  }

  deletePasswordResetToken(token);

  sendJson(res, 200, {
    message: "Senha atualizada com sucesso.",
    email: tokenRecord.email,
    accountType: tokenRecord.account_type
  });
}

async function handleValidateToken(req, res, urlObject) {
  const token = sanitizeText(urlObject.searchParams.get("token"));
  const tokenRecord = getResetTokenRecord(token);

  if (!tokenRecord) {
    sendJson(res, 404, { error: "Esse link de redefinição é inválido ou expirou." });
    return;
  }

  sendJson(res, 200, {
    email: tokenRecord.email,
    accountType: tokenRecord.account_type
  });
}

// -------------------------------------------------------------------------
// Catálogo (lojas e itens)
// -------------------------------------------------------------------------

async function handleGetCatalog(req, res) {
  sendJson(res, 200, getPublicCatalog());
}

// -------------------------------------------------------------------------
// Painel de administrador da plataforma - só pra você criar uma loja nova
// (com conta de lojista já pronta) quando alguém entra em contato pedindo
// pra virar parceiro. Protegido por uma senha única configurada no .env
// (ADMIN_PASSWORD), separada do login de cada lojista.
// -------------------------------------------------------------------------

async function handleAdminLogin(req, res) {
  const payload = await readRequestBody(req);
  const username = sanitizeText(payload.username);
  const password = sanitizeText(payload.password);

  const admin = username ? findAdminByUsername(username) : null;

  if (!admin || !verifyPassword(password, admin.password_hash)) {
    sendJson(res, 401, { error: "Usuário ou senha inválidos." });
    return;
  }

  const token = createAdminSession();
  sendJson(res, 200, { token, admin: { id: admin.id, username: admin.username } });
}

// Gera uma sessão de lojista de verdade pra uma loja qualquer, sem precisar
// saber a senha do lojista - assim você consegue entrar no painel completo
// de qualquer loja (cardápio, pedidos, cupons, métricas) direto pelo painel
// de administrador.
async function handleAdminImpersonateStore(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);
  const owner = storeId ? findOwnerByStoreId(storeId) : null;

  if (!owner) {
    sendJson(res, 404, { error: "Não foi encontrada uma conta de lojista para essa loja." });
    return;
  }

  const token = createOwnerSession(owner);
  sendJson(res, 200, { owner: getPublicOwner(owner), token });
}

async function handleAdminCreateStore(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const storeName = sanitizeText(payload.storeName);
  const categoryId = sanitizeText(payload.categoryId);
  const ownerName = sanitizeText(payload.ownerName);
  let username = sanitizeText(payload.username).toLowerCase();

  if (!storeName || !categoryId || !ownerName) {
    sendJson(res, 400, { error: "Preencha ao menos o nome da loja, a categoria e o nome do responsável." });
    return;
  }

  if (!username) {
    username = slugify(storeName);
  }

  if (!username) {
    sendJson(res, 400, { error: "Não foi possível gerar um nome de usuário a partir do nome da loja." });
    return;
  }

  if (findOwnerByUsername(username)) {
    sendJson(res, 400, { error: "Já existe uma conta de lojista com esse nome de usuário. Tente outro." });
    return;
  }

  const storeId = generateStoreId(storeName);
  const password = generateReadablePassword();

  insertStoreRow({
    id: storeId,
    categoryId,
    name: storeName,
    icon: sanitizeText(payload.icon) || "🍽️",
    logoUrl: "",
    coverLabel: sanitizeText(payload.coverLabel) || storeName,
    description: sanitizeText(payload.description),
    rating: 5,
    deliveryTime: sanitizeText(payload.deliveryTime) || "30-45 min",
    deliveryFee: sanitizeText(payload.deliveryFee) || "A combinar",
    deliveryFeesByDistrict: {},
    minOrder: Number(payload.minOrder || 0),
    openingHours: sanitizeText(payload.openingHours) || "A definir",
    openingHoursByDay: {},
    isActive: true,
    priceRange: sanitizeText(payload.priceRange) || "$$",
    tags: []
  });

  const ownerEmail = normalizeEmail(payload.ownerEmail);

  insertOwnerRow({
    id: "owner-" + storeId,
    storeId,
    username,
    ownerName,
    storeName,
    passwordHash: hashPassword(password)
  });

  if (ownerEmail) {
    updateOwnerEmail("owner-" + storeId, ownerEmail);
  }

  sendJson(res, 201, {
    message: "Loja criada com sucesso.",
    store: { id: storeId, name: storeName },
    credentials: { username, password }
  });
}

async function handleAdminCreateTaxiDriver(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const name = sanitizeText(payload.name);
  const phone = sanitizeText(payload.phone);
  const vehicle = sanitizeText(payload.vehicle);
  let username = sanitizeText(payload.username).toLowerCase();
  const customPassword = sanitizeText(payload.password);

  if (!name || !phone) {
    sendJson(res, 400, { error: "Preencha ao menos o nome e o telefone do taxista." });
    return;
  }

  if (!username) {
    username = slugify(name);
  }

  if (!username) {
    sendJson(res, 400, { error: "Não foi possível gerar um nome de usuário a partir do nome informado." });
    return;
  }

  if (findTaxiDriverByUsername(username)) {
    sendJson(res, 400, { error: "Já existe um taxista cadastrado com esse nome de usuário. Tente outro." });
    return;
  }

  // O admin pode escolher uma senha mais fácil de repassar por telefone
  // (ex.: combinada com o taxista na hora); se deixar em branco, geramos
  // uma senha legível automaticamente, como antes.
  if (customPassword && customPassword.length < 6) {
    sendJson(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });
    return;
  }

  // CRLV é opcional aqui (o admin já vetou a pessoa por fora, então não
  // bloqueia o cadastro) - mas se for enviado, fica guardado no mesmo lugar
  // protegido dos outros documentos, pra servir de registro caso precise
  // depois (ex.: confirmar o veículo numa dúvida ou acidente).
  let crlvFileName = "";
  if (payload.crlvPhoto) {
    const crlvUpload = saveDocumentUpload(payload.crlvPhoto, "crlv");
    if (crlvUpload.error) {
      sendJson(res, 400, { error: "CRLV do veículo: " + crlvUpload.error });
      return;
    }
    crlvFileName = crlvUpload.fileName;
  }

  const password = customPassword || generateReadablePassword();
  const driverId = "taxi-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
  const email = normalizeEmail(payload.email);

  // Motorista cadastrado pelo próprio admin já nasce aprovado: o admin já
  // conferiu a pessoa por fora (documento físico, indicação etc.), então não
  // faz sentido travar esse motorista atrás da mesma fila de verificação de
  // documentos usada pra quem se cadastra sozinho pelo site.
  db.prepare(
    `INSERT INTO taxi_drivers (id, username, password_hash, name, phone, vehicle, is_online, email, crlv_file, verification_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'aprovado', ?)`
  ).run(
    driverId,
    username,
    hashPassword(password),
    name,
    phone,
    vehicle,
    email || null,
    crlvFileName || null,
    new Date().toISOString()
  );

  sendJson(res, 201, {
    message: "Taxista cadastrado com sucesso.",
    driver: { id: driverId, name },
    credentials: { username, password }
  });
}

async function handleAdminListTaxiDrivers(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT * FROM taxi_drivers ORDER BY name ASC").all();
  sendJson(res, 200, {
    drivers: rows.map(rowToTaxiDriver).map(function (driver) {
      return {
        id: driver.id,
        username: driver.username,
        name: driver.name,
        phone: driver.phone,
        vehicle: driver.vehicle,
        isOnline: driver.isOnline,
        locationUpdatedAt: driver.locationUpdatedAt,
        cpf: driver.cpf,
        cnhNumber: driver.cnhNumber,
        cnhCategory: driver.cnhCategory,
        cnhExpiresAt: driver.cnhExpiresAt,
        cnhHasEar: driver.cnhHasEar,
        cnhType: driver.cnhType,
        hasCnhFront: !!driver.cnhFrontFile,
        hasCnhBack: !!driver.cnhBackFile,
        hasCnhDigital: !!driver.cnhDigitalFile,
        hasCrlv: !!driver.crlvFile,
        hasCriminalRecord: !!driver.criminalRecordFile,
        verificationStatus: driver.verificationStatus,
        verificationNote: driver.verificationNote
      };
    })
  });
}

const VALID_TAXI_VERIFICATION_STATUSES = ["pendente", "aprovado", "recusado"];

async function handleAdminVerifyTaxiDriver(req, res, driverId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const driver = findTaxiDriverById(driverId);
  if (!driver) {
    sendJson(res, 404, { error: "Motorista não encontrado." });
    return;
  }

  const payload = await readRequestBody(req);
  const status = sanitizeText(payload.status);
  const note = sanitizeText(payload.note);

  if (VALID_TAXI_VERIFICATION_STATUSES.indexOf(status) < 0) {
    sendJson(res, 400, { error: "Status inválido. Use 'aprovado', 'recusado' ou 'pendente'." });
    return;
  }

  db.prepare("UPDATE taxi_drivers SET verification_status = ?, verification_note = ? WHERE id = ?").run(
    status,
    note,
    driverId
  );

  // Se o motorista for recusado depois de já aprovado, tira ele do ar na
  // hora - não faz sentido continuar online sem os documentos em dia.
  if (status !== "aprovado") {
    db.prepare("UPDATE taxi_drivers SET is_online = 0 WHERE id = ?").run(driverId);
  }

  sendJson(res, 200, { driver: getPublicTaxiDriver(findTaxiDriverById(driverId)) });
}

// Edita os dados básicos de um taxista já cadastrado - útil sobretudo pra
// adicionar um e-mail depois (motoristas cadastrados antes desse campo
// existir não tinham pra onde mandar o link de "esqueci minha senha") e
// pra corrigir nome, telefone, veículo ou placa sem precisar recriar a
// conta do zero. Não mexe em usuário nem senha - troca de senha continua
// só pela tela de login, com "Esqueci minha senha".
async function handleAdminUpdateTaxiDriver(req, res, driverId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const existing = db.prepare("SELECT * FROM taxi_drivers WHERE id = ?").get(driverId);
  if (!existing) {
    sendJson(res, 404, { error: "Motorista não encontrado." });
    return;
  }

  const payload = await readRequestBody(req);
  const name = payload.name !== undefined ? sanitizeText(payload.name) : existing.name;
  const phone = payload.phone !== undefined ? sanitizeText(payload.phone) : existing.phone;
  const vehicle = payload.vehicle !== undefined ? sanitizeText(payload.vehicle) : existing.vehicle;
  const email = payload.email !== undefined ? normalizeEmail(payload.email) : existing.email;

  if (!name || !phone) {
    sendJson(res, 400, { error: "Nome e telefone não podem ficar em branco." });
    return;
  }

  db.prepare("UPDATE taxi_drivers SET name = ?, phone = ?, vehicle = ?, email = ? WHERE id = ?").run(
    name,
    phone,
    vehicle,
    email || null,
    driverId
  );

  const updated = findTaxiDriverById(driverId);
  sendJson(res, 200, {
    message: "Dados do taxista atualizados.",
    driver: {
      id: updated.id,
      username: updated.username,
      name: updated.name,
      phone: updated.phone,
      vehicle: updated.vehicle,
      email: updated.email
    }
  });
}

// Cadastro manual de prestador de serviço pelo admin - mesmo espírito do
// cadastro manual de taxista: útil pra quem já apareceu pessoalmente ou por
// indicação e não quer (ou não sabe) preencher o formulário de auto-cadastro
// sozinho. CPF e certidão de antecedentes ficam opcionais aqui, porque o
// admin já está vetando a pessoa por fora - diferente do auto-cadastro, onde
// esses documentos são obrigatórios por não haver esse contato direto.
async function handleAdminCreateProvider(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const name = sanitizeText(payload.name);
  const phone = sanitizeText(payload.phone);
  const specialty = sanitizeText(payload.specialty);
  let username = sanitizeText(payload.username).toLowerCase();
  const customPassword = sanitizeText(payload.password);
  const email = normalizeEmail(payload.email);
  const cpf = normalizeCpf(payload.cpf);

  if (!name || !phone || !specialty) {
    sendJson(res, 400, { error: "Preencha ao menos o nome, telefone e especialidade do prestador." });
    return;
  }

  if (cpf && cpf.length !== 11) {
    sendJson(res, 400, { error: "Se for informar o CPF, digite um CPF válido com 11 números." });
    return;
  }

  if (!username) {
    username = slugify(name);
  }

  if (!username) {
    sendJson(res, 400, { error: "Não foi possível gerar um nome de usuário a partir do nome informado." });
    return;
  }

  if (findProviderByUsername(username)) {
    sendJson(res, 400, { error: "Já existe um prestador cadastrado com esse nome de usuário. Tente outro." });
    return;
  }

  if (email && findProviderByEmail(email)) {
    sendJson(res, 400, { error: "Já existe uma conta de prestador com esse e-mail." });
    return;
  }

  if (customPassword && customPassword.length < 6) {
    sendJson(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });
    return;
  }

  // Certidão de antecedentes opcional aqui também - mesmo raciocínio do CRLV
  // no cadastro manual de taxista: não bloqueia o cadastro, fica só como
  // registro se o admin tiver o documento em mãos na hora.
  let criminalRecordFileName = "";
  if (payload.criminalRecordPhoto) {
    const criminalRecordUpload = saveDocumentUpload(payload.criminalRecordPhoto, "antecedentes-prestador");
    if (criminalRecordUpload.error) {
      sendJson(res, 400, { error: "Certidão de antecedentes criminais: " + criminalRecordUpload.error });
      return;
    }
    criminalRecordFileName = criminalRecordUpload.fileName;
  }

  const password = customPassword || generateReadablePassword();
  const providerId = "provider-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO service_providers (
      id, username, password_hash, name, specialty, phone, is_available, cpf,
      criminal_record_file, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(providerId, username, hashPassword(password), name, specialty, phone, cpf || null, criminalRecordFileName || null, now);
  if (email) {
    db.prepare("UPDATE service_providers SET email = ? WHERE id = ?").run(email, providerId);
  }

  sendJson(res, 201, {
    message: "Prestador cadastrado com sucesso.",
    provider: { id: providerId, name },
    credentials: { username, password }
  });
}

// Avaliação (nota + comentário) que o cliente deixa pro prestador é
// interna - só aparece aqui (painel do admin) e no painel do próprio
// prestador, nunca numa vitrine pública.
async function handleAdminListProviderReviews(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT provider_reviews.*, service_providers.name AS provider_name
       FROM provider_reviews
       JOIN service_providers ON service_providers.id = provider_reviews.provider_id
       ORDER BY provider_reviews.created_at DESC
       LIMIT 200`
    )
    .all();

  sendJson(res, 200, {
    reviews: rows.map(function (row) {
      const review = rowToProviderReview(row);
      review.providerName = row.provider_name;
      return review;
    })
  });
}

async function handleAdminListProviders(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT * FROM service_providers ORDER BY name ASC").all();
  sendJson(res, 200, {
    providers: rows.map(rowToProvider).map(function (provider) {
      return {
        id: provider.id,
        username: provider.username,
        name: provider.name,
        specialty: provider.specialty,
        phone: provider.phone,
        cpf: provider.cpf,
        isAvailable: provider.isAvailable,
        hasCriminalRecord: !!provider.criminalRecordFile,
        criminalRecordVerified: provider.criminalRecordVerified
      };
    })
  });
}

async function handleAdminVerifyProviderCriminalRecord(req, res, providerId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const provider = findProviderById(providerId);
  if (!provider) {
    sendJson(res, 404, { error: "Prestador não encontrado." });
    return;
  }

  if (!provider.criminalRecordFile) {
    sendJson(res, 400, { error: "Esse prestador ainda não enviou a certidão de antecedentes." });
    return;
  }

  const payload = await readRequestBody(req);
  const verified = !!payload.verified;

  db.prepare("UPDATE service_providers SET criminal_record_verified = ? WHERE id = ?").run(
    verified ? 1 : 0,
    providerId
  );

  sendJson(res, 200, { provider: getPublicProvider(findProviderById(providerId)) });
}

// -------------------------------------------------------------------------
// Cadastro público de parceiro (self-service) - a pessoa escolhe na tela
// "Ganhe dinheiro com o Alloo" se é loja, motorista ou prestador de
// serviço, preenche o formulário próprio de cada tipo e a conta já sai
// pronta pra usar na hora, com usuário e senha escolhidos por ela mesma -
// sem precisar de aprovação manual do admin antes (diferente do fluxo
// antigo de "lead" que só registrava um interesse pra alguém ligar depois).
// -------------------------------------------------------------------------

// Se o nome de usuário já existe, tenta de novo com um sufixo curto em vez
// de simplesmente recusar o cadastro - numa tela de auto-cadastro isso
// evita travar a pessoa por causa de um nome comum (ex.: dois "joão").
function dedupeUsername(base, existsFn) {
  let candidate = base;
  let attempts = 0;
  while (existsFn(candidate) && attempts < 20) {
    attempts += 1;
    candidate = `${base}-${crypto.randomBytes(2).toString("hex")}`;
  }
  return candidate;
}

function updateOwnerCpf(ownerId, cpf) {
  db.prepare("UPDATE owners SET cpf = ? WHERE id = ?").run(cpf, ownerId);
}

async function handleSignupStore(req, res) {
  const payload = await readRequestBody(req);
  const storeName = sanitizeText(payload.storeName);
  const categoryId = sanitizeText(payload.categoryId);
  const ownerName = sanitizeText(payload.ownerName);
  const cpf = normalizeCpf(payload.cpf);
  const cnpj = sanitizeText(payload.cnpj).replace(/\D/g, "");
  const phone = sanitizeText(payload.phone);
  const email = normalizeEmail(payload.email);
  const password = sanitizeText(payload.password);
  const address = normalizeAddress(payload.address || {});

  if (
    !storeName ||
    !categoryId ||
    !ownerName ||
    !cpf ||
    !phone ||
    !email ||
    !password ||
    !address.street ||
    !address.number ||
    !address.district ||
    !address.city
  ) {
    sendJson(res, 400, {
      error:
        "Preencha o nome da loja, categoria, responsável, CPF, telefone, e-mail, senha e o endereço completo da loja."
    });
    return;
  }

  if (cpf.length !== 11) {
    sendJson(res, 400, { error: "Digite um CPF válido com 11 números." });
    return;
  }

  if (password.length < 6) {
    sendJson(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });
    return;
  }

  const seed = loadSeedData();
  // "Serviços" é a categoria dos prestadores de serviço (que têm o próprio
  // fluxo de cadastro, com CPF e certidão de antecedentes) - não faz
  // sentido um estabelecimento se cadastrar nela.
  const validCategoryIds = seed.categories
    .map(function (category) {
      return category.id;
    })
    .filter(function (id) {
      return id !== "servicos";
    });
  if (validCategoryIds.indexOf(categoryId) < 0) {
    sendJson(res, 400, { error: "Categoria inválida." });
    return;
  }

  if (findOwnerByEmail(email)) {
    sendJson(res, 400, { error: "Já existe uma conta de lojista com esse e-mail." });
    return;
  }

  let username = sanitizeText(payload.username).toLowerCase() || slugify(storeName);
  if (!username) {
    sendJson(res, 400, { error: "Não foi possível gerar um nome de usuário a partir do nome da loja." });
    return;
  }
  username = dedupeUsername(username, function (candidate) {
    return !!findOwnerByUsername(candidate);
  });

  const storeId = generateStoreId(storeName);

  insertStoreRow({
    id: storeId,
    categoryId,
    name: storeName,
    icon: "🍽️",
    logoUrl: "",
    coverLabel: storeName,
    description: sanitizeText(payload.description),
    rating: 5,
    deliveryTime: "30-45 min",
    deliveryFee: "A combinar",
    deliveryFeesByDistrict: {},
    minOrder: 0,
    openingHours: "A definir",
    openingHoursByDay: {},
    isActive: true,
    priceRange: "$$",
    tags: [],
    cnpj,
    address
  });

  const ownerId = "owner-" + storeId;
  insertOwnerRow({
    id: ownerId,
    storeId,
    username,
    ownerName,
    storeName,
    passwordHash: hashPassword(password)
  });
  updateOwnerEmail(ownerId, email);
  updateOwnerPhone(ownerId, phone);
  updateOwnerCpf(ownerId, cpf);

  const owner = findOwnerById(ownerId);
  const token = createOwnerSession(owner);

  sendJson(res, 201, {
    message: "Loja cadastrada com sucesso.",
    owner: getPublicOwner(owner),
    store: { id: storeId, name: storeName },
    token
  });
}

// Categorias de CNH que autorizam dirigir carro (a partir da B) - a
// categoria A sozinha é só moto, não serve pra corrida de táxi de carro.
const VALID_CAR_CNH_CATEGORIES = ["B", "AB", "C", "D", "E"];

async function handleSignupTaxiDriver(req, res) {
  const payload = await readRequestBody(req);
  const name = sanitizeText(payload.name);
  const cpf = normalizeCpf(payload.cpf);
  const phone = sanitizeText(payload.phone);
  const email = normalizeEmail(payload.email);
  const vehicle = sanitizeText(payload.vehicle);
  const password = sanitizeText(payload.password);
  const cnhNumber = sanitizeText(payload.cnhNumber);
  const cnhCategory = sanitizeText(payload.cnhCategory).toUpperCase();
  const cnhExpiresAt = sanitizeText(payload.cnhExpiresAt);
  const cnhHasEar = !!payload.cnhHasEar;
  // 'fisica' = manda foto da frente e do verso do cartão. 'digital' = quem só
  // tem a CNH pelo app Vio manda o PDF exportado de lá (já vem com todos os
  // dados e o QR Code de validação num arquivo só).
  const cnhType = sanitizeText(payload.cnhType).toLowerCase() === "digital" ? "digital" : "fisica";

  if (
    !name ||
    !cpf ||
    !phone ||
    !email ||
    !vehicle ||
    !password ||
    !cnhNumber ||
    !cnhCategory ||
    !cnhExpiresAt
  ) {
    sendJson(res, 400, {
      error: "Preencha nome, CPF, telefone, e-mail, veículo, senha e os dados da CNH (número, categoria e validade)."
    });
    return;
  }

  if (cpf.length !== 11) {
    sendJson(res, 400, { error: "Digite um CPF válido com 11 números." });
    return;
  }

  if (password.length < 6) {
    sendJson(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });
    return;
  }

  if (VALID_CAR_CNH_CATEGORIES.indexOf(cnhCategory) < 0) {
    sendJson(res, 400, { error: "Pra rodar de carro, a CNH precisa ser categoria B ou superior." });
    return;
  }

  if (!cnhHasEar) {
    sendJson(res, 400, {
      error: "É preciso confirmar que sua CNH tem a observação EAR (Exerce Atividade Remunerada) pra transportar passageiros."
    });
    return;
  }

  const expiresDate = new Date(cnhExpiresAt + "T00:00:00");
  if (Number.isNaN(expiresDate.getTime()) || expiresDate.getTime() < Date.now()) {
    sendJson(res, 400, { error: "A validade da CNH informada é inválida ou já venceu." });
    return;
  }

  if (findTaxiDriverByEmail(email)) {
    sendJson(res, 400, { error: "Já existe uma conta de motorista com esse e-mail." });
    return;
  }

  let cnhFrontFileName = "";
  let cnhBackFileName = "";
  let cnhDigitalFileName = "";

  if (cnhType === "digital") {
    // Só um arquivo (o PDF exportado do app Vio), em vez de frente + verso.
    const cnhDigitalUpload = saveDocumentUpload(payload.cnhDigitalPdf, "cnh-digital");
    if (cnhDigitalUpload.error) {
      sendJson(res, 400, { error: "PDF da CNH digital: " + cnhDigitalUpload.error });
      return;
    }
    if (!cnhDigitalUpload.fileName) {
      sendJson(res, 400, {
        error: "Envie o PDF da sua CNH digital exportado do app Vio (com o QR Code de validação)."
      });
      return;
    }
    cnhDigitalFileName = cnhDigitalUpload.fileName;
  } else {
    const cnhFrontUpload = saveDocumentUpload(payload.cnhFrontPhoto, "cnh-frente");
    if (cnhFrontUpload.error) {
      sendJson(res, 400, { error: "Foto da frente da CNH: " + cnhFrontUpload.error });
      return;
    }

    const cnhBackUpload = saveDocumentUpload(payload.cnhBackPhoto, "cnh-verso");
    if (cnhBackUpload.error) {
      sendJson(res, 400, { error: "Foto do verso da CNH: " + cnhBackUpload.error });
      return;
    }

    if (!cnhFrontUpload.fileName || !cnhBackUpload.fileName) {
      sendJson(res, 400, {
        error: "Envie a foto da frente e do verso da CNH (ou marque a opção de CNH digital, se só tiver ela)."
      });
      return;
    }
    cnhFrontFileName = cnhFrontUpload.fileName;
    cnhBackFileName = cnhBackUpload.fileName;
  }

  const crlvUpload = saveDocumentUpload(payload.crlvPhoto, "crlv");
  if (crlvUpload.error) {
    sendJson(res, 400, { error: "Foto do CRLV: " + crlvUpload.error });
    return;
  }

  const criminalRecordUpload = saveDocumentUpload(payload.criminalRecordPhoto, "antecedentes");
  if (criminalRecordUpload.error) {
    sendJson(res, 400, { error: "Certidão de antecedentes criminais: " + criminalRecordUpload.error });
    return;
  }

  if (!crlvUpload.fileName || !criminalRecordUpload.fileName) {
    sendJson(res, 400, {
      error: "Envie o CRLV do veículo e a certidão de antecedentes criminais."
    });
    return;
  }

  let username = sanitizeText(payload.username).toLowerCase() || slugify(name);
  if (!username) {
    sendJson(res, 400, { error: "Não foi possível gerar um nome de usuário a partir do nome informado." });
    return;
  }
  username = dedupeUsername(username, function (candidate) {
    return !!findTaxiDriverByUsername(candidate);
  });

  const driverId = "taxi-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

  db.prepare(
    `INSERT INTO taxi_drivers (
      id, username, password_hash, name, phone, vehicle, is_online, email, cpf,
      cnh_number, cnh_category, cnh_expires_at, cnh_has_ear, cnh_type, cnh_front_file, cnh_back_file,
      cnh_digital_file, crlv_file, criminal_record_file, verification_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'pendente', ?)`
  ).run(
    driverId,
    username,
    hashPassword(password),
    name,
    phone,
    vehicle,
    email,
    cpf,
    cnhNumber,
    cnhCategory,
    cnhExpiresAt,
    cnhType,
    cnhFrontFileName,
    cnhBackFileName,
    cnhDigitalFileName,
    crlvUpload.fileName,
    criminalRecordUpload.fileName,
    new Date().toISOString()
  );

  const driver = findTaxiDriverById(driverId);
  const token = createTaxiSession(driver);

  sendJson(res, 201, {
    message:
      "Cadastro de motorista feito com sucesso. Sua conta já existe, mas você só consegue ficar online e receber " +
      "corridas depois que a gente conferir os documentos enviados.",
    driver: getPublicTaxiDriver(driver),
    username,
    token
  });
}

async function handleSignupProvider(req, res) {
  const payload = await readRequestBody(req);
  const name = sanitizeText(payload.name);
  const cpf = normalizeCpf(payload.cpf);
  const phone = sanitizeText(payload.phone);
  const email = normalizeEmail(payload.email);
  const specialty = sanitizeText(payload.specialty);
  const password = sanitizeText(payload.password);

  if (!name || !cpf || !phone || !email || !specialty || !password) {
    sendJson(res, 400, { error: "Preencha nome, CPF, telefone, e-mail, especialidade e senha." });
    return;
  }

  if (cpf.length !== 11) {
    sendJson(res, 400, { error: "Digite um CPF válido com 11 números." });
    return;
  }

  if (password.length < 6) {
    sendJson(res, 400, { error: "A senha deve ter pelo menos 6 caracteres." });
    return;
  }

  if (findProviderByEmail(email)) {
    sendJson(res, 400, { error: "Já existe uma conta de prestador com esse e-mail." });
    return;
  }

  // A certidão de antecedentes é opcional pro prestador (não bloqueia o
  // cadastro nem o uso do app) - é só um selo de confiança que aparece pro
  // cliente quando o admin confere e aprova o documento enviado.
  let criminalRecordFileName = "";
  if (payload.criminalRecordPhoto) {
    const criminalRecordUpload = saveDocumentUpload(payload.criminalRecordPhoto, "antecedentes-prestador");
    if (criminalRecordUpload.error) {
      sendJson(res, 400, { error: "Certidão de antecedentes criminais: " + criminalRecordUpload.error });
      return;
    }
    criminalRecordFileName = criminalRecordUpload.fileName;
  }

  let username = sanitizeText(payload.username).toLowerCase() || slugify(name);
  if (!username) {
    sendJson(res, 400, { error: "Não foi possível gerar um nome de usuário a partir do nome informado." });
    return;
  }
  username = dedupeUsername(username, function (candidate) {
    return !!findProviderByUsername(candidate);
  });

  const providerId = "provider-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO service_providers (
      id, username, password_hash, name, specialty, phone, is_available, cpf,
      criminal_record_file, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(providerId, username, hashPassword(password), name, specialty, phone, cpf, criminalRecordFileName, now);
  db.prepare("UPDATE service_providers SET email = ? WHERE id = ?").run(email, providerId);

  const provider = findProviderById(providerId);
  const token = createProviderSession(provider);

  sendJson(res, 201, {
    message: "Cadastro de prestador feito com sucesso.",
    provider: getPublicProvider(provider),
    username,
    token
  });
}

// -------------------------------------------------------------------------
// Leads de parceiros (quero ser parceiro / quero oferecer meus serviços) -
// chegam pro administrador aprovar ou recusar antes de criar a loja/conta.
// -------------------------------------------------------------------------

function rowToPartnerLead(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at
  };
}

function insertPartnerLeadRow(lead) {
  db.prepare(
    `INSERT INTO partner_leads (id, name, phone, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(lead.id, lead.name, lead.phone, lead.kind, lead.status, lead.createdAt);
}

function getPartnerLeadsByStatus(status) {
  const rows = status
    ? db.prepare("SELECT * FROM partner_leads WHERE status = ? ORDER BY created_at DESC").all(status)
    : db.prepare("SELECT * FROM partner_leads ORDER BY created_at DESC").all();
  return rows.map(rowToPartnerLead);
}

function updatePartnerLeadStatusRow(id, status) {
  db.prepare("UPDATE partner_leads SET status = ? WHERE id = ?").run(status, id);
}

async function handleCreatePartnerLead(req, res) {
  const payload = await readRequestBody(req);
  const name = sanitizeText(payload.name);
  const phone = sanitizeText(payload.phone);
  const kind = sanitizeText(payload.kind) || "estabelecimento";

  if (!name || !phone) {
    sendJson(res, 400, { error: "Preencha nome e telefone." });
    return;
  }

  const lead = {
    id: "lead-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    name,
    phone,
    kind,
    status: "pendente",
    createdAt: new Date().toISOString()
  };

  insertPartnerLeadRow(lead);
  sendJson(res, 201, { lead });
}

async function handleAdminListPartnerLeads(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const status = sanitizeText(urlObject.searchParams.get("status"));
  sendJson(res, 200, { leads: getPartnerLeadsByStatus(status) });
}

async function handleAdminUpdatePartnerLeadStatus(req, res, leadId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const status = sanitizeText(payload.status);

  if (["aprovado", "recusado", "pendente"].indexOf(status) < 0) {
    sendJson(res, 400, { error: "Status inválido." });
    return;
  }

  updatePartnerLeadStatusRow(leadId, status);
  sendJson(res, 200, { ok: true });
}

// -------------------------------------------------------------------------
// Painel geral do administrador (visão da plataforma inteira): números do
// dia, pedidos recentes de qualquer loja e pedidos pendentes de aprovação.
// -------------------------------------------------------------------------

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

async function handleAdminDashboard(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const today = dateKey(new Date());
  const yesterday = dateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const todayOrdersRow = db
    .prepare(
      "SELECT COUNT(*) as c, COALESCE(SUM(total), 0) as gmv FROM orders WHERE substr(created_at,1,10) = ? AND status != 'Cancelado'"
    )
    .get(today);
  const yesterdayOrdersRow = db
    .prepare(
      "SELECT COUNT(*) as c, COALESCE(SUM(total), 0) as gmv FROM orders WHERE substr(created_at,1,10) = ? AND status != 'Cancelado'"
    )
    .get(yesterday);

  const todayUsersRow = db
    .prepare("SELECT COUNT(*) as c FROM customers WHERE substr(created_at,1,10) = ?")
    .get(today);
  const yesterdayUsersRow = db
    .prepare("SELECT COUNT(*) as c FROM customers WHERE substr(created_at,1,10) = ?")
    .get(yesterday);

  function pctChange(current, previous) {
    if (!previous) {
      return current > 0 ? 100 : 0;
    }
    return Math.round(((current - previous) / previous) * 100);
  }

  const storeCategoryRows = db.prepare("SELECT id, category_id FROM stores").all();
  const storeCategoryById = {};
  storeCategoryRows.forEach(function (row) {
    storeCategoryById[row.id] = row.category_id;
  });

  const todayOrderRows = db
    .prepare(
      "SELECT created_at, store_id, total FROM orders WHERE substr(created_at,1,10) = ? AND status != 'Cancelado'"
    )
    .all(today);

  const hourBuckets = {};
  todayOrderRows.forEach(function (row) {
    const hour = row.created_at.slice(11, 13);
    if (!hourBuckets[hour]) {
      hourBuckets[hour] = { hour, comida: 0, servicos: 0 };
    }
    if (storeCategoryById[row.store_id] === "servicos") {
      hourBuckets[hour].servicos += 1;
    } else {
      hourBuckets[hour].comida += 1;
    }
  });

  const ordersByHour = Object.values(hourBuckets).sort(function (a, b) {
    return a.hour.localeCompare(b.hour);
  });

  const recentOrderRows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 8").all();
  const recentOrders = recentOrderRows.map(rowToOrder).map(function (order) {
    return {
      id: order.id,
      customerName: order.customerName,
      storeName: order.storeName,
      total: order.total,
      status: order.status,
      createdAt: order.createdAt
    };
  });

  const pendingLeads = getPartnerLeadsByStatus("pendente");

  sendJson(res, 200, {
    ordersToday: todayOrdersRow.c,
    ordersTodayDeltaPct: pctChange(todayOrdersRow.c, yesterdayOrdersRow.c),
    gmvToday: todayOrdersRow.gmv,
    gmvTodayDeltaPct: pctChange(todayOrdersRow.gmv, yesterdayOrdersRow.gmv),
    newUsersToday: todayUsersRow.c,
    newUsersTodayDeltaPct: pctChange(todayUsersRow.c, yesterdayUsersRow.c),
    ordersByHour,
    recentOrders,
    pendingLeads: pendingLeads.slice(0, 6),
    pendingLeadsCount: pendingLeads.length
  });
}

async function handleAdminListOrders(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  // Sem filtro de data de propósito - o admin precisa conseguir achar (e,
  // se for o caso, estornar) um pedido antigo, não só os de hoje.
  const rows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000").all();
  sendJson(res, 200, { orders: rows.map(rowToOrder) });
}

// Diagnóstico de pagamento: mostra as últimas falhas reais do Mercado Pago
// (Pix, cartão, estorno, consulta de status), com o corpo completo da
// resposta deles. Existe porque o painel de logs do Railway às vezes não
// mostra a saída do servidor - isso aqui não depende do Railway.
async function handleAdminListPaymentErrors(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT * FROM payment_error_log ORDER BY created_at DESC LIMIT 50").all();
  sendJson(res, 200, {
    errors: rows.map(function (row) {
      return {
        id: row.id,
        orderId: row.order_id,
        kind: row.kind,
        httpStatus: row.http_status,
        message: row.message,
        rawResponse: row.raw_response,
        createdAt: row.created_at
      };
    })
  });
}

// Notificação de marketing: manda uma notificação push pra TODOS os
// clientes que já ativaram notificações (ex.: "Promoção hoje na loja X"),
// não só pra quem tem um pedido em andamento como as notificações
// automáticas de status. Fica registrado em marketing_push_log pra você
// conseguir ver o que já foi enviado e pra quantos dispositivos chegou.
async function handleAdminBroadcastPush(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const title = sanitizeText(payload.title);
  const body = sanitizeText(payload.body);
  const url = sanitizeText(payload.url) || "/home.html";

  if (!title || !body) {
    sendJson(res, 400, { error: "Informe um título e uma mensagem." });
    return;
  }

  if (!isPushEnabled()) {
    sendJson(res, 503, { error: "Notificações push não estão configuradas neste servidor." });
    return;
  }

  const subscriptions = listAllPushSubscriptions();
  const notificationPayload = JSON.stringify({ title, body, url });

  let sentCount = 0;
  let failedCount = 0;

  await Promise.all(
    subscriptions.map(async function (sub) {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };

      try {
        await webpush.sendNotification(pushSubscription, notificationPayload);
        sentCount += 1;
      } catch (error) {
        failedCount += 1;
        if (error && (error.statusCode === 404 || error.statusCode === 410)) {
          deletePushSubscriptionByEndpoint(sub.endpoint);
        }
      }
    })
  );

  const logEntry = {
    id: "mkt-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
    title,
    body,
    url,
    recipientsCount: sentCount,
    failedCount,
    createdAt: new Date().toISOString()
  };

  db.prepare(
    "INSERT INTO marketing_push_log (id, title, body, url, recipients_count, failed_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(logEntry.id, title, body, url, sentCount, failedCount, logEntry.createdAt);

  sendJson(res, 200, {
    message:
      sentCount > 0
        ? `Notificação enviada para ${sentCount} dispositivo(s).`
        : "Nenhum cliente com notificações ativadas no momento.",
    sentCount,
    failedCount
  });
}

async function handleAdminListPushBroadcasts(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT * FROM marketing_push_log ORDER BY created_at DESC LIMIT 30").all();
  sendJson(res, 200, {
    broadcasts: rows.map(function (row) {
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        url: row.url,
        recipientsCount: row.recipients_count,
        failedCount: row.failed_count,
        createdAt: row.created_at
      };
    })
  });
}

async function handleAdminListCustomers(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT * FROM customers ORDER BY created_at DESC LIMIT 300").all();
  sendJson(res, 200, {
    customers: rows.map(rowToCustomer).map(function (customer) {
      return {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        createdAt: customer.createdAt
      };
    })
  });
}

// Visão geral do faturamento da plataforma inteira (não só por loja como o
// fechamento de período já mostra) - total de pedidos, faturamento total e
// ticket médio, com filtro opcional de período (start/end, mesmo formato
// AAAA-MM-DD usado no fechamento). Sem período informado, mostra o
// acumulado desde sempre.
async function handleAdminFinance(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const periodStartDate = sanitizeText(urlObject.searchParams.get("start"));
  const periodEndDate = sanitizeText(urlObject.searchParams.get("end"));
  const hasPeriod = !!(periodStartDate && periodEndDate);

  const whereClause = hasPeriod
    ? "WHERE status != 'Cancelado' AND created_at >= ? AND created_at <= ?"
    : "WHERE status != 'Cancelado'";
  const params = hasPeriod ? [dayStartIso(periodStartDate), dayEndIso(periodEndDate)] : [];

  const rows = db
    .prepare(
      `SELECT store_id, store_name, COUNT(*) as orders, COALESCE(SUM(total), 0) as gmv
       FROM orders
       ${whereClause}
       GROUP BY store_id
       ORDER BY gmv DESC`
    )
    .all(...params);

  const totalsRow = db
    .prepare(`SELECT COUNT(*) as orders, COALESCE(SUM(total), 0) as gmv FROM orders ${whereClause}`)
    .get(...params);

  const totalOrders = totalsRow.orders;
  const totalGmv = totalsRow.gmv;
  const avgTicket = totalOrders > 0 ? Number((totalGmv / totalOrders).toFixed(2)) : 0;

  sendJson(res, 200, {
    totalOrders,
    totalGmv,
    avgTicket,
    periodStart: hasPeriod ? periodStartDate : null,
    periodEnd: hasPeriod ? periodEndDate : null,
    byStore: rows.map(function (row) {
      const storeAvgTicket = row.orders > 0 ? Number((row.gmv / row.orders).toFixed(2)) : 0;
      return {
        storeId: row.store_id,
        storeName: row.store_name,
        orders: row.orders,
        gmv: row.gmv,
        avgTicket: storeAvgTicket
      };
    })
  });
}

// -------------------------------------------------------------------------
// Comissão em faixas (marginal, igual Imposto de Renda) - em vez de uma
// única taxa fixa pra tudo, cada venda (pedido de loja, corrida de táxi ou
// atendimento de prestador) paga uma taxa maior conforme o próprio valor
// dela sobe, mas só sobre o pedaço que caiu em cada faixa - nunca sobre o
// valor inteiro de uma vez. Isso evita o "efeito penhasco" (um pedido de
// R$ 100 render menos líquido pra loja que um de R$ 99 só por ter cruzado
// uma linha). Guardado como 3 faixas por vertical (loja/táxi/prestador):
// até X → taxa 1, de X até Y → taxa 2, acima de Y → taxa 3.
// -------------------------------------------------------------------------

const COMMISSION_VERTICALS = ["store", "taxi", "provider"];

// Pontos de partida sugeridos - sempre bem abaixo do que iFood (15-26%) e
// Uber/99 (20-25%) cobram, em qualquer faixa. O admin pode ajustar cada um
// livremente pelo painel (seção Comissão de cada módulo).
const DEFAULT_COMMISSION_TIERS = {
  store: { threshold1: 40, threshold2: 100, rate1: 8, rate2: 10, rate3: 12 },
  taxi: { threshold1: 15, threshold2: 40, rate1: 8, rate2: 10, rate3: 12 },
  provider: { threshold1: 150, threshold2: 500, rate1: 8, rate2: 10, rate3: 12 }
};

function isValidCommissionVertical(vertical) {
  return COMMISSION_VERTICALS.indexOf(vertical) >= 0;
}

// Formato salvo no banco (settings.commission_tiers_<vertical>): array de 3
// faixas [{maxValue, rate}, ...], sempre crescente, com a última faixa
// maxValue = null (sem teto).
function getCommissionTiers(vertical) {
  const fallback = DEFAULT_COMMISSION_TIERS[vertical];
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("commission_tiers_" + vertical);

  if (!row || !row.value) {
    return commissionSettingToTiers(fallback);
  }

  try {
    const parsed = JSON.parse(row.value);
    if (parsed && Number.isFinite(parsed.threshold1) && Number.isFinite(parsed.threshold2)) {
      return commissionSettingToTiers(parsed);
    }
  } catch (error) {
    // Valor corrompido no banco - cai pro padrão em vez de quebrar o fechamento.
  }

  return commissionSettingToTiers(fallback);
}

function getCommissionSetting(vertical) {
  const fallback = DEFAULT_COMMISSION_TIERS[vertical];
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("commission_tiers_" + vertical);

  if (!row || !row.value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(row.value);
    if (parsed && Number.isFinite(parsed.threshold1) && Number.isFinite(parsed.threshold2)) {
      return {
        threshold1: parsed.threshold1,
        threshold2: parsed.threshold2,
        rate1: parsed.rate1,
        rate2: parsed.rate2,
        rate3: parsed.rate3
      };
    }
  } catch (error) {
    // Ignora e cai pro padrão.
  }

  return fallback;
}

function commissionSettingToTiers(setting) {
  return [
    { maxValue: setting.threshold1, rate: setting.rate1 },
    { maxValue: setting.threshold2, rate: setting.rate2 },
    { maxValue: null, rate: setting.rate3 }
  ];
}

function setCommissionTiers(vertical, setting) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("commission_tiers_" + vertical, JSON.stringify(setting));
}

// Validação genérica do payload de configuração de faixa - usada pelos 3
// endpoints (loja, táxi, prestador). Exige os 2 cortes crescentes e as 3
// taxas entre 0 e 100 - sem exigir que a taxa suba a cada faixa, porque
// mesmo um admin querendo taxa igual nas 3 (efetivamente uma taxa só) é um
// uso válido.
function validateCommissionSetting(payload) {
  const threshold1 = Number(payload.threshold1);
  const threshold2 = Number(payload.threshold2);
  const rate1 = Number(payload.rate1);
  const rate2 = Number(payload.rate2);
  const rate3 = Number(payload.rate3);

  if (!Number.isFinite(threshold1) || !Number.isFinite(threshold2) || threshold1 <= 0 || threshold2 <= threshold1) {
    return { error: "Os valores de corte devem ser maiores que zero e crescentes (ex.: 40 e depois 100)." };
  }

  const rates = [rate1, rate2, rate3];
  for (let i = 0; i < rates.length; i++) {
    if (!Number.isFinite(rates[i]) || rates[i] < 0 || rates[i] > 100) {
      return { error: "As 3 taxas devem estar entre 0 e 100." };
    }
  }

  return { value: { threshold1, threshold2, rate1, rate2, rate3 } };
}

// Calcula a comissão de UMA venda (pedido/corrida/atendimento), aplicando
// cada taxa só sobre o pedaço do valor que caiu dentro daquela faixa - o
// mesmo princípio da tabela do Imposto de Renda. Sem isso (aplicando a taxa
// da faixa em cima do valor inteiro assim que cruza o corte), um pedido um
// pouco acima do corte podia render menos líquido pra loja que um logo
// abaixo - o "efeito penhasco".
function computeTieredCommission(grossValue, tiers) {
  const value = Number(grossValue) || 0;
  if (value <= 0) {
    return 0;
  }

  const sortedTiers = tiers.slice().sort(function (a, b) {
    const aMax = a.maxValue == null ? Infinity : a.maxValue;
    const bMax = b.maxValue == null ? Infinity : b.maxValue;
    return aMax - bMax;
  });

  let commission = 0;
  let lowerBound = 0;

  for (let i = 0; i < sortedTiers.length; i++) {
    const tier = sortedTiers[i];
    const upperBound = tier.maxValue == null ? Infinity : tier.maxValue;
    if (value <= lowerBound) {
      break;
    }
    const amountInBracket = Math.min(value, upperBound) - lowerBound;
    if (amountInBracket > 0) {
      commission += (amountInBracket * tier.rate) / 100;
    }
    lowerBound = upperBound;
  }

  return Number(commission.toFixed(2));
}

async function handleGetCommissionTiers(req, res, vertical) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!isValidCommissionVertical(vertical)) {
    sendJson(res, 404, { error: "Vertical de comissão desconhecida." });
    return;
  }

  sendJson(res, 200, getCommissionSetting(vertical));
}

async function handleUpdateCommissionTiers(req, res, vertical) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!isValidCommissionVertical(vertical)) {
    sendJson(res, 404, { error: "Vertical de comissão desconhecida." });
    return;
  }

  const payload = await readRequestBody(req);
  const validated = validateCommissionSetting(payload);

  if (validated.error) {
    sendJson(res, 400, { error: validated.error });
    return;
  }

  setCommissionTiers(vertical, validated.value);
  sendJson(res, 200, validated.value);
}

// Comissão da visita técnica é separada da comissão em faixa do serviço em
// si: é um valor único e fixo (não em faixas), porque a visita normalmente
// é um valor baixo e mais parecido com um "ressarcimento de deslocamento"
// do que com o valor do serviço. Padrão 10%, editável pelo admin - mesmo
// espírito das outras taxas (dá pra reajustar quando precisar).
const DEFAULT_PROVIDER_VISIT_COMMISSION_RATE = 10;

function getProviderVisitCommissionRate() {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("provider_visit_commission_rate");
  if (!row || !row.value) {
    return DEFAULT_PROVIDER_VISIT_COMMISSION_RATE;
  }
  const parsed = Number(row.value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_PROVIDER_VISIT_COMMISSION_RATE;
}

function setProviderVisitCommissionRate(rate) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run("provider_visit_commission_rate", String(rate));
}

async function handleGetProviderVisitCommission(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }
  sendJson(res, 200, { rate: getProviderVisitCommissionRate() });
}

async function handleUpdateProviderVisitCommission(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const rate = Number(payload.rate);

  if (!(rate >= 0) || !(rate <= 100)) {
    sendJson(res, 400, { error: "Informe uma taxa entre 0 e 100." });
    return;
  }

  setProviderVisitCommissionRate(rate);
  sendJson(res, 200, { rate });
}

// -------------------------------------------------------------------------
// Fechamento de período ("quinzena") - hoje, todo pagamento online (Pix e
// cartão) cai direto na conta do Mercado Pago da plataforma, não na da
// loja. Esse relatório soma, por loja e por período, quanto foi vendido em
// dinheiro/na entrega (a loja já ficou com esse dinheiro) x quanto foi
// vendido online (a plataforma está segurando esse dinheiro) - e calcula
// quanto a plataforma deve repassar pra loja (o total online, menos a
// comissão da plataforma sobre o total geral vendido, calculada pedido a
// pedido pela tabela de faixas). Enquanto as taxas estiverem em 0%, o
// relatório já serve pra saber exatamente quanto pagar de volta pra cada
// loja.
// -------------------------------------------------------------------------

function dayStartIso(dateStr) {
  return dateStr + "T00:00:00.000Z";
}

function dayEndIso(dateStr) {
  return dateStr + "T23:59:59.999Z";
}

// Soma, por loja, os pedidos entregues e ainda não fechados dentro do
// período - sem marcar nada como fechado (usado pra pré-visualizar antes
// de confirmar, e reaproveitado no fechamento de verdade).
function computeSettlementRows(periodStart, periodEnd) {
  const tiers = getCommissionTiers("store");
  const orderRows = db
    .prepare(
      `SELECT store_id, total, payment_provider, payment_status
       FROM orders
       WHERE status = 'Entregue' AND settled_at IS NULL AND created_at >= ? AND created_at <= ?`
    )
    .all(periodStart, periodEnd);

  // Agrupa manualmente por loja (em vez de SUM no SQL) porque a comissão
  // precisa ser calculada pedido a pedido, na tabela de faixas - cada
  // pedido paga a taxa de acordo com o próprio valor dele, não com a soma
  // do período inteiro.
  const byStore = new Map();

  orderRows.forEach(function (order) {
    const isOnlinePaid = order.payment_provider === "mercadopago" && order.payment_status === "pago";
    const total = Number(order.total || 0);
    const commission = computeTieredCommission(total, tiers);

    let entry = byStore.get(order.store_id);
    if (!entry) {
      entry = { ordersCount: 0, cashTotal: 0, onlineTotal: 0, grossTotal: 0, commissionTotal: 0 };
      byStore.set(order.store_id, entry);
    }

    entry.ordersCount += 1;
    entry.grossTotal += total;
    entry.commissionTotal += commission;
    if (isOnlinePaid) {
      entry.onlineTotal += total;
    } else {
      entry.cashTotal += total;
    }
  });

  const rows = [];
  byStore.forEach(function (entry, storeId) {
    const grossTotal = Number(entry.grossTotal.toFixed(2));
    const commissionTotal = Number(entry.commissionTotal.toFixed(2));
    const onlineTotal = Number(entry.onlineTotal.toFixed(2));
    const cashTotal = Number(entry.cashTotal.toFixed(2));
    const netAmount = Number((onlineTotal - commissionTotal).toFixed(2));
    const storeRow = db.prepare("SELECT name, balance FROM stores WHERE id = ?").get(storeId);
    const currentBalance = storeRow ? Number(storeRow.balance || 0) : 0;
    // Taxa média efetiva desse fechamento (informativo) - já que agora a
    // taxa varia por pedido, não existe mais "uma" taxa fixa pra mostrar.
    const commissionPercent = grossTotal > 0 ? Number(((commissionTotal / grossTotal) * 100).toFixed(2)) : 0;

    rows.push({
      storeId,
      storeName: storeRow ? storeRow.name : storeId,
      ordersCount: entry.ordersCount,
      cashTotal,
      onlineTotal,
      grossTotal,
      commissionPercent,
      commissionTotal,
      netAmount,
      currentBalance,
      balanceAfter: Number((currentBalance + netAmount).toFixed(2))
    });
  });

  return rows;
}

async function handleSettlementPreview(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const periodStartDate = sanitizeText(urlObject.searchParams.get("start"));
  const periodEndDate = sanitizeText(urlObject.searchParams.get("end"));

  if (!periodStartDate || !periodEndDate) {
    sendJson(res, 400, { error: "Informe o início e o fim do período." });
    return;
  }

  const rows = computeSettlementRows(dayStartIso(periodStartDate), dayEndIso(periodEndDate));
  sendJson(res, 200, { settlements: rows });
}

async function handleSettlementClose(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const periodStartDate = sanitizeText(payload.start);
  const periodEndDate = sanitizeText(payload.end);

  if (!periodStartDate || !periodEndDate) {
    sendJson(res, 400, { error: "Informe o início e o fim do período." });
    return;
  }

  const periodStart = dayStartIso(periodStartDate);
  const periodEnd = dayEndIso(periodEndDate);
  const rows = computeSettlementRows(periodStart, periodEnd);

  if (!rows.length) {
    sendJson(res, 400, { error: "Não há pedidos entregues e ainda não fechados nesse período." });
    return;
  }

  const now = new Date().toISOString();
  const closed = rows.map(function (row) {
    const settlementId = "settlement-" + Date.now() + "-" + Math.floor(Math.random() * 1000) + "-" + row.storeId;

    db.prepare(
      `INSERT INTO store_settlements (
         id, store_id, period_start, period_end, orders_count, cash_total, online_total,
         gross_total, commission_percent, commission_total, net_amount, balance_after, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settlementId,
      row.storeId,
      periodStart,
      periodEnd,
      row.ordersCount,
      row.cashTotal,
      row.onlineTotal,
      row.grossTotal,
      row.commissionPercent,
      row.commissionTotal,
      row.netAmount,
      row.balanceAfter,
      now
    );

    db.prepare("UPDATE stores SET balance = ? WHERE id = ?").run(row.balanceAfter, row.storeId);

    db.prepare(
      `UPDATE orders SET settled_at = ?
       WHERE store_id = ? AND status = 'Entregue' AND settled_at IS NULL
         AND created_at >= ? AND created_at <= ?`
    ).run(now, row.storeId, periodStart, periodEnd);

    return Object.assign({}, row, { id: settlementId, periodStart, periodEnd });
  });

  sendJson(res, 200, { settlements: closed });
}

async function handleListSettlements(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const storeId = sanitizeText(urlObject.searchParams.get("storeId"));
  const baseQuery =
    "SELECT store_settlements.*, stores.name AS store_name FROM store_settlements " +
    "LEFT JOIN stores ON stores.id = store_settlements.store_id";
  const rows = storeId
    ? db.prepare(baseQuery + " WHERE store_id = ? ORDER BY created_at DESC LIMIT 100").all(storeId)
    : db.prepare(baseQuery + " ORDER BY created_at DESC LIMIT 200").all();

  sendJson(res, 200, {
    settlements: rows.map(function (row) {
      return {
        id: row.id,
        storeId: row.store_id,
        storeName: row.store_name || row.store_id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        ordersCount: row.orders_count,
        cashTotal: row.cash_total,
        onlineTotal: row.online_total,
        grossTotal: row.gross_total,
        commissionPercent: row.commission_percent,
        commissionTotal: row.commission_total,
        netAmount: row.net_amount,
        balanceAfter: row.balance_after,
        createdAt: row.created_at
      };
    })
  });
}

async function handleListStoreBalances(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT id, name, balance FROM stores ORDER BY name ASC").all();
  sendJson(res, 200, {
    balances: rows.map(function (row) {
      return { storeId: row.id, storeName: row.name, balance: Number(row.balance || 0) };
    })
  });
}

// Ajuste manual de saldo, pra registrar um pagamento feito pra loja (ou
// recebido dela) por fora do fechamento automático - ex.: você fez um Pix
// pra loja com o valor que estava devendo. "payout" tira do saldo (você
// pagou, diminui o que ainda deve); "collection" soma (a loja te pagou
// algo que ela devia).
async function handleCreateBalanceAdjustment(req, res, storeId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!storeExists(storeId)) {
    sendJson(res, 404, { error: "Loja não encontrada." });
    return;
  }

  const payload = await readRequestBody(req);
  const type = payload.type === "collection" ? "collection" : "payout";
  const amount = Math.abs(Number(payload.amount) || 0);
  const note = sanitizeText(payload.note).slice(0, 300);

  if (!amount) {
    sendJson(res, 400, { error: "Informe um valor maior que zero." });
    return;
  }

  const storeRow = db.prepare("SELECT balance FROM stores WHERE id = ?").get(storeId);
  const signedAmount = type === "payout" ? -amount : amount;
  const balanceAfter = Number((Number(storeRow.balance || 0) + signedAmount).toFixed(2));

  db.prepare("UPDATE stores SET balance = ? WHERE id = ?").run(balanceAfter, storeId);
  db.prepare(
    "INSERT INTO store_balance_adjustments (id, store_id, amount, note, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "adjustment-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    storeId,
    signedAmount,
    (type === "payout" ? "Repasse pra loja" : "Recebimento da loja") + (note ? " - " + note : ""),
    balanceAfter,
    new Date().toISOString()
  );

  sendJson(res, 200, { balance: balanceAfter });
}

// -------------------------------------------------------------------------
// Prestadores de serviço (Fase 7-9): login, serviços/preços, solicitações
// de orçamento vindas do cliente, agenda de atendimentos, ganhos e
// avaliações. Modelo separado de lojas/pedidos porque o fluxo é diferente
// (orçamento sob consulta + agendamento, em vez de carrinho/checkout).
// -------------------------------------------------------------------------

function rowToProvider(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    name: row.name,
    specialty: row.specialty,
    phone: row.phone,
    isAvailable: !!row.is_available,
    email: row.email || "",
    cpf: row.cpf || "",
    criminalRecordFile: row.criminal_record_file || "",
    criminalRecordVerified: !!row.criminal_record_verified,
    balance: Number(row.balance || 0),
    visitFee: Number(row.visit_fee || 0),
    createdAt: row.created_at
  };
}

function findProviderByUsername(username) {
  return rowToProvider(db.prepare("SELECT * FROM service_providers WHERE username = ?").get(username));
}

function findProviderById(id) {
  return rowToProvider(db.prepare("SELECT * FROM service_providers WHERE id = ?").get(id));
}

function findProviderByEmail(email) {
  if (!email) {
    return null;
  }
  return rowToProvider(db.prepare("SELECT * FROM service_providers WHERE email = ?").get(email));
}

function updateProviderPasswordHash(providerId, passwordHash) {
  db.prepare("UPDATE service_providers SET password_hash = ? WHERE id = ?").run(passwordHash, providerId);
}

function getProviderRatingSummary(providerId) {
  const row = db
    .prepare("SELECT COUNT(*) AS count, AVG(rating) AS avg FROM provider_reviews WHERE provider_id = ?")
    .get(providerId);
  return {
    avgRating: row.count ? Number(row.avg.toFixed(2)) : null,
    reviewsCount: row.count
  };
}

// Observação sobre "avaliação interna": a nota média já aparecia
// publicamente antes desta feature (busca/home mostram ★ do prestador,
// igual loja) - isso eu mantive. O que fica interno (só o prestador vê no
// painel dele e o admin vê no painel dele) é o COMENTÁRIO de cada
// avaliação individual - esse nunca teve, e continua sem ter, uma vitrine
// pública.
function getPublicProvider(provider) {
  const rating = getProviderRatingSummary(provider.id);
  return {
    id: provider.id,
    name: provider.name,
    specialty: provider.specialty,
    isAvailable: provider.isAvailable,
    avgRating: rating.avgRating,
    reviewsCount: rating.reviewsCount,
    antecedentesVerified: !!provider.criminalRecordVerified,
    visitFee: Number(provider.visitFee || 0)
  };
}

function rowToProviderService(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    price: row.price,
    createdAt: row.created_at
  };
}

function getProviderServices(providerId) {
  return db
    .prepare("SELECT * FROM provider_services WHERE provider_id = ? ORDER BY created_at ASC")
    .all(providerId)
    .map(rowToProviderService);
}

function rowToBudgetRequest(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    locationLabel: row.location_label,
    message: row.message,
    status: row.status,
    quotedPrice: row.quoted_price,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function findBudgetRequestById(id) {
  const row = db.prepare("SELECT * FROM budget_requests WHERE id = ?").get(id);
  return row ? rowToBudgetRequest(row) : null;
}

function rowToProviderMessage(row) {
  return {
    id: row.id,
    budgetRequestId: row.budget_request_id,
    senderType: row.sender_type,
    body: row.body,
    createdAt: row.created_at
  };
}

// Toda mensagem da conversa passa por aqui - tanto as digitadas por
// cliente/prestador quanto as automáticas ("system"), que narram o trâmite
// (orçamento enviado, recusado, atendimento concluído etc.) direto no fio
// da conversa, sem precisar de um lugar separado pra mostrar status.
function insertProviderMessage(budgetRequestId, senderType, body) {
  const trimmedBody = sanitizeText(body).slice(0, 2000);
  if (!trimmedBody) {
    return null;
  }

  const message = {
    id: "msg-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    budgetRequestId,
    senderType,
    body: trimmedBody,
    createdAt: new Date().toISOString()
  };

  db.prepare(
    "INSERT INTO provider_messages (id, budget_request_id, sender_type, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(message.id, message.budgetRequestId, message.senderType, message.body, message.createdAt);

  return message;
}

function listProviderMessages(budgetRequestId) {
  return db
    .prepare("SELECT * FROM provider_messages WHERE budget_request_id = ? ORDER BY created_at ASC")
    .all(budgetRequestId)
    .map(rowToProviderMessage);
}

function findBookingByBudgetRequestId(budgetRequestId) {
  const row = db
    .prepare("SELECT * FROM provider_bookings WHERE budget_request_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(budgetRequestId);
  return row ? rowToProviderBooking(row) : null;
}

// Um mesmo pedido de orçamento pode ter até duas cobranças: a visita
// técnica (opcional) e o serviço em si - por isso o trâmite completo
// precisa da lista inteira, em ordem cronológica, não só a mais recente.
function listBookingsByBudgetRequestId(budgetRequestId) {
  return db
    .prepare("SELECT * FROM provider_bookings WHERE budget_request_id = ? ORDER BY created_at ASC")
    .all(budgetRequestId)
    .map(rowToProviderBooking);
}

function findLatestVisitBooking(budgetRequestId) {
  const row = db
    .prepare(
      "SELECT * FROM provider_bookings WHERE budget_request_id = ? AND kind = 'visita' ORDER BY created_at DESC LIMIT 1"
    )
    .get(budgetRequestId);
  return row ? rowToProviderBooking(row) : null;
}

function rowToProviderBooking(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    budgetRequestId: row.budget_request_id,
    customerName: row.customer_name,
    serviceName: row.service_name,
    locationLabel: row.location_label,
    scheduledAt: row.scheduled_at,
    price: row.price,
    status: row.status,
    kind: row.kind || "servico",
    createdAt: row.created_at,
    paymentStatus: row.payment_status || "nao_aplicavel",
    paymentProvider: row.payment_provider || "",
    paymentDetail: row.payment_detail || "",
    mpOrderId: row.mp_order_id || "",
    pixQrCode: row.pix_qr_code || "",
    pixQrCodeBase64: row.pix_qr_code_base64 || "",
    pixTicketUrl: row.pix_ticket_url || "",
    settledAt: row.settled_at || null
  };
}

function findBookingById(bookingId) {
  const row = db.prepare("SELECT * FROM provider_bookings WHERE id = ?").get(bookingId);
  return row ? rowToProviderBooking(row) : null;
}

function findBookingByMpOrderId(mpOrderId) {
  const row = db.prepare("SELECT * FROM provider_bookings WHERE mp_order_id = ?").get(mpOrderId);
  return row ? rowToProviderBooking(row) : null;
}

function updateBookingPaymentRow(bookingId, fields) {
  const sets = [];
  const values = [];

  ["paymentStatus", "paymentProvider", "paymentDetail", "mpOrderId", "pixQrCode", "pixQrCodeBase64", "pixTicketUrl"].forEach(
    function (key) {
      if (!(key in fields)) {
        return;
      }
      const column = {
        paymentStatus: "payment_status",
        paymentProvider: "payment_provider",
        paymentDetail: "payment_detail",
        mpOrderId: "mp_order_id",
        pixQrCode: "pix_qr_code",
        pixQrCodeBase64: "pix_qr_code_base64",
        pixTicketUrl: "pix_ticket_url"
      }[key];
      sets.push(column + " = ?");
      values.push(fields[key]);
    }
  );

  if (!sets.length) {
    return;
  }

  values.push(bookingId);
  db.prepare(`UPDATE provider_bookings SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

// Consulta pública do atendimento (sem exigir login do cliente, que hoje
// nem existe pra esse fluxo - o cliente só tem o ID do agendamento, que
// recebeu junto com a confirmação do orçamento). Mesmo padrão já usado em
// GET /api/orders/:id: o ID em si já funciona como a "senha" de acesso.
async function handleGetProviderBooking(req, res, bookingId) {
  const booking = findBookingById(bookingId);

  if (!booking) {
    sendJson(res, 404, { error: "Atendimento não encontrado." });
    return;
  }

  const provider = findProviderById(booking.providerId);
  const existingReview = db.prepare("SELECT id FROM provider_reviews WHERE booking_id = ?").get(bookingId);

  sendJson(res, 200, {
    booking,
    providerName: provider ? provider.name : "",
    alreadyReviewed: !!existingReview
  });
}

// Avaliação do cliente sobre o prestador, depois do serviço concluído -
// nota (1 a 5) + comentário opcional. Fica interna (só o prestador, no
// painel dele, e o admin veem o comentário) - não tem vitrine pública.
// Mesmo esquema de acesso sem login das outras rotas de atendimento: o ID
// do booking na URL é a "senha".
async function handleCreateProviderReview(req, res, bookingId) {
  const booking = findBookingById(bookingId);

  if (!booking) {
    sendJson(res, 404, { error: "Atendimento não encontrado." });
    return;
  }

  if (booking.kind === "visita") {
    sendJson(res, 400, { error: "A avaliação é só depois do serviço concluído, não da visita." });
    return;
  }

  if (booking.status !== "concluido") {
    sendJson(res, 400, { error: "Esse atendimento ainda não foi concluído." });
    return;
  }

  const existingReview = db.prepare("SELECT id FROM provider_reviews WHERE booking_id = ?").get(bookingId);
  if (existingReview) {
    sendJson(res, 400, { error: "Esse atendimento já foi avaliado." });
    return;
  }

  const payload = await readRequestBody(req);
  const rating = Math.round(Number(payload.rating));
  const comment = sanitizeText(payload.comment).slice(0, 1000);

  if (!(rating >= 1) || !(rating <= 5)) {
    sendJson(res, 400, { error: "Dê uma nota de 1 a 5." });
    return;
  }

  const review = {
    id: "review-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    providerId: booking.providerId,
    bookingId: booking.id,
    customerName: booking.customerName,
    rating,
    comment,
    createdAt: new Date().toISOString()
  };

  db.prepare(
    `INSERT INTO provider_reviews (id, provider_id, booking_id, customer_name, rating, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(review.id, review.providerId, review.bookingId, review.customerName, review.rating, review.comment, review.createdAt);

  if (booking.budgetRequestId) {
    insertProviderMessage(
      booking.budgetRequestId,
      "system",
      "Cliente avaliou o atendimento: " + "★".repeat(rating) + "☆".repeat(5 - rating) + "."
    );
  }

  sendJson(res, 201, { review });
}

async function handleCreateBookingPixPayment(req, res) {
  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online ainda não foi configurado neste servidor." });
    return;
  }

  const payload = await readRequestBody(req);
  const bookingId = sanitizeText(payload.bookingId);
  const payerEmail = normalizeEmail(payload.payerEmail) || "cliente@alloo.com";
  const booking = findBookingById(bookingId);

  if (!booking) {
    sendJson(res, 404, { error: "Atendimento não encontrado." });
    return;
  }

  if (booking.paymentStatus === "pago") {
    sendJson(res, 400, { error: "Esse atendimento já está pago." });
    return;
  }

  if (booking.status === "cancelado") {
    sendJson(res, 400, { error: "Esse atendimento foi cancelado." });
    return;
  }

  const amount = Number(booking.price || 0).toFixed(2);

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", "/v1/orders", {
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: booking.id,
      notification_url: getPaymentWebhookUrl(req),
      payer: { email: payerEmail },
      transactions: {
        payments: [
          {
            amount,
            payment_method: { id: "pix", type: "bank_transfer" }
          }
        ]
      }
    });
  } catch (error) {
    logPaymentError("booking-pix-network", booking.id, null, { message: error && error.message });
    sendJson(res, 503, { error: "Não foi possível falar com o Mercado Pago agora." });
    return;
  }

  if (!mpResponse.ok) {
    logPaymentError("booking-pix", booking.id, mpResponse.status, mpResponse.data);
    sendJson(res, 400, {
      error: extractMercadoPagoErrorReason(mpResponse.data) || "Não foi possível gerar a cobrança Pix."
    });
    return;
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentMethodData = transaction.payment_method || {};

  updateBookingPaymentRow(booking.id, {
    paymentProvider: "mercadopago",
    paymentStatus: "pendente",
    paymentDetail: mpResponse.data.status_detail || "",
    mpOrderId: mpResponse.data.id || "",
    pixQrCode: paymentMethodData.qr_code || "",
    pixQrCodeBase64: paymentMethodData.qr_code_base64 || "",
    pixTicketUrl: paymentMethodData.ticket_url || ""
  });

  sendJson(res, 200, {
    qrCode: paymentMethodData.qr_code || "",
    qrCodeBase64: paymentMethodData.qr_code_base64 || "",
    ticketUrl: paymentMethodData.ticket_url || "",
    paymentStatus: "pendente"
  });
}

async function handleCreateBookingCardPayment(req, res) {
  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online ainda não foi configurado neste servidor." });
    return;
  }

  const payload = await readRequestBody(req);
  const bookingId = sanitizeText(payload.bookingId);
  const token = sanitizeText(payload.token);
  const paymentMethodId = sanitizeText(payload.paymentMethodId);
  const paymentTypeId = sanitizeText(payload.paymentTypeId) === "debit_card" ? "debit_card" : "credit_card";
  const installments = Math.max(1, Number(payload.installments) || 1);
  const payerEmail = normalizeEmail(payload.payerEmail) || "cliente@alloo.com";
  const booking = findBookingById(bookingId);

  if (!booking) {
    sendJson(res, 404, { error: "Atendimento não encontrado." });
    return;
  }

  if (!token || !paymentMethodId) {
    sendJson(res, 400, { error: "Dados do cartão incompletos." });
    return;
  }

  if (booking.paymentStatus === "pago") {
    sendJson(res, 400, { error: "Esse atendimento já está pago." });
    return;
  }

  if (booking.status === "cancelado") {
    sendJson(res, 400, { error: "Esse atendimento foi cancelado." });
    return;
  }

  const amount = Number(booking.price || 0).toFixed(2);

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", "/v1/orders", {
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: booking.id,
      notification_url: getPaymentWebhookUrl(req),
      payer: { email: payerEmail },
      transactions: {
        payments: [
          {
            amount,
            payment_method: {
              id: paymentMethodId,
              type: paymentTypeId,
              token,
              installments
            }
          }
        ]
      }
    });
  } catch (error) {
    logPaymentError("booking-card-network", booking.id, null, { message: error && error.message });
    sendJson(res, 503, { error: "Não foi possível falar com o Mercado Pago agora." });
    return;
  }

  if (!mpResponse.ok) {
    logPaymentError("booking-card", booking.id, mpResponse.status, mpResponse.data);
    sendJson(res, 400, {
      error: extractMercadoPagoErrorReason(mpResponse.data) || "O pagamento não foi aprovado."
    });
    return;
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentStatus = mapMercadoPagoStatusToPaymentStatus(mpResponse.data, transaction);

  updateBookingPaymentRow(booking.id, {
    paymentProvider: "mercadopago",
    paymentStatus,
    paymentDetail: transaction.status_detail || mpResponse.data.status_detail || "",
    mpOrderId: mpResponse.data.id || ""
  });
  notifyBookingPaidIfNeeded(booking, booking.paymentStatus, paymentStatus);

  sendJson(res, paymentStatus === "recusado" ? 400 : 200, {
    paymentStatus,
    detail: transaction.status_detail || mpResponse.data.status_detail || ""
  });
}

// Cliente escolhe pagar em dinheiro, direto com o prestador (sem passar
// pelo app) - mesma ideia de "Dinheiro" já disponível pra pedido de loja e
// corrida de táxi. Só vale pro atendimento em si ('servico'): a visita
// técnica continua exigindo pagamento pelo app antes de ser liberada,
// igual já trava handleProviderUpdateBookingStatus ao marcar como
// concluída. Não marca como "pago" de verdade (o dinheiro ainda não
// passou pelo Alloo) - usa "combinado" pra distinguir dos pagamentos
// online, mas isso já é suficiente pra computeProviderSettlementRows
// bucketar certo como dinheiro (só considera "online" quando o provider é
// "mercadopago" e o status é "pago").
async function handleChooseBookingCashPayment(req, res) {
  const payload = await readRequestBody(req);
  const bookingId = sanitizeText(payload.bookingId);
  const booking = findBookingById(bookingId);

  if (!booking) {
    sendJson(res, 404, { error: "Atendimento não encontrado." });
    return;
  }

  if (booking.kind === "visita") {
    sendJson(res, 400, { error: "A visita técnica precisa ser paga pelo app, não dá pra combinar em dinheiro." });
    return;
  }

  if (booking.paymentStatus === "pago" || booking.paymentStatus === "combinado") {
    sendJson(res, 400, { error: "Esse atendimento já está pago." });
    return;
  }

  if (booking.status === "cancelado") {
    sendJson(res, 400, { error: "Esse atendimento foi cancelado." });
    return;
  }

  updateBookingPaymentRow(booking.id, {
    paymentProvider: "dinheiro",
    paymentStatus: "combinado"
  });

  if (booking.budgetRequestId) {
    insertProviderMessage(
      booking.budgetRequestId,
      "system",
      "Cliente combinou de pagar o atendimento em dinheiro, direto com você, no dia do serviço."
    );
  }

  sendJson(res, 200, { paymentStatus: "combinado" });
}

// Avisa no chat assim que um pagamento (visita ou serviço) é confirmado -
// tanto o cliente quanto o prestador enxergam na hora, sem precisar ficar
// atualizando a tela pra saber se já caiu.
function notifyBookingPaidIfNeeded(booking, previousPaymentStatus, newPaymentStatus) {
  if (newPaymentStatus !== "pago" || previousPaymentStatus === "pago" || !booking.budgetRequestId) {
    return;
  }
  insertProviderMessage(
    booking.budgetRequestId,
    "system",
    booking.kind === "visita" ? "Pagamento da visita técnica confirmado." : "Pagamento do atendimento confirmado."
  );
}

// Mesma ideia de syncOrderPaymentStatusFromMercadoPago/syncRidePaymentStatusFromMercadoPago,
// só que pro agendamento de prestador - chamado pelo webhook quando o
// Mercado Pago avisa sozinho que o status de uma cobrança mudou.
async function syncBookingPaymentStatusFromMercadoPago(booking) {
  if (!booking.mpOrderId) {
    return { synced: false, reason: "Atendimento não tem cobrança do Mercado Pago associada." };
  }

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("GET", "/v1/orders/" + encodeURIComponent(booking.mpOrderId));
  } catch (error) {
    logPaymentError("booking-sync-status-network", booking.id, null, { message: error && error.message });
    return { synced: false, reason: "Não foi possível falar com o Mercado Pago agora." };
  }

  if (!mpResponse.ok) {
    logPaymentError("booking-sync-status", booking.id, mpResponse.status, mpResponse.data);
    return { synced: false, reason: extractMercadoPagoErrorReason(mpResponse.data) || "O Mercado Pago não respondeu." };
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentStatus = mapMercadoPagoStatusToPaymentStatus(mpResponse.data, transaction);

  updateBookingPaymentRow(booking.id, {
    paymentStatus,
    paymentDetail: transaction.status_detail || mpResponse.data.status_detail || ""
  });
  notifyBookingPaidIfNeeded(booking, booking.paymentStatus, paymentStatus);

  return { synced: true, paymentStatus, booking: findBookingById(booking.id) };
}

function rowToProviderReview(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    bookingId: row.booking_id,
    customerName: row.customer_name,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at
  };
}

function startOfWeekProvider(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  clone.setDate(clone.getDate() - clone.getDay());
  return clone;
}

async function handleProviderLogin(req, res) {
  const payload = await readRequestBody(req);
  const username = sanitizeText(payload.username);
  const password = sanitizeText(payload.password);
  const provider = findProviderByUsername(username);

  if (!provider || !verifyPassword(password, provider.passwordHash)) {
    sendJson(res, 401, { error: "Usuário ou senha inválidos." });
    return;
  }

  const token = createProviderSession(provider);
  sendJson(res, 200, { provider: getPublicProvider(provider), token });
}

async function handleProviderDashboard(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const providerId = session.providerId;
  const provider = findProviderById(providerId);
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = startOfWeekProvider(new Date());

  const bookingRows = db
    .prepare("SELECT * FROM provider_bookings WHERE provider_id = ? AND status != 'cancelado'")
    .all(providerId);

  const ganhosSemana = bookingRows
    .filter(function (row) {
      return new Date(row.scheduled_at) >= weekStart;
    })
    .reduce(function (total, row) {
      return total + Number(row.price || 0);
    }, 0);

  const agendaHoje = bookingRows
    .filter(function (row) {
      return String(row.scheduled_at).slice(0, 10) === today;
    })
    .sort(function (a, b) {
      return new Date(a.scheduled_at) - new Date(b.scheduled_at);
    })
    .map(rowToProviderBooking);

  const allRequests = db.prepare("SELECT * FROM budget_requests WHERE provider_id = ?").all(providerId);
  const respondedCount = allRequests.filter(function (row) {
    return row.status !== "aguardando";
  }).length;
  const taxaResposta = allRequests.length ? Math.round((respondedCount / allRequests.length) * 100) : null;

  // Além dos pedidos ainda sem resposta, também volta pra essa lista o
  // pedido que teve visita técnica pedida E já concluída - é o sinal de que
  // o prestador precisa voltar lá e mandar o orçamento final do serviço.
  // Enquanto a visita ainda não foi feita, o pedido fica só na agenda,
  // esperando o dia marcado.
  const pendentes = allRequests
    .filter(function (row) {
      if (row.status === "aguardando") {
        return true;
      }
      if (row.status === "visita_solicitada") {
        const visitBooking = findLatestVisitBooking(row.id);
        return !!visitBooking && visitBooking.status === "concluido";
      }
      return false;
    })
    .sort(function (a, b) {
      return new Date(b.created_at) - new Date(a.created_at);
    })
    .map(function (row) {
      const request = rowToBudgetRequest(row);
      request.awaitingQuoteAfterVisit = row.status === "visita_solicitada";
      return request;
    });

  const ratingSummary = getProviderRatingSummary(providerId);
  const servicosConcluidos = db
    .prepare("SELECT COUNT(*) AS total FROM provider_bookings WHERE provider_id = ? AND status = 'concluido'")
    .get(providerId).total;

  sendJson(res, 200, {
    provider: getPublicProvider(provider),
    ganhosSemana,
    taxaResposta,
    agendaHoje,
    solicitacoesPendentes: pendentes,
    solicitacoesPendentesCount: pendentes.length,
    servicos: getProviderServices(providerId),
    avgRating: ratingSummary.avgRating,
    reviewsCount: ratingSummary.reviewsCount,
    servicosConcluidos
  });
}

async function handleProviderUpsertService(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const name = sanitizeText(payload.name);

  // O preço não é definido aqui de propósito - o serviço no catálogo é só o
  // nome do que o prestador oferece. O valor cobrado é decidido depois, caso
  // a caso, quando o prestador responde ao pedido de orçamento do cliente
  // (ação "orcamento" em handleProviderRespondToBudgetRequest).
  if (!name) {
    sendJson(res, 400, { error: "Preencha o nome do serviço." });
    return;
  }

  const id = sanitizeText(payload.id);
  const now = new Date().toISOString();

  if (id) {
    const existing = db
      .prepare("SELECT * FROM provider_services WHERE id = ? AND provider_id = ?")
      .get(id, session.providerId);

    if (!existing) {
      sendJson(res, 404, { error: "Serviço não encontrado." });
      return;
    }

    db.prepare("UPDATE provider_services SET name = ? WHERE id = ?").run(name, id);
  } else {
    db.prepare(
      "INSERT INTO provider_services (id, provider_id, name, price, created_at) VALUES (?, ?, ?, 0, ?)"
    ).run("service-" + Date.now() + "-" + Math.floor(Math.random() * 1000), session.providerId, name, now);
  }

  sendJson(res, 200, { services: getProviderServices(session.providerId) });
}

async function handleProviderDeleteService(req, res, serviceId) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  db.prepare("DELETE FROM provider_services WHERE id = ? AND provider_id = ?").run(serviceId, session.providerId);
  sendJson(res, 200, { services: getProviderServices(session.providerId) });
}

async function handleProviderSetAvailability(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const isAvailable = !!payload.isAvailable;

  db.prepare("UPDATE service_providers SET is_available = ? WHERE id = ?").run(isAvailable ? 1 : 0, session.providerId);
  sendJson(res, 200, { isAvailable });
}

// Valor fixo que o prestador cobra pra ir avaliar o serviço pessoalmente
// antes de fechar o orçamento final. Zero = não cobra visita (continua
// podendo mandar o orçamento direto, como sempre funcionou).
async function handleProviderSetVisitFee(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const visitFee = Number(payload.visitFee);

  if (!(visitFee >= 0)) {
    sendJson(res, 400, { error: "Informe um valor válido (0 se não cobra visita)." });
    return;
  }

  db.prepare("UPDATE service_providers SET visit_fee = ? WHERE id = ?").run(visitFee, session.providerId);
  sendJson(res, 200, { visitFee });
}

async function handleProviderRespondToBudgetRequest(req, res, requestId) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const requestRow = db
    .prepare("SELECT * FROM budget_requests WHERE id = ? AND provider_id = ?")
    .get(requestId, session.providerId);

  if (!requestRow) {
    sendJson(res, 404, { error: "Solicitação não encontrada." });
    return;
  }

  // "aguardando" é o estado inicial (pode recusar, pedir visita ou já
  // mandar o orçamento direto). "visita_solicitada" é depois de pedir uma
  // visita técnica - o prestador ainda pode recusar (desistir do serviço)
  // ou, depois da visita concluída, mandar o orçamento final.
  if (["aguardando", "visita_solicitada"].indexOf(requestRow.status) < 0) {
    sendJson(res, 400, { error: "Essa solicitação já foi respondida." });
    return;
  }

  const payload = await readRequestBody(req);
  const action = sanitizeText(payload.action);
  const now = new Date().toISOString();

  if (action === "recusar") {
    db.prepare("UPDATE budget_requests SET status = 'recusado', updated_at = ? WHERE id = ?").run(now, requestId);
    insertProviderMessage(requestId, "system", "O prestador não vai conseguir atender esse pedido dessa vez.");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (action === "visita") {
    if (requestRow.status !== "aguardando") {
      sendJson(res, 400, { error: "A visita já foi pedida pra esse atendimento." });
      return;
    }

    const scheduledAt = sanitizeText(payload.scheduledAt);
    if (!scheduledAt) {
      sendJson(res, 400, { error: "Informe a data/hora da visita." });
      return;
    }

    const providerRow = db.prepare("SELECT * FROM service_providers WHERE id = ?").get(session.providerId);
    const visitFee = Number((providerRow && providerRow.visit_fee) || 0);

    db.prepare("UPDATE budget_requests SET status = 'visita_solicitada', updated_at = ? WHERE id = ?").run(
      now,
      requestId
    );

    const bookingId = "booking-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    db.prepare(
      `INSERT INTO provider_bookings
       (id, provider_id, budget_request_id, customer_name, service_name, location_label, scheduled_at, price, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agendado', 'visita', ?)`
    ).run(
      bookingId,
      session.providerId,
      requestId,
      requestRow.customer_name,
      "Visita técnica",
      requestRow.location_label || "",
      scheduledAt,
      visitFee,
      now
    );

    const visitDateForMessage = new Date(scheduledAt);
    const visitLabel = isNaN(visitDateForMessage.getTime())
      ? scheduledAt
      : visitDateForMessage.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    insertProviderMessage(
      requestId,
      "system",
      visitFee > 0
        ? "Prestador quer visitar o local antes de fechar o orçamento. Visita: R$ " +
            visitFee.toFixed(2).replace(".", ",") +
            " para " +
            visitLabel +
            ". Assim que o cliente pagar, a visita entra confirmada."
        : "Prestador quer visitar o local antes de fechar o orçamento, sem cobrar pela visita. Agendada para " +
            visitLabel +
            "."
    );

    sendJson(res, 200, {
      ok: true,
      booking: rowToProviderBooking(db.prepare("SELECT * FROM provider_bookings WHERE id = ?").get(bookingId))
    });
    return;
  }

  if (action === "orcamento") {
    if (requestRow.status === "visita_solicitada") {
      const visitBooking = findLatestVisitBooking(requestId);
      if (!visitBooking || visitBooking.status !== "concluido") {
        sendJson(res, 400, { error: "Aguarde a visita técnica ser concluída antes de enviar o orçamento final." });
        return;
      }
    }

    const price = Number(payload.price);
    const scheduledAt = sanitizeText(payload.scheduledAt);

    if (!(price > 0) || !scheduledAt) {
      sendJson(res, 400, { error: "Informe o preço e a data/hora do atendimento." });
      return;
    }

    db.prepare(
      "UPDATE budget_requests SET status = 'orcamento_enviado', quoted_price = ?, updated_at = ? WHERE id = ?"
    ).run(price, now, requestId);

    const bookingId = "booking-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
    db.prepare(
      `INSERT INTO provider_bookings
       (id, provider_id, budget_request_id, customer_name, service_name, location_label, scheduled_at, price, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agendado', ?)`
    ).run(
      bookingId,
      session.providerId,
      requestId,
      requestRow.customer_name,
      sanitizeText(payload.serviceName) || "Atendimento",
      requestRow.location_label || "",
      scheduledAt,
      price,
      now
    );

    const scheduledDateForMessage = new Date(scheduledAt);
    const scheduledLabel = isNaN(scheduledDateForMessage.getTime())
      ? scheduledAt
      : scheduledDateForMessage.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    insertProviderMessage(
      requestId,
      "system",
      "Orçamento enviado: R$ " +
        price.toFixed(2).replace(".", ",") +
        " para " +
        scheduledLabel +
        ". Assim que o cliente pagar, o atendimento entra confirmado na agenda."
    );

    sendJson(res, 200, {
      ok: true,
      booking: rowToProviderBooking(db.prepare("SELECT * FROM provider_bookings WHERE id = ?").get(bookingId))
    });
    return;
  }

  sendJson(res, 400, { error: "Ação inválida." });
}

async function handleProviderListBookings(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const rows = db
    .prepare("SELECT * FROM provider_bookings WHERE provider_id = ? ORDER BY scheduled_at ASC")
    .all(session.providerId);
  sendJson(res, 200, { bookings: rows.map(rowToProviderBooking) });
}

async function handleProviderUpdateBookingStatus(req, res, bookingId) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const bookingRow = db
    .prepare("SELECT * FROM provider_bookings WHERE id = ? AND provider_id = ?")
    .get(bookingId, session.providerId);

  if (!bookingRow) {
    sendJson(res, 404, { error: "Atendimento não encontrado." });
    return;
  }

  const payload = await readRequestBody(req);
  const status = sanitizeText(payload.status);

  if (["concluido", "cancelado", "agendado"].indexOf(status) < 0) {
    sendJson(res, 400, { error: "Status inválido." });
    return;
  }

  // Visita técnica paga: só libera marcar como concluída depois que o
  // cliente já pagou pelo app. Sem essa trava, o prestador poderia ir,
  // avaliar o serviço e nunca receber pela visita em si. Não vale pra
  // visita gratuita (price 0) nem pro atendimento do serviço em si, que
  // continua podendo ser fechado em dinheiro combinado direto, igual loja
  // e táxi.
  if (
    status === "concluido" &&
    bookingRow.kind === "visita" &&
    Number(bookingRow.price || 0) > 0 &&
    bookingRow.payment_status !== "pago"
  ) {
    sendJson(res, 400, { error: "Aguarde o cliente pagar a visita pelo app antes de marcar como concluída." });
    return;
  }

  db.prepare("UPDATE provider_bookings SET status = ? WHERE id = ?").run(status, bookingId);

  if (bookingRow.budget_request_id) {
    const isVisit = bookingRow.kind === "visita";
    if (status === "concluido") {
      insertProviderMessage(
        bookingRow.budget_request_id,
        "system",
        isVisit ? "Visita técnica concluída. Aguarde o orçamento final do serviço." : "Atendimento concluído pelo prestador."
      );
    } else if (status === "cancelado") {
      insertProviderMessage(
        bookingRow.budget_request_id,
        "system",
        isVisit ? "Visita técnica cancelada pelo prestador." : "Atendimento cancelado pelo prestador."
      );
    }
  }

  sendJson(res, 200, { booking: rowToProviderBooking(db.prepare("SELECT * FROM provider_bookings WHERE id = ?").get(bookingId)) });
}

async function handleProviderEarnings(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const rows = db
    .prepare("SELECT * FROM provider_bookings WHERE provider_id = ? AND status != 'cancelado' ORDER BY scheduled_at DESC")
    .all(session.providerId);
  const total = rows.reduce(function (sum, row) {
    return sum + Number(row.price || 0);
  }, 0);
  const weekStart = startOfWeekProvider(new Date());
  const weekTotal = rows
    .filter(function (row) {
      return new Date(row.scheduled_at) >= weekStart;
    })
    .reduce(function (sum, row) {
      return sum + Number(row.price || 0);
    }, 0);

  sendJson(res, 200, {
    total,
    weekTotal,
    bookings: rows.map(rowToProviderBooking)
  });
}

async function handleProviderReviews(req, res) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const rows = db
    .prepare("SELECT * FROM provider_reviews WHERE provider_id = ? ORDER BY created_at DESC")
    .all(session.providerId);
  const summary = getProviderRatingSummary(session.providerId);

  sendJson(res, 200, {
    reviews: rows.map(rowToProviderReview),
    averageRating: summary.avgRating,
    reviewsCount: summary.reviewsCount
  });
}

async function handleListProviders(req, res) {
  const rows = db.prepare("SELECT * FROM service_providers ORDER BY name ASC").all();
  sendJson(res, 200, { providers: rows.map(rowToProvider).map(getPublicProvider) });
}

async function handleCreateBudgetRequest(req, res) {
  const payload = await readRequestBody(req);
  const providerId = sanitizeText(payload.providerId);
  const customerName = sanitizeText(payload.customerName);
  const customerPhone = sanitizeText(payload.customerPhone);
  const locationLabel = sanitizeText(payload.locationLabel);
  const message = sanitizeText(payload.message);

  if (!providerId || !customerName || !customerPhone || !message) {
    sendJson(res, 400, { error: "Preencha todos os campos." });
    return;
  }

  const provider = findProviderById(providerId);
  if (!provider) {
    sendJson(res, 404, { error: "Prestador não encontrado." });
    return;
  }

  const now = new Date().toISOString();
  const id = "req-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

  db.prepare(
    `INSERT INTO budget_requests
     (id, provider_id, customer_name, customer_phone, location_label, message, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'aguardando', ?, ?)`
  ).run(id, providerId, customerName, customerPhone, locationLabel, message, now, now);

  // O próprio pedido inicial já entra como a primeira mensagem da
  // conversa - assim o cliente e o prestador conversam num fio só, sem
  // precisar copiar essa descrição em outro lugar.
  insertProviderMessage(id, "customer", message);

  sendJson(res, 201, { id });
}

// Trâmite completo do pedido de orçamento: dados do pedido, o histórico de
// mensagens (incluindo as automáticas que narram o andamento) e o
// agendamento, se já existir. Não exige login - o próprio ID do pedido na
// URL é a "senha" de acesso, igual já fazemos em GET /api/orders/:id e
// GET /api/provider-bookings/:id. É essa rota que alimenta a tela de chat
// do cliente (conversa-prestador.html).
async function handleGetBudgetRequestTimeline(req, res, requestId) {
  const request = findBudgetRequestById(requestId);

  if (!request) {
    sendJson(res, 404, { error: "Solicitação não encontrada." });
    return;
  }

  const provider = findProviderById(request.providerId);
  const bookings = listBookingsByBudgetRequestId(requestId).map(function (booking) {
    if (booking.kind === "visita") {
      return booking;
    }
    const existingReview = db.prepare("SELECT id FROM provider_reviews WHERE booking_id = ?").get(booking.id);
    return Object.assign({}, booking, { alreadyReviewed: !!existingReview });
  });

  sendJson(res, 200, {
    request,
    messages: listProviderMessages(requestId),
    // "booking" (o mais recente) fica por compatibilidade; "bookings" traz
    // a lista inteira em ordem, porque agora um mesmo pedido pode ter até
    // duas cobranças: a visita técnica e o serviço em si.
    booking: bookings.length ? bookings[bookings.length - 1] : null,
    bookings,
    providerName: provider ? provider.name : ""
  });
}

// Cliente manda mensagem no chat (sem login, mesmo esquema de acesso via ID
// da rota acima). Só funciona enquanto o pedido não foi recusado - depois
// disso a conversa fica só de leitura.
async function handleCreateBudgetRequestMessage(req, res, requestId) {
  const request = findBudgetRequestById(requestId);

  if (!request) {
    sendJson(res, 404, { error: "Solicitação não encontrada." });
    return;
  }

  if (request.status === "recusado") {
    sendJson(res, 400, { error: "Essa solicitação foi recusada e a conversa está encerrada." });
    return;
  }

  const payload = await readRequestBody(req);
  const message = insertProviderMessage(requestId, "customer", payload.body);

  if (!message) {
    sendJson(res, 400, { error: "Escreva uma mensagem." });
    return;
  }

  sendJson(res, 201, { message });
}

// Prestador manda mensagem no chat, autenticado - usado no painel dele.
async function handleProviderSendBudgetRequestMessage(req, res, requestId) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const requestRow = db
    .prepare("SELECT * FROM budget_requests WHERE id = ? AND provider_id = ?")
    .get(requestId, session.providerId);

  if (!requestRow) {
    sendJson(res, 404, { error: "Solicitação não encontrada." });
    return;
  }

  const payload = await readRequestBody(req);
  const message = insertProviderMessage(requestId, "provider", payload.body);

  if (!message) {
    sendJson(res, 400, { error: "Escreva uma mensagem." });
    return;
  }

  sendJson(res, 201, { message });
}

// Painel do prestador busca o trâmite completo de um pedido específico
// (mesma forma da versão pública, mas autenticada e validando que o pedido
// é mesmo dele).
async function handleProviderGetBudgetRequestTimeline(req, res, requestId) {
  const session = requireProvider(req, res);
  if (!session) {
    return;
  }

  const requestRow = db
    .prepare("SELECT * FROM budget_requests WHERE id = ? AND provider_id = ?")
    .get(requestId, session.providerId);

  if (!requestRow) {
    sendJson(res, 404, { error: "Solicitação não encontrada." });
    return;
  }

  const request = rowToBudgetRequest(requestRow);
  const bookings = listBookingsByBudgetRequestId(requestId);

  sendJson(res, 200, {
    request,
    messages: listProviderMessages(requestId),
    booking: bookings.length ? bookings[bookings.length - 1] : null,
    bookings
  });
}

async function handleUpsertStore(req, res) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.id);

  if (!storeExists(storeId)) {
    sendJson(res, 404, { error: "Loja não encontrada." });
    return;
  }

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  const existingStore = getStoreWithItems(storeId);
  const normalizedStore = normalizeStorePayload(payload, existingStore);

  if (!normalizedStore.id || !normalizedStore.name || !normalizedStore.categoryId) {
    sendJson(res, 400, { error: "Loja inválida." });
    return;
  }

  saveStore(storeId, normalizedStore);
  sendJson(res, 200, { store: getStoreWithItems(storeId) });
}

async function handleUpsertStoreItem(req, res) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);
  const itemPayload = payload.item || {};

  if (!storeExists(storeId)) {
    sendJson(res, 404, { error: "Loja não encontrada." });
    return;
  }

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  const store = getStoreWithItems(storeId);
  const itemId = sanitizeText(payload.itemId);
  const existingItem = itemId ? store.items.find(function (item) { return item.id === itemId; }) : null;
  const normalizedItem = normalizeStoreItem(itemPayload, existingItem);

  if (!normalizedItem.name) {
    sendJson(res, 400, { error: "Item inválido." });
    return;
  }

  saveItem(storeId, normalizedItem);
  const updatedStore = getStoreWithItems(storeId);
  sendJson(res, 200, { store: updatedStore, item: normalizedItem });
}

// -------------------------------------------------------------------------
// Upload de fotos - salva o arquivo de verdade em assets/items/ em vez de
// embutir a imagem em base64 dentro do catálogo.
// -------------------------------------------------------------------------

async function handleUploadItemPhoto(req, res) {
  const session = getOwnerSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login como lojista para continuar." });
    return;
  }

  const payload = await readRequestBody(req);
  const dataUrl = String(payload.dataUrl || "");
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl);

  if (!match) {
    sendJson(res, 400, { error: "Imagem inválida." });
    return;
  }

  const mimeType = match[1];
  const extension = ALLOWED_UPLOAD_TYPES[mimeType];

  if (!extension) {
    sendJson(res, 400, { error: "Formato de imagem não suportado. Use JPG, PNG, WEBP ou GIF." });
    return;
  }

  const buffer = Buffer.from(match[2], "base64");

  if (buffer.length > MAX_UPLOAD_BYTES) {
    sendJson(res, 400, { error: "Imagem muito grande. O limite é 5 MB." });
    return;
  }

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  const fileName = `${session.storeId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), buffer);

  sendJson(res, 201, { url: `./assets/items/${fileName}` });
}

// -------------------------------------------------------------------------
// Documentos pessoais (CNH, CRLV, certidão de antecedentes) - salvos numa
// pasta que NUNCA é servida publicamente (ver PARTNER_DOCS_DIR). Diferente
// da foto de item/loja, aqui não existe uma URL pública: o arquivo só sai
// através de handleGetPartnerDocument, que exige login de admin.
// Retorna { fileName, error } - fileName vem preenchido só quando o
// data URL é válido, dentro do limite de tamanho e de um tipo aceito.
function saveDocumentUpload(dataUrl, prefix) {
  const value = String(dataUrl || "");
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(value);

  if (!match) {
    return { error: "Documento inválido." };
  }

  const mimeType = match[1];
  const extension = ALLOWED_DOCUMENT_TYPES[mimeType];

  if (!extension) {
    return { error: "Formato de documento não suportado. Use JPG, PNG, WEBP, GIF ou PDF." };
  }

  const buffer = Buffer.from(match[2], "base64");

  if (buffer.length > MAX_UPLOAD_BYTES) {
    return { error: "Documento muito grande. O limite é 5 MB." };
  }

  if (!fs.existsSync(PARTNER_DOCS_DIR)) {
    fs.mkdirSync(PARTNER_DOCS_DIR, { recursive: true });
  }

  const fileName = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
  fs.writeFileSync(path.join(PARTNER_DOCS_DIR, fileName), buffer);

  return { fileName };
}

const PARTNER_DOCUMENT_MIME_BY_EXTENSION = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf"
};

// Rota de admin pra ver um documento enviado no cadastro de um motorista ou
// prestador (ex.: a foto da CNH). "kind" identifica qual documento e de
// qual tabela puxar o nome do arquivo salvo.
const PARTNER_DOCUMENT_FIELDS = {
  "taxi-driver": {
    "cnh-front": "cnh_front_file",
    "cnh-back": "cnh_back_file",
    "cnh-digital": "cnh_digital_file",
    crlv: "crlv_file",
    "criminal-record": "criminal_record_file"
  },
  provider: {
    "criminal-record": "criminal_record_file"
  }
};

async function handleGetPartnerDocument(req, res, entityType, entityId, kind) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const fieldsByKind = PARTNER_DOCUMENT_FIELDS[entityType];
  const column = fieldsByKind && fieldsByKind[kind];

  if (!column) {
    sendJson(res, 404, { error: "Documento não encontrado." });
    return;
  }

  const table = entityType === "taxi-driver" ? "taxi_drivers" : "service_providers";
  const row = db.prepare(`SELECT ${column} AS file_name FROM ${table} WHERE id = ?`).get(entityId);
  const fileName = row && row.file_name;

  if (!fileName) {
    sendJson(res, 404, { error: "Esse documento não foi enviado." });
    return;
  }

  const filePath = path.join(PARTNER_DOCS_DIR, fileName);
  if (path.dirname(filePath) !== PARTNER_DOCS_DIR || !fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "Documento não encontrado." });
    return;
  }

  const extension = path.extname(fileName).slice(1).toLowerCase();
  const contentType = PARTNER_DOCUMENT_MIME_BY_EXTENSION[extension] || "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

// -------------------------------------------------------------------------
// Pedidos - centralizados no banco do servidor (não mais só no
// localStorage do navegador), com aviso em tempo real via WebSocket.
// -------------------------------------------------------------------------

const ORDER_STATUSES = [
  "Novo",
  "Recebido",
  "Em preparo",
  "Saiu para entrega",
  "Entregue",
  "Cancelado"
];

function createStatusHistoryEntry(status) {
  return {
    status,
    timestamp: new Date().toISOString()
  };
}

async function handleCreateOrder(req, res) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);
  const store = getStoreWithItems(storeId);

  if (!store) {
    sendJson(res, 404, { error: "Loja não encontrada." });
    return;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  const normalizedItems = items
    .map(function (cartItem) {
      const storeItem = (store.items || []).find(function (item) {
        return item.id === cartItem.itemId;
      });

      if (!storeItem || storeItem.available === false) {
        return null;
      }

      const quantity = Math.max(1, Number(cartItem.quantity) || 1);
      const promoPrice = storeItem.promoPrice != null ? Number(storeItem.promoPrice) : null;
      const basePrice = Number(storeItem.price || 0);
      const price = promoPrice != null && promoPrice > 0 && promoPrice < basePrice ? promoPrice : basePrice;

      return {
        itemId: storeItem.id,
        name: storeItem.name,
        price,
        section: storeItem.section || "Geral",
        quantity,
        subtotal: price * quantity
      };
    })
    .filter(Boolean);

  if (!normalizedItems.length) {
    sendJson(res, 400, { error: "O carrinho está vazio ou os itens não estão disponíveis." });
    return;
  }

  const subtotal = normalizedItems.reduce(function (total, item) {
    return total + item.subtotal;
  }, 0);

  const district = sanitizeText(payload.district).toLowerCase();
  const districtFees = store.deliveryFeesByDistrict || {};
  const deliveryFee =
    district && districtFees[district] != null
      ? Number(districtFees[district])
      : Number(String(store.deliveryFee || "0").replace("R$", "").replace(".", "").replace(",", ".").trim()) || 0;

  let appliedCoupon = null;
  let discount = 0;
  const couponCode = sanitizeText(payload.couponCode).toUpperCase();

  if (couponCode) {
    appliedCoupon = findActiveCoupon(store.id, couponCode);
    if (!appliedCoupon) {
      sendJson(res, 400, { error: "Esse cupom não é mais válido." });
      return;
    }
    discount = computeCouponDiscount(appliedCoupon, subtotal);
    if (discount <= 0) {
      sendJson(res, 400, {
        error: `O pedido mínimo para esse cupom é ${formatMoneyBR(appliedCoupon.min_order)}.`
      });
      return;
    }
  }

  const paymentMethod = sanitizeText(payload.paymentMethod) || "Pix";
  const total = Math.max(0, subtotal + deliveryFee - discount);

  // Troco só faz sentido pra pagamento em dinheiro na entrega. Se o cliente
  // pedir troco pra um valor menor que o total do pedido, é claramente um
  // erro de digitação - melhor recusar do que entregar um valor sem
  // sentido pro lojista.
  let changeFor = null;
  if (paymentMethod === "Dinheiro" && payload.changeFor != null && payload.changeFor !== "") {
    changeFor = Number(payload.changeFor);
    if (!Number.isFinite(changeFor) || changeFor < total) {
      sendJson(res, 400, {
        error: `O troco precisa ser para um valor de pelo menos ${formatMoneyBR(total)} (total do pedido).`
      });
      return;
    }
  }

  const order = {
    id: "PED-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "Novo",
    statusHistory: [createStatusHistoryEntry("Novo")],
    prepEstimate: "",
    paymentMethod,
    notes: sanitizeText(payload.notes),
    customerId: sanitizeText(payload.customerId),
    customerName: sanitizeText(payload.customerName) || "Cliente",
    customerPhone: sanitizeText(payload.customerPhone),
    storeId: store.id,
    storeName: store.name,
    storeIcon: store.icon,
    items: normalizedItems,
    subtotal,
    deliveryFee,
    couponCode: appliedCoupon ? appliedCoupon.code : "",
    discount,
    total,
    district: sanitizeText(payload.district),
    address: sanitizeText(payload.address),
    changeFor
  };

  insertOrder(order);

  if (appliedCoupon) {
    db.prepare("UPDATE coupons SET uses_count = uses_count + 1 WHERE store_id = ? AND code = ?").run(
      store.id,
      appliedCoupon.code
    );
  }

  broadcastToStore(store.id, { type: "order-created", order });

  sendJson(res, 201, { order });
}

async function handleListOrders(req, res, urlObject) {
  const storeId = sanitizeText(urlObject.searchParams.get("storeId"));

  if (!storeId) {
    sendJson(res, 400, { error: "Informe a loja." });
    return;
  }

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  sendJson(res, 200, { orders: listOrdersByStore(storeId) });
}

async function handleGetOrder(req, res, orderId) {
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  sendJson(res, 200, { order });
}

// Aplica uma mudança de status a um pedido (usado pelo lojista mudando o
// status manualmente, pelo cliente cancelando o próprio pedido, e pelo admin
// master cancelando/estornando pelo painel). Sempre passa pelo mesmo
// caminho: grava o histórico, tenta estornar sozinho se acabou de virar
// "Cancelado" com pagamento online já confirmado, avisa a loja pelo
// WebSocket e o cliente por push.
async function applyOrderStatusChange(order, status) {
  order.statusHistory.push(createStatusHistoryEntry(status));
  updateOrderStatusRow(order.id, status, order.statusHistory);

  let updatedOrder = findOrderById(order.id);
  const refund = await maybeRefundCancelledOrder(updatedOrder);
  if (refund.attempted) {
    // O estorno pode ter mudado payment_status/payment_detail - busca de
    // novo pra devolver o pedido já atualizado pra quem chamou.
    updatedOrder = findOrderById(order.id);
  }

  broadcastToStore(order.storeId, { type: "order-updated", order: updatedOrder });

  if (updatedOrder.customerId) {
    sendPushToCustomer(updatedOrder.customerId, {
      title: `Pedido ${status.toLowerCase()}`,
      body: `Seu pedido na ${updatedOrder.storeName} agora está: ${status}.`,
      url: `/orders.html`
    }).catch(function (error) {
      console.error("Erro ao enviar notificação push de status:", error && error.message);
    });
  }

  return { updatedOrder, refund };
}

async function handleUpdateOrderStatus(req, res, orderId) {
  const payload = await readRequestBody(req);
  const status = sanitizeText(payload.status);
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (!requireOwnerForStore(req, res, order.storeId)) {
    return;
  }

  if (ORDER_STATUSES.indexOf(status) < 0) {
    sendJson(res, 400, { error: "Status inválido." });
    return;
  }

  const result = await applyOrderStatusChange(order, status);
  sendJson(res, 200, { order: result.updatedOrder, refund: result.refund });
}

// Cancelamento pelo próprio cliente. Só é permitido enquanto o pedido ainda
// não saiu para entrega - depois disso, o cliente precisa falar com a loja
// (o cancelamento continua disponível pro lojista/admin em qualquer status
// através dos outros endpoints). Ao cancelar, o estorno automático segue o
// mesmo caminho de quando o lojista cancela.
const CUSTOMER_CANCELABLE_STATUSES = ["Novo", "Recebido", "Em preparo"];

async function handleCancelOrderByCustomer(req, res, orderId) {
  const session = getCustomerSession(req);

  if (!session) {
    sendJson(res, 401, { error: "Faça login para cancelar o pedido." });
    return;
  }

  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (order.customerId !== session.customerId) {
    sendJson(res, 403, { error: "Esse pedido não pertence à sua conta." });
    return;
  }

  if (order.status === "Cancelado") {
    sendJson(res, 400, { error: "Esse pedido já está cancelado." });
    return;
  }

  if (CUSTOMER_CANCELABLE_STATUSES.indexOf(order.status) < 0) {
    sendJson(res, 400, {
      error:
        "Esse pedido já saiu para entrega (ou foi finalizado) e não pode mais ser cancelado por aqui. Fale direto com a loja."
    });
    return;
  }

  const result = await applyOrderStatusChange(order, "Cancelado");
  sendJson(res, 200, { order: result.updatedOrder, refund: result.refund });
}

async function handleUpdateOrderPrep(req, res, orderId) {
  const payload = await readRequestBody(req);
  const prepEstimate = sanitizeText(payload.prepEstimate);
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (!requireOwnerForStore(req, res, order.storeId)) {
    return;
  }

  updateOrderPrepRow(orderId, prepEstimate);
  const updatedOrder = findOrderById(orderId);
  broadcastToStore(order.storeId, { type: "order-updated", order: updatedOrder });
  sendJson(res, 200, { order: updatedOrder });
}

async function handleClearOrders(req, res) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);

  if (!storeId) {
    sendJson(res, 400, { error: "Informe a loja." });
    return;
  }

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  deleteOrdersByStore(storeId);
  broadcastToStore(storeId, { type: "orders-cleared" });

  sendJson(res, 200, { message: "Fila de pedidos limpa." });
}

function formatMoneyBR(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// -------------------------------------------------------------------------
// Avaliações de loja (avaliadas pelo cliente após o pedido ser entregue)
// -------------------------------------------------------------------------

async function handleCreateReview(req, res) {
  const payload = await readRequestBody(req);
  const orderId = sanitizeText(payload.orderId);
  const rating = Math.round(Number(payload.rating));
  const comment = sanitizeText(payload.comment).slice(0, 500);
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (order.status !== "Entregue") {
    sendJson(res, 400, { error: "Só é possível avaliar pedidos já entregues." });
    return;
  }

  if (!(rating >= 1 && rating <= 5)) {
    sendJson(res, 400, { error: "Escolha uma nota de 1 a 5 estrelas." });
    return;
  }

  const existingReview = db.prepare("SELECT id FROM reviews WHERE order_id = ?").get(orderId);
  if (existingReview) {
    sendJson(res, 400, { error: "Esse pedido já foi avaliado." });
    return;
  }

  const review = {
    id: "review-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    orderId,
    storeId: order.storeId,
    customerName: order.customerName || "Cliente",
    rating,
    comment,
    createdAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO reviews (id, order_id, store_id, customer_id, customer_name, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id,
    review.orderId,
    review.storeId,
    sanitizeText(order.customerId),
    review.customerName,
    review.rating,
    review.comment,
    review.createdAt
  );

  sendJson(res, 201, { review });
}

async function handleListReviews(req, res, storeId) {
  if (!storeExists(storeId)) {
    sendJson(res, 404, { error: "Loja não encontrada." });
    return;
  }

  const rows = db
    .prepare("SELECT * FROM reviews WHERE store_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 50")
    .all(storeId);
  const summary = getStoreRatingSummary(storeId);

  sendJson(res, 200, {
    reviews: rows.map(function (row) {
      return {
        id: row.id,
        customerName: row.customer_name || "Cliente",
        rating: row.rating,
        comment: row.comment || "",
        createdAt: row.created_at
      };
    }),
    averageRating: summary.avgRating,
    reviewsCount: summary.reviewsCount
  });
}

// Avaliação de um item específico (ex.: comentário sobre o caimento de uma
// peça de roupa). Mesma regra da avaliação de loja - só libera depois do
// pedido marcado como "Entregue", e só uma vez por item por pedido.
async function handleCreateItemReview(req, res) {
  const payload = await readRequestBody(req);
  const orderId = sanitizeText(payload.orderId);
  const itemId = sanitizeText(payload.itemId);
  const rating = Math.round(Number(payload.rating));
  const comment = sanitizeText(payload.comment).slice(0, 500);
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (order.status !== "Entregue") {
    sendJson(res, 400, { error: "Só é possível avaliar itens de pedidos já entregues." });
    return;
  }

  const orderItem = (order.items || []).find(function (entry) {
    return entry.itemId === itemId;
  });

  if (!orderItem) {
    sendJson(res, 400, { error: "Esse item não faz parte deste pedido." });
    return;
  }

  if (!(rating >= 1 && rating <= 5)) {
    sendJson(res, 400, { error: "Escolha uma nota de 1 a 5 estrelas." });
    return;
  }

  const existingReview = db
    .prepare("SELECT id FROM item_reviews WHERE order_id = ? AND item_id = ?")
    .get(orderId, itemId);
  if (existingReview) {
    sendJson(res, 400, { error: "Esse item já foi avaliado." });
    return;
  }

  const review = {
    id: "item-review-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    orderId,
    itemId,
    itemName: orderItem.name,
    storeId: order.storeId,
    customerName: order.customerName || "Cliente",
    rating,
    comment,
    createdAt: new Date().toISOString()
  };

  db.prepare(`
    INSERT INTO item_reviews (id, order_id, item_id, item_name, store_id, customer_id, customer_name, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id,
    review.orderId,
    review.itemId,
    review.itemName,
    review.storeId,
    sanitizeText(order.customerId),
    review.customerName,
    review.rating,
    review.comment,
    review.createdAt
  );

  sendJson(res, 201, { review });
}

async function handleListItemReviews(req, res, itemId) {
  const rows = db
    .prepare("SELECT * FROM item_reviews WHERE item_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 50")
    .all(itemId);
  const summary = getItemRatingSummary(itemId);

  sendJson(res, 200, {
    reviews: rows.map(function (row) {
      return {
        id: row.id,
        customerName: row.customer_name || "Cliente",
        rating: row.rating,
        comment: row.comment || "",
        createdAt: row.created_at
      };
    }),
    averageRating: summary.avgRating,
    reviewsCount: summary.reviewsCount
  });
}

// Moderação de avaliações - pro lojista (ou admin, entrando como a loja)
// ver TODAS as avaliações da loja e dos itens dela, inclusive as já
// escondidas, e decidir esconder/reexibir uma avaliação abusiva ou falsa.
// Nada é apagado - só some da média e da listagem pública enquanto estiver
// escondida.
async function handleListReviewsForOwner(req, res, storeId) {
  const session = requireOwnerForStore(req, res, storeId);
  if (!session) {
    return;
  }

  const storeReviews = db
    .prepare("SELECT * FROM reviews WHERE store_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(storeId);
  const itemReviews = db
    .prepare("SELECT * FROM item_reviews WHERE store_id = ? ORDER BY created_at DESC LIMIT 100")
    .all(storeId);

  sendJson(res, 200, {
    storeReviews: storeReviews.map(function (row) {
      return {
        id: row.id,
        customerName: row.customer_name || "Cliente",
        rating: row.rating,
        comment: row.comment || "",
        createdAt: row.created_at,
        hidden: !!row.hidden
      };
    }),
    itemReviews: itemReviews.map(function (row) {
      return {
        id: row.id,
        itemName: row.item_name || "",
        customerName: row.customer_name || "Cliente",
        rating: row.rating,
        comment: row.comment || "",
        createdAt: row.created_at,
        hidden: !!row.hidden
      };
    })
  });
}

async function handleSetReviewVisibility(req, res, reviewId) {
  const reviewRow = db.prepare("SELECT id, store_id FROM reviews WHERE id = ?").get(reviewId);
  if (!reviewRow) {
    sendJson(res, 404, { error: "Avaliação não encontrada." });
    return;
  }

  const session = requireOwnerForStore(req, res, reviewRow.store_id);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const hidden = !!payload.hidden;

  db.prepare("UPDATE reviews SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, reviewId);
  sendJson(res, 200, { id: reviewId, hidden });
}

async function handleSetItemReviewVisibility(req, res, reviewId) {
  const reviewRow = db.prepare("SELECT id, store_id FROM item_reviews WHERE id = ?").get(reviewId);
  if (!reviewRow) {
    sendJson(res, 404, { error: "Avaliação não encontrada." });
    return;
  }

  const session = requireOwnerForStore(req, res, reviewRow.store_id);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const hidden = !!payload.hidden;

  db.prepare("UPDATE item_reviews SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, reviewId);
  sendJson(res, 200, { id: reviewId, hidden });
}

// -------------------------------------------------------------------------
// Cupons de desconto (por loja)
// -------------------------------------------------------------------------

function rowToCoupon(row) {
  return {
    code: row.code,
    type: row.type,
    value: row.value,
    minOrder: row.min_order,
    maxUses: row.max_uses,
    usesCount: row.uses_count,
    expiresAt: row.expires_at,
    isActive: !!row.is_active
  };
}

function findActiveCoupon(storeId, code) {
  const row = db.prepare("SELECT * FROM coupons WHERE store_id = ? AND code = ?").get(storeId, code);
  if (!row || !row.is_active) {
    return null;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return null;
  }
  if (row.max_uses != null && row.uses_count >= row.max_uses) {
    return null;
  }
  return row;
}

function computeCouponDiscount(coupon, subtotal) {
  if (subtotal < Number(coupon.min_order || 0)) {
    return 0;
  }
  if (coupon.type === "fixed") {
    return Math.min(subtotal, Number(coupon.value));
  }
  return Math.min(subtotal, (subtotal * Number(coupon.value)) / 100);
}

async function handleValidateCoupon(req, res) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);
  const code = sanitizeText(payload.code).toUpperCase();
  const subtotal = Number(payload.subtotal || 0);

  if (!storeId || !code) {
    sendJson(res, 400, { error: "Informe o cupom." });
    return;
  }

  const coupon = findActiveCoupon(storeId, code);
  if (!coupon) {
    sendJson(res, 404, { error: "Cupom inválido ou expirado." });
    return;
  }

  const discount = computeCouponDiscount(coupon, subtotal);
  if (discount <= 0) {
    sendJson(res, 400, {
      error: `O pedido mínimo para esse cupom é ${formatMoneyBR(coupon.min_order)}.`
    });
    return;
  }

  sendJson(res, 200, { code: coupon.code, type: coupon.type, value: coupon.value, discount });
}

async function handleUpsertCoupon(req, res) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);

  if (!storeExists(storeId)) {
    sendJson(res, 404, { error: "Loja não encontrada." });
    return;
  }

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  const code = sanitizeText(payload.code).toUpperCase();
  const type = payload.type === "fixed" ? "fixed" : "percent";
  const value = Number(payload.value || 0);
  const minOrder = Number(payload.minOrder || 0);
  const maxUses = payload.maxUses != null && payload.maxUses !== "" ? Number(payload.maxUses) : null;
  const expiresAt = sanitizeText(payload.expiresAt) || null;

  if (!code || value <= 0) {
    sendJson(res, 400, { error: "Preencha o código e um valor de desconto maior que zero." });
    return;
  }

  const existing = db.prepare("SELECT uses_count FROM coupons WHERE store_id = ? AND code = ?").get(storeId, code);

  db.prepare(`
    INSERT INTO coupons (code, store_id, type, value, min_order, max_uses, uses_count, expires_at, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(code, store_id) DO UPDATE SET
      type = excluded.type, value = excluded.value, min_order = excluded.min_order,
      max_uses = excluded.max_uses, expires_at = excluded.expires_at, is_active = 1
  `).run(
    code,
    storeId,
    type,
    value,
    minOrder,
    maxUses,
    existing ? existing.uses_count : 0,
    expiresAt,
    new Date().toISOString()
  );

  sendJson(res, 200, { coupon: rowToCoupon(db.prepare("SELECT * FROM coupons WHERE store_id = ? AND code = ?").get(storeId, code)) });
}

async function handleListCoupons(req, res, urlObject) {
  const storeId = sanitizeText(urlObject.searchParams.get("storeId"));

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  const rows = db.prepare("SELECT * FROM coupons WHERE store_id = ? ORDER BY created_at DESC").all(storeId);
  sendJson(res, 200, { coupons: rows.map(rowToCoupon) });
}

// Lista pública de cupons ativos, com o nome da loja junto - usada na tela
// "Cupons" do perfil do cliente. Só mostra cupons que ainda podem ser usados
// (ativo, loja ativa, não expirado, sem limite de usos batido).
async function handleListActiveCoupons(req, res) {
  const nowIso = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT coupons.*, stores.name AS store_name FROM coupons
       JOIN stores ON stores.id = coupons.store_id
       WHERE coupons.is_active = 1
         AND stores.is_active = 1
         AND (coupons.expires_at IS NULL OR coupons.expires_at = '' OR coupons.expires_at > ?)
         AND (coupons.max_uses IS NULL OR coupons.uses_count < coupons.max_uses)
       ORDER BY coupons.created_at DESC`
    )
    .all(nowIso);

  sendJson(res, 200, {
    coupons: rows.map(function (row) {
      const coupon = rowToCoupon(row);
      coupon.storeId = row.store_id;
      coupon.storeName = row.store_name;
      return coupon;
    })
  });
}

async function handleToggleCoupon(req, res, code) {
  const payload = await readRequestBody(req);
  const storeId = sanitizeText(payload.storeId);

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  const row = db.prepare("SELECT * FROM coupons WHERE store_id = ? AND code = ?").get(storeId, code);
  if (!row) {
    sendJson(res, 404, { error: "Cupom não encontrado." });
    return;
  }

  db.prepare("UPDATE coupons SET is_active = ? WHERE store_id = ? AND code = ?").run(
    row.is_active ? 0 : 1,
    storeId,
    code
  );

  sendJson(res, 200, {
    coupon: rowToCoupon(db.prepare("SELECT * FROM coupons WHERE store_id = ? AND code = ?").get(storeId, code))
  });
}

// -------------------------------------------------------------------------
// Metricas de vendas para o painel do lojista
// -------------------------------------------------------------------------

async function handleOrderMetrics(req, res, urlObject) {
  const storeId = sanitizeText(urlObject.searchParams.get("storeId"));

  if (!requireOwnerForStore(req, res, storeId)) {
    return;
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const salesByDay = db
    .prepare(`
      SELECT substr(created_at, 1, 10) AS day, SUM(total) AS total, COUNT(*) AS count
      FROM orders
      WHERE store_id = ? AND status != 'Cancelado' AND created_at >= ?
      GROUP BY day
      ORDER BY day DESC
    `)
    .all(storeId, since);

  const recentOrders = db
    .prepare("SELECT items_json FROM orders WHERE store_id = ? AND status != 'Cancelado' ORDER BY created_at DESC LIMIT 500")
    .all(storeId);

  const itemStats = {};
  recentOrders.forEach(function (row) {
    let items = [];
    try {
      items = JSON.parse(row.items_json || "[]");
    } catch (error) {
      items = [];
    }
    items.forEach(function (item) {
      if (!itemStats[item.name]) {
        itemStats[item.name] = { name: item.name, quantity: 0, revenue: 0 };
      }
      itemStats[item.name].quantity += Number(item.quantity || 0);
      itemStats[item.name].revenue += Number(item.subtotal || 0);
    });
  });

  const topItems = Object.values(itemStats)
    .sort(function (a, b) {
      return b.quantity - a.quantity;
    })
    .slice(0, 10);

  sendJson(res, 200, { salesByDay, topItems });
}

// -------------------------------------------------------------------------
// Pagamento online (Mercado Pago)
// -------------------------------------------------------------------------

async function handleCreatePixPayment(req, res) {
  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online ainda não foi configurado neste servidor." });
    return;
  }

  const payload = await readRequestBody(req);
  const orderId = sanitizeText(payload.orderId);
  const payerEmail = normalizeEmail(payload.payerEmail) || "cliente@alloo.com";
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (order.paymentStatus === "pago") {
    sendJson(res, 400, { error: "Esse pedido já está pago." });
    return;
  }

  const amount = Number(order.total || 0).toFixed(2);

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", "/v1/orders", {
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: order.id,
      notification_url: getPaymentWebhookUrl(req),
      payer: { email: payerEmail },
      transactions: {
        payments: [
          {
            amount,
            payment_method: { id: "pix", type: "bank_transfer" }
          }
        ]
      }
    });
  } catch (error) {
    logPaymentError("pix-network", order.id, null, { message: error && error.message });
    sendJson(res, 503, { error: "Não foi possível falar com o Mercado Pago agora." });
    return;
  }

  if (!mpResponse.ok) {
    // Sem isso, uma falha do Mercado Pago era só um erro genérico pro
    // cliente, sem nenhum jeito de descobrir o motivo real depois (nem no
    // log do servidor). Loga o status e o corpo completo da resposta.
    logPaymentError("pix", order.id, mpResponse.status, mpResponse.data);
    sendJson(res, 400, {
      error: extractMercadoPagoErrorReason(mpResponse.data) || "Não foi possível gerar a cobrança Pix."
    });
    return;
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentMethodData = transaction.payment_method || {};

  updateOrderPaymentRow(order.id, {
    paymentProvider: "mercadopago",
    paymentStatus: "pendente",
    paymentDetail: mpResponse.data.status_detail || "",
    mpOrderId: mpResponse.data.id || "",
    pixQrCode: paymentMethodData.qr_code || "",
    pixQrCodeBase64: paymentMethodData.qr_code_base64 || "",
    pixTicketUrl: paymentMethodData.ticket_url || ""
  });

  sendJson(res, 200, {
    qrCode: paymentMethodData.qr_code || "",
    qrCodeBase64: paymentMethodData.qr_code_base64 || "",
    ticketUrl: paymentMethodData.ticket_url || "",
    paymentStatus: "pendente"
  });
}

async function handleCreateCardPayment(req, res) {
  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online ainda não foi configurado neste servidor." });
    return;
  }

  const payload = await readRequestBody(req);
  const orderId = sanitizeText(payload.orderId);
  const token = sanitizeText(payload.token);
  const paymentMethodId = sanitizeText(payload.paymentMethodId);
  const paymentTypeId = sanitizeText(payload.paymentTypeId) === "debit_card" ? "debit_card" : "credit_card";
  const installments = Math.max(1, Number(payload.installments) || 1);
  const payerEmail = normalizeEmail(payload.payerEmail) || "cliente@alloo.com";
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (!token || !paymentMethodId) {
    sendJson(res, 400, { error: "Dados do cartão incompletos." });
    return;
  }

  if (order.paymentStatus === "pago") {
    sendJson(res, 400, { error: "Esse pedido já está pago." });
    return;
  }

  const amount = Number(order.total || 0).toFixed(2);

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", "/v1/orders", {
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: order.id,
      notification_url: getPaymentWebhookUrl(req),
      payer: { email: payerEmail },
      transactions: {
        payments: [
          {
            amount,
            payment_method: {
              id: paymentMethodId,
              type: paymentTypeId,
              token,
              installments
            }
          }
        ]
      }
    });
  } catch (error) {
    logPaymentError("card-network", order.id, null, { message: error && error.message });
    sendJson(res, 503, { error: "Não foi possível falar com o Mercado Pago agora." });
    return;
  }

  if (!mpResponse.ok) {
    logPaymentError("card", order.id, mpResponse.status, mpResponse.data);
    sendJson(res, 400, {
      error: extractMercadoPagoErrorReason(mpResponse.data) || "O pagamento não foi aprovado."
    });
    return;
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentStatus = mapMercadoPagoStatusToPaymentStatus(mpResponse.data, transaction);

  updateOrderPaymentRow(order.id, {
    paymentProvider: "mercadopago",
    paymentStatus,
    paymentDetail: transaction.status_detail || mpResponse.data.status_detail || "",
    mpOrderId: mpResponse.data.id || ""
  });

  if (paymentStatus === "pago") {
    const updatedOrder = findOrderById(order.id);
    broadcastToStore(order.storeId, { type: "order-updated", order: updatedOrder });
  }

  sendJson(res, paymentStatus === "recusado" ? 400 : 200, {
    paymentStatus,
    detail: transaction.status_detail || mpResponse.data.status_detail || ""
  });
}

// Pergunta pro Mercado Pago o status real de uma cobrança e atualiza o
// pedido local de acordo - é exatamente o que o webhook faz quando o
// Mercado Pago avisa sozinho, só que aqui é chamado sob demanda (pelo
// próprio webhook, ou manualmente por um botão "Verificar pagamento agora"
// no painel, pro caso do aviso automático nunca ter chegado - webhook mal
// configurado, fora do ar por um instante, etc.). Nunca lança erro pra quem
// chamou, sempre devolve um objeto descrevendo o que aconteceu.
async function syncOrderPaymentStatusFromMercadoPago(order) {
  if (!order.mpOrderId) {
    return { synced: false, reason: "Pedido não tem cobrança do Mercado Pago associada." };
  }

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("GET", "/v1/orders/" + encodeURIComponent(order.mpOrderId));
  } catch (error) {
    logPaymentError("sync-status-network", order.id, null, { message: error && error.message });
    return { synced: false, reason: "Não foi possível falar com o Mercado Pago agora." };
  }

  if (!mpResponse.ok) {
    logPaymentError("sync-status", order.id, mpResponse.status, mpResponse.data);
    return { synced: false, reason: extractMercadoPagoErrorReason(mpResponse.data) || "O Mercado Pago não respondeu." };
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentStatus = mapMercadoPagoStatusToPaymentStatus(mpResponse.data, transaction);

  updateOrderPaymentRow(order.id, {
    paymentStatus,
    paymentDetail: transaction.status_detail || mpResponse.data.status_detail || ""
  });

  const updatedOrder = findOrderById(order.id);
  broadcastToStore(order.storeId, { type: "order-updated", order: updatedOrder });

  if (paymentStatus === "pago" && updatedOrder.customerId) {
    sendPushToCustomer(updatedOrder.customerId, {
      title: "Pagamento confirmado",
      body: `Recebemos o pagamento do seu pedido na ${updatedOrder.storeName}.`,
      url: "/orders.html"
    }).catch(function () {});
  }

  return { synced: true, paymentStatus, order: updatedOrder };
}

async function handleMercadoPagoWebhook(req, res) {
  const payload = await readRequestBody(req);
  const mpOrderId = sanitizeText((payload.data && payload.data.id) || payload.id);

  if (!mpOrderId) {
    sendJson(res, 200, { received: true });
    return;
  }

  try {
    const order = findOrderByMpOrderId(mpOrderId);
    if (order) {
      await syncOrderPaymentStatusFromMercadoPago(order);
    }

    // A mesma cobrança do Mercado Pago nunca é ao mesmo tempo de um pedido
    // de loja, de uma corrida e de um atendimento de prestador (são fluxos
    // completamente separados), mas como o webhook é uma rota só,
    // compartilhada pelos três, procura nos três lugares - o que não achar
    // simplesmente não encontra nada e segue sem erro.
    const ride = findRideByMpOrderId(mpOrderId);
    if (ride) {
      await syncRidePaymentStatusFromMercadoPago(ride);
    }

    const booking = findBookingByMpOrderId(mpOrderId);
    if (booking) {
      await syncBookingPaymentStatusFromMercadoPago(booking);
    }
  } catch (error) {
    console.error("Erro ao processar webhook do Mercado Pago:", error && error.message);
  }

  sendJson(res, 200, { received: true });
}

// Botão "Verificar pagamento agora" no painel - útil quando o aviso
// automático do Mercado Pago (webhook) não chega por algum motivo (URL do
// webhook desatualizada após trocar de domínio, instabilidade momentânea,
// etc.). Consulta a cobrança direto na API deles e atualiza o pedido.
async function handleSyncOrderPayment(req, res, orderId) {
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (!requireOwnerForStore(req, res, order.storeId)) {
    return;
  }

  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online não está configurado neste servidor." });
    return;
  }

  const result = await syncOrderPaymentStatusFromMercadoPago(order);

  if (!result.synced) {
    sendJson(res, 502, { error: result.reason || "Não foi possível consultar o pagamento agora." });
    return;
  }

  sendJson(res, 200, { order: result.order, paymentStatus: result.paymentStatus });
}

// -------------------------------------------------------------------------
// Estorno (Pix e cartão via Mercado Pago)
// -------------------------------------------------------------------------

// Chama o estorno total da cobrança no Mercado Pago (API de Orders). Nunca
// lança erro pra quem chamou - sempre devolve um objeto descrevendo o que
// aconteceu, pra quem chamou decidir o que fazer (cancelar o pedido nunca
// deve travar por causa de uma falha no estorno).
async function refundMercadoPagoOrder(order) {
  if (!isMercadoPagoEnabled()) {
    return { attempted: true, success: false, reason: "Pagamento online não está configurado neste servidor." };
  }

  if (!order.mpOrderId) {
    return { attempted: false, success: false, reason: "Pedido não tem cobrança do Mercado Pago associada." };
  }

  let mpResponse;
  try {
    // Sem "amount" no corpo = estorno total (conforme a API de Orders do
    // Mercado Pago). Estorno parcial fica para uma próxima versão, se
    // precisar.
    mpResponse = await callMercadoPago("POST", `/v1/orders/${encodeURIComponent(order.mpOrderId)}/refund`, null);
  } catch (error) {
    logPaymentError("refund-network", order.id, null, { message: error && error.message });
    return { attempted: true, success: false, reason: "Não foi possível falar com o Mercado Pago agora." };
  }

  if (!mpResponse.ok) {
    logPaymentError("refund", order.id, mpResponse.status, mpResponse.data);
    return {
      attempted: true,
      success: false,
      reason: extractMercadoPagoErrorReason(mpResponse.data)
    };
  }

  return { attempted: true, success: true };
}

// A API do Mercado Pago às vezes manda o motivo real do erro dentro de
// "cause" (um array de {code, description}) em vez do campo "message" no
// nível de cima - sem isso, o lojista só via "O Mercado Pago recusou o
// estorno.", sem saber o porquê de verdade (ex.: saldo insuficiente na
// conta pra devolver um Pix).
function extractMercadoPagoErrorReason(data) {
  if (!data) {
    return "O Mercado Pago recusou o estorno.";
  }

  if (Array.isArray(data.cause) && data.cause.length) {
    const descriptions = data.cause
      .map(function (item) {
        return item && item.description;
      })
      .filter(Boolean);
    if (descriptions.length) {
      return descriptions.join(" ");
    }
  }

  return data.message || "O Mercado Pago recusou o estorno.";
}

// Roda toda vez que um pedido é cancelado. Se ele tinha pagamento online já
// confirmado (Pix ou cartão), tenta estornar sozinho, sem precisar de ação
// manual do lojista. Se o estorno falhar (Mercado Pago fora do ar, etc.),
// o pedido continua cancelado do mesmo jeito - só fica registrado que o
// dinheiro ainda precisa ser devolvido (manualmente, ou tentando de novo
// pelo botão "Tentar estornar novamente" no painel).
async function maybeRefundCancelledOrder(order) {
  if (!order || order.status !== "Cancelado") {
    return { attempted: false };
  }

  if (order.paymentStatus !== "pago" || order.paymentProvider !== "mercadopago") {
    return { attempted: false };
  }

  const result = await refundMercadoPagoOrder(order);

  if (result.success) {
    updateOrderPaymentRow(order.id, {
      paymentStatus: "estornado",
      paymentDetail: "Estornado automaticamente ao cancelar o pedido."
    });
  } else if (result.attempted) {
    updateOrderPaymentRow(order.id, {
      paymentDetail:
        "Falha ao estornar automaticamente: " +
        (result.reason || "erro desconhecido") +
        " - tente de novo pelo painel ou devolva manualmente pelo Mercado Pago."
    });
  }

  return result;
}

// Estorna o pagamento online de um pedido - não importa o status atual dele
// nem quando foi feito. Antes só dava pra estornar um pedido já cancelado;
// agora, se aparecer um problema comprovado num pedido antigo (mesmo já
// entregue), a loja ou o admin master conseguem devolver o dinheiro dias ou
// semanas depois, sem precisar "desfazer" a entrega. Usado tanto pelo
// lojista quanto pelo admin master - cada um com sua própria autenticação,
// mas a lógica de estornar é a mesma.
async function attemptOrderRefund(order, actorLabel) {
  if (order.paymentStatus === "estornado") {
    return { status: 400, body: { error: "Esse pedido já foi estornado." } };
  }

  if (order.paymentStatus !== "pago" || order.paymentProvider !== "mercadopago") {
    return { status: 400, body: { error: "Esse pedido não tem um pagamento online pendente de estorno." } };
  }

  const result = await refundMercadoPagoOrder(order);

  if (result.success) {
    updateOrderPaymentRow(order.id, {
      paymentStatus: "estornado",
      paymentDetail: "Estornado manualmente " + (actorLabel || "pelo painel") + "."
    });
  } else {
    updateOrderPaymentRow(order.id, {
      paymentDetail: "Falha ao tentar estornar: " + (result.reason || "erro desconhecido")
    });
  }

  const updatedOrder = findOrderById(order.id);
  broadcastToStore(order.storeId, { type: "order-updated", order: updatedOrder });
  return { status: result.success ? 200 : 502, body: { order: updatedOrder, refund: result } };
}

async function handleRefundOrder(req, res, orderId) {
  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (!requireOwnerForStore(req, res, order.storeId)) {
    return;
  }

  const outcome = await attemptOrderRefund(order, "pelo painel");
  sendJson(res, outcome.status, outcome.body);
}

// Cancelamento/estorno pelo admin master, pra qualquer loja da plataforma e
// pedido de qualquer data - sem precisar entrar como o lojista. Se o pedido
// ainda estiver em andamento (nem entregue, nem cancelado), cancela primeiro
// (o que já dispara o estorno automático). Se já foi entregue ou já estava
// cancelado, não mexe no status do pedido - só tenta devolver o pagamento
// online, o que também serve pra tentar de novo um estorno que já tinha
// falhado antes.
async function handleAdminRefundOrder(req, res, orderId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const order = findOrderById(orderId);

  if (!order) {
    sendJson(res, 404, { error: "Pedido não encontrado." });
    return;
  }

  if (order.status !== "Cancelado" && order.status !== "Entregue") {
    const result = await applyOrderStatusChange(order, "Cancelado");
    sendJson(res, 200, { order: result.updatedOrder, refund: result.refund });
    return;
  }

  const outcome = await attemptOrderRefund(order, "pelo painel administrativo");
  sendJson(res, outcome.status, outcome.body);
}

// -------------------------------------------------------------------------
// Taxistas - corrida com despacho automático pro motorista mais próximo
// (por localização ao vivo), preço sob consulta (o taxista informa depois
// de aceitar, igual já acontece com orçamento de serviço). Não calcula
// tarifa automática por rota/distância - só aproxima quem está mais perto.
// Atualização de status/localização é por polling (o cliente e o painel do
// taxista consultam a cada poucos segundos), sem canal de WebSocket
// dedicado - mais simples, e o resto do app já usa esse mesmo padrão como
// reforço ao lado do WebSocket de pedidos.
// -------------------------------------------------------------------------

const RIDE_STATUSES = ["Novo", "Aceita", "A caminho", "Em andamento", "Concluída", "Cancelada"];

function rowToTaxiDriver(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    name: row.name,
    phone: row.phone || "",
    vehicle: row.vehicle || "",
    isOnline: !!row.is_online,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    locationUpdatedAt: row.location_updated_at || "",
    email: row.email || "",
    balance: Number(row.balance || 0),
    cpf: row.cpf || "",
    cnhNumber: row.cnh_number || "",
    cnhCategory: row.cnh_category || "",
    cnhExpiresAt: row.cnh_expires_at || "",
    cnhHasEar: !!row.cnh_has_ear,
    cnhType: row.cnh_type || "fisica",
    cnhFrontFile: row.cnh_front_file || "",
    cnhBackFile: row.cnh_back_file || "",
    cnhDigitalFile: row.cnh_digital_file || "",
    crlvFile: row.crlv_file || "",
    criminalRecordFile: row.criminal_record_file || "",
    verificationStatus: row.verification_status || "pendente",
    verificationNote: row.verification_note || "",
    createdAt: row.created_at
  };
}

function getPublicTaxiDriver(driver) {
  return {
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    vehicle: driver.vehicle,
    lat: driver.lat,
    lng: driver.lng,
    locationUpdatedAt: driver.locationUpdatedAt,
    verificationStatus: driver.verificationStatus,
    verificationNote: driver.verificationNote
  };
}

function findTaxiDriverByUsername(username) {
  const row = db.prepare("SELECT * FROM taxi_drivers WHERE username = ?").get(username);
  return rowToTaxiDriver(row);
}

function findTaxiDriverById(id) {
  const row = db.prepare("SELECT * FROM taxi_drivers WHERE id = ?").get(id);
  return rowToTaxiDriver(row);
}

function findTaxiDriverByEmail(email) {
  if (!email) {
    return null;
  }
  const row = db.prepare("SELECT * FROM taxi_drivers WHERE email = ?").get(email);
  return rowToTaxiDriver(row);
}

// Distância em linha reta (km) entre dois pontos - suficiente pra ordenar
// "quem está mais perto", sem precisar de um serviço de rotas de verdade.
function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// -------------------------------------------------------------------------
// Sugestão de preço da corrida - mesma lógica que a Uber usa: bandeirada +
// (km rodado × valor por km) + (minutos × valor por minuto), com um piso
// mínimo pra corridas muito curtas não saírem de graça. Os valores ficam
// guardados na tabela genérica "settings" (mesmo lugar da comissão da
// plataforma) e são editáveis pelo super-admin, sem precisar redeploy.
// Os números de fábrica abaixo são só um ponto de partida (baseados em
// cidade pequena) - o ideal é o dono ajustar pra realidade do lugar.
// -------------------------------------------------------------------------

const DEFAULT_TAXI_PRICING = {
  baseFare: 5,
  perKmRate: 2,
  perMinRate: 0.3,
  minimumFare: 8
};

function getTaxiPricing() {
  const keys = ["taxi_base_fare", "taxi_per_km_rate", "taxi_per_min_rate", "taxi_minimum_fare"];
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys);
  const stored = {};
  rows.forEach(function (row) {
    stored[row.key] = Number(row.value);
  });

  return {
    baseFare: Number.isFinite(stored.taxi_base_fare) ? stored.taxi_base_fare : DEFAULT_TAXI_PRICING.baseFare,
    perKmRate: Number.isFinite(stored.taxi_per_km_rate) ? stored.taxi_per_km_rate : DEFAULT_TAXI_PRICING.perKmRate,
    perMinRate: Number.isFinite(stored.taxi_per_min_rate) ? stored.taxi_per_min_rate : DEFAULT_TAXI_PRICING.perMinRate,
    minimumFare: Number.isFinite(stored.taxi_minimum_fare) ? stored.taxi_minimum_fare : DEFAULT_TAXI_PRICING.minimumFare
  };
}

function setTaxiPricing(pricing) {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsert.run("taxi_base_fare", String(pricing.baseFare));
  upsert.run("taxi_per_km_rate", String(pricing.perKmRate));
  upsert.run("taxi_per_min_rate", String(pricing.perMinRate));
  upsert.run("taxi_minimum_fare", String(pricing.minimumFare));
}

function calculateSuggestedPrice(distanceKm, durationMin, pricing) {
  const raw = pricing.baseFare + distanceKm * pricing.perKmRate + durationMin * pricing.perMinRate;
  return Number(Math.max(raw, pricing.minimumFare).toFixed(2));
}

// -------------------------------------------------------------------------
// Fechamento de comissão do taxista - mesma lógica do fechamento de lojas
// (store_settlements), adaptada: corrida em dinheiro o taxista já ficou
// com o valor (igual corrida em dinheiro na Uber); corrida no Pix/cartão o
// dinheiro está na conta do Mercado Pago do Alloo. O saldo funciona como
// o "saldo negativo" da Uber - positivo é o que o Alloo deve pro taxista
// (dinheiro de corrida online, já descontada a comissão), negativo é o que
// o taxista deve pro Alloo (comissão de corrida em dinheiro ainda não
// coberta por nenhuma corrida online).
// -------------------------------------------------------------------------

function computeTaxiSettlementRows(periodStart, periodEnd) {
  const tiers = getCommissionTiers("taxi");
  const rideRows = db
    .prepare(
      `SELECT driver_id, quoted_price, payment_provider, payment_status
       FROM ride_requests
       WHERE status = 'Concluída' AND settled_at IS NULL AND driver_id IS NOT NULL AND driver_id != ''
         AND created_at >= ? AND created_at <= ?`
    )
    .all(periodStart, periodEnd);

  // Igual no fechamento de loja: a comissão é calculada corrida a corrida
  // pela tabela de faixas, não uma vez só em cima da soma do período.
  const byDriver = new Map();

  rideRows.forEach(function (ride) {
    const isOnlinePaid = ride.payment_provider === "mercadopago" && ride.payment_status === "pago";
    const price = Number(ride.quoted_price || 0);
    const commission = computeTieredCommission(price, tiers);

    let entry = byDriver.get(ride.driver_id);
    if (!entry) {
      entry = { ridesCount: 0, cashTotal: 0, onlineTotal: 0, grossTotal: 0, commissionTotal: 0 };
      byDriver.set(ride.driver_id, entry);
    }

    entry.ridesCount += 1;
    entry.grossTotal += price;
    entry.commissionTotal += commission;
    if (isOnlinePaid) {
      entry.onlineTotal += price;
    } else {
      entry.cashTotal += price;
    }
  });

  const rows = [];
  byDriver.forEach(function (entry, driverId) {
    const grossTotal = Number(entry.grossTotal.toFixed(2));
    const commissionTotal = Number(entry.commissionTotal.toFixed(2));
    const onlineTotal = Number(entry.onlineTotal.toFixed(2));
    const cashTotal = Number(entry.cashTotal.toFixed(2));
    const netAmount = Number((onlineTotal - commissionTotal).toFixed(2));
    const driverRow = db.prepare("SELECT name, balance FROM taxi_drivers WHERE id = ?").get(driverId);
    const currentBalance = driverRow ? Number(driverRow.balance || 0) : 0;
    const commissionPercent = grossTotal > 0 ? Number(((commissionTotal / grossTotal) * 100).toFixed(2)) : 0;

    rows.push({
      driverId,
      driverName: driverRow ? driverRow.name : driverId,
      ridesCount: entry.ridesCount,
      cashTotal,
      onlineTotal,
      grossTotal,
      commissionPercent,
      commissionTotal,
      netAmount,
      currentBalance,
      balanceAfter: Number((currentBalance + netAmount).toFixed(2))
    });
  });

  return rows;
}

async function handleTaxiSettlementPreview(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const periodStartDate = sanitizeText(urlObject.searchParams.get("start"));
  const periodEndDate = sanitizeText(urlObject.searchParams.get("end"));

  if (!periodStartDate || !periodEndDate) {
    sendJson(res, 400, { error: "Informe o início e o fim do período." });
    return;
  }

  const rows = computeTaxiSettlementRows(dayStartIso(periodStartDate), dayEndIso(periodEndDate));
  sendJson(res, 200, { settlements: rows });
}

async function handleTaxiSettlementClose(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const periodStartDate = sanitizeText(payload.start);
  const periodEndDate = sanitizeText(payload.end);

  if (!periodStartDate || !periodEndDate) {
    sendJson(res, 400, { error: "Informe o início e o fim do período." });
    return;
  }

  const periodStart = dayStartIso(periodStartDate);
  const periodEnd = dayEndIso(periodEndDate);
  const rows = computeTaxiSettlementRows(periodStart, periodEnd);

  if (!rows.length) {
    sendJson(res, 400, { error: "Não há corridas concluídas e ainda não fechadas nesse período." });
    return;
  }

  const now = new Date().toISOString();
  const closed = rows.map(function (row) {
    const settlementId = "taxi-settlement-" + Date.now() + "-" + Math.floor(Math.random() * 1000) + "-" + row.driverId;

    db.prepare(
      `INSERT INTO taxi_settlements (
         id, driver_id, period_start, period_end, rides_count, cash_total, online_total,
         gross_total, commission_percent, commission_total, net_amount, balance_after, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settlementId,
      row.driverId,
      periodStart,
      periodEnd,
      row.ridesCount,
      row.cashTotal,
      row.onlineTotal,
      row.grossTotal,
      row.commissionPercent,
      row.commissionTotal,
      row.netAmount,
      row.balanceAfter,
      now
    );

    db.prepare("UPDATE taxi_drivers SET balance = ? WHERE id = ?").run(row.balanceAfter, row.driverId);

    db.prepare(
      `UPDATE ride_requests SET settled_at = ?
       WHERE driver_id = ? AND status = 'Concluída' AND settled_at IS NULL
         AND created_at >= ? AND created_at <= ?`
    ).run(now, row.driverId, periodStart, periodEnd);

    return Object.assign({}, row, { id: settlementId, periodStart, periodEnd });
  });

  sendJson(res, 200, { settlements: closed });
}

async function handleListTaxiSettlements(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const driverId = sanitizeText(urlObject.searchParams.get("driverId"));
  const baseQuery =
    "SELECT taxi_settlements.*, taxi_drivers.name AS driver_name FROM taxi_settlements " +
    "LEFT JOIN taxi_drivers ON taxi_drivers.id = taxi_settlements.driver_id";
  const rows = driverId
    ? db.prepare(baseQuery + " WHERE driver_id = ? ORDER BY created_at DESC LIMIT 100").all(driverId)
    : db.prepare(baseQuery + " ORDER BY created_at DESC LIMIT 200").all();

  sendJson(res, 200, {
    settlements: rows.map(function (row) {
      return {
        id: row.id,
        driverId: row.driver_id,
        driverName: row.driver_name || row.driver_id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        ridesCount: row.rides_count,
        cashTotal: row.cash_total,
        onlineTotal: row.online_total,
        grossTotal: row.gross_total,
        commissionPercent: row.commission_percent,
        commissionTotal: row.commission_total,
        netAmount: row.net_amount,
        balanceAfter: row.balance_after,
        createdAt: row.created_at
      };
    })
  });
}

async function handleListTaxiDriverBalances(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT id, name, balance FROM taxi_drivers ORDER BY name ASC").all();
  sendJson(res, 200, {
    balances: rows.map(function (row) {
      return { driverId: row.id, driverName: row.name, balance: Number(row.balance || 0) };
    })
  });
}

// Ajuste manual de saldo do taxista, pra registrar um pagamento por fora do
// fechamento automático - ex.: você fez um Pix pro taxista com o valor que
// devia (type "payout", tira do saldo) ou o taxista te pagou a comissão
// que devia (type "collection", soma no saldo).
async function handleCreateTaxiBalanceAdjustment(req, res, driverId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const driver = findTaxiDriverById(driverId);
  if (!driver) {
    sendJson(res, 404, { error: "Taxista não encontrado." });
    return;
  }

  const payload = await readRequestBody(req);
  const type = payload.type === "collection" ? "collection" : "payout";
  const amount = Math.abs(Number(payload.amount) || 0);
  const note = sanitizeText(payload.note).slice(0, 300);

  if (!amount) {
    sendJson(res, 400, { error: "Informe um valor maior que zero." });
    return;
  }

  const signedAmount = type === "payout" ? -amount : amount;
  const balanceAfter = Number((Number(driver.balance || 0) + signedAmount).toFixed(2));

  db.prepare("UPDATE taxi_drivers SET balance = ? WHERE id = ?").run(balanceAfter, driverId);
  db.prepare(
    "INSERT INTO taxi_balance_adjustments (id, driver_id, amount, note, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "taxi-adjustment-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    driverId,
    signedAmount,
    (type === "payout" ? "Repasse pro taxista" : "Recebimento do taxista") + (note ? " - " + note : ""),
    balanceAfter,
    new Date().toISOString()
  );

  sendJson(res, 200, { balance: balanceAfter });
}

// -------------------------------------------------------------------------
// Fechamento de comissão do prestador de serviço - mesma lógica do
// fechamento de loja/táxi, adaptada: atendimento em dinheiro o prestador já
// ficou com o valor na hora; atendimento pago Pix/cartão dentro do app fica
// na conta do Mercado Pago do Alloo até o repasse. Só entra no fechamento o
// atendimento marcado como "concluido" - orçamento recusado ou atendimento
// cancelado nunca geram comissão.
// -------------------------------------------------------------------------

function computeProviderSettlementRows(periodStart, periodEnd) {
  const tiers = getCommissionTiers("provider");
  const visitCommissionRate = getProviderVisitCommissionRate();
  const bookingRows = db
    .prepare(
      `SELECT provider_id, price, payment_provider, payment_status, kind
       FROM provider_bookings
       WHERE status = 'concluido' AND settled_at IS NULL
         AND created_at >= ? AND created_at <= ?`
    )
    .all(periodStart, periodEnd);

  const byProvider = new Map();

  bookingRows.forEach(function (booking) {
    const isOnlinePaid = booking.payment_provider === "mercadopago" && booking.payment_status === "pago";
    const price = Number(booking.price || 0);
    // Visita técnica: taxa única, fixa (não em faixa) - o serviço em si
    // continua na comissão em faixa, igual sempre funcionou.
    const commission =
      booking.kind === "visita"
        ? Number(((price * visitCommissionRate) / 100).toFixed(2))
        : computeTieredCommission(price, tiers);

    let entry = byProvider.get(booking.provider_id);
    if (!entry) {
      entry = { bookingsCount: 0, cashTotal: 0, onlineTotal: 0, grossTotal: 0, commissionTotal: 0 };
      byProvider.set(booking.provider_id, entry);
    }

    entry.bookingsCount += 1;
    entry.grossTotal += price;
    entry.commissionTotal += commission;
    if (isOnlinePaid) {
      entry.onlineTotal += price;
    } else {
      entry.cashTotal += price;
    }
  });

  const rows = [];
  byProvider.forEach(function (entry, providerId) {
    const grossTotal = Number(entry.grossTotal.toFixed(2));
    const commissionTotal = Number(entry.commissionTotal.toFixed(2));
    const onlineTotal = Number(entry.onlineTotal.toFixed(2));
    const cashTotal = Number(entry.cashTotal.toFixed(2));
    const netAmount = Number((onlineTotal - commissionTotal).toFixed(2));
    const providerRow = db.prepare("SELECT name, balance FROM service_providers WHERE id = ?").get(providerId);
    const currentBalance = providerRow ? Number(providerRow.balance || 0) : 0;
    const commissionPercent = grossTotal > 0 ? Number(((commissionTotal / grossTotal) * 100).toFixed(2)) : 0;

    rows.push({
      providerId,
      providerName: providerRow ? providerRow.name : providerId,
      bookingsCount: entry.bookingsCount,
      cashTotal,
      onlineTotal,
      grossTotal,
      commissionPercent,
      commissionTotal,
      netAmount,
      currentBalance,
      balanceAfter: Number((currentBalance + netAmount).toFixed(2))
    });
  });

  return rows;
}

async function handleProviderSettlementPreview(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const periodStartDate = sanitizeText(urlObject.searchParams.get("start"));
  const periodEndDate = sanitizeText(urlObject.searchParams.get("end"));

  if (!periodStartDate || !periodEndDate) {
    sendJson(res, 400, { error: "Informe o início e o fim do período." });
    return;
  }

  const rows = computeProviderSettlementRows(dayStartIso(periodStartDate), dayEndIso(periodEndDate));
  sendJson(res, 200, { settlements: rows });
}

async function handleProviderSettlementClose(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const periodStartDate = sanitizeText(payload.start);
  const periodEndDate = sanitizeText(payload.end);

  if (!periodStartDate || !periodEndDate) {
    sendJson(res, 400, { error: "Informe o início e o fim do período." });
    return;
  }

  const periodStart = dayStartIso(periodStartDate);
  const periodEnd = dayEndIso(periodEndDate);
  const rows = computeProviderSettlementRows(periodStart, periodEnd);

  if (!rows.length) {
    sendJson(res, 400, { error: "Não há atendimentos concluídos e ainda não fechados nesse período." });
    return;
  }

  const now = new Date().toISOString();
  const closed = rows.map(function (row) {
    const settlementId =
      "provider-settlement-" + Date.now() + "-" + Math.floor(Math.random() * 1000) + "-" + row.providerId;

    db.prepare(
      `INSERT INTO provider_settlements (
         id, provider_id, period_start, period_end, bookings_count, cash_total, online_total,
         gross_total, commission_percent, commission_total, net_amount, balance_after, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settlementId,
      row.providerId,
      periodStart,
      periodEnd,
      row.bookingsCount,
      row.cashTotal,
      row.onlineTotal,
      row.grossTotal,
      row.commissionPercent,
      row.commissionTotal,
      row.netAmount,
      row.balanceAfter,
      now
    );

    db.prepare("UPDATE service_providers SET balance = ? WHERE id = ?").run(row.balanceAfter, row.providerId);

    db.prepare(
      `UPDATE provider_bookings SET settled_at = ?
       WHERE provider_id = ? AND status = 'concluido' AND settled_at IS NULL
         AND created_at >= ? AND created_at <= ?`
    ).run(now, row.providerId, periodStart, periodEnd);

    return Object.assign({}, row, { id: settlementId, periodStart, periodEnd });
  });

  sendJson(res, 200, { settlements: closed });
}

async function handleListProviderSettlements(req, res, urlObject) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const providerId = sanitizeText(urlObject.searchParams.get("providerId"));
  const baseQuery =
    "SELECT provider_settlements.*, service_providers.name AS provider_name FROM provider_settlements " +
    "LEFT JOIN service_providers ON service_providers.id = provider_settlements.provider_id";
  const rows = providerId
    ? db.prepare(baseQuery + " WHERE provider_id = ? ORDER BY created_at DESC LIMIT 100").all(providerId)
    : db.prepare(baseQuery + " ORDER BY created_at DESC LIMIT 200").all();

  sendJson(res, 200, {
    settlements: rows.map(function (row) {
      return {
        id: row.id,
        providerId: row.provider_id,
        providerName: row.provider_name || row.provider_id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        bookingsCount: row.bookings_count,
        cashTotal: row.cash_total,
        onlineTotal: row.online_total,
        grossTotal: row.gross_total,
        commissionPercent: row.commission_percent,
        commissionTotal: row.commission_total,
        netAmount: row.net_amount,
        balanceAfter: row.balance_after,
        createdAt: row.created_at
      };
    })
  });
}

async function handleListProviderBalances(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const rows = db.prepare("SELECT id, name, balance FROM service_providers ORDER BY name ASC").all();
  sendJson(res, 200, {
    balances: rows.map(function (row) {
      return { providerId: row.id, providerName: row.name, balance: Number(row.balance || 0) };
    })
  });
}

// Ajuste manual de saldo do prestador, pra registrar um pagamento por fora
// do fechamento automático - ex.: você fez um Pix pro prestador com o valor
// que devia (type "payout", tira do saldo) ou o prestador te pagou a
// comissão que devia (type "collection", soma no saldo).
async function handleCreateProviderBalanceAdjustment(req, res, providerId) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const provider = findProviderById(providerId);
  if (!provider) {
    sendJson(res, 404, { error: "Prestador não encontrado." });
    return;
  }

  const payload = await readRequestBody(req);
  const type = payload.type === "collection" ? "collection" : "payout";
  const amount = Math.abs(Number(payload.amount) || 0);
  const note = sanitizeText(payload.note).slice(0, 300);

  if (!amount) {
    sendJson(res, 400, { error: "Informe um valor maior que zero." });
    return;
  }

  const signedAmount = type === "payout" ? -amount : amount;
  const balanceAfter = Number((Number(provider.balance || 0) + signedAmount).toFixed(2));

  db.prepare("UPDATE service_providers SET balance = ? WHERE id = ?").run(balanceAfter, providerId);
  db.prepare(
    "INSERT INTO provider_balance_adjustments (id, provider_id, amount, note, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "provider-adjustment-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    providerId,
    signedAmount,
    (type === "payout" ? "Repasse pro prestador" : "Recebimento do prestador") + (note ? " - " + note : ""),
    balanceAfter,
    new Date().toISOString()
  );

  sendJson(res, 200, { balance: balanceAfter });
}

async function handleGetTaxiPricing(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }
  sendJson(res, 200, { pricing: getTaxiPricing() });
}

async function handleUpdateTaxiPricing(req, res) {
  if (!requireAdmin(req, res)) {
    return;
  }

  const payload = await readRequestBody(req);
  const baseFare = Number(payload.baseFare);
  const perKmRate = Number(payload.perKmRate);
  const perMinRate = Number(payload.perMinRate);
  const minimumFare = Number(payload.minimumFare);

  const values = [baseFare, perKmRate, perMinRate, minimumFare];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    sendJson(res, 400, { error: "Informe valores válidos (maiores ou iguais a zero) para todos os campos." });
    return;
  }

  setTaxiPricing({ baseFare, perKmRate, perMinRate, minimumFare });
  sendJson(res, 200, { pricing: getTaxiPricing() });
}

// Calcula a rota real (por ruas, não linha reta) entre dois pontos usando o
// OSRM (Open Source Routing Machine) - um serviço aberto que roda em cima
// do mesmo mapa (OpenStreetMap) que o app já usa, sem precisar de chave de
// API paga. É o mesmo tipo de cálculo que a Uber faz por trás pra saber a
// distância/tempo reais de uma corrida antes dela começar.
// Observação: usamos aqui o servidor de demonstração público do OSRM
// (router.project-osrm.org), que é gratuito mas tem limite de uso - serve
// bem pra um app de porte pequeno/médio; se o volume de corridas crescer
// bastante, o ideal é hospedar uma instância própria do OSRM.
const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving";

async function getRealRoute(pickupLat, pickupLng, destinationLat, destinationLng) {
  const url =
    OSRM_BASE_URL +
    "/" +
    destinationCoordsPath(pickupLng, pickupLat, destinationLng, destinationLat) +
    "?overview=false";

  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) {
    throw new Error("Falha ao calcular rota (OSRM respondeu " + response.status + ")");
  }
  const data = await response.json();
  if (data.code !== "Ok" || !data.routes || !data.routes[0]) {
    throw new Error("Rota não encontrada.");
  }

  return {
    distanceKm: Number((data.routes[0].distance / 1000).toFixed(2)),
    durationMin: Number((data.routes[0].duration / 60).toFixed(1))
  };
}

function destinationCoordsPath(lng1, lat1, lng2, lat2) {
  return lng1 + "," + lat1 + ";" + lng2 + "," + lat2;
}

// Estimativa de reserva quando o OSRM não responde (fora do ar, sem
// internet, demorou demais) - já que agora o preço da corrida é sempre
// definido na hora do pedido (sem "combinar depois"), a corrida não pode
// ficar sem valor só porque um serviço externo falhou. Usa distância em
// linha reta corrigida por um fator médio de "quanto uma rua real serpenteia
// a mais que a linha reta" (~1.35x, valor de referência comum pra área
// urbana/suburbana) e uma velocidade média de 28 km/h pra estimar o tempo.
const ROAD_DISTANCE_FACTOR = 1.35;
const AVERAGE_SPEED_KMH = 28;

function estimateRouteFallback(pickupLat, pickupLng, destinationLat, destinationLng) {
  const straightLineKm = haversineDistanceKm(pickupLat, pickupLng, destinationLat, destinationLng);
  const distanceKm = Number((straightLineKm * ROAD_DISTANCE_FACTOR).toFixed(2));
  const durationMin = Number(((distanceKm / AVERAGE_SPEED_KMH) * 60).toFixed(1));
  return { distanceKm, durationMin };
}

// Tenta a rota real primeiro (mais precisa); se o serviço externo falhar
// por qualquer motivo, cai pra estimativa por linha reta, mas nunca deixa
// de devolver uma distância/tempo - é assim que garantimos que toda corrida
// sai com um preço fechado, do jeito que a Uber faz.
async function getRouteOrFallback(pickupLat, pickupLng, destinationLat, destinationLng) {
  try {
    return await getRealRoute(pickupLat, pickupLng, destinationLat, destinationLng);
  } catch (error) {
    return estimateRouteFallback(pickupLat, pickupLng, destinationLat, destinationLng);
  }
}

// -------------------------------------------------------------------------
// Busca de endereço (autocomplete) e geocodificação reversa - pro cliente
// digitar o destino e ir vendo sugestões antes mesmo de terminar de
// escrever, igual a Uber faz, em vez de precisar tocar num mapa pra marcar
// o ponto. Usa o Nominatim (serviço de busca de endereços do
// OpenStreetMap, gratuito, mesma família de serviço do OSRM que já
// usávamos pras rotas) e, se ele estiver fora do ar, cai pra uma lista
// local com o centro das cidades que o app atende - assim a busca nunca
// fica "vazia" por causa de um serviço externo indisponível.
const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";
const NOMINATIM_USER_AGENT = "AllooTaxi/1.0 (contato: juniorelizandro90@gmail.com)";

// Centro das cidades do litoral do Paraná atendidas pelo app (mesma lista
// de COASTAL_PARANA_CITIES usada no cadastro do cliente), mais alguns
// pontos bem conhecidos (rodoviária, hospital, praças) das cidades onde a
// maior parte das corridas acontece - serve como sugestão instantânea
// (sem precisar de internet) e como reserva se o Nominatim não responder.
// Observação sobre precisão: em Morretes e Antonina (cidades pequenas, com
// centro histórico bem compacto) os pontos abaixo usam a mesma coordenada
// do centro da cidade - a distância entre eles de verdade é de no máximo
// algumas centenas de metros, o que não muda o valor da corrida de forma
// relevante e ainda ajuda o taxista, que já reconhece esses lugares pelo
// nome. Coordenadas de referência: centro das cidades e endereços dos
// pontos buscados publicamente (rodoviárias, hospitais).
const LOCAL_PLACES = [
  { label: "Morretes - Centro", lat: -25.4784, lng: -48.8335 },
  { label: "Rodoviária de Morretes", lat: -25.4784, lng: -48.8335 },
  { label: "Hospital de Morretes", lat: -25.4784, lng: -48.8335 },
  { label: "Praça Rocha Pombo - Morretes", lat: -25.4784, lng: -48.8335 },
  { label: "Praça dos Imigrantes - Morretes", lat: -25.4784, lng: -48.8335 },
  { label: "Antonina - Centro", lat: -25.4289, lng: -48.7119 },
  { label: "Rodoviária de Antonina", lat: -25.4289, lng: -48.7119 },
  { label: "Hospital Municipal de Antonina", lat: -25.4289, lng: -48.7119 },
  { label: "Porto de Antonina", lat: -25.4289, lng: -48.7119 },
  { label: "Guaraqueçaba - Centro", lat: -25.3067, lng: -48.3289 },
  { label: "Guaratuba - Centro", lat: -25.9, lng: -48.5667 },
  { label: "Matinhos - Centro", lat: -25.8167, lng: -48.5333 },
  { label: "Paranaguá - Centro", lat: -25.52, lng: -48.5089 },
  { label: "Rodoviária de Paranaguá", lat: -25.52, lng: -48.5089 },
  { label: "Pontal do Paraná - Centro", lat: -25.6736, lng: -48.5111 }
];

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function searchLocalPlaces(query) {
  const normalizedQuery = normalizeSearchText(query);
  return LOCAL_PLACES.filter(function (place) {
    return normalizeSearchText(place.label).indexOf(normalizedQuery) >= 0;
  });
}

// Caixa (bounding box) que envolve as 7 cidades do litoral do Paraná
// atendidas pelo app, com uma margem de segurança - usada só como
// PREFERÊNCIA de área (bounded=0), nunca como filtro rígido, senão um
// cliente digitando um destino fora dessa área nunca acharia nada.
// Formato exigido pelo Nominatim: "esquerda,topo,direita,baixo" (longitude
// mín, latitude máx, longitude máx, latitude mín).
const COASTAL_PARANA_VIEWBOX = "-49.0,-25.2,-48.2,-26.0";

async function searchAddressRemote(query) {
  // Importante: NÃO colamos nenhum texto extra tipo ", litoral do Paraná"
  // na busca - o Nominatim não reconhece esse nome de região informal, e
  // qualquer token que ele não reconheça pode fazer a busca inteira falhar
  // mesmo pra um endereço real. A preferência pela nossa região é feita só
  // pelo viewbox (não-obrigatório) abaixo.
  const url =
    NOMINATIM_BASE_URL +
    "/search?format=json&limit=6&countrycodes=br&addressdetails=0&bounded=0&viewbox=" +
    COASTAL_PARANA_VIEWBOX +
    "&email=" +
    encodeURIComponent("juniorelizandro90@gmail.com") +
    "&q=" +
    encodeURIComponent(query);

  const response = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok) {
    throw new Error("Falha ao buscar endereço (Nominatim respondeu " + response.status + ")");
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map(function (item) {
    return { label: item.display_name, lat: Number(item.lat), lng: Number(item.lon) };
  });
}

// Junta os resultados locais (instantâneos) com os do Nominatim (mais
// completos), sem repetir pontos muito próximos um do outro.
function mergePlaceResults(localMatches, remoteMatches) {
  const merged = localMatches.slice();
  remoteMatches.forEach(function (candidate) {
    const isDuplicate = merged.some(function (existing) {
      return (
        Math.abs(existing.lat - candidate.lat) < 0.001 && Math.abs(existing.lng - candidate.lng) < 0.001
      );
    });
    if (!isDuplicate) {
      merged.push(candidate);
    }
  });
  return merged.slice(0, 6);
}

async function handleGeocodeSearch(req, res, urlObject) {
  const query = sanitizeText(urlObject.searchParams.get("q")).trim();
  if (query.length < 3) {
    sendJson(res, 200, { results: [] });
    return;
  }

  const localMatches = searchLocalPlaces(query);
  let remoteMatches = [];
  try {
    remoteMatches = await searchAddressRemote(query);
  } catch (error) {
    remoteMatches = [];
  }

  sendJson(res, 200, { results: mergePlaceResults(localMatches, remoteMatches) });
}

async function reverseGeocodeRemote(lat, lng) {
  const url =
    NOMINATIM_BASE_URL + "/reverse?format=json&lat=" + lat + "&lon=" + lng + "&zoom=17&addressdetails=0";

  const response = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error("Falha ao buscar endereço (Nominatim respondeu " + response.status + ")");
  }
  const data = await response.json();
  if (!data || !data.display_name) {
    throw new Error("Endereço não encontrado pra essas coordenadas.");
  }
  return data.display_name;
}

// Descobre um texto legível pro local de partida a partir das coordenadas
// do GPS do cliente (ex.: "Rua XV de Novembro, Morretes"), pra já deixar o
// campo de referência preenchido - mas nunca bloqueia o pedido de corrida:
// se não conseguir (sem internet, Nominatim fora do ar), devolve label nula
// e o cliente digita a referência manualmente, como já fazia antes.
async function handleGeocodeReverse(req, res, urlObject) {
  const lat = Number(urlObject.searchParams.get("lat"));
  const lng = Number(urlObject.searchParams.get("lng"));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    sendJson(res, 400, { error: "Coordenadas inválidas." });
    return;
  }

  try {
    const label = await reverseGeocodeRemote(lat, lng);
    sendJson(res, 200, { label });
  } catch (error) {
    sendJson(res, 200, { label: null });
  }
}

function createTaxiSession(driver) {
  const token = createToken();
  const session = {
    driverId: driver.id,
    username: driver.username,
    name: driver.name,
    expiresAt: Date.now() + SESSION_TTL_MS
  };
  taxiSessions.set(token, session);
  persistSession(token, "taxi", session);
  return token;
}

async function handleTaxiLogin(req, res) {
  const payload = await readRequestBody(req);
  const username = sanitizeText(payload.username);
  const password = sanitizeText(payload.password);
  const driver = findTaxiDriverByUsername(username);

  if (!driver || !verifyPassword(password, driver.passwordHash)) {
    sendJson(res, 401, { error: "Usuário ou senha inválidos." });
    return;
  }

  const token = createTaxiSession(driver);
  sendJson(res, 200, { driver: getPublicTaxiDriver(driver), token });
}

async function handleTaxiDashboard(req, res) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const driver = findTaxiDriverById(session.driverId);
  if (!driver) {
    sendJson(res, 404, { error: "Conta de taxista não encontrada." });
    return;
  }

  const activeRideRow = db
    .prepare(
      "SELECT * FROM ride_requests WHERE driver_id = ? AND status NOT IN ('Concluída', 'Cancelada') ORDER BY created_at DESC LIMIT 1"
    )
    .get(driver.id);

  sendJson(res, 200, {
    driver: getPublicTaxiDriver(driver),
    isOnline: driver.isOnline,
    activeRide: activeRideRow ? rowToRide(activeRideRow) : null
  });
}

// Resumo de ganhos "de hoje" pro taxista, pro painel mostrar algo parecido
// com o resumo de ganhos do app de motorista - soma o valor combinado das
// corridas concluídas desde a meia-noite (horário local do servidor).
async function handleTaxiHistory(req, res) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const rows = db
    .prepare(
      "SELECT * FROM ride_requests WHERE driver_id = ? AND status = 'Concluída' AND created_at >= ? ORDER BY created_at DESC"
    )
    .all(session.driverId, startOfDay.toISOString());

  const rides = rows.map(rowToRide);
  const totalEarnings = rides.reduce(function (sum, ride) {
    return sum + (ride.quotedPrice || 0);
  }, 0);

  // Saldo de comissão com o Alloo (positivo = o Alloo deve pro taxista,
  // negativo = o taxista deve de comissão) - mostrado no painel dele pra
  // não ter surpresa na hora do fechamento, igual ao "Wallet" da Uber.
  const driver = findTaxiDriverById(session.driverId);

  sendJson(res, 200, {
    rides,
    totalEarnings,
    tripCount: rides.length,
    commissionBalance: driver ? driver.balance : 0
  });
}

async function handleSetTaxiOnline(req, res) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const online = !!payload.online;

  if (online) {
    const driver = findTaxiDriverById(session.driverId);
    if (!driver || driver.verificationStatus !== "aprovado") {
      sendJson(res, 403, {
        error:
          driver && driver.verificationStatus === "recusado"
            ? "Seus documentos foram recusados. " + (driver.verificationNote || "Fale com o Alloo pra entender o motivo.")
            : "Seus documentos ainda estão em análise. Você só consegue ficar online depois que forem aprovados."
      });
      return;
    }
  }

  db.prepare("UPDATE taxi_drivers SET is_online = ? WHERE id = ?").run(online ? 1 : 0, session.driverId);
  sendJson(res, 200, { isOnline: online });
}

async function handleUpdateTaxiLocation(req, res) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const payload = await readRequestBody(req);
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    sendJson(res, 400, { error: "Localização inválida." });
    return;
  }

  db.prepare("UPDATE taxi_drivers SET lat = ?, lng = ?, location_updated_at = ? WHERE id = ?").run(
    lat,
    lng,
    new Date().toISOString(),
    session.driverId
  );

  // Se o taxista tem uma corrida em andamento, avisa quem está acompanhando
  // ela (o cliente) pra atualizar a posição no mapa em tempo real, sem
  // incomodar quem está vendo outra corrida.
  const activeRideRow = db
    .prepare(
      "SELECT id FROM ride_requests WHERE driver_id = ? AND status NOT IN ('Concluída', 'Cancelada') ORDER BY created_at DESC LIMIT 1"
    )
    .get(session.driverId);
  if (activeRideRow) {
    broadcastToRide(activeRideRow.id, { type: "driver_location_updated", rideId: activeRideRow.id });
  }

  sendJson(res, 200, { ok: true });
}

function rowToRide(row) {
  return {
    id: row.id,
    customerId: row.customer_id || "",
    customerName: row.customer_name,
    customerPhone: row.customer_phone || "",
    pickupLabel: row.pickup_label || "",
    pickupLat: Number(row.pickup_lat),
    pickupLng: Number(row.pickup_lng),
    destinationLabel: row.destination_label || "",
    destinationLat: row.destination_lat != null ? Number(row.destination_lat) : null,
    destinationLng: row.destination_lng != null ? Number(row.destination_lng) : null,
    estimatedDistanceKm: row.estimated_distance_km != null ? Number(row.estimated_distance_km) : null,
    estimatedDurationMin: row.estimated_duration_min != null ? Number(row.estimated_duration_min) : null,
    suggestedPrice: row.suggested_price != null ? Number(row.suggested_price) : null,
    notes: row.notes || "",
    status: row.status,
    statusHistory: JSON.parse(row.status_history_json || "[]"),
    driverId: row.driver_id || "",
    driverName: row.driver_name || "",
    quotedPrice: row.quoted_price != null ? Number(row.quoted_price) : null,
    paymentMethod: row.payment_method || "Dinheiro",
    paymentStatus: row.payment_status || "nao_aplicavel",
    paymentProvider: row.payment_provider || "",
    paymentDetail: row.payment_detail || "",
    mpOrderId: row.mp_order_id || "",
    pixQrCode: row.pix_qr_code || "",
    pixQrCodeBase64: row.pix_qr_code_base64 || "",
    pixTicketUrl: row.pix_ticket_url || "",
    settledAt: row.settled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Devolve o pedido de corrida junto com a posição atual do motorista (se
// já tiver um atribuído) - usado tanto pro cliente acompanhar a corrida
// quanto pro taxista ver o próprio pedido em andamento.
function rideWithDriverLocation(ride) {
  if (!ride.driverId) {
    return Object.assign({}, ride, { driverLat: null, driverLng: null, driverLocationUpdatedAt: "" });
  }

  const driver = findTaxiDriverById(ride.driverId);
  return Object.assign({}, ride, {
    driverLat: driver ? driver.lat : null,
    driverLng: driver ? driver.lng : null,
    driverLocationUpdatedAt: driver ? driver.locationUpdatedAt : ""
  });
}

// Estimativa de valor ANTES de pedir a corrida - o mesmo que a Uber mostra
// pro passageiro antes dele confirmar o pedido. Não cria nada no banco, só
// calcula a rota real (OSRM) e aplica a fórmula de preço.
async function handleEstimateRideFare(req, res) {
  const payload = await readRequestBody(req);
  const pickupLat = Number(payload.pickupLat);
  const pickupLng = Number(payload.pickupLng);
  const destinationLat = Number(payload.destinationLat);
  const destinationLng = Number(payload.destinationLng);

  if (
    !Number.isFinite(pickupLat) ||
    !Number.isFinite(pickupLng) ||
    !Number.isFinite(destinationLat) ||
    !Number.isFinite(destinationLng)
  ) {
    sendJson(res, 400, { error: "Informe o local de partida e o destino." });
    return;
  }

  try {
    const route = await getRouteOrFallback(pickupLat, pickupLng, destinationLat, destinationLng);
    const suggestedPrice = calculateSuggestedPrice(route.distanceKm, route.durationMin, getTaxiPricing());
    sendJson(res, 200, {
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      suggestedPrice
    });
  } catch (error) {
    sendJson(res, 502, { error: "Não foi possível calcular o valor agora. Tente de novo em instantes." });
  }
}

async function handleCreateRide(req, res) {
  const payload = await readRequestBody(req);
  const pickupLat = Number(payload.pickupLat);
  const pickupLng = Number(payload.pickupLng);

  if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
    sendJson(res, 400, { error: "Não conseguimos identificar sua localização de partida." });
    return;
  }

  const customerName = sanitizeText(payload.customerName) || "Cliente";
  const customerPhone = sanitizeText(payload.customerPhone);

  if (!customerPhone) {
    sendJson(res, 400, { error: "Informe um telefone de contato." });
    return;
  }

  // O destino agora é obrigatório: sem ele não dá pra calcular a rota nem
  // fechar um preço antes da corrida começar - e é exatamente isso que
  // substitui o "taxista informa o valor depois" de antes. O preço mostrado
  // aqui é o preço final, igual a tarifa fechada que a Uber mostra antes de
  // você confirmar o pedido - o taxista não define nem ajusta valor nenhum.
  const destinationLat = Number(payload.destinationLat);
  const destinationLng = Number(payload.destinationLng);

  if (!Number.isFinite(destinationLat) || !Number.isFinite(destinationLng)) {
    sendJson(res, 400, { error: "Marque o destino no mapa pra calcularmos o valor da corrida." });
    return;
  }

  const route = await getRouteOrFallback(pickupLat, pickupLng, destinationLat, destinationLng);
  const estimatedDistanceKm = route.distanceKm;
  const estimatedDurationMin = route.durationMin;
  const finalPrice = calculateSuggestedPrice(route.distanceKm, route.durationMin, getTaxiPricing());

  // Forma de pagamento: dinheiro (o taxista recebe direto, sem cobrança
  // pelo app) ou Pix/cartão (cobrado dentro do app, via Mercado Pago).
  // Corrida em dinheiro já nasce visível pros taxistas, do jeito que
  // sempre funcionou. Corrida no Pix/cartão só aparece pra eles depois que
  // o pagamento é confirmado - ninguém dirige até um pickup por causa de
  // uma corrida que pode nem ter sido paga de verdade.
  const paymentMethod = RIDE_ONLINE_PAYMENT_METHODS.indexOf(sanitizeText(payload.paymentMethod)) >= 0
    ? sanitizeText(payload.paymentMethod)
    : "Dinheiro";
  const isOnlinePayment = isOnlineRidePaymentMethod(paymentMethod);
  const initialStatus = isOnlinePayment ? "Aguardando pagamento" : "Novo";

  const now = new Date().toISOString();
  const ride = {
    id: "corrida-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    customerId: sanitizeText(payload.customerId),
    customerName,
    customerPhone,
    pickupLabel: sanitizeText(payload.pickupLabel),
    pickupLat,
    pickupLng,
    destinationLabel: sanitizeText(payload.destinationLabel),
    destinationLat,
    destinationLng,
    estimatedDistanceKm,
    estimatedDurationMin,
    suggestedPrice: finalPrice,
    notes: sanitizeText(payload.notes).slice(0, 300),
    status: initialStatus,
    statusHistory: [{ status: initialStatus, at: now }],
    driverId: "",
    driverName: "",
    quotedPrice: finalPrice,
    paymentMethod,
    paymentStatus: isOnlinePayment ? "pendente" : "nao_aplicavel",
    createdAt: now,
    updatedAt: now
  };

  db.prepare(
    `INSERT INTO ride_requests (
       id, customer_id, customer_name, customer_phone, pickup_label, pickup_lat, pickup_lng,
       destination_label, destination_lat, destination_lng, estimated_distance_km, estimated_duration_min,
       suggested_price, notes, status, status_history_json, driver_id, driver_name, quoted_price,
       payment_method, payment_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ride.id,
    ride.customerId,
    ride.customerName,
    ride.customerPhone,
    ride.pickupLabel,
    ride.pickupLat,
    ride.pickupLng,
    ride.destinationLabel,
    ride.destinationLat,
    ride.destinationLng,
    ride.estimatedDistanceKm,
    ride.estimatedDurationMin,
    ride.suggestedPrice,
    ride.notes,
    ride.status,
    JSON.stringify(ride.statusHistory),
    ride.driverId,
    ride.driverName,
    ride.quotedPrice,
    ride.paymentMethod,
    ride.paymentStatus,
    ride.createdAt,
    ride.updatedAt
  );

  // Corrida em dinheiro já sai visível pros taxistas na hora, como sempre.
  // Corrida no Pix/cartão só é anunciada pros taxistas quando o pagamento
  // for confirmado (ver handleCreateRidePixPayment/handleCreateRideCardPayment
  // e syncRidePaymentStatusFromMercadoPago).
  if (!isOnlinePayment) {
    broadcastToTaxiDashboards({ type: "ride_created", rideId: ride.id });
  }

  sendJson(res, 201, { ride });
}

async function handleGetRide(req, res, rideId) {
  const row = db.prepare("SELECT * FROM ride_requests WHERE id = ?").get(rideId);

  if (!row) {
    sendJson(res, 404, { error: "Corrida não encontrada." });
    return;
  }

  sendJson(res, 200, { ride: rideWithDriverLocation(rowToRide(row)) });
}

async function handleCancelRide(req, res, rideId) {
  const row = db.prepare("SELECT * FROM ride_requests WHERE id = ?").get(rideId);

  if (!row) {
    sendJson(res, 404, { error: "Corrida não encontrada." });
    return;
  }

  const ride = rowToRide(row);

  if (ride.status === "Concluída" || ride.status === "Cancelada") {
    sendJson(res, 400, { error: "Essa corrida já foi encerrada." });
    return;
  }

  ride.statusHistory.push({ status: "Cancelada", at: new Date().toISOString() });
  db.prepare("UPDATE ride_requests SET status = 'Cancelada', status_history_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(ride.statusHistory),
    new Date().toISOString(),
    rideId
  );

  broadcastToRide(rideId, { type: "ride_updated", rideId });
  broadcastToTaxiDashboards({ type: "ride_cancelled", rideId });

  // Se a corrida já tinha pagamento online confirmado (Pix ou cartão),
  // estorna sozinho - o cliente não precisa pedir, do mesmo jeito que já
  // acontece quando um pedido de loja é cancelado.
  let updatedRide = findRideById(rideId);
  const refund = await maybeRefundCancelledRide(updatedRide);
  if (refund.attempted) {
    updatedRide = findRideById(rideId);
  }

  sendJson(res, 200, { ride: updatedRide, refund });
}

// -------------------------------------------------------------------------
// Pagamento da corrida (dinheiro, Pix ou cartão via Mercado Pago) - mesma
// mecânica já usada pros pedidos das lojas, adaptada pra corrida: o
// dinheiro do Pix/cartão cai na conta do Mercado Pago da plataforma, e o
// que é devido ao taxista (valor da corrida menos a comissão do Alloo) é
// acertado depois, no fechamento de período (ver seção de comissão mais
// abaixo) - não existe repasse automático pro taxista, alguém do Alloo
// paga ele via Pix e registra isso no painel, igual já funciona pras lojas.
// -------------------------------------------------------------------------

async function handleCreateRidePixPayment(req, res) {
  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online ainda não foi configurado neste servidor." });
    return;
  }

  const payload = await readRequestBody(req);
  const rideId = sanitizeText(payload.rideId);
  const payerEmail = normalizeEmail(payload.payerEmail) || "cliente@alloo.com";
  const ride = findRideById(rideId);

  if (!ride) {
    sendJson(res, 404, { error: "Corrida não encontrada." });
    return;
  }

  if (ride.paymentStatus === "pago") {
    sendJson(res, 400, { error: "Essa corrida já está paga." });
    return;
  }

  if (ride.status === "Cancelada") {
    sendJson(res, 400, { error: "Essa corrida foi cancelada." });
    return;
  }

  const amount = Number(ride.quotedPrice || 0).toFixed(2);

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", "/v1/orders", {
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: ride.id,
      notification_url: getPaymentWebhookUrl(req),
      payer: { email: payerEmail },
      transactions: {
        payments: [
          {
            amount,
            payment_method: { id: "pix", type: "bank_transfer" }
          }
        ]
      }
    });
  } catch (error) {
    logPaymentError("ride-pix-network", ride.id, null, { message: error && error.message });
    sendJson(res, 503, { error: "Não foi possível falar com o Mercado Pago agora." });
    return;
  }

  if (!mpResponse.ok) {
    logPaymentError("ride-pix", ride.id, mpResponse.status, mpResponse.data);
    sendJson(res, 400, {
      error: extractMercadoPagoErrorReason(mpResponse.data) || "Não foi possível gerar a cobrança Pix."
    });
    return;
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentMethodData = transaction.payment_method || {};

  updateRidePaymentRow(ride.id, {
    paymentProvider: "mercadopago",
    paymentStatus: "pendente",
    paymentDetail: mpResponse.data.status_detail || "",
    mpOrderId: mpResponse.data.id || "",
    pixQrCode: paymentMethodData.qr_code || "",
    pixQrCodeBase64: paymentMethodData.qr_code_base64 || "",
    pixTicketUrl: paymentMethodData.ticket_url || ""
  });

  sendJson(res, 200, {
    qrCode: paymentMethodData.qr_code || "",
    qrCodeBase64: paymentMethodData.qr_code_base64 || "",
    ticketUrl: paymentMethodData.ticket_url || "",
    paymentStatus: "pendente"
  });
}

async function handleCreateRideCardPayment(req, res) {
  if (!isMercadoPagoEnabled()) {
    sendJson(res, 503, { error: "Pagamento online ainda não foi configurado neste servidor." });
    return;
  }

  const payload = await readRequestBody(req);
  const rideId = sanitizeText(payload.rideId);
  const token = sanitizeText(payload.token);
  const paymentMethodId = sanitizeText(payload.paymentMethodId);
  const paymentTypeId = sanitizeText(payload.paymentTypeId) === "debit_card" ? "debit_card" : "credit_card";
  const installments = Math.max(1, Number(payload.installments) || 1);
  const payerEmail = normalizeEmail(payload.payerEmail) || "cliente@alloo.com";
  const ride = findRideById(rideId);

  if (!ride) {
    sendJson(res, 404, { error: "Corrida não encontrada." });
    return;
  }

  if (!token || !paymentMethodId) {
    sendJson(res, 400, { error: "Dados do cartão incompletos." });
    return;
  }

  if (ride.paymentStatus === "pago") {
    sendJson(res, 400, { error: "Essa corrida já está paga." });
    return;
  }

  if (ride.status === "Cancelada") {
    sendJson(res, 400, { error: "Essa corrida foi cancelada." });
    return;
  }

  const amount = Number(ride.quotedPrice || 0).toFixed(2);

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", "/v1/orders", {
      type: "online",
      processing_mode: "automatic",
      total_amount: amount,
      external_reference: ride.id,
      notification_url: getPaymentWebhookUrl(req),
      payer: { email: payerEmail },
      transactions: {
        payments: [
          {
            amount,
            payment_method: {
              id: paymentMethodId,
              type: paymentTypeId,
              token,
              installments
            }
          }
        ]
      }
    });
  } catch (error) {
    logPaymentError("ride-card-network", ride.id, null, { message: error && error.message });
    sendJson(res, 503, { error: "Não foi possível falar com o Mercado Pago agora." });
    return;
  }

  if (!mpResponse.ok) {
    logPaymentError("ride-card", ride.id, mpResponse.status, mpResponse.data);
    sendJson(res, 400, {
      error: extractMercadoPagoErrorReason(mpResponse.data) || "O pagamento não foi aprovado."
    });
    return;
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentStatus = mapMercadoPagoStatusToPaymentStatus(mpResponse.data, transaction);

  updateRidePaymentRow(ride.id, {
    paymentProvider: "mercadopago",
    paymentStatus,
    paymentDetail: transaction.status_detail || mpResponse.data.status_detail || "",
    mpOrderId: mpResponse.data.id || ""
  });

  if (paymentStatus === "pago") {
    promoteRideAfterPayment(ride.id);
  }

  sendJson(res, paymentStatus === "recusado" ? 400 : 200, {
    paymentStatus,
    detail: transaction.status_detail || mpResponse.data.status_detail || ""
  });
}

// Assim que o pagamento de uma corrida "Aguardando pagamento" é confirmado
// (Pix escaneado, ou cartão aprovado na hora), ela passa a existir de
// verdade pros taxistas - antes disso nenhum taxista via nem sabia que
// essa corrida existia, exatamente pra ninguém se comprometer com uma
// corrida que talvez nunca fosse paga.
function promoteRideAfterPayment(rideId) {
  const ride = findRideById(rideId);
  if (!ride || ride.status !== "Aguardando pagamento") {
    return;
  }

  const now = new Date().toISOString();
  const statusHistory = ride.statusHistory.concat([{ status: "Novo", at: now }]);

  db.prepare("UPDATE ride_requests SET status = 'Novo', status_history_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(statusHistory),
    now,
    rideId
  );

  broadcastToTaxiDashboards({ type: "ride_created", rideId });
}

// Pergunta pro Mercado Pago o status real de uma cobrança de corrida e
// atualiza a corrida local de acordo - espelha syncOrderPaymentStatusFromMercadoPago,
// chamado pelo webhook (avisado sozinho) ou sob demanda.
async function syncRidePaymentStatusFromMercadoPago(ride) {
  if (!ride.mpOrderId) {
    return { synced: false, reason: "Corrida não tem cobrança do Mercado Pago associada." };
  }

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("GET", "/v1/orders/" + encodeURIComponent(ride.mpOrderId));
  } catch (error) {
    logPaymentError("ride-sync-status-network", ride.id, null, { message: error && error.message });
    return { synced: false, reason: "Não foi possível falar com o Mercado Pago agora." };
  }

  if (!mpResponse.ok) {
    logPaymentError("ride-sync-status", ride.id, mpResponse.status, mpResponse.data);
    return { synced: false, reason: extractMercadoPagoErrorReason(mpResponse.data) || "O Mercado Pago não respondeu." };
  }

  const transaction = (mpResponse.data.transactions && mpResponse.data.transactions.payments || [])[0] || {};
  const paymentStatus = mapMercadoPagoStatusToPaymentStatus(mpResponse.data, transaction);
  const wasAlreadyPago = ride.paymentStatus === "pago";

  updateRidePaymentRow(ride.id, {
    paymentStatus,
    paymentDetail: transaction.status_detail || mpResponse.data.status_detail || ""
  });

  if (paymentStatus === "pago" && !wasAlreadyPago) {
    promoteRideAfterPayment(ride.id);
  }

  const updatedRide = findRideById(ride.id);
  broadcastToRide(ride.id, { type: "ride_updated", rideId: ride.id });

  return { synced: true, paymentStatus, ride: updatedRide };
}

async function refundMercadoPagoRide(ride) {
  if (!isMercadoPagoEnabled()) {
    return { attempted: true, success: false, reason: "Pagamento online não está configurado neste servidor." };
  }

  if (!ride.mpOrderId) {
    return { attempted: false, success: false, reason: "Corrida não tem cobrança do Mercado Pago associada." };
  }

  let mpResponse;
  try {
    mpResponse = await callMercadoPago("POST", `/v1/orders/${encodeURIComponent(ride.mpOrderId)}/refund`, null);
  } catch (error) {
    logPaymentError("ride-refund-network", ride.id, null, { message: error && error.message });
    return { attempted: true, success: false, reason: "Não foi possível falar com o Mercado Pago agora." };
  }

  if (!mpResponse.ok) {
    logPaymentError("ride-refund", ride.id, mpResponse.status, mpResponse.data);
    return { attempted: true, success: false, reason: extractMercadoPagoErrorReason(mpResponse.data) };
  }

  return { attempted: true, success: true };
}

// Roda toda vez que uma corrida é cancelada. Se ela tinha pagamento online
// já confirmado (Pix ou cartão), tenta estornar sozinho - o cliente não
// precisa pedir nada. Se o estorno falhar, a corrida continua cancelada do
// mesmo jeito, só fica registrado que o dinheiro ainda precisa ser
// devolvido manualmente pelo painel do Mercado Pago.
async function maybeRefundCancelledRide(ride) {
  if (!ride || ride.status !== "Cancelada") {
    return { attempted: false };
  }

  if (ride.paymentStatus !== "pago" || ride.paymentProvider !== "mercadopago") {
    return { attempted: false };
  }

  const result = await refundMercadoPagoRide(ride);

  if (result.success) {
    updateRidePaymentRow(ride.id, {
      paymentStatus: "estornado",
      paymentDetail: "Estornado automaticamente ao cancelar a corrida."
    });
  } else if (result.attempted) {
    updateRidePaymentRow(ride.id, {
      paymentDetail:
        "Falha ao estornar automaticamente: " +
        (result.reason || "erro desconhecido") +
        " - tente devolver manualmente pelo Mercado Pago."
    });
  }

  return result;
}

function findRideById(rideId) {
  const row = db.prepare("SELECT * FROM ride_requests WHERE id = ?").get(rideId);
  return row ? rowToRide(row) : null;
}

function findRideByMpOrderId(mpOrderId) {
  const row = db.prepare("SELECT * FROM ride_requests WHERE mp_order_id = ?").get(mpOrderId);
  return row ? rowToRide(row) : null;
}

// Métodos de pagamento de corrida que são cobrados de verdade dentro do
// app (via Mercado Pago) - "Dinheiro" continua sendo só uma informação
// pro taxista, sem cobrança online (ele recebe direto, e deve comissão
// depois, igual corrida em dinheiro na Uber).
const RIDE_ONLINE_PAYMENT_METHODS = ["Pix", "Cartão"];

function isOnlineRidePaymentMethod(method) {
  return RIDE_ONLINE_PAYMENT_METHODS.indexOf(method) >= 0;
}

function updateRidePaymentRow(rideId, fields) {
  const sets = [];
  const values = [];

  ["paymentStatus", "paymentProvider", "paymentDetail", "mpOrderId", "pixQrCode", "pixQrCodeBase64", "pixTicketUrl"].forEach(
    function (key) {
      if (!(key in fields)) {
        return;
      }
      const column = {
        paymentStatus: "payment_status",
        paymentProvider: "payment_provider",
        paymentDetail: "payment_detail",
        mpOrderId: "mp_order_id",
        pixQrCode: "pix_qr_code",
        pixQrCodeBase64: "pix_qr_code_base64",
        pixTicketUrl: "pix_ticket_url"
      }[key];
      sets.push(column + " = ?");
      values.push(fields[key]);
    }
  );

  if (!sets.length) {
    return;
  }

  values.push(rideId);
  db.prepare(`UPDATE ride_requests SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

// Lista, pro painel do taxista: as corridas ainda abertas (sem motorista),
// ordenadas por distância até a localização atual dele - e, se ele já tem
// uma corrida em andamento, ela aparece separada.
async function handleListTaxiRides(req, res) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const driver = findTaxiDriverById(session.driverId);
  const openRows = db.prepare("SELECT * FROM ride_requests WHERE status = 'Novo' ORDER BY created_at ASC").all();

  const openRides = openRows.map(rowToRide).map(function (ride) {
    const distanceKm =
      driver && driver.lat != null && driver.lng != null
        ? Number(haversineDistanceKm(driver.lat, driver.lng, ride.pickupLat, ride.pickupLng).toFixed(1))
        : null;
    return Object.assign({}, ride, { distanceKm });
  });

  openRides.sort(function (a, b) {
    if (a.distanceKm == null) return 1;
    if (b.distanceKm == null) return -1;
    return a.distanceKm - b.distanceKm;
  });

  const myRideRow = db
    .prepare(
      "SELECT * FROM ride_requests WHERE driver_id = ? AND status NOT IN ('Concluída', 'Cancelada') ORDER BY created_at DESC LIMIT 1"
    )
    .get(session.driverId);

  sendJson(res, 200, {
    openRides,
    myRide: myRideRow ? rowToRide(myRideRow) : null
  });
}

// Aceitar é seguro contra corrida entre dois taxistas: só afeta a linha se
// ela ainda estiver "Novo" e sem motorista - o primeiro a aceitar leva.
async function handleAcceptRide(req, res, rideId) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const driver = findTaxiDriverById(session.driverId);
  const now = new Date().toISOString();
  const existing = findRideById(rideId);

  if (!existing) {
    sendJson(res, 404, { error: "Corrida não encontrada." });
    return;
  }

  if (existing.status !== "Novo") {
    sendJson(res, 409, { error: "Essa corrida já foi aceita por outro taxista ou não está mais disponível." });
    return;
  }

  const statusHistory = existing.statusHistory.concat([{ status: "Aceita", at: now }]);

  const result = db
    .prepare(
      "UPDATE ride_requests SET status = 'Aceita', driver_id = ?, driver_name = ?, status_history_json = ?, updated_at = ? WHERE id = ? AND status = 'Novo'"
    )
    .run(session.driverId, driver ? driver.name : "", JSON.stringify(statusHistory), now, rideId);

  if (result.changes === 0) {
    sendJson(res, 409, { error: "Essa corrida já foi aceita por outro taxista ou não está mais disponível." });
    return;
  }

  broadcastToRide(rideId, { type: "ride_updated", rideId });
  broadcastToTaxiDashboards({ type: "ride_accepted", rideId });

  sendJson(res, 200, { ride: findRideById(rideId) });
}

function requireOwnRide(req, res, rideId, driverId) {
  const ride = findRideById(rideId);

  if (!ride) {
    sendJson(res, 404, { error: "Corrida não encontrada." });
    return null;
  }

  if (ride.driverId !== driverId) {
    sendJson(res, 403, { error: "Essa corrida não é sua." });
    return null;
  }

  return ride;
}


async function handleUpdateRideStatus(req, res, rideId) {
  const session = requireTaxiDriver(req, res);
  if (!session) {
    return;
  }

  const ride = requireOwnRide(req, res, rideId, session.driverId);
  if (!ride) {
    return;
  }

  const payload = await readRequestBody(req);
  const status = sanitizeText(payload.status);

  if (RIDE_STATUSES.indexOf(status) < 0) {
    sendJson(res, 400, { error: "Status inválido." });
    return;
  }

  const now = new Date().toISOString();
  const statusHistory = ride.statusHistory.concat([{ status, at: now }]);

  db.prepare("UPDATE ride_requests SET status = ?, status_history_json = ?, updated_at = ? WHERE id = ?").run(
    status,
    JSON.stringify(statusHistory),
    now,
    rideId
  );

  broadcastToRide(rideId, { type: "ride_updated", rideId });
  broadcastToTaxiDashboards({ type: "ride_status_changed", rideId });

  sendJson(res, 200, { ride: findRideById(rideId) });
}

// -------------------------------------------------------------------------
// WebSocket (implementacao minima, sem dependencias externas) para avisar
// o painel do lojista na hora quando um pedido muda.
// -------------------------------------------------------------------------

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function subscribeSocket(storeId, socket) {
  if (!storeSockets.has(storeId)) {
    storeSockets.set(storeId, new Set());
  }
  storeSockets.get(storeId).add(socket);
}

function unsubscribeSocket(storeId, socket) {
  const set = storeSockets.get(storeId);
  if (!set) {
    return;
  }
  set.delete(socket);
  if (!set.size) {
    storeSockets.delete(storeId);
  }
}

function encodeWebSocketFrame(payload) {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const length = payloadBuffer.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payloadBuffer]);
}

function broadcastToStore(storeId, message) {
  const set = storeSockets.get(storeId);
  if (!set || !set.size) {
    return;
  }

  const frame = encodeWebSocketFrame(JSON.stringify(message));
  set.forEach(function (socket) {
    try {
      socket.write(frame);
    } catch (error) {
      unsubscribeSocket(storeId, socket);
    }
  });
}

// Avisa todo mundo com o painel do taxista aberto (independente de qual
// corrida cada um está vendo) - usado quando uma corrida nova aparece, é
// aceita ou tem status/valor mudado, pra atualizar a lista de corridas por
// perto e a corrida ativa de cada motorista.
function broadcastToTaxiDashboards(message) {
  if (!taxiDashboardSockets.size) {
    return;
  }

  const frame = encodeWebSocketFrame(JSON.stringify(message));
  taxiDashboardSockets.forEach(function (socket) {
    try {
      socket.write(frame);
    } catch (error) {
      taxiDashboardSockets.delete(socket);
    }
  });
}

function subscribeRideSocket(rideId, socket) {
  if (!rideSockets.has(rideId)) {
    rideSockets.set(rideId, new Set());
  }
  rideSockets.get(rideId).add(socket);
}

function unsubscribeRideSocket(rideId, socket) {
  const set = rideSockets.get(rideId);
  if (!set) {
    return;
  }
  set.delete(socket);
  if (!set.size) {
    rideSockets.delete(rideId);
  }
}

// Avisa só quem está acompanhando aquela corrida específica (cliente na tela
// de rastreio) - usado pra status/valor e pra posição do taxista em tempo
// real, sem incomodar quem está vendo outra corrida.
function broadcastToRide(rideId, message) {
  const set = rideSockets.get(rideId);
  if (!set || !set.size) {
    return;
  }

  const frame = encodeWebSocketFrame(JSON.stringify(message));
  set.forEach(function (socket) {
    try {
      socket.write(frame);
    } catch (error) {
      unsubscribeRideSocket(rideId, socket);
    }
  });
}

function finishWebSocketHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return false;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
  return true;
}

function handleOrdersWebSocketUpgrade(req, socket, urlObject) {
  const storeId = sanitizeText(urlObject.searchParams.get("storeId"));
  const token = sanitizeText(urlObject.searchParams.get("token"));
  const session = getOwnerSessionByToken(token);

  if (!session || session.storeId !== storeId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!finishWebSocketHandshake(req, socket)) {
    return;
  }

  subscribeSocket(storeId, socket);

  // Não precisamos interpretar os frames que o navegador manda (o uso é só
  // servidor -> cliente); apenas escutamos o encerramento da conexão para
  // remover o socket da lista de assinantes.
  socket.on("data", function () {});
  socket.on("close", function () {
    unsubscribeSocket(storeId, socket);
  });
  socket.on("error", function () {
    unsubscribeSocket(storeId, socket);
  });
}

// Um único endpoint de WebSocket pra táxi, com dois papéis possíveis:
// - role=driver: painel do taxista, precisa do token de login dele (entra no
//   canal geral de painéis, taxiDashboardSockets).
// - role=ride: tela de acompanhar corrida (cliente), sem login - só precisa
//   saber o id da corrida (entra no canal daquela corrida, rideSockets).
function handleTaxiWebSocketUpgrade(req, socket, urlObject) {
  const role = sanitizeText(urlObject.searchParams.get("role"));

  if (role === "driver") {
    const token = sanitizeText(urlObject.searchParams.get("token"));
    const session = getTaxiSessionByToken(token);

    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!finishWebSocketHandshake(req, socket)) {
      return;
    }

    taxiDashboardSockets.add(socket);
    socket.on("data", function () {});
    socket.on("close", function () {
      taxiDashboardSockets.delete(socket);
    });
    socket.on("error", function () {
      taxiDashboardSockets.delete(socket);
    });
    return;
  }

  if (role === "ride") {
    const rideId = sanitizeText(urlObject.searchParams.get("rideId"));
    if (!rideId || !findRideById(rideId)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!finishWebSocketHandshake(req, socket)) {
      return;
    }

    subscribeRideSocket(rideId, socket);
    socket.on("data", function () {});
    socket.on("close", function () {
      unsubscribeRideSocket(rideId, socket);
    });
    socket.on("error", function () {
      unsubscribeRideSocket(rideId, socket);
    });
    return;
  }

  socket.destroy();
}

function handleWebSocketUpgrade(req, socket, head) {
  const urlObject = new URL(req.url || "/", `http://${req.headers.host || `${PUBLIC_HOST}:${PORT}`}`);

  if (urlObject.pathname === "/ws/orders") {
    handleOrdersWebSocketUpgrade(req, socket, urlObject);
    return;
  }

  if (urlObject.pathname === "/ws/taxi") {
    handleTaxiWebSocketUpgrade(req, socket, urlObject);
    return;
  }

  socket.destroy();
}

// -------------------------------------------------------------------------
// Notificações push (Web Push) - avisam o cliente sobre o status do pedido
// mesmo com o app fechado, via Service Worker.
// -------------------------------------------------------------------------

async function handleGetPushVapidPublicKey(req, res) {
  const config = getPushConfig();

  if (!config) {
    sendJson(res, 404, { error: "Notificações push não estão configuradas." });
    return;
  }

  sendJson(res, 200, { publicKey: config.publicKey });
}

async function handlePushSubscribe(req, res) {
  const payload = await readRequestBody(req);
  const customerId = sanitizeText(payload.customerId);
  const subscription = payload.subscription || {};
  const endpoint = sanitizeText(subscription.endpoint);
  const keys = subscription.keys || {};
  const p256dh = sanitizeText(keys.p256dh);
  const auth = sanitizeText(keys.auth);

  if (!customerId || !endpoint || !p256dh || !auth) {
    sendJson(res, 400, { error: "Dados de inscrição push incompletos." });
    return;
  }

  insertPushSubscription({
    id: "push-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
    customerId,
    endpoint,
    p256dh,
    auth,
    createdAt: new Date().toISOString()
  });

  sendJson(res, 201, { message: "Inscrição de notificações registrada." });
}

async function handlePushUnsubscribe(req, res) {
  const payload = await readRequestBody(req);
  const endpoint = sanitizeText(payload.endpoint);

  if (!endpoint) {
    sendJson(res, 400, { error: "Informe o endpoint da inscrição." });
    return;
  }

  deletePushSubscriptionByEndpoint(endpoint);
  sendJson(res, 200, { message: "Inscrição de notificações removida." });
}

// Envia uma notificação push para todas as inscrições de um cliente. Remove
// automaticamente inscrições que o navegador já invalidou (erro 404/410).
async function sendPushToCustomer(customerId, notification) {
  if (!isPushEnabled()) {
    return;
  }

  const subscriptions = listPushSubscriptionsByCustomer(customerId);
  if (!subscriptions.length) {
    return;
  }

  const payload = JSON.stringify(notification);

  await Promise.all(
    subscriptions.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };

      try {
        await webpush.sendNotification(pushSubscription, payload);
      } catch (error) {
        if (error && (error.statusCode === 404 || error.statusCode === 410)) {
          deletePushSubscriptionByEndpoint(sub.endpoint);
        } else {
          console.error("Falha ao enviar notificação push:", error && error.message);
        }
      }
    })
  );
}

// -------------------------------------------------------------------------
// Roteamento
// -------------------------------------------------------------------------

const RATE_LIMITED_ROUTES = [
  ["POST", "/api/auth/register"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/owner-login"],
  ["POST", "/api/auth/forgot-password"],
  ["POST", "/api/auth/owner-forgot-password"],
  ["POST", "/api/auth/taxi-forgot-password"],
  ["POST", "/api/auth/provider-forgot-password"],
  ["POST", "/api/auth/google"],
  ["POST", "/api/admin/login"],
  ["POST", "/api/payments/pix"],
  ["POST", "/api/payments/card"],
  ["POST", "/api/partner-leads"],
  ["POST", "/api/signup/store"],
  ["POST", "/api/signup/taxi-driver"],
  ["POST", "/api/signup/provider"],
  ["POST", "/api/provider/login"],
  ["POST", "/api/budget-requests"],
  ["POST", "/api/taxi/login"],
  ["POST", "/api/rides"],
  ["POST", "/api/rides/pix"],
  ["POST", "/api/rides/card"],
  ["POST", "/api/provider-bookings/pix"],
  ["POST", "/api/provider-bookings/card"],
  ["POST", "/api/provider-bookings/cash"],
  ["POST", "/api/admin/push/broadcast"]
];
// Observação: /api/geocode/search e /api/geocode/reverse ficam FORA dessa
// lista de propósito. O limite acima é por IP e compartilhado entre todas
// as rotas listadas (incluindo /api/rides) - se a busca de endereço (que
// dispara várias vezes enquanto o cliente digita) entrasse nessa mesma
// lista, ela ia consumir a cota e podia deixar o cliente sem conseguir
// nem confirmar o pedido da corrida depois. O controle de volume da busca
// fica por conta do debounce no front-end (só busca a cada ~450ms e com
// 3+ letras).

function isRateLimitedRoute(method, pathname) {
  return RATE_LIMITED_ROUTES.some(function (route) {
    return route[0] === method && route[1] === pathname;
  });
}

async function routeApi(req, res, urlObject) {
  const method = req.method;
  const pathname = urlObject.pathname;

  try {
    if (isRateLimitedRoute(method, pathname) && isRateLimited(req)) {
      sendJson(res, 429, { error: "Muitas tentativas. Aguarde alguns minutos e tente novamente." });
      return true;
    }

    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        status: "ok",
        app: "Alloo",
        publicUrl: getBaseUrl(req),
        timestamp: new Date().toISOString()
      });
      return true;
    }

    if (method === "GET" && pathname === "/api/config") {
      sendJson(res, 200, {
        googleClientId: getGoogleClientId() || null,
        mercadoPagoPublicKey: isMercadoPagoEnabled() ? getMercadoPagoPublicKey() : null
      });
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/register") {
      await handleRegister(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/login") {
      await handleLogin(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/google") {
      await handleGoogleAuth(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/owner-login") {
      await handleOwnerLogin(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/owner-logout") {
      handleOwnerLogout(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/owner-update-email") {
      await handleOwnerUpdateEmail(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/forgot-password") {
      await handleForgotPassword(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/owner-forgot-password") {
      await handleOwnerForgotPassword(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/taxi-forgot-password") {
      await handleTaxiForgotPassword(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/provider-forgot-password") {
      await handleProviderForgotPassword(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/auth/reset-password") {
      await handleResetPassword(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/auth/validate-reset-token") {
      await handleValidateToken(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/catalog") {
      await handleGetCatalog(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/home-chips") {
      await handleGetHomeChips(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/home-chips") {
      await handleAdminCreateHomeChip(req, res);
      return true;
    }

    const homeChipMatch = /^\/api\/admin\/home-chips\/([^/]+)$/.exec(pathname);
    if (method === "PATCH" && homeChipMatch) {
      await handleAdminUpdateHomeChip(req, res, decodeURIComponent(homeChipMatch[1]));
      return true;
    }
    if (method === "DELETE" && homeChipMatch) {
      await handleAdminDeleteHomeChip(req, res, decodeURIComponent(homeChipMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/login") {
      await handleAdminLogin(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/stores") {
      await handleAdminCreateStore(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/taxi-drivers") {
      await handleAdminCreateTaxiDriver(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/taxi-drivers") {
      await handleAdminListTaxiDrivers(req, res);
      return true;
    }

    const taxiVerifyMatch = /^\/api\/admin\/taxi-drivers\/([^/]+)\/verify$/.exec(pathname);
    if (method === "POST" && taxiVerifyMatch) {
      await handleAdminVerifyTaxiDriver(req, res, decodeURIComponent(taxiVerifyMatch[1]));
      return true;
    }

    const taxiUpdateMatch = /^\/api\/admin\/taxi-drivers\/([^/]+)$/.exec(pathname);
    if (method === "PATCH" && taxiUpdateMatch) {
      await handleAdminUpdateTaxiDriver(req, res, decodeURIComponent(taxiUpdateMatch[1]));
      return true;
    }

    const taxiDocumentMatch = /^\/api\/admin\/taxi-drivers\/([^/]+)\/documents\/([^/]+)$/.exec(pathname);
    if (method === "GET" && taxiDocumentMatch) {
      await handleGetPartnerDocument(
        req,
        res,
        "taxi-driver",
        decodeURIComponent(taxiDocumentMatch[1]),
        decodeURIComponent(taxiDocumentMatch[2])
      );
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/providers") {
      await handleAdminCreateProvider(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/providers") {
      await handleAdminListProviders(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/provider-reviews") {
      await handleAdminListProviderReviews(req, res);
      return true;
    }

    const providerVerifyMatch = /^\/api\/admin\/providers\/([^/]+)\/verify-antecedentes$/.exec(pathname);
    if (method === "POST" && providerVerifyMatch) {
      await handleAdminVerifyProviderCriminalRecord(req, res, decodeURIComponent(providerVerifyMatch[1]));
      return true;
    }

    const providerDocumentMatch = /^\/api\/admin\/providers\/([^/]+)\/documents\/([^/]+)$/.exec(pathname);
    if (method === "GET" && providerDocumentMatch) {
      await handleGetPartnerDocument(
        req,
        res,
        "provider",
        decodeURIComponent(providerDocumentMatch[1]),
        decodeURIComponent(providerDocumentMatch[2])
      );
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/impersonate-store") {
      await handleAdminImpersonateStore(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/dashboard") {
      await handleAdminDashboard(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/orders") {
      await handleAdminListOrders(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/payment-errors") {
      await handleAdminListPaymentErrors(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/push/broadcast") {
      await handleAdminBroadcastPush(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/push/broadcasts") {
      await handleAdminListPushBroadcasts(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/customers") {
      await handleAdminListCustomers(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/finance") {
      await handleAdminFinance(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/settings") {
      await handleGetCommissionTiers(req, res, "store");
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/settings") {
      await handleUpdateCommissionTiers(req, res, "store");
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/settlements/preview") {
      await handleSettlementPreview(req, res, urlObject);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/settlements/close") {
      await handleSettlementClose(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/settlements") {
      await handleListSettlements(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/store-balances") {
      await handleListStoreBalances(req, res);
      return true;
    }

    const balanceAdjustmentMatch = /^\/api\/admin\/stores\/([^/]+)\/balance-adjustments$/.exec(pathname);
    if (method === "POST" && balanceAdjustmentMatch) {
      await handleCreateBalanceAdjustment(req, res, decodeURIComponent(balanceAdjustmentMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/partner-leads") {
      await handleCreatePartnerLead(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/signup/store") {
      await handleSignupStore(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/signup/taxi-driver") {
      await handleSignupTaxiDriver(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/signup/provider") {
      await handleSignupProvider(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/partner-leads") {
      await handleAdminListPartnerLeads(req, res, urlObject);
      return true;
    }

    const partnerLeadStatusMatch = /^\/api\/admin\/partner-leads\/([^/]+)\/status$/.exec(pathname);
    if (method === "POST" && partnerLeadStatusMatch) {
      await handleAdminUpdatePartnerLeadStatus(req, res, decodeURIComponent(partnerLeadStatusMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/provider/login") {
      await handleProviderLogin(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/provider/dashboard") {
      await handleProviderDashboard(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/provider/services") {
      await handleProviderUpsertService(req, res);
      return true;
    }

    const providerServiceDeleteMatch = /^\/api\/provider\/services\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && providerServiceDeleteMatch) {
      await handleProviderDeleteService(req, res, decodeURIComponent(providerServiceDeleteMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/provider/availability") {
      await handleProviderSetAvailability(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/provider/visit-fee") {
      await handleProviderSetVisitFee(req, res);
      return true;
    }

    const providerRequestRespondMatch = /^\/api\/provider\/budget-requests\/([^/]+)\/respond$/.exec(pathname);
    if (method === "POST" && providerRequestRespondMatch) {
      await handleProviderRespondToBudgetRequest(req, res, decodeURIComponent(providerRequestRespondMatch[1]));
      return true;
    }

    if (method === "GET" && pathname === "/api/provider/bookings") {
      await handleProviderListBookings(req, res);
      return true;
    }

    const providerBookingStatusMatch = /^\/api\/provider\/bookings\/([^/]+)\/status$/.exec(pathname);
    if (method === "POST" && providerBookingStatusMatch) {
      await handleProviderUpdateBookingStatus(req, res, decodeURIComponent(providerBookingStatusMatch[1]));
      return true;
    }

    if (method === "GET" && pathname === "/api/provider/earnings") {
      await handleProviderEarnings(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/provider/reviews") {
      await handleProviderReviews(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/providers") {
      await handleListProviders(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/budget-requests") {
      await handleCreateBudgetRequest(req, res);
      return true;
    }

    const budgetRequestDetailMatch = /^\/api\/budget-requests\/([^/]+)$/.exec(pathname);
    if (method === "GET" && budgetRequestDetailMatch) {
      await handleGetBudgetRequestTimeline(req, res, decodeURIComponent(budgetRequestDetailMatch[1]));
      return true;
    }

    const budgetRequestMessagesMatch = /^\/api\/budget-requests\/([^/]+)\/messages$/.exec(pathname);
    if (method === "POST" && budgetRequestMessagesMatch) {
      await handleCreateBudgetRequestMessage(req, res, decodeURIComponent(budgetRequestMessagesMatch[1]));
      return true;
    }

    const providerRequestMessagesMatch = /^\/api\/provider\/budget-requests\/([^/]+)\/messages$/.exec(pathname);
    if (method === "POST" && providerRequestMessagesMatch) {
      await handleProviderSendBudgetRequestMessage(req, res, decodeURIComponent(providerRequestMessagesMatch[1]));
      return true;
    }

    const providerRequestDetailMatch = /^\/api\/provider\/budget-requests\/([^/]+)$/.exec(pathname);
    if (method === "GET" && providerRequestDetailMatch) {
      await handleProviderGetBudgetRequestTimeline(req, res, decodeURIComponent(providerRequestDetailMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/taxi/login") {
      await handleTaxiLogin(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/taxi/dashboard") {
      await handleTaxiDashboard(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/taxi/online") {
      await handleSetTaxiOnline(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/taxi/location") {
      await handleUpdateTaxiLocation(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/taxi/rides") {
      await handleListTaxiRides(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/taxi/history") {
      await handleTaxiHistory(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/taxi-pricing") {
      await handleGetTaxiPricing(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/taxi-pricing") {
      await handleUpdateTaxiPricing(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/taxi-commission") {
      await handleGetCommissionTiers(req, res, "taxi");
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/taxi-commission") {
      await handleUpdateCommissionTiers(req, res, "taxi");
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/provider-commission") {
      await handleGetCommissionTiers(req, res, "provider");
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/provider-commission") {
      await handleUpdateCommissionTiers(req, res, "provider");
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/provider-visit-commission") {
      await handleGetProviderVisitCommission(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/provider-visit-commission") {
      await handleUpdateProviderVisitCommission(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/taxi-settlements/preview") {
      await handleTaxiSettlementPreview(req, res, urlObject);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/taxi-settlements/close") {
      await handleTaxiSettlementClose(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/taxi-settlements") {
      await handleListTaxiSettlements(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/taxi-balances") {
      await handleListTaxiDriverBalances(req, res);
      return true;
    }

    const taxiBalanceAdjustmentMatch = /^\/api\/admin\/taxi-drivers\/([^/]+)\/balance-adjustments$/.exec(pathname);
    if (method === "POST" && taxiBalanceAdjustmentMatch) {
      await handleCreateTaxiBalanceAdjustment(req, res, decodeURIComponent(taxiBalanceAdjustmentMatch[1]));
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/provider-settlements/preview") {
      await handleProviderSettlementPreview(req, res, urlObject);
      return true;
    }

    if (method === "POST" && pathname === "/api/admin/provider-settlements/close") {
      await handleProviderSettlementClose(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/provider-settlements") {
      await handleListProviderSettlements(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/admin/provider-balances") {
      await handleListProviderBalances(req, res);
      return true;
    }

    const providerBalanceAdjustmentMatch = /^\/api\/admin\/providers\/([^/]+)\/balance-adjustments$/.exec(pathname);
    if (method === "POST" && providerBalanceAdjustmentMatch) {
      await handleCreateProviderBalanceAdjustment(req, res, decodeURIComponent(providerBalanceAdjustmentMatch[1]));
      return true;
    }

    const taxiAcceptMatch = /^\/api\/taxi\/rides\/([^/]+)\/accept$/.exec(pathname);
    if (method === "POST" && taxiAcceptMatch) {
      await handleAcceptRide(req, res, decodeURIComponent(taxiAcceptMatch[1]));
      return true;
    }

    const taxiStatusMatch = /^\/api\/taxi\/rides\/([^/]+)\/status$/.exec(pathname);
    if (method === "POST" && taxiStatusMatch) {
      await handleUpdateRideStatus(req, res, decodeURIComponent(taxiStatusMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/rides/estimate") {
      await handleEstimateRideFare(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/geocode/search") {
      await handleGeocodeSearch(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/geocode/reverse") {
      await handleGeocodeReverse(req, res, urlObject);
      return true;
    }

    if (method === "POST" && pathname === "/api/rides") {
      await handleCreateRide(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/rides/pix") {
      await handleCreateRidePixPayment(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/rides/card") {
      await handleCreateRideCardPayment(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/provider-bookings/pix") {
      await handleCreateBookingPixPayment(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/provider-bookings/card") {
      await handleCreateBookingCardPayment(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/provider-bookings/cash") {
      await handleChooseBookingCashPayment(req, res);
      return true;
    }

    const providerBookingDetailMatch = /^\/api\/provider-bookings\/([^/]+)$/.exec(pathname);
    if (method === "GET" && providerBookingDetailMatch) {
      await handleGetProviderBooking(req, res, decodeURIComponent(providerBookingDetailMatch[1]));
      return true;
    }

    const providerBookingReviewMatch = /^\/api\/provider-bookings\/([^/]+)\/review$/.exec(pathname);
    if (method === "POST" && providerBookingReviewMatch) {
      await handleCreateProviderReview(req, res, decodeURIComponent(providerBookingReviewMatch[1]));
      return true;
    }

    const rideCancelMatch = /^\/api\/rides\/([^/]+)\/cancel$/.exec(pathname);
    if (method === "POST" && rideCancelMatch) {
      await handleCancelRide(req, res, decodeURIComponent(rideCancelMatch[1]));
      return true;
    }

    const rideDetailMatch = /^\/api\/rides\/([^/]+)$/.exec(pathname);
    if (method === "GET" && rideDetailMatch) {
      await handleGetRide(req, res, decodeURIComponent(rideDetailMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/stores/upsert") {
      await handleUpsertStore(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/stores/upsert-item") {
      await handleUpsertStoreItem(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/uploads/item-photo") {
      await handleUploadItemPhoto(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/orders") {
      await handleCreateOrder(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/orders") {
      await handleListOrders(req, res, urlObject);
      return true;
    }

    if (method === "POST" && pathname === "/api/orders/clear") {
      await handleClearOrders(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/orders/metrics") {
      await handleOrderMetrics(req, res, urlObject);
      return true;
    }

    if (method === "POST" && pathname === "/api/payments/pix") {
      await handleCreatePixPayment(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/payments/card") {
      await handleCreateCardPayment(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/payments/webhook") {
      await handleMercadoPagoWebhook(req, res);
      return true;
    }

    const orderStatusMatch = /^\/api\/orders\/([^/]+)\/status$/.exec(pathname);
    if (method === "POST" && orderStatusMatch) {
      await handleUpdateOrderStatus(req, res, decodeURIComponent(orderStatusMatch[1]));
      return true;
    }

    const orderPrepMatch = /^\/api\/orders\/([^/]+)\/prep$/.exec(pathname);
    if (method === "POST" && orderPrepMatch) {
      await handleUpdateOrderPrep(req, res, decodeURIComponent(orderPrepMatch[1]));
      return true;
    }

    const orderRefundMatch = /^\/api\/orders\/([^/]+)\/refund$/.exec(pathname);
    if (method === "POST" && orderRefundMatch) {
      await handleRefundOrder(req, res, decodeURIComponent(orderRefundMatch[1]));
      return true;
    }

    const orderCancelMatch = /^\/api\/orders\/([^/]+)\/cancel$/.exec(pathname);
    if (method === "POST" && orderCancelMatch) {
      await handleCancelOrderByCustomer(req, res, decodeURIComponent(orderCancelMatch[1]));
      return true;
    }

    const adminOrderRefundMatch = /^\/api\/admin\/orders\/([^/]+)\/refund$/.exec(pathname);
    if (method === "POST" && adminOrderRefundMatch) {
      await handleAdminRefundOrder(req, res, decodeURIComponent(adminOrderRefundMatch[1]));
      return true;
    }

    const orderSyncPaymentMatch = /^\/api\/orders\/([^/]+)\/sync-payment$/.exec(pathname);
    if (method === "POST" && orderSyncPaymentMatch) {
      await handleSyncOrderPayment(req, res, decodeURIComponent(orderSyncPaymentMatch[1]));
      return true;
    }

    const orderDetailMatch = /^\/api\/orders\/([^/]+)$/.exec(pathname);
    if (method === "GET" && orderDetailMatch) {
      await handleGetOrder(req, res, decodeURIComponent(orderDetailMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/reviews") {
      await handleCreateReview(req, res);
      return true;
    }

    const storeReviewsMatch = /^\/api\/stores\/([^/]+)\/reviews$/.exec(pathname);
    if (method === "GET" && storeReviewsMatch) {
      await handleListReviews(req, res, decodeURIComponent(storeReviewsMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/item-reviews") {
      await handleCreateItemReview(req, res);
      return true;
    }

    const itemReviewsMatch = /^\/api\/items\/([^/]+)\/reviews$/.exec(pathname);
    if (method === "GET" && itemReviewsMatch) {
      await handleListItemReviews(req, res, decodeURIComponent(itemReviewsMatch[1]));
      return true;
    }

    // Moderação de avaliações (lojista dono da loja, ou admin entrando como
    // ela) - ver todas (inclusive escondidas) e esconder/reexibir uma.
    const storeReviewsManageMatch = /^\/api\/stores\/([^/]+)\/reviews\/manage$/.exec(pathname);
    if (method === "GET" && storeReviewsManageMatch) {
      await handleListReviewsForOwner(req, res, decodeURIComponent(storeReviewsManageMatch[1]));
      return true;
    }

    const reviewVisibilityMatch = /^\/api\/reviews\/([^/]+)\/visibility$/.exec(pathname);
    if (method === "POST" && reviewVisibilityMatch) {
      await handleSetReviewVisibility(req, res, decodeURIComponent(reviewVisibilityMatch[1]));
      return true;
    }

    const itemReviewVisibilityMatch = /^\/api\/item-reviews\/([^/]+)\/visibility$/.exec(pathname);
    if (method === "POST" && itemReviewVisibilityMatch) {
      await handleSetItemReviewVisibility(req, res, decodeURIComponent(itemReviewVisibilityMatch[1]));
      return true;
    }

    if (method === "POST" && pathname === "/api/coupons/validate") {
      await handleValidateCoupon(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/coupons") {
      await handleUpsertCoupon(req, res);
      return true;
    }

    if (method === "GET" && pathname === "/api/coupons") {
      await handleListCoupons(req, res, urlObject);
      return true;
    }

    if (method === "GET" && pathname === "/api/coupons/active") {
      await handleListActiveCoupons(req, res);
      return true;
    }

    const couponToggleMatch = /^\/api\/coupons\/([^/]+)\/toggle$/.exec(pathname);
    if (method === "POST" && couponToggleMatch) {
      await handleToggleCoupon(req, res, decodeURIComponent(couponToggleMatch[1]));
      return true;
    }

    if (method === "GET" && pathname === "/api/push/vapid-public-key") {
      await handleGetPushVapidPublicKey(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/push/subscribe") {
      await handlePushSubscribe(req, res);
      return true;
    }

    if (method === "POST" && pathname === "/api/push/unsubscribe") {
      await handlePushUnsubscribe(req, res);
      return true;
    }
  } catch (error) {
    console.error(error);
    sendJson(res, 500, {
      error: "Não foi possível concluir essa ação agora."
    });
    return true;
  }

  return false;
}

function serveStatic(req, res) {
  const cleanPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let filePath;

  // Fotos enviadas pelo lojista podem morar fora da pasta do projeto (ex.:
  // um disco persistente em hospedagens como Railway, via UPLOADS_DIR), mas
  // continuam sendo acessadas pela mesma URL de sempre (/assets/items/...).
  if (cleanPath.startsWith("/assets/items/")) {
    const fileName = path.basename(cleanPath);
    filePath = path.join(UPLOADS_DIR, fileName);

    if (!fileName || filePath !== path.join(UPLOADS_DIR, fileName)) {
      send(res, 403, "Acesso negado.");
      return;
    }
  } else {
    filePath = getFilePath(req.url || "/");

    if (!filePath.startsWith(ROOT) || !isPubliclyServable(filePath)) {
      send(res, 403, "Acesso negado.");
      return;
    }
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      send(res, 404, "Arquivo não encontrado.");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        send(res, 500, "Erro ao carregar o arquivo.");
        return;
      }

      send(res, 200, data, contentType);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const urlObject = new URL(req.url || "/", `http://${req.headers.host || `${PUBLIC_HOST}:${PORT}`}`);

  if (urlObject.pathname.startsWith("/api/")) {
    const handled = await routeApi(req, res, urlObject);
    if (!handled) {
      sendJson(res, 404, { error: "Rota não encontrada." });
    }
    return;
  }

  serveStatic(req, res);
});

server.on("upgrade", handleWebSocketUpgrade);

initDatabase();

server.listen(PORT, HOST, () => {
  console.log("Servidor central do Alloo iniciado com sucesso.");
  console.log(`Rede local: http://${PUBLIC_HOST}:${PORT}`);
  console.log(`Acesso local: http://localhost:${PORT}`);
});

// -------------------------------------------------------------------------
// Backup automático do banco de dados - antes disso, `npm run backup`
// (scripts/backup-db.js) precisava ser disparado na mão. Agora, enquanto o
// servidor estiver no ar, ele mesmo dispara um backup a cada 24h (a
// primeira vez, 2 minutos depois de subir - tempo suficiente pra não
// atrapalhar a inicialização nem rodar durante a suíte de testes
// automatizados, que sobe e derruba o servidor em poucos segundos).
// Uma falha aqui nunca derruba o servidor - só fica registrada no log,
// e a próxima tentativa é no dia seguinte.
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_BACKUP_DELAY_MS = 2 * 60 * 1000;

function runScheduledBackup() {
  try {
    const { runBackup } = require("./scripts/backup-db.js");
    const backupPath = runBackup();
    console.log(`Backup automático criado: ${backupPath}`);
  } catch (error) {
    console.error("Falha no backup automático (tentaremos de novo no próximo ciclo):", error.message);
  }
}

setTimeout(function () {
  runScheduledBackup();
  setInterval(runScheduledBackup, BACKUP_INTERVAL_MS);
}, FIRST_BACKUP_DELAY_MS);
