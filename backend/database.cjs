const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, nome TEXT NOT NULL,
      password_hash TEXT NOT NULL, perfil TEXT NOT NULL CHECK(perfil IN ('Chefia','Supervisor')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL REFERENCES users(id), equipe TEXT NOT NULL,
      PRIMARY KEY(user_id,equipe)
    );
    CREATE TABLE IF NOT EXISTS user_defaults (
      user_id TEXT PRIMARY KEY REFERENCES users(id), payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_groups (
      equipe TEXT PRIMARY KEY, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), csrf TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, turno TEXT NOT NULL CHECK(turno IN ('Diurno','Noturno')),
      equipe TEXT NOT NULL, autor_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(data,turno,equipe)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, report_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL, occurred_at TEXT NOT NULL, previous_data TEXT, next_data TEXT
    );
    CREATE INDEX IF NOT EXISTS reports_period ON reports(data,id);
    CREATE INDEX IF NOT EXISTS reports_author_period ON reports(autor_id,data,id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TRIGGER IF NOT EXISTS report_identity BEFORE UPDATE ON reports
      WHEN new.id != old.id OR new.autor_id != old.autor_id OR new.created_at != old.created_at
      BEGIN SELECT RAISE(ABORT,'Immutable report identity'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
      BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
      BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
    PRAGMA user_version=1;
  `);
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  return db;
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new Error('A senha precisa ter entre 12 e 128 caracteres.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [, salt, expected] = stored.split('$');
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
async function createUser(db, { email, nome, password, perfil = 'Supervisor', teams = [] }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('E-mail invalido.');
  if (!nome?.trim() || nome.length > 200 || !['Chefia','Supervisor'].includes(perfil)) throw new Error('Nome ou perfil invalido.');
  if (!Array.isArray(teams) || teams.some(t => typeof t !== 'string' || !t.trim() || t.trim().length > 120)) throw new Error('Equipe invalida.');
  const passwordHash = await hashPassword(password), id = crypto.randomUUID();
  transaction(db, () => {
    db.prepare('INSERT INTO users(id,email,nome,password_hash,perfil) VALUES (?,?,?,?,?)').run(id,email,nome.trim(),passwordHash,perfil);
    for (const team of new Set(teams.map(t => t.trim()))) db.prepare('INSERT INTO memberships VALUES (?,?)').run(id,team);
  });
  return id;
}
function serialize(row) {
  return { ...JSON.parse(row.payload), id: row.id, autor_id: row.autor_id, created_at: row.created_at, updated_at: row.updated_at };
}
module.exports = { openDatabase, hashPassword, verifyPassword, createUser, transaction, serialize, backup };
