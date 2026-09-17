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
  // One-time migration: old public accounts have no reliable approval provenance.
  if (!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='access_status')) {
    transaction(db,()=>{
      db.exec(`ALTER TABLE users ADD COLUMN access_status TEXT NOT NULL DEFAULT 'approved';
        ALTER TABLE users ADD COLUMN requested_team TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN security_version INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN created_at TEXT;
        UPDATE users SET access_status=CASE WHEN active=0 THEN 'blocked' WHEN perfil='Supervisor' THEN 'pending' ELSE 'approved' END;
        UPDATE users SET active=0 WHERE perfil='Supervisor';
        DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE active=0);`);
    });
  }
  if (!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='username')) {
    transaction(db,()=>{
      db.exec(`ALTER TABLE users ADD COLUMN username TEXT;`);
      for (const user of db.prepare('SELECT id,email FROM users ORDER BY created_at,id').all()) {
        db.prepare('UPDATE users SET username=? WHERE id=?').run(uniqueUsername(db,emailPrefix(user.email),user.id),user.id);
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username);');
    });
  } else {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username);');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS security_audit (
    id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), target_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL, occurred_at TEXT NOT NULL, previous_data TEXT NOT NULL, next_data TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS security_audit_no_update BEFORE UPDATE ON security_audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;
  CREATE TRIGGER IF NOT EXISTS security_audit_no_delete BEFORE DELETE ON security_audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;`);
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  return db;
}
function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Login invalido. Use 3 a 40 letras, numeros, ponto, hifen ou underline.');
  return username;
}
function emailPrefix(email) {
  return String(email || '').split('@')[0].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9._-]+/g,'.').replace(/^[._-]+|[._-]+$/g,'').slice(0,32) || 'usuario';
}
function uniqueUsername(db,base,ignoreId='') {
  base = normalizeUsername(base.length >= 3 ? base : `${base}123`);
  for (let i=0;i<1000;i++) {
    const candidate = i ? `${base.slice(0,Math.max(3,36-String(i).length))}${i}` : base;
    const row = db.prepare('SELECT id FROM users WHERE username=?').get(candidate);
    if (!row || row.id === ignoreId) return candidate;
  }
  throw new Error('Nao foi possivel gerar login unico.');
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
async function createUser(db, { email, username, nome, password, perfil = 'Supervisor', teams = [], pending = false, requestedTeam = '' }) {
  email = String(email || '').trim().toLowerCase();
  username = username ? normalizeUsername(username) : uniqueUsername(db,emailPrefix(email));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('E-mail invalido.');
  if (!nome?.trim() || nome.length > 200 || !['Chefia','Supervisor'].includes(perfil)) throw new Error('Nome ou perfil invalido.');
  if (!Array.isArray(teams) || teams.some(t => typeof t !== 'string' || !t.trim() || t.trim().length > 120)) throw new Error('Equipe invalida.');
  const passwordHash = await hashPassword(password), id = crypto.randomUUID();
  transaction(db, () => {
    db.prepare('INSERT INTO users(id,email,username,nome,password_hash,perfil,active,access_status,requested_team,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,email,username,nome.trim(),passwordHash,pending?'Supervisor':perfil,pending?0:1,pending?'pending':'approved',pending?requestedTeam:'',new Date().toISOString());
    if(!pending)for (const team of new Set(teams.map(t => t.trim()))) db.prepare('INSERT INTO memberships VALUES (?,?)').run(id,team);
  });
  return id;
}
function serialize(row) {
  return { ...JSON.parse(row.payload), id: row.id, autor_id: row.autor_id, created_at: row.created_at, updated_at: row.updated_at };
}
module.exports = { openDatabase, hashPassword, verifyPassword, createUser, transaction, serialize, backup, normalizeUsername, uniqueUsername, emailPrefix };
