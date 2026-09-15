// Cria uma cópia de segurança do banco de dados SQLite do app.
//
// O banco roda em modo WAL (Write-Ahead Logging), então uma cópia "crua" do
// arquivo app.db pode ficar incompleta (faltando dados que ainda estão só
// no arquivo -wal). Por isso, antes de copiar, este script manda o SQLite
// gravar tudo que está pendente de volta no arquivo principal
// (checkpoint TRUNCATE) e só depois faz a cópia.
//
// Uso: node scripts/backup-db.js
// (o comando "npm run backup" já chama este script)

const fs = require("fs");
const path = require("path");
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
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "app.db");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 30; // mantem os 30 backups mais recentes, apaga o resto

function timestampForFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

function pruneOldBackups() {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith("app-") && name.endsWith(".db"))
    .map((name) => ({ name, fullPath: path.join(BACKUP_DIR, name) }))
    .sort((a, b) => fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs);

  files.slice(MAX_BACKUPS).forEach((file) => {
    fs.unlinkSync(file.fullPath);
    console.log(`Backup antigo removido: ${file.name}`);
  });
}

// Roda o backup e devolve o caminho do arquivo criado. Lança um erro se não
// der certo (o chamador decide o que fazer - a CLI encerra o processo com
// erro, o agendamento automático dentro do servidor só registra no log e
// tenta de novo no dia seguinte, sem derrubar o app por causa disso).
function runBackup() {
  if (!fs.existsSync(DB_FILE)) {
    throw new Error(`Banco de dados não encontrado em: ${DB_FILE} (o servidor precisa ter rodado ao menos uma vez).`);
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Abre o banco, força gravar tudo que está no WAL de volta no arquivo
  // principal, e fecha - deixando o app.db num estado consistente e completo
  // antes de copiar.
  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();

  const backupFileName = `app-${timestampForFileName()}.db`;
  const backupPath = path.join(BACKUP_DIR, backupFileName);

  fs.copyFileSync(DB_FILE, backupPath);

  pruneOldBackups();

  return backupPath;
}

function main() {
  try {
    const backupPath = runBackup();
    const sizeKb = (fs.statSync(backupPath).size / 1024).toFixed(1);
    console.log(`Backup criado com sucesso: ${path.relative(ROOT, backupPath)} (${sizeKb} KB)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

// Só roda automaticamente quando chamado direto (`node scripts/backup-db.js`
// ou `npm run backup`) - quando importado pelo server.js pra agendar backups
// automáticos, só expõe runBackup() sem executar nada sozinho.
if (require.main === module) {
  main();
}

module.exports = { runBackup, BACKUP_DIR };
