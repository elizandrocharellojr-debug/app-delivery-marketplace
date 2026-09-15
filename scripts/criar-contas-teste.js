// Cria/reseta contas de teste (senha fácil, só pra testar o app agora que
// está rodando local + túnel Cloudflare). Usa exatamente o mesmo esquema de
// senha do server.js (scrypt), então funciona com o login normal do app.
//
// Uso: node scripts/criar-contas-teste.js
// (o comando "npm run criar-contas-teste" já chama este script)

const crypto = require("crypto");
const path = require("path");
let DatabaseSync;

try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  console.error("Precisa do Node.js 22.5+ (module node:sqlite).");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "app.db");

const SENHA_FACIL = "123456";
const NOME = "Elizandro";
const USUARIO = "elizandro";

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

const db = new DatabaseSync(DB_FILE);
const passwordHash = hashPassword(SENHA_FACIL);
const now = new Date().toISOString();

// 1) Administrativo geral - já existe (conta "Elizandro"), só troca a senha.
const adminRow = db.prepare("SELECT id FROM admins WHERE username = ?").get(NOME);
if (adminRow) {
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(passwordHash, adminRow.id);
  console.log(`Administrativo geral: senha da conta "${NOME}" atualizada para "${SENHA_FACIL}".`);
} else {
  db.prepare(
    "INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).run(newId("admin"), NOME, passwordHash, now);
  console.log(`Administrativo geral: conta "${NOME}" criada com a senha "${SENHA_FACIL}".`);
}

// 2) Prestador de serviço - já existe (prestador-teste), só garante a senha.
const providerRow = db.prepare("SELECT id FROM service_providers WHERE username = ?").get("prestador-teste");
if (providerRow) {
  db.prepare("UPDATE service_providers SET password_hash = ? WHERE id = ?").run(passwordHash, providerRow.id);
  console.log(`Prestador: senha da conta "prestador-teste" atualizada para "${SENHA_FACIL}".`);
} else {
  console.log('Prestador: conta "prestador-teste" não encontrada - pulei essa (crie pelo super-admin se precisar).');
}

// 3) Painel da loja - cria loja + login de dono de teste, se ainda não existir.
const ownerRow = db.prepare("SELECT id, store_id FROM owners WHERE username = ?").get(USUARIO);
if (ownerRow) {
  db.prepare("UPDATE owners SET password_hash = ? WHERE id = ?").run(passwordHash, ownerRow.id);
  console.log(`Painel da loja: senha da conta "${USUARIO}" atualizada para "${SENHA_FACIL}".`);
} else {
  const storeId = newId("store");
  db.prepare(
    `INSERT INTO stores (id, category_id, name, icon, is_active, delivery_time, delivery_fee, min_order)
     VALUES (?, NULL, ?, '🏪', 1, '30-45 min', 'R$ 5,00', 0)`
  ).run(storeId, "Loja Teste (Elizandro)");
  db.prepare(
    `INSERT INTO owners (id, store_id, username, owner_name, store_name, password_hash)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId("owner"), storeId, USUARIO, NOME, "Loja Teste (Elizandro)", passwordHash);
  console.log(`Painel da loja: loja e conta "${USUARIO}" criadas com a senha "${SENHA_FACIL}".`);
}

// 4) Tela do motorista - cria taxista de teste, se ainda não existir.
const driverRow = db.prepare("SELECT id FROM taxi_drivers WHERE username = ?").get(USUARIO);
if (driverRow) {
  db.prepare("UPDATE taxi_drivers SET password_hash = ? WHERE id = ?").run(passwordHash, driverRow.id);
  console.log(`Motorista: senha da conta "${USUARIO}" atualizada para "${SENHA_FACIL}".`);
} else {
  db.prepare(
    `INSERT INTO taxi_drivers (id, username, password_hash, name, phone, vehicle, is_online, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(newId("driver"), USUARIO, passwordHash, NOME, "", "Carro de teste - ABC-1234", now);
  console.log(`Motorista: conta "${USUARIO}" criada com a senha "${SENHA_FACIL}".`);
}

db.close();
console.log("\nPronto! Todas as contas de teste usam a senha: " + SENHA_FACIL);
