// Cria ou troca a senha da conta de administrador da plataforma, direto no
// banco de dados - sem precisar editar o código-fonte nem mexer no banco na
// mão.
//
// Uso local:
//   defina ADMIN_PASSWORD no .env e rode "npm run set-admin-password"
//
// Uso em produção (Railway), depois de já ter feito o primeiro deploy:
//   railway variable set "ADMIN_PASSWORD=sua_senha_nova"
//   railway run node scripts/set-admin-password.js
// (o "railway run" executa o comando já com as variáveis de ambiente e o
// disco persistente da produção, então atualiza o banco de verdade.)

const path = require("path");
const crypto = require("crypto");
let DatabaseSync;

try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (error) {
  console.error(
    "Este script precisa do módulo nativo node:sqlite, disponível a partir do Node.js 22.5.\n" +
      "Verifique sua versão com 'node -v' e atualize o Node.js em https://nodejs.org caso necessário."
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const DB_FILE = process.env.DB_FILE || path.join(ROOT, "data", "app.db");
const USERNAME = process.env.ADMIN_USERNAME || "Elizandro";
const PASSWORD = process.env.ADMIN_PASSWORD;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function main() {
  if (!PASSWORD) {
    console.error("Defina ADMIN_PASSWORD antes de rodar este script. Exemplo:");
    console.error('  ADMIN_PASSWORD="sua_senha_aqui" node scripts/set-admin-password.js');
    process.exit(1);
  }

  if (PASSWORD.length < 8) {
    console.error("A senha precisa ter pelo menos 8 caracteres.");
    process.exit(1);
  }

  if (!require("fs").existsSync(DB_FILE)) {
    console.error(`Banco de dados não encontrado em: ${DB_FILE}`);
    console.error("O servidor precisa ter rodado ao menos uma vez antes (pra criar o banco).");
    process.exit(1);
  }

  const db = new DatabaseSync(DB_FILE);
  const passwordHash = hashPassword(PASSWORD);
  const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(USERNAME);

  if (existing) {
    db.prepare("UPDATE admins SET password_hash = ? WHERE username = ?").run(passwordHash, USERNAME);
    console.log(`Senha atualizada para a conta de administrador "${USERNAME}".`);
  } else {
    db.prepare(`
      INSERT INTO admins (id, username, password_hash, created_at)
      VALUES (?, ?, ?, ?)
    `).run(crypto.randomUUID(), USERNAME, passwordHash, new Date().toISOString());
    console.log(`Conta de administrador "${USERNAME}" criada com a senha definida em ADMIN_PASSWORD.`);
  }

  db.close();
}

main();
